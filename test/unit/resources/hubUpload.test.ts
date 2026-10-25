import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	MAX_UPLOAD_BYTES,
	partCount,
	partsOf,
	recording,
	uploadTiming,
} from '../../../nodes/Dutify/resources/hub';
import type { BinaryStream, ByteStream, OperationDef } from '../../../shared/types';
import { byteStream, fakeContext, reader } from '../helpers';

/*
 * Contract: https://dutify.ai/api/v1/api-catalog/Recording%20Upload and Hub origin/master
 * (VideoResource, VideoService, MultipartVideoUploads):
 * (1) POST /videos/upload-session {fileName, fileSize ≤ 5000 MiB, resumable} →
 *     {blobName, uploadUrl, expiresAtEpochMs, partSize}. With resumable=true and multipart storage,
 *     uploadUrl is null and partSize is set (16 MiB); otherwise uploadUrl takes one PUT of the file.
 * (2) Multipart: POST /videos/upload-session/{blobName}/parts/{n} (1-based) → {uploadUrl}; PUT that
 *     part's bytes there (every part is partSize bytes except the last). No Dutify auth on PUTs.
 * (3) POST /videos/complete {blobName, recordedAt?, userNotes?, noteTemplate?} → VideoDTO with
 *     recordingId. 503 = transient storage check, retry with the same blobName.
 * DELETE /videos/upload-session/{blobName} frees the slot of an upload that will not complete.
 */

const MiB = 1024 * 1024;
const upload = recording.operations.find((o) => o.operation === 'upload') as OperationDef;
const params = (additionalFields: Record<string, unknown> = {}) =>
	reader({ binaryPropertyName: 'data', additionalFields });

const multipart = { blobName: 'blob-1', uploadUrl: null, expiresAtEpochMs: 1, partSize: 4 };
const single = {
	blobName: 'blob-1',
	uploadUrl: 'https://r2.example.com/put?sig=1',
	expiresAtEpochMs: 1,
	partSize: null,
};
const completed = { blobName: 'blob-1', name: 'data.txt', size: 11, recordingId: 501 };
const signed = (n: number) => ({ uploadUrl: `https://r2.example.com/part?n=${n}` });

function httpError(code: string, message = `HTTP ${code}`): Error {
	return Object.assign(new Error(message), { httpCode: code });
}

/** A binary of `text`, delivered by the stream in the given chunks. */
function streamOf(chunks: string[], size?: number): BinaryStream {
	return {
		content: byteStream(chunks.map((c) => Buffer.from(c))),
		size: size ?? Buffer.byteLength(chunks.join('')),
		mimeType: 'audio/mpeg',
		fileName: 'standup.mp3',
	};
}

/** Every test: the whole-file reader is never used by the upload. */
function noBuffering(ctx: ReturnType<typeof fakeContext>) {
	ctx.readBinary = async () => {
		throw new Error('the upload must not read the whole file into memory');
	};

	return ctx;
}

beforeEach(() => {
	uploadTiming.retryDelayMs = 0;
});
afterEach(() => {
	uploadTiming.retryDelayMs = 2000;
});

describe('partCount', () => {
	it('is the number of partSize parts, the last one shorter', () => {
		expect(partCount(11, 4)).toBe(3);
		expect(partCount(8, 4)).toBe(2);
		expect(partCount(1, 16 * MiB)).toBe(1);
		expect(partCount(16 * MiB, 16 * MiB)).toBe(1);
		expect(partCount(16 * MiB + 1, 16 * MiB)).toBe(2);
		expect(partCount(MAX_UPLOAD_BYTES, 16 * MiB)).toBe(313);
	});
});

describe('partsOf', () => {
	const collect = async (chunks: string[], partSize: number) => {
		const parts: string[] = [];
		for await (const part of partsOf(byteStream(chunks.map((c) => Buffer.from(c))), partSize)) {
			parts.push(part.toString('utf8'));
		}

		return parts;
	};

	it('regroups stream chunks of any size into parts of exactly partSize, the last shorter', async () => {
		expect(await collect(['bi', 'nary:da', 'ta'], 4)).toEqual(['bina', 'ry:d', 'ata']);
		expect(await collect(['binary:data'], 4)).toEqual(['bina', 'ry:d', 'ata']);
		expect(await collect(['b', 'i', 'n', 'a', 'r', 'y'], 3)).toEqual(['bin', 'ary']);
	});

	it('cuts bytes already in memory (n8n memory mode) the same way', async () => {
		const parts: string[] = [];
		for await (const part of partsOf(Buffer.from('binary:data'), 4)) {
			parts.push(part.toString('utf8'));
		}
		expect(parts).toEqual(['bina', 'ry:d', 'ata']);
	});

	it('yields nothing for an empty stream', async () => {
		expect(await collect([], 4)).toEqual([]);
	});

	it('never holds much more than one part', async () => {
		// 64 chunks of 1 KiB with 4 KiB parts: every part is handed out before the next is built.
		const chunk = Buffer.alloc(1024, 1);
		const parts: number[] = [];
		for await (const part of partsOf(byteStream(Array.from({ length: 64 }, () => chunk)), 4096)) {
			parts.push(part.length);
		}
		expect(parts).toEqual(Array.from({ length: 16 }, () => 4096));
	});
});

