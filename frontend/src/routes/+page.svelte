<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { getLinuxCudaDisplayTooltip } from '$lib/cuda-compat';
	import { resolveDatabaseSource, type DatabaseSource } from '$lib/database-source';
	import {
		queryDriverDetail,
		queryDatabaseSummary,
		queryDriverPage,
		queryLookupCatalog,
		type DatabaseSummary,
		type DriverRowDetail,
		type DriverProductGroup,
		type DriverRow
	} from '$lib/driver-data';
	import {
		DEFAULT_DRIVER_FILTERS,
		DEFAULT_DRIVER_SORT,
		DEFAULT_PAGE_SIZE,
		formatBooleanValue,
		getLookupOptions,
		isSearchCurrent,
		parseDriverHashState,
		PAGE_SIZE_OPTIONS,
		resolveLookupIds,
		serializeDriverHashState,
		type DriverFilters,
		type DriverHashColumnConfig,
		type LookupCatalog,
		type DriverSort,
		type DriverSortKey,
		type LookupTypeId,
		type LookupValue
	} from '$lib/driver-query';
	import {
		createSqliteDatabase,
		DatabaseLoadError,
		type SqliteDatabase
	} from '$lib/sqlite-browser';

	type ColumnKey = DriverSortKey;

	interface ColumnDefinition {
		key: ColumnKey;
		label: string;
		optional: boolean;
		width: string;
	}

	interface ActiveFilterChip {
		key: keyof DriverFilters;
		label: string;
		value: string;
	}

	interface DetailFact {
		label: string;
		value: string;
	}

	const MOBILE_DETAIL_MEDIA_QUERY = '(max-width: 1045px)';
	const PROJECT_NOTE_ACKNOWLEDGED_KEY =
		'binary-person/nvidia-driver-database/acknowleged';
	const DIAGNOSTICS_OPEN_SEQUENCE = [
		'ArrowUp',
		'ArrowUp',
		'ArrowDown',
		'ArrowDown',
		'ArrowLeft',
		'ArrowRight',
		'ArrowLeft',
		'ArrowRight'
	] as const;
	const DIAGNOSTICS_CLOSE_SEQUENCE = [
		'ArrowRight',
		'ArrowLeft',
		'ArrowRight',
		'ArrowLeft',
		'ArrowDown',
		'ArrowDown',
		'ArrowUp',
		'ArrowUp'
	] as const;

	const columns: ColumnDefinition[] = [
		{ key: 'id', label: 'id', optional: false, width: '6rem' },
		{ key: 'release', label: 'release', optional: false, width: '6rem' },
		{ key: 'version', label: 'version', optional: false, width: '7rem' },
		{ key: 'displayVersion', label: 'display', optional: false, width: '8rem' },
		{ key: 'osName', label: 'os', optional: false, width: '12rem' },
		{ key: 'languageName', label: 'lang', optional: false, width: '10rem' },
		{ key: 'name', label: 'driver', optional: false, width: '18rem' },
		{ key: 'releaseDateTime', label: 'date', optional: true, width: '12rem' },
		{ key: 'seriesNames', label: 'series', optional: true, width: '16rem' },
		{ key: 'productNames', label: 'products', optional: true, width: '18rem' },
		{ key: 'osCode', label: 'os_code', optional: true, width: '9rem' },
		{ key: 'is64Bit', label: '64bit', optional: true, width: '6rem' },
		{ key: 'isWHQL', label: 'whql', optional: true, width: '6rem' },
		{ key: 'isRecommended', label: 'recommended', optional: true, width: '9rem' },
		{ key: 'isDC', label: 'dc', optional: true, width: '5rem' },
		{ key: 'isCRD', label: 'crd', optional: true, width: '5rem' },
		{ key: 'isBeta', label: 'beta', optional: true, width: '5rem' },
		{ key: 'isFeaturePreview', label: 'feature_preview', optional: true, width: '11rem' }
	];

	const defaultVisibleColumns: Record<ColumnKey, boolean> = {
		id: true,
		release: true,
		releaseDateTime: true,
		version: true,
		displayVersion: true,
		osName: true,
		languageName: true,
		name: true,
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
	};

	const hashColumnConfig: DriverHashColumnConfig = {
		columnOrder: columns.map((column) => column.key),
		defaultVisibleColumns,
		requiredColumns: columns.filter((column) => !column.optional).map((column) => column.key)
	};

	const booleanColumnKeys = new Set<ColumnKey>([
		'is64Bit',
		'isWHQL',
		'isRecommended',
		'isDC',
		'isCRD',
		'isBeta',
		'isFeaturePreview'
	]);

	const booleanFilterDefinitions = [
		{ key: 'is64Bit', label: '64bit', title: 'Raw NVIDIA Is64Bit flag.' },
		{ key: 'isWHQL', label: 'whql', title: 'Raw NVIDIA IsWHQL flag.' },
		{ key: 'isRecommended', label: 'recommended', title: 'Raw NVIDIA IsRecommended flag.' },
		{ key: 'isBeta', label: 'beta', title: 'Raw NVIDIA IsBeta flag.' },
		{
			key: 'isFeaturePreview',
			label: 'feature preview',
			title: 'Raw NVIDIA IsFeaturePreview flag.'
		},
		{ key: 'isDC', label: 'dc', title: 'Raw NVIDIA IsDC flag; maps to DCH-package rows in the current data.' },
		{
			key: 'isCRD',
			label: 'crd',
			title: 'Raw NVIDIA IsCRD flag; maps to Creator/Studio-driver rows in the current data.'
		}
	] as const;

	let database = $state<SqliteDatabase | null>(null);
	let source = $state<DatabaseSource | null>(null);
	let summary = $state<DatabaseSummary | null>(null);
	let lookupCatalog = $state<LookupCatalog>({ sources: [], values: [] });
	let rows = $state<DriverRow[]>([]);
	let totalRows = $state(0);
	let pageCount = $state(1);
	let currentPage = $state(1);
	let pageJumpValue = $state('1');
	let pageSize = $state<number>(DEFAULT_PAGE_SIZE);
	let sort = $state<DriverSort>({ ...DEFAULT_DRIVER_SORT });
	let draftFilters = $state<DriverFilters>({ ...DEFAULT_DRIVER_FILTERS });
	let appliedFilters = $state<DriverFilters>({ ...DEFAULT_DRIVER_FILTERS });
	let visibleColumns = $state<Record<ColumnKey, boolean>>({ ...defaultVisibleColumns });
	let diagnosticsOpen = $state(false);
	let moreFiltersOpen = $state(false);
	let columnsOpen = $state(false);
	let queryPanelCollapsed = $state(false);
	let loadingDatabase = $state(true);
	let queryingRows = $state(false);
	let errorMessage = $state('');
	let refreshNonce = $state<number | null>(null);
	let expandedRowId = $state<number | null>(null);
	let detailLoadingById = $state<Record<number, boolean>>({});
	let queryFieldsetElement = $state<HTMLFieldSetElement | null>(null);
	let pageSizeSelectElement = $state<HTMLSelectElement | null>(null);
	let pageJumpInputElement = $state<HTMLInputElement | null>(null);
	let rowsRequestVersion = 0;
	let databaseRevision = $state(0);
	let appliedDatabaseRevision = $state(-1);
	let hasSearched = $state(false);
	let mobileDetailMode = $state(false);
	let projectNoteAcknowledged = $state(false);

	const lookupValues = $derived(lookupCatalog.values);
	const productTypeOptions = $derived(getLookupOptions(lookupValues, 1));
	const seriesOptions = $derived(
		draftFilters.productTypeValue
			? getLookupOptions(lookupValues, 2, draftFilters.productTypeValue)
			: []
	);
	const productOptions = $derived(
		draftFilters.seriesValue ? getLookupOptions(lookupValues, 3, draftFilters.seriesValue) : []
	);
	const osOptions = $derived(getLookupOptions(lookupValues, 4));
	const languageOptions = $derived(getLookupOptions(lookupValues, 5));
	const visibleColumnList = $derived(columns.filter((column) => visibleColumns[column.key]));
	const activeFilterChips = $derived(buildActiveFilterChips(draftFilters, lookupValues));
	const appliedFilterChips = $derived(buildActiveFilterChips(appliedFilters, lookupValues));
	const resultRangeStart = $derived(totalRows === 0 ? 0 : (currentPage - 1) * pageSize + 1);
	const resultRangeEnd = $derived(Math.min(totalRows, currentPage * pageSize));
	const busy = $derived(loadingDatabase || queryingRows);
	const expandedRow = $derived(
		expandedRowId === null ? null : rows.find((row) => row.id === expandedRowId) || null
	);
	const searchCurrent = $derived(
		isSearchCurrent({
			appliedDatabaseRevision,
			appliedFilters,
			databaseRevision,
			draftFilters,
			hasSearched
		})
	);
	const canSearch = $derived(Boolean(database) && !loadingDatabase && !searchCurrent);

	function renderValue(value: string | number | string[] | null | undefined): string {
		if (Array.isArray(value)) {
			return value.length ? value.join(', ') : '-';
		}

		if (value === null || value === undefined || value === '') {
			return '-';
		}

		return String(value);
	}

	function renderCellValue(row: DriverRow, key: ColumnKey): string {
		const value = row[key];

		if (booleanColumnKeys.has(key)) {
			return formatBooleanValue(value as string | number);
		}

		return renderValue(value);
	}

	function getCellTitle(row: DriverRow, key: ColumnKey): string {
		if (key === 'displayVersion') {
			return getLinuxCudaDisplayTooltip(row.osName, row.displayVersion) || renderCellValue(row, key);
		}

		return renderCellValue(row, key);
	}

	function renderBooleanDetail(value: string): string {
		return formatBooleanValue(value);
	}

	function getSortIndicator(columnKey: ColumnKey): string {
		if (sort.key !== columnKey) {
			return '';
		}

		return sort.direction === 'asc' ? '↑' : '↓';
	}

	function getAriaSort(columnKey: ColumnKey): 'ascending' | 'descending' | 'none' {
		if (sort.key !== columnKey) {
			return 'none';
		}

		return sort.direction === 'asc' ? 'ascending' : 'descending';
	}

	function renderNoteDetail(value: string): string {
		if (!value) {
			return '-';
		}

		if (typeof DOMParser === 'undefined') {
			return value;
		}

		const html = value
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(li|p|div|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, '$&\n');
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const text = doc.body.textContent
			?.replace(/[ \t]+\n/g, '\n')
			?.replace(/\n{3,}/g, '\n\n')
			?.trim();

		return text || value;
	}

	function getBooleanFilterLabel(key: (typeof booleanFilterDefinitions)[number]['key']): string {
		return booleanFilterDefinitions.find((definition) => definition.key === key)?.label || key;
	}

	function getProductGroups(row: DriverRow): DriverProductGroup[] {
		return row.productGroups || [];
	}

	function isDetailLoading(rowId: number): boolean {
		return Boolean(detailLoadingById[rowId]);
	}

	function formatDetailHeading(row: DriverRow): string {
		const headingParts = [renderValue(row.name), renderValue(row.version)].filter((value) => value !== '-');
		return headingParts.length > 0 ? headingParts.join(' ') : `driver ${row.id}`;
	}

	function getDetailOverviewFacts(row: DriverRow): DetailFact[] {
		return [
			{ label: 'date', value: renderValue(row.releaseDateTime) },
			{ label: 'os_code', value: renderValue(row.osCode) },
			{ label: 'file size', value: renderValue(row.downloadFileSize) }
		];
	}

	function getDetailFlagFacts(row: DriverRow): DetailFact[] {
		return [
			{ label: '64bit', value: renderBooleanDetail(row.is64Bit) },
			{ label: 'whql', value: renderBooleanDetail(row.isWHQL) },
			{ label: 'recommended', value: renderBooleanDetail(row.isRecommended) },
			{ label: 'beta', value: renderBooleanDetail(row.isBeta) },
			{ label: 'feature preview', value: renderBooleanDetail(row.isFeaturePreview) },
			{ label: 'dc', value: renderBooleanDetail(row.isDC) },
			{ label: 'crd', value: renderBooleanDetail(row.isCRD) }
		];
	}

	function buildActiveFilterChips(
		nextFilters: DriverFilters,
		nextLookupValues: LookupValue[]
	): ActiveFilterChip[] {
		const lookupLabel = (typeId: LookupTypeId, value: string) =>
			nextLookupValues.find((entry) => entry.typeId === typeId && entry.value === value)?.name || value;
		const chips: ActiveFilterChip[] = [];
		const textFilters: Array<[keyof DriverFilters, string]> = [
			['id', 'id'],
			['release', 'release'],
			['version', 'version'],
			['displayVersion', 'display'],
			['name', 'driver']
		];

		if (nextFilters.productTypeValue) {
			chips.push({
				key: 'productTypeValue',
				label: 'type',
				value: lookupLabel(1, nextFilters.productTypeValue)
			});
		}

		if (nextFilters.seriesValue) {
			chips.push({
				key: 'seriesValue',
				label: 'series',
				value: lookupLabel(2, nextFilters.seriesValue)
			});
		}

		if (nextFilters.productValue) {
			chips.push({
				key: 'productValue',
				label: 'product',
				value: lookupLabel(3, nextFilters.productValue)
			});
		}

		if (nextFilters.osValue) {
			chips.push({ key: 'osValue', label: 'os', value: lookupLabel(4, nextFilters.osValue) });
		}

		if (nextFilters.languageValue) {
			chips.push({
				key: 'languageValue',
				label: 'lang',
				value: lookupLabel(5, nextFilters.languageValue)
			});
		}

		for (const [key, label] of textFilters) {
			const value = nextFilters[key].trim();
			if (value) {
				chips.push({ key, label, value });
			}
		}

		for (const { key } of booleanFilterDefinitions) {
			if (nextFilters[key]) {
				chips.push({ key, label: getBooleanFilterLabel(key), value: formatBooleanValue(nextFilters[key]) });
			}
		}

		return chips;
	}

	function formatLargestGap(): string {
		if (!summary?.largestGap) {
			return 'none';
		}

		return `${summary.largestGap.startId}-${summary.largestGap.endId} (${summary.largestGap.length})`;
	}

	function formatActiveSource(): string {
		if (!source) {
			return 'loading';
		}

		return `${source.kind}:${source.label}`;
	}

	function parseExtraFields(row: DriverRow): string {
		try {
			const parsed = JSON.parse(row.extraFieldsJson || '{}');
			if (!parsed || Object.keys(parsed).length === 0) {
				return '';
			}

			return JSON.stringify(parsed, null, 2);
		} catch {
			return row.extraFieldsJson;
		}
	}

	function normalizeVisibleColumns(
		nextVisibleColumns: Record<ColumnKey, boolean>
	): Record<ColumnKey, boolean> {
		const normalizedVisibleColumns = { ...defaultVisibleColumns, ...nextVisibleColumns };
		for (const column of columns) {
			if (!column.optional) {
				normalizedVisibleColumns[column.key] = true;
			}
		}

		return normalizedVisibleColumns;
	}

	function normalizeFiltersForLookupValues(
		nextFilters: DriverFilters,
		nextLookupValues: LookupValue[]
	): DriverFilters {
		const normalizedFilters = { ...DEFAULT_DRIVER_FILTERS, ...nextFilters };

		if (
			normalizedFilters.productTypeValue &&
			!getLookupOptions(nextLookupValues, 1).some(
				(option) => option.value === normalizedFilters.productTypeValue
			)
		) {
			normalizedFilters.productTypeValue = '';
			normalizedFilters.seriesValue = '';
			normalizedFilters.productValue = '';
		}

		if (
			normalizedFilters.seriesValue &&
			!getLookupOptions(nextLookupValues, 2, normalizedFilters.productTypeValue).some(
				(option) => option.value === normalizedFilters.seriesValue
			)
		) {
			normalizedFilters.seriesValue = '';
			normalizedFilters.productValue = '';
		}

		if (
			normalizedFilters.productValue &&
			!getLookupOptions(nextLookupValues, 3, normalizedFilters.seriesValue).some(
				(option) => option.value === normalizedFilters.productValue
			)
		) {
			normalizedFilters.productValue = '';
		}

		if (
			normalizedFilters.osValue &&
			!getLookupOptions(nextLookupValues, 4).some((option) => option.value === normalizedFilters.osValue)
		) {
			normalizedFilters.osValue = '';
		}

		if (
			normalizedFilters.languageValue &&
			!getLookupOptions(nextLookupValues, 5).some(
				(option) => option.value === normalizedFilters.languageValue
			)
		) {
			normalizedFilters.languageValue = DEFAULT_DRIVER_FILTERS.languageValue;
		}

		return normalizedFilters;
	}

	function updateHashUrl(mode: 'push' | 'replace') {
		const nextHash = serializeDriverHashState(
			{
				filters: appliedFilters,
				sort,
				visibleColumns
			},
			hashColumnConfig
		);
		const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
		const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
		if (nextUrl === currentUrl) {
			return;
		}

		window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', nextUrl);
	}

	function applyHashState(nextLookupValues: LookupValue[], hash: string) {
		const parsed = parseDriverHashState(hash, hashColumnConfig);
		const normalizedFilters = normalizeFiltersForLookupValues(parsed.filters, nextLookupValues);

		draftFilters = { ...normalizedFilters };
		appliedFilters = { ...normalizedFilters };
		sort = { ...parsed.sort };
		visibleColumns = normalizeVisibleColumns(parsed.visibleColumns);
		currentPage = 1;
		expandedRowId = null;
		detailLoadingById = {};

		return parsed.hasState;
	}

	async function restoreSearchStateFromHash(
		nextLookupValues: LookupValue[],
		hash: string,
		mode: 'initial' | 'navigation'
	) {
		const hasHashState = applyHashState(nextLookupValues, hash);
		if (mode === 'initial' && !hasHashState) {
			return false;
		}

		await refreshRows(true);
		return true;
	}

	function clearFilter(key: keyof DriverFilters) {
		draftFilters[key] = '';

		if (key === 'productTypeValue') {
			draftFilters.seriesValue = '';
			draftFilters.productValue = '';
		}

		if (key === 'seriesValue') {
			draftFilters.productValue = '';
		}
	}

	function resetFilters() {
		draftFilters = { ...DEFAULT_DRIVER_FILTERS };
		expandedRowId = null;
		detailLoadingById = {};
		queryPanelCollapsed = false;
	}

	async function loadDatabase(forceRefresh = false) {
		loadingDatabase = true;
		errorMessage = '';
		rowsRequestVersion += 1;
		const nextDatabase = database ?? createSqliteDatabase();
		let shouldRunInitialSearch = false;

		try {
			source = resolveDatabaseSource({
				hostname: window.location.hostname,
				basePath: base,
				cacheBustToken: forceRefresh ? Date.now() : refreshNonce
			});

			await nextDatabase.load(source, forceRefresh);
			database = nextDatabase;
			lookupCatalog = await queryLookupCatalog(nextDatabase);
			summary = await queryDatabaseSummary(nextDatabase);
			databaseRevision += 1;
			shouldRunInitialSearch = !hasSearched;
			expandedRowId = null;
			detailLoadingById = {};
		} catch (error) {
			summary = null;
			lookupCatalog = { sources: [], values: [] };
			rows = [];
			totalRows = 0;
			pageCount = 1;

			if (!database) {
				await nextDatabase.close();
			}

			if (error instanceof DatabaseLoadError) {
				errorMessage = error.message;
			} else if (error instanceof Error) {
				errorMessage = error.message;
			} else {
				errorMessage = 'Failed to load the database.';
			}
		} finally {
			loadingDatabase = false;
		}

		if (shouldRunInitialSearch && !errorMessage) {
			const restoredFromHash = await restoreSearchStateFromHash(
				lookupCatalog.values,
				window.location.hash,
				'initial'
			);
			if (!restoredFromHash) {
				await runSearch(true);
			}
		}
	}

	async function refreshRows(markSearchCurrent = false) {
		if (!database || loadingDatabase) {
			rows = [];
			totalRows = 0;
			pageCount = 1;
			return;
		}

		const requestVersion = ++rowsRequestVersion;
		queryingRows = true;
		errorMessage = '';

		try {
			const result = await queryDriverPage(database, {
				filters: appliedFilters,
				page: currentPage,
				pageSize,
				resolvedLookupIds: resolveLookupIds(appliedFilters, lookupValues),
				sort
			});

			if (requestVersion !== rowsRequestVersion) {
				return;
			}

			totalRows = result.totalRows;
			pageCount = result.pageCount;
			rows = result.rows;
			detailLoadingById = {};

			if (currentPage > result.pageCount) {
				currentPage = result.pageCount;
			}

			if (markSearchCurrent) {
				appliedDatabaseRevision = databaseRevision;
				hasSearched = true;
			}
		} catch (error) {
			if (error instanceof Error) {
				errorMessage = error.message;
			} else {
				errorMessage = 'Query failed.';
			}
		} finally {
			queryingRows = false;
		}
	}

	async function runSearch(
		force = false,
		collapseAfterSearch = false,
		hashWriteMode: 'none' | 'push' = 'none'
	) {
		if (!database || busy || (!force && !canSearch)) {
			return;
		}

		appliedFilters = { ...draftFilters };
		currentPage = 1;
		expandedRowId = null;
		await refreshRows(true);

		if (!errorMessage) {
			if (hashWriteMode !== 'none') {
				updateHashUrl(hashWriteMode);
			}

			if (collapseAfterSearch) {
				queryPanelCollapsed = true;
			}
		}
	}

	function movePage(direction: -1 | 1) {
		if (busy || !hasSearched) {
			return;
		}

		const nextPage = currentPage + direction;
		if (nextPage < 1 || nextPage > pageCount) {
			return;
		}

		currentPage = nextPage;
		expandedRowId = null;
		void refreshRows();
	}

	function jumpToPage() {
		if (busy || !hasSearched) {
			pageJumpValue = String(currentPage);
			return;
		}

		const parsedPage = Number.parseInt(pageJumpValue.trim(), 10);

		if (!Number.isFinite(parsedPage)) {
			pageJumpValue = String(currentPage);
			return;
		}

		const nextPage = Math.min(Math.max(parsedPage, 1), pageCount);
		pageJumpValue = String(nextPage);

		if (nextPage === currentPage) {
			return;
		}

		currentPage = nextPage;
		expandedRowId = null;
		void refreshRows();
	}

	function handlePageJumpKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			jumpToPage();
			return;
		}

		if (event.key === 'Escape') {
			pageJumpValue = String(currentPage);
			(event.currentTarget as HTMLInputElement).blur();
		}
	}

	async function toggleSort(columnKey: ColumnKey) {
		if (busy) {
			return;
		}

		if (sort.key === columnKey) {
			sort = {
				key: columnKey,
				direction: sort.direction === 'asc' ? 'desc' : 'asc'
			};
		} else {
			sort = {
				key: columnKey,
				direction: columnKey === 'id' ? 'desc' : 'asc'
			};
		}

		currentPage = 1;
		expandedRowId = null;

		if (hasSearched) {
			await refreshRows();
			if (!errorMessage) {
				updateHashUrl('replace');
			}
		}
	}

	function changePageSize(event: Event) {
		if (busy) {
			return;
		}

		pageSize = Number((event.currentTarget as HTMLSelectElement).value);
		currentPage = 1;
		expandedRowId = null;

		if (hasSearched) {
			void refreshRows();
		}
	}

	function setColumnVisibility(columnKey: ColumnKey, checked: boolean) {
		if (!columns.find((column) => column.key === columnKey)?.optional) {
			return;
		}

		visibleColumns = normalizeVisibleColumns({
			...visibleColumns,
			[columnKey]: checked
		});
		updateHashUrl('replace');
	}

	function mergeRowDetail(rowId: number, detail: DriverRowDetail) {
		rows = rows.map((row) =>
			row.id === rowId
				? {
						...row,
						...detail,
						detailLoaded: true
					}
				: row
		);
	}

	async function ensureRowDetailLoaded(rowId: number) {
		if (!database || isDetailLoading(rowId)) {
			return;
		}

		const row = rows.find((candidate) => candidate.id === rowId);
		if (!row || row.detailLoaded) {
			return;
		}

		detailLoadingById = {
			...detailLoadingById,
			[rowId]: true
		};

		try {
			const detail = await queryDriverDetail(database, rowId);
			mergeRowDetail(rowId, detail);
		} catch (error) {
			if (error instanceof Error) {
				errorMessage = error.message;
			} else {
				errorMessage = 'Failed to load driver detail.';
			}
		} finally {
			const nextLoading = { ...detailLoadingById };
			delete nextLoading[rowId];
			detailLoadingById = nextLoading;
		}
	}

	function toggleRow(rowId: number) {
		if (busy) {
			return;
		}

		const nextExpandedRowId = expandedRowId === rowId ? null : rowId;
		expandedRowId = nextExpandedRowId;

		if (nextExpandedRowId !== null) {
			void ensureRowDetailLoaded(rowId);
		}
	}

	function handleRowKeydown(event: KeyboardEvent, rowId: number) {
		if (event.key !== 'Enter' && event.key !== ' ') {
			return;
		}

		event.preventDefault();
		toggleRow(rowId);
	}

	function toggleQueryPanel() {
		queryPanelCollapsed = !queryPanelCollapsed;
	}

	function loadProjectNoteAcknowledgedState() {
		try {
			const storedValue = window.localStorage.getItem(PROJECT_NOTE_ACKNOWLEDGED_KEY);
			if (storedValue === '1') {
				projectNoteAcknowledged = true;
				return;
			}

			projectNoteAcknowledged = false;
			if (storedValue !== '0') {
				window.localStorage.setItem(PROJECT_NOTE_ACKNOWLEDGED_KEY, '0');
			}
		} catch {
			projectNoteAcknowledged = false;
		}
	}

	function dismissProjectNote() {
		projectNoteAcknowledged = true;

		try {
			window.localStorage.setItem(PROJECT_NOTE_ACKNOWLEDGED_KEY, '1');
		} catch {
			// Ignore storage failures and just hide it for this session state.
		}
	}

	function isInteractiveSequenceTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) {
			return false;
		}

		return (
			target instanceof HTMLInputElement ||
			target instanceof HTMLSelectElement ||
			target instanceof HTMLTextAreaElement ||
			target.isContentEditable
		);
	}

	onMount(() => {
		loadProjectNoteAcknowledgedState();
		const diagnosticsKeyBuffer: string[] = [];
		const diagnosticsSequenceLength = Math.max(
			DIAGNOSTICS_OPEN_SEQUENCE.length,
			DIAGNOSTICS_CLOSE_SEQUENCE.length
		);
		const mediaQuery = window.matchMedia(MOBILE_DETAIL_MEDIA_QUERY);
		const updateMobileDetailMode = () => {
			mobileDetailMode = mediaQuery.matches;
		};
		updateMobileDetailMode();
		mediaQuery.addEventListener('change', updateMobileDetailMode);
		const handleHashChange = () => {
			if (!database || loadingDatabase || !lookupCatalog.values.length) {
				return;
			}

			void restoreSearchStateFromHash(lookupCatalog.values, window.location.hash, 'navigation');
		};
		const handleDiagnosticsSequence = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey || isInteractiveSequenceTarget(event.target)) {
				diagnosticsKeyBuffer.length = 0;
				return;
			}

			if (
				event.key !== 'ArrowUp' &&
				event.key !== 'ArrowDown' &&
				event.key !== 'ArrowLeft' &&
				event.key !== 'ArrowRight'
			) {
				diagnosticsKeyBuffer.length = 0;
				return;
			}

			diagnosticsKeyBuffer.push(event.key);
			if (diagnosticsKeyBuffer.length > diagnosticsSequenceLength) {
				diagnosticsKeyBuffer.splice(0, diagnosticsKeyBuffer.length - diagnosticsSequenceLength);
			}

			if (diagnosticsKeyBuffer.join(',') === DIAGNOSTICS_OPEN_SEQUENCE.join(',')) {
				diagnosticsOpen = true;
				diagnosticsKeyBuffer.length = 0;
				return;
			}

			if (diagnosticsKeyBuffer.join(',') === DIAGNOSTICS_CLOSE_SEQUENCE.join(',')) {
				diagnosticsOpen = false;
				diagnosticsKeyBuffer.length = 0;
			}
		};
		window.addEventListener('hashchange', handleHashChange);
		window.addEventListener('keydown', handleDiagnosticsSequence);
		void loadDatabase();

		return () => {
			mediaQuery.removeEventListener('change', updateMobileDetailMode);
			window.removeEventListener('hashchange', handleHashChange);
			window.removeEventListener('keydown', handleDiagnosticsSequence);
			void database?.close();
		};
	});

	$effect(() => {
		if (
			draftFilters.seriesValue &&
			!seriesOptions.some((option) => option.value === draftFilters.seriesValue)
		) {
			draftFilters.seriesValue = '';
			draftFilters.productValue = '';
		}

		if (
			draftFilters.productValue &&
			!productOptions.some((option) => option.value === draftFilters.productValue)
		) {
			draftFilters.productValue = '';
		}

		if (
			draftFilters.osValue &&
			osOptions.length &&
			!osOptions.some((option) => option.value === draftFilters.osValue)
		) {
			draftFilters.osValue = '';
		}

		if (
			draftFilters.languageValue &&
			languageOptions.length &&
			!languageOptions.some((option) => option.value === draftFilters.languageValue)
		) {
			draftFilters.languageValue =
				languageOptions.find((option) => option.name === 'English (US)')?.value || '';
		}
	});

	$effect(() => {
		pageJumpValue = String(currentPage);
	});

	$effect(() => {
		if (queryFieldsetElement) {
			queryFieldsetElement.disabled = busy;
		}

		if (pageSizeSelectElement) {
			pageSizeSelectElement.disabled = busy;
		}

		if (pageJumpInputElement) {
			pageJumpInputElement.disabled = busy || !hasSearched;
		}
	});

	$effect(() => {
		if (!mobileDetailMode) {
			queryPanelCollapsed = false;
		}
	});

