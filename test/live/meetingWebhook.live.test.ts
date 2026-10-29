import { afterAll, expect, it } from 'vitest';
import { dutifyErrorOf } from '../../shared/transport';
import {
	cleanupStack,
	liveDescribe,
	loadOptionsOf,
	run,
	runError,
	runOne,
	runId,
} from './harness';

/*
 * Hub personal webhooks through the test key (webhooks:read/write + recordings:read since Hub
 * #366). The URL is on example.com: Hub accepts only public https targets, and nothing there
 * reads the deliveries. Every webhook made here is deleted in afterAll.
 */
liveDescribe('Meeting Webhook — live', () => {
	const cleanup = cleanupStack();
	afterAll(async () => await cleanup.run());
	const url = `https://example.com/n8n-live/meeting-${runId}`;
	let id = '';
	// Runs last: removes anything of this run a failed assertion left behind.
	cleanup.add('meeting webhooks of this run', async () => {
		for (const hook of await run('meetingWebhook', 'list')) {
			if (String(hook.url).includes(`/n8n-live/`) && String(hook.url).endsWith(runId)) {
				await runOne('meetingWebhook', 'delete', { webhook: String(hook.id) });
			}
		}
	});

	it('create binds a webhook with the chosen sections; get, list and the picker show it', async () => {
		const created = await runOne('meetingWebhook', 'create', {
			url,
			secret: `s-${runId}`,
			sections: ['summary', 'actionItems'],
			additionalFields: { name: `n8n live ${runId}` },
		});
		id = String(created.id);
		cleanup.add(
			`meeting webhook ${id}`,
			async () => await runOne('meetingWebhook', 'delete', { webhook: id }),
		);
		expect(created).toMatchObject({
			url,
			name: `n8n live ${runId}`,
			hasSecret: true,
			sections: ['summary', 'actionItems'],
		});
		expect(created.secret ?? null).toBeNull();

		const got = await runOne('meetingWebhook', 'get', { webhook: id });
		expect(got).toMatchObject({ id: created.id, url, hasSecret: true });
		const listed = await run('meetingWebhook', 'list');
		expect(listed.map((w) => String(w.id))).toContain(id);
		const options = await loadOptionsOf('getMeetingWebhooks');
		expect(options).toContainEqual({ name: `n8n live ${runId} (${url})`, value: id });
	});

	it('update changes name, sections and pauses it while keeping the URL', async () => {
		const updated = await runOne('meetingWebhook', 'update', {
			webhook: id,
			updateFields: { name: `n8n live ${runId} 2`, sections: ['summary', 'tasks'], active: false },
		});
		expect(updated).toMatchObject({
			url,
			name: `n8n live ${runId} 2`,
			sections: ['summary', 'tasks'],
		});
		const options = await loadOptionsOf('getMeetingWebhooks');
		expect(options).toContainEqual({ name: `n8n live ${runId} 2 (${url}) (paused)`, value: id });
	});

	it('test sends a delivery that shows up in the delivery log', async () => {
		const delivery = await runOne('meetingWebhook', 'test', { webhook: id });
		expect(delivery).toMatchObject({ kind: 'test', url });
		const log = await run('meetingWebhook', 'listDeliveries', { webhook: id, deliveries: 5 });
		expect(log.map((d) => d.id)).toContain(delivery.id);
		const payload = JSON.parse(String(log[0].payload)) as Record<string, unknown>;
		expect(payload).toMatchObject({ test: true });
	});

	it('delete removes it; get then answers 404 with Hub’s message', async () => {
		expect(await runOne('meetingWebhook', 'delete', { webhook: id })).toEqual({ success: true });
		const gone = await runError('meetingWebhook', 'get', { webhook: id });
		expect(gone.httpCode).toBe('404');
		expect(gone.message).toBe('No such webhook');
		// Hub PR #393: the error is JSON with a code.
		expect(dutifyErrorOf(gone).code).toBe('NOT_FOUND');
	});

	it('a non-https URL is refused with a 400', async () => {
		const error = await runError('meetingWebhook', 'create', {
			url: `http://example.com/n8n-live/plain-${runId}`,
			sections: ['summary'],
		});
		expect(error.httpCode).toBe('400');
		expect(error.message).toContain('https://');
	});
});
