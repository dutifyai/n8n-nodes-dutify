import { sleep } from 'n8n-workflow';
import type { IDataObject, NodeApiError } from 'n8n-workflow';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	createTestSpace,
	liveDescribe,
	loadOptionsOf,
	run,
	runError,
	runOne,
	runId,
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

	it('delete of a webhook with deliveries succeeds', async ({ skip }) => {
		if (!fixture) {
			skip('no fixture webhook');
		}
		expect(await runOne('pmWebhook', 'delete', { webhook: fixture })).toEqual({ success: true });
		const gone = await runError('pmWebhook', 'get', { webhook: fixture });
		expect(gone.httpCode).toBe('404');
	});
});
