import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeProperties } from 'n8n-workflow';

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
