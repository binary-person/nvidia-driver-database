export type DriverStatus = 'found' | 'confirmed_not_found' | 'pending_frontier';
export type LookupTypeId = 1 | 2 | 3 | 4 | 5;

const TEXT_FILTER_TYPES = {
	release: 1,
	version: 2,
	displayVersion: 3,
	name: 4
} as const;

export interface DriverFilters {
	id: string;
	version: string;
	displayVersion: string;
	release: string;
	name: string;
	productTypeValue: string;
	seriesValue: string;
	productValue: string;
	osValue: string;
	languageValue: string;
	is64Bit: '' | '0' | '1';
	isWHQL: '' | '0' | '1';
	isRecommended: '' | '0' | '1';
	isDC: '' | '0' | '1';
	isCRD: '' | '0' | '1';
	isBeta: '' | '0' | '1';
	isFeaturePreview: '' | '0' | '1';
}

export interface ResolvedLookupIds {
	languageLookupId: number | null;
	osLookupId: number | null;
	productLookupId: number | null;
	productTypeLookupId: number | null;
	seriesLookupId: number | null;
}

export interface DriverQueryInput {
	filters: DriverFilters;
	page: number;
	pageSize: number;
	resolvedLookupIds?: ResolvedLookupIds;
	sort: DriverSort;
}

export type DriverSortDirection = 'asc' | 'desc';

export type DriverSortKey =
	| 'id'
	| 'release'
	| 'releaseDateTime'
	| 'version'
	| 'displayVersion'
	| 'osName'
	| 'languageName'
	| 'name'
	| 'seriesNames'
	| 'productNames'
	| 'osCode'
	| 'is64Bit'
	| 'isWHQL'
	| 'isRecommended'
	| 'isDC'
	| 'isCRD'
	| 'isBeta'
	| 'isFeaturePreview';

export interface DriverSort {
	direction: DriverSortDirection;
	key: DriverSortKey;
}

export interface SearchStateSnapshot {
	appliedDatabaseRevision: number;
	appliedFilters: DriverFilters;
	databaseRevision: number;
	draftFilters: DriverFilters;
	hasSearched: boolean;
}

export interface DriverHashColumnConfig {
	columnOrder: DriverSortKey[];
	defaultVisibleColumns: Record<DriverSortKey, boolean>;
	requiredColumns: DriverSortKey[];
}

export interface DriverHashState {
	filters: DriverFilters;
	sort: DriverSort;
	visibleColumns: Record<DriverSortKey, boolean>;
}

export interface ParsedDriverHashState extends DriverHashState {
	hasState: boolean;
}

export interface SqlQuery {
	sql: string;
	params: unknown[];
}

export interface DriverMembershipRow {
	displayVersion: string;
	id: number;
	productLookupIdsText: string;
	seriesLookupIdsText: string;
}

export interface StatusCountRow {
	status: DriverStatus;
	count: number;
}

export interface StatusCounts {
	found: number;
	confirmedNotFound: number;
	pendingFrontier: number;
}

export interface LargestGapRow {
	startId: number;
	endId: number;
	length: number;
}

export interface LookupValue {
	lookupId: number;
	typeId: LookupTypeId;
	lookupName: string;
	value: string;
	name: string;
	parentLookupId: number | null;
	parentTypeId: LookupTypeId | null;
	parentValue: string;
	code: string;
	requiresProduct: string;
	isSelectLess: string;
	ordinal: number;
}

export interface LookupSourceSummary {
	typeId: LookupTypeId;
	lookupName: string;
	url: string;
	contentHash: string;
	entryCount: number;
	lastCheckedAt: string;
	lastChangedAt: string;
}

export interface LookupCatalog {
	sources: LookupSourceSummary[];
	values: LookupValue[];
}

export const DEFAULT_PAGE_SIZE = 100;
export const PAGE_SIZE_OPTIONS = [100, 1000, 10000] as const;
export const DEFAULT_DRIVER_SORT: DriverSort = {
	key: 'id',
	direction: 'desc'
};

