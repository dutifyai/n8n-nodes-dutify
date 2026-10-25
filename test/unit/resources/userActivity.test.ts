import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { activityLog, notification, user } from '../../../nodes/Dutify/resources/userActivity';
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

const build = (resource: ResourceDef, name: string, params: Record<string, unknown>) =>
	opOf(resource, name).build!(reader(params));

const run = (
	resource: ResourceDef,
	name: string,
	ctx: OperationContext,
	params: Record<string, unknown>,
) => opOf(resource, name).run!(ctx, reader(params));

describe('registration', () => {
	it('registers user, notification and activityLog', () => {
		for (const r of [user, notification, activityLog]) {
			expect(resources).toContain(r);
		}
		expect(user.value).toBe('user');
		expect(user.operations.map((o) => o.operation)).toEqual([
			'getCurrent',
			'updateCurrent',
			'getNotificationSettings',
			'updateNotificationChannel',
			'getAvatarUrl',
		]);
		expect(notification.value).toBe('notification');
		expect(notification.operations.map((o) => o.operation)).toEqual([
			'list',
			'countUnread',
			'markRead',
			'markAllRead',
		]);
		expect(activityLog.value).toBe('activityLog');
		expect(activityLog.operations.map((o) => o.operation)).toEqual(['list']);
	});

	it('user is account-level; notification and activity log are workspace-scoped', () => {
		expect(user.workspaceScoped).toBe(false);
		expect(notification.workspaceScoped).toBe(true);
		expect(activityLog.workspaceScoped).toBe(true);
	});
});

describe('user', () => {
	it('getCurrent: GET users/current', () => {
		expect(build(user, 'getCurrent', {})).toEqual({
			method: 'GET',
			path: '/mp/api/v1/users/current',
		});
	});

	it('updateCurrent: POST users/current with fullName', () => {
		expect(build(user, 'updateCurrent', { fullName: 'Ada Lovelace' })).toEqual({
			method: 'POST',
			path: '/mp/api/v1/users/current',
			body: { fullName: 'Ada Lovelace' },
		});
	});

	it('getNotificationSettings: GET users/settings/notifications/all (every module: PM, Codexum, Roadmarq)', () => {
		expect(build(user, 'getNotificationSettings', {})).toEqual({
			method: 'GET',
			path: '/mp/api/v1/users/settings/notifications/all',
		});
	});

	describe('updateNotificationChannel', () => {
		const current = {
			appChannel: {
				taskCommentsSettings: { commentsMentionedIn: true, newComments: true, reactions: false },
				taskActivitySettings: { newTasksCreated: false, statusChanges: true },
				sharingSettings: { taskSharedWithMe: true },
			},
			emailChannel: { taskCommentsSettings: { newComments: false } },
			browserChannel: {},
		};

		it('reads the settings, overlays the changes on the chosen channel, and PUTs the whole channel', async () => {
			const updated = { taskCommentsSettings: {} };
			const ctx = fakeContext([current, updated]);
			const out = await run(user, 'updateNotificationChannel', ctx, {
				channel: 'app',
				settings: { reactions: true, statusChanges: false, folderSharedWithMe: true },
			});
			expect(ctx.calls).toEqual([
				{ method: 'GET', path: '/mp/api/v1/users/settings/notifications' },
				{
					method: 'PUT',
					path: '/mp/api/v1/users/settings/notifications/app',
					body: {
						taskCommentsSettings: { commentsMentionedIn: true, newComments: true, reactions: true },
						taskActivitySettings: { newTasksCreated: false, statusChanges: false },
						sharingSettings: { taskSharedWithMe: true, folderSharedWithMe: true },
					},
				},
			]);
			expect(out).toEqual([{ json: updated }]);
		});

		it('works on the email and browser channels, starting from nothing', async () => {
			const ctx = fakeContext([current, {}, current, {}]);
			await run(user, 'updateNotificationChannel', ctx, {
				channel: 'email',
				settings: { dueDateReminder: true },
			});
			await run(user, 'updateNotificationChannel', ctx, {
				channel: 'browser',
				settings: { newComments: false },
			});
			expect(ctx.calls[1]).toEqual({
				method: 'PUT',
				path: '/mp/api/v1/users/settings/notifications/email',
				body: {
					taskCommentsSettings: { newComments: false },
					taskActivitySettings: { dueDateReminder: true },
					sharingSettings: {},
				},
			});
			expect(ctx.calls[3]).toMatchObject({
				path: '/mp/api/v1/users/settings/notifications/browser',
				body: { taskCommentsSettings: { newComments: false } },
			});
		});

		it('refuses an empty change before any request', async () => {
			const ctx = fakeContext([]);
			await expect(
				run(user, 'updateNotificationChannel', ctx, { channel: 'app', settings: {} }),
			).rejects.toThrow(/at least one/i);
			expect(ctx.calls).toEqual([]);
		});
	});

	it('getAvatarUrl: GET workspaces/{ws}/users/{uuid}/avatar/url, the URL returned as { url }', async () => {
		const ctx = fakeContext(['https://cdn.example/a.png?sig=1']);
		const out = await run(user, 'getAvatarUrl', ctx, { workspace: 'ws-1', user: 'u-1' });
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: '/mp/api/v1/workspaces/ws-1/users/u-1/avatar/url' },
		]);
		expect(out).toEqual([{ json: { url: 'https://cdn.example/a.png?sig=1' } }]);
	});

	it('getAvatarUrl: the workspace and the member are chosen from pickers', () => {
		expect(fieldOf(user, 'getAvatarUrl', 'workspace')?.type).toBe('resourceLocator');
		expect(loaderOf(user, 'getAvatarUrl', 'user')).toBe('getMemberIds');
	});
});

