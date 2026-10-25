import type { INodeProperties } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { task, taskComment, taskRelationship } from '../../../nodes/Dutify/resources/task';
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
	params: Record<string, unknown>,
	responses: unknown[],
) {
	const o = op(def, name);
	if (!o.run) {
		throw new Error(`${name} has no run`);
	}
	const ctx = fakeContext(responses);
	const items = await o.run(ctx, reader(params, 'ws-1'));

	return { items, calls: ctx.calls };
}

/** Finds a field by name at the top level or inside a collection of the operation. */
function field(def: ResourceDef, name: string, fieldName: string): INodeProperties | undefined {
	const all: INodeProperties[] = [];
	for (const f of op(def, name).fields) {
		all.push(f);
		if (f.type === 'collection') {
			all.push(...(f.options as INodeProperties[]));
		}
	}

	return all.find((f) => f.name === fieldName);
}

const CURSOR_200 = {
	kind: 'cursor',
	cursorParam: 'cursor',
	limitParam: 'limit',
	itemsPath: 'items',
	nextCursorPath: 'nextCursor',
	maxPageSize: 200,
};

describe('registration', () => {
	it('registers task, taskComment and taskRelationship with the planned operations', () => {
		expect(resources).toContain(task);
		expect(resources).toContain(taskComment);
		expect(resources).toContain(taskRelationship);
		expect([task.value, taskComment.value, taskRelationship.value]).toEqual([
			'task',
			'taskComment',
			'taskRelationship',
		]);
		expect([task, taskComment, taskRelationship].every((r) => r.workspaceScoped)).toBe(true);
		expect(task.operations.map((o) => o.operation)).toEqual([
			'search',
			'get',
			'getSubtasks',
			'create',
			'update',
			'delete',
			'listTypes',
			'bulkChangeType',
		]);
		expect(taskComment.operations.map((o) => o.operation)).toEqual([
			'list',
			'create',
			'update',
			'delete',
			'addReaction',
			'listReactions',
			'removeReaction',
		]);
		expect(taskRelationship.operations.map((o) => o.operation)).toEqual([
			'list',
			'create',
			'delete',
		]);
	});
});

