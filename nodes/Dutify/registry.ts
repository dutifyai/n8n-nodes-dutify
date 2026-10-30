import type {
	IBinaryData,
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { ApplicationError, BINARY_ENCODING, NodeApiError, NodeOperationError } from 'n8n-workflow';
import { returnAllFields, workspaceField } from '../../shared/fields';
import { requestAllPages } from '../../shared/pagination';
import { dutifyErrorOf, dutifyRequest } from '../../shared/transport';
import { importJob, invitation, member, team } from './resources/admin';
import { automation } from './resources/automation';
import { codexumPage, codexumSpace } from './resources/codexum';
import { codexumAttachment } from './resources/codexumAttachment';
import { customField, folder, list, space, tag } from './resources/structure';
import { sprint } from './resources/sprint';
import { task, taskComment, taskRelationship } from './resources/task';
import { savedFilter, taskSharing, timeEntry } from './resources/taskExtras';
import { activityLog, notification, user } from './resources/userActivity';
import { pmWebhook } from './resources/pmWebhook';
import { call, lens, recording } from './resources/hub';
import { calendarEvent } from './resources/hubCalendar';
import { hubIntegration, hubWorkspace } from './resources/hubWorkspace';
import { meetingWebhook } from './resources/meetingWebhook';
import { bug, featureRequest, roadmarqBoard } from './resources/roadmarq';
import { view } from './resources/view';
import { account, workspace } from './resources/workspace';
import type { OperationContext, OperationDef, ParamReader, ResourceDef } from '../../shared/types';

/** Every resource the Dutify node exposes. Resource tasks append their ResourceDefs here. */
export const resources: ResourceDef[] = [
	account,
	workspace,
	task,
	taskComment,
	taskRelationship,
	space,
	folder,
	list,
	customField,
	tag,
	view,
	sprint,
	team,
	member,
	invitation,
	importJob,
	automation,
	taskSharing,
	user,
	timeEntry,
	savedFilter,
	notification,
	activityLog,
	pmWebhook,
	codexumPage,
	codexumSpace,
	codexumAttachment,
	featureRequest,
	bug,
	roadmarqBoard,
	call,
	recording,
	lens,
	meetingWebhook,
	hubWorkspace,
	hubIntegration,
	calendarEvent,
];

/** Copies a field with `show` conditions merged into its own displayOptions. */
function scoped(field: INodeProperties, show: Record<string, Array<string | boolean>>) {
	return {
		...field,
		displayOptions: {
			...field.displayOptions,
			show: { ...show, ...field.displayOptions?.show },
		},
	} as INodeProperties;
}

/**
 * Makes every dropdown in a workspace-scoped field reload when the workspace changes. n8n keeps a
 * dropdown's options until a parameter in loadOptionsDependsOn changes, so without this a dropdown
 * opened before a workspace was chosen stays empty.
 */
function reloadsWithWorkspace(field: INodeProperties): INodeProperties {
	const dependsOn = field.typeOptions?.loadOptionsDependsOn ?? [];
	const typeOptions =
		field.typeOptions?.loadOptionsMethod && !dependsOn.includes('workspace.value')
			? { ...field.typeOptions, loadOptionsDependsOn: [...dependsOn, 'workspace.value'] }
			: field.typeOptions;
	const options = field.options?.map((o) =>
		'type' in o ? reloadsWithWorkspace(o) : o,
	) as INodeProperties['options'];

	return { ...field, typeOptions, ...(options ? { options } : {}) };
}

export function buildProperties(defs: ResourceDef[]): INodeProperties[] {
	const defaultResource = defs[0]?.value ?? '';
	const properties: INodeProperties[] = [
		{
			displayName: 'Resource',
			name: 'resource',
			type: 'options',
			noDataExpression: true,
			options: defs.map((r) => ({ name: r.name, value: r.value })),
			default: defaultResource,
		},
	];

	for (const r of defs) {
		const defaultOperation = r.operations[0]?.operation ?? '';
		properties.push({
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: { show: { resource: [r.value] } },
			options: r.operations.map((o) => ({
				name: o.name,
				value: o.operation,
				action: o.action,
				description: o.description,
			})),
			default: defaultOperation,
		});
	}

	const scopedResources = defs.filter((r) => r.workspaceScoped).map((r) => r.value);
	if (scopedResources.length > 0) {
		properties.push(scoped(workspaceField, { resource: scopedResources }));
	}

	for (const r of defs) {
		for (const o of r.operations) {
			const show = { resource: [r.value], operation: [o.operation] };
			const fields = o.list ? [...o.fields, ...returnAllFields()] : o.fields;
			for (const field of fields) {
				properties.push(scoped(r.workspaceScoped ? reloadsWithWorkspace(field) : field, show));
			}
		}
	}

	return properties;
}

export function findOperation(
	defs: ResourceDef[],
	resource: string,
	operation: string,
): OperationDef {
	const op = defs
		.find((r) => r.value === resource)
		?.operations.find((o) => o.operation === operation);
	if (!op) {
		throw new ApplicationError(`Unknown Dutify operation "${resource}.${operation}"`);
	}

	return op;
}

/** Turns an API response into output items: one per array element, `{success:true}` for 204. */
function toItems(response: unknown): INodeExecutionData[] {
	if (response === undefined || response === null || response === '') {
		return [{ json: { success: true } }];
	}
	const values = Array.isArray(response) ? response : [response];

	return values.map((value: unknown) => ({
		json:
			value !== null && typeof value === 'object' && !Array.isArray(value)
				? (value as IDataObject)
				: { value: value as IDataObject[string] },
	}));
}

function asNodeError(node: INode, error: unknown, itemIndex: number) {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		error.context.itemIndex = itemIndex;

		return error;
	}

	return new NodeOperationError(node, error as Error, { itemIndex });
}

