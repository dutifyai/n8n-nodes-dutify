import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import {
	collection,
	isSet,
	jsonField,
	requireChange,
	splitList,
	text,
} from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import type { OperationDef, ParamReader, RequestSpec, ResourceDef } from '../../../shared/types';

/* ---------- helpers ---------- */

/** Copies the listed keys of a collection into a body, skipping unset values (false is kept). */
function pick(fields: IDataObject, keys: readonly string[], body: IDataObject = {}): IDataObject {
	for (const key of keys) {
		if (isSet(fields[key])) {
			body[key] = fields[key];
		}
	}

	return body;
}

const nameField = (description: string): INodeProperties => ({
	displayName: 'Name',
	name: 'name',
	type: 'string',
	default: '',
	required: true,
	description,
});

/** Free-text identifier, for entities the workspace context lists no identifier for (tags). */
const idField = (displayName: string, name: string, prefix: string): INodeProperties => ({
	displayName,
	name,
	type: 'string',
	default: '',
	required: true,
	description: `Identifier (${prefix}...). It is returned when the item is created.`,
});

/** Picker whose value is the identifier. Accepts an expression or a pasted ID as well. */
const idPicker = (displayName: string, name: string, method: string): INodeProperties => ({
	displayName,
	name,
	type: 'options',
	typeOptions: { loadOptionsMethod: method },
	default: '',
	required: true,
	description:
		'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
});

const spaceByName: INodeProperties = {
	displayName: 'Space Name or ID',
	name: 'space',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getSpaces' },
	default: '',
	required: true,
	description:
		'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
};

const description = text('Description', 'description', 'Description');
const icon = (hint: string) => text('Icon', 'icon', hint);
const color = (hint: string) => text('Color', 'color', hint);
const isPrivate = (what: string): INodeProperties => ({
	displayName: 'Private',
	name: 'isPrivate',
	type: 'boolean',
	default: false,
	description: `Whether ${what} is restricted to explicitly granted users and teams`,
});

const metadataKeys = ['name', 'description', 'icon', 'color', 'isPrivate'] as const;

/** Update ops: PUT only the metadata fields the user set. Unset fields stay unchanged server-side. */
function updateSpec(basePath: string, idParam: string, keys: readonly string[] = metadataKeys) {
	return (p: ParamReader): RequestSpec => ({
		method: 'PUT',
		path: `${basePath}/${encodeURIComponent(p.get<string>(idParam))}`,
		body: requireChange(pick(p.get<IDataObject>('updateFields', {}), keys)),
	});
}

function deleteSpec(basePath: string, idParam: string) {
	return (p: ParamReader): RequestSpec => ({
		method: 'DELETE',
		path: `${basePath}/${encodeURIComponent(p.get<string>(idParam))}`,
	});
}

/* ---------- space ---------- */

const spacePath = (p: ParamReader) => encodePath`/mp/api/v1/spaces/${p.get<string>('space')}`;

const spaceIdPicker = () => idPicker('Space Name or ID', 'space', 'getSpaceIds');

const toggle = (displayName: string, name: string, description: string): INodeProperties => ({
	displayName,
	name,
	type: 'boolean',
	default: false,
	description,
});

/** SpaceUpdateRequest fields sent as given. Unset fields stay unchanged server-side. */
const spaceScalarKeys = [
	'name',
	'description',
	'icon',
	'color',
	'isPrivate',
	'isSubtasksEnabled',
	'isSprintsEnabled',
	'isStatusesInherited',
	'isPrioritiesInherited',
	'isTaskKeyUsed',
	'taskKeyPrefix',
] as const;

/** SpaceUpdateRequest list fields with their labels; typed as JSON text or given by an expression. */
const spaceListFields = {
	statuses: 'Statuses',
	priorities: 'Priorities',
	statusReassignments: 'Status Reassignments',
	priorityReassignments: 'Priority Reassignments',
	userAccess: 'User Access',
	teamAccess: 'Team Access',
} as const;

function jsonArray(value: unknown, label: string): IDataObject[] {
	let parsed: unknown = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			parsed = undefined;
		}
	}
	if (!Array.isArray(parsed)) {
		throw new ApplicationError(`${label} must be a JSON array`);
	}

	return parsed as IDataObject[];
}

function spaceUpdateBody(fields: IDataObject): IDataObject {
	const body = pick(fields, spaceScalarKeys);
	for (const [key, label] of Object.entries(spaceListFields)) {
		if (isSet(fields[key])) {
			body[key] = jsonArray(fields[key], label);
		}
	}

	return requireChange(body);
}

