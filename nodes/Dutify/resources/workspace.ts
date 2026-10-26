import type { IDataObject } from 'n8n-workflow';
import { ApplicationError } from 'n8n-workflow';
import { idPicker } from '../../../shared/fieldHelpers';
import type { ResourceDef } from '../../../shared/types';
import { fetchAccessibleWorkspaces } from '../../../shared/workspaces';
import { boardsSpec, contextSpec, wikiSpacesSpec } from '../loaders';

/**
 * Account: questions about the API key itself. Not workspace scoped, so no
 * X-Dutify-Workspace header is sent and no workspace selector is shown.
 */
export const account: ResourceDef = {
	value: 'account',
	name: 'Account',
	workspaceScoped: false,
	operations: [
		{
			operation: 'whoAmI',
			name: 'Who Am I',
			action: 'Get the calling API key',
			description: 'Return the type, scopes and bound workspace of the API key in use',
			fields: [],
			build: () => ({ method: 'GET', path: '/mp/api/v1/api-keys/current' }),
		},
		{
			operation: 'listWorkspaces',
			name: 'Get Many Workspaces',
			action: 'Get many workspaces',
			description:
				'List the workspaces the key can use. A workspace key returns only its bound workspace.',
			fields: [],
			run: async (ctx) => {
				const { workspaces, personal } = await fetchAccessibleWorkspaces((s) => ctx.request(s));

				return workspaces.map((w) => ({
					json: personal
						? { identifier: w.identifier, name: w.name }
						: { identifier: w.identifier, name: w.name, bound: true },
				}));
			},
		},
		{
			operation: 'findMyWorkspace',
			name: 'Find My Workspace',
			action: 'Find my workspace',
			description:
				"Show a workspace key's bound workspace and scopes, or a personal key's workspaces",
			fields: [],
			run: async (ctx) => {
				const { key, personal, workspaces } = await fetchAccessibleWorkspaces((s) =>
					ctx.request(s),
				);
				if (personal) {
					return [
						{ json: { keyType: 'PERSONAL', workspaces: workspaces as unknown as IDataObject[] } },
					];
				}

				return [
					{
						json: {
							identifier: key.workspaceIdentifier,
							name: key.workspaceName,
							scopes: key.scopes,
							keyIdentifier: key.keyIdentifier,
							keyName: key.keyName,
						} as IDataObject,
					},
				];
			},
		},
	],
};

const REFERENCE_PATHS: Array<{ value: string; name: string; path: string; description: string }> = [
	{
		value: 'access-levels',
		name: 'Access Levels',
		path: '/mp/api/v1/access-levels',
		description: 'Entity access levels used in user and team grants',
	},
	{
		value: 'activity-types',
		name: 'Activity Types',
		path: '/mp/api/v1/activity-types',
		description: 'Activity log event types',
	},
	{
		value: 'automation-action-types',
		name: 'Automation Action Types',
		path: '/mp/api/v1/automation/public/action-type',
		description: 'Actions an automation rule can perform',
	},
	{
		value: 'automation-condition-types',
		name: 'Automation Condition Types',
		path: '/mp/api/v1/automation/public/condition-type',
		description: 'Condition categories for automation rules',
	},
	{
		value: 'automation-field-operators',
		name: 'Automation Field Operators',
		path: '/mp/api/v1/automation/public/field-operator',
		description: 'Operators valid in automation condition predicates',
	},
	{
		value: 'custom-field-icon-options',
		name: 'Custom Field Icon Options',
		path: '/mp/api/v1/custom-field-icon-options',
		description: 'Icons and emoji names available to custom fields',
	},
	{
		value: 'custom-field-types',
		name: 'Custom Field Types',
		path: '/mp/api/v1/custom-field-types',
		description: 'Custom field types such as text, number or dropdown',
	},
	{
		value: 'resource-view-types',
		name: 'Resource View Types',
		path: '/mp/api/v1/resource-view-types',
		description: 'View types such as list, board or calendar',
	},
	{
		value: 'status-types',
		name: 'Status Types',
		path: '/mp/api/v1/status-types',
		description: 'Status type enum (active, done, closed)',
	},
	{
		value: 'workspace-access-level-permissions',
		name: 'Workspace Access Level Permissions',
		path: '/mp/api/v1/workspace-access-level-permissions',
		description: 'Which permissions each workspace role grants',
	},
];

const DEFAULT_REFERENCE_CATEGORY = REFERENCE_PATHS[0].value;

/** The picker holding the dashboard target of each scope; the workspace scope needs none. */
const SCOPE_TARGET_PARAM: Record<string, string> = {
	space: 'scopeSpaceId',
	folder: 'scopeFolderId',
	list: 'scopeListId',
};