export const DEFAULT_DRIVER_FILTERS: DriverFilters = {
	id: '',
	version: '',
	displayVersion: '',
	release: '',
	name: '',
	productTypeValue: '',
	seriesValue: '',
	productValue: '',
	osValue: '',
	languageValue: '1',
	is64Bit: '',
	isWHQL: '',
	isRecommended: '',
	isDC: '',
	isCRD: '',
	isBeta: '',
	isFeaturePreview: ''
};

const FILTER_HASH_ALIASES: Record<keyof DriverFilters, string> = {
	id: 'id',
	release: 're',
	version: 've',
	displayVersion: 'dv',
	name: 'na',
	productTypeValue: 'pt',
	seriesValue: 'se',
	productValue: 'pr',
	osValue: 'os',
	languageValue: 'la',
	is64Bit: 'b64',
	isWHQL: 'wh',
	isRecommended: 'rc',
	isDC: 'dc',
	isCRD: 'cr',
	isBeta: 'be',
	isFeaturePreview: 'fp'
};

const COLUMN_HASH_ALIASES: Record<DriverSortKey, string> = {
	id: 'id',
	release: 're',
	version: 've',
	displayVersion: 'dv',
	osName: 'os',
	languageName: 'la',
	name: 'na',
	releaseDateTime: 'dt',
	seriesNames: 'se',
	productNames: 'pr',
	osCode: 'oc',
	is64Bit: 'b64',
	isWHQL: 'wh',
	isRecommended: 'rc',
	isDC: 'dc',
	isCRD: 'cr',
	isBeta: 'be',
	isFeaturePreview: 'fp'
};

const FILTER_KEY_BY_ALIAS = Object.fromEntries(
	Object.entries(FILTER_HASH_ALIASES).map(([key, alias]) => [alias, key])
) as Record<string, keyof DriverFilters>;

const COLUMN_KEY_BY_ALIAS = Object.fromEntries(
	Object.entries(COLUMN_HASH_ALIASES).map(([key, alias]) => [alias, key])
) as Record<string, DriverSortKey>;

const BOOLEAN_FILTER_KEYS = new Set<keyof DriverFilters>([
	'is64Bit',
	'isWHQL',
	'isRecommended',
	'isDC',
	'isCRD',
	'isBeta',
	'isFeaturePreview'
]);

export const STATUS_COUNTS_QUERY = `
	SELECT 'found' AS status, found_count AS count
	FROM browser_stats
	UNION ALL
	SELECT 'confirmed_not_found' AS status, confirmed_not_found_count AS count
	FROM browser_stats
	UNION ALL
	SELECT 'pending_frontier' AS status, pending_frontier_count AS count
	FROM browser_stats
`;

export const HIGHEST_FOUND_QUERY = `
	SELECT
		highest_found_id AS id,
		highest_found_version AS version,
		highest_found_display_version AS displayVersion,
		highest_found_name AS name
	FROM browser_stats
	WHERE highest_found_id IS NOT NULL
`;

export const LARGEST_CONFIRMED_NOT_FOUND_GAP_QUERY = `
	SELECT
		largest_gap_start_id AS startId,
		largest_gap_end_id AS endId,
		largest_gap_length AS length
	FROM browser_stats
	WHERE largest_gap_start_id IS NOT NULL
`;

export const LOOKUP_VALUES_QUERY = `
	SELECT
		lv.lookup_id AS lookupId,
		lv.type_id AS typeId,
		lv.lookup_name AS lookupName,
		lv.value,
		lv.name,
		lv.parent_lookup_id AS parentLookupId,
		parent.type_id AS parentTypeId,
		COALESCE(parent.value, '') AS parentValue,
		lv.code,
		lv.requires_product AS requiresProduct,
		lv.is_select_less AS isSelectLess,
		lv.ordinal
	FROM lookup_values lv
	LEFT JOIN lookup_values parent
		ON parent.lookup_id = lv.parent_lookup_id
	WHERE lv.type_id IN (1, 2, 3, 4, 5)
	ORDER BY lv.type_id ASC, lv.ordinal ASC
`;

