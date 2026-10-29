import { NodeApiError } from 'n8n-workflow';
import type { IHttpRequestOptions, ILoadOptionsFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { listSearch, loadOptions } from '../../nodes/Dutify/loaders';
import { PM_EVENT_OPTIONS } from '../../shared/pmEvents';

/*
 * The n8n side of every picker: which request it sends (method, path, query, workspace header),
 * how it pages, what it shows (name and value), what it does without its parent field, and how
 * it handles Dutify's refusals. Contracts: https://dutify.ai/mp/api/v1/api-catalog (Dutify Cloud,
 * Codexum, Roadmarq) and https://dutify.ai/api/v1/api-catalog (Dutify Hub).
 */

const BASE = 'https://dutify.test';

type Answer = unknown | ((options: IHttpRequestOptions) => unknown);

interface Picker {
	ctx: ILoadOptionsFunctions;
	requests: IHttpRequestOptions[];
	/** `METHOD /path` of every request, in order. */
	sent: () => string[];
}

/**
 * A load-options context over `params`. Each request is answered from `routes` by
 * `METHOD /path`; an answer that is an Error is thrown, a function is called with the options.
 * `strict` makes a missing parameter throw, as n8n does for a field the operation does not have.
 */
function picker(
	params: Record<string, unknown>,
	routes: Record<string, Answer> = {},
	strict = false,
): Picker {
	const requests: IHttpRequestOptions[] = [];
	const ctx = {
		getNodeParameter: (name: string, fallback?: unknown) => {
			if (Object.prototype.hasOwnProperty.call(params, name)) {
				return params[name];
			}
			if (strict) {
				throw new Error(`Could not get parameter "${name}"`);
			}

			return fallback;
		},
		getCredentials: async () => ({ apiKey: 'dk_live_x', baseUrl: BASE }),
		getNode: () => ({ name: 'Dutify', type: '@dutifyai/n8n-nodes-dutify.dutify', typeVersion: 1 }),
		helpers: {
			httpRequestWithAuthentication: async (_cred: string, options: IHttpRequestOptions) => {
				requests.push(options);
				const key = `${options.method} ${String(options.url).replace(BASE, '')}`;
				if (!Object.prototype.hasOwnProperty.call(routes, key)) {
					throw new Error(`unexpected request ${key}`);
				}
				const route = routes[key];
				const answer = typeof route === 'function' ? route(options) : route;
				if (answer instanceof Error) {
					throw answer;
				}

				return answer;
			},
		},
	} as unknown as ILoadOptionsFunctions;

	return {
		ctx,
		requests,
		sent: () => requests.map((r) => `${r.method} ${String(r.url).replace(BASE, '')}`),
	};
}

const refusal = (httpCode: string, message: string) =>
	Object.assign(new Error(message), { httpCode, statusCode: Number(httpCode) });

const WS = { workspace: 'ws-1' };

/* ---------- workspaces ---------- */

describe('searchWorkspaces', () => {
	it('lists the workspaces of a personal key, filtered by name or identifier, without a workspace header', async () => {
		const p = picker(
			{},
			{
				'GET /mp/api/v1/api-keys/current': { keyType: 'PERSONAL' },
				'GET /mp/api/v1/personal-api-keys/workspaces': [
					{ identifier: 'ws_a', name: 'Acme', suiteAccess: true },
					{ identifier: 'ws_b', name: 'Beta', suiteAccess: true },
				],
			},
		);
		expect(await listSearch.searchWorkspaces.call(p.ctx, 'acm')).toEqual({
			results: [{ name: 'Acme', value: 'ws_a' }],
		});
		expect(p.sent()).toEqual([
			'GET /mp/api/v1/api-keys/current',
			'GET /mp/api/v1/personal-api-keys/workspaces',
		]);
		for (const request of p.requests) {
			expect(request.headers).not.toHaveProperty('X-Dutify-Workspace');
		}
	});

	it('shows the one workspace of a workspace key, and every workspace without a filter', async () => {
		const p = picker(
			{},
			{
				'GET /mp/api/v1/api-keys/current': {
					keyType: 'WORKSPACE',
					workspaceIdentifier: 'ws_a',
					workspaceName: 'Acme',
				},
			},
		);
		expect(await listSearch.searchWorkspaces.call(p.ctx)).toEqual({
			results: [{ name: 'Acme', value: 'ws_a' }],
		});
		expect(p.sent()).toEqual(['GET /mp/api/v1/api-keys/current']);
	});
});

/* ---------- workspace context ---------- */

const CONTEXT_PATH = 'GET /mp/api/v1/workspaces/ws-1/lite/context';
const context = {
	members: [{ email: 'ann@x.test', fullName: 'Ann Lee' }, { email: 'bob@x.test' }],
	taskTypes: ['Bug', 'Story'],
	spaces: [
		{
			name: 'Eng',
			identifier: 'spc_1',
			lists: [
				{
					name: 'Backlog',
					identifier: 'lst_1',
					statuses: ['Open', 'Done'],
					customFields: [{ identifier: 'cf_1', name: 'Points', type: 'NUMBER' }],
				},
			],
			folders: [
				{
					name: 'Q4',
					identifier: 'fld_1',
					lists: [
						{
							name: 'Sprint',
							identifier: 'lst_2',
							statuses: ['Todo'],
							customFields: [{ identifier: 'cf_1', name: 'Points', type: 'NUMBER' }],
						},
					],
					folders: [{ name: 'Week 1', identifier: 'fld_2', lists: [] }],
				},
			],
		},
		{ name: 'Ops', identifier: 'spc_2', lists: [{ name: 'Backlog', identifier: 'lst_3' }] },
	],
};

describe('workspace context pickers', () => {
	const run = async (method: string, params: Record<string, unknown> = {}) => {
		const p = picker({ ...WS, ...params }, { [CONTEXT_PATH]: context });
		const options = await loadOptions[method].call(p.ctx);

		return { options, p };
	};

	it('getSpaces reads the context with the workspace header and shows the space names', async () => {
		const { options, p } = await run('getSpaces');
		expect(options).toEqual([
			{ name: 'Eng', value: 'Eng' },
			{ name: 'Ops', value: 'Ops' },
		]);
		expect(p.sent()).toEqual([CONTEXT_PATH]);
		expect(p.requests[0].headers).toMatchObject({ 'X-Dutify-Workspace': 'ws-1' });
		expect(p.requests[0].qs).toBeUndefined();
	});

	it('getLists narrows the context to the chosen space, folder lists labelled by folder', async () => {
		const { options, p } = await run('getLists', { space: 'Eng' });
		expect(options).toEqual([
			{ name: 'Backlog', value: 'Backlog' },
			{ name: 'Sprint (Q4)', value: 'Sprint' },
		]);
		expect(p.requests[0].qs).toEqual({ space: 'Eng' });
	});

	it('getLists without a space lists every space, and sends no space', async () => {
		const { options, p } = await run('getLists');
		expect(options.map((o) => o.name)).toEqual(['Backlog', 'Sprint (Q4)', 'Backlog']);
		expect(p.requests[0].qs).toBeUndefined();
	});

	it('getSpaceIds, getFolderIds and getListIds read the shallow context and are valued by identifier', async () => {
		const spaces = await run('getSpaceIds');
		expect(spaces.options).toEqual([
			{ name: 'Eng', value: 'spc_1' },
			{ name: 'Ops', value: 'spc_2' },
		]);
		expect(spaces.p.requests[0].qs).toEqual({ shallow: true });

		const folders = await run('getFolderIds');
		expect(folders.options).toEqual([
			{ name: 'Eng / Q4', value: 'fld_1' },
			{ name: 'Eng / Q4 / Week 1', value: 'fld_2' },
		]);
		expect(folders.p.requests[0].qs).toEqual({ shallow: true });

		const lists = await run('getListIds');
		expect(lists.options).toEqual([
			{ name: 'Eng / Backlog', value: 'lst_1' },
			{ name: 'Eng / Q4 / Sprint', value: 'lst_2' },
			{ name: 'Ops / Backlog', value: 'lst_3' },
		]);
		expect(lists.p.requests[0].qs).toEqual({ shallow: true });
	});

	it('getCustomFieldIds skips task types, relationship types and tags, one option per field', async () => {
		const { options, p } = await run('getCustomFieldIds');
		expect(options).toEqual([{ name: 'Points (NUMBER) - Eng / Backlog (+1 more)', value: 'cf_1' }]);
		expect(p.requests[0].qs).toEqual({
			includeTaskTypes: false,
			includeRelationshipTypes: false,
			includeTags: false,
		});
	});

	it('getStatuses shows the statuses of the chosen list, also a folder list', async () => {
		const backlog = await run('getStatuses', { space: 'Eng', list: 'Backlog' });
		expect(backlog.options).toEqual([
			{ name: 'Open', value: 'Open' },
			{ name: 'Done', value: 'Done' },
		]);
		expect(backlog.p.requests[0].qs).toEqual({ space: 'Eng' });
		expect((await run('getStatuses', { list: 'Sprint' })).options).toEqual([
			{ name: 'Todo', value: 'Todo' },
		]);
		expect((await run('getStatuses', { list: 'Nope' })).options).toEqual([]);
	});

	it('getStatuses waits for a list, also when the operation has no list field', async () => {
		const p = picker(WS, {}, true);
		expect(await loadOptions.getStatuses.call(p.ctx)).toEqual([]);
		expect(p.requests).toEqual([]);
	});

	it('getMembers is valued by e-mail and named with the full name; getTaskTypes by name', async () => {
		expect((await run('getMembers')).options).toEqual([
			{ name: 'Ann Lee (ann@x.test)', value: 'ann@x.test' },
			{ name: 'bob@x.test', value: 'bob@x.test' },
		]);
		expect((await run('getTaskTypes')).options).toEqual([
			{ name: 'Bug', value: 'Bug' },
			{ name: 'Story', value: 'Story' },
		]);
	});

	it.each([
		'getSpaces',
		'getLists',
		'getSpaceIds',
		'getFolderIds',
		'getListIds',
		'getCustomFieldIds',
		'getMembers',
		'getTaskTypes',
	])('%s shows nothing, without a request, until a workspace is chosen', async (method) => {
		const p = picker({ workspace: '' });
		expect(await loadOptions[method].call(p.ctx)).toEqual([]);
		expect(p.requests).toEqual([]);
	});

	it('an empty context gives empty pickers', async () => {
		const p = picker(WS, { [CONTEXT_PATH]: {} });
		for (const method of ['getSpaces', 'getListIds', 'getMembers', 'getTaskTypes']) {
			expect(await loadOptions[method].call(p.ctx)).toEqual([]);
		}
	});

	it('a refused context reaches the user as a node error', async () => {
		const p = picker(WS, { [CONTEXT_PATH]: refusal('500', 'Internal error') });
		await expect(loadOptions.getSpaces.call(p.ctx)).rejects.toBeInstanceOf(NodeApiError);
	});
});

/* ---------- one request, one list ---------- */

interface Case {
	method: string;
	params: Record<string, unknown>;
	route: string;
	qs?: Record<string, unknown>;
	answer: unknown;
	options: unknown[];
	/** Parameters that leave the picker empty without a request. */
	waits: Array<Record<string, unknown>>;
}

const cases: Case[] = [
	{
		method: 'getViews',
		params: { scope: 'workspace' },
		route: 'GET /mp/api/v1/views/lite',
		qs: { scope: 'workspace', scopeIdentifier: 'ws-1', limit: 200 },
		answer: {
			items: [{ identifier: 'vw_1', name: 'Board', type: 'KANBAN' }, { identifier: 'vw_2' }, {}],
		},
		options: [
			{ name: 'Board (KANBAN)', value: 'vw_1' },
			{ name: 'vw_2', value: 'vw_2' },
		],
		waits: [{}, { scope: 'list' }, { scope: 'list', scopeListId: '' }],
	},
	{
		method: 'getViews',
		params: { scope: 'list', scopeListId: 'lst_1' },
		route: 'GET /mp/api/v1/views/lite',
		qs: { scope: 'list', scopeIdentifier: 'lst_1', limit: 200 },
		answer: { items: [{ identifier: 'vw_3', name: 'Table' }] },
		options: [{ name: 'Table', value: 'vw_3' }],
		waits: [{ scope: 'unknown' }],
	},
	{
		method: 'getWidgets',
		params: { view: 'vw_1' },
		route: 'GET /mp/api/v1/views/lite/vw_1/widgets',
		answer: [{ id: 'w1', type: 'CHART', title: 'Velocity' }, { id: 'w2' }, { title: 'no id' }],
		options: [
			{ name: 'Velocity (CHART)', value: 'w1' },
			{ name: 'widget (w2)', value: 'w2' },
		],
		waits: [{}],
	},
	{
		method: 'getSprintGroups',
		params: { space: 'spc_1' },
		route: 'GET /mp/api/v1/spaces/spc_1/sprint-groups',
		answer: [
			{
				identifier: 'sg_1',
				name: '2026',
				sprints: [
					{ identifier: 'sp_1', name: 'S1', status: 'ACTIVE' },
					{ identifier: 'sp_2', name: 'S2' },
				],
			},
			{ identifier: 'sg_2' },
		],
		options: [
			{ name: '2026', value: 'sg_1' },
			{ name: 'sg_2', value: 'sg_2' },
		],
		waits: [{}],
	},
	{
		method: 'getSprints',
		params: { space: 'spc_1' },
		route: 'GET /mp/api/v1/spaces/spc_1/sprint-groups',
		answer: [
			{
				identifier: 'sg_1',
				name: '2026',
				sprints: [
					{ identifier: 'sp_1', name: 'S1', status: 'ACTIVE' },
					{ identifier: 'sp_2', name: 'S2' },
				],
			},
		],
		options: [
			{ name: '2026 / S1 (ACTIVE)', value: 'sp_1' },
			{ name: '2026 / S2', value: 'sp_2' },
		],
		waits: [{}],
	},
	{
		method: 'getTeams',
		params: {},
		route: 'GET /mp/api/v1/workspaces/ws-1/teams',
		qs: { size: 100 },
		answer: [{ identifier: 'tm_1', name: 'Core', alias: 'core' }, { identifier: 'tm_2' }],
		options: [
			{ name: 'Core (core)', value: 'tm_1' },
			{ name: 'tm_2', value: 'tm_2' },
		],
		waits: [],
	},
	{
		method: 'getInvitations',
		params: {},
		route: 'GET /mp/api/v1/workspaces/ws-1/invitations',
		answer: [{ identifier: 'inv_1', invitedEmail: 'cy@x.test', status: 'PENDING' }],
		options: [{ name: 'cy@x.test (PENDING)', value: 'inv_1' }],
		waits: [],
	},
	{
		method: 'getAccessLevels',
		params: {},
		route: 'GET /mp/api/v1/workspaces/ws-1/access-levels',
		answer: [{ id: 3, name: 'Admin', description: 'Everything' }, { id: 4 }],
		options: [
			{ name: 'Admin', value: 3, description: 'Everything' },
			{ name: '4', value: 4 },
		],
		waits: [],
	},
	{
		method: 'getImportJobs',
		params: {},
		route: 'GET /mp/api/v1/workspaces/ws-1/import',
		qs: { pageSize: 100 },
		answer: [{ identifier: 'imp_1', fileName: 'tasks.csv', status: 'COMPLETED' }],
		options: [{ name: 'tasks.csv (COMPLETED)', value: 'imp_1' }],
		waits: [],
	},
	{
		method: 'getAutomations',
		params: { scope: 'list', list: 'lst_1' },
		route: 'GET /mp/api/v1/automations/list/lst_1',
		qs: { size: 100 },
		answer: [
			{ identifier: 'au_1', name: 'Close done', active: false },
			{ identifier: 'au_2', name: 'Assign' },
		],
		options: [
			{ name: 'Close done (disabled)', value: 'au_1' },
			{ name: 'Assign', value: 'au_2' },
		],
		waits: [{}, { scope: 'workspace', workspace: 'ws-1' }, { scope: 'list' }],
	},
	{
		method: 'getSavedFilters',
		params: { list: 'lst_1' },
		route: 'GET /mp/api/v1/lists/lst_1/filters',
		answer: [{ id: 5, name: 'Mine' }, { id: 6 }],
		options: [
			{ name: 'Mine', value: '5' },
			{ name: 'Filter 6', value: '6' },
		],
		waits: [{}],
	},
	{
		method: 'getNotifications',
		params: {},
		route: 'GET /mp/api/v1/notifications/workspace/ws-1',
		qs: { unreadOnly: true, size: 100 },
		answer: [{ identifier: 'nt_1', type: 'MENTION', createdAt: '2026-10-01T08:00:00Z' }],
		options: [{ name: 'MENTION (2026-10-01T08:00:00Z)', value: 'nt_1' }],
		waits: [],
	},
	{
		method: 'getPmWebhooks',
		params: {},
		route: 'GET /mp/api/v1/workspaces/ws-1/webhooks',
		answer: [{ identifier: 'wh_1', name: 'CRM', url: 'https://a.test/hook', active: false }],
		options: [{ name: 'CRM (https://a.test/hook) (paused)', value: 'wh_1' }],
		waits: [],
	},
	{
		method: 'getPmWebhookDeliveries',
		params: { webhook: 'wh_1' },
		route: 'GET /mp/api/v1/workspaces/ws-1/webhooks/wh_1/deliveries',
		qs: { size: 100 },
		answer: [
			{
				identifier: 'dl_1',
				eventType: 'task.created',
				status: 'DELIVERED',
				createdAt: '2026-10-03',
			},
			{ identifier: 'dl_2' },
		],
		options: [
			{ name: 'task.created - DELIVERED - 2026-10-03', value: 'dl_1' },
			{ name: 'dl_2', value: 'dl_2' },
		],
		waits: [{}],
	},
	{
		method: 'getWikiSpaces',
		params: {},
		route: 'GET /api/wiki/v1/workspaces/ws-1/wiki/spaces/lite',
		answer: [{ key: 'DOCS', name: 'Docs' }],
		options: [{ name: 'Docs', value: 'DOCS' }],
		waits: [],
	},
	{
		method: 'getWikiAttachments',
		params: { pageId: 'p2' },
		route: 'GET /api/wiki/v1/pages/p2/attachments',
		answer: [
			{ id: 'a1', filename: 'x.png', status: 'pending' },
			{ id: 'a2', filename: 'y.pdf', status: 'confirmed' },
		],
		options: [
			{ name: 'x.png (pending)', value: 'a1' },
			{ name: 'y.pdf', value: 'a2' },
		],
		waits: [{}],
	},
	{
		method: 'getRequestShortIds',
		params: { board: 'roadmap' },
		route: 'GET /api/roadmarq/v1/boards/roadmap/requests/lite',
		qs: { workspaceIdentifier: 'ws-1', page: 0, size: 200 },
		answer: { content: [{ shortId: 'FR-1', title: 'Dark mode' }, { title: 'no id' }] },
		options: [{ name: 'FR-1 - Dark mode', value: 'FR-1' }],
		waits: [{}],
	},
	{
		method: 'getBugShortIds',
		params: { board: 'roadmap' },
		route: 'GET /api/roadmarq/v1/boards/roadmap/bugs/lite',
		qs: { workspaceIdentifier: 'ws-1' },
		answer: [{ shortId: 'BG-1' }],
		options: [{ name: 'BG-1', value: 'BG-1' }],
		waits: [{}],
	},
	{
		method: 'getBoards',
		params: {},
		route: 'GET /api/roadmarq/v1/boards/lite',
		qs: { workspaceIdentifier: 'ws-1' },
		answer: [{ slug: 'roadmap', name: 'Roadmap' }],
		options: [{ name: 'Roadmap', value: 'roadmap' }],
		waits: [],
	},
	{
		method: 'getHubCalls',
		params: {},
		route: 'GET /api/usercall/search',
		// The empty query is left out of the URL; Hub reads a missing query as "every call".
		qs: { view: 'lite', page: 0, size: 100 },
		answer: [
			{
				id: 42,
				call: {
					name: 'Standup',
					startTime: '2026-10-20T09:00:00Z',
					recordings: [{ id: 98, nameShortTranscription: 'part 1' }],
				},
			},
		],
		options: [{ name: 'Standup (2026-10-20)', value: '42' }],
		waits: [],
	},
	{
		method: 'getHubRecordings',
		params: {},
		route: 'GET /api/usercall/search',
		qs: { view: 'lite', page: 0, size: 100 },
		answer: [
			{
				id: 42,
				call: {
					name: 'Standup',
					startTime: '2026-10-20T09:00:00Z',
					recordings: [{ id: 98, nameShortTranscription: 'part 1' }],
				},
			},
		],
		options: [{ name: 'Standup - part 1 (2026-10-20)', value: '98' }],
		waits: [],
	},
	{
		method: 'getCalendarEvents',
		params: {},
		route: 'GET /api/v1/calendar/events',
		answer: [
			{
				eventId: 'e1',
				subject: 'Standup',
				startDateTime: '2026-10-29T09:00:00',
				seriesMasterId: 's1',
			},
		],
		options: [{ name: 'Standup (2026-10-29)', value: 'e1' }],
		waits: [],
	},
	{
		method: 'getCalendarSeries',
		params: {},
		route: 'GET /api/v1/calendar/events',
		answer: [
			{ eventId: 'e1', subject: 'Standup', seriesMasterId: 's1' },
			{ eventId: 'e2', subject: 'Standup', seriesMasterId: 's1' },
			{ eventId: 'e3', subject: 'Once' },
		],
		options: [{ name: 'Standup', value: 's1' }],
		waits: [],
	},
];

describe.each(cases)('$method $params', (c) => {
	it('sends one request with the workspace header and maps it to name and value', async () => {
		const p = picker({ ...WS, ...c.params }, { [c.route]: c.answer });
		expect(await loadOptions[c.method].call(p.ctx)).toEqual(c.options);
		expect(p.sent()).toEqual([c.route]);
		expect(p.requests[0].headers).toMatchObject({ 'X-Dutify-Workspace': 'ws-1' });
		if (c.qs) {
			expect(p.requests[0].qs).toEqual(c.qs);
		}
	});

	it('shows nothing for an empty answer', async () => {
		for (const empty of [null, []]) {
			const p = picker({ ...WS, ...c.params }, { [c.route]: empty });
			expect(await loadOptions[c.method].call(p.ctx)).toEqual([]);
		}
	});

	it('shows nothing, without a request, until its fields are chosen', async () => {
		for (const params of [
			{ ...c.params, workspace: '' },
			...c.waits.map((w) => ({ ...WS, ...w })),
		]) {
			const p = picker(params);
			expect(await loadOptions[c.method].call(p.ctx)).toEqual([]);
			expect(p.requests).toEqual([]);
		}
	});

	it("passes a server error through as a node error with Dutify's message", async () => {
		const p = picker(
			{ ...WS, ...c.params },
			{ [c.route]: refusal('500', 'Something broke on our side') },
		);
		const error = (await loadOptions[c.method]
			.call(p.ctx)
			.catch((e: unknown) => e)) as NodeApiError;
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.httpCode).toBe('500');
	});
});

