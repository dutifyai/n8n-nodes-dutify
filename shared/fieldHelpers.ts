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
