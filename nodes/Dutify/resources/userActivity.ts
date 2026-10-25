import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { collection, idPicker, oneItem } from '../../../shared/fieldHelpers';
import { resolveTaskId } from '../../../shared/taskRefs';
import { encodePath } from '../../../shared/transport';
import type {
	OperationContext,
	OperationDef,
	PaginationStyle,
	ParamReader,
	ResourceDef,
} from '../../../shared/types';

const SUCCESS: INodeExecutionData[] = [{ json: { success: true } }];

/** Notifications page zero-based and the backend rejects a size above 100. */
const NOTIFICATION_PAGING: PaginationStyle = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	maxPageSize: 100,
};

/* ---------- user ---------- */

const NOTIFICATIONS_PATH = '/mp/api/v1/users/settings/notifications';

/** Notification settings, grouped the way the API groups them. */
const NOTIFICATION_GROUPS: Array<{
	group: string;
	settings: Array<[name: string, label: string, description: string]>;
}> = [
	{
		group: 'taskCommentsSettings',
		settings: [
			['commentsMentionedIn', 'Comments Mentioned In', 'you are mentioned in a comment'],
			['newComments', 'New Comments', 'a comment is posted on a task you watch'],
			['reactions', 'Reactions', 'someone reacts to your comment'],
		],
	},
	{
		group: 'taskActivitySettings',
		settings: [
			['newTasksCreated', 'New Tasks Created', 'a task is created'],
			['assigneeChanges', 'Assignee Changes', 'the assignees of a task change'],
			['statusChanges', 'Status Changes', 'the status of a task changes'],
			['tasksAssignedToMe', 'Tasks Assigned to Me', 'a task is assigned to you'],
			['locationChanges', 'Location Changes', 'a task moves to another list or space'],
			['descriptionUpdated', 'Description Updated', 'the description of a task changes'],
			[
				'descriptionsMentionedIn',
				'Descriptions Mentioned In',
				'you are mentioned in a description',
			],
			[
				'attachmentChanges',
				'Attachment Changes',
				'attachments are added to or removed from a task',
			],
			['customFieldChanges', 'Custom Field Changes', 'a custom field value changes'],
			['taskNameChanges', 'Task Name Changes', 'the name of a task changes'],
			['dueDateReminder', 'Due Date Reminder', 'a due date is approaching (email reminders)'],
		],
	},
	{
		group: 'sharingSettings',
		settings: [
			['taskSharedWithMe', 'Task Shared With Me', 'a task is shared with you'],
			['listSharedWithMe', 'List Shared With Me', 'a list is shared with you'],
			['folderSharedWithMe', 'Folder Shared With Me', 'a folder is shared with you'],
			['spaceSharedWithMe', 'Space Shared With Me', 'a space is shared with you'],
		],
	},
];

const notificationSettingFields: INodeProperties[] = NOTIFICATION_GROUPS.flatMap((g) =>
	g.settings.map(
		([name, displayName, what]): INodeProperties => ({
			displayName,
			name,
			type: 'boolean',
			default: true,
			description: `Whether to notify when ${what}`,
		}),
	),
);

