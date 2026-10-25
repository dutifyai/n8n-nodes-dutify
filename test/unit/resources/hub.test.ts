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
		]);
		expect(recording.operations.map((o) => o.operation)).toEqual([
			'getMediaUrl',
			'getAudioUrl',
			'getPreviewUrl',
			'getProcessingStatus',
			'getProgress',
			'regenerateSummary',
			'reprocess',
		]);
		expect(lens.operations.map((o) => o.operation)).toEqual(['ask']);
	});
});

describe('call', () => {
	const CALLS = '/api/usercall';

	it('list GETs /all, paged from zero', () => {
		const op = opOf(call, 'list');
		expect(op.list).toBe(true);
		const spec = op.build!(reader({}));
		expect(spec).toEqual({
			method: 'GET',
			path: `${CALLS}/all`,
			paginate: {
				kind: 'page',
				pageParam: 'page',
				sizeParam: 'size',
				zeroBased: true,
				maxPageSize: 100,
			},
		});
	});

	it('count GETs /all/count', () => {
		expect(opOf(call, 'count').build!(reader({}))).toEqual({
			method: 'GET',
			path: `${CALLS}/all/count`,
		});
	});

	it('search sends the query and pages like list', () => {
		const op = opOf(call, 'search');
		expect(op.list).toBe(true);
		expect(op.build!(reader({ query: 'roadmap', additionalFields: {} }))).toEqual({
			method: 'GET',
			path: `${CALLS}/search`,
			qs: { query: 'roadmap' },
			paginate: {
				kind: 'page',
				pageParam: 'page',
				sizeParam: 'size',
				zeroBased: true,
				maxPageSize: 100,
			},
		});
	});

	it('search sends view=lite only when asked for', () => {
		const spec = opOf(call, 'search').build!(
			reader({ query: 'x', additionalFields: { lite: true } }),
		);
		expect(spec.qs).toEqual({ query: 'x', view: 'lite' });
	});

	it('countSearch GETs /search/count with the query', () => {
		expect(opOf(call, 'countSearch').build!(reader({ query: 'roadmap' }))).toEqual({
			method: 'GET',
			path: `${CALLS}/search/count`,
			qs: { query: 'roadmap' },
		});
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

	it('reprocess POSTs an empty body by default', () => {
		expect(
			opOf(recording, 'reprocess').build!(reader({ recording: '7', additionalFields: {} })),
		).toEqual({ method: 'POST', path: `${REC}/reprocess`, body: {} });
	});

	it('reprocess sends only the options that were set', () => {
		expect(
			opOf(recording, 'reprocess').build!(
				reader({
					recording: '7',
					additionalFields: {
						callProcessingMethod: 'GPT_6_LUNA',
						callReasoningEffort: 'HIGH',
						applyCorrections: true,
					},
				}),
			).body,
		).toEqual({
			callProcessingMethod: 'GPT_6_LUNA',
			callReasoningEffort: 'HIGH',
			isCallApplyCorrections: true,
		});
	});

	it('picks the recording from getHubRecordings in every operation', () => {
		for (const o of recording.operations) {
			expect(loaderOf(recording, o.operation, 'recording')).toBe('getHubRecordings');
		}
	});
});

describe('lens', () => {
	const ask = opOf(lens, 'ask');

	it('POSTs the question as lastMessage and returns the answer text as an item', async () => {
		const ctx = fakeContext(['Two decisions were made.']);
		const out = await ask.run!(ctx, reader({ message: 'What did we decide?', additionalFields: {} }));
		expect(ctx.calls).toEqual([
			{ method: 'POST', path: '/api/lens/chat', timeout: 120000, body: { lastMessage: { content: 'What did we decide?' } } },
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
