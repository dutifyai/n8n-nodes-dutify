import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { listSearch, loadOptions } from './loaders';
import { buildProperties, executeOperation, resources } from './registry';

export class Dutify implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dutify',
		name: 'dutify',
		icon: { light: 'file:../../icons/dutify.svg', dark: 'file:../../icons/dutify.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Work with Dutify tasks, wiki pages, feature requests and recordings',
		defaults: {
			name: 'Dutify',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'dutifyApi',
				required: true,
			},
		],
		properties: buildProperties(resources),
	};

	methods = { listSearch, loadOptions };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await executeOperation.call(this, resources);
	}
}
