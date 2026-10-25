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
	ParamReader,
	PaginationStyle,
	ResourceDef,
} from '../../../shared/types';

/* ---------- helpers ---------- */

const CURSOR_PAGING: PaginationStyle = {
	kind: 'cursor',
	cursorParam: 'cursor',
	limitParam: 'limit',
	itemsPath: 'items',
	nextCursorPath: 'nextCursor',
	maxPageSize: 200,
};

/** Copies the listed keys of a collection into a body. Keys in `keepEmpty` keep a blank value. */
function pick(
	fields: IDataObject,
	keys: readonly string[],
	keepEmpty: readonly string[] = [],
): IDataObject {
	const body: IDataObject = {};
	for (const key of keys) {
		const value = fields[key];
		if (isSet(value) || (keepEmpty.includes(key) && value === '')) {
			body[key] = value as IDataObject[string];
		}
	}

	return body;
}

/** A JSON field arrives as text (typed) or as the parsed value (expression). */
function parseJson(
	value: unknown,
	label: string,
	shape: 'array' | 'object',
): IDataObject | IDataObject[] {
	let parsed: unknown = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			parsed = undefined;
		}
	}
	const ok =
		shape === 'array'
			? Array.isArray(parsed)
			: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
	if (!ok) {
		throw new ApplicationError(`${label} must be a JSON ${shape}`);
	}

	return parsed as IDataObject | IDataObject[];
}

/** Replaces the JSON-text fields of a collection by their parsed values. */
function withJson(body: IDataObject, fields: Record<string, 'array' | 'object'>): IDataObject {
	for (const [key, shape] of Object.entries(fields)) {
		if (isSet(body[key])) {
			body[key] = parseJson(body[key], key[0].toUpperCase() + key.slice(1), shape) as IDataObject;
		}
	}

	return body;
}

const integer = (displayName: string, name: string, description: string): INodeProperties => ({
	displayName,
	name,
	type: 'number',
	typeOptions: { minValue: 0 },
	default: 0,
	description,
});

const SCOPE_OPTIONS = [
	{ name: 'Workspace', value: 'workspace' },
	{ name: 'Space', value: 'space' },
	{ name: 'Folder', value: 'folder' },
	{ name: 'List', value: 'list' },
];

const SCOPE_PARAMS = ['scope', 'scopeSpaceId', 'scopeFolderId', 'scopeListId'];

/**
 * A scope level plus the picker for its target. The workspace level needs no target: it is the
 * selected workspace. `prefix` is 'scope' for where a view lives, 'target' for where to clone to.
 */
function scopeFields(
	prefix: 'scope' | 'target',
	scopeLabel: string,
	scopeHint: string,
): INodeProperties[] {
	const scopeName = prefix === 'scope' ? 'scope' : 'targetScope';
	const idName = (kind: string) => (prefix === 'scope' ? `scope${kind}Id` : `target${kind}Id`);

	return [
		{
			displayName: scopeLabel,
			name: scopeName,
			type: 'options',
			options: SCOPE_OPTIONS,
			default: 'list',
			required: true,
			description: scopeHint,
		},
		idPicker('Space Name or ID', idName('Space'), 'getSpaceIds', {
			field: scopeName,
			value: 'space',
		}),
		idPicker('Folder Name or ID', idName('Folder'), 'getFolderIds', {
			field: scopeName,
			value: 'folder',
		}),
		idPicker('List Name or ID', idName('List'), 'getListIds', { field: scopeName, value: 'list' }),
	];
}

/** The identifier of the chosen scope's target. The workspace's identifier is the selected workspace. */
function scopeIdentifier(
	p: ParamReader,
	prefix: 'scope' | 'target',
): { scope: string; id: string } {
	const scope = p.get<string>(prefix === 'scope' ? 'scope' : 'targetScope');
	const id =
		scope === 'workspace'
			? p.workspace
			: p.get<string>(
					`${prefix}${scope === 'space' ? 'Space' : scope === 'folder' ? 'Folder' : 'List'}Id`,
					'',
				);

	return { scope, id };
}

const viewPicker: INodeProperties = idPicker(
	'View Name or ID',
	'view',
	'getViews',
	undefined,
	SCOPE_PARAMS,
);

