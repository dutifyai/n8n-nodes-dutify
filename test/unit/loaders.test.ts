import type { RequestSpec } from '../../shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
	boardOptions,
	customFieldIdOptions,
	folderIdOptions,
	listIdOptions,
	spaceIdOptions,
	contextSpec,
	getWorkspaceOptions,
	listOptions,
	memberOptions,
	spaceOptions,
	statusOptions,
	taskTypeOptions,
	wikiSpaceOptions,
	wikiSpacesSpec,
	boardsSpec,
	viewOptions,
	sprintGroupOptions,
	sprintGroupsSpec,
	sprintOptions,
	viewsSpec,
	teamOptions,
	teamsSpec,
	workspaceUserOptions,
	workspaceUsersSpec,
	invitationOptions,
	invitationsSpec,
	accessLevelOptions,
	accessLevelsSpec,
	importJobOptions,
	importJobsSpec,
	widgetOptions,
	widgetsSpec,
} from '../../nodes/Dutify/loaders';

function fetchFrom(routes: Record<string, unknown>) {
	return vi.fn(async (spec: RequestSpec) => {
		const key = `${spec.method} ${spec.path}`;
		if (!(key in routes)) {
			throw new Error(`unexpected request ${key}`);
		}

		return routes[key];
	});
}

describe('getWorkspaceOptions', () => {
	it('personal key: introspects the key, then lists its workspaces as {name, value: identifier}', async () => {
		const fetch = fetchFrom({
			'GET /mp/api/v1/api-keys/current': { keyType: 'PERSONAL', keyIdentifier: 'key_1' },
			'GET /mp/api/v1/personal-api-keys/workspaces': [
				{ identifier: 'ws_a', name: 'Acme', id: 'u', suiteAccess: true, hubAccess: false },
				{ identifier: 'ws_b', name: 'Beta', id: 'u', suiteAccess: true, hubAccess: false },
				{ identifier: 'ws_hub', name: 'Hub only', id: 'u', suiteAccess: false, hubAccess: false },
			],
		});
		const options = await getWorkspaceOptions(fetch);
		expect(fetch.mock.calls.map(([s]) => s.path)).toEqual([
			'/mp/api/v1/api-keys/current',
			'/mp/api/v1/personal-api-keys/workspaces',
		]);
		expect(options).toEqual([
			{ name: 'Acme', value: 'ws_a' },
			{ name: 'Beta', value: 'ws_b' },
		]);
	});

	it('workspace-bound key: never calls the personal-keys endpoint and returns the bound workspace', async () => {
		const fetch = fetchFrom({
			'GET /mp/api/v1/api-keys/current': {
				keyType: 'WORKSPACE',
				workspaceIdentifier: 'ws_xyz',
				workspaceName: 'Acme Corp',
			},
		});
		const options = await getWorkspaceOptions(fetch);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(options).toEqual([{ name: 'Acme Corp', value: 'ws_xyz' }]);
	});

	it('filters by the search text, case-insensitively, on name and identifier', async () => {
		const fetch = fetchFrom({
			'GET /mp/api/v1/api-keys/current': { keyType: 'PERSONAL' },
			'GET /mp/api/v1/personal-api-keys/workspaces': [
				{ identifier: 'ws_a', name: 'Acme', id: 'u', suiteAccess: true, hubAccess: false },
				{ identifier: 'ws_b', name: 'Beta', id: 'u', suiteAccess: true, hubAccess: false },
			],
		});
		expect(await getWorkspaceOptions(fetch, 'ACM')).toEqual([{ name: 'Acme', value: 'ws_a' }]);
	});
});

const context = {
	identifier: 'ws_abc',
	name: 'Acme',
	members: [
		{ email: 'alice@dutify.ai', fullName: 'Alice A', role: 'Admin' },
		{ email: 'bob@dutify.ai', fullName: null, role: 'Member' },
	],
	taskTypes: ['Bug', 'Story'],
	spaces: [
		{
			identifier: 'sp_eng',
			name: 'Engineering',
			lists: [{ identifier: 'lst_backlog', name: 'Backlog', statuses: ['Open', 'Done'] }],
			folders: [
				{
					identifier: 'fld_q2',
					name: 'Q2',
					lists: [{ identifier: 'lst_sprint', name: 'Sprint', statuses: ['To Do', 'Doing'] }],
				},
			],
		},
		{ identifier: 'sp_ops', name: 'Ops', lists: [], folders: [] },
	],
};