export const LOOKUP_SOURCES_QUERY = `
	SELECT
		type_id AS typeId,
		lookup_name AS lookupName,
		url,
		content_hash AS contentHash,
		entry_count AS entryCount,
		last_checked_at AS lastCheckedAt,
		last_changed_at AS lastChangedAt
	FROM lookup_sources
	WHERE type_id IN (1, 2, 3, 4, 5)
	ORDER BY type_id ASC
`;

const EXACT_FILTERS: ReadonlyArray<[keyof DriverFilters, string]> = [
	['is64Bit', 'd.is_64_bit'],
	['isWHQL', 'd.is_whql'],
	['isRecommended', 'd.is_recommended'],
	['isDC', 'd.is_dc'],
	['isCRD', 'd.is_crd'],
	['isBeta', 'd.is_beta'],
	['isFeaturePreview', 'd.is_feature_preview']
];

const SORT_EXPRESSIONS: Record<DriverSortKey, string> = {
	id: 'd.id',
	release: "COALESCE(release_tv.value, '') COLLATE NOCASE",
	releaseDateTime: 'd.release_date_unix',
	version: "COALESCE(version_tv.value, '') COLLATE NOCASE",
	displayVersion: "COALESCE(display_tv.value, '') COLLATE NOCASE",
	osName: "LOWER(COALESCE(os_lv.name, d.os_name, ''))",
	languageName: "LOWER(COALESCE(language_lv.name, d.language_name, ''))",
	name: "COALESCE(name_tv.value, '') COLLATE NOCASE",
	seriesNames: 'd.id',
	productNames: 'd.id',
	osCode: "LOWER(COALESCE(os_lv.code, d.os_code, ''))",
	is64Bit: 'd.is_64_bit',
	isWHQL: 'd.is_whql',
	isRecommended: 'd.is_recommended',
	isDC: 'd.is_dc',
	isCRD: 'd.is_crd',
	isBeta: 'd.is_beta',
	isFeaturePreview: 'd.is_feature_preview'
};

function normalizePrefixValue(value: string): string {
	return `${value.trim().toLowerCase()}%`;
}

function buildLookupMembershipToken(lookupId: number): string {
	return `|${lookupId}|`;
}

export function usesWorkerSideSort(sort: DriverSort): boolean {
	return (
		sort.key === 'seriesNames' ||
		sort.key === 'productNames' ||
		sort.key === 'displayVersion'
	);
}

function getResolvedLookupId(input: DriverQueryInput, key: keyof ResolvedLookupIds): number | null {
	return input.resolvedLookupIds?.[key] ?? null;
}

export function formatBooleanValue(value: string | number | null | undefined, blankValue = '-'): string {
	if (value === '1' || value === 1) {
		return 'yes';
	}

	if (value === '0' || value === 0) {
		return 'no';
	}

	return blankValue;
}

function createDefaultVisibleColumns(
	config: DriverHashColumnConfig
): Record<DriverSortKey, boolean> {
	const nextVisibleColumns = {} as Record<DriverSortKey, boolean>;

	for (const key of config.columnOrder) {
		nextVisibleColumns[key] = Boolean(config.defaultVisibleColumns[key]);
	}

	for (const key of config.requiredColumns) {
		nextVisibleColumns[key] = true;
	}

	return nextVisibleColumns;
}

function normalizeFilterHashValue(key: keyof DriverFilters, value: string): string {
	if (BOOLEAN_FILTER_KEYS.has(key)) {
		return value === '0' || value === '1' ? value : '';
	}

	return value.trim();
}

