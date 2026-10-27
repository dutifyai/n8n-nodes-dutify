import { ApplicationError } from 'n8n-workflow';
import type { INodeProperties } from 'n8n-workflow';
import { dateTime, idPicker, isSet, toInstant } from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import type { OperationDef, ParamReader, ResourceDef } from '../../../shared/types';

/*
 * Your calendar events and their custom prompts. Contract:
 * https://dutify.ai/api/v1/api-catalog/Calendar (Hub proxies calendar-events-api).
 *
 * - Actor-scoped: the calendar of the user who owns the key. Scopes: calendar:read (list),
 *   recordings:write (prompts).
 * - A recurring occurrence can carry a series prompt and its own occurrence prompt; both are
 *   applied (with the workspace prompt), neither overrides the other. A prompt reaches the AI the
 *   next time the meeting is processed.
 */

const EVENTS = '/api/v1/calendar/events';

const PICKER_WINDOW =
	' Events from the last 7 days to the next 60 days are listed; for another one, set an expression with its ID.';

const eventField = (): INodeProperties => {
	const field = idPicker('Event Name or ID', 'event', 'getCalendarEvents', undefined);

	return { ...field, description: field.description + PICKER_WINDOW };
};

const seriesField = (): INodeProperties => {
	const field = idPicker('Series Name or ID', 'series', 'getCalendarSeries', undefined);

	return {
		...field,
		description:
			field.description +
			' Recurring series with an occurrence in the last 7 days or the next 60 days are listed; for another one, set an expression with its series master ID.',
	};
};

const promptField = (what: string): INodeProperties => ({
	displayName: 'Custom Prompt',
	name: 'customPrompt',
	type: 'string',
	typeOptions: { rows: 4 },
	default: '',
	required: true,
	description: `Instructions for the AI when it analyses ${what}. It replaces the current prompt of ${what}.`,
});

/** The prompt to send; an empty one is refused so that a clear is always deliberate. */
function promptOf(p: ParamReader, clearOperation: string): string {
	const prompt = p.get<string>('customPrompt', '');
	if (prompt.trim() === '') {
		throw new ApplicationError(
			`Custom Prompt is empty. To remove the prompt, use ${clearOperation}.`,
		);
	}

	return prompt;
}

const eventPromptPath = (p: ParamReader) =>
	encodePath`/api/v1/calendar/events/${p.get<string>('event')}/custom-prompt`;

const seriesPromptPath = (p: ParamReader) =>
	encodePath`/api/v1/calendar/series/${p.get<string>('series')}/custom-prompt`;

const operations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many calendar events',
		description:
			'List your calendar events in a date range, each with its event ID, series master ID, subject, start and end, whether a recording bot is subscribed, and any event or series prompt',
		list: true,
		fields: [
			{ ...dateTime('Start', 'startDate', 'Beginning of the range'), required: true },
			{ ...dateTime('End', 'endDate', 'End of the range'), required: true },
		],
		build: (p) => {
			const start = p.get<string>('startDate', '');
			const end = p.get<string>('endDate', '');
			if (!isSet(start) || !isSet(end)) {
				throw new ApplicationError('Set both Start and End');
			}

			return {
				method: 'GET',
				path: EVENTS,
				qs: { startDate: toInstant(start), endDate: toInstant(end) },
			};
		},
	},
	{
		operation: 'setCustomPrompt',
		name: 'Set Custom Prompt',
		action: 'Set the custom prompt of a calendar event',
		description:
			'Set the prompt of one meeting (one occurrence). For a recurring meeting it is applied together with the series prompt',
		fields: [eventField(), promptField('this meeting')],
		build: (p) => ({
			method: 'PUT',
			path: eventPromptPath(p),
			body: { customPrompt: promptOf(p, 'Clear Custom Prompt') },
		}),
	},
	{
		operation: 'clearCustomPrompt',
		name: 'Clear Custom Prompt',
		action: 'Clear the custom prompt of a calendar event',
		description: "Remove one meeting's own prompt. A series prompt, if any, keeps applying to it",
		fields: [eventField()],
		build: (p) => ({ method: 'DELETE', path: eventPromptPath(p) }),
	},
	{
		operation: 'setSeriesCustomPrompt',
		name: 'Set Series Custom Prompt',
		action: 'Set the custom prompt of a recurring series',
		description:
			'Set the prompt of every meeting in a recurring series, applied together with any prompt of a single occurrence',
		fields: [seriesField(), promptField('every meeting of this series')],
		build: (p) => ({
			method: 'PUT',
			path: seriesPromptPath(p),
			body: { customPrompt: promptOf(p, 'Clear Series Custom Prompt') },
		}),
	},
	{
		operation: 'clearSeriesCustomPrompt',
		name: 'Clear Series Custom Prompt',
		action: 'Clear the custom prompt of a recurring series',
		description:
			"Remove a series' prompt. Each occurrence keeps only its own prompt, if it has one",
		fields: [seriesField()],
		build: (p) => ({ method: 'DELETE', path: seriesPromptPath(p) }),
	},
];

/** Your calendar meetings (Hub "Calendar") and the custom prompts that shape their notes. */
export const calendarEvent: ResourceDef = {
	value: 'calendarEvent',
	name: 'Calendar Event',
	workspaceScoped: true,
	operations,
};
