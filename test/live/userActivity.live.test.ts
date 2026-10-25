import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	createTestSpace,
	liveDescribe,
	live,
	loadOptionsOf,
	run,
	runError,
	runOne,
	runId,
} from './harness';

liveDescribe('user — live', () => {
	const cleanup = cleanupStack();
	afterAll(async () => await cleanup.run());

	it('getCurrent describes the test user', async () => {
		const me = await runOne('user', 'getCurrent');
		expect(JSON.stringify(me)).toContain(live.userEmail);
	});

	// BACKEND GAP (PM ApiKeyScope, origin/master 946745b2): POST /v1/users/current needs
	// `users:write`, which ApiKeyScope does not define, so no API key can rename its user.
	it('updateCurrent is refused with a 403 that names the missing scope', async () => {
		const error = await runError('user', 'updateCurrent', { fullName: `n8n Live ${runId}` });
		expect(error.httpCode).toBe('403');
		expect(error.message).toContain('users:write');
	});

	it.fails('updateCurrent renames the test user (fails in production, see above)', async () => {
		const before = await runOne('user', 'getCurrent');
		const original = String(before.fullName ?? 'n8n Live Test');
		await runOne('user', 'updateCurrent', { fullName: `n8n Live ${runId}` });
		try {
			expect((await runOne('user', 'getCurrent')).fullName).toBe(`n8n Live ${runId}`);
		} finally {
			await runOne('user', 'updateCurrent', { fullName: original });
		}
	});

	it('getNotificationSettings has the app, email and browser channels with the setting groups', async () => {
		const settings = await runOne('user', 'getNotificationSettings');
		expect(JSON.stringify(settings)).toContain('taskCommentsSettings');
		expect(JSON.stringify(settings)).toContain('appChannel');
		expect(JSON.stringify(settings)).toContain('emailChannel');
	});

	it('updateNotificationChannel flips one setting and keeps the others (then restores it)', async () => {
		const read = async () =>
			((await runOne('user', 'getNotificationSettings')) as Record<string, unknown>) ?? {};
		// GET .../notifications/all groups the channels per product: { pm: { emailChannel } }.
		const find = (all: Record<string, unknown>) =>
			((all.pm as Record<string, unknown>)?.emailChannel ?? {}) as Record<string, unknown>;
		const before = find(await read());
		const comments = (before.taskCommentsSettings ?? {}) as Record<string, boolean>;
		const activity = (before.taskActivitySettings ?? {}) as Record<string, boolean>;
		const original = comments.reactions !== false;
		cleanup.add(
			'email notification setting',
			async () =>
				await runOne('user', 'updateNotificationChannel', {
					channel: 'email',
					settings: { reactions: original },
				}),
		);

		await runOne('user', 'updateNotificationChannel', {
			channel: 'email',
			settings: { reactions: !original },
		});
		const after = find(await read());
		expect((after.taskCommentsSettings as Record<string, boolean>).reactions).toBe(!original);
		expect(after.taskActivitySettings).toEqual(activity);

		await runOne('user', 'updateNotificationChannel', {
			channel: 'email',
			settings: { reactions: original },
		});
	});

	// The test user has no avatar and the node cannot upload one, so only the 404 is checked.
	it('getAvatarUrl for a member without an avatar answers 404', async () => {
		const error = await runError('user', 'getAvatarUrl', { user: live.userId });
		expect(error.httpCode).toBe('404');
		expect(error.message).toContain('avatar');
	});
});

liveDescribe('notification, activity log — live', () => {
	const cleanup = cleanupStack();
	let space: { identifier: string; name: string };
	let taskKey = '';

	beforeAll(async () => {
		space = await createTestSpace(cleanup, 'activity');
		const listName = `Activity ${runId}`;
		await runOne('list', 'create', { space: space.name, name: listName });
		const task = await runOne('task', 'create', { title: `Activity task ${runId}`, list: listName });
		taskKey = String(task.key);
		cleanup.add(`task ${taskKey}`, async () => await runOne('task', 'delete', { task: taskKey }));
		await runOne('task', 'update', { task: taskKey, updateFields: { title: `Activity ${runId} 2` } });
	});
	afterAll(async () => await cleanup.run());

	it('notification list, countUnread, picker and markAllRead answer', async () => {
		const notifications = await run('notification', 'list', { returnAll: true });
		expect(Array.isArray(notifications)).toBe(true);
		const count = await runOne('notification', 'countUnread');
		expect(count).toEqual(expect.any(Object));
		expect(Array.isArray(await loadOptionsOf('getNotifications'))).toBe(true);
		expect(await runOne('notification', 'markAllRead')).toEqual({ success: true });
	});

	it('activity log of the task, the space and the workspace include the task', async () => {
		const ofTask = await run('activityLog', 'list', { scope: 'task', task: taskKey, returnAll: true });
		expect(ofTask.length).toBeGreaterThan(0);
		const ofSpace = await run('activityLog', 'list', {
			scope: 'space',
			space: space.identifier,
			limit: 20,
		});
		expect(ofSpace.length).toBeGreaterThan(0);
		const ofWorkspace = await run('activityLog', 'list', { scope: 'workspace', limit: 5 });
		expect(ofWorkspace.length).toBeGreaterThan(0);
		expect(ofWorkspace.length).toBeLessThanOrEqual(5);
		const mine = await run('activityLog', 'list', { scope: 'user', limit: 5 });
		expect(mine.length).toBeGreaterThan(0);
	});
});
