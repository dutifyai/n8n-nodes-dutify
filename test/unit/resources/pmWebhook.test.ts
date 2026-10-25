import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { pmWebhook } from '../../../nodes/Dutify/resources/pmWebhook';
import type { OperationDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

const WS = '/mp/api/v1/workspaces/ws-1/webhooks';

function opOf(name: string): OperationDef {
	const found = pmWebhook.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation pmWebhook.${name}`);
	}

	return found;
}

const build = (name: string, params: Record<string, unknown>) => opOf(name).build!(reader(params));

const field = (operation: string, name: string) =>
	opOf(operation).fields.find((f) => f.name === name);

const loaderOf = (operation: string, name: string) =>
	(field(operation, name)?.typeOptions as { loadOptionsMethod?: string } | undefined)
		?.loadOptionsMethod;

describe('registration', () => {
	it('registers pmWebhook, workspace scoped, with the nine operations of the brief', () => {
		expect(resources).toContain(pmWebhook);
		expect(pmWebhook.value).toBe('pmWebhook');
		expect(pmWebhook.workspaceScoped).toBe(true);
		expect(pmWebhook.operations.map((o) => o.operation)).toEqual([
			'create',
			'list',
			'getUsage',
			'get',
			'update',
			'delete',
			'test',
			'listDeliveries',
			'replayDelivery',
		]);
	});
});

describe('create', () => {
	const base = {
		url: 'https://hooks.example.com/dutify',
		secret: 's3cret',
		eventTypes: ['task-created', 'comment-added'],
		scopeType: 'WORKSPACE',
		additionalFields: {},
	};

	it('POSTs url, secret and eventTypes for a workspace-wide webhook', async () => {
		const ctx = fakeContext([{ identifier: 'whk_1' }]);
		await opOf('create').run!(ctx, reader(base));
		expect(ctx.calls).toEqual([
			{
				method: 'POST',
				path: WS,
				body: {
					url: 'https://hooks.example.com/dutify',
					secret: 's3cret',
					eventTypes: ['task-created', 'comment-added'],
				},
			},
		]);
	});

	it('returns the response unchanged', async () => {
		const response = { identifier: 'whk_1', url: base.url, active: true };
		const out = await opOf('create').run!(fakeContext([response]), reader(base));
		expect(out).toEqual([{ json: response }]);
	});

	it('adds the name', async () => {
		const ctx = fakeContext([{}]);
		await opOf('create').run!(ctx, reader({ ...base, additionalFields: { name: 'CI hook' } }));
		expect(ctx.calls[0].body).toMatchObject({ name: 'CI hook' });
	});

	it.each([
		['SPACE', 'scopeSpace', 'sp_1'],
		['FOLDER', 'scopeFolder', 'fld_1'],
		['TASK_LIST', 'scopeList', 'lst_1'],
	])('scopes to a %s picked from %s', async (scopeType, param, id) => {
		const ctx = fakeContext([{}]);
		await opOf('create').run!(ctx, reader({ ...base, scopeType, [param]: id }));
		expect(ctx.calls).toHaveLength(1);
		expect(ctx.calls[0].body).toMatchObject({ scopeType, scopeEntityIdentifier: id });
	});

	it('scopes to a TASK given by key, resolving it to its tsk_ ID first', async () => {
		const ctx = fakeContext([{ identifier: 'tsk_9' }, {}]);
		await opOf('create').run!(ctx, reader({ ...base, scopeType: 'TASK', scopeTask: 'PROJ-42' }));
		expect(ctx.calls[0]).toEqual({
			method: 'GET',
			path: '/mp/api/v1/tasks/lite/PROJ-42',
			qs: { workspace: 'ws-1' },
		});
		expect(ctx.calls[1].body).toMatchObject({ scopeType: 'TASK', scopeEntityIdentifier: 'tsk_9' });
	});

	it('does not look a task up when it is already a tsk_ ID', async () => {
		const ctx = fakeContext([{}]);
		await opOf('create').run!(ctx, reader({ ...base, scopeType: 'TASK', scopeTask: 'tsk_9' }));
		expect(ctx.calls).toHaveLength(1);
		expect(ctx.calls[0].body).toMatchObject({ scopeEntityIdentifier: 'tsk_9' });
	});

	it('throws before any request when no event type is chosen', async () => {
		const ctx = fakeContext([]);
		await expect(opOf('create').run!(ctx, reader({ ...base, eventTypes: [] }))).rejects.toThrow(
			/event type/i,
		);
		expect(ctx.calls).toEqual([]);
	});

	it('offers eventTypes as a multiOptions loaded from getPmEventTypes, and the secret as a password', () => {
		expect(field('create', 'eventTypes')).toMatchObject({ type: 'multiOptions', required: true });
		expect(loaderOf('create', 'eventTypes')).toBe('getPmEventTypes');
		expect(field('create', 'secret')?.typeOptions).toMatchObject({ password: true });
	});

	it('picks the scope target from the identifier pickers', () => {
		expect(loaderOf('create', 'scopeSpace')).toBe('getSpaceIds');
		expect(loaderOf('create', 'scopeFolder')).toBe('getFolderIds');
		expect(loaderOf('create', 'scopeList')).toBe('getListIds');
		expect(field('create', 'scopeTask')?.type).toBe('string');
		expect(field('create', 'scopeSpace')?.displayOptions).toEqual({
			show: { scopeType: ['SPACE'] },
		});
	});
});

describe('list', () => {
	it('GETs the webhooks of the caller', () => {
		expect(build('list', { additionalFields: {} })).toEqual({ method: 'GET', path: WS });
	});

	it('asks for every webhook of the workspace on request', () => {
		expect(build('list', { additionalFields: { all: true } })).toEqual({
			method: 'GET',
			path: WS,
			qs: { all: true },
		});
	});
});

describe('getUsage', () => {
	it('GETs the usage counters', () => {
		expect(build('getUsage', {})).toEqual({ method: 'GET', path: `${WS}/usage` });
	});
});

describe('get, delete, test', () => {
	it('GET /webhooks/{id}', () => {
		expect(build('get', { webhook: 'whk_1' })).toEqual({ method: 'GET', path: `${WS}/whk_1` });
	});

	it('DELETE /webhooks/{id}', () => {
		expect(build('delete', { webhook: 'whk_1' })).toEqual({
			method: 'DELETE',
			path: `${WS}/whk_1`,
		});
	});

	it('POST /webhooks/{id}/test', () => {
		expect(build('test', { webhook: 'whk_1' })).toEqual({
			method: 'POST',
			path: `${WS}/whk_1/test`,
		});
	});

	it('pick the webhook from getPmWebhooks', () => {
		for (const op of ['get', 'update', 'delete', 'test', 'listDeliveries', 'replayDelivery']) {
			expect(loaderOf(op, 'webhook')).toBe('getPmWebhooks');
		}
	});
});

describe('update', () => {
	const base = { webhook: 'whk_1', scopeType: 'KEEP', updateFields: {} };

	it('PUTs only the fields that were set', async () => {
		const ctx = fakeContext([{}]);
		await opOf('update').run!(
			ctx,
			reader({
				...base,
				updateFields: { url: 'https://new.example.com', name: 'Renamed', active: false },
			}),
		);
		expect(ctx.calls).toEqual([
			{
				method: 'PUT',
				path: `${WS}/whk_1`,
				body: { url: 'https://new.example.com', name: 'Renamed', active: false },
			},
		]);
	});

	it('replaces the event types, and leaves them alone when none are chosen', async () => {
		const ctx = fakeContext([{}, {}]);
		await opOf('update').run!(
			ctx,
			reader({ ...base, updateFields: { eventTypes: ['task-deleted'] } }),
		);
		expect(ctx.calls[0].body).toEqual({ eventTypes: ['task-deleted'] });
		await opOf('update').run!(
			ctx,
			reader({ ...base, updateFields: { name: 'x', eventTypes: [] } }),
		);
		expect(ctx.calls[1].body).toEqual({ name: 'x' });
	});

	it('changes the secret', async () => {
		const ctx = fakeContext([{}]);
		await opOf('update').run!(ctx, reader({ ...base, updateFields: { secret: 'new' } }));
		expect(ctx.calls[0].body).toEqual({ secret: 'new' });
	});

	it('moves the webhook to another scope', async () => {
		const ctx = fakeContext([{}]);
		await opOf('update').run!(ctx, reader({ ...base, scopeType: 'SPACE', scopeSpace: 'sp_2' }));
		expect(ctx.calls[0].body).toEqual({ scopeType: 'SPACE', scopeEntityIdentifier: 'sp_2' });
	});

	it('resolves a task key for a TASK scope', async () => {
		const ctx = fakeContext([{ identifier: 'tsk_3' }, {}]);
		await opOf('update').run!(ctx, reader({ ...base, scopeType: 'TASK', scopeTask: 'PROJ-1' }));
		expect(ctx.calls[1].body).toEqual({ scopeType: 'TASK', scopeEntityIdentifier: 'tsk_3' });
	});

	it('removes the scope with clearScope', async () => {
		const ctx = fakeContext([{}]);
		await opOf('update').run!(ctx, reader({ ...base, scopeType: 'WORKSPACE' }));
		expect(ctx.calls[0].body).toEqual({ clearScope: true });
	});

	it('throws before any request when nothing is set', async () => {
		const ctx = fakeContext([]);
		await expect(opOf('update').run!(ctx, reader(base))).rejects.toThrow(/at least one/i);
		expect(ctx.calls).toEqual([]);
	});
});

describe('listDeliveries', () => {
	it('GETs the delivery log, paged from zero, 100 at most', () => {
		expect(opOf('listDeliveries').list).toBe(true);
		expect(build('listDeliveries', { webhook: 'whk_1' })).toEqual({
			method: 'GET',
			path: `${WS}/whk_1/deliveries`,
			paginate: {
				kind: 'page',
				pageParam: 'page',
				sizeParam: 'size',
				zeroBased: true,
				maxPageSize: 100,
			},
		});
	});
});

describe('replayDelivery', () => {
	it('POSTs the replay of one delivery', () => {
		expect(build('replayDelivery', { webhook: 'whk_1', delivery: 'whd_1' })).toEqual({
			method: 'POST',
			path: `${WS}/whk_1/deliveries/whd_1/replay`,
		});
	});

	it('picks the delivery from getPmWebhookDeliveries, which depends on the webhook', () => {
		expect(loaderOf('replayDelivery', 'delivery')).toBe('getPmWebhookDeliveries');
		expect(field('replayDelivery', 'delivery')?.typeOptions).toMatchObject({
			loadOptionsDependsOn: ['webhook'],
		});
	});
});
