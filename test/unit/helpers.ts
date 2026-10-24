import type { IBinaryData } from 'n8n-workflow';
import { requestAllPages } from '../../shared/pagination';
import type { OperationContext, ParamReader, RequestSpec } from '../../shared/types';

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

/**
 * An OperationContext that answers requests from `responses` in order and records every
 * RequestSpec it was asked to send. A response that is an Error is thrown instead.
 * `requestAll` paginates exactly like the real node (same `requestAllPages` helper).
 */
export function fakeContext(responses: unknown[]): OperationContext & { calls: RequestSpec[] } {
	const queue = [...responses];
	const calls: RequestSpec[] = [];
	const ctx: OperationContext & { calls: RequestSpec[] } = {
		calls,
		async request(spec) {
			calls.push(spec);
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
	};

	return ctx;
}
