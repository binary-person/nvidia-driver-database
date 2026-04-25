/// <reference lib="webworker" />

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { compareNvidiaDottedVersions } from '$lib/cuda-compat';
import type { DatabaseSource } from '$lib/database-source';
import type {
	DatabaseSummary,
	DriverPageResult,
	DriverRowDetail,
	DriverRow,
	HighestFoundSummary
} from '$lib/driver-data';
import {
	buildDriverCountQuery,
	buildDriverDetailQuery,
	buildDriverMembershipQuery,
	buildDriverPageQuery,
	buildDriverRowsByIdsQuery,
	HIGHEST_FOUND_QUERY,
	LARGEST_CONFIRMED_NOT_FOUND_GAP_QUERY,
	LOOKUP_SOURCES_QUERY,
	LOOKUP_VALUES_QUERY,
	normalizeStatusCounts,
	resolveLookupIds,
	STATUS_COUNTS_QUERY,
	usesWorkerSideSort,
	type DriverMembershipRow,
	type DriverQueryInput,
	type LargestGapRow,
	type LookupCatalog,
	type LookupSourceSummary,
	type LookupValue
} from '$lib/driver-query';

const context = self as DedicatedWorkerGlobalScope;
const REQUIRED_DRIVER_COLUMNS = [
	'release_text_id',
	'version_text_id',
	'display_version_text_id',
	'name_text_id',
	'os_lookup_id',
	'os_name',
	'os_code',
	'language_lookup_id',
	'language_name',
	'product_type_lookup_ids_text',
	'series_lookup_ids_text',
	'product_lookup_ids_text',
	'is_beta',
	'is_feature_preview',
	'release_date_unix'
];
const REQUIRED_DRIVER_DETAIL_COLUMNS = [
	'driver_id',
	'gfe_display_version_text_id',
	'download_file_size_bytes',
	'details_url_value',
	'details_url_template_kind',
	'details_url_host_id',
	'details_url_locale_segment',
	'download_url_value',
	'download_url_template_kind',
	'download_url_host_id',
	'download_url_path_id',
	'release_notes_note_id',
	'other_notes_note_id',
	'extra_fields_json'
];
const REQUIRED_URL_HOST_COLUMNS = ['host_id', 'host'];
const REQUIRED_DOWNLOAD_URL_PATH_COLUMNS = ['path_id', 'path'];
const REQUIRED_LOOKUP_VALUE_COLUMNS = ['lookup_id', 'type_id', 'value', 'name', 'parent_lookup_id'];
const REQUIRED_TEXT_VALUE_COLUMNS = ['text_id', 'text_type', 'value'];
const REQUIRED_NOTE_VALUE_COLUMNS = ['note_id', 'note_type', 'content_hash', 'encoding', 'raw_size', 'value_gzip'];
const REQUIRED_BROWSER_STATS_COLUMNS = [
	'found_count',
	'confirmed_not_found_count',
	'pending_frontier_count',
	'highest_found_id',
	'highest_found_version',
	'highest_found_display_version',
	'highest_found_name',
	'largest_gap_start_id',
	'largest_gap_end_id',
	'largest_gap_length',
	'built_at'
];

type DatabaseLoadErrorKind =
	| 'database_busy'
	| 'local_missing'
	| 'http_error'
	| 'network_error'
	| 'storage_quota'
	| 'unsupported_browser'
	| 'worker_error';

interface RawDriverListRow {
	displayVersion: string;
	id: number;
	is64Bit: number;
	isBeta: number;
	isCRD: number;
	isDC: number;
	isFeaturePreview: number;
	isRecommended: number;
	isWHQL: number;
	languageName: string;
	name: string;
	osCode: string;
	osName: string;
	productLookupIdsText: string;
	release: string;
	releaseDateUnix: number | null;
	seriesLookupIdsText: string;
	status: string;
	version: string;
}

interface RawDriverDetailRow {
	driverId: number;
	detailsUrlHostId: number | null;
	detailsUrlLocaleSegment: string;
	detailsUrlTemplateKind: number | null;
	detailsUrlValue: string | null;
	downloadFileSizeBytes: number | null;
	downloadUrlHostId: number | null;
	downloadUrlPath: string;
	downloadUrlTemplateKind: number | null;
	downloadUrlValue: string | null;
	extraFieldsJson: string;
	gfeDisplayVersion: string;
	otherNotesEncoding: string;
	otherNotesGzip: Uint8Array | ArrayBuffer | null;
	productLookupIdsText: string;
	releaseNotesEncoding: string;
	releaseNotesGzip: Uint8Array | ArrayBuffer | null;
	seriesLookupIdsText: string;
}

