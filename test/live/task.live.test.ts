import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	createTestSpace,
	liveDescribe,
	live,
	loadOptionsOf,
	rawRequest,
	run,
	runError,
	runOne,
	runId,
} from './harness';

liveDescribe('task, task comment, task relationship — live', () => {
	const cleanup = cleanupStack();
	let space: { identifier: string; name: string };
	const listName = `Tasks ${runId}`;
	let status = '';
	let task: { key: string; identifier: string };

	beforeAll(async () => {
		space = await createTestSpace(cleanup, 'task');
		await runOne('list', 'create', { space: space.name, name: listName });
	});
	afterAll(async () => await cleanup.run());

	async function createTask(title: string, extra: Record<string, unknown> = {}) {
		const created = await runOne('task', 'create', { title, list: listName, ...extra });
		const ref = { key: String(created.key), identifier: String(created.identifier) };
		cleanup.add(`task ${ref.key}`, async () => await runOne('task', 'delete', { task: ref.key }));

		return { created, ...ref };
	}

	it('the space, list and status dropdowns populate', async () => {
		expect((await loadOptionsOf('getSpaces')).map((o) => o.value)).toContain(space.name);
		const lists = await loadOptionsOf('getLists', { space: space.name });
		expect(lists.map((o) => o.value)).toContain(listName);
		const statuses = await loadOptionsOf('getStatuses', { space: space.name, list: listName });
		expect(statuses.length).toBeGreaterThan(0);
		status = String(statuses[0].value);
		expect((await loadOptionsOf('getMembers')).map((o) => o.value)).toContain(live.userEmail);
	});

	it('create by list NAME (resolved through the shallow context) with a status', async () => {
		const made = await createTask(`Live task ${runId}`, {
			status,
			additionalFields: { description: 'Created by the n8n live tests', tags: `t-${runId}` },
		});
		task = { key: made.key, identifier: made.identifier };
		expect(made.created).toMatchObject({
			title: `Live task ${runId}`,
			description: 'Created by the n8n live tests',
			list: listName,
			space: space.name,
			status,
		});
		expect(made.created.tags).toEqual([`t-${runId}`]);
	});

	it('get by key and by ID return the same task', async () => {
		const byKey = await runOne('task', 'get', { task: task.key });
		const byId = await runOne('task', 'get', { task: task.identifier });
		expect(byKey.identifier).toBe(task.identifier);
		expect(byId.key).toBe(task.key);
	});

	it('update changes only the fields set', async () => {
		const updated = await runOne('task', 'update', {
			task: task.key,
			updateFields: { title: `Live task renamed ${runId}`, estimatedTime: 30 },
		});
		expect(updated).toMatchObject({
			title: `Live task renamed ${runId}`,
			description: 'Created by the n8n live tests',
			estimatedTime: 30,
		});
	});

	it('a misspelled status answers 400 whose description lists the valid options', async () => {
		const error = await runError('task', 'create', {
			title: `Bad status ${runId}`,
			list: listName,
			status: 'Not A Real Status zz',
		});
		expect(error.httpCode).toBe('400');
		expect(error.description).toContain('Valid options:');
		expect(error.description).toContain(status);
	});

	it('subtasks: update a task with a parent key, then getSubtasks', async () => {
		const child = await createTask(`Live subtask ${runId}`);
		const updated = await runOne('task', 'update', {
			task: child.key,
			updateFields: { parent: task.key },
		});
		expect(updated.parent).toBe(task.key);
		const subtasks = await run('task', 'getSubtasks', { task: task.key, returnAll: true });
		expect(subtasks.map((s) => s.key)).toContain(child.key);
	});

	// A new space has subtasks off; creating a subtask there is refused (PM TaskService).
	it('subtasks: create with only a parent is refused while the space has subtasks off', async () => {
		const error = await runError('task', 'create', {
			title: `Live subtask refused ${runId}`,
			additionalFields: { parent: task.identifier },
		});
		expect(error.httpCode).toBe('400');
		expect(error.message).toContain('Subtasks are not enabled for this space');
	});

	// Fixed in dutify-pm #234 (prod-0.1.793): the parent alone places the subtask, by task ID or
	// by key (the key resolves in the API key's workspace).
	it('subtasks: create with only a parent, by task ID and by key, lands in the parent list', async () => {
		// The node has no Space > Update.
		await rawRequest({
			method: 'PUT',
			path: `/mp/api/v1/spaces/${space.identifier}`,
			body: { isSubtasksEnabled: true },
		});
		for (const parent of [task.identifier, task.key]) {
			const created = await runOne('task', 'create', {
				title: `Live subtask by create ${runId}`,
				additionalFields: { parent },
			});
			cleanup.add(
				`task ${String(created.key)}`,
				async () => await runOne('task', 'delete', { task: String(created.key) }),
			);
			expect(created.parent).toBe(task.key);
			expect(created.list).toBe(listName);
		}
		const subtasks = await run('task', 'getSubtasks', { task: task.key, returnAll: true });
		expect(subtasks.filter((s) => s.title === `Live subtask by create ${runId}`)).toHaveLength(2);
	});

	it('search finds the task by text and list name', async () => {
		const found = await run('task', 'search', {
			additionalFields: { query: `renamed ${runId}`, list: listName },
			returnAll: true,
		});
		expect(found.map((t) => t.key)).toContain(task.key);
		const limited = await run('task', 'search', {
			additionalFields: { list: listName },
			limit: 1,
		});
		expect(limited).toHaveLength(1);
	});

	it('listTypes and bulkChangeType', async () => {
		const types = await run('task', 'listTypes', { returnAll: true });
		expect(types.length).toBeGreaterThan(0);
		const typeName = String(types[0].name ?? types[0].singularName);
		const result = await runOne('task', 'bulkChangeType', {
			taskIds: task.identifier,
			taskType: typeName,
		});
		expect(result).toEqual(expect.any(Object));
		const after = await runOne('task', 'get', { task: task.key });
		expect(String(after.taskType).toLowerCase()).toBe(typeName.toLowerCase());
		const options = await loadOptionsOf('getTaskTypes');
		expect(options.length).toBeGreaterThan(0);
	});

	it('comments: create, list, update, react, unreact, delete', async () => {
		const comment = await runOne('taskComment', 'create', {
			task: task.key,
			text: `Live comment ${runId}`,
		});
		// The response carries the rendered HTML body.
		expect(comment.text).toBe(`<p>Live comment ${runId}</p>`);
		const commentId = String(comment.identifier);

		const listed = await run('taskComment', 'list', { task: task.key, returnAll: true });
		expect(listed.map((c) => c.identifier)).toContain(commentId);

		const updated = await runOne('taskComment', 'update', {
			task: task.key,
			comment: commentId,
			text: `Live comment edited ${runId}`,
		});
		expect(updated.text).toBe(`<p>Live comment edited ${runId}</p>`);

		await runOne('taskComment', 'addReaction', {
			task: task.identifier,
			comment: commentId,
			reactionType: 'thumbs_up',
		});
		const reactions = await run('taskComment', 'listReactions', {
			task: task.identifier,
			comment: commentId,
			returnAll: true,
		});
		expect(reactions.length).toBeGreaterThan(0);
		const reaction = String(reactions[0].identifier);
		expect(
			await runOne('taskComment', 'removeReaction', {
				task: task.identifier,
				comment: commentId,
				reaction,
			}),
		).toEqual(expect.any(Object));
		const remaining = await run('taskComment', 'listReactions', {
			task: task.identifier,
			comment: commentId,
			returnAll: true,
		});
		expect(remaining.map((r) => r.identifier)).not.toContain(reaction);

		expect(await runOne('taskComment', 'delete', { task: task.key, comment: commentId })).toEqual({
			success: true,
		});
		const afterDelete = await run('taskComment', 'list', { task: task.key, returnAll: true });
		expect(afterDelete.map((c) => c.identifier)).not.toContain(commentId);
	});

	it('relationships: create, list, delete', async () => {
		const context = await runOne('workspace', 'getContext', {
			additionalFields: { includeRelationshipTypes: true },
		});
		const types = (context.relationshipTypes ?? []) as string[];
		expect(types.length).toBeGreaterThan(0);
		const target = await createTask(`Live link target ${runId}`);

		const link = await runOne('taskRelationship', 'create', {
			task: task.key,
			type: types[0],
			target: target.key,
		});
		const relationship = String(link.identifier);
		expect(link.type).toBe(types[0]);

		const listed = await run('taskRelationship', 'list', { task: task.key, returnAll: true });
		expect(listed.map((r) => r.identifier)).toContain(relationship);

		expect(await runOne('taskRelationship', 'delete', { task: task.key, relationship })).toEqual({
			success: true,
		});
		const after = await run('taskRelationship', 'list', { task: task.key, returnAll: true });
		expect(after.map((r) => r.identifier)).not.toContain(relationship);
	});

	it('delete removes the task (get then answers 404)', async () => {
		const doomed = await createTask(`Live doomed ${runId}`);
		expect(await runOne('task', 'delete', { task: doomed.key })).toEqual({ success: true });
		const error = await runError('task', 'get', { task: doomed.key });
		expect(error.httpCode).toBe('404');
	});
});
