import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
	INodePropertyOptions,
	INodeType,
} from 'n8n-workflow';
import { dutifyRequest, encodePath } from '../../shared/transport';
import type { RequestSpec } from '../../shared/types';
import { fetchAccessibleWorkspaces, type Fetch } from '../../shared/workspaces';

/* ---------- workspaces ---------- */

/** Pure core of the workspace locator: `{name, value: identifier}` for every usable workspace. */
export async function getWorkspaceOptions(
	fetch: Fetch,
	filter?: string,
): Promise<INodeListSearchItems[]> {
	const { workspaces } = await fetchAccessibleWorkspaces(fetch);
	const needle = filter?.trim().toLowerCase();

	return workspaces
		.filter(
			(w) =>
				!needle ||
				w.name.toLowerCase().includes(needle) ||
				w.identifier.toLowerCase().includes(needle),
		)
		.map((w) => ({ name: w.name, value: w.identifier }));
}

/* ---------- workspace context (spaces, lists, statuses, members, task types) ---------- */

interface ContextCustomField {
	identifier: string;
	name: string;
	type?: string | null;
}
interface ContextList {
	identifier?: string;
	name: string;
	statuses?: string[] | null;
	customFields?: ContextCustomField[] | null;
}
interface ContextFolder {
	identifier?: string;
	name: string;
	lists?: ContextList[] | null;
}
interface ContextSpace {
	identifier?: string;
	name: string;
	lists?: ContextList[] | null;
	folders?: ContextFolder[] | null;
}
export interface WorkspaceContext {
	members?: Array<{ email: string; fullName?: string | null }> | null;
	taskTypes?: string[] | null;
	spaces?: ContextSpace[] | null;
}