/** Scope fields followed by the view picker: the views listed come from the chosen scope. */
const viewFields = (): INodeProperties[] => [
	...scopeFields('scope', 'Scope', 'Where the view lives. Used to list the views to choose from'),
	viewPicker,
];

const widgetPicker: INodeProperties = idPicker(
	'Widget Name or ID',
	'widget',
	'getWidgets',
	undefined,
	['view'],
);

const viewPath = (p: ParamReader) => encodePath`/mp/api/v1/views/lite/${p.get<string>('view')}`;
const widgetsPath = (p: ParamReader) => `${viewPath(p)}/widgets`;

const VIEW_TYPES = ['list', 'board', 'table', 'dashboard', 'gantt', 'calendar', 'gallery'];

const sortDirection: INodeProperties = {
	displayName: 'Sort Direction',
	name: 'sortDirection',
	type: 'options',
	options: [
		{ name: 'Ascending', value: 'asc' },
		{ name: 'Descending', value: 'desc' },
	],
	default: 'asc',
	description: 'Only meaningful when Sort By is set',
};

const filtersField = (verb: string): INodeProperties =>
	jsonField(
		'Filters',
		'filters',
		`JSON array of filter groups ${verb}, for example [{"precedingLogic":"AND","filters":[{"field":"status","operator":"equals","value":"Open"}]}]`,
	);

const columnsField = (): INodeProperties =>
	jsonField(
		'Columns',
		'columns',
		'JSON array of columns in display order, for example [{"columnIdentifier":"status","isMandatory":true}]. A column not listed is not visible',
	);

const groupBy = (clears: string): INodeProperties =>
	text('Group By', 'groupBy', `Field identifier to group by, for example status.${clears}`);
const sortBy = (clears: string): INodeProperties =>
	text('Sort By', 'sortBy', `Field identifier to sort by, for example dueDate.${clears}`);

const isPrivate: INodeProperties = {
	displayName: 'Private',
	name: 'isPrivate',
	type: 'boolean',
	default: false,
	description: 'Whether the view is private to its creator',
};

/** The WidgetConfig fields shared by add and update. */
const widgetLayout = (): INodeProperties[] => [
	text('Title', 'title', 'Title shown in the widget header'),
	integer(
		'X',
		'x',
		'Horizontal grid position. Left out, the server places the widget below the others',
	),
	integer(
		'Y',
		'y',
		'Vertical grid position. Left out, the server places the widget below the others',
	),
	integer('Width', 'w', 'Width in grid units (the dashboard is 12 columns wide)'),
	integer('Height', 'h', 'Height in grid units'),
	integer('Min Width', 'minW', 'Minimum width in grid units'),
	integer('Min Height', 'minH', 'Minimum height in grid units'),
	jsonField(
		'Config',
		'config',
		'JSON object with the widget data settings, for example {"metric":"count","groupByField":"status","chartType":"bar"}',
	),
];

const WIDGET_KEYS = ['title', 'x', 'y', 'w', 'h', 'minW', 'minH', 'config'] as const;

/** Widget types the backend knows from the dashboards and presets. */
const WIDGET_TYPES = [
	'progress-overview',
	'distribution-chart',
	'grouped-summary',
	'trend-chart',
	'burndown',
	'workload',
	'time-tracking',
	'activity-feed',
	'voting-results',
	'relationship-graph',
	'overdue-tracker',
	'metric-card',
	'task-list',
];

const widgetBody = (type: string | undefined, fields: IDataObject): IDataObject =>
	withJson({ ...(type ? { type } : {}), ...pickWidget(fields) }, { config: 'object' });

/** Numbers are kept at 0; text and JSON are dropped when blank. */
function pickWidget(fields: IDataObject): IDataObject {
	const body: IDataObject = {};
	for (const key of WIDGET_KEYS) {
		const value = fields[key];
		if (isSet(value)) {
			body[key] = value as IDataObject[string];
		}
	}

	return body;
}

/* ---------- operations ---------- */

