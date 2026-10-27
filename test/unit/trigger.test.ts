import { createHmac } from 'node:crypto';
import type {
	IDataObject,
	IHookFunctions,
	IHttpRequestOptions,
	INodeProperties,
	IWebhookFunctions,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { DutifyTrigger } from '../../nodes/DutifyTrigger/DutifyTrigger.node';
import { sources, verifySignature } from '../../nodes/DutifyTrigger/sources';
import { PM_EVENT_TYPES } from '../../shared/pmEvents';
import packageJson from '../../package.json';
import { conformanceFixture } from './conformanceFixture';

const sign = (secret: string, body: string | Buffer) =>
	`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/* ---------- verifySignature ---------- */

describe('verifySignature', () => {
	const secret = 'a'.repeat(64);
	const raw = Buffer.from('{"version":"1","id":"whd_1","type":"task-created","data":{"x":1}}');

	it('accepts sha256=<lowercase hex HMAC-SHA256 of the raw body keyed by the secret>', () => {
		expect(verifySignature(secret, raw, sign(secret, raw))).toBe(true);
	});

	it('rejects a signature made with another secret', () => {
		expect(verifySignature(secret, raw, sign('b'.repeat(64), raw))).toBe(false);
	});

	it('rejects a signature over another body', () => {
		expect(verifySignature(secret, raw, sign(secret, `${raw.toString()} `))).toBe(false);
	});

	it('rejects a missing or empty header', () => {
		expect(verifySignature(secret, raw, undefined)).toBe(false);
		expect(verifySignature(secret, raw, '')).toBe(false);
	});

	it('rejects the right hex without the sha256= prefix', () => {
		const hex = createHmac('sha256', secret).update(raw).digest('hex');
		expect(verifySignature(secret, raw, hex)).toBe(false);
	});

	it('rejects a truncated or garbage signature without throwing', () => {
		expect(verifySignature(secret, raw, sign(secret, raw).slice(0, -2))).toBe(false);
		expect(verifySignature(secret, raw, 'sha256=zz')).toBe(false);
	});

	it('rejects when there is no secret or no raw body', () => {
		expect(verifySignature('', raw, sign('', raw))).toBe(false);
		expect(verifySignature(secret, undefined, sign(secret, raw))).toBe(false);
	});
});

/* ---------- PM source ---------- */

describe('PM webhook source', () => {
	const pm = sources.pm;
	const URL = 'https://n8n.example.com/webhook/abc/webhook';

	it('the pm, meeting (Hub), codexum (wiki) and roadmarq (feature requests) sources exist', () => {
		expect(Object.keys(sources).sort()).toEqual(['codexum', 'meeting', 'pm', 'roadmarq']);
	});

	it('codexum and roadmarq use the PM subscription API and its signature header', () => {
		expect(sources.codexum).toBe(pm);
		expect(sources.roadmarq).toBe(pm);
	});

	it('listSendsUrlQuery: the list asks PM for the webhooks at the trigger URL only', () => {
		expect(pm.list({ workspace: 'ws-1', url: URL })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/webhooks',
			qs: { url: URL },
		});
	});

	it('checks the X-Webhook-Signature-256 header (lowercase, as n8n reads headers)', () => {
		expect(pm.signatureHeader).toBe('x-webhook-signature-256');
	});

	it('creates via POST /mp/api/v1/workspaces/{ws}/webhooks with url, secret, name n8n and the events', () => {
		expect(pm.create(URL, 'sek', { workspace: 'ws-1', eventTypes: ['task-created'] })).toEqual({
			method: 'POST',
			path: '/mp/api/v1/workspaces/ws-1/webhooks',
			body: { url: URL, secret: 'sek', name: 'n8n', eventTypes: ['task-created'] },
		});
	});

	it('sends the scope when one is given', () => {
		const spec = pm.create(URL, 'sek', {
			workspace: 'ws-1',
			eventTypes: ['task-created', 'comment-added'],
			scopeType: 'TASK_LIST',
			scopeEntityIdentifier: 'lst_1',
		});
		expect(spec.body).toEqual({
			url: URL,
			secret: 'sek',
			name: 'n8n',
			eventTypes: ['task-created', 'comment-added'],
			scopeType: 'TASK_LIST',
			scopeEntityIdentifier: 'lst_1',
		});
	});

	it('percent-encodes the workspace in every path', () => {
		expect(pm.create(URL, 's', { workspace: 'a/b', eventTypes: ['task-created'] }).path).toBe(
			'/mp/api/v1/workspaces/a%2Fb/webhooks',
		);
		expect(pm.list({ workspace: 'a/b' }).path).toBe('/mp/api/v1/workspaces/a%2Fb/webhooks');
		expect(pm.remove('whk/1', { workspace: 'a/b' }).path).toBe(
			'/mp/api/v1/workspaces/a%2Fb/webhooks/whk%2F1',
		);
	});

	it('the create response carries the identifier but never the secret, so the generated one is kept', () => {
		expect(pm.parseCreated({ identifier: 'whk_1', url: URL, active: true }, 'sek')).toEqual({
			id: 'whk_1',
			secret: 'sek',
		});
	});

	it('a create response without an identifier is an error', () => {
		expect(() => pm.parseCreated({}, 'sek')).toThrow();
		expect(() => pm.parseCreated(null, 'sek')).toThrow();
	});

	it('lists the webhooks of the workspace', () => {
		expect(pm.list({ workspace: 'ws-1' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/webhooks',
		});
	});

	it('removes via DELETE /mp/api/v1/workspaces/{ws}/webhooks/{id}', () => {
		expect(pm.remove('whk_1', { workspace: 'ws-1' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/workspaces/ws-1/webhooks/whk_1',
		});
	});

	it('deactivates via PUT /mp/api/v1/workspaces/{ws}/webhooks/{id} with only { active: false }', () => {
		const spec = pm.deactivate('whk_1', { workspace: 'ws 1' });
		expect(spec).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/workspaces/ws%201/webhooks/whk_1',
			body: { active: false },
		});
		// Catalog UpdateWebhookRequest: every field is optional, so a partial body is valid.
		const updateWebhookRequest = [
			'url',
			'secret',
			'name',
			'eventTypes',
			'active',
			'scopeType',
			'scopeEntityIdentifier',
			'clearScope',
		];
		for (const key of Object.keys(spec.body as IDataObject)) {
			expect(updateWebhookRequest).toContain(key);
		}
	});

	describe('listAtUrl', () => {
		const rows = [
			{ identifier: 'whk_1', url: 'https://other.example.com/hook', active: true },
			{ identifier: 'whk_2', url: URL },
			{
				identifier: 'whk_3',
				url: URL,
				active: false,
				scopeType: 'SPACE',
				scopeEntityIdentifier: 'spc_1',
				createdAt: '2026-10-20T10:00:00Z',
			},
			{ url: URL, active: true },
		];

		it('returns the webhooks delivering to url, with their state, scope and creation time', () => {
			expect(pm.listAtUrl(rows, URL)).toEqual([
				{ id: 'whk_2', url: URL, active: true, scoped: false, createdAt: undefined },
				{
					id: 'whk_3',
					url: URL,
					active: false,
					scoped: true,
					scopeType: 'SPACE',
					scopeEntityIdentifier: 'spc_1',
					createdAt: '2026-10-20T10:00:00Z',
				},
			]);
		});

		it('carries the pause reason code (pauseReasonCode; pauseReason holds a description)', () => {
			const [hook] = pm.listAtUrl(
				[
					{
						identifier: 'whk_9',
						url: URL,
						active: false,
						pauseReason: 'Delivery repeatedly failed for an extended period.',
						pauseReasonCode: 'SUSTAINED_DELIVERY_FAILURES',
					},
				],
				URL,
			);
			expect(hook.pauseReason).toBe('SUSTAINED_DELIVERY_FAILURES');
		});

		it('counts a row without an active flag as active (PM sends it; older rows may not)', () => {
			expect(pm.listAtUrl([{ identifier: 'whk_2', url: URL }], URL)[0].active).toBe(true);
		});

		it('returns nothing when no url matches or the list is not an array', () => {
			expect(pm.listAtUrl(rows, 'https://nope.example.com/x')).toEqual([]);
			expect(pm.listAtUrl([], URL)).toEqual([]);
			expect(pm.listAtUrl(null, URL)).toEqual([]);
		});
	});

	describe('update (reuse of a webhook already at the URL)', () => {
		const updateWebhookRequest = [
			'url',
			'secret',
			'name',
			'eventTypes',
			'active',
			'scopeType',
			'scopeEntityIdentifier',
			'clearScope',
		];
		const unscoped = { id: 'whk_1', url: URL, active: false, scoped: false };
		const scoped = { id: 'whk_1', url: URL, active: false, scoped: true };

		it('PUTs the new secret, events and active:true, a body that fits UpdateWebhookRequest', () => {
			const spec = pm.update(unscoped, 'sek2', { workspace: 'ws 1', eventTypes: ['task-created'] });
			expect(spec).toEqual({
				method: 'PUT',
				path: '/mp/api/v1/workspaces/ws%201/webhooks/whk_1',
				body: { secret: 'sek2', eventTypes: ['task-created'], active: true },
			});
			for (const key of Object.keys(spec.body as IDataObject)) {
				expect(updateWebhookRequest).toContain(key);
			}
		});

		it('sends the new scope', () => {
			const spec = pm.update(scoped, 'sek2', {
				workspace: 'ws-1',
				eventTypes: ['task-created'],
				scopeType: 'TASK_LIST',
				scopeEntityIdentifier: 'lst_1',
			});
			expect(spec.body).toEqual({
				secret: 'sek2',
				eventTypes: ['task-created'],
				active: true,
				scopeType: 'TASK_LIST',
				scopeEntityIdentifier: 'lst_1',
			});
		});

		it('clears the old scope when the new config has none', () => {
			const spec = pm.update(scoped, 'sek2', { workspace: 'ws-1', eventTypes: ['task-created'] });
			expect(spec.body).toEqual({
				secret: 'sek2',
				eventTypes: ['task-created'],
				active: true,
				clearScope: true,
			});
		});
	});
});

/* ---------- Hub meeting source ---------- */

/*
 * Contract: https://dutify.ai/api/v1/api-catalog/User%20Webhooks and Hub origin/master
 * UserWebhookService: deliveries carry `X-Dutify-Signature: sha256=<hex HMAC-SHA256 of the body>`
 * (no timestamp is signed); update validates the URL every time; `enabled` is the on/off flag.
 */
describe('Hub meeting webhook source', () => {
	const meeting = sources.meeting;
	const URL = 'https://n8n.example.com/webhook/abc/webhook';
	const HOOKS = '/api/user/webhooks';

	it('checks the X-Dutify-Signature header (lowercase, as n8n reads headers)', () => {
		expect(meeting.signatureHeader).toBe('x-dutify-signature');
	});

	it('creates via POST /api/user/webhooks with url, secret, name n8n and the sections', () => {
		expect(
			meeting.create(URL, 'sek', { workspace: 'ws-1', sections: ['summary', 'tasks'] }),
		).toEqual({
			method: 'POST',
			path: HOOKS,
			body: { url: URL, secret: 'sek', name: 'n8n', sections: ['summary', 'tasks'] },
		});
	});

	it('the create response carries the integer id but never the secret, so the generated one is kept', () => {
		expect(meeting.parseCreated({ id: 42, url: URL, hasSecret: true }, 'sek')).toEqual({
			id: '42',
			secret: 'sek',
		});
		expect(() => meeting.parseCreated({}, 'sek')).toThrow();
		expect(() => meeting.parseCreated(null, 'sek')).toThrow();
	});

	it('lists GET /api/user/webhooks (Hub narrows it to the workspace header)', () => {
		expect(meeting.list({ workspace: 'ws-1' })).toEqual({ method: 'GET', path: HOOKS });
	});

	it('listAtUrl maps id, url and the on/off flag; a webhook is never scoped', () => {
		const rows = [
			{ id: 1, url: 'https://other.example.com/x', enabled: true },
			{ id: 2, url: URL, enabled: true },
			{ id: 3, url: URL, enabled: false },
			{ id: 4, url: URL },
			{ url: URL, enabled: true },
		];
		expect(meeting.listAtUrl(rows, URL)).toEqual([
			{ id: '2', url: URL, active: true, scoped: false },
			{ id: '3', url: URL, active: false, scoped: false },
			{ id: '4', url: URL, active: true, scoped: false },
		]);
		expect(meeting.listAtUrl(null, URL)).toEqual([]);
	});

	it('update PUTs the URL again (Hub requires it), a fresh secret, the sections and switches it on', () => {
		expect(
			meeting.update({ id: '3', url: URL, active: false, scoped: false }, 'sek2', {
				workspace: 'ws-1',
				sections: ['summary'],
			}),
		).toEqual({
			method: 'PUT',
			path: `${HOOKS}/3`,
			body: { url: URL, secret: 'sek2', sections: ['summary'], enabled: true },
		});
	});

	it('removes via DELETE /api/user/webhooks/{id}; Hub always deletes, so there is no pause fallback', () => {
		expect(meeting.remove('3', { workspace: 'ws-1' })).toEqual({
			method: 'DELETE',
			path: `${HOOKS}/3`,
		});
		expect(meeting.deactivate).toBeUndefined();
	});
});

/* ---------- trigger node stubs ---------- */

const BASE = 'https://dutify.test';
const HOOK_URL = 'https://n8n.example.com/webhook/7f3a/webhook';
const LIST_PATH = `${BASE}/mp/api/v1/workspaces/ws-1/webhooks`;
const OLD_WS_PATH = `${BASE}/mp/api/v1/workspaces/ws-old/webhooks`;

interface Recorded {
	method: string;
	url: string;
	body?: unknown;
	qs?: unknown;
	headers?: unknown;
}

function httpError(status: number, message: string) {
	return Object.assign(new Error(message), {
		httpCode: String(status),
		response: { body: { message } },
	});
}

function hookContext(opts: {
	params?: Record<string, unknown>;
	staticData?: IDataObject;
	responses?: unknown[];
	webhookUrl?: string;
}) {
	const params: Record<string, unknown> = {
		source: 'pm',
		workspace: 'ws-1',
		events: ['task-created', 'task-status-changed'],
		scopeType: 'WORKSPACE',
		...opts.params,
	};
	const staticData: IDataObject = opts.staticData ?? {};
	const queue = [...(opts.responses ?? [])];
	const calls: Recorded[] = [];
	const ctx = {
		getNodeParameter(name: string, fallback?: unknown) {
			if (Object.prototype.hasOwnProperty.call(params, name)) {
				return params[name];
			}
			if (fallback !== undefined) {
				return fallback;
			}
			throw new Error(`hookContext: missing parameter "${name}"`);
		},
		getNodeWebhookUrl: (name: string) =>
			name === 'default' ? (opts.webhookUrl ?? HOOK_URL) : undefined,
		getWorkflowStaticData: (type: string) => {
			if (type !== 'node') {
				throw new Error(`unexpected static data type ${type}`);
			}

			return staticData;
		},
		getCredentials: async () => ({ apiKey: 'dk_live_x', baseUrl: BASE }),
		getNode: () => ({
			id: 'n1',
			name: 'Dutify Trigger',
			type: 'n8n-nodes-dutify.dutifyTrigger',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		helpers: {
			async httpRequestWithAuthentication(_cred: string, options: IHttpRequestOptions) {
				calls.push({
					method: String(options.method),
					url: options.url,
					body: options.body,
					qs: options.qs,
					headers: options.headers,
				});
				if (queue.length === 0) {
					throw new Error(`hookContext: no response left for ${options.method} ${options.url}`);
				}
				const next = queue.shift();
				if (next instanceof Error) {
					throw next;
				}

				return next;
			},
		},
	};

	return { ctx: ctx as unknown as IHookFunctions, calls, staticData };
}

const trigger = new DutifyTrigger();
const hooks = trigger.webhookMethods.default;

/* ---------- checkExists ---------- */

describe('checkExists', () => {
	it('is true, and creates nothing, while the stored webhook is still listed at this URL (restart reuses it)', async () => {
		const { ctx, calls } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek' },
			responses: [
				[
					{ identifier: 'whk_0', url: 'https://elsewhere.example.com/h' },
					{ identifier: 'whk_1', url: HOOK_URL, active: true },
				],
			],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${LIST_PATH}`]);
		expect((calls[0].headers as IDataObject)['X-Dutify-Workspace']).toBe('ws-1');
	});

	it('is false when PM paused the stored webhook (active:false), so n8n calls create and it is resumed', async () => {
		const { ctx } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek', workspace: 'ws-1' },
			responses: [[{ identifier: 'whk_1', url: HOOK_URL, active: false }]],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
	});

	it('is false when the stored webhook was deleted in Dutify, so n8n re-creates it', async () => {
		const { ctx, calls } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek' },
			responses: [[{ identifier: 'whk_0', url: 'https://elsewhere.example.com/h' }]],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
		expect(calls.every((c) => c.method === 'GET')).toBe(true);
	});

	it('is false when the stored webhook is gone even though another one (no known secret) is at this URL', async () => {
		const { ctx } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek' },
			responses: [[{ identifier: 'whk_2', url: HOOK_URL }]],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
	});

	it('is false when the stored webhook now points at another URL', async () => {
		const { ctx } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek' },
			responses: [
				[{ identifier: 'whk_1', url: 'https://old-host.example.com/webhook/7f3a/webhook' }],
			],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
	});

	it('is false without a stored webhook, and does not adopt one it holds no secret for', async () => {
		const { ctx } = hookContext({
			responses: [[{ identifier: 'whk_1', url: HOOK_URL }]],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
	});

	it('is false when a stored id has no secret (deliveries could not be verified)', async () => {
		const { ctx } = hookContext({
			staticData: { webhookId: 'whk_1' },
			responses: [[{ identifier: 'whk_1', url: HOOK_URL }]],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
	});

	it('is false, without asking Dutify, when the workspace parameter changed since registration', async () => {
		const { ctx, calls } = hookContext({
			params: { workspace: 'ws-new' },
			staticData: { webhookId: 'whk_1', secret: 'sek', workspace: 'ws-old' },
			responses: [],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
		expect(calls).toEqual([]);
	});

	it('surfaces a failing list (e.g. 403) instead of hiding it', async () => {
		const { ctx } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek' },
			responses: [httpError(403, 'Missing permission: Manage Webhooks')],
		});
		await expect(hooks.checkExists.call(ctx)).rejects.toThrow();
	});
});

/* ---------- create ---------- */

describe('create', () => {
	it('registers the node URL with a generated 32-byte hex secret and stores id + secret', async () => {
		const { ctx, calls, staticData } = hookContext({
			responses: [[], { identifier: 'whk_new', url: HOOK_URL, active: true }],
		});
		expect(await hooks.create.call(ctx)).toBe(true);

		const post = calls.find((c) => c.method === 'POST');
		expect(post?.url).toBe(LIST_PATH);
		const body = post?.body as IDataObject;
		expect(body.url).toBe(HOOK_URL);
		expect(body.name).toBe('n8n');
		expect(body.eventTypes).toEqual(['task-created', 'task-status-changed']);
		expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(body).not.toHaveProperty('scopeType');
		expect(staticData).toEqual({
			webhookId: 'whk_new',
			secret: body.secret,
			workspace: 'ws-1',
			source: 'pm',
		});
	});

	it('generates a fresh secret every time', async () => {
		const a = hookContext({ responses: [[], { identifier: 'whk_a' }] });
		const b = hookContext({ responses: [[], { identifier: 'whk_b' }] });
		await hooks.create.call(a.ctx);
		await hooks.create.call(b.ctx);
		expect(a.staticData.secret).not.toBe(b.staticData.secret);
	});

	it('refuses to register without any event', async () => {
		const { ctx, calls } = hookContext({ params: { events: [] }, responses: [[]] });
		await expect(hooks.create.call(ctx)).rejects.toThrow(/event/i);
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('sends a list scope', async () => {
		const { ctx, calls } = hookContext({
			params: { scopeType: 'TASK_LIST', scopeList: 'lst_9' },
			responses: [[], { identifier: 'whk_new' }],
		});
		await hooks.create.call(ctx);
		const body = calls.find((c) => c.method === 'POST')?.body as IDataObject;
		expect(body.scopeType).toBe('TASK_LIST');
		expect(body.scopeEntityIdentifier).toBe('lst_9');
	});

	it('resolves a task key scope to its tsk_ ID', async () => {
		const { ctx, calls } = hookContext({
			params: { scopeType: 'TASK', scopeTask: 'PROJ-42' },
			responses: [{ identifier: 'tsk_42' }, [], { identifier: 'whk_new' }],
		});
		await hooks.create.call(ctx);
		const lookup = calls.find((c) => c.url.includes('/tasks/lite/'));
		expect(lookup?.url).toBe(`${BASE}/mp/api/v1/tasks/lite/PROJ-42`);
		const body = calls.find((c) => c.method === 'POST')?.body as IDataObject;
		expect(body.scopeType).toBe('TASK');
		expect(body.scopeEntityIdentifier).toBe('tsk_42');
	});

	it('reuses a leftover webhook at this URL (its secret is lost) via PUT with a fresh secret, creating nothing', async () => {
		const { ctx, calls, staticData } = hookContext({
			responses: [
				[
					{ identifier: 'whk_other', url: 'https://elsewhere.example.com/h' },
					{ identifier: 'whk_orphan', url: HOOK_URL, active: true },
				],
				{ identifier: 'whk_orphan', url: HOOK_URL, active: true },
			],
		});
		expect(await hooks.create.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${LIST_PATH}`,
			`PUT ${LIST_PATH}/whk_orphan`,
		]);
		const body = calls[1].body as IDataObject;
		expect(body).toEqual({
			secret: body.secret,
			eventTypes: ['task-created', 'task-status-changed'],
			active: true,
		});
		expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect((calls[1].headers as IDataObject)['X-Dutify-Workspace']).toBe('ws-1');
		expect(staticData).toEqual({
			webhookId: 'whk_orphan',
			secret: body.secret,
			workspace: 'ws-1',
			source: 'pm',
		});
	});

	it('resumes a paused webhook at this URL (PUT active:true) instead of adding one more row to the quota', async () => {
		const { ctx, calls, staticData } = hookContext({
			staticData: { webhookId: 'whk_used', secret: 'old', workspace: 'ws-1' },
			responses: [
				[
					{
						identifier: 'whk_used',
						url: HOOK_URL,
						active: false,
						pauseReasonCode: 'SUSTAINED_DELIVERY_FAILURES',
					},
				],
				{ identifier: 'whk_used', active: true },
			],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${LIST_PATH}`,
			`PUT ${LIST_PATH}/whk_used`,
		]);
		expect((calls[1].body as IDataObject).active).toBe(true);
		expect(staticData.webhookId).toBe('whk_used');
		expect(staticData.secret).not.toBe('old');
		expect(staticData.secret).toBe((calls[1].body as IDataObject).secret);
	});

	it('with a paused and an active row at this URL, reuses the active one and leaves the paused one alone', async () => {
		const { ctx, calls, staticData } = hookContext({
			responses: [
				[
					{
						identifier: 'whk_paused',
						url: HOOK_URL,
						active: false,
						createdAt: '2026-10-24T10:00:00Z',
					},
					{
						identifier: 'whk_live',
						url: HOOK_URL,
						active: true,
						createdAt: '2026-10-20T10:00:00Z',
					},
				],
				{ identifier: 'whk_live', active: true },
			],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${LIST_PATH}`,
			`PUT ${LIST_PATH}/whk_live`,
		]);
		expect(staticData.webhookId).toBe('whk_live');
	});

	it('with only paused rows at this URL, resumes the newest', async () => {
		const { ctx, calls, staticData } = hookContext({
			responses: [
				[
					{ identifier: 'whk_a', url: HOOK_URL, active: false, createdAt: '2026-10-20T10:00:00Z' },
					{ identifier: 'whk_b', url: HOOK_URL, active: false, createdAt: '2026-10-24T10:00:00Z' },
					{ identifier: 'whk_c', url: HOOK_URL, active: false, createdAt: '2026-10-22T10:00:00Z' },
				],
				{ identifier: 'whk_b', active: true },
			],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${LIST_PATH}`,
			`PUT ${LIST_PATH}/whk_b`,
		]);
		expect(staticData.webhookId).toBe('whk_b');
	});

	it('with two active rows at this URL, reuses the newest and removes the other so only one delivers', async () => {
		const { ctx, calls, staticData } = hookContext({
			responses: [
				[
					{ identifier: 'whk_old', url: HOOK_URL, active: true, createdAt: '2026-10-20T10:00:00Z' },
					{ identifier: 'whk_new', url: HOOK_URL, active: true, createdAt: '2026-10-24T10:00:00Z' },
				],
				httpError(409, 'Webhook has deliveries'),
				{ identifier: 'whk_old', active: false },
				{ identifier: 'whk_new', active: true },
			],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${LIST_PATH}`,
			`DELETE ${LIST_PATH}/whk_old`,
			`PUT ${LIST_PATH}/whk_old`,
			`PUT ${LIST_PATH}/whk_new`,
		]);
		expect(calls[2].body).toEqual({ active: false });
		expect((calls[3].body as IDataObject).active).toBe(true);
		expect(staticData.webhookId).toBe('whk_new');
	});

	it('clears the scope of a reused row when the trigger now watches the whole workspace', async () => {
		const { ctx, calls } = hookContext({
			responses: [
				[
					{
						identifier: 'whk_1',
						url: HOOK_URL,
						active: false,
						scopeType: 'SPACE',
						scopeEntityIdentifier: 'spc_1',
					},
				],
				{ identifier: 'whk_1', active: true },
			],
		});
		await hooks.create.call(ctx);
		const body = calls[1].body as IDataObject;
		expect(calls[1].method).toBe('PUT');
		expect(body.clearScope).toBe(true);
		expect(body).not.toHaveProperty('scopeType');
	});

	it('sets the new scope on a reused row', async () => {
		const { ctx, calls } = hookContext({
			params: { scopeType: 'TASK_LIST', scopeList: 'lst_9' },
			responses: [
				[
					{
						identifier: 'whk_1',
						url: HOOK_URL,
						active: true,
						scopeType: 'SPACE',
						scopeEntityIdentifier: 'spc_1',
					},
				],
				{ identifier: 'whk_1', active: true },
			],
		});
		await hooks.create.call(ctx);
		const body = calls[1].body as IDataObject;
		expect(body.scopeType).toBe('TASK_LIST');
		expect(body.scopeEntityIdentifier).toBe('lst_9');
		expect(body).not.toHaveProperty('clearScope');
	});

	it('leaves the stored webhook alone when it is at another URL (test mode must not delete the production hook)', async () => {
		const { ctx, calls } = hookContext({
			webhookUrl: 'https://n8n.example.com/webhook-test/7f3a/webhook',
			staticData: { webhookId: 'whk_prod', secret: 'prod', workspace: 'ws-1' },
			responses: [[{ identifier: 'whk_prod', url: HOOK_URL }], { identifier: 'whk_test' }],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${LIST_PATH}`,
			`POST ${LIST_PATH}`,
		]);
	});

	it('reuses the stored webhook when it is at this URL, with a fresh secret', async () => {
		const { ctx, calls, staticData } = hookContext({
			staticData: { webhookId: 'whk_old', secret: 'old', workspace: 'ws-1' },
			responses: [[{ identifier: 'whk_old', url: HOOK_URL }], { identifier: 'whk_old' }],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${LIST_PATH}`,
			`PUT ${LIST_PATH}/whk_old`,
		]);
		expect(staticData.webhookId).toBe('whk_old');
		expect(staticData.secret).not.toBe('old');
	});

	it('removes the stored webhook at this URL in the workspace it was registered in', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: { workspace: 'ws-new' },
			staticData: { webhookId: 'whk_old', secret: 'old', workspace: 'ws-old' },
			responses: [
				[],
				[{ identifier: 'whk_old', url: HOOK_URL }],
				undefined,
				{ identifier: 'whk_new' },
			],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${BASE}/mp/api/v1/workspaces/ws-new/webhooks`,
			`GET ${OLD_WS_PATH}`,
			`DELETE ${OLD_WS_PATH}/whk_old`,
			`POST ${BASE}/mp/api/v1/workspaces/ws-new/webhooks`,
		]);
		expect(staticData.workspace).toBe('ws-new');
	});

	it('leaves webhooks of other URLs alone', async () => {
		const { ctx, calls } = hookContext({
			responses: [
				[{ identifier: 'whk_other', url: 'https://elsewhere.example.com/h' }],
				{ identifier: 'whk_new' },
			],
		});
		await hooks.create.call(ctx);
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
	});

	/*
	 * PM refuses to delete a webhook that ever delivered (409 ENTITY_IN_USE). The stored webhook
	 * of a previous workspace is then paused (PUT active:false), and the trigger registers anew.
	 */
	it('pauses the stored webhook of the previous workspace when it cannot be deleted (409), then registers', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: { workspace: 'ws-new' },
			staticData: { webhookId: 'whk_old', secret: 'old', workspace: 'ws-old' },
			responses: [
				[],
				[{ identifier: 'whk_old', url: HOOK_URL, active: true }],
				httpError(409, 'Webhook has deliveries'),
				{ identifier: 'whk_old', active: false },
				{ identifier: 'whk_new' },
			],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${BASE}/mp/api/v1/workspaces/ws-new/webhooks`,
			`GET ${OLD_WS_PATH}`,
			`DELETE ${OLD_WS_PATH}/whk_old`,
			`PUT ${OLD_WS_PATH}/whk_old`,
			`POST ${BASE}/mp/api/v1/workspaces/ws-new/webhooks`,
		]);
		expect(calls[3].body).toEqual({ active: false });
		expect(staticData).toEqual({
			webhookId: 'whk_new',
			secret: (calls[4].body as IDataObject).secret,
			workspace: 'ws-new',
			source: 'pm',
		});
	});

	it('surfaces a rejected reuse (PUT) as the NodeApiError and stores nothing', async () => {
		const { ctx, staticData } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'old', workspace: 'ws-1' },
			responses: [[{ identifier: 'whk_1', url: HOOK_URL, active: false }], httpError(500, 'boom')],
		});
		const error = await hooks.create.call(ctx).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as NodeApiError).message).toBe('boom');
		expect(staticData).toEqual({});
	});

	it('surfaces a rejected create (e.g. plan limit) and stores nothing', async () => {
		const { ctx, staticData } = hookContext({
			responses: [[], httpError(400, 'Webhook limit reached for your plan')],
		});
		await expect(hooks.create.call(ctx)).rejects.toThrow(/limit/);
		expect(staticData).toEqual({});
	});
});

/* ---------- delete ---------- */

/* ---------- Codexum (wiki) and Roadmarq (feature requests) sources ---------- */

describe('codexum and roadmarq sources (PM subscriptions with product events)', () => {
	const posted = (calls: Recorded[]) => calls.find((c) => c.method === 'POST')?.body as IDataObject;

	it('checkExists and create list only the webhooks at the trigger URL (?url=)', async () => {
		const exists = hookContext({
			params: { source: 'codexum', wikiEvents: ['wiki.page.published'] },
			staticData: { webhookId: 'whk_1', secret: 'sek', workspace: 'ws-1', source: 'codexum' },
			responses: [[{ identifier: 'whk_1', url: HOOK_URL, active: true }]],
		});
		expect(await hooks.checkExists.call(exists.ctx)).toBe(true);
		expect(exists.calls[0].url).toBe(LIST_PATH);
		expect(exists.calls[0].qs).toEqual({ url: HOOK_URL });

		const created = hookContext({ responses: [[], { identifier: 'whk_new' }] });
		await hooks.create.call(created.ctx);
		expect(created.calls[0].method).toBe('GET');
		expect(created.calls[0].qs).toEqual({ url: HOOK_URL });
	});

	it('still filters the list by URL itself, for a server that ignores ?url=', async () => {
		const { ctx } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek', workspace: 'ws-1', source: 'pm' },
			responses: [[{ identifier: 'whk_1', url: 'https://elsewhere.example.com/h', active: true }]],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
	});

	it('codexumSourceCreatesPmSubscriptionWithWikiScope', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: {
				source: 'codexum',
				wikiEvents: ['wiki.page.published', 'wiki.comment.added'],
				wikiScopeType: 'WIKI_SPACE',
				wikiScopeSpace: 'ENG',
			},
			responses: [[], { identifier: 'whk_new' }],
		});
		expect(await hooks.create.call(ctx)).toBe(true);
		const post = calls.find((c) => c.method === 'POST');
		expect(post?.url).toBe(LIST_PATH);
		const body = post?.body as IDataObject;
		expect(body).toEqual({
			url: HOOK_URL,
			secret: body.secret,
			name: 'n8n',
			eventTypes: ['wiki.page.published', 'wiki.comment.added'],
			scopeType: 'WIKI_SPACE',
			scopeEntityIdentifier: 'ENG',
		});
		expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(staticData).toEqual({
			webhookId: 'whk_new',
			secret: body.secret,
			workspace: 'ws-1',
			source: 'codexum',
		});
	});

	it('codexum: a page scope sends the page ID; the whole workspace sends no scope', async () => {
		const page = hookContext({
			params: {
				source: 'codexum',
				wikiEvents: ['wiki.page.updated'],
				wikiScopeType: 'WIKI_PAGE',
				wikiScopePage: ' 0b9d7c1e-2f3a-4b5c-9d8e-7f6a5b4c3d2e ',
			},
			responses: [[], { identifier: 'whk_new' }],
		});
		await hooks.create.call(page.ctx);
		expect(posted(page.calls)).toMatchObject({
			scopeType: 'WIKI_PAGE',
			scopeEntityIdentifier: '0b9d7c1e-2f3a-4b5c-9d8e-7f6a5b4c3d2e',
		});

		const whole = hookContext({
			params: { source: 'codexum', wikiEvents: ['wiki.page.created'], wikiScopeType: 'WORKSPACE' },
			responses: [[], { identifier: 'whk_new' }],
		});
		await hooks.create.call(whole.ctx);
		expect(posted(whole.calls)).not.toHaveProperty('scopeType');
		expect(posted(whole.calls)).not.toHaveProperty('scopeEntityIdentifier');
		expect(posted(whole.calls).eventTypes).toEqual(['wiki.page.created']);
	});

	it('roadmarqSourceCreatesFeedbackBoardScope', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: {
				source: 'roadmarq',
				feedbackEvents: ['feedback.request.created'],
				feedbackScopeType: 'FEEDBACK_BOARD',
				feedbackScopeBoard: 'public-roadmap',
			},
			responses: [[], { identifier: 'whk_new' }],
		});
		await hooks.create.call(ctx);
		expect(posted(calls)).toEqual({
			url: HOOK_URL,
			secret: posted(calls).secret,
			name: 'n8n',
			eventTypes: ['feedback.request.created'],
			scopeType: 'FEEDBACK_BOARD',
			scopeEntityIdentifier: 'public-roadmap',
		});
		expect(staticData.source).toBe('roadmarq');
	});

	it('roadmarq: a request or bug scope sends its short key', async () => {
		for (const [scopeType, param, key] of [
			['FEEDBACK_REQUEST', 'feedbackScopeRequest', 'FR-12'],
			['FEEDBACK_BUG', 'feedbackScopeBug', 'BG-3'],
		]) {
			const { ctx, calls } = hookContext({
				params: {
					source: 'roadmarq',
					feedbackEvents: ['feedback.comment.added'],
					feedbackScopeType: scopeType,
					[param]: key,
				},
				responses: [[], { identifier: 'whk_new' }],
			});
			await hooks.create.call(ctx);
			expect(posted(calls)).toMatchObject({ scopeType, scopeEntityIdentifier: key });
		}
	});

	it('shortKeysUppercased: a typed fr-12 or bg-3 is sent as FR-12 / BG-3; an ID is sent as typed', async () => {
		for (const [scopeType, param, typed, sent] of [
			['FEEDBACK_REQUEST', 'feedbackScopeRequest', ' fr-12 ', 'FR-12'],
			['FEEDBACK_BUG', 'feedbackScopeBug', 'bg-3', 'BG-3'],
			[
				'FEEDBACK_REQUEST',
				'feedbackScopeRequest',
				'0b9d7c1e-2f3a-4b5c-9d8e-7f6a5b4c3d2e',
				'0b9d7c1e-2f3a-4b5c-9d8e-7f6a5b4c3d2e',
			],
		]) {
			const { ctx, calls } = hookContext({
				params: {
					source: 'roadmarq',
					feedbackEvents: ['feedback.comment.added'],
					feedbackScopeType: scopeType,
					[param]: typed,
				},
				responses: [[], { identifier: 'whk_new' }],
			});
			await hooks.create.call(ctx);
			expect(posted(calls)).toMatchObject({ scopeType, scopeEntityIdentifier: sent });
		}
	});

	const pmRefusal = (status: number, message: string, errorCode: string) =>
		Object.assign(new Error(message), {
			httpCode: String(status),
			response: { body: { message, errorCode } },
		});

	it('activationRefusalReadable: a 400 from PM names PM message, keeps the status and says how to fix it', async () => {
		const { ctx, staticData } = hookContext({
			params: {
				source: 'codexum',
				wikiEvents: ['wiki.space.updated'],
				wikiScopeType: 'WIKI_PAGE',
				wikiScopePage: 'pg-1',
			},
			responses: [
				[],
				pmRefusal(400, 'wiki.space.updated cannot be scoped to WIKI_PAGE', 'VALIDATION_ERROR'),
			],
		});
		const error = (await hooks.create.call(ctx).catch((e: unknown) => e)) as NodeApiError;
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.httpCode).toBe('400');
		expect(error.message).toMatch(/^Dutify refused the trigger's webhook: /);
		expect(error.message).toContain('wiki.space.updated cannot be scoped to WIKI_PAGE');
		expect(error.description).toMatch(/VALIDATION_ERROR/);
		expect(error.description).toMatch(/events|scope/i);
		expect(staticData).toEqual({});
	});

	it('activationRefusalReadable: a 403 WEBHOOK_SCOPE_REQUIRES_USER on reuse says to use a personal API key', async () => {
		const { ctx, calls } = hookContext({
			params: {
				source: 'roadmarq',
				feedbackEvents: ['feedback.request.created'],
				feedbackScopeType: 'FEEDBACK_BOARD',
				feedbackScopeBoard: 'public-roadmap',
			},
			responses: [
				[{ identifier: 'whk_1', url: HOOK_URL, active: true }],
				pmRefusal(
					403,
					'A workspace API key cannot hold a webhook scoped to FEEDBACK_BOARD. Use it without a scope, or use a personal API key or sign in.',
					'WEBHOOK_SCOPE_REQUIRES_USER',
				),
			],
		});
		const error = (await hooks.create.call(ctx).catch((e: unknown) => e)) as NodeApiError;
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.httpCode).toBe('403');
		expect(error.message).toMatch(/^Dutify refused the trigger's webhook: A workspace API key/);
		expect(error.description).toMatch(/WEBHOOK_SCOPE_REQUIRES_USER/);
		expect(error.description).toMatch(/personal API key/);
		expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
	});

	it('scopeEntityGone: a webhook PM paused because its scoped item was deleted is not resumed with the same scope', async () => {
		const { ctx, calls } = hookContext({
			params: {
				source: 'codexum',
				wikiEvents: ['wiki.page.updated'],
				wikiScopeType: 'WIKI_SPACE',
				wikiScopeSpace: 'eng',
			},
			staticData: { webhookId: 'whk_1', secret: 'old', workspace: 'ws-1', source: 'codexum' },
			responses: [
				[
					{
						identifier: 'whk_1',
						url: HOOK_URL,
						active: false,
						scopeType: 'WIKI_SPACE',
						scopeEntityIdentifier: 'ENG',
						pauseReason: 'SCOPE_ENTITY_GONE',
						pauseReasonCode: 'SCOPE_ENTITY_GONE',
					},
				],
			],
		});
		await expect(hooks.create.call(ctx)).rejects.toThrow(
			/scoped .*was deleted.*choose another scope/i,
		);
		expect(calls.map((c) => c.method)).toEqual(['GET']);
	});

	it('scopeEntityGone: with a new scope the paused webhook is resumed with it', async () => {
		const { ctx, calls } = hookContext({
			params: {
				source: 'codexum',
				wikiEvents: ['wiki.page.updated'],
				wikiScopeType: 'WIKI_SPACE',
				wikiScopeSpace: 'OPS',
			},
			responses: [
				[
					{
						identifier: 'whk_1',
						url: HOOK_URL,
						active: false,
						scopeType: 'WIKI_SPACE',
						scopeEntityIdentifier: 'ENG',
						pauseReasonCode: 'SCOPE_ENTITY_GONE',
					},
				],
				{ identifier: 'whk_1', active: true },
			],
		});
		expect(await hooks.create.call(ctx)).toBe(true);
		expect(calls[1]).toMatchObject({
			method: 'PUT',
			body: { scopeType: 'WIKI_SPACE', scopeEntityIdentifier: 'OPS', active: true },
		});
	});

	it('scopeEntityGone: a resume answered 404 "Scope entity not found" says the item was deleted, and creates nothing', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: {
				source: 'roadmarq',
				feedbackEvents: ['feedback.comment.added'],
				feedbackScopeType: 'FEEDBACK_REQUEST',
				feedbackScopeRequest: 'FR-12',
			},
			staticData: { webhookId: 'whk_1', secret: 'old', workspace: 'ws-1', source: 'roadmarq' },
			responses: [
				[
					{
						identifier: 'whk_1',
						url: HOOK_URL,
						active: false,
						scopeType: 'FEEDBACK_REQUEST',
						scopeEntityIdentifier: '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
					},
				],
				pmRefusal(404, 'Scope entity not found', 'WEBHOOK_SCOPE_ENTITY_NOT_FOUND'),
			],
		});
		await expect(hooks.create.call(ctx)).rejects.toThrow(
			/scoped .*was deleted.*choose another scope/i,
		);
		expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
		expect(staticData).toEqual({});
	});

	it('a new webhook whose scope PM cannot find (404) says the item was not found', async () => {
		const { ctx, calls } = hookContext({
			params: {
				source: 'roadmarq',
				feedbackEvents: ['feedback.comment.added'],
				feedbackScopeType: 'FEEDBACK_BUG',
				feedbackScopeBug: 'BG-999',
			},
			responses: [[], pmRefusal(404, 'Scope entity not found', 'WEBHOOK_SCOPE_ENTITY_NOT_FOUND')],
		});
		await expect(hooks.create.call(ctx)).rejects.toThrow(/BG-999.*not found/i);
		expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
	});

	it('never sends the security-bug opt-in (Dutify refuses it for API keys)', async () => {
		const { ctx, calls } = hookContext({
			params: { source: 'roadmarq', feedbackEvents: ['feedback.bug.created'] },
			responses: [[], { identifier: 'whk_new' }],
		});
		await hooks.create.call(ctx);
		expect(posted(calls)).not.toHaveProperty('includeSecurityBugs');
	});

	it('refuses to register without an event, and without a scope target', async () => {
		const none = hookContext({
			params: { source: 'codexum', wikiEvents: [] },
			responses: [[]],
		});
		await expect(hooks.create.call(none.ctx)).rejects.toThrow(/event/i);
		expect(none.calls.some((c) => c.method === 'POST')).toBe(false);

		const noBoard = hookContext({
			params: {
				source: 'roadmarq',
				feedbackEvents: ['feedback.request.created'],
				feedbackScopeType: 'FEEDBACK_BOARD',
				feedbackScopeBoard: '  ',
			},
			responses: [[]],
		});
		await expect(hooks.create.call(noBoard.ctx)).rejects.toThrow(/scope/i);
		expect(noBoard.calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('a Source change from pm to codexum re-registers the same webhook (PUT), deleting nothing', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: {
				source: 'codexum',
				wikiEvents: ['wiki.page.published'],
				wikiScopeType: 'WORKSPACE',
			},
			staticData: { webhookId: 'whk_1', secret: 'old', workspace: 'ws-1', source: 'pm' },
			responses: [
				[{ identifier: 'whk_1', url: HOOK_URL, active: true, scopeType: 'SPACE' }],
				{ identifier: 'whk_1' },
			],
		});
		expect(await hooks.create.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${LIST_PATH}`,
			`PUT ${LIST_PATH}/whk_1`,
		]);
		const body = calls[1].body as IDataObject;
		expect(body).toEqual({
			secret: body.secret,
			eventTypes: ['wiki.page.published'],
			active: true,
			clearScope: true,
		});
		expect(staticData).toMatchObject({ webhookId: 'whk_1', source: 'codexum' });
	});

	it('signatureVerifiesConformanceFixture: PM-signed deliveries verify, for every product source', async () => {
		const { envelope, secret, signature } = conformanceFixture();
		expect(verifySignature(secret, envelope, signature)).toBe(true);
		expect(verifySignature(`${secret}x`, envelope, signature)).toBe(false);
		expect(JSON.parse(envelope.toString('utf8'))).toMatchObject({
			version: '1',
			source: 'codexum',
			eventId: expect.any(String),
		});
		for (const source of ['codexum', 'roadmarq', 'pm']) {
			expect(sources[source].signatureHeader).toBe('x-webhook-signature-256');
		}
	});
});