export function contextSpec(workspace: string, qs: IDataObject = {}): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/mp/api/v1/workspaces/${workspace}/lite/context`,
		qs,
	};
}

const byName = (names: string[]): INodePropertyOptions[] =>
	names.map((name) => ({ name, value: name }));

export function spaceOptions(context: WorkspaceContext): INodePropertyOptions[] {
	return byName((context.spaces ?? []).map((s) => s.name));
}

/** Lists of one space (or of every space), top-level first, then folder lists labelled "List (Folder)". */
export function listOptions(context: WorkspaceContext, space?: string): INodePropertyOptions[] {
	const options: INodePropertyOptions[] = [];
	for (const s of context.spaces ?? []) {
		if (space && s.name !== space) {
			continue;
		}
		for (const l of s.lists ?? []) {
			options.push({ name: l.name, value: l.name });
		}
		for (const f of s.folders ?? []) {
			for (const l of f.lists ?? []) {
				options.push({ name: `${l.name} (${f.name})`, value: l.name });
			}
		}
	}

	return options;
}

export function statusOptions(
	context: WorkspaceContext,
	list: string,
	space?: string,
): INodePropertyOptions[] {
	for (const s of context.spaces ?? []) {
		if (space && s.name !== space) {
			continue;
		}
		const lists = [...(s.lists ?? []), ...(s.folders ?? []).flatMap((f) => f.lists ?? [])];
		const match = lists.find((l) => l.name === list);
		if (match) {
			return byName(match.statuses ?? []);
		}
	}

	return [];
}

/** Lite endpoints take an assignee e-mail, so that is the value. */
export function memberOptions(context: WorkspaceContext): INodePropertyOptions[] {
	return (context.members ?? []).map((m) => ({
		name: m.fullName ? `${m.fullName} (${m.email})` : m.email,
		value: m.email,
	}));
}

export function taskTypeOptions(context: WorkspaceContext): INodePropertyOptions[] {
	return byName(context.taskTypes ?? []);
}

/* ---------- identifier pickers (structure resources take identifiers, not names) ---------- */

export function spaceIdOptions(context: WorkspaceContext): INodePropertyOptions[] {
	return (context.spaces ?? [])
		.filter((s) => s.identifier)
		.map((s) => ({ name: s.name, value: s.identifier as string }));
}

export function folderIdOptions(context: WorkspaceContext): INodePropertyOptions[] {
	return (context.spaces ?? []).flatMap((s) =>
		(s.folders ?? [])
			.filter((f) => f.identifier)
			.map((f) => ({ name: `${s.name} / ${f.name}`, value: f.identifier as string })),
	);
}

/** Every list with its identifier, labelled "Space / List" or "Space / Folder / List". */
function listsWithPath(context: WorkspaceContext): Array<{ path: string; list: ContextList }> {
	return (context.spaces ?? []).flatMap((s) => [
		...(s.lists ?? []).map((list) => ({ path: `${s.name} / ${list.name}`, list })),
		...(s.folders ?? []).flatMap((f) =>
			(f.lists ?? []).map((list) => ({ path: `${s.name} / ${f.name} / ${list.name}`, list })),
		),
	]);
}

export function listIdOptions(context: WorkspaceContext): INodePropertyOptions[] {
	return listsWithPath(context)
		.filter(({ list }) => list.identifier)
		.map(({ path, list }) => ({ name: path, value: list.identifier as string }));
}

/**
 * The context lists custom fields per list, so a workspace or space field repeats in many lists.
 * One option per identifier, labelled with its type and the first list it appears in.
 */
export function customFieldIdOptions(context: WorkspaceContext): INodePropertyOptions[] {
	const seen = new Map<string, { label: string; extra: number }>();
	for (const { path, list } of listsWithPath(context)) {
		for (const field of list.customFields ?? []) {
			const known = seen.get(field.identifier);
			if (known) {
				known.extra += 1;
			} else {
				seen.set(field.identifier, {
					label: `${field.name}${field.type ? ` (${field.type})` : ''} - ${path}`,
					extra: 0,
				});
			}
		}
	}

	return [...seen].map(([value, { label, extra }]) => ({
		name: extra > 0 ? `${label} (+${extra} more)` : label,
		value,
	}));
}

/* ---------- wiki spaces and boards ---------- */

export function wikiSpacesSpec(workspace: string): RequestSpec {
	return { method: 'GET', path: encodePath`/api/wiki/v1/workspaces/${workspace}/wiki/spaces/lite` };
}

export function wikiSpaceOptions(
	spaces: Array<{ key: string; name: string }> | null | undefined,
): INodePropertyOptions[] {
	return (spaces ?? []).map((s) => ({ name: s.name, value: s.key }));
}

export function boardsSpec(workspace: string): RequestSpec {
	return {
		method: 'GET',
		path: '/api/roadmarq/v1/boards/lite',
		qs: { workspaceIdentifier: workspace },
	};
}

export function boardOptions(
	boards: Array<{ slug: string; name: string }> | null | undefined,
): INodePropertyOptions[] {
	return (boards ?? []).map((b) => ({ name: b.name, value: b.slug }));
}

/* ---------- n8n wiring ---------- */

function selectedWorkspace(ctx: ILoadOptionsFunctions): string {
	return String(ctx.getNodeParameter('workspace', '', { extractValue: true }) ?? '');
}

function optionalParam(ctx: ILoadOptionsFunctions, name: string): string {
	try {
		return String(ctx.getNodeParameter(name, '', { extractValue: true }) ?? '');
	} catch {
		return '';
	}
}

async function loadContext(ctx: ILoadOptionsFunctions, space?: string, extra: IDataObject = {}) {
	const workspace = selectedWorkspace(ctx);
	if (!workspace) {
		return undefined;
	}
	const qs: IDataObject = { ...(space ? { space } : {}), ...extra };

	return (await dutifyRequest.call(ctx, contextSpec(workspace, qs), workspace)) as WorkspaceContext;
}

export const listSearch: NonNullable<NonNullable<INodeType['methods']>['listSearch']> = {
	async searchWorkspaces(
		this: ILoadOptionsFunctions,
		filter?: string,
	): Promise<INodeListSearchResult> {
		const results = await getWorkspaceOptions(
			async (spec) => await dutifyRequest.call(this, spec, ''),
			filter,
		);

		return { results };
	},
};

export const loadOptions: NonNullable<NonNullable<INodeType['methods']>['loadOptions']> = {
	async getSpaces(this: ILoadOptionsFunctions) {
		const context = await loadContext(this);

		return context ? spaceOptions(context) : [];
	},
	async getLists(this: ILoadOptionsFunctions) {
		const space = optionalParam(this, 'space');
		const context = await loadContext(this, space || undefined);

		return context ? listOptions(context, space || undefined) : [];
	},
	async getSpaceIds(this: ILoadOptionsFunctions) {
		const context = await loadContext(this, undefined, { shallow: true });

		return context ? spaceIdOptions(context) : [];
	},
	async getFolderIds(this: ILoadOptionsFunctions) {
		const context = await loadContext(this, undefined, { shallow: true });

		return context ? folderIdOptions(context) : [];
	},
	async getListIds(this: ILoadOptionsFunctions) {
		const context = await loadContext(this, undefined, { shallow: true });

		return context ? listIdOptions(context) : [];
	},
	async getCustomFieldIds(this: ILoadOptionsFunctions) {
		const context = await loadContext(this, undefined, {
			includeTaskTypes: false,
			includeRelationshipTypes: false,
			includeTags: false,
		});

		return context ? customFieldIdOptions(context) : [];
	},
	async getStatuses(this: ILoadOptionsFunctions) {
		const space = optionalParam(this, 'space');
		const list = optionalParam(this, 'list');
		if (!list) {
			return [];
		}
		const context = await loadContext(this, space || undefined);

		return context ? statusOptions(context, list, space || undefined) : [];
	},
	async getMembers(this: ILoadOptionsFunctions) {
		const context = await loadContext(this);

		return context ? memberOptions(context) : [];
	},
	async getTaskTypes(this: ILoadOptionsFunctions) {
		const context = await loadContext(this);

		return context ? taskTypeOptions(context) : [];
	},
	async getWikiSpaces(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}
		const spaces = (await dutifyRequest.call(this, wikiSpacesSpec(workspace), workspace)) as Array<{
			key: string;
			name: string;
		}>;

		return wikiSpaceOptions(spaces);
	},
	async getBoards(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}
		const boards = (await dutifyRequest.call(this, boardsSpec(workspace), workspace)) as Array<{
			slug: string;
			name: string;
		}>;

		return boardOptions(boards);
	},
};