/**
 * `{error, description?, httpCode?, errorCode?}` for Continue On Fail; empty fields are left out.
 * `errorCode` is Dutify's own code (e.g. `NOT_FOUND`, `AI_COWORKER_USAGE_EXHAUSTED`), for a
 * workflow to branch on.
 */
function errorItem(error: unknown): IDataObject {
	const item: IDataObject = { error: (error as Error).message ?? String(error) };
	if (error instanceof NodeApiError) {
		if (error.description) {
			item.description = error.description;
		}
		if (error.httpCode) {
			item.httpCode = error.httpCode;
		}
		const { code } = dutifyErrorOf(error);
		if (code) {
			item.errorCode = code;
		}
	}

	return item;
}

/** Read size of a binary stream; parts are regrouped to Hub's part size by the upload. */
const STREAM_CHUNK_BYTES = 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/mp4': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/aac': 'aac',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/ogg': 'ogg',
	'audio/webm': 'webm',
	'audio/flac': 'flac',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
	'video/x-matroska': 'mkv',
};

/** A binary without a file name: the property name, with the extension n8n or its type gives. */
function nameWithExtension(property: string, binary: IBinaryData): string {
	const extension = binary.fileExtension || EXTENSIONS[binary.mimeType];

	return extension ? `${property}.${extension}` : property;
}