describe('workspace context loaders', () => {
	it('contextSpec builds the lite context request, narrowing by space name', () => {
		expect(contextSpec('ws_abc')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws_abc/lite/context',
			qs: {},
		});
		expect(contextSpec('ws/1', { space: 'Engineering', shallow: false })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws%2F1/lite/context',
			qs: { space: 'Engineering', shallow: false },
		});
	});

	it('spaceOptions uses the space name as value', () => {
		expect(spaceOptions(context)).toEqual([
			{ name: 'Engineering', value: 'Engineering' },
			{ name: 'Ops', value: 'Ops' },
		]);
	});

	it('listOptions flattens top-level and folder lists, optionally for one space', () => {
		expect(listOptions(context)).toEqual([
			{ name: 'Backlog', value: 'Backlog' },
			{ name: 'Sprint (Q2)', value: 'Sprint' },
		]);
		expect(listOptions(context, 'Ops')).toEqual([]);
		expect(listOptions(context, 'Engineering')).toHaveLength(2);
	});

	it('statusOptions returns the statuses of the chosen list', () => {
		expect(statusOptions(context, 'Sprint')).toEqual([
			{ name: 'To Do', value: 'To Do' },
			{ name: 'Doing', value: 'Doing' },
		]);
		expect(statusOptions(context, 'Nope')).toEqual([]);
	});

	it('statusOptions picks the list of the chosen space when two spaces have a list of that name', () => {
		const twoSpaces = {
			spaces: [
				{ name: 'Alpha', lists: [{ name: 'Backlog', statuses: ['A open', 'A done'] }] },
				{
					name: 'Beta',
					lists: [],
					folders: [{ name: 'F', lists: [{ name: 'Backlog', statuses: ['B open'] }] }],
				},
			],
		};
		expect(statusOptions(twoSpaces, 'Backlog', 'Beta')).toEqual([
			{ name: 'B open', value: 'B open' },
		]);
		expect(statusOptions(twoSpaces, 'Backlog', 'Alpha')).toEqual([
			{ name: 'A open', value: 'A open' },
			{ name: 'A done', value: 'A done' },
		]);
		expect(statusOptions(twoSpaces, 'Backlog', 'Gamma')).toEqual([]);
	});

	it('memberOptions uses the email as value (lite endpoints take assignee emails)', () => {
		expect(memberOptions(context)).toEqual([
			{ name: 'Alice A (alice@dutify.ai)', value: 'alice@dutify.ai' },
			{ name: 'bob@dutify.ai', value: 'bob@dutify.ai' },
		]);
	});

	it('taskTypeOptions uses the type name as value', () => {
		expect(taskTypeOptions(context)).toEqual([
			{ name: 'Bug', value: 'Bug' },
			{ name: 'Story', value: 'Story' },
		]);
		expect(taskTypeOptions({})).toEqual([]);
	});
});

describe('wiki spaces and boards loaders', () => {
	it('wikiSpacesSpec / wikiSpaceOptions use the space key', () => {
		expect(wikiSpacesSpec('ws_abc')).toEqual({
			method: 'GET',
			path: '/api/wiki/v1/workspaces/ws_abc/wiki/spaces/lite',
		});
		expect(wikiSpaceOptions([{ key: 'DOCS', name: 'Documentation', pageCount: 4 }])).toEqual([
			{ name: 'Documentation', value: 'DOCS' },
		]);
	});

	it('boardsSpec / boardOptions use the board slug', () => {
		expect(boardsSpec('ws_abc')).toEqual({
			method: 'GET',
			path: '/api/roadmarq/v1/boards/lite',
			qs: { workspaceIdentifier: 'ws_abc' },
		});
		expect(boardOptions([{ slug: 'feedback', name: 'Customer Feedback' }])).toEqual([
			{ name: 'Customer Feedback', value: 'feedback' },
		]);
	});
});

