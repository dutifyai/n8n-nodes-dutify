import { createHmac } from 'node:crypto';
import type { IDataObject, IWebhookResponseData } from 'n8n-workflow';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DutifyTrigger } from '../../nodes/DutifyTrigger/DutifyTrigger.node';
import { MEETING_SECTION_OPTIONS } from '../../nodes/Dutify/resources/meetingWebhook';
import { PM_EVENT_OPTIONS } from '../../shared/pmEvents';
import {
	cleanupStack,
	createTestSpace,
	hookContextOf,
	live,
	liveDescribe,
	rawRequest,
	runError,
	runOne,
	runId,
	webhookContextOf,
	wikiKey,
	workspaceLocator,
} from './harness';
import type { DeliveredRequest, WebhookAnswer } from './harness';
import { startReceiver, startTunnel } from './tunnel';
import type { ReceivedRequest, Receiver, Tunnel } from './tunnel';

/*
 * End to end: for each trigger source, the trigger registers its webhook on production through
 * its own webhookMethods.create, with a public URL (an ngrok tunnel to a local receiver); a real
 * change in the test workspace makes Dutify deliver; the delivery runs through the trigger's
 * webhook(), which must accept it (and refuse a tampered copy); webhookMethods.delete then
 * removes the webhook from production.
 *
 * The workspace allows 3 webhooks, so the sources run one at a time and each test removes its
 * webhook before the next one starts.
 */

const DELIVERY_TIMEOUT_MS = 120_000;

const hooks = () => new DutifyTrigger().webhookMethods.default;

const bodyOf = (req: ReceivedRequest): IDataObject => {
	try {
		return JSON.parse(req.rawBody.toString('utf8')) as IDataObject;
	} catch {
		return {};
	}
};

/** The same request with one header replaced (or removed with `undefined`). */
function withHeader(req: ReceivedRequest, name: string, value: string | undefined): DeliveredRequest {
	const headers = { ...req.headers };
	if (value === undefined) {
		delete headers[name];
	} else {
		headers[name] = value;
	}

	return { headers, rawBody: req.rawBody };
}

/** A signature with its last hex digit changed. */
const flipLast = (signature: string) =>
	signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');

async function runWebhook(
	params: IDataObject,
	staticData: IDataObject,
	request: DeliveredRequest,
): Promise<{ result: IWebhookResponseData; answer: WebhookAnswer }> {
	const answer: WebhookAnswer = {};
	const result = await new DutifyTrigger().webhook.call(
		webhookContextOf(params, staticData, request, answer),
	);

	return { result, answer };
}

/**
 * The trigger accepts the real delivery and emits its body as the one item; with a tampered
 * signature, a tampered body or no signature it answers 401 and emits nothing.
 */
async function expectVerified(
	params: IDataObject,
	staticData: IDataObject,
	req: ReceivedRequest,
	signatureHeader: string,
): Promise<IDataObject> {
	const signature = String(req.headers[signatureHeader] ?? '');
	expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
	// The header is the HMAC of the raw bytes with the secret the trigger generated and stored.
	const expected = `sha256=${createHmac('sha256', String(staticData.secret)).update(req.rawBody).digest('hex')}`;
	expect(signature).toBe(expected);

	const accepted = await runWebhook(params, staticData, req);
	expect(accepted.answer.status).toBeUndefined();
	expect(accepted.result.noWebhookResponse).toBeUndefined();
	expect(accepted.result.workflowData).toHaveLength(1);
	expect(accepted.result.workflowData?.[0]).toHaveLength(1);
	const emitted = accepted.result.workflowData?.[0][0].json as IDataObject;
	expect(emitted).toEqual(bodyOf(req));

	const refusals: DeliveredRequest[] = [
		withHeader(req, signatureHeader, flipLast(signature)),
		withHeader(req, signatureHeader, undefined),
		{ headers: req.headers, rawBody: Buffer.concat([req.rawBody, Buffer.from(' ')]) },
	];
	for (const tampered of refusals) {
		const refused = await runWebhook(params, staticData, tampered);
		expect(refused.answer.status).toBe(401);
		expect(refused.result).toEqual({ noWebhookResponse: true });
	}

	return emitted;
}

/** Every webhook of the workspace at `url` (PM lists only the exact match with ?url=). */
async function pmWebhooksAt(url: string): Promise<IDataObject[]> {
	return (await rawRequest({
		method: 'GET',
		path: `/mp/api/v1/workspaces/${encodeURIComponent(live.workspace)}/webhooks`,
		qs: { url },
	})) as IDataObject[];
}