const spaceUpdateFields = (): INodeProperties[] => [
	text('Name', 'name', 'New name, up to 100 characters'),
	description,
	icon('Icon identifier or emoji shortcode, for example rocket'),
	color('Hex color code, for example #4A90D9'),
	isPrivate('the space'),
	toggle(
		'Subtasks',
		'isSubtasksEnabled',
		'Whether tasks in the space can have subtasks. While this is off, creating a subtask there is refused.',
	),
	toggle(
		'Sprints',
		'isSprintsEnabled',
		'Whether the space uses sprints. While this is off, sprint groups cannot be created there.',
	),
	toggle(
		'Statuses Inherited',
		'isStatusesInherited',
		'Whether the space uses the workspace statuses instead of its own',
	),
	toggle(
		'Priorities Inherited',
		'isPrioritiesInherited',
		'Whether the space uses the workspace priorities instead of its own',
	),
	toggle(
		'Use Task Keys',
		'isTaskKeyUsed',
		'Whether tasks in the space get sequential keys such as ENG-12',
	),
	text(
		'Task Key Prefix',
		'taskKeyPrefix',
		'Prefix of the task keys, up to 20 characters, for example ENG',
	),
	jsonField(
		spaceListFields.statuses,
		'statuses',
		'JSON array that replaces the space statuses, such as [{"name":"In Progress","type":"ACTIVE"}]. The type is NOT_STARTED, ACTIVE or CLOSED; give an identifier to keep an existing status.',
	),
	jsonField(
		spaceListFields.priorities,
		'priorities',
		'JSON array that replaces the space priorities, such as [{"name":"High","backgroundColor":"#E53E3E"}]. Give an identifier to keep an existing priority.',
	),
	jsonField(
		spaceListFields.statusReassignments,
		'statusReassignments',
		'JSON array that moves tasks off removed statuses, such as [{"sourceStatusIdentifier":"sts_old","targetStatusIdentifier":"sts_new"}]',
	),
	jsonField(
		spaceListFields.priorityReassignments,
		'priorityReassignments',
		'JSON array that moves tasks off removed priorities, such as [{"sourcePriorityIdentifier":"pri_old","targetPriorityIdentifier":"pri_new"}]',
	),
	jsonField(
		spaceListFields.userAccess,
		'userAccess',
		'JSON array of user access grants, such as [{"userUuid":"550e8400-e29b-41d4-a716-446655440000","accessLevelId":1}]',
	),
	jsonField(
		spaceListFields.teamAccess,
		'teamAccess',
		'JSON array of team access grants, such as [{"teamIdentifier":"team_abc","accessLevelId":1}]',
	),
];

export const space: ResourceDef = {
	value: 'space',
	name: 'Space',
	workspaceScoped: true,
	operations: [
		{
			operation: 'create',
			name: 'Create',
			action: 'Create a space',
			description: 'Create a space in the workspace',
			fields: [
				nameField('Name of the space'),
				collection('Additional Fields', 'additionalFields', [
					description,
					icon('Icon identifier or emoji shortcode, for example rocket'),
					color('Hex color code, for example #4A90D9'),
					isPrivate('the space'),
				]),
			],
			build: (p) => ({
				method: 'POST',
				path: '/mp/api/v1/spaces/lite',
				body: {
					workspace: p.workspace,
					name: p.get<string>('name'),
					...pick(p.get<IDataObject>('additionalFields', {}), metadataKeys.slice(1)),
				},
			}),
		},
		{
			operation: 'get',
			name: 'Get',
			action: 'Get a space',
			description: 'Fetch a space with its settings, such as whether subtasks and sprints are on',
			fields: [spaceIdPicker()],
			build: (p) => ({ method: 'GET', path: spacePath(p) }),
		},
		{
			operation: 'update',
			name: 'Update',
			action: 'Update a space',
			description:
				'Change only the settings you set on a space, such as turning subtasks or sprints on',
			fields: [spaceIdPicker(), collection('Update Fields', 'updateFields', spaceUpdateFields())],
			build: (p) => ({
				method: 'PUT',
				path: spacePath(p),
				body: spaceUpdateBody(p.get<IDataObject>('updateFields', {})),
			}),
		},
		{
			operation: 'delete',
			name: 'Delete',
			action: 'Delete a space',
			description: 'Soft-delete a space with its folders, lists and tasks',
			fields: [spaceIdPicker()],
			build: (p) => ({ method: 'DELETE', path: spacePath(p) }),
		},
	],
};

/* ---------- folder ---------- */

const folderBase = '/mp/api/v1/folders/lite';