const contextFlag = (name: string, displayName: string, description: string) => ({
	displayName,
	name,
	type: 'boolean' as const,
	default: true,
	description,
});

/**
 * Workspace: discovery inside the selected workspace. Boards come from Roadmarq (feature
 * requests) and wiki spaces from Codexum, so those operations are named after what they return.
 */
export const workspace: ResourceDef = {
	value: 'workspace',
	name: 'Workspace',
	workspaceScoped: true,
	operations: [
		{
			operation: 'listFeatureRequestBoards',
			name: 'Get Many Feature Request Boards',
			action: 'Get many feature request boards',
			description: 'List the Roadmarq feature request boards you can view in the workspace',
			fields: [],
			build: (p) => boardsSpec(p.workspace),
		},
		{
			operation: 'listWikiSpaces',
			name: 'Get Many Wiki Spaces',
			action: 'Get many wiki spaces',
			description: 'List the Codexum wiki spaces you can view in the workspace, with page counts',
			fields: [],
			build: (p) => wikiSpacesSpec(p.workspace),
		},
		{
			operation: 'getContext',
			name: 'Get Context',
			action: 'Get the workspace context',
			description:
				'Members, spaces, folders (sub-folders nest in folders), lists, statuses, task types and tags of the workspace in one call',
			fields: [
				{
					displayName: 'Additional Fields',
					name: 'additionalFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					options: [
						{
							displayName: 'Shallow',
							name: 'shallow',
							type: 'boolean',
							default: false,
							description:
								'Whether to skip statuses, priorities, task types, custom fields and tags',
						},
						{
							displayName: 'Space Name or ID',
							name: 'space',
							type: 'options',
							typeOptions: { loadOptionsMethod: 'getSpaces' },
							default: '',
							description:
								'Narrow the result to one space. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
						},
						contextFlag(
							'includeCustomFields',
							'Include Custom Fields',
							'Whether to include custom fields',
						),
						contextFlag(
							'includeRelationshipTypes',
							'Include Relationship Types',
							'Whether to include relationship types',
						),
						contextFlag('includeTags', 'Include Tags', 'Whether to include tags'),
						contextFlag('includeTaskTypes', 'Include Task Types', 'Whether to include task types'),
					],
				},
			],
			build: (p) => {
				const { space, ...rest } = p.get<IDataObject>('additionalFields', {});

				return contextSpec(p.workspace, space ? { ...rest, space } : rest);
			},
		},
		{
			operation: 'getDashboard',
			name: 'Get Dashboard',
			action: 'Get dashboard statistics',
			description: 'Task counts and distributions for a workspace, space, folder or list',
			fields: [
				{
					displayName: 'Scope',
					name: 'scope',
					type: 'options',
					options: [
						{ name: 'Workspace', value: 'workspace' },
						{ name: 'Space', value: 'space' },
						{ name: 'Folder', value: 'folder' },
						{ name: 'List', value: 'list' },
					],
					default: 'workspace',
					required: true,
					description: 'What to aggregate over',
				},
				idPicker('Space Name or ID', SCOPE_TARGET_PARAM.space, 'getSpaceIds', {
					field: 'scope',
					value: 'space',
				}),
				idPicker('Folder Name or ID', SCOPE_TARGET_PARAM.folder, 'getFolderIds', {
					field: 'scope',
					value: 'folder',
				}),
				idPicker('List Name or ID', SCOPE_TARGET_PARAM.list, 'getListIds', {
					field: 'scope',
					value: 'list',
				}),
			],
			build: (p) => {
				const scope = p.get<string>('scope');
				const target = SCOPE_TARGET_PARAM[scope];

				// The backend rejects a blank scopeIdentifier for every scope, workspace included.
				return {
					method: 'GET',
					path: '/mp/api/v1/dashboard/lite',
					qs: {
						scope,
						scopeIdentifier: target ? p.get<string>(target, '') : p.workspace,
					},
				};
			},
		},
		{
			operation: 'getReferenceData',
			name: 'Get Reference Data',
			action: 'Get reference data',
			description: 'List the accepted values of a Dutify enum, such as custom field types',
			fields: [
				{
					displayName: 'Category',
					name: 'category',
					type: 'options',
					options: REFERENCE_PATHS.map(({ value, name, description }) => ({
						name,
						value,
						description,
					})),
					default: DEFAULT_REFERENCE_CATEGORY,
					required: true,
					description: 'Which reference list to fetch',
				},
			],
			build: (p) => {
				const category = p.get<string>('category');
				const entry = REFERENCE_PATHS.find((r) => r.value === category);

				if (!entry) {
					throw new ApplicationError(`Unknown reference data category "${category}"`);
				}

				return { method: 'GET', path: entry.path };
			},
		},
	],
};
