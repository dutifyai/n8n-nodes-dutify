import { sleep } from 'n8n-workflow';
import type { IDataObject, NodeApiError } from 'n8n-workflow';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DutifyTrigger } from '../../nodes/DutifyTrigger/DutifyTrigger.node';
import {
	cleanupStack,
	createTestSpace,
	hookContextOf,
	live,
	liveDescribe,
	loadOptionsOf,
	rawRequest,
	run,
	runError,
	runOne,
	runId,
	wikiKey,
	workspaceLocator,
} from './harness';

/** Deliveries go to example.com (IANA-reserved, nobody receives them). */
const HOOK_PREFIX = 'https://example.com/n8n-live/';
/** The one webhook allowed to deliver. */
const FIXTURE_URL = `${HOOK_PREFIX}fixture-${runId}`;

/** The plan's webhook quota is full (402 QUOTA_EXCEEDED): the test cannot create a webhook. */
const isQuotaFull = (error: unknown) => {
	const e = error as NodeApiError;

	return (
		e?.httpCode === '402' || /QUOTA_EXCEEDED|plan limit/i.test(`${e?.message} ${e?.description}`)
	);
};

/** Creates a webhook, or skips the test with the reason when the plan's quota is full. */
async function createOrSkip(skip: (note: string) => void, params: IDataObject) {
	return await runOne('pmWebhook', 'create', params).catch(async (error: unknown) => {
		if (isQuotaFull(error)) {
			skip(`webhook quota full, cannot create: ${(error as Error).message}`);
		}

		return await Promise.reject(error);
	});
}

/*
 * Webhooks count against the plan's webhook quota (3 on FREE), so each test deletes the webhook it
 * creates. Deleting a webhook that has delivered works since dutify-pm PR #232 (before it, PM
 * answered 409 ENTITY_IN_USE and the webhook could never be removed).
 */