interface UrlHostRow {
	host: string;
	hostId: number;
}

interface BrowserDatabaseMetadata {
	builtAt: string;
	compressedDatabaseFileName?: string;
	compressedSize?: number;
	compression?: string;
	databaseFileName: string;
	schemaVersion: number;
	sha256: string;
	uncompressedSize: number;
}

interface SerializedWorkerError {
	kind?: DatabaseLoadErrorKind;
	message: string;
	name?: string;
	source?: DatabaseSource;
	status?: number;
	stack?: string;
}

interface WorkerDatabaseConnection {
	close(): void;
	exec(sql: string): unknown;
	selectObject<T>(sql: string, bind?: unknown[]): T | undefined;
	selectObjects<T>(sql: string, bind?: unknown[]): T[];
	selectValue(sql: string, bind?: unknown[]): unknown;
}

class WorkerDatabaseError extends Error {
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
		this.name = 'WorkerDatabaseError';
		this.kind = kind;
		this.source = source;
		this.status = status;
	}
}

class ImportedDatabaseInvalidError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ImportedDatabaseInvalidError';
	}
}

let database: WorkerDatabaseConnection | null = null;
let detailCache = new Map<number, DriverRowDetail>();
let lookupCatalogCache: LookupCatalog | null = null;
let urlHostMapCache: Map<number, string> | null = null;
let sqlite3Promise: Promise<any> | null = null;

function optionalBindParams(params: unknown[] | undefined): unknown[] | undefined {
	return params && params.length > 0 ? params : undefined;
}

function clearWorkerCaches() {
	detailCache.clear();
	lookupCatalogCache = null;
	urlHostMapCache = null;
}

function formatReleaseDateUnix(value: number | null | undefined): string {
	if (!Number.isFinite(value)) {
		return '';
	}

	const date = new Date(Number(value) * 1000);
	const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	return `${weekdays[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function formatFileSizeBytes(value: number | null | undefined): string {
	if (!Number.isFinite(value)) {
		return '';
	}

	const numericValue = Number(value);
	if (numericValue < 1000) {
		return `${numericValue} bytes`;
	}

	const units = ['KB', 'MB', 'GB', 'TB'];
	let currentValue = numericValue;
	let unitIndex = -1;

	while (currentValue >= 1000 && unitIndex < units.length - 1) {
		currentValue /= 1000;
		unitIndex += 1;
	}

	return `${currentValue.toFixed(2)} ${units[unitIndex]}`;
}

function compareCaseInsensitive(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function parseLookupMembershipText(value: string | null | undefined): number[] {
	if (!value) {
		return [];
	}

	return value
		.split('|')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => Number(entry))
		.filter((entry) => Number.isInteger(entry) && entry > 0);
}

function getLookupCatalog(): LookupCatalog {
	if (!lookupCatalogCache) {
		const db = requireDatabase();
		lookupCatalogCache = {
			sources: db.selectObjects<LookupSourceSummary>(LOOKUP_SOURCES_QUERY),
			values: db.selectObjects<LookupValue>(LOOKUP_VALUES_QUERY)
		};
	}

	return lookupCatalogCache;
}

function getLookupValueMap(): Map<number, LookupValue> {
	return new Map(getLookupCatalog().values.map((value) => [Number(value.lookupId), value]));
}

function getUrlHostMap(): Map<number, string> {
	if (!urlHostMapCache) {
		const db = requireDatabase();
		urlHostMapCache = new Map(
			db
				.selectObjects<UrlHostRow>('SELECT host_id AS hostId, host FROM url_hosts ORDER BY host_id ASC')
				.map((row) => [Number(row.hostId), row.host])
		);
	}

	return urlHostMapCache;
}

function resolveLookupNames(
	lookupIds: number[],
	lookupValueMap: Map<number, LookupValue>
): string[] {
	return [...new Set(
		lookupIds
			.map((lookupId) => lookupValueMap.get(lookupId)?.name || '')
			.filter(Boolean)
	)].sort(compareCaseInsensitive);
}

function buildProductGroupsFromMembership(
	seriesLookupIdsText: string | null | undefined,
	productLookupIdsText: string | null | undefined,
	lookupValueMap: Map<number, LookupValue>
): Array<{ seriesName: string; products: string[] }> {
	const seriesLookupIds = parseLookupMembershipText(seriesLookupIdsText);
	const productLookupIds = parseLookupMembershipText(productLookupIdsText);
	const productsBySeriesLookupId = new Map<number, number[]>();

	for (const productLookupId of productLookupIds) {
		const productLookup = lookupValueMap.get(productLookupId);
		const parentLookupId =
			productLookup?.parentLookupId === null || productLookup?.parentLookupId === undefined
				? null
				: Number(productLookup.parentLookupId);
		if (!parentLookupId) {
			continue;
		}

		if (!productsBySeriesLookupId.has(parentLookupId)) {
			productsBySeriesLookupId.set(parentLookupId, []);
		}
		productsBySeriesLookupId.get(parentLookupId)?.push(productLookupId);
	}

	for (const seriesLookupId of seriesLookupIds) {
		if (!productsBySeriesLookupId.has(seriesLookupId)) {
			productsBySeriesLookupId.set(seriesLookupId, []);
		}
	}

	return [...productsBySeriesLookupId.entries()]
		.map(([seriesLookupId, productIds]) => {
			const seriesName = lookupValueMap.get(seriesLookupId)?.name || '';
			if (!seriesName) {
				return null;
			}

			return {
				products: resolveLookupNames(productIds, lookupValueMap),
				seriesName
			};
		})
		.filter((entry): entry is { seriesName: string; products: string[] } => Boolean(entry))
		.sort((left, right) => compareCaseInsensitive(left.seriesName, right.seriesName));
}

function reconstructDetailsUrl(row: RawDriverDetailRow, urlHostMap: Map<number, string>): string {
	if (row.detailsUrlValue === '-1') {
		return '';
	}

	if (typeof row.detailsUrlValue === 'string' && row.detailsUrlValue !== '') {
		return row.detailsUrlValue;
	}

	if (Number(row.detailsUrlTemplateKind) === 1 && row.detailsUrlLocaleSegment) {
		return `https://www.nvidia.com/${row.detailsUrlLocaleSegment}/drivers/details/${row.driverId}/`;
	}

	if (Number(row.detailsUrlTemplateKind) === 2 && row.detailsUrlLocaleSegment && row.detailsUrlHostId) {
		const host = urlHostMap.get(Number(row.detailsUrlHostId)) || '';
		if (host) {
			return `https://${host}/Download/driverResults.aspx/${row.driverId}/${row.detailsUrlLocaleSegment}`;
		}
	}

	return '';
}

