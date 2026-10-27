import { sleep } from 'n8n-workflow';
import type { IDataObject, NodeApiError } from 'n8n-workflow';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	live,
	liveDescribe,
	loadOptionsOf,
	readAudioFile,
	run,
	runError,
	runId,
	runOne,
	runOperation,
} from './harness';

/*
 * Hub workspace, integrations, calendar and the call writes, against production in the test
 * workspace. Contracts: https://dutify.ai/api/v1/api-catalog/{Calls, Workspaces, Integrations,
 * Workspace%20Settings, User%20Resource, Calendar}.
 *
 * - Every setter is a round trip that ends on the value it found, also when the test fails.
 * - Send to Jira/ClickUp/Airtable runs only while the workspace has no such integration: the node
 *   must refuse before anything is sent. With one connected the test skips rather than push real
 *   action items.
 * - Delete Call deletes only a call this suite uploaded, which spends transcription quota, so it
 *   runs only with DUTIFY_TEST_PAID_OPS=1 and DUTIFY_TEST_AUDIO. Without them only the refusal for
 *   a call that does not exist is checked.
 * - The test user's calendar is empty, so the prompt operations on a calendar event or series are
 *   checked by Hub's 404 for an event or series that does not exist; a real round trip runs when
 *   the calendar has an event.
 */

const MISSING_CALL = '999999999';
const PROCESSING_TIMEOUT_MS = 15 * 60_000;

const hubError = (error: NodeApiError) => `${error.httpCode} ${error.message}`;