const userOperations: OperationDef[] = [
	{
		operation: 'getCurrent',
		name: 'Get Current',
		action: 'Get the current user',
		description: 'Fetch the profile of the user the API key belongs to',
		fields: [],
		build: () => ({ method: 'GET', path: '/mp/api/v1/users/current' }),
	},
	{
		operation: 'updateCurrent',
		name: 'Update Current',
		action: 'Update the current user',
		description: 'Change the display name of the current user',
		fields: [
			{
				displayName: 'Full Name',
				name: 'fullName',
				type: 'string',
				default: '',
				required: true,
				description: 'New display name (up to 100 characters)',
			},
		],
		build: (p) => ({
			method: 'POST',
			path: '/mp/api/v1/users/current',
			body: { fullName: p.get<string>('fullName') },
		}),
	},
	{
		operation: 'getNotificationSettings',
		name: 'Get Notification Settings',
		action: 'Get the notification settings',
		description:
			'Fetch which notifications the current user gets in the app, by email and in the browser, for Project Management, Codexum and Roadmarq',
		fields: [],
		build: () => ({ method: 'GET', path: `${NOTIFICATIONS_PATH}/all` }),
	},
	{
		operation: 'updateNotificationChannel',
		name: 'Update Notification Channel',
		action: 'Update the notifications of a channel',
		description: 'Turn individual notifications on or off for the app, email or browser channel',
		fields: [
			{
				displayName: 'Channel',
				name: 'channel',
				type: 'options',
				options: [
					{ name: 'App', value: 'app' },
					{ name: 'Browser', value: 'browser' },
					{ name: 'Email', value: 'email' },
				],
				default: 'app',
				description: 'Where the notifications are delivered',
			},
			collection('Settings', 'settings', notificationSettingFields),
		],
		run: async (ctx, p) => {
			const channel = p.get<string>('channel');
			const changes = p.get<IDataObject>('settings', {});
			if (!NOTIFICATION_GROUPS.some((g) => g.settings.some(([name]) => name in changes))) {
				throw new ApplicationError('Set at least one notification in Settings');
			}
			// The channel is replaced as a whole, so settings that are not changed are carried over.
			const all = ((await ctx.request({ method: 'GET', path: NOTIFICATIONS_PATH })) ??
				{}) as IDataObject;
			const existing = (all[`${channel}Channel`] ?? {}) as IDataObject;
			const body: IDataObject = {};
			for (const { group, settings } of NOTIFICATION_GROUPS) {
				const merged: IDataObject = { ...((existing[group] ?? {}) as IDataObject) };
				for (const [name] of settings) {
					if (typeof changes[name] === 'boolean') {
						merged[name] = changes[name];
					}
				}
				body[group] = merged;
			}

			return oneItem(
				await ctx.request({
					method: 'PUT',
					path: `${NOTIFICATIONS_PATH}/${encodeURIComponent(channel)}`,
					body,
				}),
			);
		},
	},
	{
		operation: 'getAvatarUrl',
		name: 'Get Avatar URL',
		action: 'Get the avatar URL of a workspace member',
		description: 'Get a temporary link to the avatar image of a workspace member',
		fields: [idPicker('Member Name or ID', 'user', 'getMemberIds', undefined)],
		run: async (ctx, p) => {
			const url = await ctx.request({
				method: 'GET',
				path: encodePath`/mp/api/v1/workspaces/${p.workspace}/users/${p.get<string>('user')}/avatar/url`,
			});

			return [{ json: { url: url as string } }];
		},
	},
];

/**
 * The current user, their settings and workspace avatars (PM "Users"). The settings are
 * account-level, but PM refuses a personal key on them without X-Dutify-Workspace, so the
 * resource carries the workspace selector like the others.
 */
export const user: ResourceDef = {
	value: 'user',
	name: 'User',
	workspaceScoped: true,
	operations: userOperations,
};

/* ---------- notifications ---------- */

const workspaceNotificationsPath = (p: ParamReader) =>
	encodePath`/mp/api/v1/notifications/workspace/${p.workspace}`;

const notificationOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many notifications',
		description: 'List the notifications of the current user in the workspace',
		list: true,
		fields: [
			collection('Additional Fields', 'additionalFields', [
				{
					displayName: 'Unread Only',
					name: 'unreadOnly',
					type: 'boolean',
					default: true,
					description: 'Whether to return only notifications that are not read yet',
				},
			]),
		],
		build: (p) => {
			const unreadOnly = p.get<IDataObject>('additionalFields', {}).unreadOnly;

			return {
				method: 'GET',
				path: workspaceNotificationsPath(p),
				...(typeof unreadOnly === 'boolean' ? { qs: { unreadOnly } } : {}),
				paginate: NOTIFICATION_PAGING,
			};
		},
	},
	{
		operation: 'countUnread',
		name: 'Count Unread',
		action: 'Count unread notifications',
		description: 'Count the notifications of the current user that are not read yet',
		fields: [],
		run: async (ctx, p) => {
			const count = await ctx.request({
				method: 'GET',
				path: `${workspaceNotificationsPath(p)}/unread-count`,
			});

			return [{ json: { count: count as number } }];
		},
	},
	{
		operation: 'markRead',
		name: 'Mark Read',
		action: 'Mark a notification as read',
		description: 'Mark one of your notifications as read',
		fields: [idPicker('Notification Name or ID', 'notification', 'getNotifications', undefined)],
		run: async (ctx, p) => {
			await ctx.request({
				method: 'PUT',
				path: encodePath`/mp/api/v1/notifications/${p.get<string>('notification')}/read`,
			});

			return SUCCESS;
		},
	},
	{
		operation: 'markAllRead',
		name: 'Mark All Read',
		action: 'Mark all notifications as read',
		description: 'Mark every unread notification of the workspace as read',
		fields: [],
		run: async (ctx, p) => {
			await ctx.request({ method: 'PUT', path: `${workspaceNotificationsPath(p)}/read-all` });

			return SUCCESS;
		},
	},
];

