import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { collection, idPicker, isSet, requireChange, text } from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import type {
	OperationDef,
	PaginationStyle,
	ParamReader,
	ResourceDef,
} from '../../../shared/types';

/* ---------- helpers ---------- */

/** The backend caps every page at 100 and counts pages from zero. */
const MAX_PAGE_SIZE = 100;

const TEAM_PAGING: PaginationStyle = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	maxPageSize: MAX_PAGE_SIZE,
};

const MEMBER_PAGING: PaginationStyle = { ...TEAM_PAGING, itemsPath: 'users' };

const IMPORT_PAGING: PaginationStyle = { ...TEAM_PAGING, sizeParam: 'pageSize' };

const workspacePath = (p: ParamReader) => encodePath`/mp/api/v1/workspaces/${p.workspace}`;

/** Access levels are numbers. A picked option arrives as a number, an expression may give text. */
function accessLevelId(value: unknown): number {
	const id = Number(value);
	if (value === '' || value === undefined || value === null || !Number.isInteger(id)) {
		throw new ApplicationError(`"${String(value)}" is not an access level ID`);
	}

	return id;
}

const userField = (name = 'user', displayName = 'Member Name or ID'): INodeProperties =>
	idPicker(displayName, name, 'getMemberIds', undefined);

const accessLevelField = (
	name = 'accessLevel',
	displayName = 'Access Level Name or ID',
): INodeProperties => idPicker(displayName, name, 'getAccessLevels', undefined);

/* ---------- team ---------- */

const teamField = (): INodeProperties => idPicker('Team Name or ID', 'team', 'getTeams', undefined);

const teamPath = (p: ParamReader) => encodePath`/mp/api/teams/${p.get<string>('team')}`;

const memberUuidsField = (description: string): INodeProperties => ({
	displayName: 'Members Names or IDs',
	name: 'memberUuids',
	type: 'multiOptions',
	typeOptions: { loadOptionsMethod: 'getMemberIds' },
	default: [],
	description:
		'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
	hint: description,
});

const teamDetailFields = (): INodeProperties[] => [
	text('Description', 'description', 'Description of the team (up to 10000 characters)'),
	text('Icon', 'icon', 'Icon identifier or emoji'),
	text('Color', 'color', 'Hex color such as #E91E63'),
];

/** Copies the set team fields into a body. */
function teamBody(fields: IDataObject): IDataObject {
	const body: IDataObject = {};
	for (const key of ['name', 'alias', 'description', 'icon', 'color'] as const) {
		if (isSet(fields[key])) {
			body[key] = fields[key];
		}
	}
	const members = fields.memberUuids;
	if (Array.isArray(members) && members.length > 0) {
		body.memberUuids = members;
	}

	return body;
}

const teamOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many teams',
		description: 'List the teams of the workspace, each with its members',
		fields: [],
		list: true,
		build: (p) => ({
			method: 'GET',
			path: encodePath`/mp/api/v1/workspaces/${p.workspace}/teams`,
			paginate: TEAM_PAGING,
		}),
	},
	{
		operation: 'create',
		name: 'Create',
		action: 'Create a team',
		description: 'Create a team of workspace members. Needs the Manage Teams permission',
		fields: [
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				description: 'Display name of the team (up to 100 characters)',
			},
			{
				displayName: 'Alias',
				name: 'alias',
				type: 'string',
				default: '',
				required: true,
				description: 'Short handle of the team, unique in the workspace (up to 100 characters)',
			},
			collection('Additional Fields', 'additionalFields', [
				...teamDetailFields(),
				memberUuidsField('Workspace members to add to the team'),
			]),
		],
		build: (p) => ({
			method: 'POST',
			path: encodePath`/mp/api/v1/workspaces/${p.workspace}/teams`,
			body: teamBody({
				name: p.get<string>('name'),
				alias: p.get<string>('alias'),
				...p.get<IDataObject>('additionalFields', {}),
			}),
		}),
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a team',
		description: 'Fetch a team with its members',
		fields: [teamField()],
		build: (p) => ({ method: 'GET', path: teamPath(p) }),
	},
	{
		operation: 'update',
		name: 'Update',
		action: 'Update a team',
		description:
			'Change a team. Members, if you set them, replace the whole current membership. Needs the Manage Teams permission',
		fields: [
			teamField(),
			collection('Update Fields', 'updateFields', [
				text('Name', 'name', 'New display name (up to 100 characters)'),
				text('Alias', 'alias', 'New short handle (up to 100 characters)'),
				...teamDetailFields(),
				memberUuidsField(
					'The complete list of members. It replaces the current membership, so leave it out to keep the members as they are.',
				),
			]),
		],
		build: (p) => ({
			method: 'PUT',
			path: teamPath(p),
			body: requireChange(teamBody(p.get<IDataObject>('updateFields', {}))),
		}),
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a team',
		description:
			'Delete a team. Its members stay in the workspace. Needs the Manage Teams permission',
		fields: [teamField()],
		build: (p) => ({ method: 'DELETE', path: teamPath(p) }),
	},
	{
		operation: 'addMember',
		name: 'Add Member',
		action: 'Add a member to a team',
		description: 'Add a workspace member to a team. Needs the Manage Teams permission',
		fields: [teamField(), userField()],
		build: (p) => ({
			method: 'POST',
			path: `${teamPath(p)}/members`,
			qs: { userUuid: p.get<string>('user') },
		}),
	},
	{
		operation: 'removeMember',
		name: 'Remove Member',
		action: 'Remove a member from a team',
		description:
			'Take a member out of a team. They stay in the workspace. Needs the Manage Teams permission',
		fields: [teamField(), userField()],
		build: (p) => ({
			method: 'DELETE',
			path: encodePath`/mp/api/teams/${p.get<string>('team')}/members/${p.get<string>('user')}`,
		}),
	},
];

/** Workspace teams (PM "Teams"). */
export const team: ResourceDef = {
	value: 'team',
	name: 'Team',
	workspaceScoped: true,
	operations: teamOperations,
};

/* ---------- member ---------- */

const memberOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many members',
		description: 'List the members of the workspace with their access level and product access',
		fields: [
			collection('Additional Fields', 'additionalFields', [
				text(
					'Search',
					'search',
					'Keep members whose first name, last name or e-mail contains this text',
				),
			]),
		],
		list: true,
		build: (p) => {
			const fields = p.get<IDataObject>('additionalFields', {});

			return {
				method: 'GET',
				path: `${workspacePath(p)}/users`,
				...(isSet(fields.search) ? { qs: { search: fields.search } } : {}),
				paginate: MEMBER_PAGING,
			};
		},
	},
];

/** Workspace members (PM "Workspaces", user endpoints). */
export const member: ResourceDef = {
	value: 'member',
	name: 'Member',
	workspaceScoped: true,
	operations: memberOperations,
};

/* ---------- invitation ---------- */

const invitationOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many invitations',
		description: 'List the pending invitations of the workspace. Needs the Manage Users permission',
		fields: [],
		build: (p) => ({ method: 'GET', path: `${workspacePath(p)}/invitations` }),
	},
	{
		operation: 'send',
		name: 'Send',
		action: 'Send an invitation',
		description:
			'Send an e-mail invitation to join the workspace. This sends a real e-mail. Needs the Manage Users permission',
		fields: [
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				placeholder: 'name@email.com',
				default: '',
				required: true,
				description: 'E-mail address to invite',
			},
			accessLevelField(),
			collection('Additional Fields', 'additionalFields', [
				{
					displayName: 'Suite Access',
					name: 'suiteAccess',
					type: 'boolean',
					default: true,
					description:
						'Whether accepting grants access to Dutify Cloud, Codexum and Roadmarq. The API default is on.',
				},
				{
					displayName: 'Hub Access',
					name: 'hubAccess',
					type: 'boolean',
					default: false,
					description:
						'Whether accepting grants access to Dutify Hub and AI Coworker. The API default is off.',
				},
			]),
		],
		build: (p) => {
			const fields = p.get<IDataObject>('additionalFields', {});
			const body: IDataObject = {
				email: p.get<string>('email'),
				workspaceAccessLevelId: accessLevelId(p.get('accessLevel')),
			};
			for (const key of ['suiteAccess', 'hubAccess'] as const) {
				if (isSet(fields[key])) {
					body[key] = fields[key];
				}
			}

			return { method: 'POST', path: `${workspacePath(p)}/invitations`, body };
		},
	},
	{
		operation: 'cancel',
		name: 'Cancel',
		action: 'Cancel an invitation',
		description:
			'Revoke a pending invitation so it can no longer be accepted. Needs the Manage Users permission',
		fields: [idPicker('Invitation Name or ID', 'invitation', 'getInvitations', undefined)],
		build: (p) => ({
			method: 'DELETE',
			path: encodePath`/mp/api/v1/workspaces/${p.workspace}/invitations/${p.get<string>('invitation')}`,
		}),
	},
];

