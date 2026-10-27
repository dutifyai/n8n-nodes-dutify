import { ApplicationError } from 'n8n-workflow';
import type { RequestSpec } from './types';

export type Fetch = (spec: RequestSpec) => Promise<unknown>;

export interface WorkspaceSummary {
	identifier: string;
	name: string;
}

export interface CurrentKey {
	keyType?: string;
	keyIdentifier?: string;
	keyName?: string;
	workspaceIdentifier?: string;
	workspaceName?: string;
	scopes?: string[];
}

export const currentKeySpec: RequestSpec = { method: 'GET', path: '/mp/api/v1/api-keys/current' };
export const personalWorkspacesSpec: RequestSpec = {
	method: 'GET',
	path: '/mp/api/v1/personal-api-keys/workspaces',
};

interface RawWorkspace {
	identifier: string;
	name: string;
	suiteAccess?: boolean;
}

/** A key is personal when it says so, or when it has no workspace of its own to be bound to. */
export function isPersonalKey(key: CurrentKey): boolean {
	return key.keyType === 'PERSONAL' || !key.workspaceIdentifier;
}

/**
 * Introspects the calling key, then lists the workspaces it can use. Only a personal key
 * calls `/personal-api-keys/workspaces`; a workspace-bound key is answered from
 * `/api-keys/current` alone.
 */
export async function fetchAccessibleWorkspaces(
	fetch: Fetch,
): Promise<{ key: CurrentKey; personal: boolean; workspaces: WorkspaceSummary[] }> {
	const key = (await fetch(currentKeySpec)) as CurrentKey;
	if (!isPersonalKey(key)) {
		return {
			key,
			personal: false,
			workspaces: [
				{
					identifier: key.workspaceIdentifier as string,
					name: key.workspaceName ?? (key.workspaceIdentifier as string),
				},
			],
		};
	}
	const raw = ((await fetch(personalWorkspacesSpec)) as RawWorkspace[] | null) ?? [];

	return {
		key,
		personal: true,
		workspaces: raw
			.filter((w) => w.suiteAccess === true)
			.map((w) => ({
				identifier: w.identifier,
				name: w.name,
			})),
	};
}

/* ---------- Hub workspaces ---------- */

/**
 * Hub's workspaces (catalog tag Workspaces). For an API key Hub lists only the workspace the key
 * may use, the X-Dutify-Workspace one for a personal key; each row carries its UUID `id` and the
 * suite `identifier`.
 */
export const hubWorkspacesSpec: RequestSpec = { method: 'GET', path: '/api/v1/workspaces' };

export interface HubWorkspaceRow {
	id?: string;
	identifier?: string;
	name?: string;
	[key: string]: unknown;
}

/** The row of the selected workspace, matched by identifier or by UUID. */
export function findHubWorkspace(
	response: unknown,
	workspace: string,
): HubWorkspaceRow | undefined {
	const rows: unknown = Array.isArray(response)
		? response
		: (response as { workspaces?: unknown } | null)?.workspaces;

	return (Array.isArray(rows) ? (rows as HubWorkspaceRow[]) : []).find(
		(row) => Boolean(workspace) && (row.identifier === workspace || row.id === workspace),
	);
}

/**
 * The selected workspace as Hub knows it. Hub's /v1/workspaces/{workspaceId} paths take this
 * row's UUID: the suite identifier is refused there with 403 "API key cannot access this
 * workspace".
 */
export async function resolveHubWorkspace(
	fetch: Fetch,
	workspace: string,
): Promise<HubWorkspaceRow> {
	const row = findHubWorkspace(await fetch(hubWorkspacesSpec), workspace);
	if (!row?.id) {
		throw new ApplicationError(
			`Hub does not list the workspace "${workspace}" for this API key. Check that the key may use it and that the workspace has Hub access.`,
		);
	}

	return row;
}