describe('task', () => {
	it('search: GET tasks/lite/search with the workspace, cursor pagination (max 200)', () => {
		expect(build(task, 'search', { additionalFields: {} })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/tasks/lite/search',
			qs: { workspace: 'ws-1' },
			paginate: CURSOR_200,
		});
		expect(op(task, 'search').list).toBe(true);
	});

	it('search: filters map to the catalog query names; multi-value filters become arrays', () => {
		expect(
			build(task, 'search', {
				additionalFields: {
					query: 'login',
					space: 'Engineering',
					list: 'lst_1',
					parent: 'PROJ-1',
					status: 'In Progress, Done',
					priority: 'High',
					tag: 'backend,urgent',
					assignee: ['alice@dutify.ai'],
					taskType: ['Bug'],
					includeClosed: true,
					includeArchived: true,
					includeSubtasks: false,
				},
			}),
		).toEqual({
			method: 'GET',
			path: '/mp/api/v1/tasks/lite/search',
			qs: {
				workspace: 'ws-1',
				q: 'login',
				space: 'Engineering',
				list: 'lst_1',
				parent: 'PROJ-1',
				status: ['In Progress', 'Done'],
				priority: ['High'],
				tag: ['backend', 'urgent'],
				assignee: ['alice@dutify.ai'],
				taskType: ['Bug'],
				includeClosed: true,
				includeArchived: true,
				includeSubtasks: false,
			},
			paginate: CURSOR_200,
		});
	});

	it('search run: a list picked by name is resolved to its identifier before searching', async () => {
		const { calls } = await run(
			task,
			'search',
			{
				additionalFields: { space: 'Engineering', list: 'Backlog', query: 'x' },
				returnAll: false,
				limit: 5,
			},
			[
				{
					spaces: [
						{ name: 'Engineering', lists: [{ identifier: 'lst_backlog', name: 'Backlog' }] },
					],
				},
				{ items: [{ identifier: 'tsk_1' }] },
			],
		);
		expect(calls[0].path).toBe('/mp/api/v1/workspaces/ws-1/lite/context');
		expect(calls[1]).toMatchObject({
			path: '/mp/api/v1/tasks/lite/search',
			qs: { workspace: 'ws-1', space: 'Engineering', list: 'lst_backlog', q: 'x', limit: 5 },
		});
	});

	it('search run: without a list filter no context lookup is made, and Return All follows the cursor', async () => {
		const { items, calls } = await run(task, 'search', { additionalFields: {}, returnAll: true }, [
			{ items: [{ identifier: 'tsk_1' }], nextCursor: 'c2' },
			{ items: [{ identifier: 'tsk_2' }] },
		]);
		expect(calls).toHaveLength(2);
		expect(calls[1].qs).toMatchObject({ cursor: 'c2' });
		expect(items).toEqual([{ json: { identifier: 'tsk_1' } }, { json: { identifier: 'tsk_2' } }]);
	});

	it('get: GET tasks/lite/{ref} with workspace query (keys are workspace scoped), ref encoded', () => {
		expect(build(task, 'get', { task: 'PROJ-123' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/tasks/lite/PROJ-123',
			qs: { workspace: 'ws-1' },
		});
		expect(build(task, 'get', { task: 'a/b' }).path).toBe('/mp/api/v1/tasks/lite/a%2Fb');
	});

	it('getSubtasks: GET .../subtasks, cursor pagination, closed/archived flags only when set', () => {
		expect(build(task, 'getSubtasks', { task: 'PROJ-1', additionalFields: {} })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/tasks/lite/PROJ-1/subtasks',
			qs: { workspace: 'ws-1' },
			paginate: CURSOR_200,
		});
		expect(
			build(task, 'getSubtasks', {
				task: 'PROJ-1',
				additionalFields: { includeClosed: true, includeArchived: false },
			}).qs,
		).toEqual({ workspace: 'ws-1', includeClosed: true, includeArchived: false });
		expect(op(task, 'getSubtasks').list).toBe(true);
	});

	it('create: POST tasks/lite, and the picked names go to the body unchanged', () => {
		expect(
			build(task, 'create', {
				title: 'Fix login bug',
				space: 'Engineering',
				list: 'Backlog',
				status: 'In Progress',
				additionalFields: {
					assignees: ['alice@dutify.ai'],
					priority: 'High',
					taskType: 'Bug',
					level: 'L2',
					description: 'Times out',
					tags: 'backend, urgent',
					parent: 'PROJ-122',
					nextTo: 'PROJ-110',
					customFields: '{"Severity":"High","Story Points":5}',
					startDate: '2026-04-20T00:00:00',
					dueDate: '2026-04-25T00:00:00Z',
					estimatedTime: 120,
					isPrivate: true,
					recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
				},
			}),
		).toEqual({
			// The catalog gives POST /tasks/lite no query parameters, and the backend rejects
			// unknown ones (seen live). The workspace travels in the X-Dutify-Workspace header.
			method: 'POST',
			path: '/mp/api/v1/tasks/lite',
			body: {
				title: 'Fix login bug',
				list: 'Backlog',
				status: 'In Progress',
				assignees: ['alice@dutify.ai'],
				priority: 'High',
				taskType: 'Bug',
				level: 'L2',
				description: 'Times out',
				tags: ['backend', 'urgent'],
				parent: 'PROJ-122',
				nextTo: 'PROJ-110',
				customFields: { Severity: 'High', 'Story Points': 5 },
				startDate: '2026-04-20T00:00:00Z',
				dueDate: '2026-04-25T00:00:00Z',
				estimatedTime: 120,
				isPrivate: true,
				recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
			},
		});
	});

	it('create: only title and list are sent when nothing else is set (space is a picker helper, not a body field)', () => {
		const spec = build(task, 'create', {
			title: 'T',
			space: 'Engineering',
			list: 'lst_1',
			status: '',
			additionalFields: {},
		});
		expect(spec.body).toEqual({ title: 'T', list: 'lst_1' });
	});

	it('create: space, list, status and assignees pickers use the context loaders with the right dependencies', () => {
		expect(field(task, 'create', 'space')?.typeOptions).toMatchObject({
			loadOptionsMethod: 'getSpaces',
		});
		expect(field(task, 'create', 'list')?.typeOptions).toMatchObject({
			loadOptionsMethod: 'getLists',
			loadOptionsDependsOn: ['space'],
		});
		expect(field(task, 'create', 'status')?.typeOptions).toMatchObject({
			loadOptionsMethod: 'getStatuses',
			loadOptionsDependsOn: ['list'],
		});
		expect(field(task, 'create', 'assignees')?.typeOptions).toMatchObject({
			loadOptionsMethod: 'getMembers',
		});
		expect(field(task, 'create', 'taskType')?.typeOptions).toMatchObject({
			loadOptionsMethod: 'getTaskTypes',
		});
	});

	it('create run: a list picked by name is resolved to its identifier through the workspace context', async () => {
		const { calls } = await run(
			task,
			'create',
			{ title: 'T', space: 'Engineering', list: 'Backlog', status: 'Open', additionalFields: {} },
			[
				{
					spaces: [
						{
							name: 'Engineering',
							lists: [{ identifier: 'lst_backlog', name: 'Backlog' }],
							folders: [{ name: 'Q2', lists: [{ identifier: 'lst_q2', name: 'Roadmap' }] }],
						},
					],
				},
				{ identifier: 'tsk_1' },
			],
		);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/lite/context',
			qs: { space: 'Engineering' },
		});
		expect(calls[1]).toEqual({
			method: 'POST',
			path: '/mp/api/v1/tasks/lite',
			body: { title: 'T', list: 'lst_backlog', status: 'Open' },
		});
	});

	it('create run: a list inside a folder is found too', async () => {
		const { calls } = await run(
			task,
			'create',
			{ title: 'T', space: '', list: 'Roadmap', status: '', additionalFields: {} },
			[
				{
					spaces: [
						{
							name: 'Engineering',
							folders: [{ name: 'Q2', lists: [{ identifier: 'lst_q2', name: 'Roadmap' }] }],
						},
					],
				},
				{},
			],
		);
		expect(calls[1].body).toEqual({ title: 'T', list: 'lst_q2' });
	});

	it('create run: a list value that matches no list name is sent as given (already an identifier)', async () => {
		const { calls } = await run(
			task,
			'create',
			{ title: 'T', space: '', list: 'lst_xyz', status: '', additionalFields: {} },
			[
				{ spaces: [{ name: 'Engineering', lists: [{ identifier: 'lst_a', name: 'Backlog' }] }] },
				{},
			],
		);
		expect(calls[1].body).toEqual({ title: 'T', list: 'lst_xyz' });
	});

	it('create run: two lists with the same name are refused instead of guessing', async () => {
		await expect(
			run(
				task,
				'create',
				{ title: 'T', space: '', list: 'Backlog', status: '', additionalFields: {} },
				[
					{
						spaces: [
							{ name: 'A', lists: [{ identifier: 'lst_a', name: 'Backlog' }] },
							{ name: 'B', lists: [{ identifier: 'lst_b', name: 'Backlog' }] },
						],
					},
				],
			),
		).rejects.toThrow(/more than one list named "Backlog"/);
	});

	it('create run: with a parent and no list no context lookup is made', async () => {
		const { calls } = await run(
			task,
			'create',
			{ title: 'T', space: '', list: '', status: '', additionalFields: { parent: 'PROJ-1' } },
			[{}],
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].body).toEqual({ title: 'T', parent: 'PROJ-1' });
	});

	it('update: PATCH tasks/lite/{ref} with only the fields that were set', () => {
		expect(
			build(task, 'update', {
				task: 'PROJ-1',
				updateFields: {
					title: 'New',
					status: 'Done',
					assignees: ['a@dutify.ai'],
					tags: 'x,y',
					dueDate: '2026-05-01T10:00:00+02:00',
					timeSpent: 30,
				},
			}),
		).toEqual({
			method: 'PATCH',
			path: '/mp/api/v1/tasks/lite/PROJ-1',
			qs: { workspace: 'ws-1' },
			body: {
				title: 'New',
				status: 'Done',
				assignees: ['a@dutify.ai'],
				tags: ['x', 'y'],
				dueDate: '2026-05-01T10:00:00+02:00',
				timeSpent: 30,
			},
		});
	});

	it('update: an empty tag or assignee list is sent as [] (replace with nothing), not dropped', () => {
		expect(
			build(task, 'update', { task: 'PROJ-1', updateFields: { tags: '', assignees: [] } }).body,
		).toEqual({ tags: [], assignees: [] });
	});

	it('update run: a list to move to is resolved by name; a task without list changes needs no lookup', async () => {
		const moved = await run(task, 'update', { task: 'PROJ-1', updateFields: { list: 'Backlog' } }, [
			{ spaces: [{ name: 'E', lists: [{ identifier: 'lst_b', name: 'Backlog' }] }] },
			{},
		]);
		expect(moved.calls[1]).toMatchObject({ method: 'PATCH', body: { list: 'lst_b' } });
		const plain = await run(task, 'update', { task: 'PROJ-1', updateFields: { title: 'x' } }, [{}]);
		expect(plain.calls).toHaveLength(1);
	});

	it('delete: DELETE tasks/lite/{ref}', () => {
		expect(build(task, 'delete', { task: 'PROJ-1' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/tasks/lite/PROJ-1',
			qs: { workspace: 'ws-1' },
		});
	});

	it('listTypes: GET the workspace task type catalogue', () => {
		expect(build(task, 'listTypes', {})).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/task-types',
		});
		expect(op(task, 'listTypes').list).toBe(true);
	});

	it('bulkChangeType run: the type name becomes its identifier, task ids become an array', async () => {
		const { calls, items } = await run(
			task,
			'bulkChangeType',
			{ taskIds: 'tsk_1, tsk_2', taskType: 'Bug' },
			[
				[
					{ identifier: 'tt_task', name: 'Task', singularName: 'Task' },
					{ identifier: 'tt_bug', name: 'Bug', singularName: 'Bug' },
				],
				{ jobId: null, updated: 2 },
			],
		);
		expect(calls[0]).toMatchObject({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/task-types',
		});
		expect(calls[1]).toEqual({
			method: 'POST',
			path: '/mp/api/v1/tasks/bulk/change-type',
			body: {
				taskIdentifiers: ['tsk_1', 'tsk_2'],
				targetTaskTypeIdentifier: 'tt_bug',
				workspaceIdentifier: 'ws-1',
			},
		});
		expect(items).toEqual([{ json: { jobId: null, updated: 2 } }]);
	});

	it('bulkChangeType run: a blank type clears the type without looking types up', async () => {
		const { calls } = await run(task, 'bulkChangeType', { taskIds: 'tsk_1', taskType: '' }, [{}]);
		expect(calls).toHaveLength(1);
		expect(calls[0].body).toEqual({
			taskIdentifiers: ['tsk_1'],
			targetTaskTypeIdentifier: null,
			workspaceIdentifier: 'ws-1',
		});
	});

	it('bulkChangeType run: an unknown type name names the valid ones and sends nothing', async () => {
		await expect(
			run(task, 'bulkChangeType', { taskIds: 'tsk_1', taskType: 'Nope' }, [
				[{ identifier: 'tt_bug', name: 'Bug', singularName: 'Bug' }],
			]),
		).rejects.toThrow(/Nope.*Bug/s);
	});
});

