import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeExecutionData, INodeProperties } from 'n8n-workflow';

/** Field-building helpers shared by the resource definitions. */

export const isSet = (value: unknown) => value !== undefined && value !== null && value !== '';

/** An update that sets nothing would send `PUT {}`; refuse it up front. */
export function requireChange(body: IDataObject): IDataObject {
	if (Object.keys(body).length === 0) {
		throw new ApplicationError('Set at least one field to update in Update Fields');
	}

	return body;
}

export const collection = (
	displayName: string,
	name: string,
	options: INodeProperties[],
): INodeProperties => ({
	displayName,
	name,
	type: 'collection',
	placeholder: 'Add Field',
	default: {},
	options,
});

export const text = (displayName: string, name: string, description: string): INodeProperties => ({
	displayName,
	name,
	type: 'string',
	default: '',
	description,
});

export const jsonField = (
	displayName: string,
	name: string,
	description: string,
): INodeProperties => ({
	displayName,
	name,
	type: 'json',
	default: '',
	description,
});

/** `a, b ,,c` -> ['a','b','c']. */
export function splitList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((v) => String(v).trim()).filter(Boolean);
	}
	if (typeof value !== 'string') {
		return [];
	}

	return value
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}

/** The API wants ISO-8601 instants. n8n date pickers can omit the zone, which is read as UTC. */
export function toInstant(value: unknown): string {
	const text = String(value).trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		return `${text}T00:00:00Z`;
	}

	return /(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
}

export const dateTime = (
	displayName: string,
	name: string,
	description: string,
): INodeProperties => ({
	displayName,
	name,
	type: 'dateTime',
	default: '',
	description,
});

/** A single-response operation's result as one item. A blank response (204) becomes `{ success: true }`. */
export function oneItem(response: unknown): INodeExecutionData[] {
	if (response === undefined || response === null || response === '') {
		return [{ json: { success: true } }];
	}

	return [{ json: response as IDataObject }];
}

export const EXPRESSION_HINT =
	'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>';

/** An options field whose choices come from a loader and hold identifiers; the user never types an ID. */
export const idPicker = (
	displayName: string,
	name: string,
	method: string,
	showOn: { field: string; value: string } | undefined,
	dependsOn?: string[],
): INodeProperties => ({
	displayName,
	name,
	type: 'options',
	typeOptions: {
		loadOptionsMethod: method,
		...(dependsOn ? { loadOptionsDependsOn: dependsOn } : {}),
	},
	default: '',
	required: true,
	...(showOn ? { displayOptions: { show: { [showOn.field]: [showOn.value] } } } : {}),
	description: EXPRESSION_HINT,
});
