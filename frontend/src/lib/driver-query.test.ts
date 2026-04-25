import { describe, expect, it } from 'vitest';
import { compareNvidiaDottedVersions } from './cuda-compat';
import {
	buildDriverCountQuery,
	buildDriverDetailQuery,
	buildDriverMembershipQuery,
	buildDriverPageQuery,
	buildDriverRowsByIdsQuery,
	DEFAULT_DRIVER_FILTERS,
	DEFAULT_DRIVER_SORT,
	DEFAULT_PAGE_SIZE,
	formatBooleanValue,
	getFilterSignature,
	getLookupOptions,
	isSearchCurrent,
	LARGEST_CONFIRMED_NOT_FOUND_GAP_QUERY,
	LOOKUP_SOURCES_QUERY,
	LOOKUP_VALUES_QUERY,
	normalizeStatusCounts,
	parseDriverHashState,
	PAGE_SIZE_OPTIONS,
	resolveLookupIds,
	serializeDriverHashState,
	usesWorkerSideSort,
	type DriverQueryInput,
	type DriverHashColumnConfig,
	type LookupValue
} from './driver-query';

const sampleLookupValues: LookupValue[] = [
	{
		lookupId: 10,
		typeId: 1,
		lookupName: 'product_type',
		value: '1',
		name: 'GeForce',
		parentLookupId: null,
		parentTypeId: null,
		parentValue: '',
		code: '',
		requiresProduct: '',
		isSelectLess: '',
		ordinal: 0
	},
	{
		lookupId: 11,
		typeId: 2,
		lookupName: 'product_series',
		value: '131',
		name: 'GeForce RTX 50 Series',
		parentLookupId: 10,
		parentTypeId: 1,
		parentValue: '1',
		code: '',
		requiresProduct: 'True',
		isSelectLess: 'False',
		ordinal: 0
	},
	{
		lookupId: 15,
		typeId: 2,
		lookupName: 'product_series',
		value: '130',
		name: 'BlueField DPU',
		parentLookupId: null,
		parentTypeId: 1,
		parentValue: '12',
		code: '',
		requiresProduct: 'True',
		isSelectLess: 'False',
		ordinal: 1
	},
	{
		lookupId: 12,
		typeId: 3,
		lookupName: 'product',
		value: '1066',
		name: 'NVIDIA GeForce RTX 5090',
		parentLookupId: 11,
		parentTypeId: 2,
		parentValue: '131',
		code: '',
		requiresProduct: '',
		isSelectLess: '',
		ordinal: 2
	},
	{
		lookupId: 13,
		typeId: 4,
		lookupName: 'operating_system',
		value: '135',
		name: 'Windows 11',
		parentLookupId: null,
		parentTypeId: null,
		parentValue: '',
		code: '10.0',
		requiresProduct: '',
		isSelectLess: '',
		ordinal: 0
	},
	{
		lookupId: 14,
		typeId: 5,
		lookupName: 'language',
		value: '1',
		name: 'English (US)',
		parentLookupId: null,
		parentTypeId: null,
		parentValue: '',
		code: '',
		requiresProduct: '',
		isSelectLess: '',
		ordinal: 0
	}
];

const sampleHashColumnConfig: DriverHashColumnConfig = {
	columnOrder: [
		'id',
		'release',
		'version',
		'displayVersion',
		'osName',
		'languageName',
		'name',
		'releaseDateTime',
		'seriesNames',
		'productNames',
		'osCode',
		'is64Bit',
		'isWHQL',
		'isRecommended',
		'isDC',
		'isCRD',
		'isBeta',
		'isFeaturePreview'
	],
	defaultVisibleColumns: {
		id: true,
		release: true,
		version: true,
		displayVersion: true,
		osName: true,
		languageName: true,
		name: true,
		releaseDateTime: true,
		seriesNames: false,
		productNames: false,
		osCode: false,
		is64Bit: false,
		isWHQL: false,
		isRecommended: false,
		isDC: false,
		isCRD: false,
		isBeta: false,
		isFeaturePreview: false
	},
	requiredColumns: ['id', 'release', 'version', 'displayVersion', 'osName', 'languageName', 'name']
};