describe('delete', () => {
	it('removes the stored webhook and clears the static data', async () => {
		const { ctx, calls, staticData } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek' },
			responses: [undefined],
		});
		expect(await hooks.delete.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${LIST_PATH}/whk_1`]);
		expect(staticData).toEqual({});
	});

	it('treats a webhook already gone (404) as deleted', async () => {
		const { ctx, staticData } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek' },
			responses: [httpError(404, 'Webhook not found')],
		});
		expect(await hooks.delete.call(ctx)).toBe(true);
		expect(staticData).toEqual({});
	});

	it('pauses a webhook that cannot be deleted (409, it has deliveries) and clears the static data', async () => {
		const { ctx, calls, staticData } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek', workspace: 'ws-1' },
			responses: [httpError(409, 'Webhook has deliveries'), { identifier: 'whk_1', active: false }],
		});
		expect(await hooks.delete.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`DELETE ${LIST_PATH}/whk_1`,
			`PUT ${LIST_PATH}/whk_1`,
		]);
		expect(calls[1].body).toEqual({ active: false });
		expect((calls[1].headers as IDataObject)['X-Dutify-Workspace']).toBe('ws-1');
		expect(staticData).toEqual({});
	});

	it('reports failure when the 409 webhook cannot be paused either, keeping the static data', async () => {
		const { ctx, staticData } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek' },
			responses: [httpError(409, 'Webhook has deliveries'), httpError(500, 'boom')],
		});
		expect(await hooks.delete.call(ctx)).toBe(false);
		expect(staticData).toEqual({ webhookId: 'whk_1', secret: 'sek' });
	});

	it('reports failure on another error and keeps the static data so it can be retried', async () => {
		const { ctx, staticData } = hookContext({
			staticData: { webhookId: 'whk_1', secret: 'sek' },
			responses: [httpError(500, 'boom')],
		});
		expect(await hooks.delete.call(ctx)).toBe(false);
		expect(staticData).toEqual({ webhookId: 'whk_1', secret: 'sek' });
	});

	it('deletes in the stored workspace even after the workspace parameter changed', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: { workspace: 'ws-new' },
			staticData: { webhookId: 'whk_1', secret: 'sek', workspace: 'ws-old' },
			responses: [undefined],
		});
		expect(await hooks.delete.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${OLD_WS_PATH}/whk_1`]);
		expect((calls[0].headers as IDataObject)['X-Dutify-Workspace']).toBe('ws-old');
		expect(staticData).toEqual({});
	});

	it('a failed stale removal in create surfaces as the NodeApiError with Dutify message and status', async () => {
		const { ctx } = hookContext({
			responses: [
				[
					{ identifier: 'whk_a', url: HOOK_URL, active: true, createdAt: '2026-10-20T10:00:00Z' },
					{ identifier: 'whk_b', url: HOOK_URL, active: true, createdAt: '2026-10-24T10:00:00Z' },
				],
				httpError(500, 'boom'),
			],
		});
		const error = await hooks.create.call(ctx).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as NodeApiError).message).toBe('boom');
		expect((error as NodeApiError).httpCode).toBe('500');
	});

	it('does nothing without a stored webhook', async () => {
		const { ctx, calls } = hookContext({});
		expect(await hooks.delete.call(ctx)).toBe(true);
		expect(calls).toEqual([]);
	});
});

