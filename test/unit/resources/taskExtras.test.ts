import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { savedFilter, taskSharing, timeEntry } from '../../../nodes/Dutify/resources/taskExtras';
import type { OperationContext, OperationDef, ResourceDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

const opOf = (resource: ResourceDef, name: string): OperationDef => {
	const found = resource.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${resource.value}.${name}`);
	}

	return found;
};

const fieldOf = (resource: ResourceDef, operation: string, name: string) =>
	opOf(resource, operation).fields.find((f) => f.name === name);

const loaderOf = (resource: ResourceDef, operation: string, name: string) =>
	(fieldOf(resource, operation, name)?.typeOptions as { loadOptionsMethod?: string } | undefined)
		?.loadOptionsMethod;

const dependsOn = (resource: ResourceDef, operation: string, name: string) =>
	(fieldOf(resource, operation, name)?.typeOptions as { loadOptionsDependsOn?: string[] })
		.loadOptionsDependsOn;

const run = (
	resource: ResourceDef,
	name: string,
	ctx: OperationContext,
	params: Record<string, unknown>,
) => opOf(resource, name).run!(ctx, reader(params));

describe('registration', () => {
	it('registers taskSharing, timeEntry and savedFilter with their operations', () => {
		for (const r of [taskSharing, timeEntry, savedFilter]) {
			expect(resources).toContain(r);
			expect(r.workspaceScoped).toBe(true);
		}
		expect(taskSharing.value).toBe('taskSharing');
		expect(taskSharing.operations.map((o) => o.operation)).toEqual(['get', 'configure']);
		expect(timeEntry.value).toBe('timeEntry');
		expect(timeEntry.operations.map((o) => o.operation)).toEqual(['list', 'create', 'delete']);
		expect(savedFilter.value).toBe('savedFilter');
		expect(savedFilter.operations.map((o) => o.operation)).toEqual(['list', 'create', 'delete']);
	});
});

describe('taskSharing', () => {
	it('get: a task key is resolved to its tsk_ ID, then GET tasks/{id}/sharing', async () => {
		const ctx = fakeContext([{ identifier: 'tsk_9' }, { shared: true, publicLink: 'abc' }]);
		const out = await run(taskSharing, 'get', ctx, { task: 'PROJ-42' });
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: '/mp/api/v1/tasks/lite/PROJ-42', qs: { workspace: 'ws-1' } },
			{ method: 'GET', path: '/mp/api/v1/tasks/tsk_9/sharing' },
		]);
		expect(out).toEqual([{ json: { shared: true, publicLink: 'abc' } }]);
	});

	it('get: a tsk_ ID is used as is, with no lookup', async () => {
		const ctx = fakeContext([{ shared: false }]);
		await run(taskSharing, 'get', ctx, { task: 'tsk_5' });
		expect(ctx.calls.map((c) => c.path)).toEqual(['/mp/api/v1/tasks/tsk_5/sharing']);
	});

	it('configure: reads the current settings, applies the changes, and posts the whole DTO (omitted flags would reset to false)', async () => {
		const current = {
			shared: false,
			publicLink: 'link-1',
			expiresAt: null,
			shareAssignee: true,
			shareDescription: true,
			shareStatus: false,
			sharedCustomFieldIdentifiers: ['cf_1'],
		};
		const ctx = fakeContext([current, { ...current, shared: true }]);
		const out = await run(taskSharing, 'configure', ctx, {
			task: 'tsk_5',
			shared: true,
			additionalFields: { shareStatus: true, expiresAt: '2026-12-31', shareAssignee: false },
		});
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: '/mp/api/v1/tasks/tsk_5/sharing' },
			{
				method: 'POST',
				path: '/mp/api/v1/tasks/tsk_5/sharing',
				body: {
					shared: true,
					expiresAt: '2026-12-31T00:00:00Z',
					shareAssignee: false,
					shareDescription: true,
					shareStatus: true,
					sharedCustomFieldIdentifiers: ['cf_1'],
				},
			},
		]);
		expect(out).toEqual([{ json: { ...current, shared: true } }]);
	});

	it('configure: custom fields to show are chosen from the custom field picker', () => {
		const collectionField = fieldOf(taskSharing, 'configure', 'additionalFields');
		const cf = (collectionField?.options as Array<{ name: string; typeOptions?: unknown }>).find(
			(o) => o.name === 'sharedCustomFieldIdentifiers',
		);
		expect((cf?.typeOptions as { loadOptionsMethod?: string }).loadOptionsMethod).toBe(
			'getCustomFieldIds',
		);
	});

	it('configure: a task key is resolved first', async () => {
		const ctx = fakeContext([{ identifier: 'tsk_9' }, {}, {}]);
		await run(taskSharing, 'configure', ctx, {
			task: 'PROJ-42',
			shared: false,
			additionalFields: {},
		});
		expect(ctx.calls.map((c) => c.path)).toEqual([
			'/mp/api/v1/tasks/lite/PROJ-42',
			'/mp/api/v1/tasks/tsk_9/sharing',
			'/mp/api/v1/tasks/tsk_9/sharing',
		]);
	});
});

describe('timeEntry', () => {
	it('list: resolves the key, pages time-entries zero-based, honors Limit', async () => {
		const ctx = fakeContext([{ identifier: 'tsk_9' }, [{ id: 1 }, { id: 2 }, { id: 3 }]]);
		const out = await run(timeEntry, 'list', ctx, { task: 'PROJ-42', returnAll: false, limit: 2 });
		expect(ctx.calls[0].path).toBe('/mp/api/v1/tasks/lite/PROJ-42');
		expect(ctx.calls[1]).toMatchObject({
			method: 'GET',
			path: '/mp/api/v1/tasks/tsk_9/time-entries',
			qs: { page: 0, size: 100 },
		});
		expect(out).toEqual([{ json: { id: 1 } }, { json: { id: 2 } }]);
		expect(opOf(timeEntry, 'list').list).toBe(true);
	});

	it('list: Return All keeps paging at 100 until a short page', async () => {
		const full = Array.from({ length: 100 }, (_, i) => ({ id: i }));
		const ctx = fakeContext([full, [{ id: 100 }]]);
		const out = await run(timeEntry, 'list', ctx, { task: 'tsk_1', returnAll: true });
		expect(ctx.calls.map((c) => c.qs)).toEqual([
			{ page: 0, size: 100 },
			{ page: 1, size: 100 },
		]);
		expect(out).toHaveLength(101);
	});

	it('create: POST time-entries with minutes, start instant and optional notes', async () => {
		const ctx = fakeContext([{ id: 7, timeSpent: 90 }]);
		const out = await run(timeEntry, 'create', ctx, {
			task: 'tsk_1',
			timeSpent: 90,
			startedAt: '2026-10-20T09:00:00',
			additionalFields: { notes: 'Login form' },
		});
		expect(ctx.calls).toEqual([
			{
				method: 'POST',
				path: '/mp/api/v1/tasks/tsk_1/time-entries',
				body: { timeSpent: 90, startedAt: '2026-10-20T09:00:00Z', notes: 'Login form' },
			},
		]);
		expect(out).toEqual([{ json: { id: 7, timeSpent: 90 } }]);
	});

	it('create: notes are left out when blank', async () => {
		const ctx = fakeContext([{}]);
		await run(timeEntry, 'create', ctx, {
			task: 'tsk_1',
			timeSpent: 5,
			startedAt: '2026-10-20T09:00:00Z',
			additionalFields: {},
		});
		expect(ctx.calls[0].body).toEqual({ timeSpent: 5, startedAt: '2026-10-20T09:00:00Z' });
	});

	it('create: refuses minutes outside 1..10080 before any request', async () => {
		for (const timeSpent of [0, -3, 10081]) {
			const ctx = fakeContext([]);
			await expect(
				run(timeEntry, 'create', ctx, {
					task: 'tsk_1',
					timeSpent,
					startedAt: '2026-10-20T09:00:00Z',
					additionalFields: {},
				}),
			).rejects.toThrow(/between 1 and 10080/);
			expect(ctx.calls).toEqual([]);
		}
	});

	it('create: Time Spent and Started At are required', () => {
		expect(fieldOf(timeEntry, 'create', 'timeSpent')?.required).toBe(true);
		expect(fieldOf(timeEntry, 'create', 'startedAt')?.required).toBe(true);
	});

	it('delete: DELETE time-entries/{id} on the resolved task; 204 becomes success', async () => {
		const ctx = fakeContext([{ identifier: 'tsk_9' }, '']);
		const out = await run(timeEntry, 'delete', ctx, { task: 'PROJ-42', timeEntry: '7' });
		expect(ctx.calls[1]).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/tasks/tsk_9/time-entries/7',
		});
		expect(out).toEqual([{ json: { success: true } }]);
	});

	it('the entry to delete is chosen from a picker that follows the task', () => {
		expect(loaderOf(timeEntry, 'delete', 'timeEntry')).toBe('getTimeEntries');
		expect(dependsOn(timeEntry, 'delete', 'timeEntry')).toEqual(['task']);
	});
});

describe('savedFilter', () => {
	it('list: GET lists/{list}/filters (a plain array, no paging)', () => {
		expect(opOf(savedFilter, 'list').build!(reader({ list: 'lst_1' }))).toEqual({
			method: 'GET',
			path: '/mp/api/v1/lists/lst_1/filters',
		});
		expect(opOf(savedFilter, 'list').list).toBeUndefined();
	});

	it('create: POST lists/{list}/filters with name and parsed filter groups', () => {
		const groups = [
			{ precedingLogic: 'AND', filters: [{ field: 'status', operator: 'equals', value: 'Open' }] },
		];
		expect(
			opOf(savedFilter, 'create').build!(
				reader({
					list: 'lst_1',
					name: 'Open bugs',
					filterGroups: JSON.stringify(groups),
					additionalFields: { titleSearch: 'login', textSearch: 'crash' },
				}),
			),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/lists/lst_1/filters',
			body: { name: 'Open bugs', filterGroups: groups, titleSearch: 'login', textSearch: 'crash' },
		});
	});

	it('create: filter groups must be a JSON array', () => {
		expect(() =>
			opOf(savedFilter, 'create').build!(
				reader({ list: 'l', name: 'x', filterGroups: '{}', additionalFields: {} }),
			),
		).toThrow(/Filter Groups must be a JSON array/);
	});

	it('delete: DELETE lists/{list}/filters/{id}', () => {
		expect(opOf(savedFilter, 'delete').build!(reader({ list: 'lst_1', filter: '12' }))).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/lists/lst_1/filters/12',
		});
	});

	it('the list and the filter are chosen from pickers', () => {
		for (const name of ['list', 'create', 'delete']) {
			expect(loaderOf(savedFilter, name, 'list')).toBe('getListIds');
		}
		expect(loaderOf(savedFilter, 'delete', 'filter')).toBe('getSavedFilters');
		expect(dependsOn(savedFilter, 'delete', 'filter')).toEqual(['list']);
	});
});