liveDescribe('Dutify Trigger, end to end through a public tunnel — live', () => {
	const cleanup = cleanupStack();
	let receiver: Receiver | undefined;
	let tunnel: Tunnel | undefined;

	beforeAll(async () => {
		receiver = await startReceiver();
		tunnel = await startTunnel(receiver.port);
	}, 60_000);
	afterAll(async () => {
		try {
			await cleanup.run();
		} finally {
			await tunnel?.stop();
			await receiver?.close();
		}
	}, 120_000);

	/** The n8n-style production URL of one trigger: <public>/webhook/<id>/webhook. */
	const urlFor = (tag: string) => {
		const path = `/webhook/${runId}-${tag}/webhook`;

		return { path, url: `${String(tunnel?.publicUrl)}${path}` };
	};

	/** Activates the trigger with webhookMethods.create and registers its removal. */
	async function activate(params: IDataObject, url: string): Promise<IDataObject> {
		const staticData: IDataObject = {};
		const ctx = hookContextOf(params, url, staticData);
		expect(await hooks().checkExists.call(ctx)).toBe(false);
		expect(await hooks().create.call(ctx)).toBe(true);
		expect(staticData).toMatchObject({
			webhookId: expect.any(String),
			secret: expect.stringMatching(/^[0-9a-f]{64}$/),
			workspace: live.workspace,
			source: params.source,
		});
		const webhook = String(staticData.webhookId);
		cleanup.add(`trigger webhook ${webhook}`, async () => {
			await hooks().delete.call(hookContextOf(params, url, { ...staticData }));
		});
		expect(await hooks().checkExists.call(ctx)).toBe(true);

		return staticData;
	}

	/** Deactivates with webhookMethods.delete; the static data is cleared. */
	async function deactivate(params: IDataObject, url: string, staticData: IDataObject) {
		expect(await hooks().delete.call(hookContextOf(params, url, staticData))).toBe(true);
		expect(staticData).toEqual({});
	}

	/** The PM envelope: version, ids, type, workspace and source, with matching headers. */
	function expectPmEnvelope(req: ReceivedRequest, type: string, source: string): IDataObject {
		const body = bodyOf(req);
		expect(body).toMatchObject({
			version: '1',
			type,
			source,
			workspaceIdentifier: live.workspace,
			eventId: expect.any(String),
			id: expect.any(String),
			timestamp: expect.any(String),
			data: expect.any(Object),
		});
		expect(req.headers['x-webhook-event']).toBe(type);
		expect(req.headers['x-webhook-delivery']).toBe(body.id);
		expect(String(req.headers['content-type'])).toContain('application/json');

		return body;
	}

	const pmDelivery = (path: string, type: string, marker: string) =>
		receiver!.waitFor(
			path,
			(r) => bodyOf(r).type === type && r.rawBody.toString('utf8').includes(marker),
			DELIVERY_TIMEOUT_MS,
		);

	it('the PM events the trigger offers are exactly the PM events the backend lists', async () => {
		const rows = (await rawRequest({
			method: 'GET',
			path: `/mp/api/v1/workspaces/${encodeURIComponent(live.workspace)}/webhooks/event-types`,
		})) as Array<{ type: string; product: string }>;
		const backend = rows.filter((r) => r.product === 'pm').map((r) => r.type);
		const offered = PM_EVENT_OPTIONS.map((o) => String(o.value));
		expect([...offered].sort()).toEqual([...backend].sort());
	});

	it(
		'Project Management: a task created and renamed in a space reaches the trigger, signed',
		async () => {
			const cleanupSpace = cleanupStack();
			try {
				const space = await createTestSpace(cleanupSpace, 'trigger');
				const listName = `Trigger ${runId}`;
				await runOne('list', 'create', { space: space.name, name: listName });

				const { path, url } = urlFor('pm');
				const params: IDataObject = {
					source: 'pm',
					workspace: workspaceLocator(),
					events: ['task-created', 'task-title-changed'],
					scopeType: 'SPACE',
					scopeSpace: space.identifier,
				};
				const staticData = await activate(params, url);
				const stored = await runOne('pmWebhook', 'get', { webhook: String(staticData.webhookId) });
				expect(stored).toMatchObject({ url, active: true, scopeType: 'SPACE' });

				const title = `Trigger task ${runId}`;
				const task = await runOne('task', 'create', { title, list: listName });
				const key = String(task.key);
				// PM's task payload is thin: the task's numeric id and its identifier.
				const identifier = String(task.identifier);
				expect(identifier).toMatch(/^\w+$/);
				const created = await pmDelivery(path, 'task-created', identifier);
				const createdBody = expectPmEnvelope(created, 'task-created', 'pm');
				const emitted = await expectVerified(
					params,
					staticData,
					created,
					'x-webhook-signature-256',
				);
				expect(emitted.type).toBe('task-created');
				expect(createdBody.data).toMatchObject({ identifier });

				const renamed = `Trigger task renamed ${runId}`;
				await runOne('task', 'update', { task: key, updateFields: { title: renamed } });
				// The title-change payload names the task by its numeric id, with both titles.
				const taskId = (createdBody.data as IDataObject).taskId;
				expect(taskId).toEqual(expect.any(Number));
				const changed = await pmDelivery(path, 'task-title-changed', renamed);
				const changedBody = expectPmEnvelope(changed, 'task-title-changed', 'pm');
				await expectVerified(params, staticData, changed, 'x-webhook-signature-256');
				expect(changedBody.eventId).not.toBe(createdBody.eventId);
				expect(changedBody.data).toMatchObject({ taskId, oldTitle: title, newTitle: renamed });

				const webhook = String(staticData.webhookId);
				await deactivate(params, url, staticData);
				expect((await runError('pmWebhook', 'get', { webhook })).httpCode).toBe('404');
				expect(await pmWebhooksAt(url)).toEqual([]);
			} finally {
				await cleanupSpace.run();
			}
		},
		DELIVERY_TIMEOUT_MS * 3,
	);

	it(
		'Codexum: a wiki page created and updated in a space reaches the trigger, signed',
		async () => {
			const cleanupSpace = cleanupStack();
			try {
				const key = wikiKey('NT');
				const spaceName = `n8n-live trigger ${runId}`;
				await runOne('codexumSpace', 'create', { key, name: spaceName });
				cleanupSpace.add(
					`wiki space ${key}`,
					async () => await runOne('codexumSpace', 'delete', { space: key }),
				);

				const { path, url } = urlFor('codexum');
				const params: IDataObject = {
					source: 'codexum',
					workspace: workspaceLocator(),
					wikiEvents: ['wiki.page.created', 'wiki.page.updated'],
					wikiScopeType: 'WIKI_SPACE',
					wikiScopeSpace: key,
				};
				const staticData = await activate(params, url);

				const title = `Trigger page ${runId}`;
				const page = await runOne('codexumPage', 'create', { space: key, title });
				const created = await pmDelivery(path, 'wiki.page.created', title);
				const createdBody = expectPmEnvelope(created, 'wiki.page.created', 'codexum');
				const emitted = await expectVerified(
					params,
					staticData,
					created,
					'x-webhook-signature-256',
				);
				expect(emitted.type).toBe('wiki.page.created');
				// A thin payload: the page with its id and title, never its content.
				expect(JSON.stringify(createdBody.data)).toContain(String(page.id));

				const renamed = `Trigger page renamed ${runId}`;
				await runOne('codexumPage', 'update', {
					space: key,
					page: String(page.slug),
					updateFields: { title: renamed },
				});
				const updated = await pmDelivery(path, 'wiki.page.updated', String(page.id));
				expectPmEnvelope(updated, 'wiki.page.updated', 'codexum');
				await expectVerified(params, staticData, updated, 'x-webhook-signature-256');

				const webhook = String(staticData.webhookId);
				await deactivate(params, url, staticData);
				expect((await runError('pmWebhook', 'get', { webhook })).httpCode).toBe('404');
				expect(await pmWebhooksAt(url)).toEqual([]);
			} finally {
				await cleanupSpace.run();
			}
		},
		DELIVERY_TIMEOUT_MS * 3,
	);

	it(
		'Roadmarq: a feature request created on a board reaches the trigger, signed',
		async () => {
			const cleanupBoard = cleanupStack();
			try {
				const board = `n8n-live-trg-${runId}`;
				const createdBoard = (await rawRequest({
					method: 'POST',
					path: '/api/roadmarq/v1/boards',
					body: {
						workspaceIdentifier: live.workspace,
						name: `n8n live trigger ${runId}`,
						slug: board,
						featureRequestKey: 'NTR',
						bugReportKey: 'NTB',
						isPublic: false,
						settings: { featureRequestsEnabled: true, bugReportsEnabled: false },
					},
				})) as { id: string };
				cleanupBoard.add(
					`board ${board}`,
					async () =>
						await rawRequest({
							method: 'DELETE',
							path: `/api/roadmarq/v1/boards/${createdBoard.id}`,
							qs: { workspaceIdentifier: live.workspace },
						}),
				);

				const { path, url } = urlFor('roadmarq');
				const params: IDataObject = {
					source: 'roadmarq',
					workspace: workspaceLocator(),
					feedbackEvents: ['feedback.request.created'],
					feedbackScopeType: 'FEEDBACK_BOARD',
					feedbackScopeBoard: board,
				};
				const staticData = await activate(params, url);

				const title = `Trigger request ${runId}`;
				const request = await runOne('featureRequest', 'create', { board, title });
				const shortId = String(request.shortId);
				cleanupBoard.add(`request ${shortId}`, async () => {
					await runOne('featureRequest', 'delete', { shortId }).catch(() => undefined);
				});
				const created = await pmDelivery(path, 'feedback.request.created', shortId);
				const body = expectPmEnvelope(created, 'feedback.request.created', 'roadmarq');
				const emitted = await expectVerified(
					params,
					staticData,
					created,
					'x-webhook-signature-256',
				);
				expect(emitted.type).toBe('feedback.request.created');
				expect(JSON.stringify(body.data)).toContain(title);

				const webhook = String(staticData.webhookId);
				await deactivate(params, url, staticData);
				expect((await runError('pmWebhook', 'get', { webhook })).httpCode).toBe('404');
				expect(await pmWebhooksAt(url)).toEqual([]);
			} finally {
				await cleanupBoard.run();
			}
		},
		DELIVERY_TIMEOUT_MS * 2,
	);

	// A real "meeting processed" event needs a new recording processed (free minutes and AI
	// credits), so the meeting source uses Hub's test delivery: Hub runs the latest processed
	// meeting through the same mapper real deliveries use, with this webhook's sections.
	it(
		'Meeting processed: Hub’s test delivery reaches the trigger, signed, with the chosen sections',
		async (ctx) => {
			const { path, url } = urlFor('meeting');
			const sections = MEETING_SECTION_OPTIONS.map((o) => String(o.value));
			const params: IDataObject = { source: 'meeting', workspace: workspaceLocator(), sections };
			const staticData = await activate(params, url);
			const webhook = String(staticData.webhookId);
			const stored = await runOne('meetingWebhook', 'get', { webhook });
			expect(stored).toMatchObject({ url, hasSecret: true });
			expect([...(stored.sections as string[])].sort()).toEqual([...sections].sort());

			const sent = await runOne('meetingWebhook', 'test', { webhook });
			expect(sent).toMatchObject({ kind: 'test', url });
			const delivered = await receiver!.waitFor(path, () => true, DELIVERY_TIMEOUT_MS);
			const emitted = await expectVerified(params, staticData, delivered, 'x-dutify-signature');
			expect(emitted).toMatchObject({
				event: 'meeting.processed',
				test: true,
				meeting: { recordingId: expect.any(Number), callId: expect.any(Number) },
			});
			const meeting = emitted.meeting as IDataObject;
			const carried = (section: string) => section in meeting || section in emitted;
			// The test recording (an uploaded two-speaker standup) has every section but enhanced
			// notes and the user's own notes; Hub leaves out a section the meeting does not have.
			const absent = sections.filter((s) => !carried(s));
			await ctx.annotate(`sections absent from the delivery: ${JSON.stringify(absent)}`);
			expect(absent.filter((s) => !['enhancedNotes', 'notes'].includes(s))).toEqual([]);

			// n8n re-activating the workflow with fewer sections: the same webhook is updated with
			// a new secret, and the next delivery carries only the chosen sections.
			const fewer: IDataObject = { ...params, sections: ['summary', 'tasks'] };
			const firstSecret = staticData.secret;
			expect(await hooks().create.call(hookContextOf(fewer, url, staticData))).toBe(true);
			expect(staticData.webhookId).toBe(webhook);
			expect(staticData.secret).not.toBe(firstSecret);
			await runOne('meetingWebhook', 'test', { webhook });
			const second = await receiver!.waitFor(path, (r) => r !== delivered, DELIVERY_TIMEOUT_MS);
			const narrowed = await expectVerified(fewer, staticData, second, 'x-dutify-signature');
			const narrowedMeeting = narrowed.meeting as IDataObject;
			expect(narrowedMeeting.summary).toEqual(expect.any(String));
			expect('tasks' in narrowed).toBe(true);
			for (const unchosen of ['keyPoints', 'actionItems', 'transcript', 'insights', 'speakers']) {
				expect(unchosen in narrowedMeeting || unchosen in narrowed).toBe(false);
			}
			// The first secret no longer opens a delivery.
			const stale = await runWebhook(fewer, { ...staticData, secret: firstSecret }, second);
			expect(stale.answer.status).toBe(401);

			await deactivate(fewer, url, staticData);
			expect((await runError('meetingWebhook', 'get', { webhook })).httpCode).toBe('404');
		},
		DELIVERY_TIMEOUT_MS * 2,
	);
});
