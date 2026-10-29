import type { IDataObject, INodeProperties } from 'n8n-workflow';
import {
	collection,
	EXPRESSION_HINT,
	idPicker,
	isSet,
	oneItem,
	requireChange,
	splitList,
	text,
} from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import type { OperationDef, ParamReader, ResourceDef } from '../../../shared/types';

/* ---------- shared ---------- */

/** The page list endpoint returns at most 500 items and has no paging. */
const PAGE_LIST_MAX = 500;

export const spaceField = (): INodeProperties =>
	idPicker('Space Name or ID', 'space', 'getWikiSpaces', undefined);

/** Pages are addressed by slug; the picker lists the pages of the chosen space. */
const pageField = (): INodeProperties =>
	idPicker('Page Name or ID', 'page', 'getWikiPages', undefined, ['space']);

/** An optional page picker with a blank "top level" choice. */
const optionalPageField = (displayName: string, name: string, description: string) => ({
	displayName,
	name,
	type: 'options' as const,
	typeOptions: { loadOptionsMethod: 'getWikiParentPages', loadOptionsDependsOn: ['space'] },
	default: '',
	description: `${description}. ${EXPRESSION_HINT}.`,
});

const optionalSpaceField = (displayName: string, name: string, description: string) => ({
	displayName,
	name,
	type: 'options' as const,
	typeOptions: { loadOptionsMethod: 'getWikiSpaces' },
	default: '',
	description: `${description}. ${EXPRESSION_HINT}.`,
});

const bool = (displayName: string, name: string, description: string): INodeProperties => ({
	displayName,
	name,
	type: 'boolean',
	default: false,
	description,
});

/** `/api/wiki/v1/workspaces/{workspace}/wiki` */
const wikiBase = (p: ParamReader) => encodePath`/api/wiki/v1/workspaces/${p.workspace}/wiki`;

const spaceKey = (p: ParamReader) => p.get<string>('space');
const pagesBase = (p: ParamReader) =>
	`${wikiBase(p)}/spaces/${encodeURIComponent(spaceKey(p))}/pages`;
const litePages = (p: ParamReader) => `${pagesBase(p)}/lite`;
const litePage = (p: ParamReader) => `${litePages(p)}/${encodeURIComponent(p.get<string>('page'))}`;
const sharePath = (p: ParamReader) =>
	`${pagesBase(p)}/${encodeURIComponent(p.get<string>('page'))}/share`;
const spacesBase = (p: ParamReader) => `${wikiBase(p)}/spaces`;
const spacePath = (p: ParamReader) => `${spacesBase(p)}/${encodeURIComponent(spaceKey(p))}`;

/** Copies the listed keys that are set (a `false` counts as set). */
function pick(fields: IDataObject, keys: readonly string[]): IDataObject {
	const body: IDataObject = {};
	for (const key of keys) {
		if (isSet(fields[key])) {
			body[key] = fields[key];
		}
	}

	return body;
}

/* ---------- page fields ---------- */

const PAGE_TYPES = [
	{ name: 'Page', value: 'page' },
	{ name: 'Folder', value: 'folder' },
];

const markdownField = (
	name: string,
	displayName: string,
	description: string,
): INodeProperties => ({
	displayName,
	name,
	type: 'string',
	typeOptions: { rows: 8 },
	default: '',
	description,
});

const visibilityFields = (): INodeProperties[] => [
	bool(
		'Visible to Everyone in the Workspace',
		'isPublic',
		'Whether the page is visible to every workspace member. Leave unset to inherit from the space.',
	),
	bool(
		'Editable by Everyone in the Workspace',
		'isEditPublic',
		'Whether every workspace member can edit the page. Leave unset to inherit from the space.',
	),
	text('Icon', 'icon', 'An emoji name, or an icon name with the "icon:" prefix'),
	text('Icon Color', 'iconColor', 'Icon color as a hex code. It only applies to icons, not emojis'),
];

const PAGE_VISIBILITY_KEYS = ['isPublic', 'isEditPublic', 'icon', 'iconColor'] as const;
const PAGE_COVER_KEYS = [
	'coverImageType',
	'coverUrl',
	'coverUnsplashId',
	'coverAttachment',
	'coverPositionY',
	'coverHeight',
	'coverAsDefault',
] as const;

