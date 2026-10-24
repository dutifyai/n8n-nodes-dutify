import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { view } from '../../../nodes/Dutify/resources/view';
import type { OperationDef, PaginationStyle } from '../../../shared/types';
import { reader } from '../helpers';

const CURSOR_200: PaginationStyle = {
	kind: 'cursor',
	cursorParam: 'cursor',
	limitParam: 'limit',
	itemsPath: 'items',
	nextCursorPath: 'nextCursor',
	maxPageSize: 200,
};

function op(name: string): OperationDef {
	const found = view.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${name}`);
	}

	return found;
}

const build = (name: string, params: Record<string, unknown>, ws = 'ws-1') =>
	op(name).build!(reader(params, ws));

const methodOf = (operation: string, field: string) =>
	(
		op(operation).fields.find((f) => f.name === field)?.typeOptions as
			| { loadOptionsMethod?: string }
			| undefined
	)?.loadOptionsMethod;

describe('view registration', () => {
	it('is registered as "view" with every view and widget operation', () => {
		expect(resources).toContain(view);
		expect(view.value).toBe('view');
		expect(view.workspaceScoped).toBe(true);
		expect(view.operations.map((o) => o.operation)).toEqual([
			'list',
			'get',
			'create',
			'update',
			'delete',
			'clone',
			'listWidgets',
			'addWidget',
			'addWidgetFromPreset',
			'updateWidget',
			'removeWidget',
		]);
	});
});

describe('view', () => {
	it('list: GET views/lite for a list scope, cursor pagination (max 200)', () => {
		expect(build('list', { scope: 'list', scopeListId: 'lst_abc' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/views/lite',
			qs: { scope: 'list', scopeIdentifier: 'lst_abc' },
			paginate: CURSOR_200,
		});
		expect(op('list').list).toBe(true);
	});

	it.each([
		['space', { scopeSpaceId: 'sp_abc' }, 'sp_abc'],
		['folder', { scopeFolderId: 'fld_abc' }, 'fld_abc'],
	] as const)('list: %s scope uses its own picker value', (scope, ids, expected) => {
		expect(build('list', { scope, ...ids }).qs).toEqual({ scope, scopeIdentifier: expected });
	});

	it('list: workspace scope sends the selected workspace as scopeIdentifier (blank is rejected)', () => {
		expect(build('list', { scope: 'workspace' }, 'ws_77').qs).toEqual({
			scope: 'workspace',
			scopeIdentifier: 'ws_77',
		});
	});

	it('get: GET views/lite/{identifier}, identifier encoded', () => {
		expect(build('get', { scope: 'list', scopeListId: 'l', view: 'rv_abc' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/views/lite/rv_abc',
		});
		expect(build('get', { scope: 'list', scopeListId: 'l', view: 'a/b' }).path).toBe(
			'/mp/api/v1/views/lite/a%2Fb',
		);
	});

	it('create: scope level and target go in the body where the catalog expects them', () => {
		expect(
			build('create', {
				scope: 'list',
				scopeListId: 'lst_abc',
				name: 'Sprint Board',
				type: 'board',
				additionalFields: {},
			}),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/views/lite',
			body: { scope: 'list', scopeIdentifier: 'lst_abc', name: 'Sprint Board', type: 'board' },
		});
	});

	it('create: workspace scope uses the selected workspace as scopeIdentifier', () => {
		expect(
			build(
				'create',
				{ scope: 'workspace', name: 'Overview', type: 'dashboard', additionalFields: {} },
				'ws_77',
			).body,
		).toEqual({
			scope: 'workspace',
			scopeIdentifier: 'ws_77',
			name: 'Overview',
			type: 'dashboard',
		});
	});

	it('create: scope is a workspace/space/folder/list options field', () => {
		const scope = op('create').fields.find((f) => f.name === 'scope');
		expect(scope?.type).toBe('options');
		expect((scope?.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
			'workspace',
			'space',
			'folder',
			'list',
		]);
	});

	it('create: optional fields map to the catalog body names; filters and columns accept JSON text', () => {
		const filters = [
			{ precedingLogic: 'AND', filters: [{ field: 'status', operator: 'equals', value: 'Open' }] },
		];
		const columns = [{ columnIdentifier: 'status', isMandatory: true }];
		expect(
			build('create', {
				scope: 'space',
				scopeSpaceId: 'sp_abc',
				name: 'Board',
				type: 'dashboard',
				additionalFields: {
					isPrivate: false,
					groupBy: 'status',
					sortBy: 'dueDate',
					sortDirection: 'asc',
					filters: JSON.stringify(filters),
					columns,
				},
			}).body,
		).toEqual({
			scope: 'space',
			scopeIdentifier: 'sp_abc',
			name: 'Board',
			type: 'dashboard',
			isPrivate: false,
			groupBy: 'status',
			sortBy: 'dueDate',
			sortDirection: 'asc',
			filters,
			columns,
		});
	});

	it('create: rejects filters that are not a JSON array', () => {
		expect(() =>
			build('create', {
				scope: 'list',
				scopeListId: 'l',
				name: 'x',
				type: 'list',
				additionalFields: { filters: '{"a":1}' },
			}),
		).toThrow(/filters/i);
	});

	it('update: PUT only the fields that are set; empty groupBy is kept because it clears the setting', () => {
		expect(
			build('update', {
				scope: 'list',
				scopeListId: 'l',
				view: 'rv_abc',
				updateFields: {
					name: 'Renamed View',
					isPrivate: false,
					groupBy: '',
					sortDirection: 'desc',
				},
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/views/lite/rv_abc',
			body: { name: 'Renamed View', isPrivate: false, groupBy: '', sortDirection: 'desc' },
		});
	});

	it('update: with no fields set throws before any request', () => {
		expect(() =>
			build('update', { scope: 'list', scopeListId: 'l', view: 'rv_abc', updateFields: {} }),
		).toThrow(/at least one/i);
	});

	it('delete: DELETE views/lite/{identifier}', () => {
		expect(build('delete', { scope: 'list', scopeListId: 'l', view: 'rv_abc' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/views/lite/rv_abc',
		});
	});

	it('clone: POST .../clone with the target scope in the body', () => {
		expect(
			build('clone', {
				scope: 'list',
				scopeListId: 'l',
				view: 'rv_abc',
				targetScope: 'space',
				targetSpaceId: 'sp_abc',
				additionalFields: { name: 'Sprint Board - Mobile' },
			}),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/views/lite/rv_abc/clone',
			body: { scope: 'space', scopeIdentifier: 'sp_abc', name: 'Sprint Board - Mobile' },
		});
		expect(
			build(
				'clone',
				{
					scope: 'list',
					scopeListId: 'l',
					view: 'rv_abc',
					targetScope: 'workspace',
					additionalFields: {},
				},
				'ws_77',
			).body,
		).toEqual({ scope: 'workspace', scopeIdentifier: 'ws_77' });
	});
});

describe('dashboard widgets', () => {
	const viewParams = { scope: 'list', scopeListId: 'l', view: 'rv_abc' };

	it('widget type options include metric-card and task-list, and say the list may be incomplete', () => {
		const field = op('addWidget').fields.find((f) => f.name === 'widgetType');
		const values = (field?.options as Array<{ value: string }>).map((o) => o.value);
		expect(values).toEqual(expect.arrayContaining(['metric-card', 'task-list']));
		expect(field?.description).toMatch(/incomplete/i);
		expect(field?.description).toMatch(/expression/i);
		const update = op('updateWidget').fields.find((f) => f.name === 'updateFields');
		const typeOption = (
			update?.options as Array<{ name: string; options?: Array<{ value: string }> }>
		).find((o) => o.name === 'type');
		expect(typeOption?.options?.map((o) => o.value)).toEqual(
			expect.arrayContaining(['metric-card']),
		);
	});

	it('listWidgets: GET views/lite/{viewId}/widgets (a plain array, no paging)', () => {
		expect(build('listWidgets', viewParams)).toEqual({
			method: 'GET',
			path: '/mp/api/v1/views/lite/rv_abc/widgets',
		});
		expect(op('listWidgets').list).toBeFalsy();
	});

	it('addWidget: POST a WidgetConfig; type is required, layout and config optional', () => {
		expect(
			build('addWidget', {
				...viewParams,
				widgetType: 'distribution-chart',
				additionalFields: {
					title: 'Tasks by Status',
					x: 0,
					y: 0,
					w: 6,
					h: 4,
					minW: 3,
					minH: 2,
					config: '{"metric":"count","groupByField":"status","chartType":"bar"}',
				},
			}),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/views/lite/rv_abc/widgets',
			body: {
				type: 'distribution-chart',
				title: 'Tasks by Status',
				x: 0,
				y: 0,
				w: 6,
				h: 4,
				minW: 3,
				minH: 2,
				config: { metric: 'count', groupByField: 'status', chartType: 'bar' },
			},
		});
	});

	it('addWidget: omitted position stays omitted so the server places the widget; x=0 is kept', () => {
		expect(
			build('addWidget', { ...viewParams, widgetType: 'workload', additionalFields: { x: 0 } })
				.body,
		).toEqual({ type: 'workload', x: 0 });
	});

	it('addWidget: config must be a JSON object', () => {
		expect(() =>
			build('addWidget', {
				...viewParams,
				widgetType: 'workload',
				additionalFields: { config: '[1]' },
			}),
		).toThrow(/config/i);
	});

	it('addWidgetFromPreset: POST .../widgets/preset with the preset and optional title', () => {
		expect(
			build('addWidgetFromPreset', {
				...viewParams,
				preset: 'status-distribution',
				additionalFields: { title: 'Tasks by Status' },
			}),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/views/lite/rv_abc/widgets/preset',
			body: { preset: 'status-distribution', title: 'Tasks by Status' },
		});
		expect(
			build('addWidgetFromPreset', {
				...viewParams,
				preset: 'activity-feed',
				additionalFields: {},
			}).body,
		).toEqual({ preset: 'activity-feed' });
	});

	it('addWidgetFromPreset: offers exactly the six presets from the catalog', () => {
		const preset = op('addWidgetFromPreset').fields.find((f) => f.name === 'preset');
		expect((preset?.options as Array<{ value: string }>).map((o) => o.value).sort()).toEqual(
			[
				'status-distribution',
				'priority-distribution',
				'assignee-workload',
				'overdue-tracker',
				'activity-feed',
				'completion-trend',
			].sort(),
		);
	});

	it('updateWidget: PUT .../widgets/{widgetId} with only the fields set', () => {
		expect(
			build('updateWidget', {
				...viewParams,
				widget: 'widget_abc123',
				updateFields: { title: 'Renamed', w: 8, config: { limit: 10 } },
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/views/lite/rv_abc/widgets/widget_abc123',
			body: { title: 'Renamed', w: 8, config: { limit: 10 } },
		});
	});

	it('updateWidget: with no fields set throws before any request', () => {
		expect(() =>
			build('updateWidget', { ...viewParams, widget: 'widget_abc123', updateFields: {} }),
		).toThrow(/at least one/i);
	});

	it('removeWidget: DELETE .../widgets/{widgetId}', () => {
		expect(build('removeWidget', { ...viewParams, widget: 'widget_abc123' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/views/lite/rv_abc/widgets/widget_abc123',
		});
	});
});

describe('identifier pickers', () => {
	it('scope targets use the identifier pickers', () => {
		expect(methodOf('list', 'scopeSpaceId')).toBe('getSpaceIds');
		expect(methodOf('list', 'scopeFolderId')).toBe('getFolderIds');
		expect(methodOf('list', 'scopeListId')).toBe('getListIds');
		expect(methodOf('create', 'scopeListId')).toBe('getListIds');
		expect(methodOf('clone', 'targetSpaceId')).toBe('getSpaceIds');
		expect(methodOf('clone', 'targetFolderId')).toBe('getFolderIds');
		expect(methodOf('clone', 'targetListId')).toBe('getListIds');
	});

	it.each([
		'get',
		'update',
		'delete',
		'clone',
		'listWidgets',
		'addWidget',
		'addWidgetFromPreset',
		'updateWidget',
		'removeWidget',
	])('%s: the view is picked, not typed', (operation) => {
		expect(methodOf(operation, 'view')).toBe('getViews');
	});

	it.each(['updateWidget', 'removeWidget'])(
		'%s: the widget is picked from the view',
		(operation) => {
			expect(methodOf(operation, 'widget')).toBe('getWidgets');
		},
	);

	it('target pickers only show for their scope', () => {
		const field = op('list').fields.find((f) => f.name === 'scopeListId');
		expect(field?.displayOptions?.show).toEqual({ scope: ['list'] });
	});
});