function reconstructDownloadUrl(row: RawDriverDetailRow, urlHostMap: Map<number, string>): string {
	if (row.downloadUrlValue === '-1') {
		return '';
	}

	if (typeof row.downloadUrlValue === 'string' && row.downloadUrlValue !== '') {
		return row.downloadUrlValue;
	}

	if (Number(row.downloadUrlTemplateKind) === 1 && row.downloadUrlHostId && row.downloadUrlPath) {
		const host = urlHostMap.get(Number(row.downloadUrlHostId)) || '';
		if (host) {
			return `https://${host}${row.downloadUrlPath}`;
		}
	}

	return '';
}

function toUint8Array(value: Uint8Array | ArrayBuffer | null | undefined): Uint8Array | null {
	if (!value) {
		return null;
	}

	if (value instanceof Uint8Array) {
		return value;
	}

	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}

	return null;
}

async function decodeCompressedNote(
	encoding: string | null | undefined,
	value: Uint8Array | ArrayBuffer | null | undefined
): Promise<string> {
	const compressedBytes = toUint8Array(value);
	if (!compressedBytes || !encoding) {
		return '';
	}

	if (encoding === 'identity') {
		return new TextDecoder().decode(compressedBytes);
	}

	if (encoding !== 'gzip') {
		throw new WorkerDatabaseError(
			'worker_error',
			`Unsupported note encoding in browser database: ${encoding}`
		);
	}

	if (typeof DecompressionStream !== 'function') {
		throw new WorkerDatabaseError(
			'unsupported_browser',
			'This browser does not support gzip note decompression for the local SQLite database.'
		);
	}

	const blobBytes =
		compressedBytes.byteOffset === 0 && compressedBytes.byteLength === compressedBytes.buffer.byteLength
			? (compressedBytes.buffer as ArrayBuffer)
			: (compressedBytes.buffer.slice(
					compressedBytes.byteOffset,
					compressedBytes.byteOffset + compressedBytes.byteLength
				) as ArrayBuffer);
	const decompressedStream = new Blob([blobBytes])
		.stream()
		.pipeThrough(new DecompressionStream('gzip'));
	return await new Response(decompressedStream).text();
}

