import type { INodeProperties } from 'n8n-workflow';

/** Workspace picker. Its value is sent as the X-Dutify-Workspace header by the registry. */
export const workspaceField: INodeProperties = {
	displayName: 'Workspace',
	name: 'workspace',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The Dutify workspace to work in',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: {
				searchListMethod: 'searchWorkspaces',
				searchable: true,
			},
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. my-workspace',
		},
	],
};

/** Return All + Limit for list operations. Limit is shown only while Return All is off. */
export function returnAllFields(): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1 },
			description: 'Max number of results to return',
			displayOptions: { show: { returnAll: [false] } },
		},
	];
}
