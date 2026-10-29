import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { sleep } from 'n8n-workflow';
import type { IDataObject } from 'n8n-workflow';
import { dutifyErrorOf } from '../../shared/transport';
import {
	cleanupStack,
	live,
	liveDescribe,
	loadOptionsOf,
	rawRequest,
	readAudioFile,
	readVideoFile,
	run,
	runError,
	runId,
	runOne,
	runOperation,
} from './harness';

/*
 * Hub calls, recordings and the AI Coworker against ONE reusable test recording: a ~27 s two-speaker standup
 * ("Atlas launch", two action items) in the test workspace. The suite reuses the workspace's
 * recording; only when there is none does it upload `DUTIFY_TEST_AUDIO` (from .dutify-test.env)
 * through Recording > Upload, which also checks that operation, and waits until it is processed.
 * Without a recording and without that file, the suite skips with the reason.
 *
 * The operations that spend AI credits (Regenerate Summary, Reprocess, AI Coworker Ask) run only
 * with DUTIFY_TEST_PAID_OPS=1 in .dutify-test.env.
 *
 * The error codes, the progress of 100, the preview 404, the signed links of an uploaded video and
 * AI Coworker > Get Usage are Hub PR #393 (chatgpttests/dutify-backend-java).
 */

const MARKER = 'Atlas';
const PROCESSING_TIMEOUT_MS = 15 * 60_000;

interface TestRecording {
	call: string;
	recording: string;
}

async function processingStatus(recording: string): Promise<IDataObject> {
	return await runOne('recording', 'getProcessingStatus', { recording });
}

async function waitUntilProcessed(recording: string): Promise<IDataObject> {
	const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
	for (;;) {
		const status = await processingStatus(recording);
		if (status.processed === true) {
			return status;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`recording ${recording} not processed after 15 min: ${JSON.stringify(status)}`,
			);
		}
		await sleep(15_000);
	}
}

/** The workspace's test recording: the newest call's first recording. */
async function findRecording(): Promise<TestRecording | undefined> {
	for (const row of await run('call', 'list', { limit: 10 })) {
		const recordings = ((row.call as IDataObject | undefined)?.recordings ?? []) as IDataObject[];
		const first = recordings.find((r) => r.id !== undefined && r.id !== null);
		if (first) {
			return { call: String(row.id), recording: String(first.id) };
		}
	}

	return undefined;
}

async function uploadRecording(audio: Buffer): Promise<TestRecording> {
	const [item] = await runOperation(
		'recording',
		'upload',
		{
			binaryPropertyName: 'data',
			additionalFields: { fileName: 'n8n-live-standup.mp3', noteTemplate: 'standup' },
		},
		{ property: 'data', data: audio, mimeType: 'audio/mpeg', fileName: 'n8n-live-standup.mp3' },
	);
	const recording = String(item.json.recordingId);
	expect(recording).toMatch(/^\d+$/);
	const status = await waitUntilProcessed(recording);

	return { call: String(status.userCallId), recording };
}

let target: TestRecording | undefined;
let skipReason = '';

