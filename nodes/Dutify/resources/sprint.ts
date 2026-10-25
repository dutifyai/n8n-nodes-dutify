import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import {
	collection,
	dateTime,
	EXPRESSION_HINT,
	idPicker,
	isSet,
	oneItem,
	requireChange,
	splitList,
	text,
	toInstant,
} from '../../../shared/fieldHelpers';
import { resolveTaskIds } from '../../../shared/taskRefs';
import { encodePath } from '../../../shared/transport';
import type { OperationDef, ParamReader, ResourceDef } from '../../../shared/types';

/* ---------- helpers ---------- */

/** Sprints belong to a space, and the pickers list a space's groups and sprints. */
const spaceField = (): INodeProperties =>
	idPicker('Space Name or ID', 'space', 'getSpaceIds', undefined);

const groupField = (): INodeProperties =>
	idPicker('Sprint Group Name or ID', 'group', 'getSprintGroups', undefined, ['space']);

const sprintField = (name = 'sprint', displayName = 'Sprint Name or ID'): INodeProperties =>
	idPicker(displayName, name, 'getSprints', undefined, ['space']);

/** The space picker followed by the sprint picker: the sprints listed come from the chosen space. */
const sprintFields = (): INodeProperties[] => [spaceField(), sprintField()];

const sprintPath = (p: ParamReader) => encodePath`/mp/api/v1/sprints/${p.get<string>('sprint')}`;
const groupsPath = (p: ParamReader) =>
	encodePath`/mp/api/v1/spaces/${p.get<string>('space')}/sprint-groups`;

const goalField = (): INodeProperties =>
	text('Goal', 'goal', 'What the sprint is meant to achieve (up to 5000 characters)');
const startDate = (): INodeProperties =>
	dateTime('Start Date', 'startDate', 'Planned start date. Without a time zone it is read as UTC');
const endDate = (): INodeProperties =>
	dateTime('End Date', 'endDate', 'Planned end date. Without a time zone it is read as UTC');

/** Copies the set date and text fields into a body; dates become ISO-8601 instants. */
function sprintBody(fields: IDataObject): IDataObject {
	const body: IDataObject = {};
	for (const key of ['name', 'goal'] as const) {
		if (isSet(fields[key])) {
			body[key] = fields[key];
		}
	}
	for (const key of ['startDate', 'endDate'] as const) {
		if (isSet(fields[key])) {
			body[key] = toInstant(fields[key]);
		}
	}

	return body;
}

const taskIdsField: INodeProperties = {
	displayName: 'Tasks',
	name: 'taskIds',
	type: 'string',
	default: '',
	required: true,
	description:
		'Comma-separated task keys such as PROJ-42, or task IDs (the Identifier field of a task). All tasks must belong to the same space as the sprint.',
};

const changeTasks = (
	operation: 'addTasks' | 'removeTasks',
	name: string,
	action: string,
	description: string,
	suffix: 'add' | 'remove',
): OperationDef => ({
	operation,
	name,
	action,
	description,
	fields: [...sprintFields(), taskIdsField],
	run: async (ctx, p) => {
		const refs = splitList(p.get<string>('taskIds'));
		if (refs.length === 0) {
			throw new ApplicationError('Enter at least one task key or ID');
		}
		const taskIdentifiers = await resolveTaskIds(
			async (spec) => await ctx.request(spec),
			refs,
			p.workspace,
		);

		return oneItem(
			await ctx.request({
				method: 'POST',
				path: `${sprintPath(p)}/tasks/${suffix}`,
				body: { taskIdentifiers },
			}),
		);
	},
});

/* ---------- operations ---------- */

