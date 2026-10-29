import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { collection, oneItem } from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import { resolveHubWorkspace } from '../../../shared/workspaces';
import type {
	OperationContext,
	OperationDef,
	PaginationStyle,
	ParamReader,
	ResourceDef,
} from '../../../shared/types';

/*
 * Hub workspace settings, members and integrations. Contracts:
 * https://dutify.ai/api/v1/api-catalog/{Workspaces, Workspace%20Settings, Integrations,
 * User%20Resource}.
 *
 * - Hub's /v1/workspaces/{workspaceId} paths take the workspace UUID. The node's workspace
 *   selector holds the suite identifier, so each operation first finds the UUID in
 *   GET /api/v1/workspaces (which, for a key, lists only the selected workspace).
 * - Scopes: workspaces:read, members:read, workspace-settings:read/write, integrations:read,
 *   user-settings:read/write.
 * - The custom prompt and the preferred integration are bare @RequestBody values: the prompt is
 *   stored verbatim from a text body (an empty or blank body clears it, and GET then answers 204),
 *   the integration is a JSON string.
 */

/** The selected workspace's Hub UUID. */
async function workspaceUuid(ctx: OperationContext, p: ParamReader): Promise<string> {
	return (await resolveHubWorkspace(async (spec) => await ctx.request(spec), p.workspace))
		.id as string;
}

const settingsPath = (uuid: string, setting: string) =>
	`${encodePath`/api/v1/workspaces/${uuid}`}/settings/${setting}`;

const DEFAULT_WORKSPACE = { method: 'GET' as const, path: '/api/user/settings/default-workspace' };

/** Members page zero-based; a request without page and size gets every member at once. */
const MEMBER_PAGING: PaginationStyle = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	itemsPath: 'members',
	maxPageSize: 100,
};

/**
 * A plain-text setting as text: Hub answers 204 or an empty body when it is unset, and the HTTP
 * client may have parsed a prompt that happens to be JSON.
 */
function textOf(response: unknown): string | null {
	if (response === undefined || response === null || response === '') {
		return null;
	}

	return typeof response === 'string' ? response : JSON.stringify(response);
}

const promptField: INodeProperties = {
	displayName: 'Custom Prompt',
	name: 'customPrompt',
	type: 'string',
	typeOptions: { rows: 4 },
	default: '',
	required: true,
	description:
		"Instructions for the AI, added to every participant's analysis of this workspace's recordings (summary, key points, action items, enhanced notes, tasks). It replaces the current prompt and is stored exactly as typed.",
};

const workspaceOperations: OperationDef[] = [
	{
		operation: 'get',
		name: 'Get',
		action: 'Get the Hub workspace',
		description: 'Get the selected workspace as Hub knows it: its UUID, name, owner and Hub access',
		fields: [],
		run: async (ctx, p) =>
			oneItem(await resolveHubWorkspace(async (spec) => await ctx.request(spec), p.workspace)),
	},
	{
		operation: 'listMembers',
		name: 'Get Members',
		action: 'Get the members of the Hub workspace',
		description: 'List the members of the workspace with their user ID, name, email and role',
		list: true,
		fields: [
			collection('Additional Fields', 'additionalFields', [
				{
					displayName: 'Search',
					name: 'search',
					type: 'string',
					default: '',
					description: 'Only members whose name or email contains this text',
				},
			]),
		],
		run: async (ctx, p) => {
			const { search } = p.get<IDataObject>('additionalFields', {});
			const spec = {
				method: 'GET' as const,
				path: `${encodePath`/api/v1/workspaces/${await workspaceUuid(ctx, p)}`}/members`,
				...(search ? { qs: { search } } : {}),
				paginate: MEMBER_PAGING,
			};
			const limit = p.get<boolean>('returnAll', false) ? undefined : p.get<number>('limit', 50);

			return (await ctx.requestAll(spec, limit)).map((json): INodeExecutionData => ({ json }));
		},
	},
	{
		operation: 'getCustomPrompt',
		name: 'Get Custom Prompt',
		action: 'Get the custom prompt of the workspace',
		description: "Get the workspace's custom AI prompt; customPrompt is null when none is set",
		fields: [],
		run: async (ctx, p) => {
			const response = await ctx.request({
				method: 'GET',
				path: settingsPath(await workspaceUuid(ctx, p), 'custom-prompt'),
			});

			return [{ json: { customPrompt: textOf(response) } }];
		},
	},
	{
		operation: 'setCustomPrompt',
		name: 'Set Custom Prompt',
		action: 'Set the custom prompt of the workspace',
		description:
			'Replace the custom AI prompt. It applies to recordings processed from now on, and to a recording whose summary is regenerated; there is no history, so read the current prompt first if you need it',
		fields: [promptField],
		run: async (ctx, p) => {
			const prompt = p.get<string>('customPrompt', '');
			if (prompt.trim() === '') {
				throw new ApplicationError(
					'Custom Prompt is empty. To remove the prompt, use Clear Custom Prompt.',
				);
			}
			await ctx.request({
				method: 'PUT',
				path: settingsPath(await workspaceUuid(ctx, p), 'custom-prompt'),
				body: prompt,
				contentType: 'text/plain',
			});

			return [{ json: { customPrompt: prompt } }];
		},
	},
	{
		operation: 'clearCustomPrompt',
		name: 'Clear Custom Prompt',
		action: 'Clear the custom prompt of the workspace',
		description: 'Remove the custom AI prompt of the workspace',
		fields: [],
		run: async (ctx, p) => {
			// An empty body clears it; Get Custom Prompt then answers 204, as for one never set.
			await ctx.request({
				method: 'PUT',
				path: settingsPath(await workspaceUuid(ctx, p), 'custom-prompt'),
				body: '',
				contentType: 'text/plain',
			});

			return [{ json: { customPrompt: null } }];
		},
	},
	{
		operation: 'getDefault',
		name: 'Get Default Workspace',
		action: 'Get your default Hub workspace',
		description:
			'Get your default workspace: the one your new recordings are filed in. workspaceId is null only when you belong to no workspace',
		fields: [],
		build: () => ({ ...DEFAULT_WORKSPACE }),
	},
	{
		operation: 'setDefault',
		name: 'Set Default Workspace',
		action: 'Set your default Hub workspace',
		description:
			"Choose the workspace your new recordings are filed in, or reset it to Hub's automatic choice. An API key can only choose its own workspace",
		fields: [
			{
				displayName: 'Default Workspace',
				name: 'defaultWorkspace',
				type: 'options',
				options: [
					{
						name: 'Selected Workspace',
						value: 'selected',
						description: 'Make the workspace selected above your default',
					},
					{
						// The value stays 'none' so saved workflows keep working.
						name: 'Reset to Automatic',
						value: 'none',
						description:
							'Let Hub choose: the workspace you own, else the first workspace you belong to. You always keep a default.',
					},
				],
				default: 'selected',
				description: 'What to set as your default workspace',
			},
		],
		run: async (ctx, p) => {
			if (p.get<string>('defaultWorkspace', 'selected') === 'none') {
				// Hub resets the choice, then makes its automatic choice on the next read.
				await ctx.request({ ...DEFAULT_WORKSPACE, method: 'PUT', body: { workspaceId: null } });

				const chosen = (await ctx.request(DEFAULT_WORKSPACE)) as IDataObject | null;

				return [{ json: { workspaceId: chosen?.workspaceId ?? null } }];
			}
			const workspaceId = await workspaceUuid(ctx, p);
			await ctx.request({ ...DEFAULT_WORKSPACE, method: 'PUT', body: { workspaceId } });

			return [{ json: { workspaceId } }];
		},
	},
];