const listOp: OperationDef = {
	operation: 'list',
	name: 'Get Many',
	action: 'Get many views',
	description: 'List the views attached to a workspace, space, folder or list',
	list: true,
	fields: scopeFields('scope', 'Scope', 'Where the views live'),
	build: (p) => {
		const { scope, id } = scopeIdentifier(p, 'scope');

		return {
			method: 'GET',
			path: '/mp/api/v1/views/lite',
			qs: { scope, scopeIdentifier: id },
			paginate: CURSOR_PAGING,
		};
	},
};

const createOp: OperationDef = {
	operation: 'create',
	name: 'Create',
	action: 'Create a view',
	description:
		'Create a view at workspace, space, folder or list scope. Only dashboards can be created above list level',
	fields: [
		...scopeFields('scope', 'Scope', 'Where to create the view'),
		{
			displayName: 'Name',
			name: 'name',
			type: 'string',
			default: '',
			required: true,
			description: 'Name of the view (up to 100 characters)',
		},
		{
			displayName: 'Type',
			name: 'type',
			type: 'options',
			options: VIEW_TYPES.map((value) => ({
				name: value[0].toUpperCase() + value.slice(1),
				value,
			})),
			default: 'list',
			required: true,
			description:
				'View type. Workspace, space and folder scopes accept only Dashboard. Forms and whiteboards are not available here',
		},
		collection('Additional Fields', 'additionalFields', [
			isPrivate,
			groupBy(''),
			sortBy(''),
			sortDirection,
			filtersField('applied at creation'),
			columnsField(),
		]),
	],
	build: (p) => {
		const { scope, id } = scopeIdentifier(p, 'scope');
		const extra = pick(p.get<IDataObject>('additionalFields', {}), [
			'isPrivate',
			'groupBy',
			'sortBy',
			'sortDirection',
			'filters',
			'columns',
		]);

		return {
			method: 'POST',
			path: '/mp/api/v1/views/lite',
			body: {
				scope,
				scopeIdentifier: id,
				name: p.get<string>('name'),
				type: p.get<string>('type'),
				...withJson(extra, { filters: 'array', columns: 'array' }),
			},
		};
	},
};