export const folder: ResourceDef = {
	value: 'folder',
	name: 'Folder',
	workspaceScoped: true,
	operations: [
		{
			operation: 'create',
			name: 'Create',
			action: 'Create a folder',
			description: 'Create a folder in a space',
			fields: [spaceByName, nameField('Name of the folder')],
			build: (p) => ({
				method: 'POST',
				path: folderBase,
				body: {
					workspace: p.workspace,
					space: p.get<string>('space'),
					name: p.get<string>('name'),
				},
			}),
		},
		{
			operation: 'update',
			name: 'Update',
			action: 'Update a folder',
			description: 'Change only the metadata you set on a folder',
			fields: [
				idPicker('Folder Name or ID', 'folder', 'getFolderIds'),
				collection('Update Fields', 'updateFields', [
					text('Name', 'name', 'New name'),
					description,
					icon('Icon identifier or emoji shortcode'),
					color('Hex color code'),
					isPrivate('the folder'),
				]),
			],
			build: updateSpec(folderBase, 'folder'),
		},
		{
			operation: 'delete',
			name: 'Delete',
			action: 'Delete a folder',
			description: 'Soft-delete a folder with its sub-folders, lists and tasks',
			fields: [idPicker('Folder Name or ID', 'folder', 'getFolderIds')],
			build: deleteSpec(folderBase, 'folder'),
		},
	],
};

/* ---------- list ---------- */

const listBase = '/mp/api/v1/lists/lite';

export const list: ResourceDef = {
	value: 'list',
	name: 'List',
	workspaceScoped: true,
	operations: [
		{
			operation: 'create',
			name: 'Create',
			action: 'Create a list',
			description: 'Create a list in a space, or inside one of its folders',
			fields: [
				spaceByName,
				nameField('Name of the list'),
				collection('Additional Fields', 'additionalFields', [
					text(
						'Folder',
						'folder',
						'Folder name in the space. Leave empty to create the list directly in the space.',
					),
					icon('Icon identifier or emoji'),
					color('Hex code or color name'),
				]),
			],
			build: (p) => {
				const fields = p.get<IDataObject>('additionalFields', {});
				const body: IDataObject = {
					workspace: p.workspace,
					space: p.get<string>('space'),
					...pick(fields, ['folder']),
					name: p.get<string>('name'),
					...pick(fields, ['icon', 'color']),
				};

				return { method: 'POST', path: listBase, body };
			},
		},
		{
			operation: 'update',
			name: 'Update',
			action: 'Update a list',
			description: 'Change only the metadata you set on a list',
			fields: [
				idPicker('List Name or ID', 'list', 'getListIds'),
				collection('Update Fields', 'updateFields', [
					text('Name', 'name', 'New name'),
					description,
					icon('Icon identifier or emoji shortcode'),
					color('Hex color code'),
					isPrivate('the list'),
				]),
			],
			build: updateSpec(listBase, 'list'),
		},
		{
			operation: 'delete',
			name: 'Delete',
			action: 'Delete a list',
			description: 'Soft-delete a list and its tasks',
			fields: [idPicker('List Name or ID', 'list', 'getListIds')],
			build: deleteSpec(listBase, 'list'),
		},
	],
};

/* ---------- custom field ---------- */

const customFieldBase = '/mp/api/v1/custom-fields/lite';

const SCOPE_DEFAULT = 'workspace';

const createCustomField: OperationDef = {
	operation: 'create',
	name: 'Create',
	action: 'Create a custom field',
	description: 'Create a custom field at workspace, space or list scope',
	fields: [
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'options',
			options: [
				{ name: 'Workspace', value: 'workspace' },
				{ name: 'Space', value: 'space' },
				{ name: 'List', value: 'list' },
			],
			default: SCOPE_DEFAULT,
			required: true,
			description: 'Where the field is available',
		},
		{
			displayName: 'Scope Name',
			name: 'scopeName',
			type: 'string',
			default: '',
			displayOptions: { show: { scope: ['space', 'list'] } },
			description:
				'Name of the space or list the field belongs to. A list name is matched across the workspace.',
		},
		nameField('Plain field name, as shown in column headers'),
		{
			displayName: 'Type',
			name: 'type',
			type: 'string',
			default: 'text',
			required: true,
			description:
				'Field type, for example text, number, date, checkbox, dropdown, labels, email or phone',
		},
		collection('Additional Fields', 'additionalFields', [
			text('Emoji', 'emoji', 'Icon-picker key for the field icon, for example Flag'),
			color('Hex color code for the field icon'),
			text(
				'Options',
				'options',
				'Comma-separated option labels. Only for dropdown and labels types.',
			),
		]),
	],
	build: (p) => {
		const scope = p.get<string>('scope');
		const fields = p.get<IDataObject>('additionalFields', {});
		const body: IDataObject = { scope, workspace: p.workspace };
		const scopeName = p.get<string>('scopeName', '');
		if (scope !== 'workspace' && isSet(scopeName)) {
			body.scopeName = scopeName;
		}
		body.name = p.get<string>('name');
		body.type = p.get<string>('type');
		pick(fields, ['emoji', 'color'], body);
		// orderIndex is optional in the catalog, but the backend fails (500) on an option without it.
		const options = splitList(fields.options).map((value, orderIndex) => ({ value, orderIndex }));
		if (options.length > 0) {
			body.options = options;
		}

		return { method: 'POST', path: customFieldBase, body };
	},
};