describe('Hub pickers on a key without the scope', () => {
	it.each(['getHubCalls', 'getHubRecordings', 'getCalendarEvents', 'getCalendarSeries'])(
		'%s answers a 403 with no options, so the field still takes an expression',
		async (method) => {
			const route = method.startsWith('getHub')
				? 'GET /api/usercall/search'
				: 'GET /api/v1/calendar/events';
			const p = picker(WS, { [route]: refusal('403', 'Forbidden') });
			expect(await loadOptions[method].call(p.ctx)).toEqual([]);
			expect(p.requests).toHaveLength(1);
		},
	);

	it('the calendar window is sent as ISO start and end dates', async () => {
		const p = picker(WS, { 'GET /api/v1/calendar/events': [] });
		await loadOptions.getCalendarEvents.call(p.ctx);
		const qs = p.requests[0].qs as { startDate: string; endDate: string };
		const days = (Date.parse(qs.endDate) - Date.parse(qs.startDate)) / 86_400_000;
		expect(days).toBe(67);
	});
});

/* ---------- members: paged ---------- */

describe('getMemberIds', () => {
	const usersPath = 'GET /mp/api/v1/workspaces/ws-1/users';
	const pageOf = (options: IHttpRequestOptions) => (options.qs as { page: number }).page;

	it('reads every page of members, valued by user UUID', async () => {
		const p = picker(WS, {
			[usersPath]: (options: IHttpRequestOptions) =>
				pageOf(options) === 0
					? {
							users: [{ userUuid: 'u1', user: { fullName: 'Ann Lee', email: 'ann@x.test' } }],
							totalPages: 2,
						}
					: {
							users: [{ userUuid: 'u2', user: { email: 'bob@x.test' } }, { userUuid: 'u3' }],
							totalPages: 2,
						},
		});
		expect(await loadOptions.getMemberIds.call(p.ctx)).toEqual([
			{ name: 'Ann Lee (ann@x.test)', value: 'u1' },
			{ name: 'bob@x.test', value: 'u2' },
			{ name: 'u3', value: 'u3' },
		]);
		expect(p.requests.map((r) => r.qs)).toEqual([
			{ page: 0, size: 100 },
			{ page: 1, size: 100 },
		]);
	});

	it('stops after 20 pages, so a huge workspace cannot stall the editor', async () => {
		const p = picker(WS, {
			[usersPath]: (options: IHttpRequestOptions) => ({
				users: [{ userUuid: `u${pageOf(options)}` }],
				totalPages: 500,
			}),
		});
		expect(await loadOptions.getMemberIds.call(p.ctx)).toHaveLength(20);
		expect(p.requests).toHaveLength(20);
	});

	it('an empty answer is one request and no options; no workspace is no request', async () => {
		const empty = picker(WS, { [usersPath]: null });
		expect(await loadOptions.getMemberIds.call(empty.ctx)).toEqual([]);
		expect(empty.requests).toHaveLength(1);
		const none = picker({ workspace: '' });
		expect(await loadOptions.getMemberIds.call(none.ctx)).toEqual([]);
		expect(none.requests).toEqual([]);
	});

	it('a refused page reaches the user as a node error', async () => {
		const p = picker(WS, { [usersPath]: refusal('403', 'Missing scope members:read') });
		await expect(loadOptions.getMemberIds.call(p.ctx)).rejects.toBeInstanceOf(NodeApiError);
	});
});

