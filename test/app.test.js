"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Database = require("better-sqlite3");

const {
  buildBrowserDatabase,
  buildSummaryRecord,
  classifyPayload,
  createRuntimeControl,
  crawlDatabase,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_TRAILING_NOT_FOUND,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  getPaths,
  LOOKUP_TYPE_DEFINITIONS,
  openRepository,
  parseBuildBrowserDbArgs,
  parseCrawlArgs,
  parseLookupValueSearchXml,
  parseStatsArgs,
  queryDatabase,
  refreshLookupValues,
  runCli,
  statsDatabase,
} = require("../lib/nvidia-driver-db");

const repoRoot = path.resolve(__dirname, "..");
const fixturesDir = path.join(repoRoot, "json-examples");
const aemExamplesDir = path.join(fixturesDir, "AEMDriversContent");
const ajaxExamplesDir = path.join(fixturesDir, "AjaxDriverService");
const lookupExamplesDir = path.join(fixturesDir, "lookupValueSearch");

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "nvidia-driver-db-"));
}

async function readExample(fileName) {
  const text = await fs.readFile(path.join(aemExamplesDir, fileName), "utf8");
  return {
    text,
    payload: JSON.parse(text),
  };
}

async function readAjaxExample(fileName) {
  const text = await fs.readFile(path.join(ajaxExamplesDir, fileName), "utf8");
  return {
    text,
    payload: JSON.parse(text),
  };
}

async function readLookupExample(typeId) {
  return fs.readFile(path.join(lookupExamplesDir, `lookupValueSearch.aspx?TypeID=${typeId}`), "utf8");
}

function reverseLookupValueBlocks(xmlText) {
  const blocks = xmlText.match(/<LookupValue\b[\s\S]*?<\/LookupValue>/g);
  assert.ok(blocks && blocks.length > 0, "Expected LookupValue blocks");

  let blockIndex = 0;
  return xmlText.replace(
    /<LookupValue\b[\s\S]*?<\/LookupValue>/g,
    () => blocks[blocks.length - 1 - blockIndex++]
  );
}

function createLookupFixtureFetch(driverFetchImpl, lookupOverrides = {}) {
  return async (url, init) => {
    const lookupMatch = String(url).match(/lookupValueSearch\.aspx\?TypeID=(\d+)/);
    if (lookupMatch) {
      const typeId = Number(lookupMatch[1]);
      const bodyText = lookupOverrides[typeId] || await readLookupExample(typeId);
      return createResponse(200, bodyText);
    }

    return driverFetchImpl(url, init);
  };
}

function createMemoryStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
    },
    toString() {
      return chunks.join("");
    },
  };
}

function createResponse(status, bodyText) {
  return {
    status,
    async text() {
      return bodyText;
    },
  };
}

function openTempDb(rootDir) {
  const databaseFile = getPaths(rootDir).databaseFile;
  return new Database(databaseFile, { readonly: true });
}

function openBrowserDb(rootDir) {
  const databaseFile = getPaths(rootDir).browserDatabaseFile;
  return new Database(databaseFile, { readonly: true });
}

function getRequestedDriverId(url) {
  const match = String(url).match(/downloadID=(\d+)/);
  assert.ok(match, `Expected downloadID in URL: ${url}`);
  return match[1];
}

function getRequestedFallbackDriverId(url) {
  const decodedUrl = decodeURI(String(url));
  const match = decodedUrl.match(/"ddID":"(\d+)"/);
  assert.ok(match, `Expected ddID in fallback URL: ${url}`);
  return match[1];
}

function makeLookupEntry({
  typeId,
  lookupName,
  value,
  name,
  parentTypeId = null,
  parentValue = "",
  code = "",
  requiresProduct = "",
  isSelectLess = "",
  ordinal = 0,
  extraAttrs = {},
}) {
  return {
    typeId,
    lookupName,
    value,
    name,
    parentTypeId,
    parentValue,
    code,
    requiresProduct,
    isSelectLess,
    ordinal,
    extraAttrs,
  };
}

test("buildSummaryRecord decodes human-facing fields from a successful payload", async () => {
  const { payload } = await readExample("187732.json");
  const summary = buildSummaryRecord(payload);

  assert.equal(summary.id, "187732");
  assert.equal(summary.version, "512.59");
  assert.equal(summary.name, "GeForce Game Ready Driver");
  assert.equal(summary.osName, "Windows 11");
  assert.equal(summary.languageName, "Hungarian");
  assert.equal(summary.isBeta, "0");
  assert.equal(summary.isFeaturePreview, "0");
  assert.equal(summary.downloadFileSize, "823.44 MB");
  assert.match(summary.releaseNotes, /Game Ready Drivers provide/i);
  assert.match(summary.otherNotes, /October 2021/i);
  assert.ok(summary.seriesNames.includes("GeForce RTX 30 Series"));
  assert.ok(summary.productNames.includes("GeForce RTX 3090 Ti"));
});

test("buildSummaryRecord accepts direct AjaxDriverService payloads", async () => {
  const { payload } = await readAjaxExample("131411.json");
  const summary = buildSummaryRecord(payload);

  assert.equal(summary.id, "131411");
  assert.equal(summary.release, "390");
  assert.equal(summary.version, "390.85");
  assert.equal(summary.name, "Tesla Driver for Windows");
  assert.equal(summary.languageName, "Español (España)");
  assert.equal(summary.osName, "Windows Server 2012 R2 64");
  assert.equal(summary.downloadFileSize, "287.33 MB");
  assert.ok(summary.seriesNames.includes("V-Series"));
  assert.ok(summary.productNames.includes("Tesla V100"));
});

test("classifyPayload recognizes semantic not-found bodies", async () => {
  const { payload } = await readExample("404 not found.json");
  const classification = classifyPayload(payload);

  assert.equal(classification.kind, "not_found");
});

test("classifyPayload recognizes direct AjaxDriverService not-found bodies", async () => {
  const { payload } = await readAjaxExample("1 not found.json");
  const classification = classifyPayload(payload);

  assert.equal(classification.kind, "not_found");
});

test("classifyPayload treats direct non-not-found failures as unexpected", async () => {
  const { payload } = await readAjaxExample("0 invalid.json");
  const classification = classifyPayload(payload);

  assert.equal(classification.kind, "unexpected");
});

test("database initialization creates sqlite with the current schema", async () => {
  const rootDir = await makeTempRoot();

  const repository = await openRepository(rootDir);
  repository.close();

  const paths = getPaths(rootDir);
  assert.equal(await fs.stat(paths.databaseFile).then(() => true, () => false), true);

  const db = new Database(getPaths(rootDir).databaseFile);
  const columns = db.prepare("PRAGMA table_info(drivers)").all().map((column) => column.name);
  db.close();
  assert.ok(columns.includes("is_beta"));
  assert.ok(columns.includes("is_feature_preview"));
  assert.ok(columns.includes("download_file_size"));
  assert.ok(columns.includes("release_notes"));
  assert.ok(columns.includes("other_notes"));
});

test("buildBrowserDatabase fails clearly when the master database is missing", async () => {
  const rootDir = await makeTempRoot();

  await assert.rejects(
    buildBrowserDatabase({
      rootDir,
      stdout: createMemoryStream(),
    }),
    /Master database not found/
  );
});

