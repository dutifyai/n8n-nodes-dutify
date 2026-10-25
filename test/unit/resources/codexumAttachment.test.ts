import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { codexumAttachment } from '../../../nodes/Dutify/resources/codexumAttachment';
import type { OperationDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

const PAGE_ID = '3f2b8c1e-0a4d-4e57-9b1a-5c6d7e8f9a01';
const ATT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const BASE = `/api/wiki/v1/pages/${PAGE_ID}/attachments`;

const op = (name: string): OperationDef => {
	const found = codexumAttachment.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${name}`);
	}

	return found;
};

describe('registration', () => {
	it('registers codexumAttachment as a workspace-scoped resource with list, upload, delete', () => {
		expect(resources).toContain(codexumAttachment);
		expect(codexumAttachment.value).toBe('codexumAttachment');
		expect(codexumAttachment.workspaceScoped).toBe(true);
		expect(codexumAttachment.operations.map((o) => o.operation)).toEqual([
			'list',
			'upload',
			'delete',
		]);
	});

	it('every operation picks the page from a space and page picker', () => {
		for (const o of codexumAttachment.operations) {
			const names = o.fields.map((f) => f.name);
			expect(names).toContain('space');
			expect(names).toContain('pageId');
			const page = o.fields.find((f) => f.name === 'pageId');
			expect(page?.typeOptions?.loadOptionsMethod).toBe('getWikiPageIds');
			expect(page?.typeOptions?.loadOptionsDependsOn).toEqual(['space']);
		}
	});
});

describe('list', () => {
	it('GETs the page attachments; the array response is not paginated', () => {
		const spec = op('list').build!(reader({ space: 'DOCS', pageId: PAGE_ID }));
		expect(spec).toEqual({ method: 'GET', path: BASE });
		expect(spec.paginate).toBeUndefined();
	});
});

describe('delete', () => {
	it('DELETEs one attachment of the page, picked from the attachments of the page', () => {
		expect(
			op('delete').build!(reader({ space: 'DOCS', pageId: PAGE_ID, attachmentId: ATT_ID })),
		).toEqual({
			method: 'DELETE',
			path: `${BASE}/${ATT_ID}`,
		});
		const field = op('delete').fields.find((f) => f.name === 'attachmentId');
		expect(field?.required).toBe(true);
		expect(field?.typeOptions?.loadOptionsMethod).toBe('getWikiAttachments');
		expect(field?.typeOptions?.loadOptionsDependsOn).toEqual(['pageId']);
	});
});

describe('upload', () => {
	const params = { space: 'DOCS', pageId: PAGE_ID, binaryPropertyName: 'data' };
	const confirmed = { id: ATT_ID, pageId: PAGE_ID, filename: 'data.txt', status: 'confirmed' };
	const slot = {
		attachmentId: ATT_ID,
		uploadUrl: 'https://r2.example/key?X-Amz-Signature=abc',
		storageKey: 'wiki/2026/key',
	};

	it('has a binary property field defaulting to "data" and no build', () => {
		const field = op('upload').fields.find((f) => f.name === 'binaryPropertyName');
		expect(field?.default).toBe('data');
		expect(field?.required).toBe(true);
		expect(op('upload').build).toBeUndefined();
		expect(op('upload').run).toBeTypeOf('function');
	});

	it('requests the slot, PUTs the bytes to the returned URL, then confirms, in that order', async () => {
		const ctx = fakeContext([slot, confirmed]);
		const out = await op('upload').run!(ctx, reader(params));

		expect(ctx.calls).toEqual([
			{
				method: 'POST',
				path: `${BASE}/upload-url`,
				// fakeContext.readBinary: 'binary:data' (11 bytes), text/plain, data.txt
				body: { filename: 'data.txt', contentType: 'text/plain', sizeBytes: 11 },
			},
			{ method: 'POST', path: `${BASE}/${ATT_ID}/confirm` },
		]);
		expect(ctx.puts).toEqual([
			{ url: slot.uploadUrl, data: Buffer.from('binary:data'), mimeType: 'text/plain' },
		]);
		expect(ctx.events).toEqual([
			`POST ${BASE}/upload-url`,
			`PUT ${slot.uploadUrl}`,
			`POST ${BASE}/${ATT_ID}/confirm`,
		]);
		expect(out).toEqual([{ json: confirmed }]);
	});

	it('declares the same Content-Type it PUTs, and the byte length of the data', async () => {
		const ctx = fakeContext([slot, confirmed]);
		ctx.readBinary = async () => ({
			data: Buffer.from([1, 2, 3, 4, 5]),
			mimeType: 'image/png',
			fileName: 'logo.png',
		});
		await op('upload').run!(ctx, reader(params));
		expect(ctx.calls[0].body).toEqual({
			filename: 'logo.png',
			contentType: 'image/png',
			sizeBytes: 5,
		});
		expect(ctx.puts[0].mimeType).toBe('image/png');
		expect(ctx.puts[0].data.length).toBe(5);
	});

	it('falls back to application/octet-stream when the binary has no mime type', async () => {
		const ctx = fakeContext([slot, confirmed]);
		ctx.readBinary = async () => ({ data: Buffer.from('x'), mimeType: '', fileName: 'blob' });
		await op('upload').run!(ctx, reader(params));
		expect(ctx.calls[0].body).toMatchObject({ contentType: 'application/octet-stream' });
		expect(ctx.puts[0].mimeType).toBe('application/octet-stream');
	});

	it('reads the binary property the user named', async () => {
		const ctx = fakeContext([slot, confirmed]);
		const seen: string[] = [];
		ctx.readBinary = async (property) => {
			seen.push(property);

			return { data: Buffer.from('x'), mimeType: 'text/plain', fileName: 'a.txt' };
		};
		await op('upload').run!(ctx, reader({ ...params, binaryPropertyName: 'invoice' }));
		expect(seen).toEqual(['invoice']);
	});

	it('refuses an empty file before any request (the API requires sizeBytes > 0)', async () => {
		const ctx = fakeContext([]);
		ctx.readBinary = async () => ({
			data: Buffer.alloc(0),
			mimeType: 'text/plain',
			fileName: 'e.txt',
		});
		await expect(op('upload').run!(ctx, reader(params))).rejects.toThrow(/empty/i);
		expect(ctx.events).toEqual([]);
	});

	it('does not confirm when the PUT fails, and removes the pending attachment', async () => {
		const ctx = fakeContext([slot, undefined]);
		ctx.putBinary = async () => {
			throw new Error('403 SignatureDoesNotMatch');
		};
		await expect(op('upload').run!(ctx, reader(params))).rejects.toThrow(/SignatureDoesNotMatch/);
		expect(ctx.events).toEqual([`POST ${BASE}/upload-url`, `DELETE ${BASE}/${ATT_ID}`]);
	});

	it('still reports the PUT error when the cleanup delete fails too', async () => {
		const ctx = fakeContext([slot, new Error('delete failed')]);
		ctx.putBinary = async () => {
			throw new Error('403 SignatureDoesNotMatch');
		};
		await expect(op('upload').run!(ctx, reader(params))).rejects.toThrow(/SignatureDoesNotMatch/);
	});

	it('does not touch the attachment when the slot request is rejected', async () => {
		const ctx = fakeContext([new Error('File type not allowed: exe')]);
		await expect(op('upload').run!(ctx, reader(params))).rejects.toThrow(/File type not allowed/);
		expect(ctx.events).toEqual([`POST ${BASE}/upload-url`]);
	});
});