describe('identifier pickers', () => {
	const context = {
		spaces: [
			{
				identifier: 'sp_eng',
				name: 'Engineering',
				lists: [
					{
						identifier: 'lst_backlog',
						name: 'Backlog',
						customFields: [
							{ identifier: 'cf_sev', name: 'Severity', type: 'text' },
							{ identifier: 'cf_ws', name: 'Team', type: 'dropdown' },
						],
					},
				],
				folders: [
					{
						identifier: 'fld_q2',
						name: 'Q2',
						lists: [
							{
								identifier: 'lst_backlog2',
								name: 'Backlog',
								customFields: [{ identifier: 'cf_ws', name: 'Team', type: 'dropdown' }],
							},
						],
					},
				],
			},
			{ identifier: 'sp_ops', name: 'Ops', lists: null, folders: null },
		],
	};

	it('spaces: {name, value: identifier}', () => {
		expect(spaceIdOptions(context)).toEqual([
			{ name: 'Engineering', value: 'sp_eng' },
			{ name: 'Ops', value: 'sp_ops' },
		]);
	});

	it('folders: labelled Space / Folder', () => {
		expect(folderIdOptions(context)).toEqual([{ name: 'Engineering / Q2', value: 'fld_q2' }]);
	});

	it('lists: duplicate names stay distinguishable by their path', () => {
		expect(listIdOptions(context)).toEqual([
			{ name: 'Engineering / Backlog', value: 'lst_backlog' },
			{ name: 'Engineering / Q2 / Backlog', value: 'lst_backlog2' },
		]);
	});

	it('custom fields: one entry per identifier, labelled with type and first location', () => {
		expect(customFieldIdOptions(context)).toEqual([
			{ name: 'Severity (text) - Engineering / Backlog', value: 'cf_sev' },
			{ name: 'Team (dropdown) - Engineering / Backlog (+1 more)', value: 'cf_ws' },
		]);
	});

	it('tolerates an empty context', () => {
		expect(spaceIdOptions({})).toEqual([]);
		expect(customFieldIdOptions({ spaces: null })).toEqual([]);
	});
});

describe('view and widget pickers', () => {
	it('viewsSpec: lists views of the chosen scope, 200 per page', () => {
		expect(viewsSpec('list', 'lst_abc')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/views/lite',
			qs: { scope: 'list', scopeIdentifier: 'lst_abc', limit: 200 },
		});
	});

	it('viewOptions: {name (type), value: identifier}; tolerates a missing page', () => {
		expect(
			viewOptions({
				items: [
					{ identifier: 'rv_1', name: 'Sprint Board', type: 'board' },
					{ identifier: 'rv_2', name: 'Overview', type: 'dashboard' },
					{ name: 'No id' },
				],
			}),
		).toEqual([
			{ name: 'Sprint Board (board)', value: 'rv_1' },
			{ name: 'Overview (dashboard)', value: 'rv_2' },
		]);
		expect(viewOptions(undefined)).toEqual([]);
	});

	it('widgetsSpec + widgetOptions: widgets of a view as {title (type), value: id}', () => {
		expect(widgetsSpec('rv_1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/views/lite/rv_1/widgets',
		});
		expect(
			widgetOptions([
				{ id: 'widget_a', type: 'chart', title: 'Tasks by Status' },
				{ id: 'widget_b', type: 'workload' },
			]),
		).toEqual([
			{ name: 'Tasks by Status (chart)', value: 'widget_a' },
			{ name: 'workload (widget_b)', value: 'widget_b' },
		]);
		expect(widgetOptions(null)).toEqual([]);
	});
});

