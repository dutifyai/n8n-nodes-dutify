import type { INodePropertyOptions } from 'n8n-workflow';

/**
 * The PM event types a webhook subscription can receive, as the subscription API spells them.
 *
 * Source: `ai.dutify.enumerable.EventAddress` on PM origin/master, narrowed to the events the
 * delivery pipeline maps in `WebhookAccessFilter`. That leaves out the internal broker signals
 * (websocket-notification, email-notification, storage-files-cleanup, ...).
 *
 * Wiki (`wiki.*`) and feature-request (`feedback.*`) events are delivered too, since PM became
 * the webhook hub of the suite. They are not listed here: the Dutify Trigger loads them from
 * `GET /mp/api/v1/workspaces/{ws}/webhooks/event-types`, filtered by product (`codexum`,
 * `roadmarq`). That endpoint lists the PM events as well, but this static list stays the PM
 * source of the trigger and of the webhook resource, so saved workflows keep their options.
 *
 * The Dutify Trigger node reuses this list, so a new PM event is added here once.
 */
export const PM_EVENT_TYPES: string[] = [
	// Tasks
	'task-created',
	'task-deleted',
	'task-status-changed',
	'task-priority-changed',
	'task-title-changed',
	'task-assignee-added',
	'task-assignee-removed',
	'task-watcher-removed',
	'task-start-date-updated',
	'task-due-date-updated',
	'task-estimated-time-updated',
	'task-time-spent-updated',
	'task-added-to-list',
	'task-removed-from-list',
	'task-moved-to-parent-task',
	'task-removed-from-parent-task',
	'task-moved-to-closed-status',
	'task-moved-from-closed-status',
	'descendants-moved-to-list',
	'task-key-usage-changed',
	'sharing-configuration-changed',
	'automation-executed',
	'form-submitted',
	// Comments, reactions and attachments
	'comment-added',
	'comment-updated',
	'comment-deleted',
	'reaction-added',
	'reaction-deleted',
	'attachment-added',
	'attachment-deleted',
	// Custom fields
	'custom-field-created',
	'custom-field-updated',
	'custom-field-deleted',
	'custom-field-default-value-changed',
	'custom-field-option-deleted',
	'custom-field-formula-configuration-changed',
	'custom-field-value-updated',
	'rollup-selection-changed',
	// Statuses and priorities
	'status-created',
	'status-deleted',
	'priority-created',
	'priority-deleted',
	'status-inheritance-changed',
	'priority-inheritance-changed',
	// Spaces, folders and lists
	'space-deleted',
	'folder-deleted',
	'task-list-deleted',
	'task-list-moved',
	// Workspace, members, invitations and teams (only delivered to workspace-wide webhooks)
	'workspace-ownership-transferred',
	'workspace-user-role-changed',
	'workspace-user-removed',
	'workspace-user-left',
	'workspace-deleted',
	'workspace-cleanup-requested',
	'invitation-sent',
	'invitation-accepted',
	'invitation-declined',
	'invitation-cancelled',
	'team-membership-changed',
	'team-deleted',
];

/** `task-moved-to-parent-task` -> `Task Moved to Parent Task`. */
export function pmEventLabel(eventType: string): string {
	return eventType
		.split('-')
		.map((word, index) =>
			index > 0 && ['to', 'from', 'of', 'in'].includes(word)
				? word
				: word.charAt(0).toUpperCase() + word.slice(1),
		)
		.join(' ');
}

/** The event types as n8n options, labelled for people and valued with the API name. */
export const PM_EVENT_OPTIONS: INodePropertyOptions[] = PM_EVENT_TYPES.map((value) => ({
	name: pmEventLabel(value),
	value,
}));