/* ---------- time entries: task key lookup ---------- */

describe('getTimeEntries', () => {
	const entries = [
		{ id: 9, timeSpent: 30, startedAt: '2026-10-02T10:00:00Z', notes: 'review' },
		{ id: 10 },
	];
	const shown = [
		{ name: '30 min on 2026-10-02 - review', value: '9' },
		{ name: '0 min', value: '10' },
	];

	it('reads the entries of a task ID directly', async () => {
		const p = picker(
			{ ...WS, task: 'tsk_1' },
			{ 'GET /mp/api/v1/tasks/tsk_1/time-entries': entries },
		);
		expect(await loadOptions.getTimeEntries.call(p.ctx)).toEqual(shown);
		expect(p.requests[0].qs).toEqual({ size: 100 });
	});

	it('looks a task key up first, in the selected workspace', async () => {
		const p = picker(
			{ ...WS, task: 'APP-7' },
			{
				'GET /mp/api/v1/tasks/lite/APP-7': { identifier: 'tsk_2' },
				'GET /mp/api/v1/tasks/tsk_2/time-entries': entries,
			},
		);
		expect(await loadOptions.getTimeEntries.call(p.ctx)).toEqual(shown);
		expect(p.sent()).toEqual([
			'GET /mp/api/v1/tasks/lite/APP-7',
			'GET /mp/api/v1/tasks/tsk_2/time-entries',
		]);
		expect(p.requests[0].qs).toEqual({ workspace: 'ws-1' });
	});

	it('a half-typed or unknown task key shows no entries', async () => {
		const unknown = picker(
			{ ...WS, task: 'APP-' },
			{ 'GET /mp/api/v1/tasks/lite/APP-': refusal('404', 'Not found') },
		);
		expect(await loadOptions.getTimeEntries.call(unknown.ctx)).toEqual([]);
		const noId = picker({ ...WS, task: 'APP-8' }, { 'GET /mp/api/v1/tasks/lite/APP-8': {} });
		expect(await loadOptions.getTimeEntries.call(noId.ctx)).toEqual([]);
		expect(noId.requests).toHaveLength(1);
	});

	it('waits for a workspace and a task', async () => {
		for (const params of [{ workspace: '', task: 'tsk_1' }, WS]) {
			const p = picker(params);
			expect(await loadOptions.getTimeEntries.call(p.ctx)).toEqual([]);
			expect(p.requests).toEqual([]);
		}
	});
});

