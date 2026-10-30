/**
 * Engine mode for the live tests: instead of emulating the n8n runtime, every operation runs as a
 * real workflow in a running n8n instance with this package installed (Webhook → [Code for binary
 * input] → Dutify), so parameter defaults, hidden-field pruning, resource-locator handling,
 * binary data and error serialization are n8n's own.
 *
 * Enabled when N8N_ENGINE_URL, N8N_ENGINE_API_KEY (an n8n public API key) and
 * N8N_ENGINE_CREDENTIAL_ID (the instance's Dutify credential) are set in the environment.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-globals --
   test-only code (not published): reads its settings from the environment. */
import { randomUUID } from 'node:crypto';
import type { IDataObject, INode, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export interface EngineBinary {
	property: string;
	data: Buffer;
	mimeType: string;
	fileName: string;
}

const config = {
	url: process.env.N8N_ENGINE_URL ?? '',
	apiKey: process.env.N8N_ENGINE_API_KEY ?? '',
	credentialId: process.env.N8N_ENGINE_CREDENTIAL_ID ?? '',
};

const ENGINE_NODE: INode = {
	id: 'engine-node',
	name: 'Dutify',
	type: '@dutifyai/n8n-nodes-dutify.dutify',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export const engineEnabled = Boolean(config.url && config.apiKey && config.credentialId);

async function api(method: string, path: string, body?: unknown): Promise<IDataObject> {
	const response = await fetch(`${config.url}/api/v1${path}`, {
		method,
		headers: { 'X-N8N-API-KEY': config.apiKey, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`n8n ${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`);
	}

	return text ? (JSON.parse(text) as IDataObject) : {};
}

const BINARY_CODE = `const b = $input.first().json.body;
return [{ json: {}, binary: { [b.property]: await this.helpers.prepareBinaryData(Buffer.from(b.data, 'base64'), b.fileName, b.mimeType) } }];`;

function workflowOf(path: string, parameters: IDataObject, withBinary: boolean): IDataObject {
	const nodes: IDataObject[] = [
		{
			id: randomUUID(),
			name: 'Webhook',
			type: 'n8n-nodes-base.webhook',
			typeVersion: 2,
			position: [0, 0],
			webhookId: path,
			parameters: { httpMethod: 'POST', path, responseMode: 'lastNode', options: {} },
		},
		{
			id: randomUUID(),
			name: 'Dutify',
			type: '@dutifyai/n8n-nodes-dutify.dutify',
			typeVersion: 1,
			position: [400, 0],
			parameters,
			credentials: { dutifyApi: { id: config.credentialId, name: 'Dutify account' } },
		},
	];
	const connections: IDataObject = withBinary
		? {
				Webhook: { main: [[{ node: 'Binary', type: 'main', index: 0 }]] },
				Binary: { main: [[{ node: 'Dutify', type: 'main', index: 0 }]] },
			}
		: { Webhook: { main: [[{ node: 'Dutify', type: 'main', index: 0 }]] } };
	if (withBinary) {
		nodes.push({
			id: randomUUID(),
			name: 'Binary',
			type: 'n8n-nodes-base.code',
			typeVersion: 2,
			position: [200, 0],
			parameters: { jsCode: BINARY_CODE },
		});
	}

	return {
		name: `live-engine ${String(parameters.resource)}.${String(parameters.operation)} ${path.slice(0, 8)}`,
		nodes,
		connections,
		settings: { saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' },
	};
}

/**
 * The error n8n recorded for the run, as a NodeApiError. n8n does not keep the Dutify error body,
 * so the body is rebuilt from what the user sees: the message, and the code the node puts in the
 * description ("Code: NOT_FOUND").
 */
function errorOf(recorded: IDataObject): NodeApiError {
	const message = String(recorded.message ?? 'n8n reported an error');
	const description = typeof recorded.description === 'string' ? recorded.description : undefined;
	const code = /Code: ([A-Z0-9_]+)/.exec(description ?? '')?.[1];
	const error = new NodeApiError(
		ENGINE_NODE,
		{ message, ...(code ? { errorCode: code } : {}) } as JsonObject,
		{
			message,
			description,
			httpCode: recorded.httpCode === undefined ? undefined : String(recorded.httpCode),
		},
	);
	for (const key of ['context', 'level', 'messages']) {
		if (recorded[key] !== undefined && recorded[key] !== null) {
			(error as unknown as IDataObject)[key] = recorded[key];
		}
	}

	return error;
}

async function executionOf(workflowId: string): Promise<IDataObject> {
	for (let attempt = 0; attempt < 40; attempt++) {
		const list = await api('GET', `/executions?workflowId=${workflowId}&includeData=true&limit=1`);
		const [execution] = (list.data ?? []) as IDataObject[];
		if (execution && execution.finished !== undefined && execution.status !== 'running') {
			return execution;
		}
		await pause(250);
	}
	throw new Error(`n8n kept no finished execution for workflow ${workflowId}`);
}

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

/** Calls the workflow's production webhook, waiting for n8n to register it after activation. */
async function callWebhook(path: string, binary?: EngineBinary): Promise<void> {
	const body = JSON.stringify(
		binary
			? {
					property: binary.property,
					data: binary.data.toString('base64'),
					mimeType: binary.mimeType,
					fileName: binary.fileName,
				}
			: {},
	);
	for (let attempt = 0; attempt < 40; attempt++) {
		const response = await fetch(`${config.url}/webhook/${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			signal: AbortSignal.timeout(300_000),
		});
		if (response.status !== 404) {
			return;
		}
		await pause(250);
	}
	throw new Error(`n8n never registered the webhook ${path}`);
}

/** Unpublishes and deletes a test workflow; n8n refuses the delete while unpublishing. */
async function removeWorkflow(id: string): Promise<void> {
	await api('POST', `/workflows/${id}/deactivate`).catch(() => undefined);
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			await api('DELETE', `/workflows/${id}`);

			return;
		} catch {
			await pause(250);
		}
	}
}

/** Runs one Dutify operation as a real n8n workflow and returns the Dutify node's output items. */
export async function runInEngine(
	parameters: IDataObject,
	binary?: EngineBinary,
): Promise<INodeExecutionData[]> {
	const path = randomUUID();
	const created = await api('POST', '/workflows', workflowOf(path, parameters, Boolean(binary)));
	const id = String(created.id);
	try {
		await api('POST', `/workflows/${id}/activate`);
		await callWebhook(path, binary);
		const execution = await executionOf(id);
		const resultData = ((execution.data as IDataObject)?.resultData ?? {}) as IDataObject;
		const runs = ((resultData.runData as IDataObject)?.Dutify ?? []) as IDataObject[];
		const run = runs[0];
		const recorded = (run?.error ?? resultData.error) as IDataObject | undefined;
		if (recorded) {
			throw errorOf(recorded);
		}
		if (!run) {
			throw new Error(`the Dutify node did not run (execution ${String(execution.id)})`);
		}
		const main = ((run.data as IDataObject).main ?? []) as INodeExecutionData[][];

		return main[0] ?? [];
	} finally {
		await removeWorkflow(id);
	}
}
