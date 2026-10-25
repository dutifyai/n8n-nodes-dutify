import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import {
	collection,
	idPicker,
	isSet,
	jsonField,
	requireChange,
	text,
} from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import type {
	OperationDef,
	PaginationStyle,
	ParamReader,
	ResourceDef,
} from '../../../shared/types';

/** The automation endpoints page zero-based and the backend rejects a size above 100. */
const AUTOMATION_PAGING: PaginationStyle = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	maxPageSize: 100,
};

type Scope = 'space' | 'folder' | 'list';

const scopeField = (description: string): INodeProperties => ({
	displayName: 'Scope',
	name: 'scope',
	type: 'options',
	options: [
		{ name: 'Space', value: 'space' },
		{ name: 'Folder', value: 'folder' },
		{ name: 'List', value: 'list' },
	],
	default: 'list',
	description,
});

/** The scope selector followed by the picker for the chosen scope's target. */
const scopeFields = (description: string): INodeProperties[] => [
	scopeField(description),
	idPicker('Space Name or ID', 'space', 'getSpaceIds', { field: 'scope', value: 'space' }),
	idPicker('Folder Name or ID', 'folder', 'getFolderIds', { field: 'scope', value: 'folder' }),
	idPicker('List Name or ID', 'list', 'getListIds', { field: 'scope', value: 'list' }),
];

const IDENTIFIER_KEY: Record<Scope, string> = {
	space: 'spaceIdentifier',
	folder: 'folderIdentifier',
	list: 'listIdentifier',
};

const targetOf = (p: ParamReader) => {
	const scope = p.get<Scope>('scope');

	return { scope, id: p.get<string>(scope) };
};

/** An existing automation is picked from the ones in the chosen scope. */
const automationFields = (): INodeProperties[] => [
	...scopeFields('Where to look for the automation'),
	idPicker('Automation Name or ID', 'automation', 'getAutomations', undefined, [
		'scope',
		'space',
		'folder',
		'list',
	]),
];

const automationPath = (p: ParamReader) =>
	encodePath`/mp/api/v1/automations/${p.get<string>('automation')}`;

/* ---------- JSON fields ---------- */

type JsonKey = 'triggers' | 'actions' | 'conditionNodes';

const JSON_LABEL: Record<JsonKey, string> = {
	triggers: 'Triggers',
	actions: 'Actions',
	conditionNodes: 'Condition Nodes',
};

