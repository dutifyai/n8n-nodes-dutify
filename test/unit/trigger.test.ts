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

	it('only the pm source exists for now', () => {
		expect(Object.keys(sources)).toEqual(['pm']);
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
				{ id: 'whk_2', active: true, scoped: false, createdAt: undefined },
				{ id: 'whk_3', active: false, scoped: true, createdAt: '2026-10-20T10:00:00Z' },
			]);
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
		const unscoped = { id: 'whk_1', active: false, scoped: false };
		const scoped = { id: 'whk_1', active: false, scoped: true };

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
		getNodeWebhookUrl: (name: string) => (name === 'default' ? (opts.webhookUrl ?? HOOK_URL) : undefined),
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
			responses: [[{ identifier: 'whk_1', url: 'https://old-host.example.com/webhook/7f3a/webhook' }]],
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
		expect(staticData).toEqual({ webhookId: 'whk_new', secret: body.secret, workspace: 'ws-1' });
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
		expect(staticData).toEqual({ webhookId: 'whk_orphan', secret: body.secret, workspace: 'ws-1' });
	});

	it('resumes a paused webhook at this URL (PUT active:true) instead of adding one more row to the quota', async () => {
		const { ctx, calls, staticData } = hookContext({
			staticData: { webhookId: 'whk_used', secret: 'old', workspace: 'ws-1' },
			responses: [
				[{ identifier: 'whk_used', url: HOOK_URL, active: false, pauseReasonCode: 'SUSTAINED_DELIVERY_FAILURES' }],
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
					{ identifier: 'whk_paused', url: HOOK_URL, active: false, createdAt: '2026-10-24T10:00:00Z' },
					{ identifier: 'whk_live', url: HOOK_URL, active: true, createdAt: '2026-10-20T10:00:00Z' },
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
				[{ identifier: 'whk_1', url: HOOK_URL, active: false, scopeType: 'SPACE', scopeEntityIdentifier: 'spc_1' }],
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
				[{ identifier: 'whk_1', url: HOOK_URL, active: true, scopeType: 'SPACE', scopeEntityIdentifier: 'spc_1' }],
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
			responses: [[], [{ identifier: 'whk_old', url: HOOK_URL }], undefined, { identifier: 'whk_new' }],
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
			responses: [[{ identifier: 'whk_other', url: 'https://elsewhere.example.com/h' }], { identifier: 'whk_new' }],
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

/* ---------- webhook() ---------- */

function webhookContext(opts: {
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
			return name === 'source' ? 'pm' : fallback;
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

	it('has a source options property with only pm for now', () => {
		const source = prop('source');
		expect(source.type).toBe('options');
		expect(source.default).toBe('pm');
		expect((source.options ?? []).map((o) => (o as { value: string }).value)).toEqual(['pm']);
	});

	it('for pm: the workspace locator, shown for the pm source', () => {
		const ws = prop('workspace');
		expect(ws.type).toBe('resourceLocator');
		expect(ws.required).toBe(true);
		expect(ws.displayOptions?.show?.source).toEqual(['pm']);
		const listMode = ws.modes?.find((m) => m.name === 'list');
		expect(listMode?.typeOptions?.searchListMethod).toBe('searchWorkspaces');
		expect(trigger.methods.listSearch.searchWorkspaces).toBeTypeOf('function');
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
});

describe('package registration', () => {
	it('registers the trigger build output in n8n.nodes', () => {
		expect(packageJson.n8n.nodes).toContain('dist/nodes/DutifyTrigger/DutifyTrigger.node.js');
		expect(packageJson.n8n.nodes).toContain('dist/nodes/Dutify/Dutify.node.js');
	});
});
