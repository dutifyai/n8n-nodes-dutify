import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { sprint } from '../../../nodes/Dutify/resources/sprint';
import type { OperationDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

function op(name: string): OperationDef {
	const found = sprint.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${name}`);
	}

	return found;
}

const build = (name: string, params: Record<string, unknown>) => op(name).build!(reader(params));

const loaderOf = (operation: string, field: string) =>
	(
		op(operation).fields.find((f) => f.name === field)?.typeOptions as
			| { loadOptionsMethod?: string }
			| undefined
	)?.loadOptionsMethod;

describe('sprint registration', () => {
	it('is registered as "sprint" with the twelve sprint and sprint group operations', () => {
		expect(resources).toContain(sprint);
		expect(sprint.value).toBe('sprint');
		expect(sprint.workspaceScoped).toBe(true);
		expect(sprint.operations.map((o) => o.operation)).toEqual([
			'listGroups',
			'createGroup',
			'create',
			'get',
			'update',
			'delete',
			'start',
			'complete',
			'addTasks',
			'removeTasks',
			'getTasks',
			'getBurndown',
		]);
	});
});

describe('sprint groups', () => {
	it('listGroups: GET spaces/{space}/sprint-groups (a plain array, no paging)', () => {
		expect(build('listGroups', { space: 'sp_eng' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/spaces/sp_eng/sprint-groups',
		});
		expect(op('listGroups').list).toBeUndefined();
	});

	it('createGroup: POST spaces/{space}/sprint-groups with name; optional description and duration', () => {
		expect(
			build('createGroup', { space: 'sp_eng', name: 'Frontend Team', additionalFields: {} }),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/spaces/sp_eng/sprint-groups',
			body: { name: 'Frontend Team' },
		});
		expect(
			build('createGroup', {
				space: 'sp_eng',
				name: 'Frontend Team',
				additionalFields: { description: 'UI', defaultDurationDays: 14 },
			}).body,
		).toEqual({ name: 'Frontend Team', description: 'UI', defaultDurationDays: 14 });
	});

	it('the space is chosen from a picker', () => {
		expect(loaderOf('listGroups', 'space')).toBe('getSpaceIds');
		expect(loaderOf('createGroup', 'space')).toBe('getSpaceIds');
	});
});

describe('sprints', () => {
	it('create: POST sprint-groups/{group}/sprints with name; goal and ISO dates optional', () => {
		expect(
			build('create', { space: 'sp_eng', group: 'sg_1', name: 'Sprint 14', additionalFields: {} }),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/sprint-groups/sg_1/sprints',
			body: { name: 'Sprint 14' },
		});
		expect(
			build('create', {
				space: 'sp_eng',
				group: 'sg_1',
				name: 'Sprint 14',
				additionalFields: {
					goal: 'Ship it',
					startDate: '2026-04-14T00:00:00',
					endDate: '2026-04-28T00:00:00Z',
				},
			}).body,
		).toEqual({
			name: 'Sprint 14',
			goal: 'Ship it',
			startDate: '2026-04-14T00:00:00Z',
			endDate: '2026-04-28T00:00:00Z',
		});
	});

	it('get: GET sprints/{sprint}', () => {
		expect(build('get', { space: 'sp_eng', sprint: 'spr_1' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/sprints/spr_1',
		});
	});

	it('update: PUT sprints/{sprint} with only the set fields; refuses an empty update', () => {
		expect(
			build('update', {
				space: 'sp_eng',
				sprint: 'spr_1',
				updateFields: { name: 'Sprint 15', goal: 'New goal', endDate: '2026-05-01' },
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/sprints/spr_1',
			body: { name: 'Sprint 15', goal: 'New goal', endDate: '2026-05-01T00:00:00Z' },
		});
		expect(() => build('update', { space: 'sp_eng', sprint: 'spr_1', updateFields: {} })).toThrow(
			/at least one field/i,
		);
	});

	it('delete: DELETE sprints/{sprint}', () => {
		expect(build('delete', { space: 'sp_eng', sprint: 'spr_1' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/sprints/spr_1',
		});
	});

	it('start: POST sprints/{sprint}/start, no body', () => {
		expect(build('start', { space: 'sp_eng', sprint: 'spr_1' })).toEqual({
			method: 'POST',
			path: '/mp/api/v1/sprints/spr_1/start',
		});
	});

	it('complete: POST sprints/{sprint}/complete; the body is required, rollover is optional', () => {
		expect(build('complete', { space: 'sp_eng', sprint: 'spr_1', rolloverSprint: '' })).toEqual({
			method: 'POST',
			path: '/mp/api/v1/sprints/spr_1/complete',
			body: {},
		});
		expect(
			build('complete', { space: 'sp_eng', sprint: 'spr_1', rolloverSprint: 'spr_2' }).body,
		).toEqual({ rolloverSprintIdentifier: 'spr_2' });
	});

	it('getTasks: GET sprints/{sprint}/tasks (a plain array, no paging)', () => {
		expect(build('getTasks', { space: 'sp_eng', sprint: 'spr_1' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/sprints/spr_1/tasks',
		});
	});

	it('getBurndown: GET sprints/{sprint}/burndown', () => {
		expect(build('getBurndown', { space: 'sp_eng', sprint: 'spr_1' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/sprints/spr_1/burndown',
		});
	});

	it('every operation that takes a sprint or group picks it from a loader', () => {
		expect(loaderOf('create', 'group')).toBe('getSprintGroups');
		expect(loaderOf('create', 'space')).toBe('getSpaceIds');
		for (const name of [
			'get',
			'update',
			'delete',
			'start',
			'complete',
			'addTasks',
			'removeTasks',
			'getTasks',
			'getBurndown',
		]) {
			expect(loaderOf(name, 'sprint')).toBe('getSprints');
			expect(loaderOf(name, 'space')).toBe('getSpaceIds');
		}
		expect(loaderOf('complete', 'rolloverSprint')).toBe('getSprints');
	});
});

describe('sprint tasks', () => {
	const run = async (name: string, params: Record<string, unknown>, responses: unknown[]) => {
		const ctx = fakeContext(responses);
		const items = await op(name).run!(ctx, reader(params));

		return { items, calls: ctx.calls };
	};

	it('addTasks: task IDs go straight to POST sprints/{sprint}/tasks/add', async () => {
		const { items, calls } = await run(
			'addTasks',
			{ space: 'sp_eng', sprint: 'spr_1', taskIds: 'tsk_a, tsk_b' },
			[{ identifier: 'spr_1', totalTasks: 2 }],
		);
		expect(calls).toEqual([
			{
				method: 'POST',
				path: '/mp/api/v1/sprints/spr_1/tasks/add',
				body: { taskIdentifiers: ['tsk_a', 'tsk_b'] },
			},
		]);
		expect(items).toEqual([{ json: { identifier: 'spr_1', totalTasks: 2 } }]);
	});

	it('removeTasks: POST sprints/{sprint}/tasks/remove with taskIdentifiers', async () => {
		const { calls } = await run(
			'removeTasks',
			{ space: 'sp_eng', sprint: 'spr_1', taskIds: 'tsk_a' },
			[{ identifier: 'spr_1' }],
		);
		expect(calls).toEqual([
			{
				method: 'POST',
				path: '/mp/api/v1/sprints/spr_1/tasks/remove',
				body: { taskIdentifiers: ['tsk_a'] },
			},
		]);
	});

	it('a task key such as PROJ-42 is resolved to its ID first (the endpoint takes IDs only)', async () => {
		const { calls } = await run(
			'addTasks',
			{ space: 'sp_eng', sprint: 'spr_1', taskIds: 'PROJ-42, tsk_b' },
			[{ key: 'PROJ-42', identifier: 'tsk_resolved' }, { identifier: 'spr_1' }],
		);
		expect(calls).toEqual([
			{ method: 'GET', path: '/mp/api/v1/tasks/lite/PROJ-42', qs: { workspace: 'ws-1' } },
			{
				method: 'POST',
				path: '/mp/api/v1/sprints/spr_1/tasks/add',
				body: { taskIdentifiers: ['tsk_resolved', 'tsk_b'] },
			},
		]);
	});

	it('a key that does not resolve to an ID stops before changing the sprint', async () => {
		const ctx = fakeContext([{ key: 'PROJ-42' }]);
		await expect(
			op('removeTasks').run!(ctx, reader({ space: 'sp_eng', sprint: 'spr_1', taskIds: 'PROJ-42' })),
		).rejects.toThrow(/PROJ-42/);
		expect(ctx.calls).toHaveLength(1);
	});

	it('refuses an empty task list before any request (the backend requires at least one)', async () => {
		const ctx = fakeContext([]);
		await expect(
			op('addTasks').run!(ctx, reader({ space: 'sp_eng', sprint: 'spr_1', taskIds: ' , ' })),
		).rejects.toThrow(/at least one task/i);
		expect(ctx.calls).toEqual([]);
	});
});
