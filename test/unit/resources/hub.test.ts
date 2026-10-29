import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { call, LENS_TIMEOUT_MS, lens, recording } from '../../../nodes/Dutify/resources/hub';
import type { OperationDef, ResourceDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

function opOf(resource: ResourceDef, name: string): OperationDef {
	const found = resource.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${resource.value}.${name}`);
	}

	return found;
}

const field = (resource: ResourceDef, operation: string, name: string) =>
	opOf(resource, operation).fields.find((f) => f.name === name);

const loaderOf = (resource: ResourceDef, operation: string, name: string) =>
	(field(resource, operation, name)?.typeOptions as { loadOptionsMethod?: string } | undefined)
		?.loadOptionsMethod;

describe('registration', () => {
	it('registers call, recording and lens, all workspace scoped', () => {
		for (const [def, value] of [
			[call, 'call'],
			[recording, 'recording'],
			[lens, 'lens'],
		] as const) {
			expect(resources).toContain(def);
			expect(def.value).toBe(value);
			// Hub reads the workspace of a personal key from X-Dutify-Workspace.
			expect(def.workspaceScoped).toBe(true);
		}
	});

	it('exposes the operations of the brief', () => {
		expect(call.operations.map((o) => o.operation)).toEqual([
			'list',
			'count',
			'search',
			'countSearch',
			'get',
			'delete',
			'setCustomPrompt',
			'clearCustomPrompt',
		]);
		expect(recording.operations.map((o) => o.operation)).toEqual([
			'getMediaUrl',
			'getAudioUrl',
			'getPreviewUrl',
			'getProcessingStatus',
			'getProgress',
			'regenerateSummary',
			'reprocess',
			'upload',
		]);
		expect(lens.operations.map((o) => o.operation)).toEqual(['ask', 'getUsage']);
	});
});

describe('call', () => {
	const CALLS = '/api/usercall';

	const paging = (maxPageSize: number) => ({
		kind: 'page',
		pageParam: 'page',
		sizeParam: 'size',
		zeroBased: true,
		maxPageSize,
	});

	it('list defaults to light rows: /search with an empty query and view=lite, 100 a page', () => {
		const op = opOf(call, 'list');
		expect(op.list).toBe(true);
		const expected = {
			method: 'GET',
			path: `${CALLS}/search`,
			qs: { query: '', view: 'lite' },
			paginate: paging(100),
		};
		expect(op.build!(reader({}))).toEqual(expected);
		expect(op.build!(reader({ additionalFields: {} }))).toEqual(expected);
		expect(op.build!(reader({ additionalFields: { lite: true } }))).toEqual(expected);
	});

	it('list with Light Rows off GETs /all (every transcript), 20 a page to keep a page near 4 MB', () => {
		expect(opOf(call, 'list').build!(reader({ additionalFields: { lite: false } }))).toEqual({
			method: 'GET',
			path: `${CALLS}/all`,
			paginate: paging(20),
		});
	});

	it('count GETs /all/count', () => {
		expect(opOf(call, 'count').build!(reader({}))).toEqual({
			method: 'GET',
			path: `${CALLS}/all/count`,
		});
	});

	it('search sends the query and defaults to light rows, 100 a page', () => {
		const op = opOf(call, 'search');
		expect(op.list).toBe(true);
		expect(op.build!(reader({ query: 'roadmap', additionalFields: {} }))).toEqual({
			method: 'GET',
			path: `${CALLS}/search`,
			qs: { query: 'roadmap', view: 'lite' },
			paginate: paging(100),
		});
	});

	it('search with Light Rows off sends no view and pages 20 at a time', () => {
		const spec = opOf(call, 'search').build!(
			reader({ query: 'x', additionalFields: { lite: false } }),
		);
		expect(spec.qs).toEqual({ query: 'x' });
		expect(spec.paginate).toEqual(paging(20));
	});

	it('Light Rows is on by default in list and search', () => {
		for (const name of ['list', 'search']) {
			const extra = field(call, name, 'additionalFields');
			const lite = (extra?.options as Array<{ name: string; default?: unknown }>).find(
				(o) => o.name === 'lite',
			);
			expect(lite?.default).toBe(true);
		}
	});

	it('countSearch GETs /search/count with the query', () => {
		expect(opOf(call, 'countSearch').build!(reader({ query: 'roadmap' }))).toEqual({
			method: 'GET',
			path: `${CALLS}/search/count`,
			qs: { query: 'roadmap' },
		});
	});

	it('call and recording pickers say only the 100 most recent calls are listed', () => {
		for (const f of [field(call, 'get', 'call'), field(recording, 'getProgress', 'recording')]) {
			expect(f?.description).toMatch(/100 most recent/);
			expect(f?.description).toMatch(/expression/);
		}
	});

	it('get GETs one call by integer ID, picked from the calls', () => {
		expect(opOf(call, 'get').build!(reader({ call: '42' }))).toEqual({
			method: 'GET',
			path: `${CALLS}/42`,
		});
		const f = field(call, 'get', 'call');
		expect(f?.required).toBe(true);
		expect(loaderOf(call, 'get', 'call')).toBe('getHubCalls');
	});
});

describe('call writes', () => {
	// Catalog (Calls): DELETE /usercall/{id}; PUT/DELETE /usercall/{id}/custom-prompt with
	// {customPrompt}.

	it('delete DELETEs the call by integer ID, picked from the calls', () => {
		expect(opOf(call, 'delete').build!(reader({ call: '42' }))).toEqual({
			method: 'DELETE',
			path: '/api/usercall/42',
		});
		expect(loaderOf(call, 'delete', 'call')).toBe('getHubCalls');
	});

	it('offers no third-party destination for action items: Hub no longer supports them', () => {
		const vendors = /jira|clickup|airtable|destination/i;
		for (const op of call.operations) {
			expect(op.operation).not.toMatch(vendors);
			expect(`${op.name} ${op.action} ${op.description}`).not.toMatch(vendors);
			for (const f of op.fields) {
				expect(`${f.name} ${f.displayName} ${f.description ?? ''}`).not.toMatch(vendors);
			}
		}
	});

	it('setCustomPrompt PUTs {customPrompt} on the call', () => {
		expect(
			opOf(call, 'setCustomPrompt').build!(reader({ call: '42', customPrompt: 'Focus on risks' })),
		).toEqual({
			method: 'PUT',
			path: '/api/usercall/42/custom-prompt',
			body: { customPrompt: 'Focus on risks' },
		});
	});

	it('setCustomPrompt refuses an empty prompt (Clear Custom Prompt removes it)', () => {
		expect(() =>
			opOf(call, 'setCustomPrompt').build!(reader({ call: '42', customPrompt: '  ' })),
		).toThrow(/Clear Custom Prompt/);
	});

	it('clearCustomPrompt DELETEs the call prompt', () => {
		expect(opOf(call, 'clearCustomPrompt').build!(reader({ call: '42' }))).toEqual({
			method: 'DELETE',
			path: '/api/usercall/42/custom-prompt',
		});
	});
});

describe('recording', () => {
	const REC = '/api/recording/7';
	const URL_ = 'https://store.example/rec.mp4?sig=abc';

	it.each([
		['getMediaUrl', 'media-url'],
		['getAudioUrl', 'audio-url'],
		['getPreviewUrl', 'preview-url'],
	])('%s GETs %s', async (operation, segment) => {
		const ctx = fakeContext([URL_]);
		const out = await opOf(recording, operation).run!(
			ctx,
			reader({ recording: '7', download: false, additionalFields: {} }),
		);
		expect(ctx.calls).toEqual([{ method: 'GET', path: `${REC}/${segment}` }]);
		expect(out).toEqual([{ json: { url: URL_ } }]);
	});

	it('passes expiryMinutes when set', async () => {
		const ctx = fakeContext([URL_]);
		await opOf(recording, 'getAudioUrl').run!(
			ctx,
			reader({ recording: '7', download: false, additionalFields: { expiryMinutes: 5 } }),
		);
		expect(ctx.calls[0]).toEqual({
			method: 'GET',
			path: `${REC}/audio-url`,
			qs: { expiryMinutes: 5 },
		});
	});

	it('reads the URL from an object response too', async () => {
		const ctx = fakeContext([{ url: URL_ }]);
		const out = await opOf(recording, 'getMediaUrl').run!(
			ctx,
			reader({ recording: '7', download: false, additionalFields: {} }),
		);
		expect(out).toEqual([{ json: { url: URL_ } }]);
	});

	it('download: true fetches the signed URL into binary property "data"', async () => {
		const ctx = fakeContext([URL_]);
		const seen: Array<[string, string | undefined]> = [];
		const original = ctx.downloadToBinary;
		ctx.downloadToBinary = async (url, fileName) => {
			seen.push([url, fileName]);

			return await original(url, fileName);
		};
		const out = await opOf(recording, 'getMediaUrl').run!(
			ctx,
			reader({ recording: '7', download: true, additionalFields: {} }),
		);
		expect(seen).toEqual([[URL_, 'recording-7-media']]);
		expect(out).toHaveLength(1);
		expect(out[0].json).toEqual({ url: URL_ });
		expect(out[0].binary?.data).toMatchObject({ fileName: 'recording-7-media' });
		// Only the URL request went through the authenticated client.
		expect(ctx.calls).toHaveLength(1);
	});

	it.each([
		['video/mp4', 'recording-7-media.mp4', 'mp4'],
		['audio/mp4', 'recording-7-media.m4a', 'm4a'],
		['audio/mpeg', 'recording-7-media.mp3', 'mp3'],
		['video/webm', 'recording-7-media.webm', 'webm'],
		['image/jpeg', 'recording-7-media.jpg', 'jpg'],
		['image/png', 'recording-7-media.png', 'png'],
	])('names the download from its content type: %s', async (mimeType, fileName, extension) => {
		const ctx = fakeContext([URL_]);
		ctx.downloadToBinary = async (_url, name) => ({ data: 'x', mimeType, fileName: name });
		const out = await opOf(recording, 'getMediaUrl').run!(
			ctx,
			reader({ recording: '7', download: true, additionalFields: {} }),
		);
		expect(out[0].binary?.data).toMatchObject({ fileName, fileExtension: extension, mimeType });
	});

	it('keeps the name without an extension for an unknown content type', async () => {
		const ctx = fakeContext([URL_]);
		ctx.downloadToBinary = async (_url, name) => ({
			data: 'x',
			mimeType: 'application/octet-stream',
			fileName: name,
		});
		const out = await opOf(recording, 'getMediaUrl').run!(
			ctx,
			reader({ recording: '7', download: true, additionalFields: {} }),
		);
		expect(out[0].binary?.data.fileName).toBe('recording-7-media');
		expect(out[0].binary?.data.fileExtension).toBeUndefined();
	});

	it('download: false never downloads', async () => {
		const ctx = fakeContext([URL_]);
		let downloads = 0;
		ctx.downloadToBinary = async () => {
			downloads++;
			throw new Error('should not download');
		};
		const out = await opOf(recording, 'getPreviewUrl').run!(
			ctx,
			reader({ recording: '7', download: false, additionalFields: {} }),
		);
		expect(downloads).toBe(0);
		expect(out[0].binary).toBeUndefined();
	});

	it('every URL operation has a download boolean defaulting to false', () => {
		for (const name of ['getMediaUrl', 'getAudioUrl', 'getPreviewUrl']) {
			const f = field(recording, name, 'download');
			expect(f?.type).toBe('boolean');
			expect(f?.default).toBe(false);
		}
	});

	it('getProcessingStatus GETs processing-status', () => {
		expect(opOf(recording, 'getProcessingStatus').build!(reader({ recording: '7' }))).toEqual({
			method: 'GET',
			path: `${REC}/processing-status`,
		});
	});

	it('getProgress GETs progress', () => {
		expect(opOf(recording, 'getProgress').build!(reader({ recording: '7' }))).toEqual({
			method: 'GET',
			path: `${REC}/progress`,
		});
	});

	it('regenerateSummary POSTs saveToDb (the body is required) and wraps the text', async () => {
		const op = opOf(recording, 'regenerateSummary');
		const ctx = fakeContext(['The new summary']);
		const out = await op.run!(ctx, reader({ recording: '7', saveToDb: false }));
		expect(ctx.calls).toEqual([
			{ method: 'POST', path: `${REC}/regenerate-summary`, body: { saveToDb: false } },
		]);
		expect(out).toEqual([{ json: { summary: 'The new summary' } }]);
		expect(field(recording, 'regenerateSummary', 'saveToDb')?.default).toBe(true);
	});

	/*
	 * Reprocess queues the run (schedule-reprocess) and returns at once: the immediate /reprocess
	 * runs the whole pipeline while the request waits, which can outlast n8n's HTTP timeout.
	 * schedule-reprocess answers 200 with no body (Hub PR #393).
	 */
	it('reprocess POSTs schedule-reprocess with an empty body by default and reports it queued', async () => {
		const ctx = fakeContext(['']);
		const out = await opOf(recording, 'reprocess').run!(
			ctx,
			reader({ recording: '7', additionalFields: {} }),
		);
		expect(ctx.calls).toEqual([{ method: 'POST', path: `${REC}/schedule-reprocess`, body: {} }]);
		expect(out).toEqual([{ json: { recording: '7', scheduled: true } }]);
	});

	it('reprocess sends only the options that were set', async () => {
		const ctx = fakeContext([undefined]);
		await opOf(recording, 'reprocess').run!(
			ctx,
			reader({
				recording: '7',
				additionalFields: {
					callProcessingMethod: 'GPT_6_LUNA',
					callReasoningEffort: 'HIGH',
					applyCorrections: false,
				},
			}),
		);
		expect(ctx.calls[0].body).toEqual({
			callProcessingMethod: 'GPT_6_LUNA',
			callReasoningEffort: 'HIGH',
			isCallApplyCorrections: false,
		});
	});

	it("reprocess passes Hub's refusal on (404 NOT_FOUND, 402, 409)", async () => {
		const refusal = Object.assign(new Error('Recording not found'), { httpCode: '404' });
		const ctx = fakeContext([refusal]);
		await expect(
			opOf(recording, 'reprocess').run!(ctx, reader({ recording: '7', additionalFields: {} })),
		).rejects.toBe(refusal);
	});

	it('reprocess says it returns at once and how to follow the run', () => {
		expect(opOf(recording, 'reprocess').description).toMatch(/Get Processing Status/);
	});

	it('picks the recording from getHubRecordings in every operation on a recording', () => {
		for (const o of recording.operations.filter((op) => op.operation !== 'upload')) {
			expect(loaderOf(recording, o.operation, 'recording')).toBe('getHubRecordings');
		}
	});
});

describe('lens', () => {
	const ask = opOf(lens, 'ask');

	it('POSTs the question as lastMessage and returns the answer text as an item', async () => {
		const ctx = fakeContext(['Two decisions were made.']);
		const out = await ask.run!(
			ctx,
			reader({ message: 'What did we decide?', additionalFields: {} }),
		);
		expect(ctx.calls).toEqual([
			{
				method: 'POST',
				path: '/api/lens/chat',
				timeout: 120000,
				body: { lastMessage: { content: 'What did we decide?' } },
			},
		]);
		expect(out).toEqual([{ json: { answer: 'Two decisions were made.' } }]);
	});

	it('sets an explicit 120 s timeout: the answer can take 15 to 30 s', async () => {
		const ctx = fakeContext(['ok']);
		await ask.run!(ctx, reader({ message: 'q', additionalFields: {} }));
		expect(LENS_TIMEOUT_MS).toBe(120000);
		expect(ctx.calls[0].timeout).toBe(120000);
	});

	it('passes an object answer through unchanged', async () => {
		const ctx = fakeContext([{ answer: 'x', sources: [] }]);
		const out = await ask.run!(ctx, reader({ message: 'q', additionalFields: {} }));
		expect(out).toEqual([{ json: { answer: 'x', sources: [] } }]);
	});

	it('sends prior turns as history, from JSON text or an array', async () => {
		const history = [
			{ user: 'user', content: 'hi' },
			{ user: 'assistant', content: 'hello' },
		];
		for (const value of [JSON.stringify(history), history]) {
			const ctx = fakeContext(['ok']);
			await ask.run!(ctx, reader({ message: 'q', additionalFields: { history: value } }));
			expect(ctx.calls[0].body).toEqual({ lastMessage: { content: 'q' }, history });
		}
	});

	it('refuses history that is not an array, or longer than 20 turns, before any request', async () => {
		for (const bad of ['{"a":1}', 'nope', JSON.stringify(Array(21).fill({ content: 'x' }))]) {
			const ctx = fakeContext([]);
			await expect(
				ask.run!(ctx, reader({ message: 'q', additionalFields: { history: bad } })),
			).rejects.toThrow(/history/i);
			expect(ctx.calls).toEqual([]);
		}
	});

	it('requires the message', () => {
		expect(field(lens, 'ask', 'message')?.required).toBe(true);
	});
});

/*
 * AI Coworker usage (Hub PR #393, operationId getAiCoworkerUsage): GET
 * /api/v1/lens/credits/by-workspace/{workspace UUID}, scope lens:chat, only the key's own
 * workspace. 200 {allowanceRemaining, purchasedBalance, total, monthlyAllowance, cycleResetsAt}.
 */
describe('AI Coworker usage', () => {
	const usage = opOf(lens, 'getUsage');
	const UUID = '3f1c2a9e-1b2c-4d5e-8f90-123456789abc';
	const balance = {
		allowanceRemaining: 20,
		purchasedBalance: 5,
		total: 25,
		monthlyAllowance: 25,
		cycleResetsAt: '2026-11-01T00:00:00Z',
	};

	it("finds the workspace's Hub UUID, then reads its usage balance", async () => {
		const ctx = fakeContext([[{ id: UUID, identifier: 'ws-1', name: 'Team' }], balance]);
		const out = await usage.run!(ctx, reader({}, 'ws-1'));
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: '/api/v1/workspaces' },
			{ method: 'GET', path: `/api/v1/lens/credits/by-workspace/${UUID}` },
		]);
		expect(out).toEqual([{ json: balance }]);
	});

	it('refuses a workspace Hub does not list for the key, before reading any balance', async () => {
		const ctx = fakeContext([[{ id: UUID, identifier: 'other' }]]);
		await expect(usage.run!(ctx, reader({}, 'ws-1'))).rejects.toThrow(/does not list/);
		expect(ctx.calls).toHaveLength(1);
	});

	it('has no fields and is named for the AI Coworker, not Lens', () => {
		expect(usage.fields).toEqual([]);
		expect(`${usage.name} ${usage.action} ${usage.description}`).not.toMatch(/lens/i);
		expect(usage.description).toMatch(/AI_COWORKER_USAGE_EXHAUSTED/);
	});
});