function areVisibleColumnsEqual(
	left: Record<DriverSortKey, boolean>,
	right: Record<DriverSortKey, boolean>,
	columnOrder: DriverSortKey[]
): boolean {
	return columnOrder.every((key) => Boolean(left[key]) === Boolean(right[key]));
}

export function serializeDriverHashState(
	state: DriverHashState,
	config: DriverHashColumnConfig
): string {
	const params = new URLSearchParams();
	params.set('v', '1');

	for (const key of Object.keys(FILTER_HASH_ALIASES) as Array<keyof DriverFilters>) {
		const value = normalizeFilterHashValue(key, state.filters[key]);
		const defaultValue = DEFAULT_DRIVER_FILTERS[key];
		if (!value || value === defaultValue) {
			continue;
		}

		params.set(FILTER_HASH_ALIASES[key], value);
	}

	if (
		state.sort.key !== DEFAULT_DRIVER_SORT.key ||
		state.sort.direction !== DEFAULT_DRIVER_SORT.direction
	) {
		params.set(
			's',
			`${COLUMN_HASH_ALIASES[state.sort.key]}.${state.sort.direction === 'asc' ? 'a' : 'd'}`
		);
	}

	const normalizedVisibleColumns = createDefaultVisibleColumns(config);
	for (const key of config.columnOrder) {
		normalizedVisibleColumns[key] = Boolean(state.visibleColumns[key]);
	}
	for (const key of config.requiredColumns) {
		normalizedVisibleColumns[key] = true;
	}

	const defaultVisibleColumns = createDefaultVisibleColumns(config);
	if (!areVisibleColumnsEqual(normalizedVisibleColumns, defaultVisibleColumns, config.columnOrder)) {
		params.set(
			'c',
			config.columnOrder
				.filter((key) => normalizedVisibleColumns[key])
				.map((key) => COLUMN_HASH_ALIASES[key])
				.join(',')
		);
	}

	return `#${params.toString()}`;
}

export function parseDriverHashState(
	hash: string,
	config: DriverHashColumnConfig
): ParsedDriverHashState {
	const defaultState: ParsedDriverHashState = {
		hasState: false,
		filters: { ...DEFAULT_DRIVER_FILTERS },
		sort: { ...DEFAULT_DRIVER_SORT },
		visibleColumns: createDefaultVisibleColumns(config)
	};

	if (!hash) {
		return defaultState;
	}

	const normalizedHash = hash.startsWith('#') ? hash.slice(1) : hash;
	const params = new URLSearchParams(normalizedHash);
	if (params.get('v') !== '1') {
		return defaultState;
	}

	const filters: DriverFilters = { ...DEFAULT_DRIVER_FILTERS };
	for (const [alias, key] of Object.entries(FILTER_KEY_BY_ALIAS)) {
		const rawValue = params.get(alias);
		if (rawValue === null) {
			continue;
		}

		const normalizedValue = normalizeFilterHashValue(key, rawValue);
		if (
			key === 'is64Bit' ||
			key === 'isWHQL' ||
			key === 'isRecommended' ||
			key === 'isDC' ||
			key === 'isCRD' ||
			key === 'isBeta' ||
			key === 'isFeaturePreview'
		) {
			filters[key] = normalizedValue as '' | '0' | '1';
		} else {
			filters[key] = normalizedValue;
		}
	}

	const sortValue = params.get('s');
	let sort: DriverSort = { ...DEFAULT_DRIVER_SORT };
	if (sortValue) {
		const [sortAlias, directionAlias] = sortValue.split('.', 2);
		const sortKey = COLUMN_KEY_BY_ALIAS[sortAlias];
		if (sortKey && (directionAlias === 'a' || directionAlias === 'd')) {
			sort = {
				key: sortKey,
				direction: directionAlias === 'a' ? 'asc' : 'desc'
			};
		}
	}

	const visibleColumns = createDefaultVisibleColumns(config);
	if (params.has('c')) {
		for (const key of config.columnOrder) {
			visibleColumns[key] = false;
		}

		const columnAliases = params
			.get('c')
			?.split(',')
			.map((value) => value.trim())
			.filter(Boolean);

		for (const alias of columnAliases || []) {
			const columnKey = COLUMN_KEY_BY_ALIAS[alias];
			if (columnKey) {
				visibleColumns[columnKey] = true;
			}
		}

		for (const key of config.requiredColumns) {
			visibleColumns[key] = true;
		}
	}

	return {
		hasState: true,
		filters,
		sort,
		visibleColumns
	};
}

