import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	createTestSpace,
	liveDescribe,
	loadOptionsOf,
	run,
	runError,
	runOne,
	runId,
} from './harness';

liveDescribe('task sharing, time entry, saved filter — live', () => {
	const cleanup = cleanupStack();
	let space: { identifier: string; name: string };
	let listId = '';
	let taskKey = '';

	beforeAll(async () => {
		space = await createTestSpace(cleanup, 'extras');
		const listName = `Extras ${runId}`;
		listId = String(
			(await runOne('list', 'create', { space: space.name, name: listName })).identifier,
		);
		const task = await runOne('task', 'create', { title: `Extras task ${runId}`, list: listName });
		taskKey = String(task.key);
		cleanup.add(`task ${taskKey}`, async () => await runOne('task', 'delete', { task: taskKey }));
	});
	afterAll(async () => await cleanup.run());

	it('sharing: an unconfigured task answers a settings object that is not shared', async () => {
		const settings = await runOne('taskSharing', 'get', { task: taskKey });
		expect(settings).toEqual(expect.any(Object));
		expect(settings.shared === false || settings.shared === undefined).toBe(true);
	});

	// Public sharing needs a Pro plan; the test workspace is FREE. Turning sharing on can only
	// be checked for the refusal: a 402 whose message reaches the n8n error.
	it('sharing: configure on a FREE workspace is refused with the plan message', async () => {
		const error = await runError('taskSharing', 'configure', {
			task: taskKey,
			shared: true,
			additionalFields: { shareStatus: true },
		});
		expect(error.httpCode).toBe('402');
		expect(error.message).toContain('Pro');
		expect(error.description).toContain('QUOTA_EXCEEDED');
	});

	it('time entry: create, list, picker, delete', async () => {
		const created = await runOne('timeEntry', 'create', {
			task: taskKey,
			timeSpent: 25,
			startedAt: '2026-10-20T09:00:00',
			additionalFields: { notes: `live ${runId}` },
		});
		expect(created).toMatchObject({ timeSpent: 25, notes: `live ${runId}` });
		const entry = String(created.id); // time entries carry a numeric `id`
		cleanup.add(
			`time entry ${entry}`,
			async () => await runOne('timeEntry', 'delete', { task: taskKey, timeEntry: entry }),
		);

		const listed = await run('timeEntry', 'list', { task: taskKey, returnAll: true });
		expect(listed.map((e) => String(e.id))).toContain(entry);
		const options = await loadOptionsOf('getTimeEntries', { task: taskKey });
		expect(options.map((o) => o.value)).toContain(entry);

		expect(await runOne('timeEntry', 'delete', { task: taskKey, timeEntry: entry })).toEqual({
			success: true,
		});
		const after = await run('timeEntry', 'list', { task: taskKey, returnAll: true });
		expect(after.map((e) => String(e.id))).not.toContain(entry);
	});

	it('saved filter: create, list, picker, delete', async () => {
		const created = await runOne('savedFilter', 'create', {
			list: listId,
			name: `Open only ${runId}`,
			filterGroups:
				'[{"precedingLogic":"AND","filters":[{"field":"status","operator":"equals","value":"Open"}]}]',
			additionalFields: { titleSearch: 'Extras' },
		});
		expect(created).toMatchObject({ name: `Open only ${runId}` });
		const filter = String(created.id); // saved filters carry a numeric `id`
		cleanup.add(
			`saved filter ${filter}`,
			async () => await runOne('savedFilter', 'delete', { list: listId, filter }),
		);

		const listed = await run('savedFilter', 'list', { list: listId });
		expect(listed.map((f) => String(f.id))).toContain(filter);
		const options = await loadOptionsOf('getSavedFilters', { list: listId });
		expect(options.map((o) => o.value)).toContain(filter);

		expect(await runOne('savedFilter', 'delete', { list: listId, filter })).toEqual({
			success: true,
		});
		const after = await run('savedFilter', 'list', { list: listId });
		expect(after.map((f) => String(f.id))).not.toContain(filter);
	});
});
