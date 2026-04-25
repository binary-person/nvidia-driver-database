import type { DatabaseSource } from '$lib/database-source';
import type { DatabaseSummary, DriverPageResult, DriverRowDetail } from '$lib/driver-data';
import type { DriverQueryInput } from '$lib/driver-query';
import type { LookupCatalog } from '$lib/driver-query';

type DatabaseLoadErrorKind =
	| 'database_busy'
	| 'local_missing'
	| 'http_error'
	| 'network_error'
	| 'storage_quota'
	| 'unsupported_browser'
	| 'worker_error';

interface SerializedWorkerError {
	kind?: DatabaseLoadErrorKind;
	message: string;
	name?: string;
	source?: DatabaseSource;
	status?: number;
	stack?: string;
}

interface WorkerRequestMap {
	'load-database': {
		args: {
			forceRefresh: boolean;
			source: DatabaseSource;
		};
		result: null;
	};
	'query-page': {
		args: DriverQueryInput;
		result: DriverPageResult;
	};
	'query-driver-detail': {
		args: {
			driverId: number;
		};
		result: DriverRowDetail;
	};
	'query-lookups': {
		args: undefined;
		result: LookupCatalog;
	};
	'query-summary': {
		args: undefined;
		result: DatabaseSummary;
	};
	'close': {
		args: undefined;
		result: null;
	};
}

type WorkerRequestType = keyof WorkerRequestMap;

type WorkerMessage =
	| {
			id: number;
			ok: true;
			result: unknown;
	  }
	| {
			error: SerializedWorkerError;
			id: number;
			ok: false;
	  };

export class DatabaseLoadError extends Error {
	kind: DatabaseLoadErrorKind;
	source?: DatabaseSource;
	status?: number;

	constructor(
		kind: DatabaseLoadErrorKind,
		message: string,
		source?: DatabaseSource,
		status?: number,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'DatabaseLoadError';
		this.kind = kind;
		this.source = source;
		this.status = status;
	}
}

export interface SqliteDatabase {
	load(source: DatabaseSource, forceRefresh?: boolean): Promise<void>;
	queryDriverDetail(driverId: number): Promise<DriverRowDetail>;
	queryLookups(): Promise<LookupCatalog>;
	queryPage(input: DriverQueryInput): Promise<DriverPageResult>;
	querySummary(): Promise<DatabaseSummary>;
	close(): Promise<void>;
}

function toPlainCloneable<T>(value: T): T {
	if (value === null || value === undefined) {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((entry) => toPlainCloneable(entry)) as T;
	}

	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		return value;
	}

	if (typeof value === 'object') {
		const plainObject: Record<string, unknown> = {};

		for (const [key, entry] of Object.entries(value)) {
			plainObject[key] = toPlainCloneable(entry);
		}

		return plainObject as T;
	}

	return value;
}

function deserializeWorkerError(error: SerializedWorkerError): Error {
	if (error.kind) {
		return new DatabaseLoadError(error.kind, error.message, error.source, error.status);
	}

	const nextError = new Error(error.message);
	nextError.name = error.name || 'Error';
	if (error.stack) {
		nextError.stack = error.stack;
	}
	return nextError;
}

class WorkerBackedSqliteDatabase implements SqliteDatabase {
	private closed = false;
	private nextRequestId = 1;
	private readonly pending = new Map<
		number,
		{
			reject: (reason?: unknown) => void;
			resolve: (value: unknown) => void;
		}
	>();
	private readonly worker: Worker;

	constructor() {
		this.worker = new Worker(new URL('./sqlite-opfs.worker.ts', import.meta.url), {
			type: 'module'
		});
		this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
			const message = event.data;
			const handlers = this.pending.get(message.id);
			if (!handlers) {
				return;
			}

			this.pending.delete(message.id);

			if (message.ok) {
				handlers.resolve(message.result);
				return;
			}

			handlers.reject(deserializeWorkerError(message.error));
		};
		this.worker.onerror = (event) => {
			const workerError = new DatabaseLoadError(
				'worker_error',
				event.message || 'SQLite worker failed unexpectedly.'
			);

			for (const handlers of this.pending.values()) {
				handlers.reject(workerError);
			}

			this.pending.clear();
		};
	}

	private request<TType extends WorkerRequestType>(
		type: TType,
		args: WorkerRequestMap[TType]['args']
	): Promise<WorkerRequestMap[TType]['result']> {
		if (this.closed) {
			return Promise.reject(new Error('Database worker is already closed.'));
		}

		const id = this.nextRequestId++;

		return new Promise<WorkerRequestMap[TType]['result']>((resolve, reject) => {
			this.pending.set(id, {
				reject,
				resolve: (value) => resolve(value as WorkerRequestMap[TType]['result'])
			});
			this.worker.postMessage({
				args: toPlainCloneable(args),
				id,
				type
			});
		});
	}

	async load(source: DatabaseSource, forceRefresh = false): Promise<void> {
		await this.request('load-database', {
			forceRefresh,
			source
		});
	}

	async queryPage(input: DriverQueryInput): Promise<DriverPageResult> {
		return this.request('query-page', input);
	}

	async queryDriverDetail(driverId: number): Promise<DriverRowDetail> {
		return this.request('query-driver-detail', { driverId });
	}

	async queryLookups(): Promise<LookupCatalog> {
		return this.request('query-lookups', undefined);
	}

	async querySummary(): Promise<DatabaseSummary> {
		return this.request('query-summary', undefined);
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}

		try {
			await this.request('close', undefined);
		} catch {
			// Ignore close failures because termination below is authoritative.
		} finally {
			this.closed = true;
			for (const handlers of this.pending.values()) {
				handlers.reject(new Error('Database worker was closed.'));
			}
			this.pending.clear();
			this.worker.terminate();
		}
	}
}

export function createSqliteDatabase(): SqliteDatabase {
	return new WorkerBackedSqliteDatabase();
}
