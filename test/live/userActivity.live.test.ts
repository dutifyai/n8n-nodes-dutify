import { sleep } from 'n8n-workflow';
import type { IDataObject } from 'n8n-workflow';
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

	// `users:write` exists since dutify-pm #234 (prod-0.1.793); for API keys it covers only
	// POST /v1/users/current.
	it('updateCurrent renames the test user (then restores the name)', async () => {
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

	// The catalog describes the per-module endpoint's Codexum and Roadmarq side as "forwards to
	// their backend (stubbed for now)": it answers with the settings it was sent, so the answer is
	// what is checked. The value written is the one read first, so nothing changes either way.
	// PM answers with the whole channel after the update: every key of the module, the one sent
	// at its new value.
	it.each([
		[
			'codexum',
			'codexumSettings',
			'pageUpdated',
			['mentionedInPage', 'pageComments', 'pageSharedWithMe', 'pageUpdated'],
		],
		[
			'roadmarq',
			'roadmarqSettings',
			'feedbackVotes',
			['feedbackComments', 'feedbackStatusChanged', 'feedbackVotes', 'newFeedback'],
		],
	])(
		'updateModuleNotificationChannel sends a %s setting and answers with the whole channel',
		async (module, field, key, keys) => {
			const all = (await runOne('user', 'getNotificationSettings')) as Record<string, unknown>;
			const app = ((all[module] as Record<string, unknown>)?.appChannel ?? {}) as Record<
				string,
				Record<string, boolean>
			>;
			const current = app.settings?.[key] !== false;
			const answer = await runOne('user', 'updateModuleNotificationChannel', {
				module,
				channel: 'app',
				[field]: { [key]: current },
			});
			const settings = (answer as { settings: Record<string, boolean> }).settings;
			expect(Object.keys(settings).sort()).toEqual(keys);
			expect(settings[key]).toBe(current);
			for (const value of Object.values(settings)) {
				expect(typeof value).toBe('boolean');
			}
		},
	);

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
		const task = await runOne('task', 'create', {
			title: `Activity task ${runId}`,
			list: listName,
		});
		taskKey = String(task.key);
		cleanup.add(`task ${taskKey}`, async () => await runOne('task', 'delete', { task: taskKey }));
		await runOne('task', 'update', {
			task: taskKey,
			updateFields: { title: `Activity ${runId} 2` },
		});
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

	// A reaction to your own comment notifies you ("reaction-to-your-comment"): the test makes one,
	// marks that notification read and checks it is read; an unknown notification is 404.
	it('notification markRead marks the notification of a reaction to the test user’s comment', async () => {
		const task = await runOne('task', 'get', { task: taskKey });
		const comment = await runOne('taskComment', 'create', {
			task: taskKey,
			text: `Notify me ${runId}`,
		});
		const commentId = String(comment.identifier);
		await runOne('taskComment', 'addReaction', {
			task: String(task.identifier),
			comment: commentId,
			reactionType: 'thumbs_up',
		});

		const ofComment = (rows: IDataObject[]) =>
			rows.find((n) => (n.data as IDataObject | undefined)?.commentIdentifier === commentId);
		let notification: IDataObject | undefined;
		for (let i = 0; i < 20 && !notification; i++) {
			notification = ofComment(
				await run('notification', 'list', {
					additionalFields: { unreadOnly: true },
					returnAll: true,
				}),
			);
			if (!notification) {
				await sleep(1500);
			}
		}
		expect(notification).toMatchObject({ type: 'reaction-to-your-comment', readStatus: false });
		const id = String(notification?.identifier);
		expect((await loadOptionsOf('getNotifications')).map((o) => String(o.value))).toContain(id);

		expect(await runOne('notification', 'markRead', { notification: id })).toEqual({
			success: true,
		});
		const unread = await run('notification', 'list', {
			additionalFields: { unreadOnly: true },
			returnAll: true,
		});
		expect(unread.map((n) => n.identifier)).not.toContain(id);
		const all = await run('notification', 'list', { returnAll: true });
		expect(all.find((n) => n.identifier === id)).toMatchObject({ readStatus: true });

		const unknown = await runError('notification', 'markRead', { notification: 'NoSuchNtf0' });
		expect(unknown.httpCode).toBe('404');
	}, 60_000);

	it('activity log of the task, the space and the workspace include the task', async () => {
		const ofTask = await run('activityLog', 'list', {
			scope: 'task',
			task: taskKey,
			returnAll: true,
		});
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