test("buildBrowserDatabase resolves known product aliases to canonical lookup names", async () => {
  const rootDir = await makeTempRoot();
  const repository = await openRepository(rootDir);

  try {
    const productTypeDefinition = LOOKUP_TYPE_DEFINITIONS.find((entry) => entry.typeId === 1);
    const seriesDefinition = LOOKUP_TYPE_DEFINITIONS.find((entry) => entry.typeId === 2);
    const productDefinition = LOOKUP_TYPE_DEFINITIONS.find((entry) => entry.typeId === 3);
    const osDefinition = LOOKUP_TYPE_DEFINITIONS.find((entry) => entry.typeId === 4);
    const languageDefinition = LOOKUP_TYPE_DEFINITIONS.find((entry) => entry.typeId === 5);
    const checkedAt = new Date().toISOString();

    repository.replaceLookupValues(productTypeDefinition, "https://example.test/type1", "type1", [
      makeLookupEntry({
        typeId: 1,
        lookupName: "product_type",
        value: "1",
        name: "RTX PRO",
        ordinal: 0,
      }),
    ], checkedAt);
    repository.replaceLookupValues(seriesDefinition, "https://example.test/type2", "type2", [
      makeLookupEntry({
        typeId: 2,
        lookupName: "product_series",
        value: "2",
        name: "RTX PRO Blackwell",
        parentTypeId: 1,
        parentValue: "1",
        ordinal: 0,
      }),
    ], checkedAt);
    repository.replaceLookupValues(productDefinition, "https://example.test/type3", "type3", [
      makeLookupEntry({
        typeId: 3,
        lookupName: "product",
        value: "3",
        name: "NVIDIA RTX PRO 5000 Blackwell",
        parentTypeId: 2,
        parentValue: "2",
        ordinal: 0,
      }),
    ], checkedAt);
    repository.replaceLookupValues(osDefinition, "https://example.test/type4", "type4", [
      makeLookupEntry({
        typeId: 4,
        lookupName: "operating_system",
        value: "4",
        name: "Linux 64-bit",
        code: "linux64",
        ordinal: 0,
      }),
    ], checkedAt);
    repository.replaceLookupValues(languageDefinition, "https://example.test/type5", "type5", [
      makeLookupEntry({
        typeId: 5,
        lookupName: "language",
        value: "5",
        name: "English (US)",
        ordinal: 0,
      }),
    ], checkedAt);

    repository.persistFound({
      id: "999001",
      release: "595",
      version: "595.58",
      displayVersion: "595.58.03",
      gfeDisplayVersion: "",
      releaseDateTime: "Tue Mar 24, 2026",
      osName: "Linux 64-bit",
      osCode: "linux64",
      languageName: "English (US)",
      is64Bit: "1",
      isWHQL: "0",
      isRecommended: "1",
      isDC: "0",
      isCRD: "0",
      isBeta: "0",
      isFeaturePreview: "0",
      downloadFileSize: "396.81 MB",
      releaseNotes: "",
      otherNotes: "",
      name: "Data Center Driver for Linux",
      detailsUrl: "https://www.nvidia.com/en-us/drivers/details/999001/",
      downloadUrl: "https://us.download.nvidia.com/XFree86/Linux-x86_64/595.58.03/NVIDIA-Linux-x86_64-595.58.03.run",
      seriesNames: ["RTX PRO Blackwell"],
      productNames: ["NVIDIA RTX PRO 5000 72GB Blackwell"],
    }, "{}", checkedAt);
  } finally {
    repository.close();
  }

  const result = await buildBrowserDatabase({
    rootDir,
    stdout: createMemoryStream(),
  });

  assert.equal(result.exitCode, 0);

  const db = openBrowserDb(rootDir);
  const driverRow = db.prepare(`
    SELECT product_lookup_ids_text, series_lookup_ids_text
    FROM drivers
    WHERE id = 999001
  `).get();
  const productLookup = db.prepare(`
    SELECT lookup_id
    FROM lookup_values
    WHERE type_id = 3
      AND name = 'NVIDIA RTX PRO 5000 Blackwell'
  `).get();
  db.close();

  assert.equal(driverRow.product_lookup_ids_text, `|${productLookup.lookup_id}|`);
  assert.equal(driverRow.series_lookup_ids_text.length > 0, true);
});

test("replaceLookupValues preserves a richer TypeID 3 snapshot when a weaker regional snapshot would reduce found-product coverage", async () => {
  const rootDir = await makeTempRoot();
  const repository = await openRepository(rootDir);

  try {
    const productDefinition = LOOKUP_TYPE_DEFINITIONS.find((entry) => entry.typeId === 3);
    const checkedAt = new Date().toISOString();

    repository.persistFound({
      id: "999101",
      release: "595",
      version: "595.45",
      displayVersion: "595.45.04",
      gfeDisplayVersion: "",
      releaseDateTime: "Thu Mar 5, 2026",
      osName: "Linux 64-bit",
      osCode: "linux64",
      languageName: "English (US)",
      is64Bit: "1",
      isWHQL: "0",
      isRecommended: "1",
      isDC: "0",
      isCRD: "0",
      isBeta: "0",
      isFeaturePreview: "0",
      downloadFileSize: "423.19 MB",
      releaseNotes: "",
      otherNotes: "",
      name: "Data Center Driver for Linux",
      detailsUrl: "https://www.nvidia.com/en-us/drivers/details/999101/",
      downloadUrl: "https://us.download.nvidia.com/XFree86/Linux-x86_64/595.45.04/NVIDIA-Linux-x86_64-595.45.04.run",
      seriesNames: ["RTX PRO Blackwell"],
      productNames: [
        "NVIDIA RTX PRO 5000 48GB Blackwell",
        "NVIDIA RTX PRO 4500 Blackwell Workstation Edition",
      ],
    }, "{}", checkedAt);

    repository.replaceLookupValues(productDefinition, "https://example.test/type3-a", "type3-a", [
      makeLookupEntry({
        typeId: 3,
        lookupName: "product",
        value: "1080",
        name: "NVIDIA RTX PRO 5000 48GB Blackwell",
        parentTypeId: 2,
        parentValue: "132",
        ordinal: 0,
      }),
      makeLookupEntry({
        typeId: 3,
        lookupName: "product",
        value: "1082",
        name: "NVIDIA RTX PRO 4500 Blackwell Workstation Edition",
        parentTypeId: 2,
        parentValue: "132",
        ordinal: 1,
      }),
    ], checkedAt);

    const regressionResult = repository.replaceLookupValues(
      productDefinition,
      "https://example.test/type3-b",
      "type3-b",
      [
        makeLookupEntry({
          typeId: 3,
          lookupName: "product",
          value: "1080",
          name: "NVIDIA RTX PRO 5000 Blackwell",
          parentTypeId: 2,
          parentValue: "132",
          ordinal: 0,
        }),
        makeLookupEntry({
          typeId: 3,
          lookupName: "product",
          value: "1082",
          name: "NVIDIA RTX PRO 4500 Blackwell",
          parentTypeId: 2,
          parentValue: "132",
          ordinal: 1,
        }),
      ],
      new Date(Date.now() + 1000).toISOString()
    );

    assert.equal(regressionResult.changed, false);
    assert.equal(regressionResult.skippedCoverageRegression, true);
    assert.equal(regressionResult.retainedCoverageCount, 2);
    assert.equal(regressionResult.candidateCoverageCount, 0);
  } finally {
    repository.close();
  }

  const db = openTempDb(rootDir);
  const productNames = db.prepare(`
    SELECT name
    FROM lookup_values
    WHERE type_id = 3
    ORDER BY name ASC
  `).pluck().all();
  db.close();

  assert.deepEqual(productNames, [
    "NVIDIA RTX PRO 4500 Blackwell Workstation Edition",
    "NVIDIA RTX PRO 5000 48GB Blackwell",
  ]);
});