liveDescribe('Hub call, recording and AI Coworker — live', () => {
	beforeAll(async () => {
		target = await findRecording();
		if (!target) {
			const audio = readAudioFile();
			if (!audio) {
				skipReason =
					'no recording in the test workspace and no DUTIFY_TEST_AUDIO file to upload one';

				return;
			}
			target = await uploadRecording(audio);
		}
	}, PROCESSING_TIMEOUT_MS + 60_000);

	const withRecording =
		(
			name: string,
			body: (t: TestRecording, ctx: TestContext) => Promise<void>,
			timeout?: number,
			paidOp = false,
		) =>
		() =>
			it(
				name,
				async (ctx) => {
					if (!target) {
						ctx.skip(skipReason);

						return;
					}
					if (paidOp && !live.paidOps) {
						ctx.skip('spends AI credits; set DUTIFY_TEST_PAID_OPS=1 to run it');

						return;
					}
					await body(target, ctx);
				},
				timeout,
			);

	withRecording(
		'the test recording is processed',
		async (t) => {
			const status = await waitUntilProcessed(t.recording);
			expect(status).toMatchObject({ id: Number(t.recording), processed: true });
			expect(String(status.userCallId)).toBe(t.call);
			// A processed recording reports 100, in both progress answers.
			expect(Number(status.progress)).toBe(100);
			const progress = await runOne('recording', 'getProgress', { recording: t.recording });
			expect(Number(progress.value)).toBe(100);
		},
		PROCESSING_TIMEOUT_MS,
	)();

	withRecording('call list (light and full), count, search and countSearch find it', async (t) => {
		const lite = await run('call', 'list', { returnAll: true });
		expect(lite.map((c) => String(c.id))).toContain(t.call);
		const full = await run('call', 'list', { limit: 5, additionalFields: { lite: false } });
		expect(full.map((c) => String(c.id))).toContain(t.call);
		const count = await runOne('call', 'count');
		expect(Number(count.value)).toBeGreaterThanOrEqual(1);

		const found = await run('call', 'search', { query: MARKER, limit: 5 });
		expect(found.map((c) => String(c.id))).toContain(t.call);
		const counted = await runOne('call', 'countSearch', { query: MARKER });
		expect(Number(counted.value)).toBeGreaterThanOrEqual(1);
		const none = await runOne('call', 'countSearch', { query: 'zq-no-such-meeting-xv' });
		expect(Number(none.value)).toBe(0);
	})();

	withRecording('get returns the call with its summary and the recording', async (t) => {
		const call = await runOne('call', 'get', { call: t.call });
		expect(String(call.id)).toBe(t.call);
		const recordings = ((call.call as IDataObject).recordings ?? []) as IDataObject[];
		expect(recordings.map((r) => String(r.id))).toContain(t.recording);
		expect(JSON.stringify(call)).toMatch(/Atlas/i);
	})();

	withRecording('the call and recording pickers list it', async (t) => {
		expect((await loadOptionsOf('getHubCalls')).map((o) => o.value)).toContain(t.call);
		expect((await loadOptionsOf('getHubRecordings')).map((o) => o.value)).toContain(t.recording);
	})();

	// The test recording is an uploaded audio file: Hub signs its media and audio URLs (Hub #372).
	// An audio file has no preview image, so the preview URL answers 404 NO_PREVIEW.
	withRecording(
		'media and audio URLs of an uploaded audio recording are signed https URLs; preview is 404 NO_PREVIEW',
		async (t) => {
			for (const operation of ['getMediaUrl', 'getAudioUrl']) {
				const result = await runOne('recording', operation, { recording: t.recording });
				expect(JSON.stringify(result)).toMatch(/"https:\/\/[^"]+/);
			}
			const error = await runError('recording', 'getPreviewUrl', { recording: t.recording });
			expect(error.httpCode).toBe('404');
			expect(error.message).toBe('Recording has no preview image');
			expect(dutifyErrorOf(error).code).toBe('NO_PREVIEW');
			expect(error.description).toBe('Code: NO_PREVIEW');
		},
	)();

	it('an unknown call and an unknown recording answer 404 NOT_FOUND with a message', async () => {
		const call = await runError('call', 'get', { call: '999999999' });
		expect(call.httpCode).toBe('404');
		expect(dutifyErrorOf(call).code).toBe('NOT_FOUND');
		expect(call.message).toMatch(/not found/i);
		for (const operation of ['getProcessingStatus', 'getProgress', 'getMediaUrl']) {
			const recording = await runError('recording', operation, { recording: '999999999' });
			expect(recording.httpCode).toBe('404');
			expect(recording.message).toBe('Recording not found');
			expect(dutifyErrorOf(recording).code).toBe('NOT_FOUND');
		}
	});

	// Reprocess queues the run (schedule-reprocess); a recording that does not exist is refused
	// before anything is queued, so this spends nothing.
	it('reprocess of an unknown recording answers 404 NOT_FOUND', async () => {
		const error = await runError('recording', 'reprocess', {
			recording: '999999999',
			additionalFields: {},
		});
		expect(error.httpCode).toBe('404');
		expect(dutifyErrorOf(error).code).toBe('NOT_FOUND');
	});

	it('AI Coworker > Get Usage reads the workspace balance', async () => {
		const usage = await runOne('lens', 'getUsage');
		for (const key of ['allowanceRemaining', 'purchasedBalance', 'total', 'monthlyAllowance']) {
			expect(Number.isInteger(usage[key])).toBe(true);
			expect(Number(usage[key])).toBeGreaterThanOrEqual(0);
		}
		expect(usage.total).toBe(Number(usage.allowanceRemaining) + Number(usage.purchasedBalance));
		expect(Number(usage.allowanceRemaining)).toBeLessThanOrEqual(Number(usage.monthlyAllowance));
		expect(Number.isNaN(Date.parse(String(usage.cycleResetsAt)))).toBe(false);
	});

	// Asking with nothing left spends nothing, so it runs whenever the balance is 0.
	it('AI Coworker > Ask with no usage left answers 402 AI_COWORKER_USAGE_EXHAUSTED', async (ctx) => {
		const usage = await runOne('lens', 'getUsage');
		if (Number(usage.total) > 0) {
			ctx.skip(`the workspace still has ${String(usage.total)} AI Coworker questions left`);

			return;
		}
		const error = await runError('lens', 'ask', { message: 'Anything new?', additionalFields: {} });
		expect(error.httpCode).toBe('402');
		expect(dutifyErrorOf(error).code).toBe('AI_COWORKER_USAGE_EXHAUSTED');
		expect(error.message).toMatch(/^This workspace has used up its AI Coworker usage\./);
		expect(error.message).not.toMatch(/lens/i);
	});

	/* ---------- paid: AI credits, only with DUTIFY_TEST_PAID_OPS=1 ---------- */

	const paid = (name: string, body: (t: TestRecording) => Promise<void>) =>
		withRecording(name, body, PROCESSING_TIMEOUT_MS, true)();

	paid(
		'reprocess queues the pipeline at once and the recording ends processed again',
		async (t) => {
			const started = Date.now();
			const [result] = await run('recording', 'reprocess', {
				recording: t.recording,
				additionalFields: {},
			});
			expect(result).toEqual({ recording: t.recording, scheduled: true });
			// Queued, not run while the request waits.
			expect(Date.now() - started).toBeLessThan(20_000);
			const status = await waitUntilProcessed(t.recording);
			expect(Number(status.progress)).toBe(100);
		},
	);

	paid('regenerateSummary returns a new summary without saving it', async (t) => {
		const [result] = await run('recording', 'regenerateSummary', {
			recording: t.recording,
			saveToDb: false,
		});
		expect(JSON.stringify(result)).toMatch(/Atlas|login|checklist/i);
	});

	// The FREE test workspace has a small AI Coworker allowance; once it is spent, Hub answers
	// 402 AI_COWORKER_USAGE_EXHAUSTED, and the test skips with that reason.
	withRecording(
		'AI Coworker answers a question about the standup from the recording',
		async (_t, ctx) => {
			let answer: IDataObject | undefined;
			let failure: Error | undefined;
			try {
				[answer] = await run('lens', 'ask', {
					message: 'What are the two action items from the Atlas launch standup?',
					additionalFields: {},
				});
			} catch (error) {
				failure = error as Error;
			}
			if (failure && dutifyErrorOf(failure).code === 'AI_COWORKER_USAGE_EXHAUSTED') {
				ctx.skip(failure.message);

				return;
			}
			expect(failure?.message).toBeUndefined();
			// The recording's two action items: Sarah ships the mobile login fix by Wednesday, Alex
			// sends the launch checklist by Friday. A real answer names both, from the recording.
			const text = String(answer?.answer ?? '');
			await ctx.annotate(`AI Coworker answer: ${text}`);
			expect(text.length).toBeGreaterThan(40);
			expect(text).toMatch(/login/i);
			expect(text).toMatch(/checklist/i);
		},
		PROCESSING_TIMEOUT_MS,
		true,
	)();
});

