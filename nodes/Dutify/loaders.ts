import type { ILoadOptionsFunctions, INodeListSearchResult, INodeType } from 'n8n-workflow';

// Placeholder (ruling R2): Task 3 replaces these with the real Dutify loaders.

export const listSearch: NonNullable<NonNullable<INodeType['methods']>['listSearch']> = {
	async searchWorkspaces(this: ILoadOptionsFunctions): Promise<INodeListSearchResult> {
		return { results: [] };
	},
};

export const loadOptions: NonNullable<NonNullable<INodeType['methods']>['loadOptions']> = {};