export function getFilterSignature(filters: DriverFilters): string {
	return JSON.stringify({
		id: filters.id.trim(),
		version: filters.version.trim(),
		displayVersion: filters.displayVersion.trim(),
		release: filters.release.trim(),
		name: filters.name.trim(),
		productTypeValue: filters.productTypeValue,
		seriesValue: filters.seriesValue,
		productValue: filters.productValue,
		osValue: filters.osValue,
		languageValue: filters.languageValue,
		is64Bit: filters.is64Bit,
		isWHQL: filters.isWHQL,
		isRecommended: filters.isRecommended,
		isDC: filters.isDC,
		isCRD: filters.isCRD,
		isBeta: filters.isBeta,
		isFeaturePreview: filters.isFeaturePreview
	});
}

export function isSearchCurrent(snapshot: SearchStateSnapshot): boolean {
	return (
		snapshot.hasSearched &&
		snapshot.appliedDatabaseRevision === snapshot.databaseRevision &&
		getFilterSignature(snapshot.draftFilters) === getFilterSignature(snapshot.appliedFilters)
	);
}

export function getLookupOptions(
	values: LookupValue[],
	typeId: LookupTypeId,
	parentValue = ''
): LookupValue[] {
	return values.filter((value) => {
		if (value.typeId !== typeId) {
			return false;
		}

		if (!parentValue) {
			return true;
		}

		return value.parentValue === parentValue;
	});
}

export function resolveLookupIds(filters: DriverFilters, values: LookupValue[]): ResolvedLookupIds {
	const findLookupId = (typeId: LookupTypeId, value: string): number | null =>
		values.find((entry) => entry.typeId === typeId && entry.value === value)?.lookupId ?? null;

	return {
		languageLookupId: filters.languageValue ? findLookupId(5, filters.languageValue) : null,
		osLookupId: filters.osValue ? findLookupId(4, filters.osValue) : null,
		productLookupId: filters.productValue ? findLookupId(3, filters.productValue) : null,
		productTypeLookupId: filters.productTypeValue ? findLookupId(1, filters.productTypeValue) : null,
		seriesLookupId: filters.seriesValue ? findLookupId(2, filters.seriesValue) : null
	};
}

