import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
	INodePropertyOptions,
	INodeType,
} from 'n8n-workflow';
import { PM_EVENT_OPTIONS } from '../../shared/pmEvents';
import { resolveTaskId } from '../../shared/taskRefs';
import { dutifyRequest, encodePath } from '../../shared/transport';
import type { HubWebhookRow, RequestSpec } from '../../shared/types';
import {
	fetchAccessibleWorkspaces,
	resolveHubWorkspace,
	type Fetch,
} from '../../shared/workspaces';

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
	/** Sub-folders, same shape, at any depth. */
	folders?: ContextFolder[] | null;
}

interface FolderNode<L> {
	identifier?: string;
	name: string;
	lists?: L[] | null;
	folders?: Array<FolderNode<L>> | null;
}

/** Every folder of a tree, depth first, with the names of the folders from the top down to it. */
export function walkFolders<L, F extends FolderNode<L>>(
	folders: F[] | null | undefined,
	parents: string[] = [],
): Array<{ folder: F; path: string[] }> {
	return (folders ?? []).flatMap((folder) => {
		const path = [...parents, folder.name];

		return [{ folder, path }, ...walkFolders<L, F>(folder.folders as F[] | null | undefined, path)];
	});
}

/** The lists of a space: top-level first, then each folder's lists, at any depth. */
export function spaceLists<L>(space: {
	lists?: L[] | null;
	folders?: Array<FolderNode<L>> | null;
}): L[] {
	return [
		...(space.lists ?? []),
		...walkFolders<L, FolderNode<L>>(space.folders).flatMap(({ folder }) => folder.lists ?? []),
	];
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

/**
 * Lists of one space (or of every space), top-level first, then folder lists labelled
 * "List (Folder)", or "List (Folder / Sub)" in a sub-folder.
 */
export function listOptions(context: WorkspaceContext, space?: string): INodePropertyOptions[] {
	const options: INodePropertyOptions[] = [];
	for (const s of context.spaces ?? []) {
		if (space && s.name !== space) {
			continue;
		}
		for (const l of s.lists ?? []) {
			options.push({ name: l.name, value: l.name });
		}
		for (const { folder, path } of walkFolders<ContextList, ContextFolder>(s.folders)) {
			for (const l of folder.lists ?? []) {
				options.push({ name: `${l.name} (${path.join(' / ')})`, value: l.name });
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
		const match = spaceLists(s).find((l) => l.name === list);
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

/** Every folder at any depth, labelled "Space / Folder / Sub". */
export function folderIdOptions(context: WorkspaceContext): INodePropertyOptions[] {
	return (context.spaces ?? []).flatMap((s) =>
		walkFolders<ContextList, ContextFolder>(s.folders)
			.filter(({ folder }) => folder.identifier)
			.map(({ folder, path }) => ({
				name: [s.name, ...path].join(' / '),
				value: folder.identifier as string,
			})),
	);
}

/** Every list with its identifier, labelled "Space / List" or "Space / Folder / Sub / List". */
function listsWithPath(context: WorkspaceContext): Array<{ path: string; list: ContextList }> {
	return (context.spaces ?? []).flatMap((s) => [
		...(s.lists ?? []).map((list) => ({ path: `${s.name} / ${list.name}`, list })),
		...walkFolders<ContextList, ContextFolder>(s.folders).flatMap(({ folder, path }) =>
			(folder.lists ?? []).map((list) => ({
				path: [s.name, ...path, list.name].join(' / '),
				list,
			})),
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

/** Every page of a wiki space (the lite endpoint only lists one level at a time). */
export function wikiPagesSpec(workspace: string, space: string): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/api/wiki/v1/workspaces/${workspace}/wiki/spaces/${space}/pages`,
	};
}

interface WikiPageRow {
	id?: string;
	slug?: string;
	title?: string;
	type?: string;
	parentId?: string | null;
}

/** Value is the slug (lite endpoints address pages by slug); the label shows the ancestry. */
export function wikiPageOptions(
	rows: WikiPageRow[] | null | undefined,
	valueKey: 'slug' | 'id' = 'slug',
): INodePropertyOptions[] {
	const byId = new Map((rows ?? []).filter((r) => r.id).map((r) => [r.id as string, r]));
	const titleOf = (row: WikiPageRow) => row.title ?? (row.slug as string);
	const path = (row: WikiPageRow): string => {
		const parent = row.parentId ? byId.get(row.parentId) : undefined;

		return parent && parent !== row ? `${path(parent)} / ${titleOf(row)}` : titleOf(row);
	};

	return (rows ?? [])
		.filter((r) => r[valueKey])
		.map((r) => ({
			name: r.type === 'folder' ? `${path(r)} (folder)` : path(r),
			value: r[valueKey] as string,
		}));
}

/** For optional parent and sibling fields: the same pages, plus a blank "top level" choice. */
export function wikiParentPageOptions(
	rows: WikiPageRow[] | null | undefined,
): INodePropertyOptions[] {
	return [{ name: '- Top Level -', value: '' }, ...wikiPageOptions(rows)];
}

/** Attachment endpoints address the page by UUID, so this picker is valued by page id, not slug. */
export function wikiPageIdOptions(rows: WikiPageRow[] | null | undefined): INodePropertyOptions[] {
	return wikiPageOptions(rows, 'id');
}

export function wikiAttachmentsSpec(pageId: string): RequestSpec {
	return { method: 'GET', path: encodePath`/api/wiki/v1/pages/${pageId}/attachments` };
}

interface WikiAttachmentRow {
	id?: string;
	filename?: string;
	status?: string;
}

export function wikiAttachmentOptions(
	rows: WikiAttachmentRow[] | null | undefined,
): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((r) => r.id)
		.map((r) => ({
			name:
				r.status && r.status !== 'confirmed'
					? `${r.filename ?? r.id} (${r.status})`
					: (r.filename ?? (r.id as string)),
			value: r.id as string,
		}));
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

/** The request list pages from zero and the backend caps a page at 200. */
const SHORT_ID_PAGE_SIZE = 200;

export function requestsSpec(workspace: string, board: string): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/api/roadmarq/v1/boards/${board}/requests/lite`,
		qs: { workspaceIdentifier: workspace, page: 0, size: SHORT_ID_PAGE_SIZE },
	};
}

export function bugsSpec(workspace: string, board: string): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/api/roadmarq/v1/boards/${board}/bugs/lite`,
		qs: { workspaceIdentifier: workspace },
	};
}

type ShortIdRow = { shortId?: string; title?: string };

function shortIdOptions(rows: ShortIdRow[] | null | undefined): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((r) => r.shortId)
		.map((r) => ({
			name: r.title ? `${r.shortId} - ${r.title}` : (r.shortId as string),
			value: r.shortId as string,
		}));
}

/** Requests come back wrapped in a page: `{content: [...]}`. */
export function requestShortIdOptions(
	page: { content?: ShortIdRow[] | null } | null | undefined,
): INodePropertyOptions[] {
	return shortIdOptions(page?.content);
}

/** Bugs come back as a plain array. */
export function bugShortIdOptions(rows: ShortIdRow[] | null | undefined): INodePropertyOptions[] {
	return shortIdOptions(rows);
}

/* ---------- roadmarq board-scoped names (statuses, categories, ...) ---------- */

/** The non-lite board list carries the board UUID that the settings endpoints are addressed by. */
export function boardIdsSpec(workspace: string): RequestSpec {
	return {
		method: 'GET',
		path: '/api/roadmarq/v1/boards',
		qs: { workspaceIdentifier: workspace },
	};
}

const BOARD_NAME_SEGMENTS = {
	statuses: 'statuses',
	categories: 'categories',
	milestones: 'milestones',
	severityLevels: 'severity-levels',
	productAreas: 'product-areas',
	bugStatuses: 'bug-status-levels',
} as const;

export type BoardNameKind = keyof typeof BOARD_NAME_SEGMENTS;

export function boardNamesSpec(boardId: string, kind: BoardNameKind): RequestSpec {
	return {
		method: 'GET',
		path: `${encodePath`/api/roadmarq/v1/boards/${boardId}`}/${BOARD_NAME_SEGMENTS[kind]}`,
	};
}

/** The lite endpoints match status, category, milestone, severity and product area by name. */
export function nameOptions(
	rows: Array<{ name?: string }> | null | undefined,
): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((r) => r.name)
		.map((r) => ({ name: r.name as string, value: r.name as string }));
}

function isForbidden(error: unknown): boolean {
	const e = error as { httpCode?: unknown; statusCode?: unknown } | null;

	return String(e?.httpCode ?? e?.statusCode) === '403';
}

async function lookupNames(
	fetch: (spec: RequestSpec) => Promise<unknown>,
	workspace: string,
	boardSlug: string,
	kind: BoardNameKind,
): Promise<INodePropertyOptions[]> {
	const boards = (await fetch(boardIdsSpec(workspace))) as Array<{ id?: string; slug?: string }>;
	const id = (boards ?? []).find((b) => b.slug === boardSlug)?.id;
	if (!id) {
		return [];
	}

	return nameOptions((await fetch(boardNamesSpec(id, kind))) as Parameters<typeof nameOptions>[0]);
}

/**
 * Names of one kind for a board picked by slug: slug -> UUID through the board list, then the
 * list itself. No board, an unknown slug, or a key without the scope (403) gives no options;
 * the field still accepts a typed name.
 */
export async function loadBoardNames(
	fetch: (spec: RequestSpec) => Promise<unknown>,
	workspace: string,
	boardSlug: string,
	kind: BoardNameKind,
): Promise<INodePropertyOptions[]> {
	if (!workspace || !boardSlug) {
		return [];
	}
	return await lookupNames(fetch, workspace, boardSlug, kind).catch((error: unknown) =>
		// Already a NodeApiError from the transport; a forbidden scope just means no suggestions.
		isForbidden(error) ? [] : Promise.reject(error),
	);
}

/* ---------- views and dashboard widgets ---------- */

/** One page of a scope's views, at the backend's maximum page size. */
export function viewsSpec(scope: string, scopeIdentifier: string): RequestSpec {
	return {
		method: 'GET',
		path: '/mp/api/v1/views/lite',
		qs: { scope, scopeIdentifier, limit: 200 },
	};
}

interface ViewPage {
	items?: Array<{ identifier?: string; name?: string; type?: string }> | null;
}

export function viewOptions(page: ViewPage | null | undefined): INodePropertyOptions[] {
	return (page?.items ?? [])
		.filter((v) => v.identifier)
		.map((v) => {
			const label = v.name ?? (v.identifier as string);

			return { name: v.type ? `${label} (${v.type})` : label, value: v.identifier as string };
		});
}

export function widgetsSpec(viewId: string): RequestSpec {
	return { method: 'GET', path: encodePath`/mp/api/v1/views/lite/${viewId}/widgets` };
}

interface WidgetRow {
	id?: string;
	type?: string;
	title?: string;
}

export function widgetOptions(widgets: WidgetRow[] | null | undefined): INodePropertyOptions[] {
	return (widgets ?? [])
		.filter((w) => w.id)
		.map((w) => ({
			name: w.title ? `${w.title} (${w.type ?? 'widget'})` : `${w.type ?? 'widget'} (${w.id})`,
			value: w.id as string,
		}));
}

/* ---------- sprint groups and sprints ---------- */

export function sprintGroupsSpec(spaceId: string): RequestSpec {
	return { method: 'GET', path: encodePath`/mp/api/v1/spaces/${spaceId}/sprint-groups` };
}

interface SprintGroupRow {
	identifier?: string;
	name?: string;
	sprints?: Array<{ identifier?: string; name?: string; status?: string }> | null;
}

export function sprintGroupOptions(
	groups: SprintGroupRow[] | null | undefined,
): INodePropertyOptions[] {
	return (groups ?? [])
		.filter((g) => g.identifier)
		.map((g) => ({ name: g.name ?? (g.identifier as string), value: g.identifier as string }));
}

/** Every sprint of every group in the space, labelled "Group / Sprint (STATUS)". */
export function sprintOptions(groups: SprintGroupRow[] | null | undefined): INodePropertyOptions[] {
	return (groups ?? []).flatMap((g) =>
		(g.sprints ?? [])
			.filter((s) => s.identifier)
			.map((s) => {
				const label = `${g.name ?? g.identifier} / ${s.name ?? s.identifier}`;

				return { name: s.status ? `${label} (${s.status})` : label, value: s.identifier as string };
			}),
	);
}

/* ---------- teams, members, invitations, access levels, import jobs ---------- */

/** The backend caps every page at 100. */
const PICKER_PAGE_SIZE = 100;
/** A picker stops after this many pages of members, so a huge workspace cannot stall the editor. */
const MAX_MEMBER_PAGES = 20;

export function teamsSpec(workspace: string): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/mp/api/v1/workspaces/${workspace}/teams`,
		qs: { size: PICKER_PAGE_SIZE },
	};
}

export function teamOptions(
	teams: Array<{ identifier?: string; name?: string; alias?: string }> | null | undefined,
): INodePropertyOptions[] {
	return (teams ?? [])
		.filter((t) => t.identifier)
		.map((t) => {
			const label = t.name ?? (t.identifier as string);

			return { name: t.alias ? `${label} (${t.alias})` : label, value: t.identifier as string };
		});
}

export function workspaceUsersSpec(workspace: string, page: number): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/mp/api/v1/workspaces/${workspace}/users`,
		qs: { page, size: PICKER_PAGE_SIZE },
	};
}

interface WorkspaceUserRow {
	userUuid?: string;
	user?: { fullName?: string | null; email?: string | null } | null;
}

/** Team and member endpoints take a user UUID, which the workspace context does not carry. */
export function workspaceUserOptions(
	users: WorkspaceUserRow[] | null | undefined,
): INodePropertyOptions[] {
	return (users ?? [])
		.filter((u) => u.userUuid)
		.map((u) => {
			const email = u.user?.email ?? '';
			const fullName = u.user?.fullName ?? '';
			const label = fullName ? `${fullName} (${email})` : email || (u.userUuid as string);

			return { name: label, value: u.userUuid as string };
		});
}

export function invitationsSpec(workspace: string): RequestSpec {
	return { method: 'GET', path: encodePath`/mp/api/v1/workspaces/${workspace}/invitations` };
}

export function invitationOptions(
	invitations:
		| Array<{ identifier?: string; invitedEmail?: string; status?: string }>
		| null
		| undefined,
): INodePropertyOptions[] {
	return (invitations ?? [])
		.filter((i) => i.identifier)
		.map((i) => {
			const label = i.invitedEmail ?? (i.identifier as string);

			return { name: i.status ? `${label} (${i.status})` : label, value: i.identifier as string };
		});
}

export function accessLevelsSpec(workspace: string): RequestSpec {
	return { method: 'GET', path: encodePath`/mp/api/v1/workspaces/${workspace}/access-levels` };
}

/** Roles are the workspace's own access levels, so the numeric id is the value. */
export function accessLevelOptions(
	levels: Array<{ id?: number; name?: string; description?: string }> | null | undefined,
): INodePropertyOptions[] {
	return (levels ?? [])
		.filter((l) => l.id !== undefined && l.id !== null)
		.map((l) => ({
			name: l.name ?? String(l.id),
			value: l.id as number,
			...(l.description ? { description: l.description } : {}),
		}));
}

export function importJobsSpec(workspace: string): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/mp/api/v1/workspaces/${workspace}/import`,
		qs: { pageSize: PICKER_PAGE_SIZE },
	};
}

export function importJobOptions(
	jobs:
		| Array<{ identifier?: string; fileName?: string; source?: string; status?: string }>
		| null
		| undefined,
): INodePropertyOptions[] {
	return (jobs ?? [])
		.filter((j) => j.identifier)
		.map((j) => {
			const label = j.fileName ?? `${j.source ?? 'Platform'} import ${j.identifier}`;

			return { name: j.status ? `${label} (${j.status})` : label, value: j.identifier as string };
		});
}

/* ---------- automations, saved filters, notifications, time entries ---------- */

export function automationsSpec(scope: string, target: string): RequestSpec {
	return {
		method: 'GET',
		path: `/mp/api/v1/automations/${encodeURIComponent(scope)}/${encodeURIComponent(target)}`,
		qs: { size: PICKER_PAGE_SIZE },
	};
}

export function automationOptions(
	rows: Array<{ identifier?: string; name?: string; active?: boolean }> | null | undefined,
): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((a) => a.identifier)
		.map((a) => {
			const label = a.name ?? (a.identifier as string);

			return {
				name: a.active === false ? `${label} (disabled)` : label,
				value: a.identifier as string,
			};
		});
}

export function savedFiltersSpec(list: string): RequestSpec {
	return { method: 'GET', path: encodePath`/mp/api/v1/lists/${list}/filters` };
}

export function savedFilterOptions(
	rows: Array<{ id?: number; name?: string }> | null | undefined,
): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((f) => f.id !== undefined && f.id !== null)
		.map((f) => ({ name: f.name ?? `Filter ${f.id}`, value: String(f.id) }));
}

export function notificationsSpec(workspace: string): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/mp/api/v1/notifications/workspace/${workspace}`,
		qs: { unreadOnly: true, size: PICKER_PAGE_SIZE },
	};
}

export function notificationOptions(
	rows: Array<{ identifier?: string; type?: string; createdAt?: string }> | null | undefined,
): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((n) => n.identifier)
		.map((n) => {
			const label = n.type ?? (n.identifier as string);

			return {
				name: n.type && n.createdAt ? `${label} (${n.createdAt})` : label,
				value: n.identifier as string,
			};
		});
}

export function timeEntriesSpec(taskId: string): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/mp/api/v1/tasks/${taskId}/time-entries`,
		qs: { size: PICKER_PAGE_SIZE },
	};
}