const operations: OperationDef[] = [
	listOp,
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a view',
		description: 'Fetch a view by its identifier',
		fields: viewFields(),
		build: (p) => ({ method: 'GET', path: viewPath(p) }),
	},
	createOp,
	{
		operation: 'update',
		name: 'Update',
		action: 'Update a view',
		description: 'Rename a view or change its privacy, grouping, sorting, filters or columns',
		fields: [
			...viewFields(),
			collection('Update Fields', 'updateFields', [
				text('Name', 'name', 'New view name (up to 100 characters)'),
				isPrivate,
				groupBy(' Set it to a blank value to clear grouping'),
				sortBy(' Set it to a blank value to clear sorting'),
				sortDirection,
				filtersField('to replace the current ones (an empty array clears all filters)'),
				columnsField(),
			]),
		],
		build: (p) => {
			const body = pick(
				p.get<IDataObject>('updateFields', {}),
				['name', 'isPrivate', 'groupBy', 'sortBy', 'sortDirection', 'filters', 'columns'],
				['groupBy', 'sortBy'],
			);

			return {
				method: 'PUT',
				path: viewPath(p),
				body: requireChange(withJson(body, { filters: 'array', columns: 'array' })),
			};
		},
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a view',
		description: 'Delete a view. Mandatory views cannot be deleted',
		fields: viewFields(),
		build: (p) => ({ method: 'DELETE', path: viewPath(p) }),
	},
	{
		operation: 'clone',
		name: 'Clone',
		action: 'Clone a view',
		description:
			'Copy a view, with its grouping, sorting, filters, widgets and columns, into another scope',
		fields: [
			...viewFields(),
			...scopeFields('target', 'Target Scope', 'Where to put the copy'),
			collection('Additional Fields', 'additionalFields', [
				text('Name', 'name', 'Name of the copy. Defaults to the source name followed by (copy)'),
			]),
		],
		build: (p) => {
			const { scope, id } = scopeIdentifier(p, 'target');

			return {
				method: 'POST',
				path: `${viewPath(p)}/clone`,
				body: {
					scope,
					scopeIdentifier: id,
					...pick(p.get<IDataObject>('additionalFields', {}), ['name']),
				},
			};
		},
	},
	{
		operation: 'listWidgets',
		name: 'Get Many Widgets',
		action: 'Get many widgets of a dashboard',
		description: 'List the widgets on a view, in order. Views other than dashboards have none',
		fields: viewFields(),
		build: (p) => ({ method: 'GET', path: widgetsPath(p) }),
	},
	{
		operation: 'addWidget',
		name: 'Add Widget',
		action: 'Add a widget to a dashboard',
		description: 'Append a widget to a dashboard view',
		fields: [
			...viewFields(),
			{
				displayName: 'Widget Type',
				name: 'widgetType',
				type: 'options',
				options: WIDGET_TYPES.map((value) => ({ name: value, value })),
				default: 'distribution-chart',
				required: true,
				description:
					'Which kind of widget to render. Some types need a paid plan. This list may be incomplete: an expression can supply any widget type the server accepts',
			},
			collection('Additional Fields', 'additionalFields', widgetLayout()),
		],
		build: (p) => ({
			method: 'POST',
			path: widgetsPath(p),
			body: widgetBody(p.get<string>('widgetType'), p.get<IDataObject>('additionalFields', {})),
		}),
	},
	{
		operation: 'addWidgetFromPreset',
		name: 'Add Widget From Preset',
		action: 'Add a widget to a dashboard from a preset',
		description: 'Append a ready-made widget to a dashboard view',
		fields: [
			...viewFields(),
			{
				displayName: 'Preset',
				name: 'preset',
				type: 'options',
				options: [
					{ name: 'Activity Feed', value: 'activity-feed' },
					{ name: 'Assignee Workload', value: 'assignee-workload' },
					{ name: 'Completion Trend', value: 'completion-trend' },
					{ name: 'Overdue Tracker', value: 'overdue-tracker' },
					{ name: 'Priority Distribution', value: 'priority-distribution' },
					{ name: 'Status Distribution', value: 'status-distribution' },
				],
				default: 'status-distribution',
				required: true,
				description: 'The ready-made widget to add',
			},
			collection('Additional Fields', 'additionalFields', [
				text('Title', 'title', 'Title to use instead of the preset default (up to 200 characters)'),
			]),
		],
		build: (p) => ({
			method: 'POST',
			path: `${widgetsPath(p)}/preset`,
			body: {
				preset: p.get<string>('preset'),
				...pick(p.get<IDataObject>('additionalFields', {}), ['title']),
			},
		}),
	},
	{
		operation: 'updateWidget',
		name: 'Update Widget',
		action: 'Update a widget on a dashboard',
		description: 'Change a widget title, position, size or data settings',
		fields: [
			...viewFields(),
			widgetPicker,
			collection('Update Fields', 'updateFields', [
				{
					displayName: 'Widget Type',
					name: 'type',
					type: 'options',
					options: WIDGET_TYPES.map((value) => ({ name: value, value })),
					default: 'distribution-chart',
					description:
						'Change the kind of widget. This list may be incomplete: an expression can supply any widget type the server accepts.',
				},
				...widgetLayout(),
			]),
		],
		build: (p) => {
			const fields = p.get<IDataObject>('updateFields', {});

			return {
				method: 'PUT',
				path: `${widgetsPath(p)}/${encodeURIComponent(p.get<string>('widget'))}`,
				body: requireChange(
					widgetBody(isSet(fields.type) ? String(fields.type) : undefined, fields),
				),
			};
		},
	},
	{
		operation: 'removeWidget',
		name: 'Remove Widget',
		action: 'Remove a widget from a dashboard',
		description: 'Remove a widget from a dashboard view. The other widgets keep their position',
		fields: [...viewFields(), widgetPicker],
		build: (p) => ({
			method: 'DELETE',
			path: `${widgetsPath(p)}/${encodeURIComponent(p.get<string>('widget'))}`,
		}),
	},
];

/** Views and their dashboard widgets (PM "Views (Lite)"). */
export const view: ResourceDef = {
	value: 'view',
	name: 'View',
	workspaceScoped: true,
	operations,
};
