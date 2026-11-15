import type { INodeProperties } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { buildProperties, resources } from '../../nodes/Dutify/registry';

// n8n's review rule: an optional parameter belongs in an Additional Fields, Options, Filters or
// Update Fields collection, never at the top level of an operation. A top-level field shown only
// for some values of another field is required whenever it is shown.
const CONTAINERS = new Set(['collection', 'fixedCollection', 'notice']);
// n8n's own list pattern: Return All and Limit stay at the top level of a Get Many operation.
const PAGING = new Set(['returnAll', 'limit']);
// A mode switch always holds one of its values, so it has nothing to leave out.
const isModeSwitch = (p: INodeProperties) =>
	p.type === 'options' && !p.typeOptions?.loadOptionsMethod && p.default !== '';

// Top-level on purpose, each with its reason. Anything else optional goes into a collection.
const INTENDED = new Set([
	// Only narrows the request picker below it.
	...['comment', 'delete', 'get', 'moderate', 'setAssignee', 'setStatus', 'setVisibility', 'toggleAffected'].map(
		(op) => `board on bug > ${op}`,
	),
	...['comment', 'delete', 'get', 'moderate', 'setStatus', 'vote'].map((op) => `board on featureRequest > ${op}`),
	'space on task > create', // only narrows the list picker
	'list on task > create', // the task's place; a subtask takes its parent's list instead
	// Leaving both empty is what unassigns, so the pair is the operation's input.
	'assigneeEmail on bug > setAssignee',
	'assigneeId on bug > setAssignee',
	'taskType on task > bulkChangeType', // empty clears the type
	'query on call > search', // empty matches every call
	'query on call > countSearch',
	// Whether the operation returns the URL or the file itself.
	'download on recording > getAudioUrl',
	'download on recording > getMediaUrl',
	'download on recording > getPreviewUrl',
	'deliveries on meetingWebhook > listDeliveries', // a count with its default
]);

const where = (p: INodeProperties) =>
	`${p.name} on ${String(p.displayOptions?.show?.resource)} > ${String(p.displayOptions?.show?.operation)}`;

describe('top-level operation parameters', () => {
	const fields = buildProperties(resources).filter(
		(p) =>
			p.displayOptions?.show?.operation &&
			!CONTAINERS.has(p.type) &&
			!PAGING.has(p.name) &&
			!isModeSwitch(p),
	);

	it('finds the operation fields', () => {
		expect(fields.length).toBeGreaterThan(50);
	});

	it('are all required: optional ones live in a collection', () => {
		expect(fields.filter((p) => p.required !== true).map(where).filter((w) => !INTENDED.has(w))).toEqual([]);
	});
});

describe('fields n8n asked to move into a collection', () => {
	const props = buildProperties(resources);
	const nested = (resource: string, operation: string, collection: string) => {
		const c = props.find(
			(p) =>
				p.name === collection &&
				(p.displayOptions?.show?.resource as string[] | undefined)?.includes(resource) &&
				(p.displayOptions?.show?.operation as string[] | undefined)?.includes(operation),
		);

		return ((c?.options ?? []) as INodeProperties[]).map((o) => o.name);
	};

	it.each([
		['task', 'create', 'additionalFields', 'status'],
		['codexumPage', 'list', 'options', 'parent'],
		['codexumPage', 'create', 'additionalFields', 'markdown'],
		['codexumPage', 'create', 'additionalFields', 'parent'],
		['codexumPage', 'move', 'options', 'newParent'],
		['codexumPage', 'move', 'options', 'afterPage'],
		['codexumPage', 'delete', 'options', 'permanent'],
		['sprint', 'complete', 'options', 'rolloverSprint'],
		['automation', 'list', 'options', 'includeDescendants'],
		['recording', 'regenerateSummary', 'options', 'saveToDb'],
		['meetingWebhook', 'create', 'additionalFields', 'secret'],
		['meetingWebhook', 'create', 'additionalFields', 'sections'],
	])('%s > %s keeps %s.%s', (resource, operation, collection, field) => {
		expect(nested(resource, operation, collection)).toContain(field);
	});

	it('Scope Name is required wherever it is shown', () => {
		const scopeName = props.find((p) => p.name === 'scopeName' && p.displayOptions?.show?.resource?.includes('customField'));
		expect(scopeName?.required).toBe(true);
		expect(scopeName?.displayOptions?.show?.scope).toEqual(['space', 'list']);
	});
});