function normalizeDriverRow(
	row: RawDriverListRow,
	lookupValueMap: Map<number, LookupValue>
): DriverRow {
	const seriesNames = resolveLookupNames(parseLookupMembershipText(row.seriesLookupIdsText), lookupValueMap);
	const productNames = resolveLookupNames(parseLookupMembershipText(row.productLookupIdsText), lookupValueMap);

	return {
		detailLoaded: false,
		detailsUrl: '',
		displayVersion: row.displayVersion,
		downloadFileSize: '',
		downloadUrl: '',
		extraFieldsJson: '{}',
		gfeDisplayVersion: '',
		id: Number(row.id),
		is64Bit: String(row.is64Bit),
		isBeta: String(row.isBeta),
		isCRD: String(row.isCRD),
		isDC: String(row.isDC),
		isFeaturePreview: String(row.isFeaturePreview),
		isRecommended: String(row.isRecommended),
		isWHQL: String(row.isWHQL),
		languageName: row.languageName,
		name: row.name,
		osCode: row.osCode,
		osName: row.osName,
		otherNotes: '',
		productGroups: [],
		productNames,
		release: row.release,
		releaseDateTime: formatReleaseDateUnix(row.releaseDateUnix),
		releaseNotes: '',
		seriesNames,
		status: row.status,
		version: row.version
	};
}

async function normalizeDriverDetailRow(
	row: RawDriverDetailRow,
	lookupValueMap: Map<number, LookupValue>,
	urlHostMap: Map<number, string>
): Promise<DriverRowDetail> {
	const [releaseNotes, otherNotes] = await Promise.all([
		decodeCompressedNote(row.releaseNotesEncoding, row.releaseNotesGzip),
		decodeCompressedNote(row.otherNotesEncoding, row.otherNotesGzip)
	]);

	return {
		detailsUrl: reconstructDetailsUrl(row, urlHostMap),
		downloadFileSize: formatFileSizeBytes(row.downloadFileSizeBytes),
		downloadUrl: reconstructDownloadUrl(row, urlHostMap),
		extraFieldsJson: row.extraFieldsJson,
		gfeDisplayVersion: row.gfeDisplayVersion,
		otherNotes,
		productGroups: buildProductGroupsFromMembership(
			row.seriesLookupIdsText,
			row.productLookupIdsText,
			lookupValueMap
		),
		releaseNotes
	};
}

function serializeError(error: unknown): SerializedWorkerError {
	if (error instanceof WorkerDatabaseError) {
		return {
			kind: error.kind,
			message: error.message,
			name: error.name,
			source: error.source,
			stack: error.stack,
			status: error.status
		};
	}

	if (error instanceof Error) {
		return {
			message: error.message,
			name: error.name,
			stack: error.stack
		};
	}

	return {
		message: 'Unknown worker error.'
	};
}

async function getSqlite3() {
	if (!sqlite3Promise) {
		sqlite3Promise = sqlite3InitModule();
	}

	return sqlite3Promise;
}

function isSqliteCorruptError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes('SQLITE_CORRUPT') ||
			error.message.includes('database disk image is malformed'))
	);
}

function closeDatabase() {
	if (!database) {
		return;
	}

	try {
		database.close();
	} finally {
		database = null;
		clearWorkerCaches();
	}
}

function formatBytes(value: number): string {
	if (value >= 1024 * 1024 * 1024) {
		return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
	}

	if (value >= 1024 * 1024) {
		return `${(value / 1024 / 1024).toFixed(1)} MiB`;
	}

	return `${value} bytes`;
}

