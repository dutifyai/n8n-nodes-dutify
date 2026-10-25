import { describe, expect, it } from 'vitest';
import type { INodeExecutionData } from 'n8n-workflow';
import { resources } from '../../../nodes/Dutify/registry';
import { account, workspace } from '../../../nodes/Dutify/resources/workspace';
import type { OperationDef, ResourceDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

function op(def: ResourceDef, name: string): OperationDef {
	const found = def.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${name}`);
	}

	return found;
}

function build(def: ResourceDef, name: string, params: Record<string, unknown>, ws = 'ws-1') {
	const o = op(def, name);
	if (!o.build) {
		throw new Error(`${name} has no build`);
	}

	return o.build(reader(params, ws));
}

async function run(
	def: ResourceDef,
	name: string,
	responses: unknown[],
): Promise<{ items: INodeExecutionData[]; paths: string[] }> {
	const o = op(def, name);
	if (!o.run) {
		throw new Error(`${name} has no run`);
	}
	const ctx = fakeContext(responses);
	const items = await o.run(ctx, reader({}, ''));

	return { items, paths: ctx.calls.map((c) => c.path) };
}

describe('resource definitions', () => {
	it('account is not workspace scoped, workspace is, and both are registered', () => {
		expect(account.value).toBe('account');
		expect(account.workspaceScoped).toBe(false);
		expect(account.operations.map((o) => o.operation)).toEqual([
			'whoAmI',
			'listWorkspaces',
			'findMyWorkspace',
		]);
		expect(workspace.value).toBe('workspace');
		expect(workspace.workspaceScoped).toBe(true);
		expect(workspace.operations.map((o) => o.operation)).toEqual([
			'listFeatureRequestBoards',
			'listWikiSpaces',
			'getContext',
			'getDashboard',
			'getReferenceData',
		]);
		expect(resources).toContain(account);
		expect(resources).toContain(workspace);
	});
});

describe('account', () => {
	it('whoAmI: GET /api-keys/current', () => {
		expect(build(account, 'whoAmI', {}, '')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/api-keys/current',
		});
	});

	it('listWorkspaces with a personal key lists its suite workspaces', async () => {
		const { items, paths } = await run(account, 'listWorkspaces', [
			{ keyType: 'PERSONAL' },
			[
				{ identifier: 'ws_a', id: 'u-1', name: 'Acme', suiteAccess: true, hubAccess: false },
				{ identifier: 'ws_h', id: 'u-2', name: 'Hub', suiteAccess: false, hubAccess: true },
			],
		]);
		expect(paths).toEqual([
			'/mp/api/v1/api-keys/current',
			'/mp/api/v1/personal-api-keys/workspaces',
		]);
		expect(items).toEqual([{ json: { identifier: 'ws_a', name: 'Acme' } }]);
	});

	it('listWorkspaces with a workspace key returns only the bound workspace, no personal-keys call', async () => {
		const { items, paths } = await run(account, 'listWorkspaces', [
			{ keyType: 'WORKSPACE', workspaceIdentifier: 'ws_x', workspaceName: 'X' },
		]);
		expect(paths).toEqual(['/mp/api/v1/api-keys/current']);
		expect(items).toEqual([{ json: { identifier: 'ws_x', name: 'X', bound: true } }]);
	});

	it('findMyWorkspace with a workspace key introspects the bound workspace', async () => {
		const { items, paths } = await run(account, 'findMyWorkspace', [
			{
				keyType: 'WORKSPACE',
				workspaceIdentifier: 'ws_x',
				workspaceName: 'X',
				scopes: ['tasks:read'],
				keyIdentifier: 'key_1',
				keyName: 'n8n',
			},
		]);
		expect(paths).toHaveLength(1);
		expect(items).toEqual([
			{
				json: {
					identifier: 'ws_x',
					name: 'X',
					scopes: ['tasks:read'],
					keyIdentifier: 'key_1',
					keyName: 'n8n',
				},
			},
		]);
	});

	it('findMyWorkspace with a personal key returns its workspaces', async () => {
		const { items } = await run(account, 'findMyWorkspace', [
			{ keyType: 'PERSONAL' },
			[{ identifier: 'ws_a', id: 'u-1', name: 'Acme', suiteAccess: true, hubAccess: true }],
		]);
		expect(items).toEqual([
			{
				json: {
					keyType: 'PERSONAL',
					workspaces: [{ identifier: 'ws_a', name: 'Acme' }],
				},
			},
		]);
	});
});

describe('workspace', () => {
	it('listFeatureRequestBoards: Roadmarq boards/lite with workspaceIdentifier', () => {
		expect(build(workspace, 'listFeatureRequestBoards', {})).toEqual({
			method: 'GET',
			path: '/api/roadmarq/v1/boards/lite',
			qs: { workspaceIdentifier: 'ws-1' },
		});
	});

	it('listWikiSpaces: Codexum spaces/lite', () => {
		expect(build(workspace, 'listWikiSpaces', {})).toEqual({
			method: 'GET',
			path: '/api/wiki/v1/workspaces/ws-1/wiki/spaces/lite',
		});
	});

	it('getContext: lite context, optional flags only when set', () => {
		expect(build(workspace, 'getContext', { additionalFields: {} })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/lite/context',
			qs: {},
		});
		const flags = {
			shallow: true,
			space: 'Engineering',
			includeCustomFields: false,
			includeRelationshipTypes: false,
			includeTags: false,
			includeTaskTypes: false,
		};
		expect(build(workspace, 'getContext', { additionalFields: flags })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/lite/context',
			qs: flags,
		});
	});

	it('getDashboard: workspace scope sends the workspace identifier as scopeIdentifier (backend rejects blank)', () => {
		expect(build(workspace, 'getDashboard', { scope: 'workspace', scopeIdentifier: '' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/dashboard/lite',
			qs: { scope: 'workspace', scopeIdentifier: 'ws-1' },
		});
	});

	it('getDashboard: space, folder and list scopes send the identifier chosen in that scope picker', () => {
		const params = { scopeSpaceId: 'spc_1', scopeFolderId: 'fld_1', scopeListId: 'lst_1' };
		const sent = (scope: string) =>
			(build(workspace, 'getDashboard', { scope, ...params }) as { qs: unknown }).qs;
		expect(build(workspace, 'getDashboard', { scope: 'list', ...params })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/dashboard/lite',
			qs: { scope: 'list', scopeIdentifier: 'lst_1' },
		});
		expect(sent('space')).toEqual({ scope: 'space', scopeIdentifier: 'spc_1' });
		expect(sent('folder')).toEqual({ scope: 'folder', scopeIdentifier: 'fld_1' });
	});

	it('getDashboard: the scope target is a picker per scope (no pasted UUID)', () => {
		const fields = op(workspace, 'getDashboard').fields;
		expect(fields.find((f) => f.name === 'scopeIdentifier')).toBeUndefined();
		const pickers: Record<string, [string, string]> = {
			scopeSpaceId: ['getSpaceIds', 'space'],
			scopeFolderId: ['getFolderIds', 'folder'],
			scopeListId: ['getListIds', 'list'],
		};
		for (const [name, [method, scope]] of Object.entries(pickers)) {
			const field = fields.find((f) => f.name === name);
			expect(field?.type).toBe('options');
			expect(field?.typeOptions?.loadOptionsMethod).toBe(method);
			expect(field?.displayOptions?.show).toEqual({ scope: [scope] });
		}
	});

	it('getContext drops a blank space from the query', () => {
		expect(
			build(workspace, 'getContext', { additionalFields: { space: '', shallow: true } }),
		).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/lite/context',
			qs: { shallow: true },
		});
	});

	it.each([
		['access-levels', '/mp/api/v1/access-levels'],
		['activity-types', '/mp/api/v1/activity-types'],
		['automation-action-types', '/mp/api/v1/automation/public/action-type'],
		['automation-condition-types', '/mp/api/v1/automation/public/condition-type'],
		['automation-field-operators', '/mp/api/v1/automation/public/field-operator'],
		['custom-field-icon-options', '/mp/api/v1/custom-field-icon-options'],
		['custom-field-types', '/mp/api/v1/custom-field-types'],
		['resource-view-types', '/mp/api/v1/resource-view-types'],
		['status-types', '/mp/api/v1/status-types'],
		['workspace-access-level-permissions', '/mp/api/v1/workspace-access-level-permissions'],
	])('getReferenceData %s -> GET %s', (category, path) => {
		expect(build(workspace, 'getReferenceData', { category })).toEqual({ method: 'GET', path });
	});

	it('every getReferenceData category option has a test row above', () => {
		const field = op(workspace, 'getReferenceData').fields.find((f) => f.name === 'category');
		expect(field?.options).toHaveLength(10);
	});
});