test("buildBrowserDatabase rebuilds data/browser.sqlite from the master database", async () => {
  const rootDir = await makeTempRoot();
  const foundOld = await readAjaxExample("2.json");
  const foundModern = await readExample("187732.json");
  const notFound = await readAjaxExample("1 not found.json");

  await crawlDatabase({
    rootDir,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 2,
    fetchImpl: createLookupFixtureFetch(async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": foundOld.text,
        "3": notFound.text,
        "4": foundModern.text.replace(/187732/g, "4"),
        "5": notFound.text,
        "6": notFound.text,
      };
      return createResponse(200, responses[id]);
    }),
  });

  const staleFile = getPaths(rootDir).browserDatabaseFile;
  await fs.writeFile(staleFile, "stale", "utf8");

  const result = await buildBrowserDatabase({
    rootDir,
    stdout: createMemoryStream(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.browserDatabaseGzipFile, getPaths(rootDir).browserDatabaseGzipFile);
  assert.equal(result.browserDatabaseMetaFile, getPaths(rootDir).browserDatabaseMetaFile);

  const db = openBrowserDb(rootDir);
  const driverColumns = db.prepare("PRAGMA table_info(drivers)").all().map((column) => column.name);
  const detailColumns = db.prepare("PRAGMA table_info(driver_detail)").all().map((column) => column.name);
  const lookupColumns = db.prepare("PRAGMA table_info(lookup_values)").all().map((column) => column.name);
  const textValueColumns = db.prepare("PRAGMA table_info(text_values)").all().map((column) => column.name);
  const noteValueColumns = db.prepare("PRAGMA table_info(note_values)").all().map((column) => column.name);
  const driverRows = db.prepare(`
    SELECT
      id,
      release_text_id,
      version_text_id,
      name_text_id,
      os_lookup_id,
      language_lookup_id,
      product_type_lookup_ids_text,
      series_lookup_ids_text,
      product_lookup_ids_text,
      is_64_bit,
      is_whql,
      is_recommended,
      release_date_unix
    FROM drivers
    ORDER BY id ASC
  `).all();
  const detailRows = db.prepare(`
    SELECT
      driver_id,
      download_file_size_bytes,
      details_url_value,
      details_url_template_kind,
      details_url_host_id,
      details_url_locale_segment,
      download_url_value,
      download_url_template_kind,
      download_url_host_id,
      download_url_path_id,
      release_notes_note_id
    FROM driver_detail
    ORDER BY driver_id ASC
  `).all();
  const urlHostRows = db.prepare(`
    SELECT host
    FROM url_hosts
    ORDER BY host ASC
  `).all();
  const downloadUrlPathRows = db.prepare(`
    SELECT path
    FROM download_url_paths
    ORDER BY path ASC
  `).all();
  const browserTables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name ASC
  `).all();
  const stats = db.prepare(`
    SELECT
      found_count,
      confirmed_not_found_count,
      pending_frontier_count,
      highest_found_id,
      highest_found_version,
      largest_gap_start_id,
      largest_gap_end_id,
      largest_gap_length
    FROM browser_stats
  `).get();
  const lookupSourceTypes = db.prepare("SELECT type_id FROM lookup_sources ORDER BY type_id ASC").all();
  const lookupTypeSixCount = db.prepare("SELECT COUNT(*) AS count FROM lookup_values WHERE type_id = 6").get();
  db.close();
  const browserDatabaseStat = await fs.stat(getPaths(rootDir).browserDatabaseFile);
  const browserDatabaseGzipStat = await fs.stat(getPaths(rootDir).browserDatabaseGzipFile);
  const browserMetadata = JSON.parse(
    await fs.readFile(getPaths(rootDir).browserDatabaseMetaFile, "utf8")
  );

  assert.ok(driverColumns.includes("release_date_unix"));
  assert.ok(driverColumns.includes("release_text_id"));
  assert.ok(driverColumns.includes("version_text_id"));
  assert.ok(driverColumns.includes("product_type_lookup_ids_text"));
  assert.ok(driverColumns.includes("series_lookup_ids_text"));
  assert.ok(driverColumns.includes("product_lookup_ids_text"));
  assert.ok(detailColumns.includes("download_file_size_bytes"));
  assert.ok(detailColumns.includes("details_url_value"));
  assert.ok(detailColumns.includes("details_url_template_kind"));
  assert.ok(detailColumns.includes("details_url_host_id"));
  assert.ok(detailColumns.includes("details_url_locale_segment"));
  assert.ok(detailColumns.includes("download_url_value"));
  assert.ok(detailColumns.includes("download_url_template_kind"));
  assert.ok(detailColumns.includes("download_url_host_id"));
  assert.ok(detailColumns.includes("download_url_path_id"));
  assert.ok(detailColumns.includes("release_notes_note_id"));
  assert.equal(detailColumns.includes("products_grouped_lookup_ids_json"), false);
  assert.ok(lookupColumns.includes("lookup_id"));
  assert.ok(lookupColumns.includes("parent_lookup_id"));
  assert.ok(textValueColumns.includes("text_id"));
  assert.equal(textValueColumns.includes("value_lc"), false);
  assert.ok(noteValueColumns.includes("note_id"));
  assert.ok(noteValueColumns.includes("content_hash"));
  assert.ok(noteValueColumns.includes("encoding"));
  assert.ok(noteValueColumns.includes("raw_size"));
  assert.ok(noteValueColumns.includes("value_gzip"));
  assert.equal(driverColumns.includes("status"), false);
  assert.equal(driverColumns.includes("last_checked_at"), false);
  assert.equal(driverColumns.includes("found_at"), false);
  assert.equal(driverColumns.includes("updated_at"), false);
  assert.equal(driverColumns.includes("name"), false);
  assert.equal(detailColumns.includes("details_url"), false);
  assert.equal(detailColumns.includes("download_url"), false);
  assert.equal(detailColumns.includes("download_url_path"), false);
  assert.deepEqual(driverRows.map((row) => row.id), [2, 4]);
  assert.ok(driverRows[0].release_text_id > 0);
  assert.ok(driverRows[0].version_text_id > 0);
  assert.ok(driverRows[0].name_text_id > 0);
  assert.ok(driverRows[0].os_lookup_id > 0);
  assert.ok(driverRows[0].language_lookup_id > 0);
  assert.match(driverRows[0].product_type_lookup_ids_text, /^\|/);
  assert.match(driverRows[0].series_lookup_ids_text, /^\|/);
  assert.match(driverRows[0].product_lookup_ids_text, /^\|/);
  assert.equal(typeof driverRows[0].is_64_bit, "number");
  assert.equal(typeof driverRows[0].is_whql, "number");
  assert.equal(typeof driverRows[0].is_recommended, "number");
  assert.ok(driverRows[0].release_date_unix > 0);
  assert.deepEqual(detailRows.map((row) => row.driver_id), [2, 4]);
  assert.ok(detailRows[0].download_file_size_bytes > 0);
  assert.equal(detailRows[0].details_url_value, null);
  assert.equal(detailRows[0].details_url_template_kind, 2);
  assert.ok(detailRows[0].details_url_host_id > 0);
  assert.equal(detailRows[0].details_url_locale_segment, "en-us");
  assert.equal(detailRows[0].download_url_value, null);
  assert.equal(detailRows[0].download_url_template_kind, 1);
  assert.ok(detailRows[0].download_url_host_id > 0);
  assert.ok(detailRows[0].download_url_path_id > 0);
  assert.ok(detailRows[0].release_notes_note_id > 0);
  assert.equal(browserTables.some((row) => row.name === "driver_product_map"), false);
  assert.equal(browserTables.some((row) => row.name === "driver_series_fallback"), false);
  assert.equal(browserTables.some((row) => row.name === "url_hosts"), true);
  assert.equal(browserTables.some((row) => row.name === "download_url_paths"), true);
  assert.ok(urlHostRows.some((row) => row.host === "www.nvidia.com"));
  assert.ok(urlHostRows.some((row) => row.host.includes("download.nvidia.com")));
  assert.ok(downloadUrlPathRows.some((row) => row.path.startsWith("/")));
  assert.deepEqual(stats, {
    found_count: 2,
    confirmed_not_found_count: 1,
    pending_frontier_count: 2,
    highest_found_id: 4,
    highest_found_version: "512.59",
    largest_gap_start_id: 3,
    largest_gap_end_id: 3,
    largest_gap_length: 1,
  });
  assert.deepEqual(lookupSourceTypes.map((row) => row.type_id), [1, 2, 3, 4, 5]);
  assert.equal(lookupTypeSixCount.count, 0);
  assert.equal(browserMetadata.schemaVersion, 1);
  assert.equal(browserMetadata.databaseFileName, "browser.sqlite");
  assert.equal(browserMetadata.compressedDatabaseFileName, "browser.sqlite.gz");
  assert.equal(browserMetadata.compression, "gzip");
  assert.equal(browserMetadata.uncompressedSize, browserDatabaseStat.size);
  assert.equal(browserMetadata.compressedSize, browserDatabaseGzipStat.size);
  assert.match(browserMetadata.builtAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(browserMetadata.sha256, /^[0-9a-f]{64}$/);
  assert.ok(browserMetadata.compressedSize < browserMetadata.uncompressedSize);
});

test("buildBrowserDatabase preserves series-only membership tokens for legacy rows", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const notFound = await readAjaxExample("1 not found.json");
  const payload = JSON.parse(found.text);
  payload.IDS[0].downloadInfo.series = [
    {
      seriesname: "nForce%20Audio",
    },
  ];

  await crawlDatabase({
    rootDir,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 2,
    fetchImpl: createLookupFixtureFetch(async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": JSON.stringify(payload),
        "3": notFound.text,
        "4": notFound.text,
      };
      return createResponse(200, responses[id]);
    }),
  });

  await buildBrowserDatabase({
    rootDir,
    stdout: createMemoryStream(),
  });

  const db = openBrowserDb(rootDir);
  const row = db.prepare(`
    SELECT
      series_lookup_ids_text,
      product_lookup_ids_text
    FROM drivers
    WHERE id = 2
  `).get();
  const seriesLookup = db.prepare(`
    SELECT lookup_id
    FROM lookup_values
    WHERE type_id = 2
      AND name = 'nForce Audio'
    LIMIT 1
  `).get();
  db.close();

  assert.match(row.series_lookup_ids_text, /^\|\d+\|$/);
  assert.equal(row.product_lookup_ids_text, "");
  assert.equal(row.series_lookup_ids_text, `|${Number(seriesLookup.lookup_id)}|`);
});

test("buildBrowserDatabase compacts modern details URLs and templated download URLs", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const notFound = await readAjaxExample("1 not found.json");

  await crawlDatabase({
    rootDir,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 2,
    fetchImpl: createLookupFixtureFetch(async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": found.text,
        "3": notFound.text,
        "4": notFound.text,
      };
      return createResponse(200, responses[id]);
    }),
  });

  const masterDb = new Database(getPaths(rootDir).databaseFile);
  masterDb.prepare(`
    UPDATE drivers
    SET
      details_url = 'https://www.nvidia.com/en-us/drivers/details/2/',
      download_url = 'http://cn.download.nvidia.com/Windows/Quadro_Certified/332.76/test-driver.exe'
    WHERE id = 2
  `).run();
  masterDb.close();

  await buildBrowserDatabase({
    rootDir,
    stdout: createMemoryStream(),
  });

  const db = openBrowserDb(rootDir);
  const detail = db.prepare(`
    SELECT
      details_url_value,
      details_url_template_kind,
      details_url_host_id,
      details_url_locale_segment,
      download_url_value,
      download_url_template_kind,
      download_url_host_id,
      download_url_path_id
    FROM driver_detail
    WHERE driver_id = 2
  `).get();
  const downloadUrlPath = db.prepare(`
    SELECT path
    FROM download_url_paths
    WHERE path_id = ?
  `).get(detail.download_url_path_id);
  db.close();

  assert.equal(detail.details_url_value, null);
  assert.equal(detail.details_url_template_kind, 1);
  assert.equal(detail.details_url_host_id, null);
  assert.match(detail.details_url_locale_segment, /^[a-z]{2}-[a-z]{2}$/);
  assert.equal(detail.download_url_value, null);
  assert.equal(detail.download_url_template_kind, 1);
  assert.ok(detail.download_url_host_id > 0);
  assert.ok(detail.download_url_path_id > 0);
  assert.match(downloadUrlPath.path, /^\//);
});

test("buildBrowserDatabase dedupes repeated templated download paths into download_url_paths", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const foundModern = await readExample("187732.json");
  const notFound = await readAjaxExample("1 not found.json");

  await crawlDatabase({
    rootDir,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 2,
    fetchImpl: createLookupFixtureFetch(async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": found.text,
        "3": notFound.text,
        "4": foundModern.text.replace(/187732/g, "4"),
        "5": notFound.text,
        "6": notFound.text,
      };
      return createResponse(200, responses[id]);
    }),
  });

  const sharedPath = "http://cn.download.nvidia.com/Windows/Quadro_Certified/332.76/test-driver.exe";
  const masterDb = new Database(getPaths(rootDir).databaseFile);
  masterDb.prepare(`
    UPDATE drivers
    SET download_url = ?
    WHERE id IN (2, 4)
  `).run(sharedPath);
  masterDb.close();

  await buildBrowserDatabase({
    rootDir,
    stdout: createMemoryStream(),
  });

  const db = openBrowserDb(rootDir);
  const detailRows = db.prepare(`
    SELECT
      driver_id,
      download_url_value,
      download_url_template_kind,
      download_url_path_id
    FROM driver_detail
    WHERE driver_id IN (2, 4)
    ORDER BY driver_id ASC
  `).all();
  const dictionaryRows = db.prepare(`
    SELECT path_id, path
    FROM download_url_paths
    WHERE path = '/Windows/Quadro_Certified/332.76/test-driver.exe'
  `).all();
  db.close();

  assert.equal(dictionaryRows.length, 1);
  assert.equal(detailRows[0].download_url_value, null);
  assert.equal(detailRows[1].download_url_value, null);
  assert.equal(detailRows[0].download_url_template_kind, 1);
  assert.equal(detailRows[1].download_url_template_kind, 1);
  assert.equal(detailRows[0].download_url_path_id, dictionaryRows[0].path_id);
  assert.equal(detailRows[1].download_url_path_id, dictionaryRows[0].path_id);
});

test("buildBrowserDatabase preserves literal URL fallbacks and missing URL sentinels", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const foundModern = await readExample("187732.json");
  const notFound = await readAjaxExample("1 not found.json");

  await crawlDatabase({
    rootDir,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 2,
    fetchImpl: createLookupFixtureFetch(async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": found.text,
        "3": notFound.text,
        "4": foundModern.text.replace(/187732/g, "4"),
        "5": notFound.text,
        "6": notFound.text,
      };
      return createResponse(200, responses[id]);
    }),
  });

  const masterDb = new Database(getPaths(rootDir).databaseFile);
  masterDb.prepare(`
    UPDATE drivers
    SET
      details_url = '',
      download_url = ''
    WHERE id = 2
  `).run();
  masterDb.prepare(`
    UPDATE drivers
    SET
      details_url = 'http://www.nvidia.com/object/nvswap_1.0.html',
      download_url = 'http://www.nvidia.com/object/maxtreme_9.00.01.html'
    WHERE id = 4
  `).run();
  masterDb.close();

  await buildBrowserDatabase({
    rootDir,
    stdout: createMemoryStream(),
  });

  const db = openBrowserDb(rootDir);
  const detailRows = db.prepare(`
    SELECT
      driver_id,
      details_url_value,
      details_url_template_kind,
      download_url_value,
      download_url_template_kind
    FROM driver_detail
    WHERE driver_id IN (2, 4)
    ORDER BY driver_id ASC
  `).all();
  db.close();

  assert.deepEqual(detailRows, [
    {
      details_url_template_kind: null,
      details_url_value: "-1",
      download_url_template_kind: null,
      download_url_value: "-1",
      driver_id: 2,
    },
    {
      details_url_template_kind: null,
      details_url_value: "http://www.nvidia.com/object/nvswap_1.0.html",
      download_url_template_kind: null,
      download_url_value: "http://www.nvidia.com/object/maxtreme_9.00.01.html",
      driver_id: 4,
    },
  ]);
});

test("buildBrowserDatabase fails clearly when a found product no longer maps to lookup values", async () => {
  const rootDir = await makeTempRoot();
  const foundModern = await readExample("187732.json");
  const notFound = await readAjaxExample("1 not found.json");

  await crawlDatabase({
    rootDir,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 2,
    fetchImpl: createLookupFixtureFetch(async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": foundModern.text.replace(/187732/g, "2"),
        "3": notFound.text,
        "4": notFound.text,
      };
      return createResponse(200, responses[id]);
    }),
  });

  const db = new Database(getPaths(rootDir).databaseFile);
  db.prepare(`
    DELETE FROM lookup_values
    WHERE type_id = 3
      AND name = ?
  `).run("GeForce RTX 3090 Ti");
  db.close();

  await assert.rejects(
    buildBrowserDatabase({
      rootDir,
      stdout: createMemoryStream(),
    }),
    /unmapped product names GeForce RTX 3090 Ti/
  );
});

test("parseLookupValueSearchXml preserves NVIDIA parent branching metadata", async () => {
  const productTypes = parseLookupValueSearchXml(await readLookupExample(1), 1);
  const series = parseLookupValueSearchXml(await readLookupExample(2), 2);
  const products = parseLookupValueSearchXml(await readLookupExample(3), 3);
  const operatingSystems = parseLookupValueSearchXml(await readLookupExample(4), 4);
  const languages = parseLookupValueSearchXml(await readLookupExample(5), 5);

  assert.equal(productTypes.find((entry) => entry.value === "1").name, "GeForce");

  const geforceRtx50Series = series.find((entry) => entry.name === "GeForce RTX 50 Series");
  assert.equal(geforceRtx50Series.parentTypeId, 1);
  assert.equal(geforceRtx50Series.parentValue, "1");
  assert.equal(geforceRtx50Series.requiresProduct, "True");

  const childProduct = products.find((entry) => entry.parentValue === geforceRtx50Series.value);
  assert.equal(childProduct.parentTypeId, 2);

  assert.equal(operatingSystems.find((entry) => entry.name === "Windows 11").code, "10.0");
  assert.equal(languages.find((entry) => entry.value === "1").name, "English (US)");
});

test("refreshLookupValues stores TypeID 1-5 lookup tables and updates changed values", async () => {
  const rootDir = await makeTempRoot();
  const repository = await openRepository(rootDir);

  try {
    const firstRefresh = await refreshLookupValues({
      repository,
      fetchImpl: createLookupFixtureFetch(async () => {
        throw new Error("driver fetch should not be called while refreshing lookups");
      }),
      stderr: createMemoryStream(),
      sleepImpl: async () => {},
    });

    assert.equal(firstRefresh.exitCode, 0);
    assert.deepEqual(firstRefresh.changedTypes.map((entry) => entry.typeId), LOOKUP_TYPE_DEFINITIONS.map((entry) => entry.typeId));

    const typeOneXml = await readLookupExample(1);
    const mutatedTypeOneXml = typeOneXml.replace(
      "</LookupValues>",
      "<LookupValue><Name>Test Product Type</Name><Value>999</Value></LookupValue></LookupValues>"
    );

    const secondRefresh = await refreshLookupValues({
      repository,
      fetchImpl: createLookupFixtureFetch(async () => {
        throw new Error("driver fetch should not be called while refreshing lookups");
      }, {
        1: mutatedTypeOneXml,
      }),
      stderr: createMemoryStream(),
      sleepImpl: async () => {},
    });

    assert.equal(secondRefresh.exitCode, 0);
    assert.deepEqual(secondRefresh.changedTypes.map((entry) => entry.typeId), [1]);
  } finally {
    repository.close();
  }

  const db = openTempDb(rootDir);
  const sourceRows = db.prepare("SELECT type_id, entry_count FROM lookup_sources ORDER BY type_id ASC").all();
  const testProductType = db.prepare("SELECT name FROM lookup_values WHERE type_id = 1 AND value = '999'").get();
  const seriesRow = db.prepare("SELECT parent_type_id, parent_value FROM lookup_values WHERE type_id = 2 AND name = 'GeForce RTX 50 Series'").get();
  const productRow = db.prepare("SELECT parent_type_id FROM lookup_values WHERE type_id = 3 AND parent_value = ? LIMIT 1").get("131");
  const typeSixCount = db.prepare("SELECT COUNT(*) AS count FROM lookup_values WHERE type_id = 6").get();
  db.close();

  assert.deepEqual(sourceRows.map((row) => row.type_id), [1, 2, 3, 4, 5]);
  assert.equal(sourceRows.find((row) => row.type_id === 1).entry_count, 11);
  assert.deepEqual(testProductType, { name: "Test Product Type" });
  assert.deepEqual(seriesRow, { parent_type_id: 1, parent_value: "1" });
  assert.deepEqual(productRow, { parent_type_id: 2 });
  assert.equal(typeSixCount.count, 0);
});

test("refreshLookupValues ignores lookup entry reorder-only changes", async () => {
  const rootDir = await makeTempRoot();
  const repository = await openRepository(rootDir);

  try {
    const firstRefresh = await refreshLookupValues({
      repository,
      fetchImpl: createLookupFixtureFetch(async () => {
        throw new Error("driver fetch should not be called while refreshing lookups");
      }),
      stderr: createMemoryStream(),
      sleepImpl: async () => {},
    });

    assert.equal(firstRefresh.exitCode, 0);
    assert.deepEqual(firstRefresh.changedTypes.map((entry) => entry.typeId), LOOKUP_TYPE_DEFINITIONS.map((entry) => entry.typeId));

    const reorderedProductsXml = reverseLookupValueBlocks(await readLookupExample(3));
    const secondRefresh = await refreshLookupValues({
      repository,
      fetchImpl: createLookupFixtureFetch(async () => {
        throw new Error("driver fetch should not be called while refreshing lookups");
      }, {
        3: reorderedProductsXml,
      }),
      stderr: createMemoryStream(),
      sleepImpl: async () => {},
    });

    assert.equal(secondRefresh.exitCode, 0);
    assert.deepEqual(secondRefresh.changedTypes, []);
  } finally {
    repository.close();
  }
});

test("crawlDatabase refreshes NVIDIA lookup tables before crawling drivers by default", async () => {
  const rootDir = await makeTempRoot();
  const notFound = await readExample("404 not found.json");
  const stdout = createMemoryStream();

  const result = await crawlDatabase({
    rootDir,
    stdout,
    stderr: createMemoryStream(),
    concurrency: 1,
    maxTrailingNotFound: 1,
    fetchImpl: createLookupFixtureFetch(async () => createResponse(200, notFound.text)),
  });

  assert.equal(result.exitCode, 0);
  assert.match(stdout.toString(), /lookup TypeID 1 product_type updated 10 values/);

  const db = openTempDb(rootDir);
  const lookupSourceCount = db.prepare("SELECT COUNT(*) AS count FROM lookup_sources").get();
  const driverTwo = db.prepare("SELECT status FROM drivers WHERE id = 2").get();
  db.close();

  assert.equal(lookupSourceCount.count, 5);
  assert.deepEqual(driverTwo, { status: "pending_frontier" });
});

test("crawlDatabase stores found rows in sqlite and archives raw payload snapshots for future rebuilds", async () => {
  const rootDir = await makeTempRoot();
  const foundTwo = await readExample("2.json");
  const foundModern = await readExample("187732.json");
  const notFound = await readExample("404 not found.json");

  const responses = new Map([
    ["2", foundTwo.text],
    ["3", notFound.text],
    ["4", foundModern.text.replace(/187732/g, "4")],
    ["5", notFound.text],
    ["6", notFound.text],
  ]);

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 2,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, responses.get(id));
    },
  });

  assert.equal(result.exitCode, 0);

  const db = openTempDb(rootDir);
  const driverTwo = db.prepare("SELECT status, version, is_beta, is_feature_preview FROM drivers WHERE id = 2").get();
  const driverThree = db.prepare("SELECT status FROM drivers WHERE id = 3").get();
  const driverFour = db.prepare("SELECT status, version, is_beta, is_feature_preview FROM drivers WHERE id = 4").get();
  const driverFive = db.prepare("SELECT status FROM drivers WHERE id = 5").get();
  const seriesCount = db.prepare("SELECT COUNT(*) AS count FROM driver_series WHERE driver_id = 4").get();
  db.close();

  assert.deepEqual(driverTwo, {
    status: "found",
    version: "96.85",
    is_beta: "0",
    is_feature_preview: "0",
  });
  assert.deepEqual(driverThree, { status: "confirmed_not_found" });
  assert.deepEqual(driverFour, {
    status: "found",
    version: "512.59",
    is_beta: "0",
    is_feature_preview: "0",
  });
  assert.deepEqual(driverFive, { status: "pending_frontier" });
  assert.ok(seriesCount.count > 0);
  const rawTwo = await fs.readFile(path.join(getPaths(rootDir).rawPayloadDir, "2.json"), "utf8");
  const rawFour = await fs.readFile(path.join(getPaths(rootDir).rawPayloadDir, "4.json"), "utf8");
  assert.equal(rawTwo, foundTwo.text.endsWith("\n") ? foundTwo.text : `${foundTwo.text}\n`);
  assert.match(rawFour, /"ID": "4"/);
});

test("crawlDatabase retries pending frontier rows on a later run and promotes interior misses", async () => {
  const rootDir = await makeTempRoot();
  const foundTwo = await readExample("2.json");
  const foundFive = await readExample("265870.json");
  const foundSeven = await readExample("187732.json");
  const notFound = await readExample("404 not found.json");

  await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 2,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": foundTwo.text,
        "3": foundFive.text.replace(/265870/g, "3"),
        "4": notFound.text,
        "5": notFound.text,
      };
      return createResponse(200, responses[id]);
    },
  });

  await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 2,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "4": notFound.text,
        "5": foundSeven.text.replace(/187732/g, "5"),
        "6": notFound.text,
        "7": notFound.text,
      };
      return createResponse(200, responses[id]);
    },
  });

  const db = openTempDb(rootDir);
  const statuses = db.prepare("SELECT id, status FROM drivers WHERE id BETWEEN 4 AND 7 ORDER BY id ASC").all();
  db.close();

  assert.deepEqual(statuses, [
    { id: 4, status: "confirmed_not_found" },
    { id: 5, status: "found" },
    { id: 6, status: "pending_frontier" },
    { id: 7, status: "pending_frontier" },
  ]);
});

test("crawlDatabase reports contentChanged false when rechecking unchanged pending frontier rows", async () => {
  const rootDir = await makeTempRoot();
  const found = await readExample("2.json");
  const notFound = await readExample("404 not found.json");

  const firstResult = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? found.text : notFound.text);
    },
  });

  assert.equal(firstResult.exitCode, 0);
  assert.equal(firstResult.contentChanged, true);

  const secondResult = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: async () => createResponse(200, notFound.text),
  });

  assert.equal(secondResult.exitCode, 0);
  assert.equal(secondResult.contentChanged, false);
});

test("crawlDatabase falls back to AEM driver details when AjaxDriverService returns GlobalTryCatchBlock", async () => {
  const rootDir = await makeTempRoot();
  const foundViaAem = await readExample("2.json");
  const notFound = await readAjaxExample("1 not found.json");
  const primaryErrorBody = `{ "Success" : "0", "IDS" : [{ "Success" : "0", "GlobalTryCatchBlock" : "mssqlnative error: [6005: SQLState: 42000 Message: SHUTDOWN is in progress.]" }] }`;
  const requestedUrls = [];

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));

      if (String(url).includes("AEMDriversContent/getDownloadDetails")) {
        const id = getRequestedFallbackDriverId(url);
        return createResponse(200, id === "2" ? foundViaAem.text : notFound.text);
      }

      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? primaryErrorBody : notFound.text);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(requestedUrls.some((url) => url.includes("AEMDriversContent/getDownloadDetails")), true);

  const db = openTempDb(rootDir);
  const driverTwo = db.prepare("SELECT status, version, name FROM drivers WHERE id = 2").get();
  db.close();

  assert.deepEqual(driverTwo, {
    status: "found",
    version: "96.85",
    name: "ForceWare Release 95",
  });
});

test("fresh crawl persists beta, feature preview, notes, and file size from the payload", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const mutatedPayload = JSON.parse(found.text);
  const downloadInfo = mutatedPayload.IDS[0].downloadInfo;
  const notFound = await readAjaxExample("1 not found.json");

  downloadInfo.IsBeta = "1";
  downloadInfo.IsFeaturePreview = "1";
  downloadInfo.DownloadURLFileSize = "12.34 MB";
  downloadInfo.ReleaseNotes = "Feature%20preview%20release%20notes";
  downloadInfo.OtherNotes = "Beta%20other%20notes";

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? JSON.stringify(mutatedPayload) : notFound.text);
    },
  });

  assert.equal(result.exitCode, 0);

  const db = openTempDb(rootDir);
  const row = db.prepare(`
    SELECT
      is_beta,
      is_feature_preview,
      download_file_size,
      release_notes,
      other_notes
    FROM drivers
    WHERE id = 2
  `).get();
  db.close();

  assert.deepEqual(row, {
    is_beta: "1",
    is_feature_preview: "1",
    download_file_size: "12.34 MB",
    release_notes: "Feature preview release notes",
    other_notes: "Beta other notes",
  });
});

test("fresh crawl skips preseeded confirmed-not-found rows in a sparse clean database", async () => {
  const rootDir = await makeTempRoot();
  const repository = await openRepository(rootDir);
  repository.promoteConfirmedNotFound(["3", "5"], new Date().toISOString());
  repository.close();

  const found = await readExample("2.json");
  const notFound = await readExample("404 not found.json");
  const requestedIds = [];

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      requestedIds.push(id);
      const responses = {
        "2": found.text,
        "4": notFound.text,
      };
      return createResponse(200, responses[id] || notFound.text);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestedIds, ["2", "4"]);
});

test("crawlDatabase accepts --prepopulate-notfoundids-style input and skips those confirmed-not-found IDs", async () => {
  const rootDir = await makeTempRoot();
  const notFoundIdsFile = path.join(rootDir, "notfoundids.txt");
  const found = await readExample("2.json");
  const notFound = await readExample("404 not found.json");
  const requestedIds = [];

  await fs.writeFile(notFoundIdsFile, "3\n5\n\n3\n", "utf8");

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    prepopulateNotFoundIdsFile: notFoundIdsFile,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      requestedIds.push(id);
      const responses = {
        "2": found.text,
        "4": notFound.text,
      };
      return createResponse(200, responses[id] || notFound.text);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestedIds, ["2", "4"]);

  const db = openTempDb(rootDir);
  const statuses = db.prepare("SELECT id, status FROM drivers WHERE id IN (3,5) ORDER BY id ASC").all();
  db.close();
  assert.deepEqual(statuses, [
    { id: 3, status: "confirmed_not_found" },
    { id: 5, status: "confirmed_not_found" },
  ]);
});

test("queryDatabase supports exact and compound filters from sqlite", async () => {
  const rootDir = await makeTempRoot();
  const foundOld = await readExample("2.json");
  const foundModern = await readExample("265870.json");
  const notFound = await readExample("404 not found.json");

  await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": foundOld.text,
        "3": foundModern.text.replace(/265870/g, "3").replace(/595\.58\.03/g, "595.58.03").replace(/595\.58/g, "595.58"),
        "4": notFound.text,
      };
      return createResponse(200, responses[id]);
    },
  });

  const stdout = createMemoryStream();
  const result = await queryDatabase({
    rootDir,
    stdout,
    filters: {
      version: "595.58",
      osCode: "linux64",
      product: "5090",
    },
  });

  assert.equal(result.exitCode, 0);
  const records = JSON.parse(stdout.toString());
  assert.equal(records.length, 1);
  assert.equal(records[0].version, "595.58");
  assert.equal(records[0].osCode, "linux64");
});

test("statsDatabase reports useful crawl summary details from sqlite", async () => {
  const rootDir = await makeTempRoot();
  const foundOld = await readExample("2.json");
  const foundModern = await readExample("187732.json");
  const notFound = await readExample("404 not found.json");
  const stdout = createMemoryStream();

  await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 3,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": foundOld.text,
        "3": notFound.text,
        "4": notFound.text,
        "5": foundModern.text.replace(/187732/g, "5"),
        "6": notFound.text,
        "7": notFound.text,
        "8": notFound.text,
      };
      return createResponse(200, responses[id]);
    },
  });

  const result = await statsDatabase({
    rootDir,
    stdout,
    topGaps: 3,
  });

  assert.equal(result.exitCode, 0);
  const stats = JSON.parse(stdout.toString());
  assert.deepEqual(stats.statusCounts, {
    found: 2,
    confirmedNotFound: 2,
    pendingFrontier: 3,
  });
  assert.equal(stats.crawlPosition.nextUnresolvedId, 6);
  assert.equal(stats.frontier.firstPendingId, 6);
  assert.equal(stats.frontier.lastPendingId, 8);
  assert.equal(stats.foundExtremes.highestFound.id, 5);
  assert.equal(stats.lastRun.stopReason, "max_trailing_not_found_reached");
  assert.equal(stats.lastRun.lastProcessedId, "8");
  assert.deepEqual(stats.largestConfirmedNotFoundGap, {
    startId: 3,
    endId: 4,
    length: 2,
    previousKnown: {
      id: 2,
      status: "found",
      version: "96.85",
      displayVersion: "",
      name: "ForceWare Release 95",
    },
    nextKnown: {
      id: 5,
      status: "found",
      version: "512.59",
      displayVersion: "",
      name: "GeForce Game Ready Driver",
    },
  });
  assert.equal(stats.topConfirmedNotFoundGaps.length, 1);
});

test("browser-safe query helpers can be imported and used without node-specific code", async () => {
  const browserModuleUrl = pathToFileURL(path.join(repoRoot, "browser", "query-filters.mjs")).href;
  const browserQueryModule = await import(browserModuleUrl);

  const filters = browserQueryModule.parseQueryFilters([
    "--version",
    "595.58",
    "--product",
    "5090",
  ]);

  assert.deepEqual(filters, {
    version: "595.58",
    product: "5090",
  });
  assert.match(browserQueryModule.getQueryUsageFragment(), /--version/);
  assert.match(browserQueryModule.getQueryUsageFragment(), /--is-beta/);
});

test("additive unknown keys are stored in extra_fields_json", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const mutatedPayload = JSON.parse(found.text);
  mutatedPayload.IDS[0].downloadInfo.NewSchemaField = "";
  const notFound = await readAjaxExample("1 not found.json");

  await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? JSON.stringify(mutatedPayload) : notFound.text);
    },
  });

  const db = openTempDb(rootDir);
  const row = db.prepare("SELECT extra_fields_json FROM drivers WHERE id = 2").get();
  db.close();

  assert.deepEqual(JSON.parse(row.extra_fields_json), { NewSchemaField: "" });
});

test("incompatible core shape fails clearly", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const mutatedPayload = JSON.parse(found.text);
  mutatedPayload.IDS[0].downloadInfo.series = {};
  const stderr = createMemoryStream();

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    stdout: createMemoryStream(),
    stderr,
    retries: 0,
    maxTrailingNotFound: 1,
    fetchImpl: async () => createResponse(200, JSON.stringify(mutatedPayload)),
  });

  assert.equal(result.exitCode, 1);
  assert.match(stderr.toString(), /core shape mismatch: field series must be an array/);
});

test("runCli retries unexpected 200 response bodies and exits after the retry limit", async () => {
  const rootDir = await makeTempRoot();
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const retryDelays = [];
  let requestCount = 0;

  const exitCode = await runCli(["3", "--retries", "2", "--concurrency", "1"], {
    rootDir,
    refreshLookups: false,
    stdout,
    stderr,
    sleepImpl: async (delayMs) => {
      retryDelays.push(delayMs);
    },
    fetchImpl: async () => {
      requestCount += 1;
      return createResponse(200, "{\"Success\":\"1\",\"IDS\":[]}");
    },
  });

  const stderrText = stderr.toString();
  assert.equal(exitCode, 1);
  assert.equal(requestCount, 3);
  assert.deepEqual(retryDelays, [1000, 2000]);
  assert.match(stderrText, /Unexpected 200 response for driver ID 2; retry 1\/2 in 1s/);
  assert.match(stderrText, /Unexpected 200 response for driver ID 2; retry 2\/2 in 2s/);
  assert.equal((stderrText.match(/Unexpected 200 response: body did not match a known success or semantic not-found shape/g) || []).length, 3);
});

test("runCli retries retryable HTTP errors and exits after the retry limit", async () => {
  const rootDir = await makeTempRoot();
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const retryDelays = [];
  let requestCount = 0;

  const exitCode = await runCli(["3", "--retries", "2", "--concurrency", "1"], {
    rootDir,
    refreshLookups: false,
    stdout,
    stderr,
    sleepImpl: async (delayMs) => {
      retryDelays.push(delayMs);
    },
    fetchImpl: async () => {
      requestCount += 1;
      return createResponse(500, "server exploded");
    },
  });

  const stderrText = stderr.toString();
  assert.equal(exitCode, 1);
  assert.equal(requestCount, 3);
  assert.deepEqual(retryDelays, [1000, 2000]);
  assert.match(stderrText, /retry 1\/2 in 1s/);
  assert.match(stderrText, /retry 2\/2 in 2s/);
  assert.equal((stderrText.match(/Unexpected HTTP status 500/g) || []).length, 3);
  assert.equal((stderrText.match(/server exploded/g) || []).length, 3);
});

test("runCli retries timed out requests and exits after the retry limit", async () => {
  const rootDir = await makeTempRoot();
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const retryDelays = [];
  let requestCount = 0;

  const exitCode = await runCli(["3", "--retries", "2", "--timeout", "0.001", "--concurrency", "1"], {
    rootDir,
    refreshLookups: false,
    stdout,
    stderr,
    sleepImpl: async (delayMs) => {
      retryDelays.push(delayMs);
    },
    fetchImpl: async (_url, init = {}) => {
      requestCount += 1;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });

  const stderrText = stderr.toString();
  assert.equal(exitCode, 1);
  assert.equal(requestCount, 3);
  assert.deepEqual(retryDelays, [1000, 2000]);
  assert.match(stderrText, /Request timeout for driver ID 2; retry 1\/2 in 1s/);
  assert.match(stderrText, /Request timeout for driver ID 2; retry 2\/2 in 2s/);
  assert.equal((stderrText.match(/Request timed out after 1ms for driver ID 2/g) || []).length, 3);
});

test("parseCrawlArgs supports named crawl flags and the legacy positional max value", async () => {
  assert.deepEqual(parseCrawlArgs(["--max-trailing-not-found", "15", "--concurrency", "4"]), {
    maxTrailingNotFound: 15,
    concurrency: 4,
    retries: DEFAULT_RETRIES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prepopulateNotFoundIdsFile: null,
    prepopulateFromDataRawDir: null,
    writeChangeStatusFile: null,
  });

  assert.deepEqual(parseCrawlArgs(["15", "--concurrency", "4"]), {
    maxTrailingNotFound: 15,
    concurrency: 4,
    retries: DEFAULT_RETRIES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prepopulateNotFoundIdsFile: null,
    prepopulateFromDataRawDir: null,
    writeChangeStatusFile: null,
  });

  assert.deepEqual(parseCrawlArgs(["--concurrency", "2", "--retries", "0", "--timeout", "7", "--prepopulate-notfoundids", "ids.txt"]), {
    maxTrailingNotFound: DEFAULT_MAX_TRAILING_NOT_FOUND,
    concurrency: 2,
    retries: 0,
    timeoutMs: 7000,
    prepopulateNotFoundIdsFile: "ids.txt",
    prepopulateFromDataRawDir: null,
    writeChangeStatusFile: null,
  });

  assert.deepEqual(parseCrawlArgs(["--prepopulate-from-data-raw", "data-raw", "--write-change-status", "status.txt"]), {
    maxTrailingNotFound: DEFAULT_MAX_TRAILING_NOT_FOUND,
    concurrency: DEFAULT_CONCURRENCY,
    retries: DEFAULT_RETRIES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prepopulateNotFoundIdsFile: null,
    prepopulateFromDataRawDir: "data-raw",
    writeChangeStatusFile: "status.txt",
  });
});

test("parseStatsArgs supports the top gap limit flag", async () => {
  assert.deepEqual(parseStatsArgs(["--top-gaps", "7"]), {
    topGaps: 7,
  });
});

test("parseBuildBrowserDbArgs rejects unexpected arguments", async () => {
  assert.deepEqual(parseBuildBrowserDbArgs([]), {});
  assert.throws(() => parseBuildBrowserDbArgs(["extra"]), /Unexpected buildbrowserdb argument/);
});

test("runCli prints top-level help for --help", async () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await runCli(["--help"], {
    rootDir: await makeTempRoot(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Usage:/);
  assert.match(stdout.toString(), /--max-trailing-not-found <n>/);
  assert.match(stdout.toString(), /--retries <n>/);
  assert.match(stdout.toString(), /HTTP 404 still fails immediately/);
  assert.match(stdout.toString(), /--timeout <seconds>/);
  assert.match(stdout.toString(), /--prepopulate-notfoundids <file>/);
  assert.match(stdout.toString(), /--prepopulate-from-data-raw <dir>/);
  assert.match(stdout.toString(), /--write-change-status <file>/);
  assert.match(stdout.toString(), /node app\.js stats/);
  assert.match(stdout.toString(), /--top-gaps <n>/);
  assert.match(stdout.toString(), /node app\.js buildbrowserdb/);
  assert.match(stdout.toString(), /node app\.js query/);
});

test("runCli prints query help for query --help", async () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await runCli(["query", "--help"], {
    rootDir: await makeTempRoot(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Query options:/);
  assert.match(stdout.toString(), /--version <version>/);
  assert.match(stdout.toString(), /--product <productName>/);
});

test("runCli prints stats help for stats --help", async () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await runCli(["stats", "--help"], {
    rootDir: await makeTempRoot(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Stats options:/);
  assert.match(stdout.toString(), /--top-gaps <n>/);
});

test("runCli prints buildbrowserdb help for buildbrowserdb --help", async () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await runCli(["buildbrowserdb", "--help"], {
    rootDir: await makeTempRoot(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Browser DB options:/);
  assert.match(stdout.toString(), /data\/browser\.sqlite/);
});

test("runCli buildbrowserdb builds the derived browser database without fetching", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const notFound = await readAjaxExample("1 not found.json");

  await crawlDatabase({
    rootDir,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: createLookupFixtureFetch(async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? found.text : notFound.text);
    }),
  });

  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const exitCode = await runCli(["buildbrowserdb"], {
    rootDir,
    stdout,
    stderr,
    fetchImpl: async () => {
      throw new Error("buildbrowserdb should not fetch");
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /writing compressed browser database/);
  assert.match(stdout.toString(), /built browser database/);
  assert.match(stdout.toString(), /wrote browser database metadata/);

  const db = openBrowserDb(rootDir);
  const row = db.prepare(`
    SELECT tv.value AS name
    FROM drivers d
    LEFT JOIN text_values tv
      ON tv.text_id = d.name_text_id
    WHERE d.id = 2
  `).get();
  db.close();
  const browserMetadata = JSON.parse(
    await fs.readFile(getPaths(rootDir).browserDatabaseMetaFile, "utf8")
  );
  assert.deepEqual(row, { name: "ForceWare Release 95" });
  assert.equal(browserMetadata.databaseFileName, "browser.sqlite");
  assert.equal(browserMetadata.compressedDatabaseFileName, "browser.sqlite.gz");
});

test("crawlDatabase checkpoints and removes WAL sidecars on close", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const notFound = await readAjaxExample("1 not found.json");

  const result = await crawlDatabase({
    rootDir,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: createLookupFixtureFetch(async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? found.text : notFound.text);
    }),
  });

  assert.equal(result.exitCode, 0);

  const { databaseFile } = getPaths(rootDir);
  await fs.access(databaseFile);
  await assert.rejects(fs.access(`${databaseFile}-wal`));
  await assert.rejects(fs.access(`${databaseFile}-shm`));
});

test("crawlDatabase resets HTTP retry backoff after a successful request", async () => {
  const rootDir = await makeTempRoot();
  const foundTwo = await readExample("2.json");
  const foundModern = await readExample("187732.json");
  const notFound = await readExample("404 not found.json");
  const retryDelays = [];
  const requestCounts = new Map();

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    concurrency: 1,
    retries: 2,
    maxTrailingNotFound: 1,
    sleepImpl: async (delayMs) => {
      retryDelays.push(delayMs);
    },
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      const count = (requestCounts.get(id) || 0) + 1;
      requestCounts.set(id, count);

      if (id === "2") {
        if (count <= 2) {
          return createResponse(500, `temporary failure ${count}`);
        }

        return createResponse(200, foundTwo.text);
      }

      if (id === "3") {
        if (count === 1) {
          return createResponse(503, "busy");
        }

        return createResponse(200, foundModern.text.replace(/187732/g, "3"));
      }

      if (id === "4") {
        return createResponse(200, notFound.text);
      }

      throw new Error(`Unexpected id ${id}`);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(retryDelays, [1000, 2000, 1000]);
  assert.equal(requestCounts.get("2"), 3);
  assert.equal(requestCounts.get("3"), 2);
});

test("crawlDatabase fails immediately on HTTP 404 without retrying", async () => {
  const rootDir = await makeTempRoot();
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const retryDelays = [];
  let requestCount = 0;

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    stdout,
    stderr,
    concurrency: 1,
    retries: 6,
    sleepImpl: async (delayMs) => {
      retryDelays.push(delayMs);
    },
    fetchImpl: async () => {
      requestCount += 1;
      return createResponse(404, "missing");
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(requestCount, 1);
  assert.deepEqual(retryDelays, []);
  assert.match(stderr.toString(), /Unexpected HTTP status 404/);
  assert.match(stderr.toString(), /missing/);
});

test("crawlDatabase retries malformed Success=0 bodies and exits after the retry limit", async () => {
  const rootDir = await makeTempRoot();
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const retryDelays = [];
  let requestCount = 0;
  const invalid = await readAjaxExample("0 invalid.json");

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    stdout,
    stderr,
    concurrency: 1,
    retries: 2,
    sleepImpl: async (delayMs) => {
      retryDelays.push(delayMs);
    },
    fetchImpl: async () => {
      requestCount += 1;
      return createResponse(200, invalid.text);
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(requestCount, 3);
  assert.deepEqual(retryDelays, [1000, 2000]);
  assert.match(stderr.toString(), /Unexpected 200 response/);
  assert.match(stderr.toString(), /body did not match a known success or semantic not-found shape/);
});

test("crawlDatabase repairs trailing commas in otherwise valid AjaxDriverService JSON", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const notFound = await readAjaxExample("1 not found.json");
  const payload = JSON.parse(found.text);
  payload.IDS[0].downloadInfo.series = [
    {
      seriesname: "nForce%20Audio",
    },
  ];

  const malformedText = JSON.stringify(payload).replace(
    "\"seriesname\":\"nForce%20Audio\"}",
    "\"seriesname\":\"nForce%20Audio\",}"
  );

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    concurrency: 1,
    maxTrailingNotFound: 1,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? malformedText : notFound.text);
    },
  });

  assert.equal(result.exitCode, 0);

  const db = openTempDb(rootDir);
  const row = db.prepare("SELECT name FROM drivers WHERE id = 2").get();
  const seriesRows = db.prepare("SELECT series_name FROM driver_series WHERE driver_id = 2").all();
  const productRows = db.prepare("SELECT product_name FROM driver_products WHERE driver_id = 2").all();
  db.close();

  assert.deepEqual(row, { name: "ForceWare Release 95" });
  assert.deepEqual(seriesRows, [{ series_name: "nForce Audio" }]);
  assert.deepEqual(productRows, []);
});

test("crawlDatabase repairs control characters embedded in JSON strings", async () => {
  const rootDir = await makeTempRoot();
  const found = await readAjaxExample("2.json");
  const notFound = await readAjaxExample("1 not found.json");
  const malformedText = found.text.replace(
    "\"BannerURLGfe\" : \"\"",
    "\"BannerURLGfe\" : \"\nhttp://example.com/banner\""
  );

  const result = await crawlDatabase({
    rootDir,
    refreshLookups: false,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    concurrency: 1,
    maxTrailingNotFound: 1,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? malformedText : notFound.text);
    },
  });

  assert.equal(result.exitCode, 0);

  const db = openTempDb(rootDir);
  const row = db.prepare("SELECT name, version FROM drivers WHERE id = 2").get();
  db.close();

  assert.deepEqual(row, {
    name: "ForceWare Release 95",
    version: "96.85",
  });
});

test("runCli can prepopulate found rows from a data-raw directory and exit without crawling", async () => {
  const rootDir = await makeTempRoot();
  const rawDir = path.join(rootDir, "seed-data-raw");
  const found = await readAjaxExample("2.json");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(rawDir, "2.json"), found.text, "utf8");

  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const exitCode = await runCli(["--prepopulate-from-data-raw", rawDir], {
    rootDir,
    stdout,
    stderr,
    fetchImpl: async () => {
      throw new Error("prepopulate-from-data-raw should not fetch");
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /prepopulated 1 found driver rows/);

  const db = openTempDb(rootDir);
  const row = db.prepare("SELECT status, name, version FROM drivers WHERE id = 2").get();
  const appState = db.prepare("SELECT value_text FROM app_state WHERE key = 'last_stop_reason'").get();
  db.close();

  assert.deepEqual(row, {
    status: "found",
    name: "ForceWare Release 95",
    version: "96.85",
  });
  assert.deepEqual(appState, {
    value_text: "prepopulated_from_data_raw",
  });
});

test("runtime shutdown aborts the in-flight fetch and preserves committed rows", async () => {
  const rootDir = await makeTempRoot();
  const foundTwo = await readExample("2.json");
  const runtimeControl = createRuntimeControl();
  let signalSecondRequest;

  const crawlPromise = crawlDatabase({
    rootDir,
    refreshLookups: false,
    runtimeControl,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 10,
    fetchImpl: async (url, init = {}) => {
      const id = getRequestedDriverId(url);
      if (id === "2") {
        return createResponse(200, foundTwo.text);
      }

      if (id === "3") {
        signalSecondRequest();
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      }

      throw new Error(`Unexpected id ${id}`);
    },
  });

  await new Promise((resolve) => {
    signalSecondRequest = resolve;
  });
  runtimeControl.requestShutdown();

  const result = await crawlPromise;
  assert.equal(result.exitCode, 130);

  const db = openTempDb(rootDir);
  const driverTwo = db.prepare("SELECT status FROM drivers WHERE id = 2").get();
  const driverThree = db.prepare("SELECT status FROM drivers WHERE id = 3").get();
  const lastStopReason = db.prepare("SELECT value_text FROM app_state WHERE key = 'last_stop_reason'").get();
  db.close();

  assert.deepEqual(driverTwo, { status: "found" });
  assert.equal(driverThree, undefined);
  assert.deepEqual(lastStopReason, { value_text: "sigint" });
});

test("runCli query mode parses flags and prints matching sqlite-backed records", async () => {
  const rootDir = await makeTempRoot();
  const foundModern = await readExample("265870.json");
  const notFound = await readExample("404 not found.json");

  await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 1,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? foundModern.text.replace(/265870/g, "2") : notFound.text);
    },
  });

  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const exitCode = await runCli([
    "query",
    "--version",
    "595.58",
    "--os-code",
    "linux64",
    "--product",
    "5090",
  ], {
    rootDir,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  const records = JSON.parse(stdout.toString());
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "2");
});

test("runCli stats mode prints the sqlite-backed crawl summary", async () => {
  const rootDir = await makeTempRoot();
  const foundOld = await readExample("2.json");
  const foundModern = await readExample("187732.json");
  const notFound = await readExample("404 not found.json");

  await crawlDatabase({
    rootDir,
    refreshLookups: false,
    concurrency: 1,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    maxTrailingNotFound: 3,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      const responses = {
        "2": foundOld.text,
        "3": notFound.text,
        "4": notFound.text,
        "5": foundModern.text.replace(/187732/g, "5"),
        "6": notFound.text,
        "7": notFound.text,
        "8": notFound.text,
      };
      return createResponse(200, responses[id]);
    },
  });

  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const exitCode = await runCli(["stats", "--top-gaps", "1"], {
    rootDir,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  const stats = JSON.parse(stdout.toString());
  assert.equal(stats.topConfirmedNotFoundGaps.length, 1);
  assert.equal(stats.largestConfirmedNotFoundGap.length, 2);
  assert.equal(stats.crawlPosition.nextUnresolvedId, 6);
});

test("runCli accepts the crawl concurrency flag", async () => {
  const rootDir = await makeTempRoot();
  const foundTwo = await readExample("2.json");
  const notFound = await readExample("404 not found.json");
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await runCli(["1", "--concurrency", "2"], {
    rootDir,
    refreshLookups: false,
    stdout,
    stderr,
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? foundTwo.text : notFound.text);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /found 2/);
});

test("runCli writes 1 for changed crawl content and 0 for an unchanged rerun", async () => {
  const rootDir = await makeTempRoot();
  const found = await readExample("2.json");
  const notFound = await readExample("404 not found.json");
  const firstStatusFile = path.join(rootDir, "change-status-first.txt");
  const secondStatusFile = path.join(rootDir, "change-status-second.txt");

  const firstExitCode = await runCli(["1", "--write-change-status", firstStatusFile], {
    rootDir,
    refreshLookups: false,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    fetchImpl: async (url) => {
      const id = getRequestedDriverId(url);
      return createResponse(200, id === "2" ? found.text : notFound.text);
    },
  });

  assert.equal(firstExitCode, 0);
  assert.equal(await fs.readFile(firstStatusFile, "utf8"), "1\n");

  const secondExitCode = await runCli(["1", "--write-change-status", secondStatusFile], {
    rootDir,
    refreshLookups: false,
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
    fetchImpl: async () => createResponse(200, notFound.text),
  });

  assert.equal(secondExitCode, 0);
  assert.equal(await fs.readFile(secondStatusFile, "utf8"), "0\n");
});
