import type { IBinaryData } from 'n8n-workflow';
import { requestAllPages } from '../../shared/pagination';
import type { ByteStream, OperationContext, ParamReader, RequestSpec } from '../../shared/types';

/**
 * A ParamReader over a plain object. Like n8n's getNodeParameter, reading a missing
 * parameter without a fallback throws, so a test cannot silently pass on a typo.
 */
export function reader(params: Record<string, unknown>, workspace = 'ws-1'): ParamReader {
	return {
		workspace,
		get<T = unknown>(name: string, ...fallback: [T?]): T {
			if (Object.prototype.hasOwnProperty.call(params, name)) {
				return params[name] as T;
			}
			if (fallback.length > 0) {
				return fallback[0] as T;
			}
			throw new Error(`reader: missing parameter "${name}"`);
		},
	};
}

interface FakePut {
	url: string;
	data: Buffer;
	mimeType: string;
	/** putStream only: the declared size, and that the body came as a stream. */
	size?: number;
	streamed?: boolean;
}

export type FakeContext = OperationContext & {
	calls: RequestSpec[];
	puts: FakePut[];
	/** Requests and PUTs in the order they happened, e.g. `POST /path`, `PUT https://...`. */
	events: string[];
};

/**
 * An OperationContext that answers requests from `responses` in order and records every
 * RequestSpec it was asked to send. A response that is an Error is thrown instead.
 * `requestAll` paginates exactly like the real node (same `requestAllPages` helper).
 */
export function fakeContext(responses: unknown[]): FakeContext {
	const queue = [...responses];
	const calls: RequestSpec[] = [];
	const puts: FakePut[] = [];
	const events: string[] = [];
	const ctx: FakeContext = {
		calls,
		puts,
		events,
		async request(spec) {
			calls.push(spec);
			events.push(`${spec.method} ${spec.path}`);
			if (queue.length === 0) {
				throw new Error(`fakeContext: no response left for ${spec.method} ${spec.path}`);
			}
			const next = queue.shift();
			if (next instanceof Error) {
				throw next;
			}

			return next;
		},
		async requestAll(spec, limit) {
			return await requestAllPages((s) => ctx.request(s), spec, limit);
		},
		async readBinary(property) {
			return {
				data: Buffer.from(`binary:${property}`),
				mimeType: 'text/plain',
				fileName: `${property}.txt`,
			};
		},
		async downloadToBinary(url, fileName) {
			const binary: IBinaryData = {
				data: Buffer.from(url).toString('base64'),
				mimeType: 'application/octet-stream',
				fileName: fileName ?? 'download',
			};

			return binary;
		},
		async putBinary(url, data, mimeType) {
			events.push(`PUT ${url}`);
			puts.push({ url, data, mimeType });
		},
		async openBinary(property) {
			const data = Buffer.from(`binary:${property}`);

			return {
				content: byteStream([data]),
				size: data.length,
				mimeType: 'text/plain',
				fileName: `${property}.txt`,
			};
		},
		async putStream(url, content, size, mimeType) {
			events.push(`PUT ${url}`);
			const streamed = !Buffer.isBuffer(content);
			const data = streamed ? await drain(content) : content;
			puts.push({ url, data, mimeType, size, streamed });
		},
	};

	return ctx;
}

/** A stand-in for the Readable n8n's getBinaryStream returns: async-iterable and destroyable. */
export function byteStream(chunks: Buffer[]): ByteStream {
	const fake = {
		destroyed: false,
		destroy() {
			fake.destroyed = true;

			return fake;
		},
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};

	return fake as unknown as ByteStream;
}

export async function drain(stream: ByteStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.from(chunk as Buffer));
	}

	return Buffer.concat(chunks);
}
