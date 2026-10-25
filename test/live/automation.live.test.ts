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

liveDescribe('automation — live', () => {
	const cleanup = cleanupStack();
	let space: { identifier: string; name: string };
	let listId = '';
	const atList = () => ({ scope: 'list', list: listId });

	beforeAll(async () => {
		space = await createTestSpace(cleanup, 'automation');
		listId = String(
			(await runOne('list', 'create', { space: space.name, name: `Automations ${runId}` }))
				.identifier,
		);
	});
	afterAll(async () => await cleanup.run());

	it('create (inline object parameters), list, picker, get, update, audit, delete', async () => {
		const created = await runOne('automation', 'create', {
			...atList(),
			name: `Auto ${runId}`,
			// Values from the PM enums: trigger "on task creation", action "set priority".
			triggers: '[{"triggerType":"on task creation","parameters":{}}]',
			actions: '[{"actionType":"set priority","parameters":{"priority":"High"}}]',
			additionalFields: { description: 'live test', active: false },
		});
		expect(created).toMatchObject({
			name: `Auto ${runId}`,
			description: 'live test',
			active: false,
			listIdentifier: listId,
		});
		const automation = String(created.identifier);
		cleanup.add(
			`automation ${automation}`,
			async () => await runOne('automation', 'delete', { ...atList(), automation }),
		);
		const actions = created.actions as Array<{ actionType: string; parameters: string }>;
		expect(actions[0].actionType).toBe('set priority');
		expect(JSON.parse(actions[0].parameters)).toEqual({ priority: 'High' });

		const listed = await run('automation', 'list', { ...atList(), returnAll: true });
		expect(listed.map((a) => a.identifier)).toContain(automation);
		const fromSpace = await run('automation', 'list', {
			scope: 'space',
			space: space.identifier,
			includeDescendants: true,
			returnAll: true,
		});
		expect(fromSpace.map((a) => a.identifier)).toContain(automation);
		const options = await loadOptionsOf('getAutomations', atList());
		expect(options.map((o) => o.value)).toContain(automation);

		expect(await runOne('automation', 'get', { ...atList(), automation })).toMatchObject({
			identifier: automation,
		});
		const updated = await runOne('automation', 'update', {
			...atList(),
			automation,
			updateFields: { name: `Auto renamed ${runId}` },
		});
		expect(updated).toMatchObject({ name: `Auto renamed ${runId}`, active: false });

		const audit = await run('automation', 'getAudit', { ...atList(), automation, returnAll: true });
		expect(Array.isArray(audit)).toBe(true);

		expect(await runOne('automation', 'delete', { ...atList(), automation })).toEqual({
			success: true,
		});
		const gone = await runError('automation', 'get', { ...atList(), automation });
		expect(gone.httpCode).toBe('404');
	});
});