/* ---------- wiki pages ---------- */

describe('wiki page pickers', () => {
	const route = 'GET /api/wiki/v1/workspaces/ws-1/wiki/spaces/DOCS/pages';
	const rows = [
		{ id: 'p1', slug: 'guide', title: 'Guide', type: 'folder' },
		{ id: 'p2', slug: 'setup', title: 'Setup', parentId: 'p1' },
	];
	const run = async (method: string, params: Record<string, unknown> = { space: 'DOCS' }) => {
		const p = picker({ ...WS, ...params }, { [route]: rows });

		return { options: await loadOptions[method].call(p.ctx), p };
	};

	it('getWikiPages reads every page of the space, valued by slug, labelled with the ancestry', async () => {
		const { options, p } = await run('getWikiPages');
		expect(options).toEqual([
			{ name: 'Guide (folder)', value: 'guide' },
			{ name: 'Guide / Setup', value: 'setup' },
		]);
		expect(p.sent()).toEqual([route]);
	});

	it('getWikiParentPages offers the top level first', async () => {
		expect((await run('getWikiParentPages')).options).toEqual([
			{ name: '- Top Level -', value: '' },
			{ name: 'Guide (folder)', value: 'guide' },
			{ name: 'Guide / Setup', value: 'setup' },
		]);
	});

	it('getWikiPageIds is valued by page ID', async () => {
		expect((await run('getWikiPageIds')).options).toEqual([
			{ name: 'Guide (folder)', value: 'p1' },
			{ name: 'Guide / Setup', value: 'p2' },
		]);
	});

	it('waits for a space; the parent picker still offers the top level', async () => {
		expect((await run('getWikiPages', {})).options).toEqual([]);
		expect((await run('getWikiPageIds', {})).options).toEqual([]);
		const parent = await run('getWikiParentPages', {});
		expect(parent.options).toEqual([{ name: '- Top Level -', value: '' }]);
		expect(parent.p.requests).toEqual([]);
	});
});