function buildWhereClause(input: DriverQueryInput): SqlQuery {
	const conditions: string[] = [];
	const params: unknown[] = [];

	const idValue = input.filters.id.trim();
	if (idValue) {
		conditions.push('CAST(d.id AS TEXT) LIKE ?');
		params.push(`${idValue}%`);
	}

	for (const [key, textType] of Object.entries(TEXT_FILTER_TYPES) as Array<
		[keyof typeof TEXT_FILTER_TYPES, number]
	>) {
		const value = input.filters[key].trim();
		if (!value) {
			continue;
		}

		const textIdColumn = key === 'release'
			? 'd.release_text_id'
			: key === 'version'
				? 'd.version_text_id'
				: key === 'displayVersion'
					? 'd.display_version_text_id'
					: 'd.name_text_id';
		conditions.push(`
			${textIdColumn} IN (
				SELECT text_id
				FROM text_values
				WHERE text_type = ${textType}
					AND value LIKE ? COLLATE NOCASE
			)
		`);
		params.push(normalizePrefixValue(value));
	}

	for (const [key, columnSql] of EXACT_FILTERS) {
		const value = input.filters[key];
		if (!value) {
			continue;
		}

		conditions.push(`${columnSql} = ?`);
		params.push(Number(value));
	}

	if (input.filters.productTypeValue) {
		const productTypeLookupId = getResolvedLookupId(input, 'productTypeLookupId');
		if (productTypeLookupId === null) {
			conditions.push('0 = 1');
		} else {
			conditions.push(`instr(COALESCE(d.product_type_lookup_ids_text, ''), ?) > 0`);
			params.push(buildLookupMembershipToken(productTypeLookupId));
		}
	}

	if (input.filters.seriesValue) {
		const seriesLookupId = getResolvedLookupId(input, 'seriesLookupId');
		if (seriesLookupId === null) {
			conditions.push('0 = 1');
		} else {
			conditions.push(`instr(COALESCE(d.series_lookup_ids_text, ''), ?) > 0`);
			params.push(buildLookupMembershipToken(seriesLookupId));
		}
	}

	if (input.filters.productValue) {
		const productLookupId = getResolvedLookupId(input, 'productLookupId');
		if (productLookupId === null) {
			conditions.push('0 = 1');
		} else {
			conditions.push(`instr(COALESCE(d.product_lookup_ids_text, ''), ?) > 0`);
			params.push(buildLookupMembershipToken(productLookupId));
		}
	}

	if (input.filters.osValue) {
		const osLookupId = getResolvedLookupId(input, 'osLookupId');
		if (osLookupId === null) {
			conditions.push('0 = 1');
		} else {
			conditions.push('d.os_lookup_id = ?');
			params.push(osLookupId);
		}
	}

	if (input.filters.languageValue) {
		const languageLookupId = getResolvedLookupId(input, 'languageLookupId');
		if (languageLookupId === null) {
			conditions.push('0 = 1');
		} else {
			conditions.push('d.language_lookup_id = ?');
			params.push(languageLookupId);
		}
	}

	return {
		sql: conditions.length > 0 ? conditions.join(' AND ') : '1 = 1',
		params
	};
}

function buildOrderByClause(sort: DriverSort): string {
	const key = sort.key in SORT_EXPRESSIONS ? sort.key : DEFAULT_DRIVER_SORT.key;
	const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
	const expression = SORT_EXPRESSIONS[key];

	if (key === 'id') {
		return `ORDER BY ${expression} ${direction}`;
	}

	return `ORDER BY ${expression} ${direction}, d.id DESC`;
}

export function buildDriverCountQuery(input: DriverQueryInput): SqlQuery {
	const where = buildWhereClause(input);

	return {
		sql: `
			SELECT COUNT(*) AS totalRows
			FROM drivers d
			WHERE ${where.sql}
		`,
		params: where.params
	};
}

export function buildDriverPageQuery(input: DriverQueryInput): SqlQuery {
	const where = buildWhereClause(input);
	const offset = (input.page - 1) * input.pageSize;
	const orderBy = buildOrderByClause(usesWorkerSideSort(input.sort) ? DEFAULT_DRIVER_SORT : input.sort);

	return {
		sql: `
			SELECT
				d.id,
				'found' AS status,
				COALESCE(release_tv.value, '') AS release,
				COALESCE(version_tv.value, '') AS version,
				COALESCE(display_tv.value, '') AS displayVersion,
				d.release_date_unix AS releaseDateUnix,
				COALESCE(os_lv.name, d.os_name, '') AS osName,
				COALESCE(os_lv.code, d.os_code, '') AS osCode,
				COALESCE(language_lv.name, d.language_name, '') AS languageName,
				d.is_64_bit AS is64Bit,
				d.is_whql AS isWHQL,
				d.is_recommended AS isRecommended,
				d.is_dc AS isDC,
				d.is_crd AS isCRD,
				d.is_beta AS isBeta,
				d.is_feature_preview AS isFeaturePreview,
				COALESCE(name_tv.value, '') AS name,
				COALESCE(d.series_lookup_ids_text, '') AS seriesLookupIdsText,
				COALESCE(d.product_lookup_ids_text, '') AS productLookupIdsText
			FROM drivers d
			LEFT JOIN text_values release_tv
				ON release_tv.text_id = d.release_text_id
			LEFT JOIN text_values version_tv
				ON version_tv.text_id = d.version_text_id
			LEFT JOIN text_values display_tv
				ON display_tv.text_id = d.display_version_text_id
			LEFT JOIN text_values name_tv
				ON name_tv.text_id = d.name_text_id
			LEFT JOIN lookup_values os_lv
				ON os_lv.lookup_id = d.os_lookup_id
			LEFT JOIN lookup_values language_lv
				ON language_lv.lookup_id = d.language_lookup_id
			WHERE ${where.sql}
			${orderBy}
			LIMIT ? OFFSET ?
		`,
		params: [...where.params, input.pageSize, offset]
	};
}