const operations: OperationDef[] = [
	{
		operation: 'listGroups',
		name: 'List Sprint Groups',
		action: 'List the sprint groups of a space',
		description: 'List the sprint groups of a space, each with a summary of its sprints',
		fields: [spaceField()],
		build: (p) => ({ method: 'GET', path: groupsPath(p) }),
	},
	{
		operation: 'createGroup',
		name: 'Create Sprint Group',
		action: 'Create a sprint group',
		description:
			'Create a sprint group in a space. A group holds sprints, and only one of them can be in progress at a time',
		fields: [
			spaceField(),
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				description: 'Name of the sprint group (up to 100 characters)',
			},
			collection('Additional Fields', 'additionalFields', [
				text('Description', 'description', 'Description of the group (up to 2000 characters)'),
				{
					displayName: 'Default Duration (Days)',
					name: 'defaultDurationDays',
					type: 'number',
					typeOptions: { minValue: 1, maxValue: 90 },
					default: 14,
					description: 'Default sprint length in days, from 1 to 90',
				},
			]),
		],
		build: (p) => {
			const fields = p.get<IDataObject>('additionalFields', {});
			const body: IDataObject = { name: p.get<string>('name') };
			if (isSet(fields.description)) {
				body.description = fields.description;
			}
			if (isSet(fields.defaultDurationDays)) {
				body.defaultDurationDays = fields.defaultDurationDays;
			}

			return { method: 'POST', path: groupsPath(p), body };
		},
	},
	{
		operation: 'create',
		name: 'Create',
		action: 'Create a sprint',
		description: 'Create a sprint in a sprint group. New sprints start as not started',
		fields: [
			spaceField(),
			groupField(),
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				description: 'Name of the sprint (up to 200 characters)',
			},
			collection('Additional Fields', 'additionalFields', [goalField(), startDate(), endDate()]),
		],
		build: (p) => ({
			method: 'POST',
			path: encodePath`/mp/api/v1/sprint-groups/${p.get<string>('group')}/sprints`,
			body: sprintBody({
				name: p.get<string>('name'),
				...p.get<IDataObject>('additionalFields', {}),
			}),
		}),
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a sprint',
		description: 'Fetch a sprint with its task statistics',
		fields: sprintFields(),
		build: (p) => ({ method: 'GET', path: sprintPath(p) }),
	},
	{
		operation: 'update',
		name: 'Update',
		action: 'Update a sprint',
		description: 'Change the name, goal or planned dates of a sprint',
		fields: [
			...sprintFields(),
			collection('Update Fields', 'updateFields', [
				text('Name', 'name', 'New sprint name (up to 200 characters)'),
				goalField(),
				startDate(),
				endDate(),
			]),
		],
		build: (p) => ({
			method: 'PUT',
			path: sprintPath(p),
			body: requireChange(sprintBody(p.get<IDataObject>('updateFields', {}))),
		}),
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a sprint',
		description: 'Delete a sprint. Its tasks stay in their lists and lose the sprint',
		fields: sprintFields(),
		build: (p) => ({ method: 'DELETE', path: sprintPath(p) }),
	},
	{
		operation: 'start',
		name: 'Start',
		action: 'Start a sprint',
		description:
			'Move a sprint from not started to in progress. Only one sprint per group can be active',
		fields: sprintFields(),
		build: (p) => ({ method: 'POST', path: `${sprintPath(p)}/start` }),
	},
	{
		operation: 'complete',
		name: 'Complete',
		action: 'Complete a sprint',
		description: 'Move a sprint from in progress to done, optionally rolling unfinished tasks over',
		fields: [
			...sprintFields(),
			{
				...sprintField('rolloverSprint', 'Roll Over Unfinished Tasks to Name or ID'),
				required: false,
				description: `Sprint that receives the unfinished tasks. Leave empty to not roll anything over. ${EXPRESSION_HINT}`,
			},
		],
		build: (p) => {
			const rollover = p.get<string>('rolloverSprint', '');

			return {
				method: 'POST',
				path: `${sprintPath(p)}/complete`,
				body: isSet(rollover) ? { rolloverSprintIdentifier: rollover } : {},
			};
		},
	},
	changeTasks(
		'addTasks',
		'Add Tasks',
		'Add tasks to a sprint',
		'Put tasks into a sprint. A task can be in one sprint at a time',
		'add',
	),
	changeTasks(
		'removeTasks',
		'Remove Tasks',
		'Remove tasks from a sprint',
		'Take tasks out of a sprint. They stay in their lists',
		'remove',
	),
	{
		operation: 'getTasks',
		name: 'Get Tasks',
		action: 'Get the tasks of a sprint',
		description: 'List every task in a sprint',
		fields: sprintFields(),
		build: (p) => ({ method: 'GET', path: `${sprintPath(p)}/tasks` }),
	},
	{
		operation: 'getBurndown',
		name: 'Get Burndown',
		action: 'Get the burndown data of a sprint',
		description: 'Daily snapshots of remaining and completed work, for burndown and burnup charts',
		fields: sprintFields(),
		build: (p) => ({ method: 'GET', path: `${sprintPath(p)}/burndown` }),
	},
];

/** Sprints and sprint groups (PM "Sprints" and "Sprint Groups"). */
export const sprint: ResourceDef = {
	value: 'sprint',
	name: 'Sprint',
	workspaceScoped: true,
	operations,
};
