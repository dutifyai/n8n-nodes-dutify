import type { IDataObject, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';
import { buildProperties, executeOperation, findOperation } from '../../nodes/Dutify/registry';
import type { ResourceDef } from '../../shared/types';

const thing: ResourceDef = {
	value: 'thing',
	name: 'Thing',
	workspaceScoped: true,
	operations: [
		{
			operation: 'get',
			name: 'Get',
			action: 'Get a thing',
			description: 'Get one thing',
			fields: [
				{ displayName: 'Thing ID', name: 'thingId', type: 'string', default: '', required: true },
			],
			build: (p) => ({ method: 'GET', path: `/mp/api/v1/things/${p.get<string>('thingId')}` }),
		},
		{
			operation: 'list',
			name: 'List',
			action: 'List things',
			description: 'List things',
			list: true,
			fields: [],
			build: () => ({
				method: 'GET',
				path: '/mp/api/v1/things',
				paginate: {
					kind: 'cursor',
					cursorParam: 'cursor',
					limitParam: 'limit',
					itemsPath: 'items',
					nextCursorPath: 'nextCursor',
					maxPageSize: 100,
				},
			}),
		},
	],
};

const account: ResourceDef = {
	value: 'account',
	name: 'Account',
	workspaceScoped: false,
	operations: [
		{
			operation: 'whoAmI',
			name: 'Who Am I',
			action: 'Get the current account',
			description: 'Get the account behind the API key',
			fields: [],
			build: () => ({ method: 'GET', path: '/mp/api/v1/api-keys/current' }),
		},
	],
};

const resources = [thing, account];

const byName = (props: INodeProperties[], name: string) => props.filter((p) => p.name === name);

describe('buildProperties', () => {
	const props = buildProperties(resources);

	it('emits a resource options property listing every resource', () => {
		const [resource] = byName(props, 'resource');
		expect(resource.type).toBe('options');
		expect(resource.options).toEqual([
			{ name: 'Thing', value: 'thing' },
			{ name: 'Account', value: 'account' },
		]);
	});

	it('emits one operation property per resource, shown only for that resource', () => {
		const ops = byName(props, 'operation');
		expect(ops).toHaveLength(2);
		expect(ops[0].displayOptions?.show?.resource).toEqual(['thing']);
		expect(ops[0].type).toBe('options');
		expect(ops[0].options).toEqual([
			{ name: 'Get', value: 'get', action: 'Get a thing', description: 'Get one thing' },
			{ name: 'List', value: 'list', action: 'List things', description: 'List things' },
		]);
		expect(ops[1].displayOptions?.show?.resource).toEqual(['account']);
	});

	it('scopes every operation field to its resource and operation', () => {
		const [thingId] = byName(props, 'thingId');
		expect(thingId.displayOptions?.show).toEqual({ resource: ['thing'], operation: ['get'] });
	});

	it('does not mutate the field definitions it was given', () => {
		expect(thing.operations[0].fields[0].displayOptions).toBeUndefined();
	});

	it('adds returnAll and limit to list operations, limit shown only when returnAll is false', () => {
		const [returnAll] = byName(props, 'returnAll');
		const [limit] = byName(props, 'limit');
		expect(returnAll.type).toBe('boolean');
		expect(returnAll.displayOptions?.show).toEqual({ resource: ['thing'], operation: ['list'] });
		expect(limit.type).toBe('number');
		expect(limit.default).toBe(50);
		expect(limit.typeOptions?.minValue).toBe(1);
		expect(limit.displayOptions?.show).toEqual({
			resource: ['thing'],
			operation: ['list'],
			returnAll: [false],
		});
	});

	it('does not add returnAll to non-list operations', () => {
		expect(byName(props, 'returnAll')).toHaveLength(1);
	});

	it('shows the workspace locator only for workspace-scoped resources', () => {
		const ws = byName(props, 'workspace');
		expect(ws).toHaveLength(1);
		expect(ws[0].type).toBe('resourceLocator');
		expect(ws[0].displayOptions?.show).toEqual({ resource: ['thing'] });
		expect(ws[0].modes?.map((m) => m.name)).toEqual(['list', 'id']);
		const listMode = ws[0].modes?.find((m) => m.name === 'list');
		expect(listMode?.typeOptions?.searchListMethod).toBe('searchWorkspaces');
	});

	it('emits no workspace locator when no resource is workspace-scoped', () => {
		expect(byName(buildProperties([account]), 'workspace')).toHaveLength(0);
	});
});

describe('findOperation', () => {
	it('finds a known pair', () => {
		expect(findOperation(resources, 'thing', 'list').operation).toBe('list');
	});

	it('throws for an unknown pair', () => {
		expect(() => findOperation(resources, 'thing', 'delete')).toThrow();
		expect(() => findOperation(resources, 'nope', 'get')).toThrow();
	});
});

const node: INode = {
	id: 'n1',
	name: 'Dutify',
	type: 'n8n-nodes-dutify.dutify',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/**
 * A minimal IExecuteFunctions: per-item parameters, a stubbed authenticated request
 * that answers from `responses` in order (an Error response is thrown).
 */
function stubThis(opts: { items: IDataObject[]; continueOnFail?: boolean; responses: unknown[] }) {
	const queue = [...opts.responses];
	const httpRequestWithAuthentication = vi.fn(async () => {
		const next = queue.shift();
		if (next instanceof Error || (next && typeof next === 'object' && 'httpCode' in next)) {
			throw next;
		}

		return next;
	});
	const self = {
		getInputData: () => opts.items.map((): INodeExecutionData => ({ json: {} })),
		getNodeParameter: vi.fn((name: string, i: number, fallback?: unknown) => {
			const params = opts.items[i];
			if (name in params) {
				return params[name];
			}
			if (fallback !== undefined) {
				return fallback;
			}
			throw new Error(`Could not get parameter "${name}"`);
		}),
		getNode: () => node,
		continueOnFail: () => opts.continueOnFail ?? false,
		getCredentials: vi.fn(async () => ({ apiKey: 'k', baseUrl: 'https://dutify.ai' })),
		helpers: { httpRequestWithAuthentication },
	};

	return { self, httpRequestWithAuthentication };
}

describe('executeOperation', () => {
	it('runs each item, and with continueOnFail turns a failed item into an error item', async () => {
		const { self, httpRequestWithAuthentication } = stubThis({
			continueOnFail: true,
			items: [
				{ resource: 'thing', operation: 'get', workspace: 'ws-1', thingId: 't1' },
				{ resource: 'thing', operation: 'get', workspace: 'ws-1', thingId: 't2' },
			],
			responses: [
				{ id: 't1' },
				{ httpCode: '404', response: { body: { message: 'Thing t2 not found' } } },
			],
		});
		const result = await executeOperation.call(self as never, resources);
		expect(result).toHaveLength(1);
		const out = result[0];
		expect(out).toHaveLength(2);
		expect(out[0].json).toEqual({ id: 't1' });
		expect(out[0].pairedItem).toEqual({ item: 0 });
		expect(out[1].json.error).toContain('Thing t2 not found');
		expect(out[1].pairedItem).toEqual({ item: 1 });

		const firstCall = httpRequestWithAuthentication.mock.calls[0] as unknown as [
			string,
			{ url: string; headers: IDataObject },
		];
		expect(firstCall[0]).toBe('dutifyApi');
		expect(firstCall[1].url).toBe('https://dutify.ai/mp/api/v1/things/t1');
		expect(firstCall[1].headers['X-Dutify-Workspace']).toBe('ws-1');
	});

	it('throws the Dutify error when continueOnFail is off', async () => {
		const { self } = stubThis({
			items: [{ resource: 'thing', operation: 'get', workspace: 'ws-1', thingId: 't2' }],
			responses: [{ httpCode: '404', response: { body: { message: 'Thing t2 not found' } } }],
		});
		await expect(executeOperation.call(self as never, resources)).rejects.toThrow(
			/Thing t2 not found/,
		);
	});

	it('fans an array response out to one item per element', async () => {
		const { self } = stubThis({
			items: [{ resource: 'thing', operation: 'get', workspace: 'ws-1', thingId: 't1' }],
			responses: [[{ id: 'a' }, { id: 'b' }]],
		});
		const [out] = await executeOperation.call(self as never, resources);
		expect(out.map((i) => i.json)).toEqual([{ id: 'a' }, { id: 'b' }]);
		expect(out.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 0 }]);
	});

	it('passes limit to pagination when returnAll is false', async () => {
		const { self, httpRequestWithAuthentication } = stubThis({
			items: [
				{ resource: 'thing', operation: 'list', workspace: 'ws-1', returnAll: false, limit: 2 },
			],
			responses: [{ items: [{ id: 1 }, { id: 2 }], nextCursor: 'c2' }],
		});
		const [out] = await executeOperation.call(self as never, resources);
		expect(out.map((i) => i.json)).toEqual([{ id: 1 }, { id: 2 }]);
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
		const call = httpRequestWithAuthentication.mock.calls[0] as unknown as [
			string,
			{ qs: IDataObject },
		];
		expect(call[1].qs).toEqual({ limit: 2 });
	});

	it('follows every page when returnAll is true', async () => {
		const { self, httpRequestWithAuthentication } = stubThis({
			items: [{ resource: 'thing', operation: 'list', workspace: 'ws-1', returnAll: true }],
			responses: [
				{ items: [{ id: 1 }], nextCursor: 'c2' },
				{ items: [{ id: 2 }], nextCursor: null },
			],
		});
		const [out] = await executeOperation.call(self as never, resources);
		expect(out.map((i) => i.json)).toEqual([{ id: 1 }, { id: 2 }]);
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(2);
	});

	it('sends no workspace header for a resource that is not workspace-scoped', async () => {
		const { self, httpRequestWithAuthentication } = stubThis({
			items: [{ resource: 'account', operation: 'whoAmI' }],
			responses: [{ id: 'key-1' }],
		});
		const [out] = await executeOperation.call(self as never, resources);
		expect(out[0].json).toEqual({ id: 'key-1' });
		const call = httpRequestWithAuthentication.mock.calls[0] as unknown as [
			string,
			{ headers: IDataObject },
		];
		expect(call[1].headers).not.toHaveProperty('X-Dutify-Workspace');
	});

	it('returns a success item for an empty (204) response', async () => {
		const { self } = stubThis({
			items: [{ resource: 'thing', operation: 'get', workspace: 'ws-1', thingId: 't1' }],
			responses: [''],
		});
		const [out] = await executeOperation.call(self as never, resources);
		expect(out).toEqual([{ json: { success: true }, pairedItem: { item: 0 } }]);
	});
});
