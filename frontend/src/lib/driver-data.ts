import type { DriverQueryInput, LargestGapRow, LookupCatalog, LookupSourceSummary, StatusCounts } from '$lib/driver-query';
import type { SqliteDatabase } from '$lib/sqlite-browser';

export interface HighestFoundSummary {
	id: number;
	version: string;
	displayVersion: string;
	name: string;
}

export interface DatabaseSummary {
	statusCounts: StatusCounts;
	highestFound: HighestFoundSummary | null;
	largestGap: LargestGapRow | null;
	lookupSources: LookupSourceSummary[];
}

export interface DriverProductGroup {
	seriesName: string;
	products: string[];
}

export interface DriverRowDetail {
	detailsUrl: string;
	downloadFileSize: string;
	downloadUrl: string;
	extraFieldsJson: string;
	gfeDisplayVersion: string;
	otherNotes: string;
	productGroups: DriverProductGroup[];
	releaseNotes: string;
}

export interface DriverRow {
	id: number;
	status: string;
	release: string;
	version: string;
	displayVersion: string;
	gfeDisplayVersion: string;
	releaseDateTime: string;
	osName: string;
	osCode: string;
	languageName: string;
	is64Bit: string;
	isWHQL: string;
	isRecommended: string;
	isDC: string;
	isCRD: string;
	isBeta: string;
	isFeaturePreview: string;
	downloadFileSize: string;
	releaseNotes: string;
	otherNotes: string;
	name: string;
	detailsUrl: string;
	downloadUrl: string;
	extraFieldsJson: string;
	productGroups: DriverProductGroup[];
	seriesNames: string[];
	productNames: string[];
	detailLoaded: boolean;
}

export interface DriverPageResult {
	pageCount: number;
	rows: DriverRow[];
	totalRows: number;
}

export async function queryDatabaseSummary(db: SqliteDatabase): Promise<DatabaseSummary> {
	return db.querySummary();
}

export async function queryLookupCatalog(db: SqliteDatabase): Promise<LookupCatalog> {
	return db.queryLookups();
}

export async function queryDriverPage(
	db: SqliteDatabase,
	options: DriverQueryInput
): Promise<DriverPageResult> {
	return db.queryPage(options);
}

export async function queryDriverDetail(
	db: SqliteDatabase,
	driverId: number
): Promise<DriverRowDetail> {
	return db.queryDriverDetail(driverId);
}
