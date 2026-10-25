import { ApplicationError } from 'n8n-workflow';
import type { IDataObject } from 'n8n-workflow';
import { encodePath } from './transport';

interface TaskRow {
	identifier?: string;
}

export const TASK_ID_PREFIX = 'tsk_';

type TaskLookup = (spec: { method: 'GET'; path: string; qs: IDataObject }) => Promise<unknown>;

/** Some endpoints take task IDs only. A task key such as PROJ-42 is looked up first. */
export async function resolveTaskId(
	request: TaskLookup,
	ref: string,
	workspace: string,
): Promise<string> {
	if (ref.startsWith(TASK_ID_PREFIX)) {
		return ref;
	}
	const found = (await request({
		method: 'GET',
		path: encodePath`/mp/api/v1/tasks/lite/${ref}`,
		qs: { workspace },
	})) as TaskRow | null;
	if (!found?.identifier) {
		throw new ApplicationError(`Could not find the ID of task "${ref}"`);
	}

	return found.identifier;
}

export async function resolveTaskIds(
	request: TaskLookup,
	refs: string[],
	workspace: string,
): Promise<string[]> {
	const ids: string[] = [];
	for (const ref of refs) {
		ids.push(await resolveTaskId(request, ref, workspace));
	}

	return ids;
}