export function buildDriverMembershipQuery(input: DriverQueryInput): SqlQuery {
	const where = buildWhereClause(input);

	return {
		sql: `
			SELECT
				d.id,
				COALESCE(display_tv.value, '') AS displayVersion,
				COALESCE(d.series_lookup_ids_text, '') AS seriesLookupIdsText,
				COALESCE(d.product_lookup_ids_text, '') AS productLookupIdsText
			FROM drivers d
			LEFT JOIN text_values display_tv
				ON display_tv.text_id = d.display_version_text_id
			WHERE ${where.sql}
		`,
		params: where.params
	};
}

export function buildDriverRowsByIdsQuery(ids: number[]): SqlQuery {
	if (ids.length === 0) {
		return {
			sql: `
				SELECT
					d.id,
					'found' AS status,
					COALESCE(release_tv.value, '') AS release,
					COALESCE(version_tv.value, '') AS version,
					COALESCE(display_tv.value, '') AS displayVersion,
					d.release_date_unix AS releaseDateUnix,
					COALESCE(os_lv.name, d.os_name, '') AS osName,
					COALESCE(os_lv.code, d.os_code, '') AS osCode,
					COALESCE(language_lv.name, d.language_name, '') AS languageName,
					d.is_64_bit AS is64Bit,
					d.is_whql AS isWHQL,
					d.is_recommended AS isRecommended,
					d.is_dc AS isDC,
					d.is_crd AS isCRD,
					d.is_beta AS isBeta,
					d.is_feature_preview AS isFeaturePreview,
					COALESCE(name_tv.value, '') AS name,
					COALESCE(d.series_lookup_ids_text, '') AS seriesLookupIdsText,
					COALESCE(d.product_lookup_ids_text, '') AS productLookupIdsText
				FROM drivers d
				LEFT JOIN text_values release_tv
					ON release_tv.text_id = d.release_text_id
				LEFT JOIN text_values version_tv
					ON version_tv.text_id = d.version_text_id
				LEFT JOIN text_values display_tv
					ON display_tv.text_id = d.display_version_text_id
				LEFT JOIN text_values name_tv
					ON name_tv.text_id = d.name_text_id
				LEFT JOIN lookup_values os_lv
					ON os_lv.lookup_id = d.os_lookup_id
				LEFT JOIN lookup_values language_lv
					ON language_lv.lookup_id = d.language_lookup_id
				WHERE 0 = 1
			`,
			params: []
		};
	}

	const placeholders = ids.map(() => '?').join(', ');
	return {
		sql: `
			SELECT
				d.id,
				'found' AS status,
				COALESCE(release_tv.value, '') AS release,
				COALESCE(version_tv.value, '') AS version,
				COALESCE(display_tv.value, '') AS displayVersion,
				d.release_date_unix AS releaseDateUnix,
				COALESCE(os_lv.name, d.os_name, '') AS osName,
				COALESCE(os_lv.code, d.os_code, '') AS osCode,
				COALESCE(language_lv.name, d.language_name, '') AS languageName,
				d.is_64_bit AS is64Bit,
				d.is_whql AS isWHQL,
				d.is_recommended AS isRecommended,
				d.is_dc AS isDC,
				d.is_crd AS isCRD,
				d.is_beta AS isBeta,
				d.is_feature_preview AS isFeaturePreview,
				COALESCE(name_tv.value, '') AS name,
				COALESCE(d.series_lookup_ids_text, '') AS seriesLookupIdsText,
				COALESCE(d.product_lookup_ids_text, '') AS productLookupIdsText
			FROM drivers d
			LEFT JOIN text_values release_tv
				ON release_tv.text_id = d.release_text_id
			LEFT JOIN text_values version_tv
				ON version_tv.text_id = d.version_text_id
			LEFT JOIN text_values display_tv
				ON display_tv.text_id = d.display_version_text_id
			LEFT JOIN text_values name_tv
				ON name_tv.text_id = d.name_text_id
			LEFT JOIN lookup_values os_lv
				ON os_lv.lookup_id = d.os_lookup_id
			LEFT JOIN lookup_values language_lv
				ON language_lv.lookup_id = d.language_lookup_id
			WHERE d.id IN (${placeholders})
		`,
		params: ids
	};
}