function buildInput(filters = DEFAULT_DRIVER_FILTERS): DriverQueryInput {
	return {
		filters,
		page: 1,
		pageSize: DEFAULT_PAGE_SIZE,
		resolvedLookupIds: resolveLookupIds(filters, sampleLookupValues),
		sort: DEFAULT_DRIVER_SORT
	};
}

describe('driver-query', () => {
	it('builds prefix and AND-based filters for the driver page query', () => {
		const query = buildDriverPageQuery({
			...buildInput({
				...DEFAULT_DRIVER_FILTERS,
				languageValue: '',
				version: '55',
				isWHQL: '1',
				isBeta: '1'
			}),
			page: 3,
			pageSize: 1000
		});

		expect(query.sql).toContain('d.version_text_id IN');
		expect(query.sql).toContain('d.is_beta = ?');
		expect(query.sql).not.toContain('LEFT JOIN driver_detail');
		expect(query.sql).not.toContain('releaseNotes');
		expect(query.sql).not.toContain('confirmed_not_found');
		expect(query.sql).toContain('ORDER BY d.id DESC');
		expect(query.params).toEqual(['55%', 1, 1, 1000, 2000]);
	});

	it('builds the count query while ignoring blank filters', () => {
		const query = buildDriverCountQuery(buildInput());

		expect(query.sql).toContain('COUNT(*) AS totalRows');
		expect(query.params).toEqual([14]);
	});

	it('builds parameter-free count and membership queries when lookup-backed filters are blank', () => {
		const input = buildInput({
			...DEFAULT_DRIVER_FILTERS,
			languageValue: '',
			osValue: '',
			productTypeValue: '',
			seriesValue: '',
			productValue: ''
		});
		const countQuery = buildDriverCountQuery(input);
		const membershipQuery = buildDriverMembershipQuery(input);

		expect(countQuery.sql).toContain('WHERE 1 = 1');
		expect(countQuery.params).toEqual([]);
		expect(membershipQuery.sql).toContain('WHERE 1 = 1');
		expect(membershipQuery.params).toEqual([]);
	});

	it('builds lookup-backed hierarchy filters for product, OS, and language', () => {
		const filters = {
			...DEFAULT_DRIVER_FILTERS,
			productTypeValue: '1',
			seriesValue: '131',
			productValue: '1066',
			osValue: '135',
			languageValue: '1'
		};
		const query = buildDriverPageQuery({
			...buildInput(filters),
			page: 1,
			pageSize: 100
		});

		expect(query.sql).toContain("instr(COALESCE(d.product_type_lookup_ids_text, ''), ?) > 0");
		expect(query.sql).toContain("instr(COALESCE(d.series_lookup_ids_text, ''), ?) > 0");
		expect(query.sql).toContain("instr(COALESCE(d.product_lookup_ids_text, ''), ?) > 0");
		expect(query.sql).toContain('d.os_lookup_id = ?');
		expect(query.sql).toContain('d.language_lookup_id = ?');
		expect(query.params).toEqual(['|10|', '|11|', '|12|', 13, 14, 100, 0]);
	});

	it('does not expose lookup-backed text filters in browser query filters', () => {
		expect(Object.keys(DEFAULT_DRIVER_FILTERS)).not.toContain('osCode');
		expect(Object.keys(DEFAULT_DRIVER_FILTERS)).not.toContain('osName');
		expect(Object.keys(DEFAULT_DRIVER_FILTERS)).not.toContain('languageName');
		expect(Object.keys(DEFAULT_DRIVER_FILTERS)).not.toContain('series');
		expect(Object.keys(DEFAULT_DRIVER_FILTERS)).not.toContain('product');
	});

	it('defines lookup table queries and filters cascading child options', () => {
		expect(LOOKUP_VALUES_QUERY).toContain('lookup_id AS lookupId');
		expect(LOOKUP_VALUES_QUERY).toContain('LEFT JOIN lookup_values parent');
		expect(LOOKUP_SOURCES_QUERY).toContain('FROM lookup_sources');

		expect(getLookupOptions([...sampleLookupValues], 2, '1').map((value) => value.name)).toEqual([
			'GeForce RTX 50 Series'
		]);
		expect(getLookupOptions([...sampleLookupValues], 3, '131').map((value) => value.name)).toEqual([
			'NVIDIA GeForce RTX 5090'
		]);
		expect(
			resolveLookupIds(
				{
					...DEFAULT_DRIVER_FILTERS,
					productTypeValue: '1',
					seriesValue: '131',
					productValue: '1066',
					osValue: '135',
					languageValue: '1'
				},
				sampleLookupValues
			)
		).toEqual({
			languageLookupId: 14,
			osLookupId: 13,
			productLookupId: 12,
			productTypeLookupId: 10,
			seriesLookupId: 11
		});
	});

	it('tracks staged search state and boolean display labels', () => {
		const draftFilters = {
			...DEFAULT_DRIVER_FILTERS,
			version: '551 '
		};
		const appliedFilters = {
			...DEFAULT_DRIVER_FILTERS,
			version: '551'
		};

		expect(formatBooleanValue('1')).toBe('yes');
		expect(formatBooleanValue('0')).toBe('no');
		expect(formatBooleanValue('', 'any')).toBe('any');
		expect(getFilterSignature(draftFilters)).toBe(getFilterSignature(appliedFilters));
		expect(
			isSearchCurrent({
				appliedDatabaseRevision: 2,
				appliedFilters,
				databaseRevision: 2,
				draftFilters,
				hasSearched: true
			})
		).toBe(true);
		expect(
			isSearchCurrent({
				appliedDatabaseRevision: 1,
				appliedFilters,
				databaseRevision: 2,
				draftFilters,
				hasSearched: true
			})
		).toBe(false);
		expect(
			isSearchCurrent({
				appliedDatabaseRevision: 2,
				appliedFilters,
				databaseRevision: 2,
				draftFilters: { ...draftFilters, release: '595' },
				hasSearched: true
			})
		).toBe(false);
	});

	it('serializes default hash state compactly and restores defaults when hash is absent', () => {
		expect(
			serializeDriverHashState(
				{
					filters: { ...DEFAULT_DRIVER_FILTERS },
					sort: { ...DEFAULT_DRIVER_SORT },
					visibleColumns: { ...sampleHashColumnConfig.defaultVisibleColumns }
				},
				sampleHashColumnConfig
			)
		).toBe('#v=1');

		expect(parseDriverHashState('', sampleHashColumnConfig)).toEqual({
			hasState: false,
			filters: { ...DEFAULT_DRIVER_FILTERS },
			sort: { ...DEFAULT_DRIVER_SORT },
			visibleColumns: { ...sampleHashColumnConfig.defaultVisibleColumns }
		});
	});

	it('serializes and restores compact hash state without paging', () => {
		const hash = serializeDriverHashState(
			{
				filters: {
					...DEFAULT_DRIVER_FILTERS,
					productTypeValue: '1',
					seriesValue: '131',
					productValue: '1066',
					osValue: '135',
					version: ' 596 ',
					isRecommended: '1'
				},
				sort: {
					key: 'release',
					direction: 'asc'
				},
				visibleColumns: {
					...sampleHashColumnConfig.defaultVisibleColumns,
					seriesNames: true,
					productNames: true,
					releaseDateTime: false
				}
			},
			sampleHashColumnConfig
		);

		expect(hash).toContain('#v=1');
		expect(hash).toContain('pt=1');
		expect(hash).toContain('ve=596');
		expect(hash).toContain('rc=1');
		expect(hash).toContain('s=re.a');
		expect(hash).toContain('c=');
		expect(hash).not.toContain('page=');
		expect(hash).not.toContain('limit=');

		expect(parseDriverHashState(hash, sampleHashColumnConfig)).toEqual({
			hasState: true,
			filters: {
				...DEFAULT_DRIVER_FILTERS,
				productTypeValue: '1',
				seriesValue: '131',
				productValue: '1066',
				osValue: '135',
				version: '596',
				isRecommended: '1'
			},
			sort: {
				key: 'release',
				direction: 'asc'
			},
			visibleColumns: {
				...sampleHashColumnConfig.defaultVisibleColumns,
				seriesNames: true,
				productNames: true,
				releaseDateTime: false
			}
		});
	});

	it('falls back safely for invalid hash state and preserves required columns', () => {
		const parsed = parseDriverHashState(
			'#v=1&wh=9&s=bogus.x&c=be,unknown',
			sampleHashColumnConfig
		);

		expect(parsed.hasState).toBe(true);
		expect(parsed.filters.isWHQL).toBe('');
		expect(parsed.sort).toEqual(DEFAULT_DRIVER_SORT);
		expect(parsed.visibleColumns.isBeta).toBe(true);
		expect(parsed.visibleColumns.id).toBe(true);
		expect(parsed.visibleColumns.release).toBe(true);
		expect(parsed.visibleColumns.version).toBe(true);
		expect(parsed.visibleColumns.displayVersion).toBe(true);
		expect(parsed.visibleColumns.osName).toBe(true);
		expect(parsed.visibleColumns.languageName).toBe(true);
		expect(parsed.visibleColumns.name).toBe(true);
		expect(parsed.visibleColumns.releaseDateTime).toBe(false);
		expect(parseDriverHashState('#pt=1', sampleHashColumnConfig)).toEqual({
			hasState: false,
			filters: { ...DEFAULT_DRIVER_FILTERS },
			sort: { ...DEFAULT_DRIVER_SORT },
			visibleColumns: { ...sampleHashColumnConfig.defaultVisibleColumns }
		});
	});

	it('builds custom per-column ordering for browser queries', () => {
		const query = buildDriverPageQuery({
			...buildInput(),
			page: 1,
			pageSize: 100,
			sort: {
				key: 'release',
				direction: 'asc'
			}
		});

		expect(query.sql).toContain("ORDER BY COALESCE(release_tv.value, '') COLLATE NOCASE ASC, d.id DESC");
	});

	it('uses worker-side sort for series/product ordering and summary normalization helpers', () => {
		expect(
			usesWorkerSideSort({
				key: 'productNames',
				direction: 'asc'
			})
		).toBe(true);
		expect(
			usesWorkerSideSort({
				key: 'displayVersion',
				direction: 'asc'
			})
		).toBe(true);

		const membershipQuery = buildDriverMembershipQuery({
			...buildInput(),
			page: 1,
			pageSize: 100,
			sort: {
				key: 'productNames',
				direction: 'asc'
			}
		});

		expect(membershipQuery.sql).toContain('series_lookup_ids_text');
		expect(membershipQuery.sql).toContain('product_lookup_ids_text');
		expect(membershipQuery.sql).toContain("COALESCE(display_tv.value, '') AS displayVersion");
		expect(buildDriverRowsByIdsQuery([5, 2, 1]).params).toEqual([5, 2, 1]);
		expect(buildDriverDetailQuery(7).sql).toContain('FROM driver_detail d');
		expect(buildDriverDetailQuery(7).sql).toContain('LEFT JOIN drivers dr');
		expect(buildDriverDetailQuery(7).sql).toContain('LEFT JOIN note_values note_release');
		expect(buildDriverDetailQuery(7).sql).toContain('note_release.value_gzip AS releaseNotesGzip');
		expect(buildDriverDetailQuery(7).sql).toContain('note_other.value_gzip AS otherNotesGzip');
		expect(buildDriverDetailQuery(7).sql).toContain("COALESCE(dr.series_lookup_ids_text, '') AS seriesLookupIdsText");
		expect(buildDriverDetailQuery(7).sql).toContain(
			"COALESCE(dr.product_lookup_ids_text, '') AS productLookupIdsText"
		);
		expect(buildDriverDetailQuery(7).sql).toContain('d.details_url_value AS detailsUrlValue');
		expect(buildDriverDetailQuery(7).sql).toContain('LEFT JOIN download_url_paths dp');
		expect(buildDriverDetailQuery(7).sql).toContain("COALESCE(dp.path, '') AS downloadUrlPath");
		expect(LOOKUP_VALUES_QUERY).toContain('lv.parent_lookup_id AS parentLookupId');
		expect(
			normalizeStatusCounts([
				{ status: 'found', count: 4 },
				{ status: 'confirmed_not_found', count: 2 },
				{ status: 'pending_frontier', count: 1 }
			])
		).toEqual({
			found: 4,
			confirmedNotFound: 2,
			pendingFrontier: 1
		});
		expect(compareNvidiaDottedVersions('580.142', '580.65.06')).toBe(1);

		expect(PAGE_SIZE_OPTIONS).toEqual([100, 1000, 10000]);
		expect(LARGEST_CONFIRMED_NOT_FOUND_GAP_QUERY).toContain('FROM browser_stats');
	});
});