describe('sprint pickers', () => {
	const groups = [
		{
			identifier: 'sg_1',
			name: 'Frontend Team',
			sprints: [
				{ identifier: 'spr_1', name: 'Sprint 13', status: 'DONE' },
				{ identifier: 'spr_2', name: 'Sprint 14', status: 'IN_PROGRESS' },
			],
		},
		{ identifier: 'sg_2', name: 'Backend', sprints: null },
		{ name: 'No id' },
	];

	it('sprintGroupsSpec: GET spaces/{space}/sprint-groups', () => {
		expect(sprintGroupsSpec('sp_eng')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/spaces/sp_eng/sprint-groups',
		});
	});

	it('sprintGroupOptions: {name, value: identifier}; tolerates a missing list', () => {
		expect(sprintGroupOptions(groups)).toEqual([
			{ name: 'Frontend Team', value: 'sg_1' },
			{ name: 'Backend', value: 'sg_2' },
		]);
		expect(sprintGroupOptions(null)).toEqual([]);
	});

	it('sprintOptions: every sprint of every group as "Group / Sprint (STATUS)"', () => {
		expect(sprintOptions(groups)).toEqual([
			{ name: 'Frontend Team / Sprint 13 (DONE)', value: 'spr_1' },
			{ name: 'Frontend Team / Sprint 14 (IN_PROGRESS)', value: 'spr_2' },
		]);
		expect(sprintOptions(undefined)).toEqual([]);
	});
});

describe('team, member, invitation, access level and import job pickers', () => {
	it('teamOptions: {name, value: identifier}', () => {
		expect(
			teamOptions([
				{ identifier: 'team_1', name: 'Backend Engineers', alias: 'backend' },
				{ name: 'No id' },
			]),
		).toEqual([{ name: 'Backend Engineers (backend)', value: 'team_1' }]);
		expect(teamOptions(null)).toEqual([]);
	});

	it('workspaceUserOptions: user UUIDs labelled with name and e-mail', () => {
		expect(
			workspaceUserOptions([
				{ userUuid: 'u-1', user: { fullName: 'Jane Smith', email: 'jane@example.com' } },
				{ userUuid: 'u-2', user: { email: 'bob@example.com' } },
				{ userUuid: 'u-3' },
				{ user: { email: 'orphan@example.com' } },
			]),
		).toEqual([
			{ name: 'Jane Smith (jane@example.com)', value: 'u-1' },
			{ name: 'bob@example.com', value: 'u-2' },
			{ name: 'u-3', value: 'u-3' },
		]);
		expect(workspaceUserOptions(undefined)).toEqual([]);
	});

	it('workspaceUsersSpec: one page of members at the backend maximum of 100', () => {
		expect(workspaceUsersSpec('ws-1', 2)).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/users',
			qs: { page: 2, size: 100 },
		});
	});

	it('invitationOptions: pending invitations as e-mail, value identifier', () => {
		expect(
			invitationOptions([
				{ identifier: 'inv-1', invitedEmail: 'jane@example.com', status: 'PENDING' },
				{ identifier: 'inv-2' },
			]),
		).toEqual([
			{ name: 'jane@example.com (PENDING)', value: 'inv-1' },
			{ name: 'inv-2', value: 'inv-2' },
		]);
		expect(invitationOptions(null)).toEqual([]);
	});

	it('accessLevelOptions: workspace access levels by name, value id', () => {
		expect(
			accessLevelOptions([
				{ id: 1, name: 'Admin', description: 'Everything' },
				{ id: 2, name: 'Member' },
				{ name: 'No id' },
			]),
		).toEqual([
			{ name: 'Admin', value: 1, description: 'Everything' },
			{ name: 'Member', value: 2 },
		]);
	});

	it('importJobOptions: file name, source and status, value identifier', () => {
		expect(
			importJobOptions([
				{ identifier: 'imp_1', fileName: 'tasks.csv', source: 'CSV', status: 'PREVIEW' },
				{ identifier: 'imp_2', source: 'JIRA', status: 'COMPLETED' },
			]),
		).toEqual([
			{ name: 'tasks.csv (PREVIEW)', value: 'imp_1' },
			{ name: 'JIRA import imp_2 (COMPLETED)', value: 'imp_2' },
		]);
	});

	it('specs: teams, invitations, access levels and import jobs', () => {
		expect(teamsSpec('ws-1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/teams',
			qs: { size: 100 },
		});
		expect(invitationsSpec('ws-1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/invitations',
		});
		expect(accessLevelsSpec('ws-1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/access-levels',
		});
		expect(importJobsSpec('ws-1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/import',
			qs: { pageSize: 100 },
		});
	});
});