/* ---------- Roadmarq board names ---------- */

describe('Roadmarq board name pickers', () => {
	const boards = 'GET /api/roadmarq/v1/boards';

	it.each([
		['getRequestStatuses', 'statuses'],
		['getRequestCategories', 'categories'],
		['getMilestones', 'milestones'],
		['getSeverityLevels', 'severity-levels'],
		['getProductAreas', 'product-areas'],
		['getBugStatuses', 'bug-status-levels'],
	])('%s finds the board UUID by slug, then lists its %s by name', async (method, segment) => {
		const p = picker(
			{ ...WS, board: 'roadmap' },
			{
				[boards]: [
					{ id: 'b-other', slug: 'other' },
					{ id: 'b-uuid', slug: 'roadmap' },
				],
				[`GET /api/roadmarq/v1/boards/b-uuid/${segment}`]: [{ name: 'Planned' }, {}],
			},
		);
		expect(await loadOptions[method].call(p.ctx)).toEqual([{ name: 'Planned', value: 'Planned' }]);
		expect(p.sent()).toEqual([boards, `GET /api/roadmarq/v1/boards/b-uuid/${segment}`]);
		expect(p.requests[0].qs).toEqual({ workspaceIdentifier: 'ws-1' });
	});

	it('waits for a board; an unknown slug or a 403 shows nothing; another error reaches the user', async () => {
		const none = picker(WS);
		expect(await loadOptions.getMilestones.call(none.ctx)).toEqual([]);
		expect(none.requests).toEqual([]);

		const unknown = picker(
			{ ...WS, board: 'gone' },
			{ [boards]: [{ id: 'b-uuid', slug: 'roadmap' }] },
		);
		expect(await loadOptions.getMilestones.call(unknown.ctx)).toEqual([]);
		expect(unknown.requests).toHaveLength(1);

		const forbidden = picker(
			{ ...WS, board: 'roadmap' },
			{ [boards]: refusal('403', 'Forbidden') },
		);
		expect(await loadOptions.getMilestones.call(forbidden.ctx)).toEqual([]);

		const broken = picker({ ...WS, board: 'roadmap' }, { [boards]: refusal('500', 'Broken') });
		await expect(loadOptions.getMilestones.call(broken.ctx)).rejects.toBeInstanceOf(NodeApiError);
	});
});

/* ---------- static ---------- */

describe('getPmEventTypes', () => {
	it('serves the shared event list without a request', async () => {
		const p = picker(WS);
		expect(await loadOptions.getPmEventTypes.call(p.ctx)).toEqual(PM_EVENT_OPTIONS);
		expect(PM_EVENT_OPTIONS.length).toBeGreaterThan(0);
		expect(p.requests).toEqual([]);
	});
});
