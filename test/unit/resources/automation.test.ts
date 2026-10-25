import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { automation } from '../../../nodes/Dutify/resources/automation';
import type { OperationDef } from '../../../shared/types';
import { reader } from '../helpers';

function op(name: string): OperationDef {
	const found = automation.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${name}`);
	}

	return found;
}

const build = (name: string, params: Record<string, unknown>) => op(name).build!(reader(params));

const fieldOf = (operation: string, name: string) =>
	op(operation).fields.find((f) => f.name === name);

const loaderOf = (operation: string, name: string) =>
	(fieldOf(operation, name)?.typeOptions as { loadOptionsMethod?: string } | undefined)
		?.loadOptionsMethod;

const PAGING = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	maxPageSize: 100,
};

describe('automation registration', () => {
	it('is registered as "automation" with the six automation operations', () => {
		expect(resources).toContain(automation);
		expect(automation.value).toBe('automation');
		expect(automation.workspaceScoped).toBe(true);
		expect(automation.operations.map((o) => o.operation)).toEqual([
			'list',
			'get',
			'create',
			'update',
			'delete',
			'getAudit',
		]);
	});
});

describe('automation list', () => {
	it('lists a list: GET automations/list/{id}, zero-based page/size capped at 100', () => {
		expect(build('list', { scope: 'list', list: 'lst_1' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/automations/list/lst_1',
			paginate: PAGING,
		});
		expect(op('list').list).toBe(true);
	});

	it('lists a folder: GET automations/folder/{id}, with includeDescendants only when on', () => {
		expect(build('list', { scope: 'folder', folder: 'fld_1', includeDescendants: false })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/automations/folder/fld_1',
			paginate: PAGING,
		});
		expect(build('list', { scope: 'folder', folder: 'fld_1', includeDescendants: true })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/automations/folder/fld_1',
			qs: { includeDescendants: true },
			paginate: PAGING,
		});
	});

	it('lists a space: GET automations/space/{id}', () => {
		expect(build('list', { scope: 'space', space: 'sp_1', includeDescendants: true })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/automations/space/sp_1',
			qs: { includeDescendants: true },
			paginate: PAGING,
		});
	});

	it('the list scope does not send includeDescendants (the endpoint does not declare it)', () => {
		expect(
			build('list', { scope: 'list', list: 'lst_1', includeDescendants: true }).qs,
		).toBeUndefined();
	});

	it('the three scopes pick three different catalog paths', () => {
		const paths = ['space', 'folder', 'list'].map(
			(scope) => build('list', { scope, space: 's', folder: 'f', list: 'l' }).path,
		);
		expect(new Set(paths).size).toBe(3);
	});

	it('the target is chosen from pickers shown for its scope', () => {
		expect(loaderOf('list', 'space')).toBe('getSpaceIds');
		expect(loaderOf('list', 'folder')).toBe('getFolderIds');
		expect(loaderOf('list', 'list')).toBe('getListIds');
		expect(fieldOf('list', 'space')?.displayOptions?.show).toEqual({ scope: ['space'] });
		expect(fieldOf('list', 'folder')?.displayOptions?.show).toEqual({ scope: ['folder'] });
		expect(fieldOf('list', 'list')?.displayOptions?.show).toEqual({ scope: ['list'] });
	});
});

describe('automation get, delete and audit', () => {
	const target = { scope: 'list', list: 'lst_1', automation: 'aut_1' };

	it('get: GET automations/{id}', () => {
		expect(build('get', target)).toEqual({ method: 'GET', path: '/mp/api/v1/automations/aut_1' });
	});

	it('delete: DELETE automations/{id}', () => {
		expect(build('delete', target)).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/automations/aut_1',
		});
	});

	it('getAudit: GET automations/{id}/audit, paged', () => {
		expect(build('getAudit', target)).toEqual({
			method: 'GET',
			path: '/mp/api/v1/automations/aut_1/audit',
			paginate: PAGING,
		});
		expect(op('getAudit').list).toBe(true);
	});

	it('the automation is chosen from a picker that follows the scope and its target', () => {
		for (const name of ['get', 'update', 'delete', 'getAudit']) {
			expect(loaderOf(name, 'automation')).toBe('getAutomations');
			expect(
				(fieldOf(name, 'automation')?.typeOptions as { loadOptionsDependsOn?: string[] })
					.loadOptionsDependsOn,
			).toEqual(['scope', 'space', 'folder', 'list']);
		}
	});
});

describe('automation create', () => {
	const triggers = '[{"triggerType":"status_changed","parameters":{"status":"Done"}}]';
	const actions = '[{"actionType":"set_status","parameters":"{\\"status\\":\\"Closed\\"}"}]';
	const base = { scope: 'space', space: 'sp_1', name: 'Auto close', triggers, actions };

	it('POST automations with the name, the scope identifier, triggers and actions', () => {
		expect(build('create', { ...base, additionalFields: {} })).toEqual({
			method: 'POST',
			path: '/mp/api/v1/automations',
			body: {
				name: 'Auto close',
				spaceIdentifier: 'sp_1',
				triggers: [{ triggerType: 'status_changed', parameters: '{"status":"Done"}' }],
				actions: [{ actionType: 'set_status', parameters: '{"status":"Closed"}' }],
			},
		});
	});

	it('a folder or list scope sends only that identifier', () => {
		const folderBody = build('create', {
			...base,
			scope: 'folder',
			folder: 'fld_1',
			additionalFields: {},
		}).body as Record<string, unknown>;
		expect(folderBody.folderIdentifier).toBe('fld_1');
		expect(folderBody).not.toHaveProperty('spaceIdentifier');
		const listBody = build('create', {
			...base,
			scope: 'list',
			list: 'lst_1',
			additionalFields: {},
		}).body as Record<string, unknown>;
		expect(listBody.listIdentifier).toBe('lst_1');
		expect(listBody).not.toHaveProperty('folderIdentifier');
	});

	it('description, active and the condition tree are optional; object parameters become JSON text', () => {
		const body = build('create', {
			...base,
			actions: [{ actionType: 'notify', parameters: { who: 'owner' } }],
			additionalFields: {
				description: 'Closes done tasks',
				active: false,
				conditionNodes:
					'[{"nodeType":"operator","operatorType":"AND","children":[{"nodeType":"condition","conditionType":"field_check","parameters":{"a":1}}]}]',
			},
		}).body;
		expect(body).toMatchObject({
			description: 'Closes done tasks',
			active: false,
			actions: [{ actionType: 'notify', parameters: '{"who":"owner"}' }],
			conditionNodes: [
				{
					nodeType: 'operator',
					operatorType: 'AND',
					children: [
						{ nodeType: 'condition', conditionType: 'field_check', parameters: '{"a":1}' },
					],
				},
			],
		});
	});

	it('name, triggers and actions are required fields', () => {
		for (const name of ['name', 'triggers', 'actions']) {
			expect(fieldOf('create', name)?.required).toBe(true);
		}
	});

	it('rejects JSON that is not an array', () => {
		const make = (extra: Record<string, unknown>) => () =>
			build('create', { ...base, additionalFields: {}, ...extra });
		expect(make({ triggers: '{"triggerType":"x"}' })).toThrow(/Triggers must be a JSON array/);
		expect(make({ actions: 'not json' })).toThrow(/Actions must be a JSON array/);
	});
});

describe('automation update', () => {
	const target = { scope: 'list', list: 'lst_1', automation: 'aut_1' };

	it('PUT automations/{id} with only the set fields', () => {
		expect(
			build('update', {
				...target,
				updateFields: { name: 'Renamed', active: false, actions: '[{"actionType":"notify"}]' },
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/automations/aut_1',
			body: { name: 'Renamed', active: false, actions: [{ actionType: 'notify' }] },
		});
	});

	it('keeps active=false (a boolean off is a change)', () => {
		expect(build('update', { ...target, updateFields: { active: false } }).body).toEqual({
			active: false,
		});
	});

	it('refuses an empty update before any request', () => {
		expect(() => build('update', { ...target, updateFields: {} })).toThrow(/at least one field/i);
	});
});