export const customField: ResourceDef = {
	value: 'customField',
	name: 'Custom Field',
	workspaceScoped: true,
	operations: [
		createCustomField,
		{
			operation: 'update',
			name: 'Update',
			action: 'Update a custom field',
			description: 'Change a custom field name, description, emoji, color or privacy',
			fields: [
				idPicker('Custom Field Name or ID', 'customField', 'getCustomFieldIds'),
				collection('Update Fields', 'updateFields', [
					text('Name', 'name', 'New name'),
					description,
					text('Emoji', 'emoji', 'Icon-picker key, for example rocket'),
					color('Hex color code'),
					isPrivate('the field'),
				]),
			],
			build: updateSpec(customFieldBase, 'customField', [
				'name',
				'description',
				'emoji',
				'color',
				'isPrivate',
			]),
		},
		{
			operation: 'delete',
			name: 'Delete',
			action: 'Delete a custom field',
			description: 'Permanently delete a custom field and every task value stored in it',
			fields: [idPicker('Custom Field Name or ID', 'customField', 'getCustomFieldIds')],
			build: deleteSpec(customFieldBase, 'customField'),
		},
	],
};

/* ---------- tag ---------- */

const tagColors = ['textColor', 'backgroundColor'] as const;

const tagColorOptions = (): INodeProperties[] => [
	text('Background Color', 'backgroundColor', 'Hex background color, for example #3B82F6'),
	text('Text Color', 'textColor', 'Hex text color, for example #FFFFFF'),
];

const tagPath = (p: ParamReader) => encodePath`/mp/api/v1/tags/${p.get<string>('tag')}`;

export const tag: ResourceDef = {
	value: 'tag',
	name: 'Tag',
	workspaceScoped: true,
	operations: [
		{
			operation: 'create',
			name: 'Create',
			action: 'Create a tag',
			description: 'Create a tag in a space',
			fields: [
				idPicker('Space Name or ID', 'space', 'getSpaceIds'),
				nameField('Tag name. Names are case-sensitive and unique per space.'),
				collection('Additional Fields', 'additionalFields', tagColorOptions()),
			],
			build: (p) => ({
				method: 'POST',
				path: encodePath`/mp/api/v1/tags/space/${p.get<string>('space')}`,
				body: pick(p.get<IDataObject>('additionalFields', {}), tagColors, {
					name: p.get<string>('name'),
				}),
			}),
		},
		{
			operation: 'get',
			name: 'Get',
			action: 'Get a tag',
			description: 'Fetch a tag by identifier',
			fields: [idField('Tag ID', 'tag', 'tag_')],
			build: (p) => ({ method: 'GET', path: tagPath(p) }),
		},
		{
			operation: 'update',
			name: 'Update',
			action: 'Update a tag',
			description: 'Rename or recolor a tag',
			fields: [
				idField('Tag ID', 'tag', 'tag_'),
				collection('Update Fields', 'updateFields', [
					text('Name', 'name', 'New name'),
					...tagColorOptions(),
				]),
			],
			// The backend copies every TagDTO field onto the tag, so an omitted field would be
			// overwritten with null. Read the tag first and send it back whole.
			run: async (ctx, p) => {
				const changes = requireChange(
					pick(p.get<IDataObject>('updateFields', {}), ['name', ...tagColors]),
				);
				const path = tagPath(p);
				const current = (await ctx.request({ method: 'GET', path })) as IDataObject;
				const body: IDataObject = {
					...pick(current, ['name', ...tagColors]),
					...changes,
				};
				const updated = await ctx.request({ method: 'PUT', path, body });

				return [{ json: (updated ?? body) as IDataObject }];
			},
		},
		{
			operation: 'delete',
			name: 'Delete',
			action: 'Delete a tag',
			description: 'Delete a tag and remove it from every task that carries it',
			fields: [idField('Tag ID', 'tag', 'tag_')],
			build: (p) => ({ method: 'DELETE', path: tagPath(p) }),
		},
	],
};
