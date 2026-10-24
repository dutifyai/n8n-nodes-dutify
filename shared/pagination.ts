import type { IDataObject } from 'n8n-workflow';
import type { PaginationStyle, RequestSpec } from './types';

/** Reads `a.b.c` from an object; undefined when any step is missing. No lodash. */
function getPath(source: unknown, path: string | undefined): unknown {
	if (!path) {
		return source;
	}
	let current: unknown = source;
	for (const key of path.split('.')) {
		if (current === null || typeof current !== 'object') {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}

	return current;
}

function itemsOf(response: unknown, path: string | undefined): IDataObject[] {
	const items = getPath(response, path);

	return Array.isArray(items) ? (items as IDataObject[]) : [];
}

/**
 * Fetches pages until the end of the list, `limit` items, an empty page, a repeated
 * cursor, or (page style) a short page or a page identical to the previous one.
 * The last two guards stop a server that ignores the paging param from looping forever.
 */
export async function collectAll(
	fetchPage: (qs: IDataObject) => Promise<unknown>,
	style: PaginationStyle,
	limit?: number,
): Promise<IDataObject[]> {
	const all: IDataObject[] = [];
	const remaining = () => (limit === undefined ? Infinity : limit - all.length);
	const pageSize = () => Math.max(1, Math.min(style.maxPageSize, remaining()));

	if (style.kind === 'cursor') {
		const seen = new Set<string>();
		let cursor: string | undefined;
		while (remaining() > 0) {
			const qs: IDataObject = { [style.limitParam]: pageSize() };
			if (cursor !== undefined) {
				qs[style.cursorParam] = cursor;
			}
			const response = await fetchPage(qs);
			const items = itemsOf(response, style.itemsPath);
			all.push(...items.slice(0, remaining()));
			const next = getPath(response, style.nextCursorPath);
			if (items.length === 0 || next === undefined || next === null || next === '') {
				break;
			}
			const nextCursor = String(next);
			if (seen.has(nextCursor) || nextCursor === cursor) {
				break;
			}
			seen.add(nextCursor);
			cursor = nextCursor;
		}

		return all;
	}

	let pageNumber = style.zeroBased ? 0 : 1;
	let previous: string | undefined;
	while (remaining() > 0) {
		const size = style.maxPageSize;
		const response = await fetchPage({ [style.pageParam]: pageNumber, [style.sizeParam]: size });
		const items = itemsOf(response, style.itemsPath);
		const fingerprint = JSON.stringify(items);
		if (items.length === 0 || fingerprint === previous) {
			break;
		}
		all.push(...items.slice(0, remaining()));
		if (items.length < size) {
			break;
		}
		previous = fingerprint;
		pageNumber++;
	}

	return all;
}

/**
 * Sends `spec` and returns every item: paginated via `collectAll` when the spec has a
 * `paginate` style (paging params merged over `spec.qs`), otherwise a single request
 * whose array response (or single object) is returned, truncated to `limit`.
 */
export async function requestAllPages(
	request: (spec: RequestSpec) => Promise<unknown>,
	spec: RequestSpec,
	limit?: number,
): Promise<IDataObject[]> {
	if (!spec.paginate) {
		const response = await request(spec);
		let items: IDataObject[] = [];
		if (Array.isArray(response)) {
			items = response as IDataObject[];
		} else if (response !== undefined && response !== null && response !== '') {
			items = [response as IDataObject];
		}

		return limit === undefined ? items : items.slice(0, limit);
	}

	return await collectAll(
		async (pageQs) => await request({ ...spec, qs: { ...spec.qs, ...pageQs } }),
		spec.paginate,
		limit,
	);
}