export function timeEntryOptions(
	rows:
		| Array<{ id?: number; timeSpent?: number; startedAt?: string; notes?: string }>
		| null
		| undefined,
): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((e) => e.id !== undefined && e.id !== null)
		.map((e) => {
			const day = e.startedAt ? ` on ${e.startedAt.slice(0, 10)}` : '';
			const notes = e.notes ? ` - ${e.notes}` : '';

			return { name: `${e.timeSpent ?? 0} min${day}${notes}`, value: String(e.id) };
		});
}

/** Which field of the view scope fields holds the target identifier, per scope. */
const SCOPE_TARGET_PARAM: Record<string, string> = {
	space: 'scopeSpaceId',
	folder: 'scopeFolderId',
	list: 'scopeListId',
};

/* ---------- PM webhooks ---------- */

/** The catalog has no endpoint listing the event types, so the picker serves the shared static list. */
export function pmEventTypeOptions(): INodePropertyOptions[] {
	return PM_EVENT_OPTIONS;
}

/** Every event type a PM webhook can subscribe to, across PM, the wiki and feature requests. */
export function webhookEventTypesSpec(workspace: string): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/mp/api/v1/workspaces/${workspace}/webhooks/event-types`,
	};
}

interface WebhookEventTypeRow {
	type?: string;
	product?: string;
	description?: string;
	/** The `scopeType` values a subscription with this type may use (PM's ProductEventScopes). */
	scopes?: string[];
}

/** The trigger's scope value for "no scope": every event of the product fits it. */
const WHOLE_WORKSPACE = 'WORKSPACE';

/**
 * The event types of one product (`pm`, `codexum` or `roadmarq`), sorted by their API name. With
 * a `scope` (a scope type such as `WIKI_PAGE`), only the types PM lets that scope narrow: PM
 * refuses the others at activation. A row that lists no scopes is kept; PM judges it.
 */
export function webhookEventTypeOptions(
	rows: WebhookEventTypeRow[] | null | undefined,
	product: string,
	scope?: string,
): INodePropertyOptions[] {
	const narrowed = Boolean(scope) && scope !== WHOLE_WORKSPACE;

	return (Array.isArray(rows) ? rows : [])
		.filter((row) => row.type && row.product === product)
		.filter((row) => !narrowed || !Array.isArray(row.scopes) || row.scopes.includes(String(scope)))
		.map((row) => ({
			name: String(row.type),
			value: String(row.type),
			description: row.description ?? '',
		}))
		.sort((a, b) => a.value.localeCompare(b.value));
}

export function pmWebhooksSpec(workspace: string): RequestSpec {
	return { method: 'GET', path: encodePath`/mp/api/v1/workspaces/${workspace}/webhooks` };
}

export function pmWebhookOptions(
	rows:
		| Array<{ identifier?: string; name?: string; url?: string; active?: boolean }>
		| null
		| undefined,
): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((w) => w.identifier)
		.map((w) => {
			const label =
				w.name && w.url ? `${w.name} (${w.url})` : (w.name ?? w.url ?? (w.identifier as string));

			return {
				name: w.active === false ? `${label} (paused)` : label,
				value: w.identifier as string,
			};
		});
}

export function pmWebhookDeliveriesSpec(workspace: string, webhook: string): RequestSpec {
	return {
		method: 'GET',
		path: encodePath`/mp/api/v1/workspaces/${workspace}/webhooks/${webhook}/deliveries`,
		qs: { size: PICKER_PAGE_SIZE },
	};
}

export function pmWebhookDeliveryOptions(
	rows:
		| Array<{ identifier?: string; eventType?: string; status?: string; createdAt?: string }>
		| null
		| undefined,
): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((d) => d.identifier)
		.map((d) => {
			const label = [d.eventType, d.status, d.createdAt].filter(Boolean).join(' - ');

			return { name: label || (d.identifier as string), value: d.identifier as string };
		});
}

/* ---------- Hub calls and recordings ---------- */

interface HubCallRow {
	id?: number;
	call?: {
		name?: string;
		startTime?: string;
		recordings?: Array<{ id?: number; nameShortTranscription?: string }>;
	};
}

/**
 * The most recent calls, newest first. `/usercall/all` has no light projection and returns every
 * transcript, so this asks the search (empty query = the same list, same order) for `view=lite`.
 */
export function hubCallsSpec(): RequestSpec {
	return {
		method: 'GET',
		path: '/api/usercall/search',
		qs: { query: '', view: 'lite', page: 0, size: PICKER_PAGE_SIZE },
	};
}

const dayOf = (startTime: string | undefined) => (startTime ? ` (${startTime.slice(0, 10)})` : '');

export function hubCallOptions(rows: HubCallRow[] | null | undefined): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((r) => r.id !== undefined && r.id !== null)
		.map((r) => {
			const title = r.call?.name || r.call?.recordings?.[0]?.nameShortTranscription;

			return {
				name: title ? `${title}${dayOf(r.call?.startTime)}` : `Call ${r.id}`,
				value: String(r.id),
			};
		});
}

export function hubRecordingOptions(rows: HubCallRow[] | null | undefined): INodePropertyOptions[] {
	return (rows ?? []).flatMap((r) =>
		(r.call?.recordings ?? [])
			.filter((rec) => rec.id !== undefined && rec.id !== null)
			.map((rec) => {
				const title = [r.call?.name, rec.nameShortTranscription].filter(Boolean).join(' - ');

				return {
					name: title ? `${title}${dayOf(r.call?.startTime)}` : `Recording ${rec.id}`,
					value: String(rec.id),
				};
			}),
	);
}

/* ---------- Hub integration targets (send a call's action items) ---------- */

const hubWorkspacePath = (uuid: string, version: 'v1' | 'v2') =>
	encodePath`/api/${version}/workspaces/${uuid}`;

export function jiraCloudsSpec(uuid: string): RequestSpec {
	return { method: 'GET', path: `${hubWorkspacePath(uuid, 'v2')}/integrations/jira/clouds` };
}

export function jiraProjectsSpec(uuid: string, cloudId: string): RequestSpec {
	return {
		method: 'GET',
		path: `${hubWorkspacePath(uuid, 'v2')}/integrations/jira/clouds/${encodeURIComponent(cloudId)}/projects`,
	};
}

export function jiraCloudOptions(
	rows: Array<{ cloudId?: string; name?: string }> | null | undefined,
): INodePropertyOptions[] {
	return (Array.isArray(rows) ? rows : [])
		.filter((r) => r.cloudId)
		.map((r) => ({ name: r.name || (r.cloudId as string), value: r.cloudId as string }));
}

export function jiraProjectOptions(
	rows: Array<{ id?: string; key?: string; name?: string }> | null | undefined,
): INodePropertyOptions[] {
	return (Array.isArray(rows) ? rows : [])
		.filter((r) => r.id)
		.map((r) => {
			const name = r.name || (r.id as string);

			return { name: r.key ? `${name} (${r.key})` : name, value: r.id as string };
		});
}

export function airtableBasesSpec(uuid: string): RequestSpec {
	return { method: 'GET', path: `${hubWorkspacePath(uuid, 'v2')}/integrations/airtable/bases` };
}

export function airtableTablesSpec(uuid: string, baseId: string): RequestSpec {
	return {
		method: 'GET',
		path: `${hubWorkspacePath(uuid, 'v2')}/integrations/airtable/bases/${encodeURIComponent(baseId)}/tables`,
	};
}

type NamedRow = { id?: string; name?: string };

const namedOptions = (rows: NamedRow[] | null | undefined): INodePropertyOptions[] =>
	(Array.isArray(rows) ? rows : [])
		.filter((r) => r.id)
		.map((r) => ({ name: r.name || (r.id as string), value: r.id as string }));

/** AirtableBaseList: `{ bases: [...] }`. */
export function airtableBaseOptions(
	list: { bases?: NamedRow[] } | null | undefined,
): INodePropertyOptions[] {
	return namedOptions(list?.bases);
}

export function airtableTableOptions(rows: NamedRow[] | null | undefined): INodePropertyOptions[] {
	return namedOptions(rows);
}

/* ---------- Hub calendar ---------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The picker's window: the last 7 days and the next 60. */
export function calendarEventsSpec(now: Date = new Date()): RequestSpec {
	return {
		method: 'GET',
		path: '/api/v1/calendar/events',
		qs: {
			startDate: new Date(now.getTime() - 7 * DAY_MS).toISOString(),
			endDate: new Date(now.getTime() + 60 * DAY_MS).toISOString(),
		},
	};
}

/** A calendar-events-api row, as far as the pickers read it. */
interface CalendarEventRow {
	eventId?: string;
	id?: string;
	subject?: string;
	summary?: string;
	startDateTime?: string;
	start?: string;
	seriesMasterId?: string | null;
}

const eventTitle = (e: CalendarEventRow) => e.subject || e.summary || 'Untitled event';

export function calendarEventOptions(
	rows: CalendarEventRow[] | null | undefined,
): INodePropertyOptions[] {
	return (Array.isArray(rows) ? rows : [])
		.filter((e) => e.eventId || e.id)
		.map((e) => ({
			name: `${eventTitle(e)}${dayOf(e.startDateTime ?? e.start)}`,
			value: String(e.eventId ?? e.id),
		}));
}

/** One option per recurring series, named after its first listed occurrence. */
export function calendarSeriesOptions(
	rows: CalendarEventRow[] | null | undefined,
): INodePropertyOptions[] {
	const seen = new Map<string, string>();
	for (const e of Array.isArray(rows) ? rows : []) {
		if (e.seriesMasterId && !seen.has(e.seriesMasterId)) {
			seen.set(e.seriesMasterId, eventTitle(e));
		}
	}

	return [...seen].map(([value, name]) => ({ name, value }));
}

/* ---------- Hub meeting webhooks ---------- */

/** The caller's webhooks; Hub shows a key only those bound to the X-Dutify-Workspace workspace. */
export function hubWebhooksSpec(): RequestSpec {
	return { method: 'GET', path: '/api/user/webhooks' };
}

export function hubWebhookOptions(
	rows: HubWebhookRow[] | null | undefined,
): INodePropertyOptions[] {
	return (rows ?? [])
		.filter((w) => w.id !== undefined && w.id !== null)
		.map((w) => {
			const label = w.name && w.url ? `${w.name} (${w.url})` : w.name || w.url || `Webhook ${w.id}`;
			const paused = w.enabled === false;

			return { name: paused ? `${label} (paused)` : label, value: String(w.id) };
		});
}

/** A key without the scope (403) just gets no suggestions; the field still takes an expression. */
async function orNoneWhenForbidden<T>(load: () => Promise<T[]>): Promise<T[]> {
	return await load().catch((error: unknown) => (isForbidden(error) ? [] : Promise.reject(error)));
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

/**
 * A Hub integration picker: finds the workspace UUID, then loads. With `parent`, waits until that
 * field (the Jira site, the Airtable base) is chosen. A workspace without the integration makes
 * Hub answer 404 "Integration Not Found", which n8n shows as the reason the list is empty.
 */
async function hubTargets(
	ctx: ILoadOptionsFunctions,
	parent: string,
	load: (fetch: Fetch, uuid: string, parentValue: string) => Promise<INodePropertyOptions[]>,
): Promise<INodePropertyOptions[]> {
	const workspace = selectedWorkspace(ctx);
	const parentValue = parent ? optionalParam(ctx, parent) : '';
	if (!workspace || (parent && !parentValue)) {
		return [];
	}
	const fetch: Fetch = async (spec) => await dutifyRequest.call(ctx, spec, workspace);
	const { id } = await resolveHubWorkspace(fetch, workspace);

	return await load(fetch, id as string, parentValue);
}

async function loadSprintGroups(ctx: ILoadOptionsFunctions): Promise<SprintGroupRow[]> {
	const workspace = selectedWorkspace(ctx);
	const space = optionalParam(ctx, 'space');
	if (!workspace || !space) {
		return [];
	}

	return (await dutifyRequest.call(ctx, sprintGroupsSpec(space), workspace)) as SprintGroupRow[];
}

async function loadWikiPages(ctx: ILoadOptionsFunctions) {
	const workspace = selectedWorkspace(ctx);
	const space = optionalParam(ctx, 'space');
	if (!workspace || !space) {
		return [];
	}

	return (await dutifyRequest.call(ctx, wikiPagesSpec(workspace, space), workspace)) as Parameters<
		typeof wikiPageOptions
	>[0];
}

async function boardNames(ctx: ILoadOptionsFunctions, kind: BoardNameKind) {
	const workspace = selectedWorkspace(ctx);

	return await loadBoardNames(
		async (spec) => await dutifyRequest.call(ctx, spec, workspace),
		workspace,
		optionalParam(ctx, 'board'),
		kind,
	);
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

/** The Dutify Trigger's scope field per product source. */
const TRIGGER_SCOPE_FIELD: Record<string, string> = {
	codexum: 'wikiScopeType',
	roadmarq: 'feedbackScopeType',
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
	async getViews(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		const scope = optionalParam(this, 'scope');
		const target =
			scope === 'workspace' ? workspace : optionalParam(this, SCOPE_TARGET_PARAM[scope] ?? '');
		if (!workspace || !scope || !target) {
			return [];
		}
		const page = (await dutifyRequest.call(this, viewsSpec(scope, target), workspace)) as ViewPage;

		return viewOptions(page);
	},
	async getWidgets(this: ILoadOptionsFunctions) {
		const view = optionalParam(this, 'view');
		const workspace = selectedWorkspace(this);
		if (!workspace || !view) {
			return [];
		}
		const widgets = (await dutifyRequest.call(this, widgetsSpec(view), workspace)) as WidgetRow[];

		return widgetOptions(widgets);
	},
	async getSprintGroups(this: ILoadOptionsFunctions) {
		return sprintGroupOptions(await loadSprintGroups(this));
	},
	async getSprints(this: ILoadOptionsFunctions) {
		return sprintOptions(await loadSprintGroups(this));
	},
	async getTeams(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return teamOptions(
			(await dutifyRequest.call(this, teamsSpec(workspace), workspace)) as Parameters<
				typeof teamOptions
			>[0],
		);
	},
	async getMemberIds(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}
		const options: INodePropertyOptions[] = [];
		for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
			const response = (await dutifyRequest.call(
				this,
				workspaceUsersSpec(workspace, page),
				workspace,
			)) as { users?: WorkspaceUserRow[] | null; totalPages?: number } | null;
			options.push(...workspaceUserOptions(response?.users));
			if (page + 1 >= (response?.totalPages ?? 0)) {
				break;
			}
		}

		return options;
	},
	async getInvitations(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return invitationOptions(
			(await dutifyRequest.call(this, invitationsSpec(workspace), workspace)) as Parameters<
				typeof invitationOptions
			>[0],
		);
	},
	async getAccessLevels(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return accessLevelOptions(
			(await dutifyRequest.call(this, accessLevelsSpec(workspace), workspace)) as Parameters<
				typeof accessLevelOptions
			>[0],
		);
	},
	async getImportJobs(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return importJobOptions(
			(await dutifyRequest.call(this, importJobsSpec(workspace), workspace)) as Parameters<
				typeof importJobOptions
			>[0],
		);
	},
	async getAutomations(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		const scope = optionalParam(this, 'scope');
		const target = optionalParam(this, scope);
		if (!workspace || !['space', 'folder', 'list'].includes(scope) || !target) {
			return [];
		}

		return automationOptions(
			(await dutifyRequest.call(this, automationsSpec(scope, target), workspace)) as Parameters<
				typeof automationOptions
			>[0],
		);
	},
	async getSavedFilters(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		const list = optionalParam(this, 'list');
		if (!workspace || !list) {
			return [];
		}

		return savedFilterOptions(
			(await dutifyRequest.call(this, savedFiltersSpec(list), workspace)) as Parameters<
				typeof savedFilterOptions
			>[0],
		);
	},
	async getNotifications(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return notificationOptions(
			(await dutifyRequest.call(this, notificationsSpec(workspace), workspace)) as Parameters<
				typeof notificationOptions
			>[0],
		);
	},
	async getTimeEntries(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		const task = optionalParam(this, 'task');
		if (!workspace || !task) {
			return [];
		}
		try {
			const taskId = await resolveTaskId(
				async (spec) => await dutifyRequest.call(this, spec, workspace),
				task,
				workspace,
			);

			return timeEntryOptions(
				(await dutifyRequest.call(this, timeEntriesSpec(taskId), workspace)) as Parameters<
					typeof timeEntryOptions
				>[0],
			);
		} catch {
			// A half-typed or unknown task key just shows no entries.
			return [];
		}
	},
	async getPmEventTypes(this: ILoadOptionsFunctions) {
		return pmEventTypeOptions();
	},
	/**
	 * The Dutify Trigger's events for its source; the source names the product, and its scope
	 * field narrows the list to the events that scope can take.
	 */
	async getWebhookEventTypes(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}
		const product = optionalParam(this, 'source') || 'pm';
		const scopeField = TRIGGER_SCOPE_FIELD[product];
		const scope = scopeField ? optionalParam(this, scopeField) : '';

		return await orNoneWhenForbidden(async () =>
			webhookEventTypeOptions(
				(await dutifyRequest.call(this, webhookEventTypesSpec(workspace), workspace)) as
					| WebhookEventTypeRow[]
					| null,
				product,
				scope,
			),
		);
	},
	async getPmWebhooks(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return pmWebhookOptions(
			(await dutifyRequest.call(this, pmWebhooksSpec(workspace), workspace)) as Parameters<
				typeof pmWebhookOptions
			>[0],
		);
	},
	async getPmWebhookDeliveries(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		const webhook = optionalParam(this, 'webhook');
		if (!workspace || !webhook) {
			return [];
		}

		return pmWebhookDeliveryOptions(
			(await dutifyRequest.call(
				this,
				pmWebhookDeliveriesSpec(workspace, webhook),
				workspace,
			)) as Parameters<typeof pmWebhookDeliveryOptions>[0],
		);
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
	async getWikiPages(this: ILoadOptionsFunctions) {
		return wikiPageOptions(await loadWikiPages(this));
	},
	async getWikiParentPages(this: ILoadOptionsFunctions) {
		return wikiParentPageOptions(await loadWikiPages(this));
	},
	async getWikiPageIds(this: ILoadOptionsFunctions) {
		return wikiPageIdOptions(await loadWikiPages(this));
	},
	async getWikiAttachments(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		const pageId = optionalParam(this, 'pageId');
		if (!workspace || !pageId) {
			return [];
		}
		const rows = (await dutifyRequest.call(
			this,
			wikiAttachmentsSpec(pageId),
			workspace,
		)) as Parameters<typeof wikiAttachmentOptions>[0];

		return wikiAttachmentOptions(rows);
	},
	async getRequestShortIds(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		const board = optionalParam(this, 'board');
		if (!workspace || !board) {
			return [];
		}

		return requestShortIdOptions(
			(await dutifyRequest.call(this, requestsSpec(workspace, board), workspace)) as Parameters<
				typeof requestShortIdOptions
			>[0],
		);
	},
	async getBugShortIds(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		const board = optionalParam(this, 'board');
		if (!workspace || !board) {
			return [];
		}

		return bugShortIdOptions(
			(await dutifyRequest.call(this, bugsSpec(workspace, board), workspace)) as Parameters<
				typeof bugShortIdOptions
			>[0],
		);
	},
	async getRequestStatuses(this: ILoadOptionsFunctions) {
		return await boardNames(this, 'statuses');
	},
	async getRequestCategories(this: ILoadOptionsFunctions) {
		return await boardNames(this, 'categories');
	},
	async getMilestones(this: ILoadOptionsFunctions) {
		return await boardNames(this, 'milestones');
	},
	async getSeverityLevels(this: ILoadOptionsFunctions) {
		return await boardNames(this, 'severityLevels');
	},
	async getProductAreas(this: ILoadOptionsFunctions) {
		return await boardNames(this, 'productAreas');
	},
	async getBugStatuses(this: ILoadOptionsFunctions) {
		return await boardNames(this, 'bugStatuses');
	},
	async getHubCalls(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return await orNoneWhenForbidden(async () =>
			hubCallOptions(
				(await dutifyRequest.call(this, hubCallsSpec(), workspace)) as Parameters<
					typeof hubCallOptions
				>[0],
			),
		);
	},
	async getHubRecordings(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return await orNoneWhenForbidden(async () =>
			hubRecordingOptions(
				(await dutifyRequest.call(this, hubCallsSpec(), workspace)) as Parameters<
					typeof hubRecordingOptions
				>[0],
			),
		);
	},
	async getJiraClouds(this: ILoadOptionsFunctions) {
		return await hubTargets(this, '', async (fetch, uuid) =>
			jiraCloudOptions(
				(await fetch(jiraCloudsSpec(uuid))) as Parameters<typeof jiraCloudOptions>[0],
			),
		);
	},
	async getJiraProjects(this: ILoadOptionsFunctions) {
		return await hubTargets(this, 'jiraCloud', async (fetch, uuid, cloud) =>
			jiraProjectOptions(
				(await fetch(jiraProjectsSpec(uuid, cloud))) as Parameters<typeof jiraProjectOptions>[0],
			),
		);
	},
	async getAirtableBases(this: ILoadOptionsFunctions) {
		return await hubTargets(this, '', async (fetch, uuid) =>
			airtableBaseOptions(
				(await fetch(airtableBasesSpec(uuid))) as Parameters<typeof airtableBaseOptions>[0],
			),
		);
	},
	async getAirtableTables(this: ILoadOptionsFunctions) {
		return await hubTargets(this, 'airtableBase', async (fetch, uuid, base) =>
			airtableTableOptions(
				(await fetch(airtableTablesSpec(uuid, base))) as Parameters<typeof airtableTableOptions>[0],
			),
		);
	},
	async getCalendarEvents(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return await orNoneWhenForbidden(async () =>
			calendarEventOptions(
				(await dutifyRequest.call(this, calendarEventsSpec(), workspace)) as Parameters<
					typeof calendarEventOptions
				>[0],
			),
		);
	},
	async getCalendarSeries(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return await orNoneWhenForbidden(async () =>
			calendarSeriesOptions(
				(await dutifyRequest.call(this, calendarEventsSpec(), workspace)) as Parameters<
					typeof calendarSeriesOptions
				>[0],
			),
		);
	},
	async getMeetingWebhooks(this: ILoadOptionsFunctions) {
		const workspace = selectedWorkspace(this);
		if (!workspace) {
			return [];
		}

		return await orNoneWhenForbidden(async () =>
			hubWebhookOptions(
				(await dutifyRequest.call(this, hubWebhooksSpec(), workspace)) as Parameters<
					typeof hubWebhookOptions
				>[0],
			),
		);
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
