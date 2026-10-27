import type {
	IBinaryData,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

/** One HTTP call to Dutify, independent of n8n. Operations build these; the transport sends them. */
export interface RequestSpec {
	method: IHttpRequestMethods;
	/** Catalog path with path params already substituted and encoded (use `encodePath`). */
	path: string;
	/** Query string. `undefined`, `null` and `''` values are dropped before sending. */
	qs?: IDataObject;
	/**
	 * JSON body, or a string sent verbatim (Hub endpoints that bind a bare `@RequestBody String`).
	 * An empty string is sent as an empty body.
	 */
	body?: IDataObject | IDataObject[] | string;
	/** Content-Type of a string body, e.g. `text/plain`. */
	contentType?: string;
	/** Request timeout in milliseconds, for slow endpoints such as Lens. Omitted: the HTTP client default. */
	timeout?: number;
	/** Present only on list operations. */
	paginate?: PaginationStyle;
}

export type PaginationStyle =
	| {
			kind: 'cursor';
			cursorParam: string;
			limitParam: string;
			itemsPath: string;
			nextCursorPath: string;
			maxPageSize: number;
	  }
	| {
			kind: 'page';
			pageParam: string;
			sizeParam: string;
			/** Dotted path to the items array; omitted when the response itself is the array. */
			itemsPath?: string;
			zeroBased: boolean;
			maxPageSize: number;
	  };

export interface ParamReader {
	/** '' when the resource has no workspace selector. */
	workspace: string;
	/** Resource-locator values come back as the plain string value. */
	get<T = unknown>(name: string, fallback?: T): T;
}

/** A row of Hub's GET /api/user/webhooks (UserWebhookDTO), as far as the node reads it. */
export interface HubWebhookRow {
	id?: number | string;
	name?: string | null;
	url?: string;
	/** UserWebhookDTO's on/off flag. */
	enabled?: boolean;
}

/** The stream n8n hands out for stored binary data (a Node Readable). */
export type ByteStream = Awaited<ReturnType<IExecuteFunctions['helpers']['getBinaryStream']>>;

export interface BinaryStream {
	/**
	 * A stream when n8n keeps the binary on disk or in S3; the bytes themselves when it keeps them
	 * in the item (memory mode), where they are already in memory.
	 */
	content: ByteStream | Buffer;
	/** In bytes. */
	size: number;
	mimeType: string;
	fileName: string;
}

export interface OperationContext {
	request(spec: RequestSpec): Promise<unknown>;
	requestAll(spec: RequestSpec, limit?: number): Promise<IDataObject[]>;
	/** Reads the whole binary into memory; for small files (wiki attachments). */
	readBinary(property: string): Promise<{ data: Buffer; mimeType: string; fileName: string }>;
	/**
	 * Opens the binary as a stream without reading it into memory, with its size in bytes. For
	 * large files (recordings).
	 */
	openBinary(property: string): Promise<BinaryStream>;
	/** Unauthenticated PUT of `size` bytes, streamed, to a presigned URL. */
	putStream(
		url: string,
		content: ByteStream | Buffer,
		size: number,
		mimeType: string,
	): Promise<void>;
	/** Unauthenticated GET of a signed URL, returned as n8n binary data. */
	downloadToBinary(url: string, fileName?: string): Promise<IBinaryData>;
	/** Unauthenticated PUT of raw bytes to a presigned URL. */
	putBinary(url: string, data: Buffer, mimeType: string): Promise<void>;
}

export interface OperationDef {
	/** camelCase n8n value, e.g. 'create'. */
	operation: string;
	/** Option label, e.g. 'Create'. */
	name: string;
	/** e.g. 'Create a task'. */
	action: string;
	description: string;
	/** displayOptions are injected by the registry, never set here. */
	fields: INodeProperties[];
	/** The registry adds returnAll/limit fields and uses requestAll. */
	list?: boolean;
	build?(p: ParamReader): RequestSpec;
	/** Multi-step operations only. */
	run?(ctx: OperationContext, p: ParamReader): Promise<INodeExecutionData[]>;
}

export interface ResourceDef {
	value: string;
	name: string;
	workspaceScoped: boolean;
	operations: OperationDef[];
}