const coverFields = (): INodeProperties[] => [
	{
		displayName: 'Cover Image Type',
		name: 'coverImageType',
		type: 'options',
		default: 'url',
		options: [
			{ name: 'Attachment', value: 'attachment' },
			{ name: 'Unsplash', value: 'unsplash' },
			{ name: 'URL', value: 'url' },
		],
		description: 'Where the cover image comes from',
	},
	text('Cover URL', 'coverUrl', 'Cover image URL, for the URL type'),
	text('Cover Unsplash ID', 'coverUnsplashId', 'Unsplash photo ID, for the Unsplash type'),
	text(
		'Cover Attachment',
		'coverAttachment',
		'File name of an attachment already uploaded to this page, for the Attachment type',
	),
	{
		displayName: 'Cover Position Y',
		name: 'coverPositionY',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 0, maxValue: 100 },
		description: 'Vertical position of the cover crop, 0 to 100',
	},
	{
		displayName: 'Cover Height',
		name: 'coverHeight',
		type: 'options',
		default: 'medium',
		options: [
			{ name: 'Small', value: 'small' },
			{ name: 'Medium', value: 'medium' },
			{ name: 'Large', value: 'large' },
		],
		description: 'Height of the cover',
	},
	bool(
		'Cover as Default',
		'coverAsDefault',
		"Whether a folder's cover applies as the default to its child pages",
	),
];

/* ---------- page operations ---------- */

const searchFields = (): INodeProperties[] => [
	optionalSpaceField('Space Name or ID', 'spaceKey', 'Limit the search to one space'),
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		description: 'Max number of results to return',
	},
];

const queryField = (description: string): INodeProperties => ({
	displayName: 'Query',
	name: 'query',
	type: 'string',
	default: '',
	required: true,
	description,
});