</script>

<svelte:head>
	<title>NVIDIA Driver Database</title>
	<meta
		name="description"
		content="Browse the NVIDIA driver download ID database directly in your browser with SQLite WASM."
	/>
</svelte:head>

<div class="app-shell">
	<header class="topbar">
		<a
			class="brand brand-link"
			href="https://github.com/binary-person/nvidia-driver-database"
			target="_blank"
			rel="noreferrer"
		>
			<span class="prompt">&gt;</span>
			<span>nvidia-driver-db</span>
		</a>

		<div class="topbar-right">
			<span class="source">{formatActiveSource()}</span>
			{#if mobileDetailMode}
				<button
					type="button"
					class="query-toggle"
					aria-expanded={!queryPanelCollapsed}
					aria-controls="query-fields"
					onclick={toggleQueryPanel}
				>
					{queryPanelCollapsed ? 'show filters' : 'hide filters'}
				</button>
			{/if}
		</div>
	</header>

	{#if !projectNoteAcknowledged}
		<section class="project-note" aria-label="Project attribution">
			<div class="project-note-content">
				<span>
					Source and issues:
					<a href="https://github.com/binary-person/nvidia-driver-database" target="_blank" rel="noreferrer">
						github.com/binary-person/nvidia-driver-database
					</a>
				</span>
				<span>
					Independent project, not affiliated with or endorsed by NVIDIA. NVIDIA names, marks, and copyrighted materials remain their property.
				</span>
				<button type="button" class="project-note-dismiss" onclick={dismissProjectNote}>
					dismiss
				</button>
			</div>
		</section>
	{/if}

	{#if !mobileDetailMode || !queryPanelCollapsed}
		<section class="query-strip" aria-busy={busy} aria-label="Driver query filters">
			<fieldset bind:this={queryFieldsetElement} class="query-fields" id="query-fields">
			<div class="filter-row primary">
				<label>
					<span>type</span>
					<select bind:value={draftFilters.productTypeValue}>
						<option value="">any</option>
						{#each productTypeOptions as option}
							<option value={option.value}>{option.name}</option>
						{/each}
					</select>
				</label>

				<label>
					<span>series</span>
					<select
						bind:value={draftFilters.seriesValue}
						disabled={!draftFilters.productTypeValue}
					>
						<option value="">any</option>
						{#each seriesOptions as option}
							<option value={option.value}>{option.name}</option>
						{/each}
					</select>
				</label>

				<label>
					<span>product</span>
					<select
						bind:value={draftFilters.productValue}
						disabled={!draftFilters.seriesValue}
					>
						<option value="">any</option>
						{#each productOptions as option}
							<option value={option.value}>{option.name}</option>
						{/each}
					</select>
				</label>

				<label>
					<span>os</span>
					<select bind:value={draftFilters.osValue}>
						<option value="">any</option>
						{#each osOptions as option}
							<option value={option.value}>{option.name}</option>
						{/each}
					</select>
				</label>

				<label>
					<span>lang</span>
					<select bind:value={draftFilters.languageValue}>
						<option value="">any</option>
						{#each languageOptions as option}
							<option value={option.value}>{option.name}</option>
						{/each}
					</select>
				</label>
			</div>

			<div class="filter-row secondary">
				<label>
					<span>id</span>
					<input bind:value={draftFilters.id} placeholder="267" />
				</label>
				<label>
					<span>release</span>
					<input bind:value={draftFilters.release} placeholder="595" />
				</label>
				<label>
					<span>version</span>
					<input bind:value={draftFilters.version} placeholder="596" />
				</label>
				<label>
					<span>display</span>
					<input bind:value={draftFilters.displayVersion} placeholder="596.21" />
				</label>
				<label>
					<span>driver</span>
					<input bind:value={draftFilters.name} placeholder="GeForce" />
				</label>
				<div class="strip-actions">
					<button
						type="button"
						class:active={moreFiltersOpen}
						onclick={() => (moreFiltersOpen = !moreFiltersOpen)}
					>
						more
					</button>
					<button
						type="button"
						class="search-button"
						class:pending={!searchCurrent}
						disabled={!canSearch}
						onclick={() => void runSearch(false, mobileDetailMode, 'push')}
					>
						<span>search</span>
					</button>
					<button type="button" onclick={resetFilters}>reset</button>
				</div>
			</div>

			{#if moreFiltersOpen}
				<div class="filter-row tertiary">
					{#each booleanFilterDefinitions as filter}
						<label title={filter.title}>
							<span>{filter.label}</span>
							<select bind:value={draftFilters[filter.key]}>
								<option value="">any</option>
								<option value="1">yes</option>
								<option value="0">no</option>
							</select>
						</label>
					{/each}
				</div>
			{/if}

			{#if activeFilterChips.length > 0}
				<div class="active-filters">
					{#each activeFilterChips as chip}
						<button type="button" class="chip" onclick={() => clearFilter(chip.key)}>
							<span>{chip.label}</span>
							<code>{chip.value}</code>
							<span>x</span>
						</button>
					{/each}
				</div>
			{/if}
			</fieldset>
		</section>
	{/if}

	{#if diagnosticsOpen}
		<aside class="diagnostics">
			<div class="diagnostics-head">
				<h2>diagnostics</h2>
			</div>
			<div class="diagnostics-grid">
				<div><span>source_kind</span><code>{source?.kind || '-'}</code></div>
				<div><span>source_url</span><code>{source?.url || '-'}</code></div>
				<div><span>found</span><code>{summary?.statusCounts.found ?? '-'}</code></div>
				<div><span>confirmed_not_found</span><code>{summary?.statusCounts.confirmedNotFound ?? '-'}</code></div>
				<div><span>pending_frontier</span><code>{summary?.statusCounts.pendingFrontier ?? '-'}</code></div>
				<div><span>highest_found</span><code>{summary?.highestFound?.id ?? '-'}</code></div>
				<div><span>highest_version</span><code>{summary?.highestFound?.version || '-'}</code></div>
				<div><span>largest_gap</span><code>{formatLargestGap()}</code></div>
				<div>
					<span>linux64_cuda_display_tooltip</span>
					<code>https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/#id7</code>
				</div>
				{#each summary?.lookupSources || [] as lookup}
					<div>
						<span>lookup_{lookup.typeId}_{lookup.lookupName}</span>
						<code>{lookup.entryCount} rows / {lookup.lastCheckedAt}</code>
					</div>
				{/each}
			</div>
		</aside>
	{/if}

	<section class="table-toolbar">
		<div class="result-count">
			{#if busy}
				querying
			{:else}
				rows {resultRangeStart}-{resultRangeEnd} / {totalRows}
				{#if mobileDetailMode && queryPanelCollapsed}
					<span class="filter-count">
						{appliedFilterChips.length} filter{appliedFilterChips.length === 1 ? '' : 's'}
					</span>
				{/if}
			{/if}
		</div>

		<div class="toolbar-controls">
			<label class="page-size">
				<span>limit</span>
				<select bind:this={pageSizeSelectElement} value={pageSize} onchange={changePageSize}>
					{#each PAGE_SIZE_OPTIONS as option}
						<option value={option}>{option}</option>
					{/each}
				</select>
			</label>
			<button type="button" disabled={currentPage <= 1} onclick={() => movePage(-1)}>prev</button>
			<div class="page-readout">
				<input
					bind:this={pageJumpInputElement}
					bind:value={pageJumpValue}
					type="text"
					inputmode="numeric"
					pattern="[0-9]*"
					aria-label="Current page"
					onblur={jumpToPage}
					onkeydown={handlePageJumpKeydown}
				/>
				<span class="page-total">/ {pageCount}</span>
			</div>
			<button type="button" disabled={currentPage >= pageCount} onclick={() => movePage(1)}>next</button>
			<button type="button" class:active={columnsOpen} onclick={() => (columnsOpen = !columnsOpen)}>
				columns
			</button>
		</div>
	</section>

	{#if columnsOpen}
		<section class="column-panel">
			{#each columns as column}
				<label class="toggle">
					<input
						type="checkbox"
						checked={visibleColumns[column.key]}
						disabled={!column.optional}
						onchange={(event) =>
							setColumnVisibility(column.key, (event.currentTarget as HTMLInputElement).checked)}
					/>
					<span>{column.label}</span>
				</label>
			{/each}
		</section>
	{/if}

	{#if errorMessage}
		<section class="error-panel">
			<strong>database_error</strong>
			<pre>{errorMessage}</pre>
		</section>
	{/if}

	{#if mobileDetailMode && expandedRow}
		<section class="mobile-detail-panel" aria-label={`Driver ${expandedRow.id} detail`}>
			<div class="mobile-detail-head">
				<div class="mobile-detail-title">
					<span>driver {expandedRow.id}</span>
					<strong>{formatDetailHeading(expandedRow)}</strong>
				</div>
				<button
					type="button"
					aria-label={`Close detail for driver ${expandedRow.id}`}
					onclick={() => (expandedRowId = null)}
				>
					close
				</button>
			</div>

			{#if isDetailLoading(expandedRow.id)}
				<div class="detail-loading">loading detail...</div>
			{/if}

			<div class="detail-grid mobile-detail-grid">
				<div class="detail-panel detail-facts-panel">
					<div class="detail-fact-grid">
						{#each getDetailOverviewFacts(expandedRow) as fact}
							<div class="detail-fact">
								<span>{fact.label}</span>
								<code>{fact.value}</code>
							</div>
						{/each}
						{#each getDetailFlagFacts(expandedRow) as fact}
							<div class="detail-fact">
								<span>{fact.label}</span>
								<code>{fact.value}</code>
							</div>
						{/each}
						{#if expandedRow.detailsUrl}
							<div class="detail-link-item detail-link-full">
								<span>details</span>
								<a href={expandedRow.detailsUrl} target="_blank" rel="noreferrer">
									{expandedRow.detailsUrl}
								</a>
							</div>
						{/if}
						{#if expandedRow.downloadUrl}
							<div class="detail-link-item detail-link-full">
								<span>download</span>
								<a href={expandedRow.downloadUrl} target="_blank" rel="noreferrer">
									{expandedRow.downloadUrl}
								</a>
							</div>
						{/if}
					</div>
				</div>
				<div class="detail-panel products-detail">
					<div class="detail-panel-label">products</div>
					{#if getProductGroups(expandedRow).length > 0}
						<div class="product-groups">
							{#each getProductGroups(expandedRow) as group}
								<div class="product-group">
									<code class="series-label">{group.seriesName}</code>
									<code>{renderValue(group.products)}</code>
								</div>
							{/each}
						</div>
					{:else}
						<code>-</code>
					{/if}
				</div>
				<div class="detail-panel note-detail">
					<div class="detail-panel-label">release notes</div>
					<pre>{renderNoteDetail(expandedRow.releaseNotes)}</pre>
				</div>
				<div class="detail-panel note-detail">
					<div class="detail-panel-label">other notes</div>
					<pre>{renderNoteDetail(expandedRow.otherNotes)}</pre>
				</div>
			</div>

			{#if parseExtraFields(expandedRow)}
				<pre class="extra-fields">{parseExtraFields(expandedRow)}</pre>
			{/if}
		</section>
	{/if}

	<section class="table-shell" aria-busy={busy}>
		<table>
			<colgroup>
				{#each visibleColumnList as column}
					<col style={`width: ${column.width}`} />
				{/each}
			</colgroup>
			<thead>
				<tr>
					{#each visibleColumnList as column}
						<th aria-sort={getAriaSort(column.key)}>
							<button
								type="button"
								class="column-sort"
								class:active={sort.key === column.key}
								onclick={() => void toggleSort(column.key)}
							>
								<span>{column.label}</span>
								<span class="sort-indicator">{getSortIndicator(column.key)}</span>
							</button>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#if rows.length === 0 && !busy}
					<tr>
						<td colspan={visibleColumnList.length}>
							<div class="empty-state">no rows</div>
						</td>
					</tr>
				{:else}
					{#each rows as row}
						<tr
							class:expanded={expandedRowId === row.id}
							aria-expanded={expandedRowId === row.id}
							tabindex="0"
							onclick={() => toggleRow(row.id)}
							onkeydown={(event) => handleRowKeydown(event, row.id)}
						>
							{#each visibleColumnList as column}
								<td class={`cell-${column.key}`} title={getCellTitle(row, column.key)}>
									{#if column.key === 'id'}
										<button
											type="button"
											class="row-toggle"
											aria-label={`${expandedRowId === row.id ? 'collapse' : 'expand'} driver ${row.id}`}
											aria-expanded={expandedRowId === row.id}
											onclick={(event) => {
												event.stopPropagation();
												toggleRow(row.id);
											}}
										>
											{renderCellValue(row, column.key)}
										</button>
									{:else}
										{renderCellValue(row, column.key)}
									{/if}
								</td>
							{/each}
						</tr>
						{#if !mobileDetailMode && expandedRowId === row.id}
							<tr class="detail-row" onclick={(event) => event.stopPropagation()}>
								<td colspan={visibleColumnList.length}>
									{#if isDetailLoading(row.id)}
										<div class="detail-loading">loading detail...</div>
									{/if}
									<div class="detail-grid">
										<div class="detail-panel detail-facts-panel">
											<div class="detail-fact-grid">
												{#each getDetailOverviewFacts(row) as fact}
													<div class="detail-fact">
														<span>{fact.label}</span>
														<code>{fact.value}</code>
													</div>
												{/each}
												{#each getDetailFlagFacts(row) as fact}
													<div class="detail-fact">
														<span>{fact.label}</span>
														<code>{fact.value}</code>
													</div>
												{/each}
												{#if row.detailsUrl}
													<div class="detail-link-item detail-link-full">
														<span>details</span>
														<a
															href={row.detailsUrl}
															target="_blank"
															rel="noreferrer"
															onclick={(event) => event.stopPropagation()}
														>
															{row.detailsUrl}
														</a>
													</div>
												{/if}
												{#if row.downloadUrl}
													<div class="detail-link-item detail-link-full">
														<span>download</span>
														<a
															href={row.downloadUrl}
															target="_blank"
															rel="noreferrer"
															onclick={(event) => event.stopPropagation()}
														>
															{row.downloadUrl}
														</a>
													</div>
												{/if}
											</div>
										</div>
										<div class="detail-panel products-detail">
											<div class="detail-panel-label">products</div>
											{#if getProductGroups(row).length > 0}
												<div class="product-groups">
													{#each getProductGroups(row) as group}
														<div class="product-group">
															<code class="series-label">{group.seriesName}</code>
															<code>{renderValue(group.products)}</code>
														</div>
													{/each}
												</div>
											{:else}
												<code>-</code>
											{/if}
										</div>
										<div class="detail-panel note-detail">
											<div class="detail-panel-label">release notes</div>
											<pre>{renderNoteDetail(row.releaseNotes)}</pre>
										</div>
										<div class="detail-panel note-detail">
											<div class="detail-panel-label">other notes</div>
											<pre>{renderNoteDetail(row.otherNotes)}</pre>
										</div>
									</div>

									{#if parseExtraFields(row)}
										<pre class="extra-fields">{parseExtraFields(row)}</pre>
									{/if}
								</td>
							</tr>
						{/if}
					{/each}
				{/if}
			</tbody>
		</table>
	</section>
</div>

<style>
	:global(:root) {
		--bg: #f4f5f0;
		--panel: #ffffff;
		--panel-alt: #edf0e8;
		--panel-tint: rgba(64, 88, 52, 0.03);
		--text: #151515;
		--muted: #676767;
		--line: #d6dbd1;
		--line-strong: #9aa396;
		--accent: #5f8d13;
		--danger: #9f1d1d;
		--row-hover: #f7f8f3;
		--row-selected: #edf2e4;
		--detail-surface: #fafbf7;
		--detail-panel: #ffffff;
		--detail-line: #d9dfd1;
		--chip-bg: #f5f7f0;
	}

	:global(html, body) {
		height: 100%;
		margin: 0;
		overflow: hidden;
	}

	.app-shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		background: var(--bg);
		color: var(--text);
		font-family:
			'JetBrains Mono',
			'SFMono-Regular',
			Consolas,
			'Liberation Mono',
			monospace;
		font-size: 13px;
	}

	.topbar,
	.query-strip,
	.table-toolbar,
	.column-panel,
	.diagnostics,
	.error-panel,
	.project-note {
		border-bottom: 1px solid var(--line);
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.72)),
			var(--panel-alt);
	}

	.mobile-detail-panel {
		border-bottom: 1px solid var(--detail-line);
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.82)),
			var(--detail-surface);
	}

	.topbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem 1rem;
		padding: 0.55rem 0.75rem;
		position: sticky;
		top: 0;
		z-index: 20;
	}

	.brand,
	.topbar-right,
	.toolbar-controls,
	.active-filters,
	.strip-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.brand {
		font-weight: 700;
		letter-spacing: 0.02em;
		min-width: 0;
	}

	.brand-link {
		color: inherit;
		text-decoration: none;
	}

	.brand-link:hover {
		color: var(--accent);
	}

	.prompt {
		color: var(--accent);
	}

	.prompt,
	.source,
	.result-count,
	label span,
	.page-readout,
	.diagnostics span {
		color: var(--muted);
	}

	.source {
		flex: 0 1 22rem;
		max-width: 32vw;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.topbar-right,
	.toolbar-controls {
		min-width: 0;
	}

	.topbar-right {
		justify-content: flex-end;
		flex-wrap: nowrap;
	}

	button,
	input,
	select {
		border: 1px solid var(--line-strong);
		border-radius: 0;
		background: #fff;
		color: var(--text);
		font: inherit;
		height: 2rem;
	}

	button {
		padding: 0 0.65rem;
		cursor: pointer;
		text-transform: lowercase;
	}

	button:hover,
	button.active,
	button.pending {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--chip-bg);
	}

	button:disabled {
		color: #aaa;
		border-color: var(--line);
		cursor: default;
	}

	button:disabled {
		background: #f3f3f0;
	}

	input,
	select {
		box-sizing: border-box;
		width: 100%;
		padding: 0 0.45rem;
	}

	input::placeholder {
		color: #aaa;
	}

	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.query-strip {
		padding: 0.6rem 0.75rem;
		box-shadow: inset 0 -1px 0 rgba(127, 143, 121, 0.08);
	}

	.project-note {
		padding: 0.45rem 0.75rem;
	}

	.project-note-content {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem 1.1rem;
		color: var(--muted);
		font-size: 0.75rem;
		line-height: 1.45;
	}

	.project-note-content a {
		color: var(--accent);
		text-decoration: none;
	}

	.project-note-content a:hover {
		text-decoration: underline;
	}

	.project-note-dismiss {
		margin-left: auto;
		height: 1.55rem;
		padding: 0 0.5rem;
		border-color: var(--line);
		background: rgba(255, 255, 255, 0.72);
		color: var(--muted);
	}

	.project-note-dismiss:hover {
		border-color: var(--line-strong);
		background: #fff;
		color: var(--text);
	}

	.query-toggle {
		flex: 0 0 auto;
	}

	.query-fields {
		display: grid;
		gap: 0.5rem;
	}

	.filter-row {
		display: grid;
		gap: 0.5rem;
		align-items: end;
	}

	.filter-row.primary {
		grid-template-columns: minmax(9rem, 0.8fr) minmax(14rem, 1.2fr) minmax(16rem, 1.4fr) minmax(12rem, 1fr) minmax(10rem, 0.9fr);
	}

	.filter-row.secondary {
		grid-template-columns: 6rem 7rem 7rem 8rem minmax(12rem, 1fr) auto;
	}

	.filter-row.tertiary {
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		padding-top: 0.5rem;
		border-top: 1px solid var(--line);
	}

	label {
		display: grid;
		gap: 0.25rem;
		min-width: 0;
	}

	label span {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 2rem;
	}

	.toggle input {
		width: auto;
		height: auto;
	}

	.active-filters {
		flex-wrap: wrap;
		padding-top: 0.25rem;
	}

	.strip-actions {
		justify-content: flex-end;
	}

	.chip {
		height: 1.6rem;
		display: inline-flex;
		gap: 0.35rem;
		align-items: center;
		border-color: var(--line);
		background: var(--chip-bg);
	}

	code,
	pre {
		font-family:
			'JetBrains Mono',
			'SFMono-Regular',
			Consolas,
			'Liberation Mono',
			monospace;
	}

	.diagnostics {
		padding: 0.75rem;
	}

	.diagnostics-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.6rem;
	}

	h2 {
		margin: 0;
		font-size: 0.9rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.diagnostics-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		border-top: 1px solid var(--line);
		border-left: 1px solid var(--line);
	}

	.diagnostics-grid div {
		display: grid;
		gap: 0.2rem;
		padding: 0.45rem;
		border-right: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}

	.diagnostics code {
		overflow-wrap: anywhere;
	}

	.table-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 1rem;
		padding: 0.45rem 0.75rem;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
	}

	.page-size {
		grid-template-columns: auto 6rem;
		align-items: center;
	}

	.page-readout {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.filter-count {
		margin-left: 0.5rem;
		color: var(--muted);
	}

	.page-readout input {
		width: 3.75rem;
		min-width: 0;
		text-align: right;
	}

	.column-panel {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.45rem;
		padding: 0.55rem 0.75rem;
	}

	.mobile-detail-panel {
		padding: 0.75rem;
		overflow: auto;
	}

	.mobile-detail-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}

	.mobile-detail-title {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
	}

	.mobile-detail-title span {
		color: var(--muted);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.mobile-detail-title strong {
		overflow-wrap: anywhere;
	}

	.error-panel {
		padding: 0.75rem;
		color: var(--danger);
	}

	.error-panel pre,
	.extra-fields {
		margin: 0.5rem 0 0;
		overflow: auto;
		padding: 0.6rem;
		border: 1px solid var(--line);
		background: #111;
		color: #f4f4f4;
		font-size: 0.78rem;
	}

	.table-shell {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		background: var(--panel);
	}

	table {
		width: 100%;
		min-width: 80rem;
		border-collapse: collapse;
		table-layout: fixed;
	}

	th,
	td {
		border-right: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
		padding: 0.3rem 0.45rem;
		text-align: left;
		vertical-align: middle;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	th {
		position: sticky;
		top: 0;
		z-index: 2;
		background: #f0f2eb;
		color: var(--muted);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.column-sort {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.45rem;
		width: 100%;
		height: auto;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		text-transform: uppercase;
	}

	.column-sort:hover,
	.column-sort.active {
		color: var(--accent);
	}

	.column-sort:disabled {
		background: transparent;
	}

	.sort-indicator {
		min-width: 0.75rem;
		text-align: right;
		color: var(--line-strong);
	}

	tbody tr {
		cursor: pointer;
		background: rgba(255, 255, 255, 0.92);
	}

	tbody tr:hover {
		background: var(--row-hover);
	}

	tbody tr.expanded {
		background: var(--row-selected);
		box-shadow: inset 0 1px 0 rgba(95, 141, 19, 0.12), inset 0 -1px 0 rgba(95, 141, 19, 0.12);
	}

	tbody tr:focus {
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}

	.row-toggle {
		display: block;
		width: 100%;
		height: auto;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		text-transform: none;
	}

	.row-toggle:hover {
		color: var(--accent);
	}

	.cell-seriesNames,
	.cell-productNames {
		max-width: 0;
	}

	.detail-row td {
		padding: 0;
		white-space: normal;
		background: var(--detail-surface);
		border-top: 1px solid var(--detail-line);
	}

	.detail-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		border-top: 1px solid var(--detail-line);
		background: var(--detail-surface);
	}

	.detail-loading {
		padding: 0.55rem 0.65rem;
		color: var(--muted);
		border: 1px solid var(--detail-line);
		border-bottom: 0;
		background: var(--detail-panel);
	}

	.detail-facts-panel,
	.note-detail {
		align-items: start;
	}

	.detail-facts-panel,
	.products-detail {
		grid-column: 1 / -1;
	}

	.note-detail {
		grid-column: 1 / -1;
	}

	.detail-panel {
		display: grid;
		gap: 0.5rem;
		padding: 0.45rem;
		border-right: 1px solid var(--detail-line);
		border-bottom: 1px solid var(--detail-line);
		background: var(--detail-panel);
		min-width: 0;
	}

	.detail-panel-label {
		color: var(--line-strong);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.detail-fact-grid,
	.detail-link-list {
		display: grid;
		gap: 0.5rem;
		min-width: 0;
	}

	.detail-fact-grid {
		grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
	}

	.detail-fact,
	.detail-link-item {
		display: grid;
		gap: 0.18rem;
		min-width: 0;
	}

	.detail-fact span,
	.detail-link-item span {
		color: var(--muted);
	}

	.detail-link-full {
		grid-column: 1 / -1;
	}

	.detail-panel code,
	.detail-panel a {
		overflow-wrap: anywhere;
	}

	.detail-panel code {
		color: var(--text);
	}

	.product-groups {
		display: grid;
		gap: 0.35rem;
		min-width: 0;
	}

	.product-group {
		display: grid;
		grid-template-columns: minmax(11rem, 16rem) minmax(0, 1fr);
		gap: 0.5rem;
		min-width: 0;
	}

	.product-group code {
		min-width: 0;
	}

	.product-group .series-label {
		color: var(--muted);
	}

	.detail-panel a {
		color: var(--accent);
		text-decoration: none;
	}

	.note-detail {
		display: block;
	}

	.note-detail .detail-panel-label {
		display: block;
		margin-bottom: 0.45rem;
	}

	.note-detail pre {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 0.78rem;
		line-height: 1.45;
	}

	.empty-state {
		padding: 1rem;
		color: var(--muted);
	}

	@media (max-width: 1045px) {
		.topbar,
		.table-toolbar {
			align-items: flex-start;
		}

		.topbar {
			display: flex;
			flex-direction: column;
			position: static;
		}

		.topbar-right,
		.toolbar-controls {
			width: 100%;
			justify-content: flex-start;
			flex-wrap: wrap;
		}

		.filter-row.primary,
		.filter-row.secondary {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.filter-row.secondary .strip-actions,
		.filter-row.tertiary {
			grid-column: 1 / -1;
		}

		.strip-actions {
			justify-content: flex-start;
		}

		.source {
			flex-basis: 100%;
			max-width: 100%;
		}

		.table-shell {
			min-height: 0;
		}

		.project-note-content {
			flex-direction: column;
			gap: 0.2rem;
		}

		.project-note-dismiss {
			margin-left: 0;
		}
	}

	@media (max-width: 1045px), (max-height: 720px) {
		:global(html),
		:global(body) {
			overflow: auto;
		}

		.app-shell {
			height: auto;
			min-height: 100vh;
			overflow: visible;
		}

		.table-shell {
			flex: 0 0 auto;
			min-height: 18rem;
			max-height: 55vh;
		}
	}

	@media (max-width: 1045px) {
		.topbar {
			gap: 0.6rem;
		}

		.filter-row.primary,
		.filter-row.secondary,
		.filter-row.tertiary {
			grid-template-columns: minmax(0, 1fr);
		}

		.filter-row.secondary .strip-actions {
			grid-column: auto;
		}

		.page-size {
			grid-template-columns: minmax(0, 1fr);
		}

		.table-toolbar {
			gap: 0.6rem;
		}

		.mobile-detail-panel {
			padding: 0.65rem 0.75rem 0.75rem;
		}

		.mobile-detail-head {
			flex-wrap: wrap;
		}

		.mobile-detail-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.mobile-detail-panel .products-detail,
		.mobile-detail-panel .detail-panel,
		.mobile-detail-panel .detail-facts-panel,
		.mobile-detail-panel .note-detail {
			grid-column: auto;
			grid-template-columns: minmax(0, 1fr);
			gap: 0.25rem;
		}

		.mobile-detail-panel .detail-fact-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.mobile-detail-panel .product-group {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.2rem;
		}

		.mobile-detail-panel .product-groups {
			gap: 0.75rem;
		}

		.topbar-right {
			justify-content: space-between;
			align-items: center;
		}
	}
</style>
