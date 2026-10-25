import type { IDataObject, INode } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';
import { executeOperation } from '../../nodes/Dutify/registry';
import type { ResourceDef } from '../../shared/types';

const node: INode = {
	id: 'n1',
	name: 'Dutify',
	type: 'n8n-nodes-dutify.dutify',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** Resource whose operations just expose the binary helpers of the OperationContext. */
const probe: ResourceDef = {
	value: 'probe',
	name: 'Probe',
	workspaceScoped: false,
	operations: [
		{
			operation: 'read',
			name: 'Read',
			action: 'Read',
			description: 'Read',
			fields: [],
			run: async (ctx) => {
				const { data, mimeType, fileName } = await ctx.readBinary('data');

				return [
					{
						json: {
							text: data.toString('utf8'),
							isBuffer: Buffer.isBuffer(data),
							mimeType,
							fileName,
						},
					},
				];
			},
		},
		{
			operation: 'put',
			name: 'Put',
			action: 'Put',
			description: 'Put',
			fields: [],
			run: async (ctx) => {
				await ctx.putBinary('https://r2.example/obj?sig=1', Buffer.from('hello'), 'text/plain');

				return [{ json: { done: true } }];
			},
		},
		{
			operation: 'download',
			name: 'Download',
			action: 'Download',
			description: 'Download',
			fields: [],
			run: async (ctx) => [
				{
					json: {},
					binary: {
						data: await ctx.downloadToBinary('https://r2.example/file?sig=2', 'report.pdf'),
					},
				},
			],
		},
	],
};

function stubThis(operation: string, helpers: Record<string, unknown>) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string) => (name === 'resource' ? 'probe' : operation),
		getNode: () => node,
		continueOnFail: () => false,
		helpers,
	};
}

describe('readBinary', () => {
	it('returns the buffer, mime type and file name of the named binary property', async () => {
		const assertBinaryData = vi.fn(() => ({
			mimeType: 'image/png',
			fileName: 'logo.png',
			data: '',
		}));
		const getBinaryDataBuffer = vi.fn(async () => Buffer.from('PNGDATA'));
		const self = stubThis('read', { assertBinaryData, getBinaryDataBuffer });
		const [out] = await executeOperation.call(self as never, [probe]);
		expect(assertBinaryData).toHaveBeenCalledWith(0, 'data');
		expect(getBinaryDataBuffer).toHaveBeenCalledWith(0, 'data');
		expect(out[0].json).toEqual({
			text: 'PNGDATA',
			isBuffer: true,
			mimeType: 'image/png',
			fileName: 'logo.png',
		});
	});

	it('falls back to the property name when the binary has no file name', async () => {
		const self = stubThis('read', {
			assertBinaryData: () => ({ mimeType: 'text/plain', data: '' }),
			getBinaryDataBuffer: async () => Buffer.from('x'),
		});
		const [out] = await executeOperation.call(self as never, [probe]);
		expect((out[0].json as IDataObject).fileName).toBe('data');
	});

	it('fails when the item has no such binary property', async () => {
		const self = stubThis('read', {
			assertBinaryData: () => {
				throw new Error('No binary data property "data" exists on item!');
			},
			getBinaryDataBuffer: vi.fn(),
		});
		await expect(executeOperation.call(self as never, [probe])).rejects.toThrow(/No binary data/);
	});
});

describe('putBinary', () => {
	it('PUTs the raw bytes with the Content-Type and no Dutify authentication', async () => {
		const httpRequest = vi.fn(async () => '');
		const httpRequestWithAuthentication = vi.fn();
		const self = stubThis('put', { httpRequest, httpRequestWithAuthentication });
		const [out] = await executeOperation.call(self as never, [probe]);
		expect(out[0].json).toEqual({ done: true });
		expect(httpRequestWithAuthentication).not.toHaveBeenCalled();
		expect(httpRequest).toHaveBeenCalledTimes(1);
		const options = (httpRequest.mock.calls[0] as unknown as [IDataObject])[0];
		expect(options).toMatchObject({
			method: 'PUT',
			url: 'https://r2.example/obj?sig=1',
			headers: { 'Content-Type': 'text/plain' },
		});
		expect(Buffer.isBuffer(options.body)).toBe(true);
		expect((options.body as Buffer).toString('utf8')).toBe('hello');
		expect(options.json).toBe(false);
		expect(options.headers).not.toHaveProperty('X-API-Key');
	});

	it('surfaces a storage error', async () => {
		const httpRequest = vi.fn(async () => {
			throw new Error('403 SignatureDoesNotMatch');
		});
		const self = stubThis('put', { httpRequest });
		await expect(executeOperation.call(self as never, [probe])).rejects.toThrow(
			/SignatureDoesNotMatch/,
		);
	});
});

describe('downloadToBinary', () => {
	const arrayBuffer = (text: string) => {
		const bytes = Buffer.from(text);

		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	};

	it('GETs the signed URL unauthenticated as an arraybuffer and converts it to a Buffer', async () => {
		const httpRequest = vi.fn(async () => ({
			body: arrayBuffer('%PDF-1.7'),
			headers: { 'content-type': 'application/pdf; charset=binary' },
		}));
		const prepareBinaryData = vi.fn(async (_b: Buffer, fileName?: string, mime?: string) => ({
			data: 'b64',
			fileName,
			mimeType: mime,
		}));
		const self = stubThis('download', { httpRequest, prepareBinaryData });
		const [out] = await executeOperation.call(self as never, [probe]);
		expect(httpRequest).toHaveBeenCalledWith({
			method: 'GET',
			url: 'https://r2.example/file?sig=2',
			encoding: 'arraybuffer',
			json: false,
			returnFullResponse: true,
		});
		const [buffer, fileName, mime] = prepareBinaryData.mock.calls[0] as unknown as [
			Buffer,
			string,
			string,
		];
		expect(Buffer.isBuffer(buffer)).toBe(true);
		expect(buffer.toString('utf8')).toBe('%PDF-1.7');
		expect(fileName).toBe('report.pdf');
		expect(mime).toBe('application/pdf');
		expect(out[0].binary?.data).toEqual({
			data: 'b64',
			fileName: 'report.pdf',
			mimeType: 'application/pdf',
		});
	});

	it('passes no mime type when the response has no content-type header', async () => {
		const prepareBinaryData = vi.fn(async () => ({ data: 'b64' }));
		const self = stubThis('download', {
			httpRequest: async () => ({ body: arrayBuffer('abc'), headers: {} }),
			prepareBinaryData,
		});
		await executeOperation.call(self as never, [probe]);
		expect((prepareBinaryData.mock.calls[0] as unknown as unknown[])[2]).toBeUndefined();
	});

	it('keeps a Buffer body as is', async () => {
		const prepareBinaryData = vi.fn(async () => ({ data: 'b64' }));
		const self = stubThis('download', {
			httpRequest: async () => ({
				body: Buffer.from('raw'),
				headers: { 'content-type': 'text/plain' },
			}),
			prepareBinaryData,
		});
		await executeOperation.call(self as never, [probe]);
		expect((prepareBinaryData.mock.calls[0] as unknown as [Buffer])[0].toString('utf8')).toBe(
			'raw',
		);
	});
});
