import type { RequestSpec } from './types';

export type Fetch = (spec: RequestSpec) => Promise<unknown>;

export interface WorkspaceSummary {
	identifier: string;
	name: string;
	description: string | null;
	isOwner: boolean;
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
	description?: string | null;
	isOwner?: boolean;
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
					description: null,
					isOwner: false,
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
				description: w.description ?? null,
				isOwner: w.isOwner ?? false,
			})),
	};
}
