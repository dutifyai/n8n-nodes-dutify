import { sleep } from 'n8n-workflow';
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

/*
 * BACKEND BUG (PM WebhookService.deleteWebhook + migration 095, origin/master 946745b2):
 * fk_webhook_delivery_subscription has no ON DELETE CASCADE and the service does not remove the
 * deliveries, so a webhook that ever delivered answers 409 ENTITY_IN_USE on delete. It still
 * counts against the plan's webhook quota (3 on FREE). So that repeated runs do not fill the
 * quota, the delivery checks reuse ONE parked fixture webhook (inactive between runs), and the
 * create / delete round-trip uses a webhook that never delivers.
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

	it('create scoped to a space; get, list, picker, usage, update, delete (never delivers)', async () => {
		const url = `${HOOK_PREFIX}${runId}`;
		const created = await runOne('pmWebhook', 'create', {
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

	it('test, listDeliveries, delivery picker and replayDelivery on the parked fixture webhook', async () => {
		const parked = (await run('pmWebhook', 'list', { additionalFields: { all: true } })).find((w) =>
			String(w.url).startsWith(HOOK_PREFIX),
		);
		if (parked) {
			fixture = String(parked.identifier);
		} else {
			fixture = String(
				(
					await runOne('pmWebhook', 'create', {
						url: `${HOOK_PREFIX}fixture`,
						secret: `s-${runId}`,
						eventTypes: ['task-created'],
						scopeType: 'SPACE',
						scopeSpace: space.identifier,
						additionalFields: { name: 'n8n live delivery fixture' },
					})
				).identifier,
			);
		}
		cleanup.add(
			`park webhook ${fixture}`,
			async () =>
				await runOne('pmWebhook', 'update', {
					webhook: fixture,
					updateFields: { active: false },
				}),
		);
		await runOne('pmWebhook', 'update', { webhook: fixture, updateFields: { active: true } });

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

	it('delete of a webhook with deliveries is refused with 409 ENTITY_IN_USE', async () => {
		const error = await runError('pmWebhook', 'delete', { webhook: fixture });
		expect(error.httpCode).toBe('409');
		expect(error.description).toContain('ENTITY_IN_USE');
	});
});