describe('recording upload, multipart (the default for every file)', () => {
	it('opens a resumable session, signs and PUTs each part in order from the stream, then completes', async () => {
		const ctx = noBuffering(fakeContext([multipart, signed(1), signed(2), signed(3), completed]));
		const out = await upload.run!(ctx, params());
		expect(ctx.calls[0]).toEqual({
			method: 'POST',
			path: '/api/videos/upload-session',
			body: { fileName: 'data.txt', fileSize: 11, resumable: true },
		});
		expect(ctx.events).toEqual([
			'POST /api/videos/upload-session',
			'POST /api/videos/upload-session/blob-1/parts/1',
			'PUT https://r2.example.com/part?n=1',
			'POST /api/videos/upload-session/blob-1/parts/2',
			'PUT https://r2.example.com/part?n=2',
			'POST /api/videos/upload-session/blob-1/parts/3',
			'PUT https://r2.example.com/part?n=3',
			'POST /api/videos/complete',
		]);
		expect(ctx.puts.map((p) => p.data.toString('utf8'))).toEqual(['bina', 'ry:d', 'ata']);
		expect(ctx.puts.every((p) => p.mimeType === 'text/plain')).toBe(true);
		expect(ctx.calls.at(-1)?.body).toEqual({ blobName: 'blob-1' });
		expect(out).toEqual([{ json: completed }]);
	});

	it('cuts parts at partSize whatever chunks the stream delivers', async () => {
		const ctx = noBuffering(fakeContext([multipart, signed(1), signed(2), signed(3), completed]));
		ctx.openBinary = async () => streamOf(['bi', 'nary:da', 'ta']);
		await upload.run!(ctx, params());
		expect(ctx.puts.map((p) => p.data.toString('utf8'))).toEqual(['bina', 'ry:d', 'ata']);
		expect(ctx.puts.every((p) => p.mimeType === 'audio/mpeg')).toBe(true);
		expect(ctx.calls[0].body).toMatchObject({ fileName: 'standup.mp3', fileSize: 11 });
	});

	it('sends the file name override, recordedAt, notes and note template when set', async () => {
		const ctx = noBuffering(fakeContext([multipart, signed(1), signed(2), signed(3), completed]));
		await upload.run!(
			ctx,
			params({
				fileName: 'standup.mp3',
				recordedAt: '2026-10-25T09:00:00',
				userNotes: 'Daily standup',
				noteTemplate: 'standup',
			}),
		);
		expect(ctx.calls[0].body).toEqual({ fileName: 'standup.mp3', fileSize: 11, resumable: true });
		expect(ctx.calls.at(-1)?.body).toEqual({
			blobName: 'blob-1',
			// n8n date pickers omit the zone; like every other date field it is read as UTC.
			recordedAt: '2026-10-25T09:00:00Z',
			userNotes: 'Daily standup',
			noteTemplate: 'standup',
		});
	});

	it('releases the session and surfaces the error when a part PUT fails', async () => {
		const ctx = noBuffering(fakeContext([multipart, signed(1), signed(2), undefined]));
		let puts = 0;
		ctx.putBinary = async () => {
			puts += 1;
			if (puts === 2) {
				throw new Error('storage down');
			}
		};
		await expect(upload.run!(ctx, params())).rejects.toThrow('storage down');
		expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'POST /api/videos/upload-session',
			'POST /api/videos/upload-session/blob-1/parts/1',
			'POST /api/videos/upload-session/blob-1/parts/2',
			'DELETE /api/videos/upload-session/blob-1',
		]);
	});

	it('releases the session when a part cannot be signed', async () => {
		const ctx = noBuffering(fakeContext([multipart, {}, undefined]));
		await expect(upload.run!(ctx, params())).rejects.toThrow(/no upload URL for part 1/i);
		expect(ctx.calls.at(-1)).toEqual({
			method: 'DELETE',
			path: '/api/videos/upload-session/blob-1',
		});
	});

	it('refuses a stream that ends before the declared size, releasing the session', async () => {
		const ctx = noBuffering(fakeContext([multipart, signed(1), signed(2), undefined]));
		ctx.openBinary = async () => streamOf(['binary:'], 11);
		await expect(upload.run!(ctx, params())).rejects.toThrow(/7 of 11 bytes/);
		expect(ctx.calls.at(-1)?.method).toBe('DELETE');
	});

	it('refuses a stream longer than the declared size, releasing the session', async () => {
		const ctx = noBuffering(fakeContext([multipart, signed(1), signed(2), undefined]));
		ctx.openBinary = async () => streamOf(['binary:data!!'], 8);
		await expect(upload.run!(ctx, params())).rejects.toThrow(/more than the 8 bytes/);
		expect(ctx.calls.at(-1)?.method).toBe('DELETE');
		// Parts beyond the declared size are never signed.
		expect(ctx.calls.filter((c) => c.path.includes('/parts/')).length).toBe(2);
	});
});