function validateImportedDatabase(db: WorkerDatabaseConnection) {
	try {
		const driverColumns = db
			.selectObjects<{ name: string }>('PRAGMA table_info(drivers)')
			.map((column) => column.name);
		const driverDetailColumns = db
			.selectObjects<{ name: string }>('PRAGMA table_info(driver_detail)')
			.map((column) => column.name);
		const urlHostColumns = db
			.selectObjects<{ name: string }>('PRAGMA table_info(url_hosts)')
			.map((column) => column.name);
		const downloadUrlPathColumns = db
			.selectObjects<{ name: string }>('PRAGMA table_info(download_url_paths)')
			.map((column) => column.name);
		const lookupValueColumns = db
			.selectObjects<{ name: string }>('PRAGMA table_info(lookup_values)')
			.map((column) => column.name);
		const textValueColumns = db
			.selectObjects<{ name: string }>('PRAGMA table_info(text_values)')
			.map((column) => column.name);
		const noteValueColumns = db
			.selectObjects<{ name: string }>('PRAGMA table_info(note_values)')
			.map((column) => column.name);
		const browserStatsColumns = db
			.selectObjects<{ name: string }>('PRAGMA table_info(browser_stats)')
			.map((column) => column.name);
		const missingColumns = REQUIRED_DRIVER_COLUMNS.filter((column) => !driverColumns.includes(column));
		const missingDetailColumns = REQUIRED_DRIVER_DETAIL_COLUMNS.filter(
			(column) => !driverDetailColumns.includes(column)
		);
		const missingLookupValueColumns = REQUIRED_LOOKUP_VALUE_COLUMNS.filter(
			(column) => !lookupValueColumns.includes(column)
		);
		const missingUrlHostColumns = REQUIRED_URL_HOST_COLUMNS.filter(
			(column) => !urlHostColumns.includes(column)
		);
		const missingDownloadUrlPathColumns = REQUIRED_DOWNLOAD_URL_PATH_COLUMNS.filter(
			(column) => !downloadUrlPathColumns.includes(column)
		);
		const missingTextValueColumns = REQUIRED_TEXT_VALUE_COLUMNS.filter(
			(column) => !textValueColumns.includes(column)
		);
		const missingNoteValueColumns = REQUIRED_NOTE_VALUE_COLUMNS.filter(
			(column) => !noteValueColumns.includes(column)
		);
		const missingBrowserStatsColumns = REQUIRED_BROWSER_STATS_COLUMNS.filter(
			(column) => !browserStatsColumns.includes(column)
		);

		if (missingColumns.length > 0) {
			throw new ImportedDatabaseInvalidError(
				`Cached database is missing required columns: ${missingColumns.join(', ')}.`
			);
		}

		if (missingDetailColumns.length > 0) {
			throw new ImportedDatabaseInvalidError(
				`Cached database is missing driver_detail columns: ${missingDetailColumns.join(', ')}.`
			);
		}

		if (missingLookupValueColumns.length > 0) {
			throw new ImportedDatabaseInvalidError(
				`Cached database is missing lookup_values columns: ${missingLookupValueColumns.join(', ')}.`
			);
		}

		if (missingUrlHostColumns.length > 0) {
			throw new ImportedDatabaseInvalidError(
				`Cached database is missing url_hosts columns: ${missingUrlHostColumns.join(', ')}.`
			);
		}

		if (missingDownloadUrlPathColumns.length > 0) {
			throw new ImportedDatabaseInvalidError(
				`Cached database is missing download_url_paths columns: ${missingDownloadUrlPathColumns.join(', ')}.`
			);
		}

		if (missingTextValueColumns.length > 0) {
			throw new ImportedDatabaseInvalidError(
				`Cached database is missing text_values columns: ${missingTextValueColumns.join(', ')}.`
			);
		}

		if (missingNoteValueColumns.length > 0) {
			throw new ImportedDatabaseInvalidError(
				`Cached database is missing note_values columns: ${missingNoteValueColumns.join(', ')}.`
			);
		}

		if (missingBrowserStatsColumns.length > 0) {
			throw new ImportedDatabaseInvalidError(
				`Cached database is missing browser_stats columns: ${missingBrowserStatsColumns.join(', ')}.`
			);
		}

		db.selectValue('SELECT id FROM drivers LIMIT 1');
		db.selectValue('SELECT driver_id FROM driver_detail LIMIT 1');
		db.selectValue('SELECT host_id FROM url_hosts LIMIT 1');
		db.selectValue('SELECT path_id FROM download_url_paths LIMIT 1');
		db.selectValue('SELECT lookup_id FROM lookup_values LIMIT 1');
		db.selectValue('SELECT text_id FROM text_values LIMIT 1');
		db.selectValue('SELECT note_id FROM note_values LIMIT 1');
		db.selectValue('SELECT found_count FROM browser_stats LIMIT 1');
	} catch (error) {
		if (error instanceof ImportedDatabaseInvalidError) {
			throw error;
		}

		if (isSqliteCorruptError(error)) {
			throw new ImportedDatabaseInvalidError(
				'Cached database is malformed and needs to be re-imported.',
				{ cause: error }
			);
		}

		throw error;
	}
}

async function fetchSourceResponse(
	url: string,
	source: DatabaseSource,
	artifactLabel: string
): Promise<Response> {
	try {
		return await fetch(url, {
			credentials: 'omit'
		});
	} catch (error) {
		throw new WorkerDatabaseError(
			'network_error',
			`Failed to fetch ${source.kind} ${artifactLabel}.`,
			source,
			undefined,
			{ cause: error }
		);
	}
}

function sqliteRcLabel(sqlite3: any, rc: number): string {
	return (
		sqlite3?.capi?.sqlite3_errstr?.(rc) ||
		sqlite3?.capi?.sqlite3_js_rc_str?.(rc) ||
		`SQLite result code ${rc}`
	);
}