/** Workspace invitations (PM "Workspaces", invitation endpoints). */
export const invitation: ResourceDef = {
	value: 'invitation',
	name: 'Invitation',
	workspaceScoped: true,
	operations: invitationOperations,
};

/* ---------- import job ---------- */

const jobField = (): INodeProperties =>
	idPicker('Import Job Name or ID', 'job', 'getImportJobs', undefined);

const importJobPath = (p: ParamReader) =>
	encodePath`/mp/api/v1/workspaces/${p.workspace}/import/${p.get<string>('job')}`;

interface MappingRow {
	csvHeader?: string;
	targetField?: string;
	targetType?: string;
}

const importJobOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many import jobs',
		description: 'List the import jobs of the workspace, newest first',
		fields: [],
		list: true,
		build: (p) => ({
			method: 'GET',
			path: `${workspacePath(p)}/import`,
			paginate: IMPORT_PAGING,
		}),
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get an import job',
		description: 'Fetch the status and progress of an import job',
		fields: [jobField()],
		build: (p) => ({ method: 'GET', path: importJobPath(p) }),
	},
	{
		operation: 'confirmMappings',
		name: 'Confirm Mappings',
		action: 'Confirm the column mappings of an import job',
		description:
			'Confirm which CSV column goes to which task field for a previewed import job. This starts the import and creates tasks',
		fields: [
			jobField(),
			{
				displayName: 'Column Mappings',
				name: 'columnMappings',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Mapping',
				default: {},
				required: true,
				description: 'One row per CSV column to import',
				options: [
					{
						displayName: 'Mapping',
						name: 'mapping',
						values: [
							{
								displayName: 'CSV Column',
								name: 'csvHeader',
								type: 'string',
								default: '',
								description: 'Header of the CSV column, spelled exactly as in the file',
							},
							{
								displayName: 'Task Field',
								name: 'targetField',
								type: 'string',
								default: '',
								description:
									'Task field to fill, such as title or status, or the identifier of a custom field',
							},
							{
								displayName: 'Field Type',
								name: 'targetType',
								type: 'options',
								options: [
									{ name: 'Built-In Field', value: 'builtin' },
									{ name: 'Custom Field', value: 'custom_field' },
								],
								default: 'builtin',
								description: 'Whether the task field is built in or a custom field',
							},
						],
					},
				],
			},
		],
		build: (p) => {
			const rows = p.get<{ mapping?: MappingRow[] }>('columnMappings', {}).mapping ?? [];
			if (rows.length === 0) {
				throw new ApplicationError('Add at least one column mapping');
			}

			return {
				method: 'POST',
				path: `${importJobPath(p)}/confirm`,
				body: {
					columnMappings: rows.map((row) => ({
						csvHeader: row.csvHeader,
						targetField: row.targetField,
						targetType: row.targetType,
					})),
				},
			};
		},
	},
];

/** Import jobs (PM "Import"). */
export const importJob: ResourceDef = {
	value: 'importJob',
	name: 'Import Job',
	workspaceScoped: true,
	operations: importJobOperations,
};
