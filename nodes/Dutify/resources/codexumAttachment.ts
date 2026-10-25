import { ApplicationError } from 'n8n-workflow';
import type { INodeProperties } from 'n8n-workflow';
import { idPicker } from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import type {
	OperationContext,
	OperationDef,
	ParamReader,
	ResourceDef,
} from '../../../shared/types';
import { spaceField } from './codexum';

/** Used when n8n has no mime type for the binary; the same value is declared and PUT. */
const DEFAULT_MIME_TYPE = 'application/octet-stream';
const DEFAULT_BINARY_PROPERTY = 'data';

/**
 * Attachment endpoints address the page by UUID (not slug), so the page picker is valued by
 * page id. The space picker only narrows that list; it is not part of any request.
 */
const pageIdField = (): INodeProperties =>
	idPicker('Page Name or ID', 'pageId', 'getWikiPageIds', undefined, ['space']);

const attachmentField = (): INodeProperties =>
	idPicker('Attachment Name or ID', 'attachmentId', 'getWikiAttachments', undefined, ['pageId']);

const attachmentsPath = (p: ParamReader) =>
	encodePath`/api/wiki/v1/pages/${p.get<string>('pageId')}/attachments`;

const attachmentPath = (p: ParamReader) =>
	`${attachmentsPath(p)}/${encodeURIComponent(p.get<string>('attachmentId'))}`;

interface UploadSlot {
	attachmentId: string;
	uploadUrl: string;
}

/** Request a slot, PUT the bytes to the presigned URL, confirm. A failed PUT removes the pending record. */
async function upload(ctx: OperationContext, p: ParamReader) {
	const property = p.get<string>('binaryPropertyName', DEFAULT_BINARY_PROPERTY);
	const { data, mimeType, fileName } = await ctx.readBinary(property);
	if (data.length === 0) {
		throw new ApplicationError(`The binary property "${property}" is empty; nothing to upload`);
	}
	const contentType = mimeType || DEFAULT_MIME_TYPE;
	const base = attachmentsPath(p);

	const slot = (await ctx.request({
		method: 'POST',
		path: `${base}/upload-url`,
		body: { filename: fileName, contentType, sizeBytes: data.length },
	})) as UploadSlot;

	const confirmPath = `${base}/${encodeURIComponent(slot.attachmentId)}`;
	let stored = false;
	try {
		await ctx.putBinary(slot.uploadUrl, data, contentType);
		stored = true;
	} finally {
		if (!stored) {
			// The pending record counts toward the per-page limit; drop it. The PUT error still propagates.
			await ctx.request({ method: 'DELETE', path: confirmPath }).catch(() => undefined);
		}
	}

	const confirmed = await ctx.request({ method: 'POST', path: `${confirmPath}/confirm` });

	return [{ json: confirmed as Record<string, never> }];
}

const operations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many attachments of a page',
		description: 'List the file attachments of a page',
		fields: [spaceField(), pageIdField()],
		build: (p) => ({ method: 'GET', path: attachmentsPath(p) }),
	},
	{
		operation: 'upload',
		name: 'Upload',
		action: 'Upload an attachment to a page',
		description: 'Upload a binary file as an attachment of a page',
		fields: [
			spaceField(),
			pageIdField(),
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: DEFAULT_BINARY_PROPERTY,
				required: true,
				description: 'Name of the binary property of the input item that holds the file',
			},
		],
		run: upload,
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete an attachment',
		description: 'Delete an attachment and its file',
		fields: [spaceField(), pageIdField(), attachmentField()],
		build: (p) => ({ method: 'DELETE', path: attachmentPath(p) }),
	},
];

/** Codexum (wiki) page attachments. */
export const codexumAttachment: ResourceDef = {
	value: 'codexumAttachment',
	name: 'Codexum Attachment',
	workspaceScoped: true,
	operations,
};
