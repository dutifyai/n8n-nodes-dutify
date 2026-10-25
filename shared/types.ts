import type {
	IBinaryData,
	IDataObject,
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
	body?: IDataObject | IDataObject[];
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

export interface OperationContext {
	request(spec: RequestSpec): Promise<unknown>;
	requestAll(spec: RequestSpec, limit?: number): Promise<IDataObject[]>;
	readBinary(property: string): Promise<{ data: Buffer; mimeType: string; fileName: string }>;
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