/** The Hub side of a workspace: its record, members, AI prompt and your default workspace. */
export const hubWorkspace: ResourceDef = {
	value: 'hubWorkspace',
	name: 'Hub Workspace',
	workspaceScoped: true,
	operations: workspaceOperations,
};

/* ---------- integrations ---------- */

/**
 * The task systems Hub accepts (catalog: enum ["PM"]). Any other value is refused with
 * 400 UNSUPPORTED_TASK_SYSTEM, whose message reaches the user.
 */
const TASK_SYSTEMS = [{ name: 'Dutify Cloud', value: 'PM' }];

const integrationOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get the connected integrations',
		description:
			'List the integrations connected to the workspace, each with its system and status (CONNECTED, REVOKED, ERROR or ACCESS_REQUIRED)',
		fields: [],
		run: async (ctx, p) => {
			const rows = await ctx.request({
				method: 'GET',
				path: `${encodePath`/api/v1/workspaces/${await workspaceUuid(ctx, p)}`}/integrations`,
			});

			return (Array.isArray(rows) ? (rows as IDataObject[]) : []).map((json) => ({ json }));
		},
	},
	{
		operation: 'getPreferred',
		name: 'Get Preferred',
		action: 'Get the preferred integration',
		description:
			"Get the workspace's task system: always Dutify Cloud, since that is where Hub creates new action items",
		fields: [],
		run: async (ctx, p) => {
			const response = await ctx.request({
				method: 'GET',
				path: settingsPath(await workspaceUuid(ctx, p), 'preferred-integration'),
			});

			return [{ json: { preferredIntegration: textOf(response) } }];
		},
	},
	{
		operation: 'setPreferred',
		name: 'Set Preferred',
		action: 'Set the preferred integration',
		description: "Set the workspace's task system. Dutify Cloud is the only one Hub supports",
		fields: [
			{
				displayName: 'Preferred Integration',
				name: 'preferredIntegration',
				type: 'options',
				options: TASK_SYSTEMS,
				default: 'PM',
				required: true,
				description: 'The task system Hub creates new action items in',
			},
		],
		run: async (ctx, p) => {
			const value = p.get<string>('preferredIntegration');
			await ctx.request({
				method: 'PUT',
				path: settingsPath(await workspaceUuid(ctx, p), 'preferred-integration'),
				// The bare enum value as a JSON string ("PM"), not an object.
				body: JSON.stringify(value),
				contentType: 'application/json',
			});

			return [{ json: { preferredIntegration: value } }];
		},
	},
];

/** The vendor systems connected to a Hub workspace, and the preferred one. */
export const hubIntegration: ResourceDef = {
	value: 'hubIntegration',
	name: 'Hub Integration',
	workspaceScoped: true,
	operations: integrationOperations,
};