async function runOperation(
	this: IExecuteFunctions,
	defs: ResourceDef[],
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const resource = this.getNodeParameter('resource', itemIndex) as string;
	const operation = this.getNodeParameter('operation', itemIndex) as string;
	const op = findOperation(defs, resource, operation);
	const workspaceScoped = defs.find((r) => r.value === resource)?.workspaceScoped ?? false;
	const workspace = workspaceScoped
		? String(this.getNodeParameter('workspace', itemIndex, '', { extractValue: true }) ?? '')
		: '';

	const p: ParamReader = {
		workspace,
		get: <T>(name: string, fallback?: T) =>
			this.getNodeParameter(name, itemIndex, fallback, { extractValue: true }) as T,
	};

	const ctx: OperationContext = {
		request: async (spec) => await dutifyRequest.call(this, spec, workspace),
		requestAll: async (spec, limit) =>
			await requestAllPages(async (s) => await ctx.request(s), spec, limit),
		readBinary: async (property) => {
			const binary = this.helpers.assertBinaryData(itemIndex, property);
			const data = await this.helpers.getBinaryDataBuffer(itemIndex, property);

			return {
				data,
				mimeType: binary.mimeType,
				fileName: binary.fileName ?? property,
			};
		},
		openBinary: async (property) => {
			const binary = this.helpers.assertBinaryData(itemIndex, property);
			const fileName = binary.fileName ?? nameWithExtension(property, binary);
			if (binary.id) {
				// Filesystem or S3 binary mode: stream it from there, never through a Buffer.
				const meta = await this.helpers.getBinaryMetadata(binary.id);
				const content = await this.helpers.getBinaryStream(binary.id, STREAM_CHUNK_BYTES);

				return { content, size: meta.fileSize, mimeType: binary.mimeType, fileName };
			}
			// No id: the bytes travel in the item itself, as base64 (n8n 1.x memory mode, or a
			// binary a node built in place), so they are already in memory.
			const data = Buffer.from(binary.data, BINARY_ENCODING);

			return { content: data, size: data.length, mimeType: binary.mimeType, fileName };
		},
		putStream: async (url, content, size, mimeType) => {
			// Presigned storage URL: no Dutify credentials. A stream has no length the client can
			// derive, so Content-Length is sent explicitly.
			await this.helpers.httpRequest({
				method: 'PUT',
				url,
				body: content,
				headers: { 'Content-Type': mimeType, 'Content-Length': String(size) },
				json: false,
			});
		},
		downloadToBinary: async (url, fileName) => {
			const response = (await this.helpers.httpRequest({
				method: 'GET',
				url,
				encoding: 'arraybuffer',
				json: false,
				returnFullResponse: true,
			})) as { body: ArrayBuffer | Buffer; headers?: IDataObject };
			const contentType = response.headers?.['content-type'];

			return await this.helpers.prepareBinaryData(
				Buffer.from(response.body as ArrayBuffer),
				fileName,
				typeof contentType === 'string' ? contentType.split(';')[0].trim() : undefined,
			);
		},
		putBinary: async (url, data, mimeType) => {
			// Presigned storage URL: no Dutify credentials. The signature covers Content-Type
			// (and Content-Length, which the HTTP client derives from the Buffer).
			await this.helpers.httpRequest({
				method: 'PUT',
				url,
				body: data,
				headers: { 'Content-Type': mimeType },
				json: false,
			});
		},
	};

	if (op.run) {
		return await op.run(ctx, p);
	}
	if (!op.build) {
		throw new NodeOperationError(
			this.getNode(),
			`Dutify operation "${resource}.${operation}" has neither build nor run`,
			{ itemIndex },
		);
	}
	const spec = op.build(p);
	if (op.list) {
		const returnAll = p.get<boolean>('returnAll', false);
		const limit = returnAll ? undefined : p.get<number>('limit', 50);

		return toItems(await ctx.requestAll(spec, limit));
	}

	return toItems(await ctx.request(spec));
}

export async function executeOperation(
	this: IExecuteFunctions,
	defs: ResourceDef[],
): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const output: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const results = await runOperation.call(this, defs, itemIndex);
			for (const result of results) {
				output.push({ ...result, pairedItem: { item: itemIndex } });
			}
		} catch (error) {
			if (this.continueOnFail()) {
				output.push({
					json: errorItem(error),
					pairedItem: { item: itemIndex },
				});
				continue;
			}
			throw asNodeError(this.getNode(), error, itemIndex);
		}
	}

	return [output];
}