describe('notification', () => {
	const PAGING = {
		kind: 'page',
		pageParam: 'page',
		sizeParam: 'size',
		zeroBased: true,
		maxPageSize: 100,
	};

	it('list: GET notifications/workspace/{ws}, paged, unreadOnly only when asked', () => {
		expect(build(notification, 'list', { additionalFields: {} })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/notifications/workspace/ws-1',
			paginate: PAGING,
		});
		expect(build(notification, 'list', { additionalFields: { unreadOnly: true } })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/notifications/workspace/ws-1',
			qs: { unreadOnly: true },
			paginate: PAGING,
		});
		expect(opOf(notification, 'list').list).toBe(true);
	});

	it('countUnread: GET .../unread-count, the number returned as { count }', async () => {
		const ctx = fakeContext([4]);
		const out = await run(notification, 'countUnread', ctx, {});
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: '/mp/api/v1/notifications/workspace/ws-1/unread-count' },
		]);
		expect(out).toEqual([{ json: { count: 4 } }]);
	});

	it('markRead: PUT notifications/{id}/read, reported as success', async () => {
		const ctx = fakeContext([{}]);
		const out = await run(notification, 'markRead', ctx, { notification: 'ntf_1' });
		expect(ctx.calls).toEqual([{ method: 'PUT', path: '/mp/api/v1/notifications/ntf_1/read' }]);
		expect(out).toEqual([{ json: { success: true } }]);
	});

	it('markAllRead: PUT notifications/workspace/{ws}/read-all', async () => {
		const ctx = fakeContext(['']);
		const out = await run(notification, 'markAllRead', ctx, {});
		expect(ctx.calls).toEqual([
			{ method: 'PUT', path: '/mp/api/v1/notifications/workspace/ws-1/read-all' },
		]);
		expect(out).toEqual([{ json: { success: true } }]);
	});

	it('the notification is chosen from a picker', () => {
		expect(loaderOf(notification, 'markRead', 'notification')).toBe('getNotifications');
	});
});

describe('activityLog', () => {
	const page = (items: unknown[], nextCursor?: string) => ({
		items,
		nextCursor,
		hasMore: Boolean(nextCursor),
		size: items.length,
	});

	it('workspace scope, everything below: GET activity-log/workspace/{ws}/full, cursor/size', async () => {
		const ctx = fakeContext([page([{ id: 1 }, { id: 2 }], 'c2'), page([{ id: 3 }])]);
		const out = await run(activityLog, 'list', ctx, {
			scope: 'workspace',
			include: 'full',
			returnAll: true,
		});
		expect(ctx.calls).toEqual([
			{
				method: 'GET',
				path: '/mp/api/v1/activity-log/workspace/ws-1/full',
				qs: { size: 100 },
				paginate: expect.objectContaining({ kind: 'cursor' }),
			},
			{
				method: 'GET',
				path: '/mp/api/v1/activity-log/workspace/ws-1/full',
				qs: { size: 100, cursor: 'c2' },
				paginate: expect.objectContaining({ kind: 'cursor' }),
			},
		]);
		expect(out.map((i) => i.json)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	it('the cursor paging reads items/nextCursor and caps pages at 100', async () => {
		const ctx = fakeContext([page([])]);
		await run(activityLog, 'list', ctx, {
			scope: 'workspace',
			include: 'own',
			returnAll: false,
			limit: 5,
		});
		expect(ctx.calls[0].paginate).toEqual({
			kind: 'cursor',
			cursorParam: 'cursor',
			limitParam: 'size',
			itemsPath: 'items',
			nextCursorPath: 'nextCursor',
			maxPageSize: 100,
		});
		expect(ctx.calls[0].qs).toEqual({ size: 5 });
		expect(ctx.calls[0].path).toBe('/mp/api/v1/activity-log/workspace/ws-1/own');
	});

	it.each([
		['space', { space: 'sp_1' }, '/mp/api/v1/activity-log/space/sp_1/full'],
		['folder', { folder: 'fld_1' }, '/mp/api/v1/activity-log/folder/fld_1/full'],
		['list', { list: 'lst_1' }, '/mp/api/v1/activity-log/list/lst_1/full'],
	])('%s scope picks its own catalog path', async (scope, target, path) => {
		const ctx = fakeContext([page([])]);
		await run(activityLog, 'list', ctx, { scope, ...target, include: 'full', returnAll: true });
		expect(ctx.calls[0].path).toBe(path);
	});

	it('task scope resolves a key to its tsk_ ID first', async () => {
		const ctx = fakeContext([{ identifier: 'tsk_9' }, page([])]);
		await run(activityLog, 'list', ctx, {
			scope: 'task',
			task: 'PROJ-42',
			include: 'own',
			returnAll: true,
		});
		expect(ctx.calls.map((c) => c.path)).toEqual([
			'/mp/api/v1/tasks/lite/PROJ-42',
			'/mp/api/v1/activity-log/task/tsk_9/own',
		]);
	});

	it('user scope: GET activity-log/user/own (there is no "full" variant)', async () => {
		const ctx = fakeContext([page([])]);
		await run(activityLog, 'list', ctx, { scope: 'user', include: 'full', returnAll: true });
		expect(ctx.calls[0].path).toBe('/mp/api/v1/activity-log/user/own');
	});

	it('targets are chosen from pickers', () => {
		expect(loaderOf(activityLog, 'list', 'space')).toBe('getSpaceIds');
		expect(loaderOf(activityLog, 'list', 'folder')).toBe('getFolderIds');
		expect(loaderOf(activityLog, 'list', 'list')).toBe('getListIds');
		expect(opOf(activityLog, 'list').list).toBe(true);
	});
});