/** Notifications of the current user (PM "Notifications"). */
export const notification: ResourceDef = {
	value: 'notification',
	name: 'Notification',
	workspaceScoped: true,
	operations: notificationOperations,
};

/* ---------- activity log ---------- */

/** The activity log pages by cursor; `items` holds the page and the backend caps the size at 100. */
const ACTIVITY_PAGING: PaginationStyle = {
	kind: 'cursor',
	cursorParam: 'cursor',
	limitParam: 'size',
	itemsPath: 'items',
	nextCursorPath: 'nextCursor',
	maxPageSize: 100,
};

const NOT_USER = { scope: ['workspace', 'space', 'folder', 'list', 'task'] };

const taskScopeField: INodeProperties = {
	displayName: 'Task',
	name: 'task',
	type: 'string',
	default: '',
	required: true,
	displayOptions: { show: { scope: ['task'] } },
	description: "Task key such as PROJ-42, or the task ID (the task's Identifier field)",
};

async function activityPath(ctx: OperationContext, p: ParamReader): Promise<string> {
	const scope = p.get<string>('scope');
	if (scope === 'user') {
		return '/mp/api/v1/activity-log/user/own';
	}
	const target =
		scope === 'workspace'
			? p.workspace
			: scope === 'task'
				? await resolveTaskId(
						async (spec) => await ctx.request(spec),
						p.get<string>('task'),
						p.workspace,
					)
				: p.get<string>(scope);
	const include = p.get<string>('include', 'full');

	return `/mp/api/v1/activity-log/${scope}/${encodeURIComponent(target)}/${include}`;
}

const activityOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many activity log entries',
		description: 'Read the activity log of the workspace, a space, a folder, a list or a task',
		list: true,
		fields: [
			{
				displayName: 'Scope',
				name: 'scope',
				type: 'options',
				options: [
					{ name: 'Folder', value: 'folder' },
					{ name: 'List', value: 'list' },
					{ name: 'My Activity (All Workspaces)', value: 'user' },
					{ name: 'Space', value: 'space' },
					{ name: 'Task', value: 'task' },
					{ name: 'Workspace', value: 'workspace' },
				],
				default: 'workspace',
				description: 'Whose activity to read',
			},
			idPicker('Space Name or ID', 'space', 'getSpaceIds', { field: 'scope', value: 'space' }),
			idPicker('Folder Name or ID', 'folder', 'getFolderIds', { field: 'scope', value: 'folder' }),
			idPicker('List Name or ID', 'list', 'getListIds', { field: 'scope', value: 'list' }),
			taskScopeField,
			{
				displayName: 'Include',
				name: 'include',
				type: 'options',
				options: [
					{
						name: 'Everything Below',
						value: 'full',
						description: 'The item and everything inside it',
					},
					{
						name: 'This Item Only',
						value: 'own',
						description: 'Only entries about the item itself',
					},
				],
				default: 'full',
				displayOptions: { show: NOT_USER },
				description: 'Whether to include the activity of everything inside the item',
			},
		],
		run: async (ctx, p) => {
			const spec = {
				method: 'GET' as const,
				path: await activityPath(ctx, p),
				paginate: ACTIVITY_PAGING,
			};
			const limit = p.get<boolean>('returnAll', false) ? undefined : p.get<number>('limit', 50);

			return (await ctx.requestAll(spec, limit)).map((json): INodeExecutionData => ({ json }));
		},
	},
];

/** Activity log queries (PM "Activity Log"). */
export const activityLog: ResourceDef = {
	value: 'activityLog',
	name: 'Activity Log',
	workspaceScoped: true,
	operations: activityOperations,
};
