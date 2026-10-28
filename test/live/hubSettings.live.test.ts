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
 * - Select Jira/ClickUp/Airtable Destination only stores a destination on the caller's
 *   participation (it creates no vendor item). It runs only while the workspace has no such
 *   integration, where Hub refuses with 409 INTEGRATION_NOT_CONNECTED and stores nothing. With one
 *   connected the test skips rather than overwrite a real destination.
 * - Delete Call deletes only a call this suite uploaded, which spends transcription quota, so it
 *   runs only with DUTIFY_TEST_PAID_OPS=1 and DUTIFY_TEST_AUDIO. Without them only the refusal for
 *   a call that does not exist is checked.
 * - The test user's calendar is empty, so the prompt operations on a calendar event or series are
 *   checked by Hub's 404 for an event or series that does not exist; a real round trip runs when
 *   the calendar has an event.
 */

const MISSING_CALL = '999999999';
const PROCESSING_TIMEOUT_MS = 15 * 60_000;
/**
 * Hub's calendar endpoints (proxied to calendar-events-api) were measured on 2026-10-28 at 0.8 to
 * 8.2 s per answer, and the slowest end in a 502 at about 10.8 s, while other Hub endpoints answer
 * in under 1 s. So a calendar test gets 12 s per request it makes, on top of a little slack.
 */
const CALENDAR_REQUEST_MS = 12_000;
const CALENDAR_TEST_MS = (requests: number) => requests * CALENDAR_REQUEST_MS + 3_000;

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

	// Catalog (User Resource): PUT {workspaceId: null} resets the choice; the next GET returns
	// Hub's automatic choice, the workspace the user owns. The test user owns the test workspace.
	it('setDefault Reset to Automatic brings back the workspace the user owns', async () => {
		const me = (await run('hubWorkspace', 'listMembers', { returnAll: true })).find(
			(m) => m.email === live.userEmail,
		);
		expect(me?.role).toBe('OWNER');
		cleanup.add(
			'default workspace (after reset)',
			async () => await runOne('hubWorkspace', 'setDefault', { defaultWorkspace: 'selected' }),
		);

		expect(await runOne('hubWorkspace', 'setDefault', { defaultWorkspace: 'none' })).toEqual({
			workspaceId: uuid,
		});
		expect((await runOne('hubWorkspace', 'getDefault')).workspaceId).toBe(uuid);
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

	// Catalog (Workspace Settings): GET always answers "PM"; PUT accepts only "PM", and any other
	// IntegrationSystem value is a 400 {code: UNSUPPORTED_TASK_SYSTEM, message, supported: ["PM"]}.
	it('preferred integration: PM is set and read back; Hub refuses another system with its code', async () => {
		expect((await runOne('hubIntegration', 'getPreferred')).preferredIntegration).toBe('PM');
		expect(await runOne('hubIntegration', 'setPreferred', { preferredIntegration: 'PM' })).toEqual({
			preferredIntegration: 'PM',
		});
		expect((await runOne('hubIntegration', 'getPreferred')).preferredIntegration).toBe('PM');

		// An expression can still send another value; Hub's own refusal reaches the user.
		const error = await runError('hubIntegration', 'setPreferred', {
			preferredIntegration: 'JIRA',
		});
		expect(hubError(error)).toBe(
			'400 Dutify Cloud is the supported task system. The only accepted value is "PM".',
		);
		expect(error.description).toContain('Code: UNSUPPORTED_TASK_SYSTEM');
		expect((await runOne('hubIntegration', 'getPreferred')).preferredIntegration).toBe('PM');
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
		"%s shows Hub's 409 INTEGRATION_NOT_CONNECTED while the workspace has no such integration",
		async ([operation, systems, vendor, params], ctx) => {
			if (await connected(systems)) {
				ctx.skip(`${vendor} is connected; the test does not overwrite a real destination`);

				return;
			}
			const call = await callOrSkip(ctx);
			const error = await runError('call', operation, { call, ...params });
			expect(error.httpCode).toBe('409');
			expect(error.message).toMatch(
				new RegExp(`^Cannot select an? ${vendor} destination: it is not connected to workspace`),
			);
			expect(error.description).toContain('Code: INTEGRATION_NOT_CONNECTED');
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
			// Deletes the uploaded call if the test stops before its own delete (404 = already gone).
			cleanup.add('uploaded call', async () => await runOne('call', 'delete', { call }));

			// The catalog gives 200 OK and no body schema; Hub answers the JSON scalar `true`, which
			// the node outputs as `{ value: true }` like every other scalar response.
			expect(await runOne('call', 'delete', { call })).toEqual({ value: true });
			expect((await runError('call', 'get', { call })).httpCode).toBe('404');
		},
		PROCESSING_TIMEOUT_MS + 120_000,
	);

	/* ---------- Calendar Event ---------- */

	it(
		'list returns the events of a range; the pickers load',
		async () => {
			const now = Date.now();
			const events = await run('calendarEvent', 'list', {
				startDate: new Date(now - 7 * 864e5).toISOString(),
				endDate: new Date(now + 30 * 864e5).toISOString(),
				returnAll: true,
			});
			expect(Array.isArray(events)).toBe(true);
			expect(Array.isArray(await loadOptionsOf('getCalendarEvents'))).toBe(true);
			expect(Array.isArray(await loadOptionsOf('getCalendarSeries'))).toBe(true);
		},
		CALENDAR_TEST_MS(3),
	);

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
		CALENDAR_TEST_MS(1),
	);

	it(
		'event prompt round trip on a real calendar event, restoring it',
		async (ctx) => {
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
		},
		CALENDAR_TEST_MS(4),
	);
});