/** A JSON field arrives as text (typed) or as the parsed value (expression). */
function parseArray(value: unknown, label: string): IDataObject[] {
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

/** The API stores `parameters` as JSON text; an object written inline is turned into text. */
function stringifyParameters(node: IDataObject): IDataObject {
	const copy: IDataObject = { ...node };
	if (copy.parameters !== undefined && typeof copy.parameters !== 'string') {
		copy.parameters = JSON.stringify(copy.parameters);
	}
	if (Array.isArray(copy.children)) {
		copy.children = (copy.children as IDataObject[]).map(stringifyParameters);
	}

	return copy;
}

/** Copies the set automation fields of a collection into a request body. */
function automationBody(fields: IDataObject): IDataObject {
	const body: IDataObject = {};
	for (const key of ['name', 'description'] as const) {
		if (isSet(fields[key])) {
			body[key] = fields[key];
		}
	}
	if (typeof fields.active === 'boolean') {
		body.active = fields.active;
	}
	for (const key of Object.keys(JSON_LABEL) as JsonKey[]) {
		if (isSet(fields[key])) {
			body[key] = parseArray(fields[key], JSON_LABEL[key]).map(stringifyParameters);
		}
	}

	return body;
}

const triggersField = (): INodeProperties =>
	jsonField(
		'Triggers',
		'triggers',
		'JSON array of up to 20 triggers, any of which fires the automation, such as [{"triggerType":"status_changed","parameters":{"status":"Done"}}]. Valid trigger types: GET /mp/api/v1/activity-types',
	);
const actionsField = (): INodeProperties =>
	jsonField(
		'Actions',
		'actions',
		'JSON array of up to 20 actions, run in order, such as [{"actionType":"set_status","parameters":{"status":"Closed"}}]. Valid action types: GET /mp/api/v1/automation/public/action-type',
	);
const conditionNodesField = (): INodeProperties =>
	jsonField(
		'Condition Nodes',
		'conditionNodes',
		'JSON array with the condition tree that must hold for the actions to run. A leaf is {"nodeType":"condition","conditionType":"...","parameters":{...}}; a group is {"nodeType":"operator","operatorType":"AND","children":[...]}. Valid types: GET /mp/api/v1/automation/public/condition-type and /mp/api/v1/automation/public/field-operator',
	);
const descriptionField = (): INodeProperties =>
	text('Description', 'description', 'What the automation does (up to 2000 characters)');
const activeField = (): INodeProperties => ({
	displayName: 'Active',
	name: 'active',
	type: 'boolean',
	default: true,
	description: 'Whether the automation is enabled and processing events',
});

/* ---------- operations ---------- */

const operations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many automations',
		description: 'List the automations of a space, a folder or a list',
		list: true,
		fields: [
			...scopeFields('Whether to list the automations of a space, a folder or a list'),
			{
				displayName: 'Include Descendants',
				name: 'includeDescendants',
				type: 'boolean',
				default: false,
				displayOptions: { show: { scope: ['space', 'folder'] } },
				description: 'Whether to include the automations of the folders and lists below',
			},
		],
		build: (p) => {
			const { scope, id } = targetOf(p);
			const includeDescendants = scope !== 'list' && p.get<boolean>('includeDescendants', false);

			return {
				method: 'GET',
				path: `/mp/api/v1/automations/${scope}/${encodeURIComponent(id)}`,
				...(includeDescendants ? { qs: { includeDescendants: true } } : {}),
				paginate: AUTOMATION_PAGING,
			};
		},
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get an automation',
		description: 'Fetch an automation with its triggers, conditions and actions',
		fields: automationFields(),
		build: (p) => ({ method: 'GET', path: automationPath(p) }),
	},
	{
		operation: 'create',
		name: 'Create',
		action: 'Create an automation',
		description: 'Create an automation in a space, a folder or a list',
		fields: [
			...scopeFields('Where the automation lives'),
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				description: 'Name of the automation (up to 200 characters)',
			},
			{ ...triggersField(), required: true },
			{ ...actionsField(), required: true },
			collection('Additional Fields', 'additionalFields', [
				descriptionField(),
				activeField(),
				conditionNodesField(),
			]),
		],
		build: (p) => {
			const { scope, id } = targetOf(p);

			return {
				method: 'POST',
				path: '/mp/api/v1/automations',
				body: {
					...automationBody({
						name: p.get<string>('name'),
						triggers: p.get('triggers'),
						actions: p.get('actions'),
						...p.get<IDataObject>('additionalFields', {}),
					}),
					[IDENTIFIER_KEY[scope]]: id,
				},
			};
		},
	},
	{
		operation: 'update',
		name: 'Update',
		action: 'Update an automation',
		description: 'Change the name, enabled state, triggers, conditions or actions of an automation',
		fields: [
			...automationFields(),
			collection('Update Fields', 'updateFields', [
				text('Name', 'name', 'New name (up to 200 characters)'),
				descriptionField(),
				activeField(),
				triggersField(),
				actionsField(),
				conditionNodesField(),
			]),
		],
		build: (p) => ({
			method: 'PUT',
			path: automationPath(p),
			body: requireChange(automationBody(p.get<IDataObject>('updateFields', {}))),
		}),
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete an automation',
		description: 'Permanently delete an automation',
		fields: automationFields(),
		build: (p) => ({ method: 'DELETE', path: automationPath(p) }),
	},
	{
		operation: 'getAudit',
		name: 'Get Audit',
		action: 'Get the execution history of an automation',
		description: 'List the runs of an automation with the result of each action',
		list: true,
		fields: automationFields(),
		build: (p) => ({
			method: 'GET',
			path: `${automationPath(p)}/audit`,
			paginate: AUTOMATION_PAGING,
		}),
	},
];

/** Automation rules (PM "Automation"). */
export const automation: ResourceDef = {
	value: 'automation',
	name: 'Automation',
	workspaceScoped: true,
	operations,
};
