import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	createTestSpace,
	liveDescribe,
	loadOptionsOf,
	rawRequest,
	run,
	runError,
	runOne,
	runId,
} from './harness';

liveDescribe('sprint — live', () => {
	const cleanup = cleanupStack();
	let space: { identifier: string; name: string };
	let group = '';
	let sprint = '';
	let nextSprint = '';
	let taskKey = '';

	beforeAll(async () => {
		space = await createTestSpace(cleanup, 'sprint');
		// Sprints are off for a new space, and the node has no Space > Update.
		await rawRequest({
			method: 'PUT',
			path: `/mp/api/v1/spaces/${space.identifier}`,
			body: { isSprintsEnabled: true },
		});
		const listName = `Sprint tasks ${runId}`;
		await runOne('list', 'create', { space: space.name, name: listName });
		const task = await runOne('task', 'create', { title: `Sprint task ${runId}`, list: listName });
		taskKey = String(task.key);
		cleanup.add(`task ${taskKey}`, async () => await runOne('task', 'delete', { task: taskKey }));
	});
	afterAll(async () => await cleanup.run());

	it('createGroup, then listGroups and the group picker show it', async () => {
		const created = await runOne('sprint', 'createGroup', {
			space: space.identifier,
			name: `Group ${runId}`,
			additionalFields: { defaultDurationDays: 7 },
		});
		expect(created).toMatchObject({ name: `Group ${runId}` });
		group = String(created.identifier);
		// The node has no group delete; the catalog's DELETE is used for cleanup.
		cleanup.add(`sprint group ${group}`, async () =>
			rawRequest({
				method: 'DELETE',
				path: `/mp/api/v1/spaces/${space.identifier}/sprint-groups/${group}`,
			}),
		);

		const groups = await run('sprint', 'listGroups', { space: space.identifier });
		expect(groups.map((g) => g.identifier)).toContain(group);
		const options = await loadOptionsOf('getSprintGroups', { space: space.identifier });
		expect(options.map((o) => o.value)).toContain(group);
	});

	it('create, get, update', async () => {
		const created = await runOne('sprint', 'create', {
			space: space.identifier,
			group,
			name: `Sprint ${runId}`,
			additionalFields: {
				goal: 'Live test',
				startDate: '2026-11-02T00:00:00',
				endDate: '2026-11-09T00:00:00',
			},
		});
		expect(created).toMatchObject({ name: `Sprint ${runId}`, goal: 'Live test' });
		sprint = String(created.identifier);
		cleanup.add(`sprint ${sprint}`, async () =>
			runOne('sprint', 'delete', { space: space.identifier, sprint }),
		);

		const options = await loadOptionsOf('getSprints', { space: space.identifier });
		expect(options.map((o) => o.value)).toContain(sprint);

		expect(await runOne('sprint', 'get', { space: space.identifier, sprint })).toMatchObject({
			identifier: sprint,
		});
		const updated = await runOne('sprint', 'update', {
			space: space.identifier,
			sprint,
			updateFields: { name: `Sprint renamed ${runId}` },
		});
		expect(updated).toMatchObject({ name: `Sprint renamed ${runId}`, goal: 'Live test' });
	});

	it('addTasks by key, getTasks, removeTasks', async () => {
		await runOne('sprint', 'addTasks', { space: space.identifier, sprint, taskIds: taskKey });
		const tasks = await run('sprint', 'getTasks', { space: space.identifier, sprint });
		expect(JSON.stringify(tasks)).toContain(taskKey);
		await runOne('sprint', 'removeTasks', { space: space.identifier, sprint, taskIds: taskKey });
		const after = await run('sprint', 'getTasks', { space: space.identifier, sprint });
		expect(JSON.stringify(after)).not.toContain(taskKey);
	});

	it('start, getBurndown, complete with rollover into a second sprint', async () => {
		const second = await runOne('sprint', 'create', {
			space: space.identifier,
			group,
			name: `Sprint next ${runId}`,
		});
		nextSprint = String(second.identifier);
		cleanup.add(`sprint ${nextSprint}`, async () =>
			runOne('sprint', 'delete', { space: space.identifier, sprint: nextSprint }),
		);
		await runOne('sprint', 'addTasks', { space: space.identifier, sprint, taskIds: taskKey });

		const started = await runOne('sprint', 'start', { space: space.identifier, sprint });
		expect(started).toEqual(expect.any(Object));
		const burndown = await run('sprint', 'getBurndown', { space: space.identifier, sprint });
		expect(Array.isArray(burndown)).toBe(true);

		await runOne('sprint', 'complete', {
			space: space.identifier,
			sprint,
			rolloverSprint: nextSprint,
		});
		const rolled = await run('sprint', 'getTasks', { space: space.identifier, sprint: nextSprint });
		expect(JSON.stringify(rolled)).toContain(taskKey);
	});

	it('delete removes the sprint (get then answers 404)', async () => {
		expect(
			await runOne('sprint', 'delete', { space: space.identifier, sprint: nextSprint }),
		).toEqual({ success: true });
		const error = await runError('sprint', 'get', { space: space.identifier, sprint: nextSprint });
		expect(error.httpCode).toBe('404');
	});
});