describe('recording upload, one PUT (storage without multipart)', () => {
	it('PUTs the stream with its size to the session URL, then completes', async () => {
		const ctx = noBuffering(fakeContext([single, completed]));
		await upload.run!(ctx, params());
		expect(ctx.events).toEqual([
			'POST /api/videos/upload-session',
			'PUT https://r2.example.com/put?sig=1',
			'POST /api/videos/complete',
		]);
		expect(ctx.puts).toEqual([
			{
				url: single.uploadUrl,
				data: Buffer.from('binary:data'),
				mimeType: 'text/plain',
				size: 11,
				streamed: true,
			},
		]);
	});

	it('releases the session when the PUT fails', async () => {
		const ctx = noBuffering(fakeContext([single, undefined]));
		ctx.putStream = async () => {
			throw new Error('storage down');
		};
		await expect(upload.run!(ctx, params())).rejects.toThrow('storage down');
		expect(ctx.calls.at(-1)).toEqual({
			method: 'DELETE',
			path: '/api/videos/upload-session/blob-1',
		});
	});

	it('refuses a session with neither an upload URL nor a part size, releasing it', async () => {
		const ctx = noBuffering(fakeContext([{ ...single, uploadUrl: null }, undefined]));
		await expect(upload.run!(ctx, params())).rejects.toThrow(/upload URL/i);
		expect(ctx.calls.at(-1)?.method).toBe('DELETE');
	});
});

describe('recording upload, completion', () => {
	it('retries a 503 (transient storage check) with the same blob, then succeeds', async () => {
		const ctx = noBuffering(fakeContext([single, httpError('503'), completed]));
		const out = await upload.run!(ctx, params());
		expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'POST /api/videos/upload-session',
			'POST /api/videos/complete',
			'POST /api/videos/complete',
		]);
		expect(out).toEqual([{ json: completed }]);
	});

	it('releases the session when completion fails, so it does not hold an upload slot', async () => {
		const ctx = noBuffering(
			fakeContext([single, httpError('400', 'The file is larger than declared'), undefined]),
		);
		await expect(upload.run!(ctx, params())).rejects.toThrow('The file is larger than declared');
		expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'POST /api/videos/upload-session',
			'POST /api/videos/complete',
			'DELETE /api/videos/upload-session/blob-1',
		]);
	});

	it('gives up after three 503s and releases the session', async () => {
		const ctx = noBuffering(
			fakeContext([single, httpError('503'), httpError('503'), httpError('503'), undefined]),
		);
		await expect(upload.run!(ctx, params())).rejects.toThrow('HTTP 503');
		expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'POST /api/videos/upload-session',
			'POST /api/videos/complete',
			'POST /api/videos/complete',
			'POST /api/videos/complete',
			'DELETE /api/videos/upload-session/blob-1',
		]);
	});

	it('surfaces the completion error even when the release fails too', async () => {
		const ctx = noBuffering(
			fakeContext([single, httpError('410', 'Upload session expired'), httpError('500')]),
		);
		await expect(upload.run!(ctx, params())).rejects.toThrow('Upload session expired');
	});
});

describe('recording upload, refused before a session starts', () => {
	it('refuses an empty file', async () => {
		const ctx = noBuffering(fakeContext([]));
		ctx.openBinary = async () => streamOf([], 0);
		await expect(upload.run!(ctx, params())).rejects.toThrow(/empty/);
		expect(ctx.calls).toEqual([]);
	});

	it("refuses a file over Hub's 5000 MiB limit and closes its stream", async () => {
		const ctx = noBuffering(fakeContext([]));
		const big = streamOf(['x'], MAX_UPLOAD_BYTES + 1);
		ctx.openBinary = async () => big;
		await expect(upload.run!(ctx, params())).rejects.toThrow(/5000 MiB/);
		expect(ctx.calls).toEqual([]);
		expect((big.content as ByteStream).destroyed).toBe(true);
	});

	it('accepts a file of exactly 5000 MiB (the session is opened)', async () => {
		const ctx = noBuffering(fakeContext([httpError('429', 'Too many uploads in progress')]));
		ctx.openBinary = async () => streamOf(['x'], MAX_UPLOAD_BYTES);
		await expect(upload.run!(ctx, params())).rejects.toThrow('Too many uploads in progress');
		expect(ctx.calls[0].body).toMatchObject({ fileSize: MAX_UPLOAD_BYTES });
	});

	it('is 5000 MiB, as in Hub', () => {
		expect(MAX_UPLOAD_BYTES).toBe(5000 * MiB);
	});
});