describe('taskComment', () => {
	it('list: GET .../comments, cursor pagination', () => {
		expect(build(taskComment, 'list', { task: 'PROJ-1' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/tasks/lite/PROJ-1/comments',
			qs: { workspace: 'ws-1' },
			paginate: CURSOR_200,
		});
		expect(op(taskComment, 'list').list).toBe(true);
	});

	it('create: POST .../comments with text, mentions and replyTo', () => {
		expect(
			build(taskComment, 'create', {
				task: 'PROJ-1',
				text: 'Hi @alice@dutify.ai please review',
				additionalFields: { mentions: ['alice@dutify.ai'], replyTo: 'cmt_parent_123' },
			}),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/tasks/lite/PROJ-1/comments',
			qs: { workspace: 'ws-1' },
			body: {
				text: 'Hi @alice@dutify.ai please review',
				mentions: ['alice@dutify.ai'],
				replyTo: 'cmt_parent_123',
			},
		});
		expect(
			build(taskComment, 'create', { task: 'PROJ-1', text: 'plain', additionalFields: {} }).body,
		).toEqual({ text: 'plain' });
	});

	it('update: PUT .../comments/{id} with text and mentions', () => {
		expect(
			build(taskComment, 'update', {
				task: 'PROJ-1',
				comment: 'cmt_1',
				text: 'Edited',
				additionalFields: { mentions: ['a@dutify.ai'] },
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/tasks/lite/PROJ-1/comments/cmt_1',
			qs: { workspace: 'ws-1' },
			body: { text: 'Edited', mentions: ['a@dutify.ai'] },
		});
	});

	it('delete: DELETE .../comments/{id}', () => {
		expect(build(taskComment, 'delete', { task: 'PROJ-1', comment: 'cmt_1' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/tasks/lite/PROJ-1/comments/cmt_1',
			qs: { workspace: 'ws-1' },
		});
	});

	/* The reaction endpoints take task IDs only; a task key is looked up first. */
	const keyLookup = {
		method: 'GET',
		path: '/mp/api/v1/tasks/lite/PROJ-42',
		qs: { workspace: 'ws-1' },
	};
	const TASK_ROW = { identifier: 'a1b2c3d4e5', key: 'PROJ-42' };

	it('addReaction: resolves a task key, then POSTs the reaction type to the comment reactions endpoint', async () => {
		const { items, calls } = await run(
			taskComment,
			'addReaction',
			{ task: 'PROJ-42', comment: 'cmt_1', reactionType: 'thumbs_up' },
			[TASK_ROW, { identifier: 'react_1', reactionType: 'thumbs_up' }],
		);
		expect(calls).toEqual([
			keyLookup,
			{
				method: 'POST',
				path: '/mp/api/v1/tasks/a1b2c3d4e5/comments/cmt_1/reactions',
				body: { reactionType: 'thumbs_up' },
			},
		]);
		expect(items).toEqual([{ json: { identifier: 'react_1', reactionType: 'thumbs_up' } }]);
	});

	it('listReactions: resolves a task key, then GETs with zero-based page/size pagination (backend max size 100)', async () => {
		const { items, calls } = await run(
			taskComment,
			'listReactions',
			{ task: 'PROJ-42', comment: 'cmt_1', returnAll: false, limit: 5 },
			[TASK_ROW, [{ identifier: 'react_1' }]],
		);
		expect(calls).toEqual([
			keyLookup,
			{
				method: 'GET',
				path: '/mp/api/v1/tasks/a1b2c3d4e5/comments/cmt_1/reactions',
				paginate: {
					kind: 'page',
					pageParam: 'page',
					sizeParam: 'size',
					zeroBased: true,
					maxPageSize: 100,
				},
				qs: { page: 0, size: 100 },
			},
		]);
		expect(items).toEqual([{ json: { identifier: 'react_1' } }]);
		expect(op(taskComment, 'listReactions').list).toBe(true);
	});

	it('removeReaction: resolves a task key, then DELETEs the reaction by its identifier', async () => {
		const { calls } = await run(
			taskComment,
			'removeReaction',
			{ task: 'PROJ-42', comment: 'cmt_1', reaction: 'react_1' },
			[TASK_ROW, undefined],
		);
		expect(calls).toEqual([
			keyLookup,
			{
				method: 'DELETE',
				path: '/mp/api/v1/tasks/a1b2c3d4e5/comments/cmt_1/reactions/react_1',
			},
		]);
	});

	it('reaction operations describe the Task field as accepting a key', () => {
		for (const name of ['addReaction', 'listReactions', 'removeReaction']) {
			expect(field(taskComment, name, 'task')?.description).toMatch(/PROJ-/);
		}
	});
});

describe('taskRelationship', () => {
	it('list: GET .../relationships, cursor pagination', () => {
		expect(build(taskRelationship, 'list', { task: 'PROJ-1' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/tasks/lite/PROJ-1/relationships',
			qs: { workspace: 'ws-1' },
			paginate: CURSOR_200,
		});
		expect(op(taskRelationship, 'list').list).toBe(true);
	});

	it('create: POST type name and target', () => {
		expect(
			build(taskRelationship, 'create', { task: 'PROJ-42', type: 'Blocking', target: 'PROJ-43' }),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/tasks/lite/PROJ-42/relationships',
			qs: { workspace: 'ws-1' },
			body: { type: 'Blocking', target: 'PROJ-43' },
		});
	});

	it('delete: DELETE .../relationships/{id}', () => {
		expect(build(taskRelationship, 'delete', { task: 'PROJ-42', relationship: 'rel_1' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/tasks/lite/PROJ-42/relationships/rel_1',
			qs: { workspace: 'ws-1' },
		});
	});
});