/* ---------- meeting source lifecycle ---------- */

describe('meeting source (Hub "meeting processed")', () => {
	const HUB_HOOKS = `${BASE}/api/user/webhooks`;
	const meetingParams = { source: 'meeting', sections: ['summary', 'actionItems'] };

	it('create registers the node URL with a fresh secret and the sections, in the workspace header', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: meetingParams,
			responses: [[], { id: 42, url: HOOK_URL, hasSecret: true }],
		});
		expect(await hooks.create.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${HUB_HOOKS}`,
			`POST ${HUB_HOOKS}`,
		]);
		const body = calls[1].body as IDataObject;
		expect(body).toEqual({
			url: HOOK_URL,
			secret: body.secret,
			name: 'n8n',
			sections: ['summary', 'actionItems'],
		});
		expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
		for (const call of calls) {
			expect((call.headers as IDataObject)['X-Dutify-Workspace']).toBe('ws-1');
		}
		expect(staticData).toEqual({
			webhookId: '42',
			secret: body.secret,
			workspace: 'ws-1',
			source: 'meeting',
		});
	});

	it('create needs no PM events', async () => {
		const { ctx } = hookContext({
			params: { ...meetingParams, events: [] },
			responses: [[], { id: 42 }],
		});
		expect(await hooks.create.call(ctx)).toBe(true);
	});

	it('create reuses a paused webhook already at this URL (PUT with the URL, enabled) instead of adding one', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: meetingParams,
			responses: [
				[
					{ id: 7, url: 'https://elsewhere.example.com/h', enabled: true },
					{ id: 9, url: HOOK_URL, enabled: false },
				],
				{ id: 9, url: HOOK_URL, enabled: true },
			],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${HUB_HOOKS}`,
			`PUT ${HUB_HOOKS}/9`,
		]);
		const body = calls[1].body as IDataObject;
		expect(body).toEqual({
			url: HOOK_URL,
			secret: body.secret,
			sections: ['summary', 'actionItems'],
			enabled: true,
		});
		expect(staticData).toEqual({
			webhookId: '9',
			secret: body.secret,
			workspace: 'ws-1',
			source: 'meeting',
		});
	});

	it('create keeps one webhook per URL: an active one is reused, a second active one removed', async () => {
		const { ctx, calls } = hookContext({
			params: meetingParams,
			responses: [
				[
					{ id: 9, url: HOOK_URL, enabled: true },
					{ id: 11, url: HOOK_URL, enabled: true },
				],
				undefined,
				{ id: 9 },
			],
		});
		await hooks.create.call(ctx);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${HUB_HOOKS}`,
			`DELETE ${HUB_HOOKS}/11`,
			`PUT ${HUB_HOOKS}/9`,
		]);
	});

	it('checkExists is true while the stored webhook is listed, switched on, at this URL', async () => {
		const { ctx, calls } = hookContext({
			params: meetingParams,
			staticData: { webhookId: '42', secret: 'sek', workspace: 'ws-1' },
			responses: [[{ id: 42, url: HOOK_URL, enabled: true }]],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${HUB_HOOKS}`]);
	});

	it('checkExists is false when the stored webhook is switched off in Hub, so create turns it on', async () => {
		const { ctx } = hookContext({
			params: meetingParams,
			staticData: { webhookId: '42', secret: 'sek', workspace: 'ws-1' },
			responses: [[{ id: 42, url: HOOK_URL, enabled: false }]],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
	});

	it('delete removes the stored webhook and clears the static data', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: meetingParams,
			staticData: { webhookId: '42', secret: 'sek', workspace: 'ws-1' },
			responses: [undefined],
		});
		expect(await hooks.delete.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${HUB_HOOKS}/42`]);
		expect(staticData).toEqual({});
	});

	it('delete treats 404 as gone; any other refusal (no pause fallback for Hub) keeps the static data', async () => {
		const gone = hookContext({
			params: meetingParams,
			staticData: { webhookId: '42', secret: 'sek' },
			responses: [httpError(404, 'No such webhook')],
		});
		expect(await hooks.delete.call(gone.ctx)).toBe(true);
		expect(gone.staticData).toEqual({});

		const refused = hookContext({
			params: meetingParams,
			staticData: { webhookId: '42', secret: 'sek' },
			responses: [httpError(409, 'conflict')],
		});
		expect(await hooks.delete.call(refused.ctx)).toBe(false);
		expect(refused.calls).toHaveLength(1);
		expect(refused.staticData).toEqual({ webhookId: '42', secret: 'sek' });
	});
});

/* ---------- webhook() ---------- */

function webhookContext(opts: {
	source?: string;
	staticData?: IDataObject;
	rawBody?: Buffer;
	headers?: Record<string, string>;
	body?: IDataObject;
	/** What `readRawBody()` puts on the request; omitted, it leaves rawBody as it is. */
	readsRawBody?: Buffer;
}) {
	const response = { statusCode: 200, sent: undefined as unknown, ended: false, rawReads: 0 };
	const req: IDataObject & { rawBody?: Buffer } = {
		rawBody: opts.rawBody,
		headers: opts.headers ?? {},
		body: opts.body,
		async readRawBody() {
			response.rawReads++;
			if (opts.readsRawBody) {
				req.rawBody = opts.readsRawBody;
			}
		},
	};
	const res = {
		status(code: number) {
			response.statusCode = code;

			return res;
		},
		json(payload: unknown) {
			response.sent = payload;
			response.ended = true;

			return res;
		},
		send(payload: unknown) {
			response.sent = payload;
			response.ended = true;

			return res;
		},
		end() {
			response.ended = true;

			return res;
		},
	};
	const ctx = {
		getNodeParameter(name: string, fallback?: unknown) {
			return name === 'source' ? (opts.source ?? 'pm') : fallback;
		},
		getWorkflowStaticData: () => opts.staticData ?? {},
		getRequestObject: () => req,
		getResponseObject: () => res,
		getHeaderData: () => opts.headers ?? {},
		getBodyData: () => opts.body ?? {},
		getNode: () => ({ name: 'Dutify Trigger' }),
	};

	return { ctx: ctx as unknown as IWebhookFunctions, response };
}

describe('webhook()', () => {
	const secret = 'c'.repeat(64);
	const body = {
		version: '1',
		id: 'whd_1',
		type: 'task-created',
		timestamp: '2026-10-25T10:00:00Z',
		workspaceIdentifier: 'ws-1',
		data: { identifier: 'tsk_1', title: 'Hello' },
	};
	const raw = Buffer.from(JSON.stringify(body));
	const goodHeaders = {
		'x-webhook-signature-256': sign(secret, raw),
		'x-webhook-event': 'task-created',
		'x-webhook-delivery': 'whd_1',
	};

	it('with a good signature starts the workflow with the delivered body', async () => {
		const { ctx, response } = webhookContext({
			staticData: { webhookId: 'whk_1', secret },
			rawBody: raw,
			headers: goodHeaders,
			body,
		});
		const result = await trigger.webhook.call(ctx);
		expect(result.workflowData).toEqual([[{ json: body }]]);
		expect(response.statusCode).toBe(200);
	});

	it('reads the raw body when n8n has not buffered it yet, then verifies it', async () => {
		const { ctx, response } = webhookContext({
			staticData: { webhookId: 'whk_1', secret },
			rawBody: undefined,
			readsRawBody: raw,
			headers: goodHeaders,
			body,
		});
		const result = await trigger.webhook.call(ctx);
		expect(response.rawReads).toBe(1);
		expect(result.workflowData).toEqual([[{ json: body }]]);
	});

	it('does not re-read a raw body that is already there', async () => {
		const { ctx, response } = webhookContext({
			staticData: { webhookId: 'whk_1', secret },
			rawBody: raw,
			headers: goodHeaders,
			body,
		});
		await trigger.webhook.call(ctx);
		expect(response.rawReads).toBe(0);
	});

	it('answers 401 when the raw body stays missing, even with a signature', async () => {
		const { ctx, response } = webhookContext({
			staticData: { webhookId: 'whk_1', secret },
			rawBody: undefined,
			headers: goodHeaders,
			body,
		});
		const result = await trigger.webhook.call(ctx);
		expect(result.workflowData).toBeUndefined();
		expect(response.statusCode).toBe(401);
	});

	it('with a wrong signature answers 401 and does not start the workflow', async () => {
		const { ctx, response } = webhookContext({
			staticData: { webhookId: 'whk_1', secret },
			rawBody: raw,
			headers: { ...goodHeaders, 'x-webhook-signature-256': sign('wrong', raw) },
			body,
		});
		const result = await trigger.webhook.call(ctx);
		expect(result.workflowData).toBeUndefined();
		expect(result.noWebhookResponse).toBe(true);
		expect(response.statusCode).toBe(401);
		expect(response.ended).toBe(true);
	});

	it('with no signature header answers 401 and does not start the workflow', async () => {
		const { ctx, response } = webhookContext({
			staticData: { webhookId: 'whk_1', secret },
			rawBody: raw,
			headers: { 'x-webhook-event': 'task-created' },
			body,
		});
		const result = await trigger.webhook.call(ctx);
		expect(result.workflowData).toBeUndefined();
		expect(response.statusCode).toBe(401);
	});

	it('with a body changed after signing answers 401', async () => {
		const tampered = { ...body, data: { identifier: 'tsk_2' } };
		const { ctx, response } = webhookContext({
			staticData: { webhookId: 'whk_1', secret },
			rawBody: Buffer.from(JSON.stringify(tampered)),
			headers: goodHeaders,
			body: tampered,
		});
		const result = await trigger.webhook.call(ctx);
		expect(result.workflowData).toBeUndefined();
		expect(response.statusCode).toBe(401);
	});

	it('without a stored secret answers 401 (nothing can be verified)', async () => {
		const { ctx, response } = webhookContext({
			staticData: {},
			rawBody: raw,
			headers: { 'x-webhook-signature-256': sign('', raw) },
			body,
		});
		const result = await trigger.webhook.call(ctx);
		expect(result.workflowData).toBeUndefined();
		expect(response.statusCode).toBe(401);
	});
});

describe('webhook() for the meeting source', () => {
	const secret = 'd'.repeat(64);
	const body = {
		event: 'meeting.processed',
		test: false,
		hubUrl: 'https://dutify.ai/call/7',
		sentAt: '2026-10-25T10:00:00Z',
		meeting: { recordingId: 501, callId: 7, title: 'Standup', summary: 'Two action items' },
	};
	const raw = Buffer.from(JSON.stringify(body));

	it('accepts X-Dutify-Signature: sha256=<HMAC-SHA256 of the raw body> and starts the workflow', async () => {
		const { ctx, response } = webhookContext({
			source: 'meeting',
			staticData: { webhookId: '42', secret },
			rawBody: raw,
			headers: { 'x-dutify-signature': sign(secret, raw), 'x-dutify-delivery-id': 'k1' },
			body,
		});
		const result = await trigger.webhook.call(ctx);
		expect(result.workflowData).toEqual([[{ json: body }]]);
		expect(response.statusCode).toBe(200);
	});

	it('answers 401 to a delivery signed with another secret, or unsigned', async () => {
		for (const headers of [
			{ 'x-dutify-signature': sign('other', raw) },
			{},
			// The PM header does not count for the meeting source.
			{ 'x-webhook-signature-256': sign(secret, raw) },
		]) {
			const { ctx, response } = webhookContext({
				source: 'meeting',
				staticData: { webhookId: '42', secret },
				rawBody: raw,
				headers,
				body,
			});
			const result = await trigger.webhook.call(ctx);
			expect(result.workflowData).toBeUndefined();
			expect(response.statusCode).toBe(401);
		}
	});
});

/* ---------- description ---------- */

describe('description', () => {
	const props = trigger.description.properties;
	const prop = (name: string) => props.find((p) => p.name === name) as INodeProperties;

	it('is a webhook trigger with no inputs, the Dutify credential and the Dutify icon', () => {
		const d = trigger.description;
		expect(d.name).toBe('dutifyTrigger');
		expect(d.displayName).toBe('Dutify Trigger');
		expect(d.group).toEqual(['trigger']);
		expect(d.inputs).toEqual([]);
		expect(d.credentials).toEqual([{ name: 'dutifyApi', required: true }]);
		expect(d.icon).toEqual({
			light: 'file:../../icons/dutify.svg',
			dark: 'file:../../icons/dutify.dark.svg',
		});
		expect(d.webhooks).toEqual([
			expect.objectContaining({ name: 'default', httpMethod: 'POST', responseMode: 'onReceived' }),
		]);
	});

	it('has a source options property with pm (the default), meeting, codexum and roadmarq', () => {
		const source = prop('source');
		expect(source.type).toBe('options');
		expect(source.default).toBe('pm');
		const options = (source.options ?? []) as Array<{ name: string; value: string }>;
		expect(options.map((o) => o.value).sort()).toEqual(['codexum', 'meeting', 'pm', 'roadmarq']);
		expect(options.find((o) => o.value === 'codexum')?.name).toBe('Codexum (Wiki)');
		expect(options.find((o) => o.value === 'roadmarq')?.name).toBe('Roadmarq (Feature Requests)');
	});

	it('the workspace locator is shown for every source (a meeting webhook is bound to it)', () => {
		const ws = prop('workspace');
		expect(ws.type).toBe('resourceLocator');
		expect(ws.required).toBe(true);
		expect([...(ws.displayOptions?.show?.source ?? [])].sort()).toEqual([
			'codexum',
			'meeting',
			'pm',
			'roadmarq',
		]);
		expect(props.filter((p) => p.name === 'workspace')).toHaveLength(1);
		const listMode = ws.modes?.find((m) => m.name === 'list');
		expect(listMode?.typeOptions?.searchListMethod).toBe('searchWorkspaces');
		expect(trigger.methods.listSearch.searchWorkspaces).toBeTypeOf('function');
	});

	it('for meeting: a sections multiOptions over every WebhookSection, preset to the four defaults', () => {
		const sections = prop('sections');
		expect(sections.type).toBe('multiOptions');
		expect(sections.displayOptions?.show?.source).toEqual(['meeting']);
		expect(sections.default).toEqual(['summary', 'keyPoints', 'actionItems', 'tasks']);
		expect((sections.options ?? []).map((o) => (o as { value: string }).value)).toContain(
			'transcript',
		);
	});

	it('for pm: required events multiOptions over PM_EVENT_TYPES', () => {
		const events = prop('events');
		expect(events.type).toBe('multiOptions');
		expect(events.required).toBe(true);
		expect(events.displayOptions?.show?.source).toEqual(['pm']);
		expect((events.options ?? []).map((o) => (o as { value: string }).value)).toEqual(
			PM_EVENT_TYPES,
		);
	});

	it('for pm: an optional scope that defaults to the whole workspace, with a target per scope type', () => {
		const scope = prop('scopeType');
		expect(scope.type).toBe('options');
		expect(scope.default).toBe('WORKSPACE');
		expect(scope.required).toBeFalsy();
		expect(scope.displayOptions?.show?.source).toEqual(['pm']);
		expect((scope.options ?? []).map((o) => (o as { value: string }).value).sort()).toEqual(
			['FOLDER', 'SPACE', 'TASK', 'TASK_LIST', 'WORKSPACE'].sort(),
		);
		const targets: Record<string, string> = {
			scopeSpace: 'SPACE',
			scopeFolder: 'FOLDER',
			scopeList: 'TASK_LIST',
			scopeTask: 'TASK',
		};
		for (const [name, type] of Object.entries(targets)) {
			const target = prop(name);
			expect(target.displayOptions?.show).toEqual({ source: ['pm'], scopeType: [type] });
		}
		for (const method of ['getSpaceIds', 'getFolderIds', 'getListIds']) {
			expect(trigger.methods.loadOptions[method]).toBeTypeOf('function');
		}
	});

	it('for codexum and roadmarq: required events loaded from /event-types for the chosen source', () => {
		for (const [name, source] of [
			['wikiEvents', 'codexum'],
			['feedbackEvents', 'roadmarq'],
		]) {
			const events = prop(name);
			expect(events.type).toBe('multiOptions');
			expect(events.required).toBe(true);
			expect(events.displayOptions?.show?.source).toEqual([source]);
			expect(events.typeOptions?.loadOptionsMethod).toBe('getWebhookEventTypes');
			expect(events.typeOptions?.loadOptionsDependsOn).toEqual(
				expect.arrayContaining(['source', 'workspace.value']),
			);
		}
		expect(trigger.methods.loadOptions.getWebhookEventTypes).toBeTypeOf('function');
	});

	it('for codexum: a scope over the whole workspace, a wiki space (picker) or a page ID', () => {
		const scope = prop('wikiScopeType');
		expect(scope.default).toBe('WORKSPACE');
		expect(scope.displayOptions?.show?.source).toEqual(['codexum']);
		expect((scope.options ?? []).map((o) => (o as { value: string }).value).sort()).toEqual([
			'WIKI_PAGE',
			'WIKI_SPACE',
			'WORKSPACE',
		]);
		expect(prop('wikiScopeSpace').displayOptions?.show).toEqual({
			source: ['codexum'],
			wikiScopeType: ['WIKI_SPACE'],
		});
		expect(prop('wikiScopeSpace').typeOptions?.loadOptionsMethod).toBe('getWikiSpaces');
		expect(prop('wikiScopePage').displayOptions?.show).toEqual({
			source: ['codexum'],
			wikiScopeType: ['WIKI_PAGE'],
		});
	});

	it('for roadmarq: a scope over the whole workspace, a board (picker), a request or a bug', () => {
		const scope = prop('feedbackScopeType');
		expect(scope.default).toBe('WORKSPACE');
		expect(scope.displayOptions?.show?.source).toEqual(['roadmarq']);
		expect((scope.options ?? []).map((o) => (o as { value: string }).value).sort()).toEqual([
			'FEEDBACK_BOARD',
			'FEEDBACK_BUG',
			'FEEDBACK_REQUEST',
			'WORKSPACE',
		]);
		const targets: Record<string, string> = {
			feedbackScopeBoard: 'FEEDBACK_BOARD',
			feedbackScopeRequest: 'FEEDBACK_REQUEST',
			feedbackScopeBug: 'FEEDBACK_BUG',
		};
		for (const [name, type] of Object.entries(targets)) {
			expect(prop(name).displayOptions?.show).toEqual({
				source: ['roadmarq'],
				feedbackScopeType: [type],
			});
		}
		expect(prop('feedbackScopeBoard').typeOptions?.loadOptionsMethod).toBe('getBoards');
	});

	it('the Roadmarq scope hint says a scope needs a personal API key (workspace and integration keys get 403)', () => {
		expect(prop('feedbackScopeType').hint).toMatch(/personal API key/);
		expect(prop('feedbackScopeType').hint).toMatch(/workspace|integration/i);
	});

	it('has no security-bug opt-in field (Dutify refuses it for API keys)', () => {
		expect(props.some((p) => /security/i.test(p.name))).toBe(false);
	});
});

describe('package registration', () => {
	it('registers the trigger build output in n8n.nodes', () => {
		expect(packageJson.n8n.nodes).toContain('dist/nodes/DutifyTrigger/DutifyTrigger.node.js');
		expect(packageJson.n8n.nodes).toContain('dist/nodes/Dutify/Dutify.node.js');
	});
});

/* ---------- the source that made the webhook is remembered ---------- */

describe('static data records the source of the webhook', () => {
	const PM_HOOKS = `${BASE}/mp/api/v1/workspaces/ws-1/webhooks`;
	const HUB_HOOKS = `${BASE}/api/user/webhooks`;

	it('create stores the source next to the webhook', async () => {
		const meeting = hookContext({
			params: { source: 'meeting', sections: ['summary'] },
			responses: [[], { id: 42 }],
		});
		await hooks.create.call(meeting.ctx);
		expect(meeting.staticData.source).toBe('meeting');

		const pm = hookContext({ responses: [[], { identifier: 'whk_new' }] });
		await hooks.create.call(pm.ctx);
		expect(pm.staticData.source).toBe('pm');
	});

	it('delete removes the webhook through the source that made it, even after Source changed', async () => {
		const { ctx, calls, staticData } = hookContext({
			params: { source: 'meeting', sections: ['summary'] },
			staticData: { webhookId: 'whk_1', secret: 'sek', workspace: 'ws-1', source: 'pm' },
			responses: [undefined],
		});
		expect(await hooks.delete.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${PM_HOOKS}/whk_1`]);
		expect(staticData).toEqual({});
	});

	it('delete of static data written before the source was stored uses the current source', async () => {
		const { ctx, calls } = hookContext({
			params: { source: 'meeting', sections: ['summary'] },
			staticData: { webhookId: '42', secret: 'sek', workspace: 'ws-1' },
			responses: [undefined],
		});
		expect(await hooks.delete.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${HUB_HOOKS}/42`]);
	});

	it('checkExists is false when the stored webhook belongs to another source', async () => {
		const { ctx, calls } = hookContext({
			params: { source: 'meeting', sections: ['summary'] },
			staticData: { webhookId: 'whk_1', secret: 'sek', workspace: 'ws-1', source: 'pm' },
			responses: [],
		});
		expect(await hooks.checkExists.call(ctx)).toBe(false);
		expect(calls).toEqual([]);
	});

	it("create after a Source change removes the old source's webhook, then registers the new one", async () => {
		const { ctx, calls, staticData } = hookContext({
			params: { source: 'meeting', sections: ['summary'] },
			staticData: { webhookId: 'whk_1', secret: 'sek', workspace: 'ws-1', source: 'pm' },
			responses: [[], undefined, { id: 42 }],
		});
		expect(await hooks.create.call(ctx)).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${HUB_HOOKS}`,
			`DELETE ${PM_HOOKS}/whk_1`,
			`POST ${HUB_HOOKS}`,
		]);
		expect(staticData).toMatchObject({ webhookId: '42', source: 'meeting' });
	});
});