const pageOperations: OperationDef[] = [
	{
		operation: 'search',
		name: 'Search',
		action: 'Search wiki pages',
		description: 'Search the wiki, by default with keyword and semantic ranking combined',
		fields: [
			queryField('Text to search for'),
			collection('Options', 'options', [
				...searchFields(),
				{
					displayName: 'Mode',
					name: 'mode',
					type: 'options',
					default: 'hybrid',
					options: [
						{ name: 'Hybrid', value: 'hybrid' },
						{ name: 'Keyword', value: 'keyword' },
						{ name: 'Semantic', value: 'semantic' },
					],
					description: 'How results are ranked',
				},
			]),
		],
		build: (p) => ({
			method: 'GET',
			path: `${wikiBase(p)}/search/lite`,
			qs: {
				q: p.get<string>('query'),
				...pick(p.get<IDataObject>('options', {}), ['spaceKey', 'mode', 'limit']),
			},
		}),
	},
	{
		operation: 'retrieve',
		name: 'Retrieve Passages',
		action: 'Retrieve citable passages from the wiki',
		description:
			'Semantic retrieval for question answering: the best-matching passages with page, space and score',
		fields: [
			queryField('A natural-language question or topic'),
			collection('Options', 'options', searchFields()),
		],
		build: (p) => ({
			method: 'POST',
			path: `${wikiBase(p)}/search/retrieve/lite`,
			body: {
				query: p.get<string>('query'),
				...pick(p.get<IDataObject>('options', {}), ['spaceKey', 'limit']),
			},
		}),
	},
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many pages of a space',
		description: 'List the pages of a space (titles and slugs, no body), one level at a time',
		list: true,
		fields: [
			spaceField(),
			optionalPageField(
				'Parent Page Name or ID',
				'parent',
				'List the children of this page. Leave at top level to list the root pages',
			),
		],
		build: (p) => ({
			method: 'GET',
			path: litePages(p),
			qs: { limit: PAGE_LIST_MAX, ...pick({ parent: p.get<string>('parent', '') }, ['parent']) },
		}),
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a page',
		description: 'Get a page with its body as Markdown',
		fields: [spaceField(), pageField()],
		run: async (ctx, p) => {
			const response = (await ctx.request({
				method: 'GET',
				path: litePage(p),
				qs: { format: 'markdown' },
			})) as IDataObject | null;
			if (response && typeof response === 'object') {
				// A page with no body has no content (null); hand back an empty Markdown string.
				response.markdown = response.markdown ?? '';
			}

			return oneItem(response);
		},
	},
	{
		operation: 'create',
		name: 'Create',
		action: 'Create a page',
		description: 'Create a page or folder from a title and a Markdown body',
		fields: [
			spaceField(),
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				required: true,
				description: 'Title of the page',
			},
			markdownField(
				'markdown',
				'Markdown Body',
				'Page body as Markdown. Leave empty for a blank page',
			),
			optionalPageField('Parent Page Name or ID', 'parent', 'Create the page under this page'),
			collection('Additional Fields', 'additionalFields', [
				{
					displayName: 'Type',
					name: 'type',
					type: 'options',
					default: 'page',
					options: PAGE_TYPES,
					description: 'Whether to create a page or a folder',
				},
				text('Template', 'template', 'Name of a page template (case-sensitive) to start from'),
				...visibilityFields(),
			]),
		],
		build: (p) => ({
			method: 'POST',
			path: litePages(p),
			body: {
				title: p.get<string>('title'),
				...pick({ parent: p.get<string>('parent', ''), markdown: p.get<string>('markdown', '') }, [
					'parent',
					'markdown',
				]),
				...pick(p.get<IDataObject>('additionalFields', {}), [
					'type',
					'template',
					...PAGE_VISIBILITY_KEYS,
				]),
			},
		}),
	},
	{
		operation: 'update',
		name: 'Update',
		action: 'Update a page',
		description: 'Change the title, Markdown body, visibility, icon or cover of a page',
		fields: [
			spaceField(),
			pageField(),
			collection('Update Fields', 'updateFields', [
				text('Title', 'title', 'New title of the page'),
				markdownField(
					'markdown',
					'Markdown Body',
					'New page body as Markdown. It replaces the whole body',
				),
				...visibilityFields(),
				...coverFields(),
			]),
		],
		build: (p) => ({
			method: 'PUT',
			path: litePage(p),
			body: requireChange(
				pick(p.get<IDataObject>('updateFields', {}), [
					'title',
					'markdown',
					...PAGE_VISIBILITY_KEYS,
					...PAGE_COVER_KEYS,
				]),
			),
		}),
	},
	{
		operation: 'move',
		name: 'Move',
		action: 'Move a page',
		description: 'Move a page under another page, to the top level, or into another space',
		fields: [
			spaceField(),
			pageField(),
			optionalPageField(
				'New Parent Page Name or ID',
				'newParent',
				'Move the page under this page. Leave at top level to move it to the root',
			),
			optionalPageField(
				'Insert After Page Name or ID',
				'afterPage',
				'Sibling to insert the page after. Leave at top level to make it the first child',
			),
			collection('Options', 'options', [
				optionalSpaceField(
					'Target Space Name or ID',
					'targetSpaceKey',
					'Move the page into another space. The parent and sibling are then looked up in that space, so set them with an expression',
				),
			]),
		],
		build: (p) => ({
			method: 'POST',
			path: `${litePage(p)}/move`,
			body: {
				...pick(
					{ newParent: p.get<string>('newParent', ''), afterPage: p.get<string>('afterPage', '') },
					['newParent', 'afterPage'],
				),
				...pick(p.get<IDataObject>('options', {}), ['targetSpaceKey']),
			},
		}),
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a page',
		description: 'Archive a page with everything below it, or delete it permanently',
		fields: [
			spaceField(),
			pageField(),
			bool(
				'Permanent',
				'permanent',
				'Whether to delete the page permanently instead of archiving it. Needs admin access',
			),
		],
		build: (p) => ({
			method: 'DELETE',
			path: `${pagesBase(p)}/${encodeURIComponent(p.get<string>('page'))}`,
			qs: { permanent: p.get<boolean>('permanent', false) },
		}),
	},
	{
		operation: 'getShare',
		name: 'Get Share Link',
		action: 'Get the public share link of a page',
		description: 'Get whether a page is shared publicly, and its public URL',
		fields: [spaceField(), pageField()],
		build: (p) => ({ method: 'GET', path: sharePath(p) }),
	},
	{
		operation: 'enableShare',
		name: 'Enable Share Link',
		action: 'Share a page publicly',
		description: 'Create a public link to a page',
		fields: [
			spaceField(),
			pageField(),
			collection('Options', 'options', [
				text(
					'Custom Token',
					'token',
					'Custom ending of the public URL: 3 to 100 lowercase letters, numbers and hyphens. Generated when empty',
				),
				bool(
					'Show Author',
					'showAuthor',
					"Whether the page creator's name is shown on the public page",
				),
			]),
		],
		build: (p) => ({
			method: 'POST',
			path: sharePath(p),
			body: pick(p.get<IDataObject>('options', {}), ['token', 'showAuthor']),
		}),
	},
	{
		operation: 'disableShare',
		name: 'Disable Share Link',
		action: 'Stop sharing a page publicly',
		description: 'Revoke the public link to a page',
		fields: [spaceField(), pageField()],
		build: (p) => ({ method: 'DELETE', path: sharePath(p) }),
	},
];