async function fetchBrowserDatabaseMetadata(source: DatabaseSource): Promise<BrowserDatabaseMetadata> {
	const response = await fetchSourceResponse(source.metadataUrl, source, 'browser database metadata');
	if (!response.ok) {
		if (source.kind === 'local' && response.status === 404) {
			throw new WorkerDatabaseError(
				'local_missing',
				'Local browser database artifacts not found. Run the crawler first, then node app.js buildbrowserdb.',
				source,
				response.status
			);
		}

		throw new WorkerDatabaseError(
			'http_error',
			`Failed to fetch ${source.kind} browser database metadata (HTTP ${response.status}).`,
			source,
			response.status
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new WorkerDatabaseError(
			'worker_error',
			'Browser database metadata is not valid JSON.',
			source,
			undefined,
			{ cause: error }
		);
	}

	if (!payload || typeof payload !== 'object') {
		throw new WorkerDatabaseError(
			'worker_error',
			'Browser database metadata is missing or malformed.',
			source
		);
	}

	const metadata = payload as Partial<BrowserDatabaseMetadata>;
	const uncompressedSize = Number(metadata.uncompressedSize);
	if (!Number.isInteger(uncompressedSize) || uncompressedSize <= 0) {
		throw new WorkerDatabaseError(
			'worker_error',
			'Browser database metadata does not include a valid uncompressed size.',
			source
		);
	}

	return {
		builtAt: typeof metadata.builtAt === 'string' ? metadata.builtAt : '',
		compressedDatabaseFileName:
			typeof metadata.compressedDatabaseFileName === 'string'
				? metadata.compressedDatabaseFileName
				: undefined,
		compressedSize:
			metadata.compressedSize === undefined || metadata.compressedSize === null
				? undefined
				: Number(metadata.compressedSize),
		compression: typeof metadata.compression === 'string' ? metadata.compression : 'gzip',
		databaseFileName: typeof metadata.databaseFileName === 'string' ? metadata.databaseFileName : '',
		schemaVersion: Number(metadata.schemaVersion || 0),
		sha256: typeof metadata.sha256 === 'string' ? metadata.sha256 : '',
		uncompressedSize
	};
}

function assertSqliteBufferShape(buffer: Uint8Array, expectedSize: number, source: DatabaseSource) {
	if (expectedSize < 512 || expectedSize % 512 !== 0) {
		throw new WorkerDatabaseError(
			'worker_error',
			`Browser database metadata reported an invalid SQLite byte length (${formatBytes(expectedSize)}).`,
			source
		);
	}

	const header = 'SQLite format 3';
	if (buffer.byteLength < header.length) {
		throw new WorkerDatabaseError(
			'worker_error',
			'Inflated browser database is missing the SQLite header.',
			source
		);
	}

	for (let index = 0; index < header.length; index += 1) {
		if (buffer[index] !== header.charCodeAt(index)) {
			throw new WorkerDatabaseError(
				'worker_error',
				'Inflated browser database does not begin with a valid SQLite header.',
				source
			);
		}
	}
}

async function streamCompressedDatabaseIntoWasm(
	sqlite3: any,
	source: DatabaseSource,
	metadata: BrowserDatabaseMetadata
): Promise<number> {
	const response = await fetchSourceResponse(source.url, source, 'browser database');

	if (!response.ok) {
		if (source.kind === 'local' && response.status === 404) {
			throw new WorkerDatabaseError(
				'local_missing',
				'Local browser database artifacts not found. Run the crawler first, then node app.js buildbrowserdb.',
				source,
				response.status
			);
		}

		throw new WorkerDatabaseError(
			'http_error',
			`Failed to fetch ${source.kind} browser database (HTTP ${response.status}).`,
			source,
			response.status
		);
	}

	if (!response.body) {
		throw new WorkerDatabaseError(
			'unsupported_browser',
			'This browser cannot stream the compressed SQLite database.'
		);
	}

	const contentEncoding = String(response.headers.get('content-encoding') || '').toLowerCase();
	const needsManualGzip =
		source.compression === 'gzip' && !contentEncoding.split(',').some((value) => value.trim() === 'gzip');

	if (needsManualGzip && typeof DecompressionStream !== 'function') {
		throw new WorkerDatabaseError(
			'unsupported_browser',
			'This browser does not support streaming gzip decompression for the SQLite database.'
		);
	}

	const ptr = sqlite3.wasm.alloc(metadata.uncompressedSize);
	const target = sqlite3.wasm.heap8u().subarray(ptr, ptr + metadata.uncompressedSize);
	const stream = needsManualGzip
		? response.body.pipeThrough(new DecompressionStream('gzip'))
		: response.body;
	const reader = stream.getReader();
	let offset = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			if (!value) {
				continue;
			}

			if (offset + value.byteLength > target.byteLength) {
				throw new WorkerDatabaseError(
					'worker_error',
					`Inflated browser database exceeded the expected size (${formatBytes(metadata.uncompressedSize)}).`,
					source
				);
			}

			target.set(value, offset);
			offset += value.byteLength;
		}
	} catch (error) {
		sqlite3.wasm.dealloc(ptr);
		throw error;
	} finally {
		reader.releaseLock();
	}

	if (offset !== metadata.uncompressedSize) {
		sqlite3.wasm.dealloc(ptr);
		throw new WorkerDatabaseError(
			'worker_error',
			`Inflated browser database size mismatch: expected ${formatBytes(metadata.uncompressedSize)}, received ${formatBytes(offset)}.`,
			source
		);
	}

	assertSqliteBufferShape(target, metadata.uncompressedSize, source);
	return ptr;
}