export function buildDriverDetailQuery(driverId: number): SqlQuery {
	return {
		sql: `
			SELECT
				d.driver_id AS driverId,
				COALESCE(gfe_tv.value, '') AS gfeDisplayVersion,
				d.download_file_size_bytes AS downloadFileSizeBytes,
				COALESCE(note_release.encoding, '') AS releaseNotesEncoding,
				note_release.value_gzip AS releaseNotesGzip,
				COALESCE(note_other.encoding, '') AS otherNotesEncoding,
				note_other.value_gzip AS otherNotesGzip,
				COALESCE(dr.series_lookup_ids_text, '') AS seriesLookupIdsText,
				COALESCE(dr.product_lookup_ids_text, '') AS productLookupIdsText,
				d.details_url_value AS detailsUrlValue,
				d.details_url_template_kind AS detailsUrlTemplateKind,
				d.details_url_host_id AS detailsUrlHostId,
				COALESCE(d.details_url_locale_segment, '') AS detailsUrlLocaleSegment,
				d.download_url_value AS downloadUrlValue,
				d.download_url_template_kind AS downloadUrlTemplateKind,
				d.download_url_host_id AS downloadUrlHostId,
				COALESCE(dp.path, '') AS downloadUrlPath,
				COALESCE(d.extra_fields_json, '{}') AS extraFieldsJson
			FROM driver_detail d
			LEFT JOIN drivers dr
				ON dr.id = d.driver_id
			LEFT JOIN text_values gfe_tv
				ON gfe_tv.text_id = d.gfe_display_version_text_id
			LEFT JOIN note_values note_release
				ON note_release.note_id = d.release_notes_note_id
			LEFT JOIN note_values note_other
				ON note_other.note_id = d.other_notes_note_id
			LEFT JOIN download_url_paths dp
				ON dp.path_id = d.download_url_path_id
			WHERE d.driver_id = ?
			LIMIT 1
		`,
		params: [driverId]
	};
}

export function normalizeStatusCounts(rows: StatusCountRow[]): StatusCounts {
	const counts: StatusCounts = {
		found: 0,
		confirmedNotFound: 0,
		pendingFrontier: 0
	};

	for (const row of rows) {
		if (row.status === 'found') {
			counts.found = Number(row.count);
		} else if (row.status === 'confirmed_not_found') {
			counts.confirmedNotFound = Number(row.count);
		} else if (row.status === 'pending_frontier') {
			counts.pendingFrontier = Number(row.count);
		}
	}

	return counts;
}