liveDescribe('PM webhook — live', () => {
	const cleanup = cleanupStack();
	let space: { identifier: string; name: string };
	let listId = '';
	let taskKey = '';
	let fixture = '';

	beforeAll(async () => {
		space = await createTestSpace(cleanup, 'webhook');
		const listName = `Hooks ${runId}`;
		listId = String(
			(await runOne('list', 'create', { space: space.name, name: listName })).identifier,
		);
		const task = await runOne('task', 'create', { title: `Hook task ${runId}`, list: listName });
		taskKey = String(task.key);
		cleanup.add(`task ${taskKey}`, async () => await runOne('task', 'delete', { task: taskKey }));
	});
	afterAll(async () => await cleanup.run());

	it('the event type picker offers task-created', async () => {
		const options = await loadOptionsOf('getPmEventTypes');
		expect(options.map((o) => o.value)).toContain('task-created');
	});

	it('create scoped to a space; get, list, picker, usage, update, delete (never delivers)', async ({
		skip,
	}) => {
		const url = `${HOOK_PREFIX}roundtrip-${runId}`;
		const created = await createOrSkip(skip, {
			url,
			secret: `s-${runId}`,
			eventTypes: ['task-created', 'task-status-changed'],
			scopeType: 'SPACE',
			scopeSpace: space.identifier,
			additionalFields: { name: `Hook ${runId}` },
		});
		expect(created).toMatchObject({ url, name: `Hook ${runId}` });
		expect(JSON.stringify(created)).not.toContain(`s-${runId}`);
		const webhook = String(created.identifier);
		cleanup.add(`webhook ${webhook}`, async () => await runOne('pmWebhook', 'delete', { webhook }));

		expect(await runOne('pmWebhook', 'get', { webhook })).toMatchObject({ identifier: webhook });
		expect((await run('pmWebhook', 'list')).map((w) => w.identifier)).toContain(webhook);
		const all = await run('pmWebhook', 'list', { additionalFields: { all: true } });
		expect(all.map((w) => w.identifier)).toContain(webhook);
		expect((await loadOptionsOf('getPmWebhooks')).map((o) => o.value)).toContain(webhook);
		expect(await runOne('pmWebhook', 'getUsage')).toEqual(expect.any(Object));

		const renamed = await runOne('pmWebhook', 'update', {
			webhook,
			updateFields: { name: `Hook renamed ${runId}` },
		});
		expect(renamed).toMatchObject({ name: `Hook renamed ${runId}`, url });
		const toTask = await runOne('pmWebhook', 'update', {
			webhook,
			scopeType: 'TASK',
			scopeTask: taskKey,
		});
		expect(JSON.stringify(toTask)).toContain('TASK');
		const toList = await runOne('pmWebhook', 'update', {
			webhook,
			scopeType: 'TASK_LIST',
			scopeList: listId,
		});
		expect(JSON.stringify(toList)).toContain(listId);

		expect(await runOne('pmWebhook', 'delete', { webhook })).toEqual({ success: true });
		const gone = await runError('pmWebhook', 'get', { webhook });
		expect(gone.httpCode).toBe('404');
	});

	it('test, listDeliveries, delivery picker and replayDelivery on a fixture webhook', async ({
		skip,
	}) => {
		fixture = String(
			(
				await createOrSkip(skip, {
					url: FIXTURE_URL,
					secret: `s-${runId}`,
					eventTypes: ['task-created'],
					scopeType: 'SPACE',
					scopeSpace: space.identifier,
					additionalFields: { name: 'n8n live delivery fixture' },
				})
			).identifier,
		);
		const created = fixture;
		cleanup.add(
			`webhook ${created}`,
			async () => await runOne('pmWebhook', 'delete', { webhook: created }),
		);

		const before = await run('pmWebhook', 'listDeliveries', { webhook: fixture, returnAll: true });
		const sent = await runOne('pmWebhook', 'test', { webhook: fixture });
		expect(sent).toEqual(expect.any(Object));
		let deliveries = before;
		for (let attempt = 0; attempt < 10 && deliveries.length <= before.length; attempt++) {
			await sleep(1500);
			deliveries = await run('pmWebhook', 'listDeliveries', { webhook: fixture, returnAll: true });
		}
		expect(deliveries.length).toBeGreaterThan(before.length);
		const delivery = String(deliveries[0].identifier);
		const options = await loadOptionsOf('getPmWebhookDeliveries', { webhook: fixture });
		expect(options.map((o) => String(o.value))).toContain(delivery);

		const replayed = await runOne('pmWebhook', 'replayDelivery', { webhook: fixture, delivery });
		expect(replayed).toEqual(expect.any(Object));
	});

	it('eventTypesIncludeWikiAndFeedback: /event-types lists every product; the trigger picker filters', async () => {
		const rows = (await rawRequest({
			method: 'GET',
			path: `/mp/api/v1/workspaces/${encodeURIComponent(live.workspace)}/webhooks/event-types`,
		})) as Array<{ type: string; product: string; scopes: string[] }>;
		const products = new Set(rows.map((r) => r.product));
		expect([...products].sort()).toEqual(['codexum', 'pm', 'roadmarq']);
		expect(rows.find((r) => r.type === 'wiki.page.published')?.scopes).toEqual(
			expect.arrayContaining(['WIKI_SPACE', 'WIKI_PAGE']),
		);
		expect(rows.find((r) => r.type === 'feedback.request.created')?.scopes).toContain(
			'FEEDBACK_BOARD',
		);

		const wiki = (await loadOptionsOf('getWebhookEventTypes', { source: 'codexum' })).map(
			(o) => o.value,
		);
		expect(wiki).toContain('wiki.page.published');
		expect(wiki.every((v) => String(v).startsWith('wiki.'))).toBe(true);
		const feedback = (await loadOptionsOf('getWebhookEventTypes', { source: 'roadmarq' })).map(
			(o) => o.value,
		);
		expect(feedback).toContain('feedback.request.created');
		expect(feedback.every((v) => String(v).startsWith('feedback.'))).toBe(true);
	});

	it('pageScopeOffersOnlyPageEvents: a wiki page scope lists only the events PM lets a page scope take', async () => {
		const rows = (await rawRequest({
			method: 'GET',
			path: `/mp/api/v1/workspaces/${encodeURIComponent(live.workspace)}/webhooks/event-types`,
		})) as Array<{ type: string; product: string; scopes?: string[] }>;
		const wikiRows = rows.filter((r) => r.product === 'codexum');
		expect(wikiRows.every((r) => Array.isArray(r.scopes))).toBe(true);
		const pageLevel = wikiRows.filter((r) => r.scopes?.includes('WIKI_PAGE')).map((r) => r.type);

		const offered = (
			await loadOptionsOf('getWebhookEventTypes', { source: 'codexum', wikiScopeType: 'WIKI_PAGE' })
		).map((o) => String(o.value));
		expect(offered.length).toBeGreaterThan(0);
		expect([...offered].sort()).toEqual([...pageLevel].sort());
		expect(offered).toContain('wiki.page.updated');
		expect(offered).not.toContain('wiki.space.updated');
		expect(offered.every((t) => /^wiki\.(page|comment|reaction|attachment)\./.test(t))).toBe(true);

		const request = (
			await loadOptionsOf('getWebhookEventTypes', {
				source: 'roadmarq',
				feedbackScopeType: 'FEEDBACK_REQUEST',
			})
		).map((o) => String(o.value));
		expect(request).toContain('feedback.request.created');
		expect(request.some((t) => t.startsWith('feedback.bug.'))).toBe(false);
	});

	it('activationRefusalReadable: a space event on a page scope fails with PM reason, creating nothing', async () => {
		const url = `${HOOK_PREFIX}refused-${runId}`;
		const ctx = hookContextOf(
			{
				source: 'codexum',
				workspace: workspaceLocator(),
				wikiEvents: ['wiki.space.updated'],
				wikiScopeType: 'WIKI_PAGE',
				wikiScopePage: '00000000-0000-4000-8000-000000000000',
			},
			url,
			{},
		);
		const error = (await new DutifyTrigger().webhookMethods.default.create.call(ctx).then(
			() => undefined,
			(e: unknown) => e,
		)) as NodeApiError | undefined;
		expect(error?.httpCode).toBe('400');
		expect(error?.message).toMatch(/^Dutify refused the trigger's webhook: .*wiki\.space\.updated/);
		const atUrl = (await rawRequest({
			method: 'GET',
			path: `/mp/api/v1/workspaces/${encodeURIComponent(live.workspace)}/webhooks`,
			qs: { url },
		})) as IDataObject[];
		expect(atUrl).toEqual([]);
	});

	it('createWikiScopedWebhookRoundTrip: the trigger registers a wiki-space webhook, PM names the scope, delete removes it', async ({
		skip,
	}) => {
		const key = wikiKey('NH');
		await runOne('codexumSpace', 'create', { key, name: `n8n-live hooks ${runId}` });
		let spaceGone = false;
		cleanup.add(`wiki space ${key}`, async () => {
			if (!spaceGone) {
				await runOne('codexumSpace', 'delete', { space: key });
			}
		});

		const url = `${HOOK_PREFIX}wiki-${runId}`;
		const staticData: IDataObject = {};
		const ctx = hookContextOf(
			{
				source: 'codexum',
				workspace: workspaceLocator(),
				wikiEvents: ['wiki.page.published', 'wiki.page.created'],
				wikiScopeType: 'WIKI_SPACE',
				wikiScopeSpace: key,
			},
			url,
			staticData,
		);
		const hooks = new DutifyTrigger().webhookMethods.default;
		expect(await hooks.checkExists.call(ctx)).toBe(false);
		await hooks.create.call(ctx).catch(async (error: unknown) => {
			if (isQuotaFull(error)) {
				skip(`webhook quota full, cannot create: ${(error as Error).message}`);
			}

			return await Promise.reject(error);
		});
		const webhook = String(staticData.webhookId);
		cleanup.add(`webhook ${webhook}`, async () => await runOne('pmWebhook', 'delete', { webhook }));
		expect(staticData).toMatchObject({ source: 'codexum', workspace: live.workspace });

		const stored = await runOne('pmWebhook', 'get', { webhook });
		expect(stored).toMatchObject({
			url,
			scopeType: 'WIKI_SPACE',
			scopeEntityIdentifier: key,
			scopeEntityName: `n8n-live hooks ${runId}`,
		});
		expect([...(stored.eventTypes as string[])].sort()).toEqual([
			'wiki.page.created',
			'wiki.page.published',
		]);
		expect(stored.includeSecurityBugs ?? false).toBe(false);

		const atUrl = (await rawRequest({
			method: 'GET',
			path: `/mp/api/v1/workspaces/${encodeURIComponent(live.workspace)}/webhooks`,
			qs: { url },
		})) as IDataObject[];
		expect(atUrl.map((w) => w.identifier)).toEqual([webhook]);
		expect(await hooks.checkExists.call(ctx)).toBe(true);

		expect(await hooks.delete.call(ctx)).toBe(true);
		expect(staticData).toEqual({});
		const gone = await runError('pmWebhook', 'get', { webhook });
		expect(gone.httpCode).toBe('404');
		// FREE allows one wiki space: free it for the next test.
		await runOne('codexumSpace', 'delete', { space: key });
		spaceGone = true;
	});

	/** A page-scoped trigger webhook; `remove` deletes the page for good, or its whole space (then true). */
	async function scopeGoneRoundTrip(
		skip: (note: string) => void,
		tag: string,
		remove: (space: string, page: IDataObject) => Promise<boolean>,
	) {
		const key = wikiKey(tag);
		await runOne('codexumSpace', 'create', { key, name: `n8n-live gone ${runId}` });
		let spaceGone = false;
		cleanup.add(`wiki space ${key}`, async () => {
			if (!spaceGone) {
				await runOne('codexumSpace', 'delete', { space: key });
			}
		});
		const page = await runOne('codexumPage', 'create', { space: key, title: `Gone ${runId}` });

		const url = `${HOOK_PREFIX}gone-${tag}-${runId}`;
		const params: IDataObject = {
			source: 'codexum',
			workspace: workspaceLocator(),
			wikiEvents: ['wiki.page.updated'],
			wikiScopeType: 'WIKI_PAGE',
			wikiScopePage: String(page.id),
		};
		const staticData: IDataObject = {};
		const hooks = new DutifyTrigger().webhookMethods.default;
		await hooks.create
			.call(hookContextOf(params, url, staticData))
			.catch(async (error: unknown) => {
				if (isQuotaFull(error)) {
					skip(`webhook quota full, cannot create: ${(error as Error).message}`);
				}

				return await Promise.reject(error);
			});
		const webhook = String(staticData.webhookId);
		cleanup.add(`webhook ${webhook}`, async () => await runOne('pmWebhook', 'delete', { webhook }));

		spaceGone = await remove(key, page);
		let stored: IDataObject = {};
		for (let i = 0; i < 30; i++) {
			stored = await runOne('pmWebhook', 'get', { webhook });
			if (stored.active === false) {
				break;
			}
			await sleep(3000);
		}
		expect(stored).toMatchObject({ active: false, pauseReasonCode: 'SCOPE_ENTITY_GONE' });

		// n8n re-activating the workflow: the paused webhook is not resumed, the error says why.
		const error = (await hooks.create.call(hookContextOf(params, url, {})).then(
			() => undefined,
			(e: unknown) => e,
		)) as Error | undefined;
		expect(error?.message).toMatch(/^The scoped wiki page .*was deleted/);
		expect((await runOne('pmWebhook', 'get', { webhook })).active).toBe(false);
		if (!spaceGone) {
			// FREE allows one wiki space: free it for the next test.
			await runOne('codexumSpace', 'delete', { space: key });
			spaceGone = true;
		}
	}

	it('deletedPageScopePauses: deleting the scoped page for good pauses the webhook; reactivating names the deleted scope', async ({
		skip,
	}) => {
		await scopeGoneRoundTrip(skip, 'NG', async (space, page) => {
			await runOne('codexumPage', 'delete', { space, page: String(page.slug), permanent: true });

			return false;
		});
	});

	it('deletedSpacePausesPageScope: deleting the space pauses a webhook scoped to one of its pages', async ({
		skip,
	}) => {
		await scopeGoneRoundTrip(skip, 'NS', async (space) => {
			await runOne('codexumSpace', 'delete', { space });

			return true;
		});
	});

	it('a local n8n URL is refused by Dutify (use a public tunnel)', async () => {
		const ctx = hookContextOf(
			{
				source: 'codexum',
				workspace: workspaceLocator(),
				wikiEvents: ['wiki.page.published'],
				wikiScopeType: 'WORKSPACE',
			},
			'http://localhost:5678/webhook/7f3a/webhook',
			{},
		);
		const error = (await new DutifyTrigger().webhookMethods.default.create.call(ctx).then(
			() => undefined,
			(e: unknown) => e,
		)) as NodeApiError | undefined;
		expect(error?.httpCode).toBe('400');
		expect(`${error?.message} ${error?.description}`).toMatch(
			/WEBHOOK_URL_NOT_ALLOWED|not allowed/i,
		);
	});

	it('delete of a webhook with deliveries succeeds', async ({ skip }) => {
		if (!fixture) {
			skip('no fixture webhook');
		}
		expect(await runOne('pmWebhook', 'delete', { webhook: fixture })).toEqual({ success: true });
		const gone = await runError('pmWebhook', 'get', { webhook: fixture });
		expect(gone.httpCode).toBe('404');
	});
});