/** Codexum (wiki) pages. */
export const codexumPage: ResourceDef = {
	value: 'codexumPage',
	name: 'Codexum Page',
	workspaceScoped: true,
	operations: pageOperations,
};

/* ---------- space operations ---------- */

const SPACE_OPTION_KEYS = [
	'description',
	'isPublic',
	'isEditPublic',
	'icon',
	'iconColor',
	'projectId',
];

const spaceOptionFields = (): INodeProperties[] => [
	text('Description', 'description', 'Description of the space'),
	bool(
		'Visible to Everyone in the Workspace',
		'isPublic',
		'Whether every workspace member can see the space',
	),
	bool(
		'Editable by Everyone in the Workspace',
		'isEditPublic',
		'Whether every workspace member can edit the space. It needs the space to be visible to everyone',
	),
	text('Icon', 'icon', 'An emoji name, or an icon name with the "icon:" prefix'),
	text('Icon Color', 'iconColor', 'Icon color as a hex code. It only applies to icons, not emojis'),
	{
		displayName: 'Project ID',
		name: 'projectId',
		type: 'number',
		default: 0,
		description: 'ID of a Dutify Cloud project to link the space to',
	},
];

const PUBLIC_SETTING_BOOLEANS = [
	'isEnabled',
	'showReactions',
	'showPageViews',
	'showLastUpdated',
	'showAuthor',
] as const;

const publicSettingsFields = (): INodeProperties[] => [
	bool('Public Wiki Enabled', 'isEnabled', 'Whether the public wiki of the space is on'),
	bool('Show Reactions', 'showReactions', 'Whether to show reactions on public pages'),
	bool('Show Page Views', 'showPageViews', 'Whether to show view counts on public pages'),
	bool(
		'Show Last Updated',
		'showLastUpdated',
		'Whether to show the last updated date on public pages',
	),
	bool('Show Author', 'showAuthor', 'Whether to show the author name on public pages'),
	text(
		'Custom Slug',
		'customSlug',
		'Custom URL slug of the public wiki (3 to 60 lowercase letters, numbers and hyphens). Set it empty to remove the slug',
	),
	{
		displayName: 'View Mode',
		name: 'viewMode',
		type: 'options',
		default: 'space',
		options: [
			{ name: 'Help Center', value: 'helpcenter' },
			{ name: 'Space', value: 'space' },
		],
		description: 'How the public wiki is laid out',
	},
	text('Hero Title', 'heroTitle', 'Help center hero title (up to 150 characters). Empty resets it'),
	text(
		'Hero Subtitle',
		'heroSubtitle',
		'Help center hero subtitle (up to 250 characters). Empty resets it',
	),
	text(
		'Allowed Emojis',
		'allowedEmojis',
		'Comma-separated emojis people can react with. Leave unset to keep the current list',
	),
];

const spaceOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many spaces',
		description: 'List the wiki spaces you can see in the workspace',
		list: true,
		fields: [],
		build: (p) => ({ method: 'GET', path: spacesBase(p) }),
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a space',
		description: 'Get a wiki space',
		fields: [spaceField()],
		build: (p) => ({ method: 'GET', path: spacePath(p) }),
	},
	{
		operation: 'getWithPages',
		name: 'Get With Pages',
		action: 'Get a space with its page tree',
		description: 'Get a wiki space together with its full page tree',
		fields: [spaceField()],
		build: (p) => ({ method: 'GET', path: `${spacePath(p)}/full` }),
	},
	{
		operation: 'create',
		name: 'Create',
		action: 'Create a space',
		description: 'Create a wiki space',
		fields: [
			{
				displayName: 'Key',
				name: 'key',
				type: 'string',
				default: '',
				required: true,
				description:
					'Short unique key of the space: 2 to 20 uppercase letters and numbers, starting with a letter, such as DOCS',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				description: 'Display name of the space',
			},
			collection('Additional Fields', 'additionalFields', spaceOptionFields()),
		],
		build: (p) => ({
			method: 'POST',
			path: spacesBase(p),
			body: {
				key: p.get<string>('key'),
				name: p.get<string>('name'),
				...pick(p.get<IDataObject>('additionalFields', {}), SPACE_OPTION_KEYS),
			},
		}),
	},
	{
		operation: 'update',
		name: 'Update',
		action: 'Update a space',
		description: 'Change the name, description, visibility or icon of a space',
		fields: [
			spaceField(),
			collection('Update Fields', 'updateFields', [
				text('Name', 'name', 'New display name of the space'),
				...spaceOptionFields(),
			]),
		],
		build: (p) => ({
			method: 'PUT',
			path: spacePath(p),
			body: requireChange(
				pick(p.get<IDataObject>('updateFields', {}), ['name', ...SPACE_OPTION_KEYS]),
			),
		}),
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a space',
		description:
			'Permanently delete a wiki space and all its pages. Needs admin access to the space',
		fields: [spaceField()],
		build: (p) => ({ method: 'DELETE', path: spacePath(p) }),
	},
	{
		operation: 'getPublicSettings',
		name: 'Get Public Wiki Settings',
		action: 'Get the public wiki settings of a space',
		description: 'Get whether the space is published as a public wiki, and how',
		fields: [spaceField()],
		build: (p) => ({ method: 'GET', path: `${spacePath(p)}/public-settings` }),
	},
	{
		operation: 'checkPublicSlug',
		name: 'Check Public Slug',
		action: 'Check a public wiki slug',
		description: 'Check whether a custom slug is valid and still free',
		fields: [
			spaceField(),
			{
				displayName: 'Slug',
				name: 'slug',
				type: 'string',
				default: '',
				required: true,
				description: 'The custom slug to check',
			},
		],
		build: (p) => ({
			method: 'GET',
			path: `${spacePath(p)}/public-settings/check-slug`,
			qs: { slug: p.get<string>('slug') },
		}),
	},
	{
		operation: 'setPublicSettings',
		name: 'Set Public Wiki Settings',
		action: 'Change the public wiki settings of a space',
		description: 'Change the public wiki settings. Settings you leave out keep their current value',
		fields: [spaceField(), collection('Settings', 'settings', publicSettingsFields())],
		// The endpoint replaces the booleans, the slug and the emoji list with whatever is sent,
		// so the current settings are read first and written back with the changes applied.
		run: async (ctx, p) => {
			const changes = p.get<IDataObject>('settings', {});
			const body: IDataObject = {};
			for (const key of PUBLIC_SETTING_BOOLEANS) {
				if (typeof changes[key] === 'boolean') {
					body[key] = changes[key];
				}
			}
			if (isSet(changes.viewMode)) {
				body.viewMode = changes.viewMode;
			}
			for (const key of ['customSlug', 'heroTitle', 'heroSubtitle'] as const) {
				if (typeof changes[key] === 'string') {
					body[key] = changes[key];
				}
			}
			if (isSet(changes.allowedEmojis)) {
				body.allowedEmojis = splitList(changes.allowedEmojis);
			}
			requireChange(body);

			const path = `${spacePath(p)}/public-settings`;
			const current = ((await ctx.request({ method: 'GET', path })) ?? {}) as IDataObject;

			return oneItem(await ctx.request({ method: 'PUT', path, body: { ...current, ...body } }));
		},
	},
];

/** Codexum (wiki) spaces and their public wiki settings. */
export const codexumSpace: ResourceDef = {
	value: 'codexumSpace',
	name: 'Codexum Space',
	workspaceScoped: true,
	operations: spaceOperations,
};