function openMemoryDatabaseFromBytes(
	sqlite3: any,
	databaseBytesPtr: number,
	metadata: BrowserDatabaseMetadata,
	source: DatabaseSource
): WorkerDatabaseConnection {
	const nextDatabase = new sqlite3.oo1.DB(':memory:', 'c') as WorkerDatabaseConnection & {
		pointer: number;
	};
	let transferred = false;

	try {
		const deserializeFlags = 1 | 4;
		const rc = sqlite3.capi.sqlite3_deserialize(
			nextDatabase.pointer,
			'main',
			databaseBytesPtr,
			metadata.uncompressedSize,
			metadata.uncompressedSize,
			deserializeFlags
		);
		if (rc) {
			throw new WorkerDatabaseError(
				'worker_error',
				`Failed to deserialize the browser database into SQLite memory: ${sqliteRcLabel(sqlite3, rc)}.`,
				source
			);
		}

		transferred = true;
		nextDatabase.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -8192;');
		validateImportedDatabase(nextDatabase);
		return nextDatabase;
	} catch (error) {
		if (!transferred) {
			sqlite3.wasm.dealloc(databaseBytesPtr);
		}
		nextDatabase.close();
		throw error;
	}
}

async function ensureDatabaseLoaded(source: DatabaseSource, _forceRefresh: boolean): Promise<void> {
	closeDatabase();
	clearWorkerCaches();

	const sqlite3 = await getSqlite3();
	const metadata = await fetchBrowserDatabaseMetadata(source);
	const databaseBytesPtr = await streamCompressedDatabaseIntoWasm(sqlite3, source, metadata);

	try {
		database = openMemoryDatabaseFromBytes(sqlite3, databaseBytesPtr, metadata, source);
	} catch (error) {
		if (error instanceof ImportedDatabaseInvalidError) {
			throw new WorkerDatabaseError(
				'worker_error',
				`${error.message} The source database may need to be regenerated or republished.`,
				source,
				undefined,
				{ cause: error }
			);
		}

		throw error;
	}
}

function requireDatabase() {
	if (!database) {
		throw new WorkerDatabaseError(
			'worker_error',
			'The SQLite database is not loaded yet.'
		);
	}

	return database;
}

function querySummary(): DatabaseSummary {
	const db = requireDatabase();
	const statusCounts = normalizeStatusCounts(
		db.selectObjects<{ status: 'found' | 'confirmed_not_found' | 'pending_frontier'; count: number }>(
			STATUS_COUNTS_QUERY
		)
	);

	const highestFound = db.selectObject<HighestFoundSummary>(HIGHEST_FOUND_QUERY) ?? null;
	const largestGap = db.selectObject<LargestGapRow>(LARGEST_CONFIRMED_NOT_FOUND_GAP_QUERY) ?? null;
	const lookupSources = db.selectObjects<LookupSourceSummary>(LOOKUP_SOURCES_QUERY);

	return {
		highestFound,
		largestGap,
		lookupSources,
		statusCounts
	};
}

function queryLookups(): LookupCatalog {
	return getLookupCatalog();
}

function ensureResolvedQueryInput(db: WorkerDatabaseConnection, options: DriverQueryInput): DriverQueryInput {
	if (options.resolvedLookupIds) {
		return options;
	}

	return {
		...options,
		resolvedLookupIds: resolveLookupIds(options.filters, getLookupCatalog().values)
	};
}

function buildSortKey(names: string[]): string {
	return names.join(' | ');
}

function reorderRowsByIds(rows: RawDriverListRow[], ids: number[]): RawDriverListRow[] {
	const rowById = new Map(rows.map((row) => [Number(row.id), row]));
	return ids
		.map((id) => rowById.get(id))
		.filter((row): row is RawDriverListRow => Boolean(row));
}