/*
 * An uploaded video has a preview thumbnail, which the audio test recording lacks, and Hub signs
 * its file for Get Media URL and Get Audio URL (Hub PR #393). Uploading and
 * processing one spends transcription minutes and AI, so this runs only with
 * DUTIFY_TEST_PAID_OPS=1 and a DUTIFY_TEST_VIDEO file (a short mp4 of the same standup). The
 * call is hard-deleted afterwards, so the audio recording stays the workspace's newest call.
 */
liveDescribe('Hub recording preview of an uploaded video — live (paid)', () => {
	const cleanup = cleanupStack();
	afterAll(async () => await cleanup.run(), 120_000);

	it(
		'a processed video upload: preview is an image, media and audio URLs sign the video',
		async (ctx) => {
			const video = readVideoFile();
			if (!live.paidOps || !video) {
				ctx.skip(
					'uploads and processes a video (transcription minutes and AI); set DUTIFY_TEST_PAID_OPS=1 and DUTIFY_TEST_VIDEO',
				);

				return;
			}
			const fileName = `n8n-live-preview-${runId}.mp4`;
			const [item] = await runOperation(
				'recording',
				'upload',
				{ binaryPropertyName: 'data', additionalFields: { fileName, noteTemplate: 'standup' } },
				{ property: 'data', data: video, mimeType: 'video/mp4', fileName },
			);
			const recording = String(item.json.recordingId);
			expect(recording).toMatch(/^\d+$/);
			const status = await waitUntilProcessed(recording);
			const call = String(status.userCallId);
			cleanup.add(`hub call ${call}`, async () => {
				await rawRequest({ method: 'DELETE', path: `/api/usercall/${encodeURIComponent(call)}` });
			});

			const preview = await runOne('recording', 'getPreviewUrl', { recording });
			expect(String(preview.url)).toMatch(/^https:\/\//);
			const image = await fetch(String(preview.url));
			expect(image.status).toBe(200);
			expect(String(image.headers.get('content-type'))).toMatch(/^image\//);

			const [downloaded] = await runOperation('recording', 'getPreviewUrl', {
				recording,
				download: true,
			});
			expect(String(downloaded.binary?.data.mimeType)).toMatch(/^image\//);
			expect(Number(downloaded.binary?.data.fileSize)).toBeGreaterThan(0);

			// An uploaded video has no separate audio track: both links sign the video file.
			for (const operation of ['getMediaUrl', 'getAudioUrl']) {
				const signed = await runOne('recording', operation, { recording });
				expect(String(signed.url)).toMatch(/^https:\/\//);
				const head = await fetch(String(signed.url), { headers: { Range: 'bytes=0-0' } });
				expect([200, 206]).toContain(head.status);
				expect(String(head.headers.get('content-type'))).toMatch(/^video\//);
				await head.body?.cancel();
			}

			await rawRequest({ method: 'DELETE', path: `/api/usercall/${encodeURIComponent(call)}` });
			const gone = await runError('call', 'get', { call });
			expect(gone.httpCode).toBe('404');
		},
		PROCESSING_TIMEOUT_MS + 60_000,
	);
});