liveDescribe('Hub workspace, integrations, calendar and call writes — live', () => {
	const cleanup = cleanupStack();
	let uuid = '';

	beforeAll(async () => {
		uuid = String((await runOne('hubWorkspace', 'get')).id);
	});
	afterAll(async () => await cleanup.run());

	/* ---------- Hub Workspace ---------- */

	it('get returns the selected workspace with its Hub UUID', async () => {
		const ws = await runOne('hubWorkspace', 'get');
		expect(ws.identifier).toBe(live.workspace);
		expect(String(ws.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(typeof ws.name).toBe('string');
	});

	it('listMembers lists the test user; limit and search narrow it', async () => {
		const all = await run('hubWorkspace', 'listMembers', { returnAll: true });
		const me = all.find((m) => m.email === live.userEmail);
		expect(me?.userId).toBe(live.userId);
		expect(me?.role).toBe('OWNER');
		expect(await run('hubWorkspace', 'listMembers', { limit: 1 })).toHaveLength(1);
		const found = await run('hubWorkspace', 'listMembers', {
			returnAll: true,
			additionalFields: { search: live.userEmail },
		});
		expect(found.map((m) => m.email)).toContain(live.userEmail);
	});

	it('custom prompt round trip: set keeps the text exactly, clear removes it, the original comes back', async () => {
		const original = (await runOne('hubWorkspace', 'getCustomPrompt')).customPrompt as
			| string
			| null;
		const restore = async () =>
			original === null
				? await runOne('hubWorkspace', 'clearCustomPrompt')
				: await runOne('hubWorkspace', 'setCustomPrompt', { customPrompt: original });
		cleanup.add('workspace custom prompt', restore);

		const text = `n8n live ${runId}: write "decisions" first, then owners`;
		expect(await runOne('hubWorkspace', 'setCustomPrompt', { customPrompt: text })).toEqual({
			customPrompt: text,
		});
		expect((await runOne('hubWorkspace', 'getCustomPrompt')).customPrompt).toBe(text);

		await runOne('hubWorkspace', 'clearCustomPrompt');
		expect((await runOne('hubWorkspace', 'getCustomPrompt')).customPrompt).toBeNull();

		await restore();
		expect((await runOne('hubWorkspace', 'getCustomPrompt')).customPrompt).toBe(original);
	});

	it('default workspace round trip: set the selected workspace, read it back, restore the original', async (ctx) => {
		const original = (await runOne('hubWorkspace', 'getDefault')).workspaceId ?? null;
		if (original !== null && original !== uuid) {
			ctx.skip('the default is another workspace, which this key cannot set back');

			return;
		}
		const restore = async () =>
			await runOne('hubWorkspace', 'setDefault', {
				defaultWorkspace: original === null ? 'none' : 'selected',
			});
		cleanup.add('default workspace', restore);

		expect(await runOne('hubWorkspace', 'setDefault', { defaultWorkspace: 'selected' })).toEqual({
			workspaceId: uuid,
		});
		expect((await runOne('hubWorkspace', 'getDefault')).workspaceId).toBe(uuid);

		await restore();
		expect((await runOne('hubWorkspace', 'getDefault')).workspaceId ?? null).toBe(original);
	});

	// BACKEND GAP (recorded in the parity report): Hub answers 204 to {workspaceId: null} but keeps
	// answering the workspace UUID afterwards, so the default cannot be removed. This test states
	// the expected outcome and is marked failing; it starts passing (and must lose `.fails`) once
	// Hub clears the default. It ends on the selected workspace, which is the test user's default.
	it.fails('setDefault None removes the default workspace', async () => {
		cleanup.add(
			'default workspace (after None)',
			async () => await runOne('hubWorkspace', 'setDefault', { defaultWorkspace: 'selected' }),
		);
		expect(await runOne('hubWorkspace', 'setDefault', { defaultWorkspace: 'none' })).toEqual({
			workspaceId: null,
		});
		expect((await runOne('hubWorkspace', 'getDefault')).workspaceId ?? null).toBeNull();
	});

	/* ---------- Hub Integration ---------- */

	it('list returns the connected integrations, each with its system and status', async () => {
		const rows = await run('hubIntegration', 'list');
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(typeof row.integrationSystem).toBe('string');
			expect(['CONNECTED', 'REVOKED', 'ERROR', 'ACCESS_REQUIRED']).toContain(row.status);
		}
	});

	it('preferred integration: set and read back the current system; Hub refuses another one with its reason', async (ctx) => {
		const original = (await runOne('hubIntegration', 'getPreferred')).preferredIntegration as
			| string
			| null;
		if (original === null) {
			ctx.skip('no preferred integration is set, and the node cannot set it back to none');

			return;
		}
		cleanup.add(
			'preferred integration',
			async () =>
				await runOne('hubIntegration', 'setPreferred', { preferredIntegration: original }),
		);

		expect(
			await runOne('hubIntegration', 'setPreferred', { preferredIntegration: original }),
		).toEqual({ preferredIntegration: original });
		expect((await runOne('hubIntegration', 'getPreferred')).preferredIntegration).toBe(original);

		// Hub accepts only Dutify Project Management today, although the catalog's enum lists more.
		if (original === 'PM') {
			const error = await runError('hubIntegration', 'setPreferred', {
				preferredIntegration: 'JIRA',
			});
			expect(hubError(error)).toBe('400 Dutify Cloud is the supported task system');
			expect((await runOne('hubIntegration', 'getPreferred')).preferredIntegration).toBe('PM');
		}
	});

	/* ---------- Call: send to a vendor ---------- */

	const connected = async (systems: string[]) =>
		(await run('hubIntegration', 'list')).some(
			(r) => systems.includes(String(r.integrationSystem)) && r.status === 'CONNECTED',
		);

	let testCall = '';
	const callOrSkip = async (ctx: { skip: (note: string) => void }) => {
		if (!testCall) {
			const first = (await run('call', 'list', { limit: 1 }))[0];
			testCall = first ? String(first.id) : '';
		}
		if (!testCall) {
			ctx.skip('the test workspace has no call');
		}

		return testCall;
	};

	it.for([
		['sendToJira', ['JIRA', 'ATLASSIAN'], 'Jira', { jiraCloud: 'n8n-live', jiraProjects: ['1'] }],
		['sendToClickUp', ['CLICKUP'], 'ClickUp', { clickUpList: '1' }],
		['sendToAirtable', ['AIRTABLE'], 'Airtable', { airtableBase: 'b', airtableTables: ['t'] }],
	] as Array<[string, string[], string, IDataObject]>)(
		'%s refuses before sending while the workspace has no such integration',
		async ([operation, systems, vendor, params], ctx) => {
			if (await connected(systems)) {
				ctx.skip(`${vendor} is connected; the test does not push real action items`);

				return;
			}
			const call = await callOrSkip(ctx);
			const error = await runError('call', operation, { call, ...params });
			expect(error.message).toContain(`no connected ${vendor} integration`);
		},
	);

	it('the Jira and Airtable pickers show Hub\'s "integration not found" answer while none is connected', async (ctx) => {
		if (await connected(['JIRA', 'ATLASSIAN', 'AIRTABLE'])) {
			ctx.skip('Jira or Airtable is connected');

			return;
		}
		for (const method of ['getJiraClouds', 'getAirtableBases'] as const) {
			const error = (await loadOptionsOf(method).catch((e: unknown) => e)) as NodeApiError;
			expect(hubError(error)).toBe(
				'404 Authorization for the requested integration service was not found.',
			);
		}
		// The dependent pickers wait for their parent field.
		expect(await loadOptionsOf('getJiraProjects')).toEqual([]);
		expect(await loadOptionsOf('getAirtableTables')).toEqual([]);
	});

	/* ---------- Call: custom prompt ---------- */

	it('call custom prompt round trip: set, read on the call, clear, restore', async (ctx) => {
		const call = await callOrSkip(ctx);
		if (!call) {
			return;
		}
		const read = async () =>
			((await runOne('call', 'get', { call })).callSpecificCustomPrompt ?? null) as string | null;
		const original = await read();
		const restore = async () =>
			original === null
				? await runOne('call', 'clearCustomPrompt', { call })
				: await runOne('call', 'setCustomPrompt', { call, customPrompt: original });
		cleanup.add('call custom prompt', restore);

		const text = `n8n live ${runId}: list the risks`;
		await runOne('call', 'setCustomPrompt', { call, customPrompt: text });
		expect(await read()).toBe(text);

		await runOne('call', 'clearCustomPrompt', { call });
		expect(await read()).toBeNull();

		await restore();
		expect(await read()).toBe(original);
	});

	/* ---------- Call: delete ---------- */

	it("delete of a call that does not exist shows Hub's 404", async () => {
		const error = await runError('call', 'delete', { call: MISSING_CALL });
		expect(hubError(error)).toBe(`404 User call not found with ID: ${MISSING_CALL}`);
	});

	it(
		'delete removes a call this test uploaded (paid: uses transcription quota)',
		async (ctx) => {
			const audio = readAudioFile();
			if (!live.paidOps || !audio) {
				ctx.skip('uploads a recording; set DUTIFY_TEST_PAID_OPS=1 and DUTIFY_TEST_AUDIO to run it');

				return;
			}
			const [item] = await runOperation(
				'recording',
				'upload',
				{
					binaryPropertyName: 'data',
					additionalFields: { fileName: `n8n-live-delete-${runId}.mp3` },
				},
				{ property: 'data', data: audio, mimeType: 'audio/mpeg', fileName: 'delete-me.mp3' },
			);
			const recording = String(item.json.recordingId);
			const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
			let status: IDataObject = {};
			for (;;) {
				status = await runOne('recording', 'getProcessingStatus', { recording });
				if (status.processed === true || Date.now() > deadline) {
					break;
				}
				await sleep(15_000);
			}
			const call = String(status.userCallId);
			expect(call).toMatch(/^\d+$/);

			expect(await runOne('call', 'delete', { call })).toEqual({ success: true });
			expect((await runError('call', 'get', { call })).httpCode).toBe('404');
		},
		PROCESSING_TIMEOUT_MS + 120_000,
	);

	/* ---------- Calendar Event ---------- */

	it('list returns the events of a range; the pickers load', async () => {
		const now = Date.now();
		const events = await run('calendarEvent', 'list', {
			startDate: new Date(now - 7 * 864e5).toISOString(),
			endDate: new Date(now + 30 * 864e5).toISOString(),
			returnAll: true,
		});
		expect(Array.isArray(events)).toBe(true);
		expect(Array.isArray(await loadOptionsOf('getCalendarEvents'))).toBe(true);
		expect(Array.isArray(await loadOptionsOf('getCalendarSeries'))).toBe(true);
	});

	it.each([
		['setCustomPrompt', { event: `n8n-live-${runId}`, customPrompt: 'x' }, 'Event not found.'],
		['clearCustomPrompt', { event: `n8n-live-${runId}` }, 'Event not found.'],
		[
			'setSeriesCustomPrompt',
			{ series: `n8n-live-${runId}`, customPrompt: 'x' },
			'Series not found.',
		],
		['clearSeriesCustomPrompt', { series: `n8n-live-${runId}` }, 'Series not found.'],
	] as Array<[string, IDataObject, string]>)(
		"%s on an event or series that does not exist shows Hub's 404",
		async (operation, params, message) => {
			const error = await runError('calendarEvent', operation, params);
			expect(hubError(error)).toBe(`404 ${message}`);
		},
	);

	it('event prompt round trip on a real calendar event, restoring it', async (ctx) => {
		const options = await loadOptionsOf('getCalendarEvents');
		if (options.length === 0) {
			ctx.skip('the test user has no calendar events');

			return;
		}
		const now = Date.now();
		const events = await run('calendarEvent', 'list', {
			startDate: new Date(now - 7 * 864e5).toISOString(),
			endDate: new Date(now + 60 * 864e5).toISOString(),
			returnAll: true,
		});
		const event = events.find((e) => String(e.eventId ?? e.id) === String(options[0].value));
		const id = String(options[0].value);
		const original = (event?.eventCustomPrompt ?? null) as string | null;
		cleanup.add('event custom prompt', async () =>
			original === null
				? await runOne('calendarEvent', 'clearCustomPrompt', { event: id })
				: await runOne('calendarEvent', 'setCustomPrompt', { event: id, customPrompt: original }),
		);
		await runOne('calendarEvent', 'setCustomPrompt', {
			event: id,
			customPrompt: `n8n live ${runId}`,
		});
		await runOne('calendarEvent', 'clearCustomPrompt', { event: id });
	});
});