function queryPage(options: DriverQueryInput): DriverPageResult {
	const db = requireDatabase();
	const lookupValueMap = getLookupValueMap();
	const resolvedOptions = ensureResolvedQueryInput(db, options);
	const countQuery = buildDriverCountQuery(resolvedOptions);
	const totalRows = Number(db.selectValue(countQuery.sql, optionalBindParams(countQuery.params)) ?? 0);
	const pageCount = Math.max(1, Math.ceil(totalRows / resolvedOptions.pageSize));
	let rawRows: RawDriverListRow[];

	if (usesWorkerSideSort(resolvedOptions.sort)) {
		const membershipQuery = buildDriverMembershipQuery(resolvedOptions);
		const membershipRows = db.selectObjects<DriverMembershipRow>(
			membershipQuery.sql,
			optionalBindParams(membershipQuery.params)
		);
		const sortedMembershipRows = membershipRows
			.sort((left, right) => {
				let comparison = 0;
				if (resolvedOptions.sort.key === 'displayVersion') {
					comparison =
						compareNvidiaDottedVersions(left.displayVersion, right.displayVersion) ??
						compareCaseInsensitive(left.displayVersion, right.displayVersion);
				} else {
					const leftSortValue = buildSortKey(
						resolveLookupNames(
							parseLookupMembershipText(
								resolvedOptions.sort.key === 'seriesNames'
									? left.seriesLookupIdsText
									: left.productLookupIdsText
							),
							lookupValueMap
						)
					);
					const rightSortValue = buildSortKey(
						resolveLookupNames(
							parseLookupMembershipText(
								resolvedOptions.sort.key === 'seriesNames'
									? right.seriesLookupIdsText
									: right.productLookupIdsText
							),
							lookupValueMap
						)
					);
					comparison = compareCaseInsensitive(leftSortValue, rightSortValue);
				}

				if (comparison !== 0) {
					return resolvedOptions.sort.direction === 'asc' ? comparison : -comparison;
				}

				return right.id - left.id;
			})
			.map((entry) => entry);
		const offset = (resolvedOptions.page - 1) * resolvedOptions.pageSize;
		const pageIds = sortedMembershipRows
			.slice(offset, offset + resolvedOptions.pageSize)
			.map((row) => Number(row.id));
		const rowQuery = buildDriverRowsByIdsQuery(pageIds);
		rawRows = reorderRowsByIds(
			db.selectObjects<RawDriverListRow>(rowQuery.sql, optionalBindParams(rowQuery.params)),
			pageIds
		);
	} else {
		const rowQuery = buildDriverPageQuery(resolvedOptions);
		rawRows = db.selectObjects<RawDriverListRow>(
			rowQuery.sql,
			optionalBindParams(rowQuery.params)
		);
	}

	return {
		pageCount,
		rows: rawRows.map((row) => normalizeDriverRow(row, lookupValueMap)),
		totalRows
	};
}

async function queryDriverDetail(driverId: number): Promise<DriverRowDetail> {
	const cachedDetail = detailCache.get(driverId);
	if (cachedDetail) {
		return cachedDetail;
	}

	const db = requireDatabase();
	const detailQuery = buildDriverDetailQuery(driverId);
	const row = db.selectObject<RawDriverDetailRow>(
		detailQuery.sql,
		optionalBindParams(detailQuery.params)
	);
	if (!row) {
		throw new WorkerDatabaseError('worker_error', `Driver detail not found for ID ${driverId}.`);
	}

	const detail = await normalizeDriverDetailRow(row, getLookupValueMap(), getUrlHostMap());
	detailCache.set(driverId, detail);
	return detail;
}

context.onmessage = async (
	event: MessageEvent<{
		args?: unknown;
		id: number;
		type: 'close' | 'load-database' | 'query-driver-detail' | 'query-lookups' | 'query-page' | 'query-summary';
	}>
) => {
	const { args, id, type } = event.data;

	try {
		let result: unknown = null;

		switch (type) {
			case 'load-database': {
				const { forceRefresh, source } = args as {
					forceRefresh: boolean;
					source: DatabaseSource;
				};
				await ensureDatabaseLoaded(source, forceRefresh);
				break;
			}
			case 'query-summary':
				result = querySummary();
				break;
			case 'query-lookups':
				result = queryLookups();
				break;
			case 'query-page':
				result = queryPage(args as DriverQueryInput);
				break;
			case 'query-driver-detail':
				result = await queryDriverDetail((args as { driverId: number }).driverId);
				break;
			case 'close':
				closeDatabase();
				break;
			default:
				throw new WorkerDatabaseError('worker_error', `Unknown worker message type: ${type}`);
		}

		context.postMessage({
			id,
			ok: true,
			result
		});
	} catch (error) {
		context.postMessage({
			error: serializeError(error),
			id,
			ok: false
		});
	}
};
