import type { IDataObject } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { calendarEvent } from '../../../nodes/Dutify/resources/hubCalendar';
import { hubIntegration, hubWorkspace } from '../../../nodes/Dutify/resources/hubWorkspace';
import type { OperationDef, ResourceDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

/*
 * Contracts: https://dutify.ai/api/v1/api-catalog/{Workspaces, Integrations, Workspace%20Settings,
 * User%20Resource, Calendar}. Hub's workspace paths take the workspace UUID, which the node finds
 * in GET /api/v1/workspaces by the selected workspace identifier.
 */

function opOf(resource: ResourceDef, name: string): OperationDef {
	const found = resource.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${resource.value}.${name}`);
	}

	return found;
}

const field = (resource: ResourceDef, operation: string, name: string) =>
	opOf(resource, operation).fields.find((f) => f.name === name);

const loaderOf = (resource: ResourceDef, operation: string, name: string) =>
	(field(resource, operation, name)?.typeOptions as { loadOptionsMethod?: string } | undefined)
		?.loadOptionsMethod;

const UUID = 'c0b647a5-2e8f-4d74-b7b9-8cc2257a07ab';
const WS_ROW = { id: UUID, identifier: 'ws-1', name: 'Test', ownerId: 'owner-1' };
const workspaces = { workspaces: [WS_ROW] };
const BASE = `/api/v1/workspaces/${UUID}`;
const LIST_WORKSPACES = { method: 'GET', path: '/api/v1/workspaces' };
const MEMBER_PAGING = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	itemsPath: 'members',
	maxPageSize: 100,
};

describe('registration', () => {
	it('registers hubWorkspace, hubIntegration and calendarEvent, all workspace scoped', () => {
		for (const [def, value] of [
			[hubWorkspace, 'hubWorkspace'],
			[hubIntegration, 'hubIntegration'],
			[calendarEvent, 'calendarEvent'],
		] as const) {
			expect(resources).toContain(def);
			expect(def.value).toBe(value);
			expect(def.workspaceScoped).toBe(true);
		}
	});

	it('exposes the operations', () => {
		expect(hubWorkspace.operations.map((o) => o.operation)).toEqual([
			'get',
			'listMembers',
			'getCustomPrompt',
			'setCustomPrompt',
			'clearCustomPrompt',
			'getDefault',
			'setDefault',
		]);
		expect(hubIntegration.operations.map((o) => o.operation)).toEqual([
			'list',
			'getPreferred',
			'setPreferred',
		]);
		expect(calendarEvent.operations.map((o) => o.operation)).toEqual([
			'list',
			'setCustomPrompt',
			'clearCustomPrompt',
			'setSeriesCustomPrompt',
			'clearSeriesCustomPrompt',
		]);
	});
});

describe('hubWorkspace', () => {
	it('get returns the selected workspace from the workspaces list', async () => {
		const other = { id: 'other-uuid', identifier: 'ws-2', name: 'Other' };
		const ctx = fakeContext([{ workspaces: [other, WS_ROW] }]);
		const out = await opOf(hubWorkspace, 'get').run!(ctx, reader({}));
		expect(ctx.calls).toEqual([LIST_WORKSPACES]);
		expect(out).toEqual([{ json: WS_ROW }]);
	});

	it('get also finds the workspace when the selector holds its UUID', async () => {
		const ctx = fakeContext([workspaces]);
		const out = await opOf(hubWorkspace, 'get').run!(ctx, reader({}, UUID));
		expect(out).toEqual([{ json: WS_ROW }]);
	});

	it('refuses with the workspace named when Hub does not list it for this key', async () => {
		const ctx = fakeContext([{ workspaces: [{ id: 'x', identifier: 'other' }] }]);
		await expect(opOf(hubWorkspace, 'get').run!(ctx, reader({}))).rejects.toThrow(/ws-1/);
	});

	it('listMembers pages /members zero-based, 100 a page, from the members array', async () => {
		const members = [{ userId: 'u1' }, { userId: 'u2' }];
		const ctx = fakeContext([workspaces, { members, page: 0, size: 100, totalPages: 1 }]);
		const out = await opOf(hubWorkspace, 'listMembers').run!(
			ctx,
			reader({ returnAll: true, additionalFields: {} }),
		);
		expect(ctx.calls).toEqual([
			LIST_WORKSPACES,
			{
				method: 'GET',
				path: `${BASE}/members`,
				qs: { page: 0, size: 100 },
				paginate: MEMBER_PAGING,
			},
		]);
		expect(out).toEqual([{ json: { userId: 'u1' } }, { json: { userId: 'u2' } }]);
		expect(opOf(hubWorkspace, 'listMembers').list).toBe(true);
	});

	it('listMembers sends the search text and stops at the limit', async () => {
		const ctx = fakeContext([workspaces, { members: [{ userId: 'u1' }, { userId: 'u2' }] }]);
		const out = await opOf(hubWorkspace, 'listMembers').run!(
			ctx,
			reader({ returnAll: false, limit: 1, additionalFields: { search: 'ann' } }),
		);
		expect(ctx.calls[1]).toEqual({
			method: 'GET',
			path: `${BASE}/members`,
			qs: { search: 'ann', page: 0, size: 100 },
			paginate: MEMBER_PAGING,
		});
		expect(out).toHaveLength(1);
	});

	it('getCustomPrompt returns the plain-text prompt as customPrompt', async () => {
		const ctx = fakeContext([workspaces, 'Summarise in bullets']);
		const out = await opOf(hubWorkspace, 'getCustomPrompt').run!(ctx, reader({}));
		expect(ctx.calls[1]).toEqual({ method: 'GET', path: `${BASE}/settings/custom-prompt` });
		expect(out).toEqual([{ json: { customPrompt: 'Summarise in bullets' } }]);
	});

	it('getCustomPrompt answers null when none is set (204, or empty after a clear)', async () => {
		for (const empty of [undefined, '']) {
			const ctx = fakeContext([workspaces, empty]);
			expect(await opOf(hubWorkspace, 'getCustomPrompt').run!(ctx, reader({}))).toEqual([
				{ json: { customPrompt: null } },
			]);
		}
	});

	it('getCustomPrompt keeps a prompt the HTTP client parsed as JSON as its text', async () => {
		const ctx = fakeContext([workspaces, { a: 1 }]);
		expect(await opOf(hubWorkspace, 'getCustomPrompt').run!(ctx, reader({}))).toEqual([
			{ json: { customPrompt: '{"a":1}' } },
		]);
	});

	it('setCustomPrompt PUTs the prompt as the raw text body, not JSON', async () => {
		const ctx = fakeContext([workspaces, '']);
		const out = await opOf(hubWorkspace, 'setCustomPrompt').run!(
			ctx,
			reader({ customPrompt: 'Use "quotes" freely' }),
		);
		expect(ctx.calls[1]).toEqual({
			method: 'PUT',
			path: `${BASE}/settings/custom-prompt`,
			body: 'Use "quotes" freely',
			contentType: 'text/plain',
		});
		expect(out).toEqual([{ json: { customPrompt: 'Use "quotes" freely' } }]);
	});

	it('setCustomPrompt refuses an empty prompt before any request', async () => {
		const ctx = fakeContext([]);
		await expect(
			opOf(hubWorkspace, 'setCustomPrompt').run!(ctx, reader({ customPrompt: ' ' })),
		).rejects.toThrow(/Clear Custom Prompt/);
		expect(ctx.calls).toEqual([]);
	});

	it('clearCustomPrompt PUTs an empty body (the only body that clears it)', async () => {
		const ctx = fakeContext([workspaces, '']);
		const out = await opOf(hubWorkspace, 'clearCustomPrompt').run!(ctx, reader({}));
		expect(ctx.calls[1]).toEqual({
			method: 'PUT',
			path: `${BASE}/settings/custom-prompt`,
			body: '',
			contentType: 'text/plain',
		});
		expect(out).toEqual([{ json: { customPrompt: null } }]);
	});

	it('getDefault GETs the user default workspace', () => {
		expect(opOf(hubWorkspace, 'getDefault').build!(reader({}))).toEqual({
			method: 'GET',
			path: '/api/user/settings/default-workspace',
		});
	});

	it('setDefault to the selected workspace PUTs its UUID', async () => {
		const ctx = fakeContext([workspaces, { workspaceId: UUID }]);
		const out = await opOf(hubWorkspace, 'setDefault').run!(
			ctx,
			reader({ defaultWorkspace: 'selected' }),
		);
		expect(ctx.calls).toEqual([
			LIST_WORKSPACES,
			{
				method: 'PUT',
				path: '/api/user/settings/default-workspace',
				body: { workspaceId: UUID },
			},
		]);
		expect(out).toEqual([{ json: { workspaceId: UUID } }]);
	});

	it('setDefault with None PUTs workspaceId null, without looking the workspace up', async () => {
		const ctx = fakeContext([undefined]);
		const out = await opOf(hubWorkspace, 'setDefault').run!(
			ctx,
			reader({ defaultWorkspace: 'none' }),
		);
		expect(ctx.calls).toEqual([
			{
				method: 'PUT',
				path: '/api/user/settings/default-workspace',
				body: { workspaceId: null },
			},
		]);
		expect(out).toEqual([{ json: { workspaceId: null } }]);
	});
});

describe('hubIntegration', () => {
	it('list GETs the connected integrations of the workspace, one item each', async () => {
		const rows = [{ integrationSystem: 'PM', status: 'CONNECTED' }];
		const ctx = fakeContext([workspaces, rows]);
		const out = await opOf(hubIntegration, 'list').run!(ctx, reader({}));
		expect(ctx.calls).toEqual([LIST_WORKSPACES, { method: 'GET', path: `${BASE}/integrations` }]);
		expect(out).toEqual([{ json: rows[0] }]);
	});

	it('getPreferred returns the enum value as preferredIntegration', async () => {
		const ctx = fakeContext([workspaces, 'PM']);
		const out = await opOf(hubIntegration, 'getPreferred').run!(ctx, reader({}));
		expect(ctx.calls[1]).toEqual({
			method: 'GET',
			path: `${BASE}/settings/preferred-integration`,
		});
		expect(out).toEqual([{ json: { preferredIntegration: 'PM' } }]);
	});

	it('getPreferred answers null when none is set', async () => {
		const ctx = fakeContext([workspaces, '']);
		expect(await opOf(hubIntegration, 'getPreferred').run!(ctx, reader({}))).toEqual([
			{ json: { preferredIntegration: null } },
		]);
	});

	it('setPreferred PUTs the bare enum value as a JSON string body', async () => {
		const ctx = fakeContext([workspaces, '']);
		const out = await opOf(hubIntegration, 'setPreferred').run!(
			ctx,
			reader({ preferredIntegration: 'JIRA' }),
		);
		expect(ctx.calls[1]).toEqual({
			method: 'PUT',
			path: `${BASE}/settings/preferred-integration`,
			body: '"JIRA"',
			contentType: 'application/json',
		});
		expect(out).toEqual([{ json: { preferredIntegration: 'JIRA' } }]);
	});

	it('setPreferred offers the IntegrationSystem values of the catalog', () => {
		const options = field(hubIntegration, 'setPreferred', 'preferredIntegration')?.options as
			| IDataObject[]
			| undefined;
		expect((options ?? []).map((o) => o.value).sort()).toEqual(
			[
				'AIRTABLE',
				'ATLASSIAN',
				'CLICKUP',
				'COMPOSIO',
				'EMAIL',
				'GOOGLE',
				'JIRA',
				'PM',
				'SLACK',
				'TEAMS',
			].sort(),
		);
	});
});

describe('calendarEvent', () => {
	it('list GETs the events between two ISO-8601 instants', () => {
		const op = opOf(calendarEvent, 'list');
		expect(op.list).toBe(true);
		expect(
			op.build!(reader({ startDate: '2026-10-01', endDate: '2026-10-31T12:00:00+02:00' })),
		).toEqual({
			method: 'GET',
			path: '/api/v1/calendar/events',
			qs: { startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-31T12:00:00+02:00' },
		});
		expect(field(calendarEvent, 'list', 'startDate')?.required).toBe(true);
		expect(field(calendarEvent, 'list', 'endDate')?.required).toBe(true);
	});

	it('list refuses a missing date before any request', () => {
		expect(() =>
			opOf(calendarEvent, 'list').build!(reader({ startDate: '', endDate: '2026-10-31' })),
		).toThrow(/Start/);
	});

	it('setCustomPrompt PUTs {customPrompt} on one occurrence', () => {
		expect(
			opOf(calendarEvent, 'setCustomPrompt').build!(
				reader({ event: 'evt/1', customPrompt: 'Note pricing' }),
			),
		).toEqual({
			method: 'PUT',
			path: '/api/v1/calendar/events/evt%2F1/custom-prompt',
			body: { customPrompt: 'Note pricing' },
		});
		expect(loaderOf(calendarEvent, 'setCustomPrompt', 'event')).toBe('getCalendarEvents');
	});

	it('clearCustomPrompt DELETEs the occurrence prompt', () => {
		expect(opOf(calendarEvent, 'clearCustomPrompt').build!(reader({ event: 'evt1' }))).toEqual({
			method: 'DELETE',
			path: '/api/v1/calendar/events/evt1/custom-prompt',
		});
		expect(loaderOf(calendarEvent, 'clearCustomPrompt', 'event')).toBe('getCalendarEvents');
	});

	it('setSeriesCustomPrompt PUTs {customPrompt} on the series', () => {
		expect(
			opOf(calendarEvent, 'setSeriesCustomPrompt').build!(
				reader({ series: 'ser1', customPrompt: 'Weekly format' }),
			),
		).toEqual({
			method: 'PUT',
			path: '/api/v1/calendar/series/ser1/custom-prompt',
			body: { customPrompt: 'Weekly format' },
		});
		expect(loaderOf(calendarEvent, 'setSeriesCustomPrompt', 'series')).toBe('getCalendarSeries');
	});

	it('clearSeriesCustomPrompt DELETEs the series prompt', () => {
		expect(
			opOf(calendarEvent, 'clearSeriesCustomPrompt').build!(reader({ series: 'ser1' })),
		).toEqual({ method: 'DELETE', path: '/api/v1/calendar/series/ser1/custom-prompt' });
		expect(loaderOf(calendarEvent, 'clearSeriesCustomPrompt', 'series')).toBe('getCalendarSeries');
	});

	it('the prompt setters refuse an empty prompt', () => {
		for (const [operation, params] of [
			['setCustomPrompt', { event: 'e' }],
			['setSeriesCustomPrompt', { series: 's' }],
		] as const) {
			expect(() =>
				opOf(calendarEvent, operation).build!(reader({ ...params, customPrompt: '' })),
			).toThrow(/Clear/);
		}
	});
});
