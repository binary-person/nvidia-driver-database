"use strict";

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { setTimeout: sleep } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");
const { createGzip, gzipSync } = require("node:zlib");
const Database = require("better-sqlite3");
const PromisePool = require("es6-promise-pool");

const DEFAULT_MAX_TRAILING_NOT_FOUND = 300;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RETRIES = 6;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_DRIVER_ID = 2;
const DEFAULT_DATA_DIR_NAME = "data";
const RAW_PAYLOAD_DIR_NAME = "data-raw";
const DATABASE_FILE_NAME = "nvidia-driver-database.sqlite";
const BROWSER_DATABASE_FILE_NAME = "browser.sqlite";
const BROWSER_DATABASE_GZIP_FILE_NAME = "browser.sqlite.gz";
const BROWSER_DATABASE_META_FILE_NAME = "browser.sqlite.meta.json";
const BROWSER_TEMP_DATABASE_FILE_NAME = "browser-temp.sqlite";
const NVIDIA_DRIVER_DETAILS_URL_PREFIX = "https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=GetDownloadDetails&downloadID=";
const NVIDIA_AEM_DRIVER_DETAILS_URL_PREFIX = "https://www.nvidia.com/services/com.nvidia.services/AEMDriversContent/getDownloadDetails?";
const NVIDIA_LOOKUP_VALUE_SEARCH_URL_PREFIX = "https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=";
const SQLITE_SCHEMA_VERSION = "3";
const HELP_FLAGS = new Set(["--help", "-h"]);
const BROWSER_TEXT_TYPES = Object.freeze({
  RELEASE: 1,
  VERSION: 2,
  DISPLAY_VERSION: 3,
  DRIVER_NAME: 4,
  GFE_DISPLAY_VERSION: 5,
});
const BROWSER_NOTE_TYPES = Object.freeze({
  RELEASE_NOTES: 6,
  OTHER_NOTES: 7,
});
const BROWSER_URL_VALUE_MISSING = "-1";
const BROWSER_DETAIL_URL_TEMPLATE_KINDS = Object.freeze({
  MODERN_NVIDIA_DETAILS: 1,
  LEGACY_DRIVER_RESULTS: 2,
});
const BROWSER_DOWNLOAD_URL_TEMPLATE_KINDS = Object.freeze({
  DOWNLOAD_HOST_PATH: 1,
});
const BROWSER_PRODUCT_NAME_ALIASES = Object.freeze({
  "NVIDIA RTX PRO 4500 Blackwell Server Edition": "NVIDIA RTX PRO 4500 Blackwell",
  "NVIDIA RTX PRO 4500 Blackwell Workstation Edition": "NVIDIA RTX PRO 4500 Blackwell",
  "NVIDIA RTX PRO 5000 48GB Blackwell": "NVIDIA RTX PRO 5000 Blackwell",
  "NVIDIA RTX PRO 5000 72GB Blackwell": "NVIDIA RTX PRO 5000 Blackwell",
});
const RELEASE_DATE_MONTHS = new Map([
  ["jan", 0],
  ["feb", 1],
  ["mar", 2],
  ["apr", 3],
  ["may", 4],
  ["jun", 5],
  ["jul", 6],
  ["aug", 7],
  ["sep", 8],
  ["oct", 9],
  ["nov", 10],
  ["dec", 11],
]);

const LOOKUP_TYPE_DEFINITIONS = [
  { typeId: 1, lookupName: "product_type", parentTypeId: null },
  { typeId: 2, lookupName: "product_series", parentTypeId: 1 },
  { typeId: 3, lookupName: "product", parentTypeId: 2 },
  { typeId: 4, lookupName: "operating_system", parentTypeId: null },
  { typeId: 5, lookupName: "language", parentTypeId: null },
];

const KNOWN_LOOKUP_ATTRS = new Set([
  "Code",
  "IsSelectLess",
  "ParentID",
  "RequiresProduct",
]);

const REQUIRED_SUMMARY_FIELDS = {
  Release: "release",
  Version: "version",
  DisplayVersion: "displayVersion",
  GFE_DisplayVersion: "gfeDisplayVersion",
  ReleaseDateTime: "releaseDateTime",
  OSName: "osName",
  OsCode: "osCode",
  LanguageName: "languageName",
  Is64Bit: "is64Bit",
  IsWHQL: "isWHQL",
  IsRecommended: "isRecommended",
  IsDC: "isDC",
  IsCRD: "isCRD",
  IsBeta: "isBeta",
  IsFeaturePreview: "isFeaturePreview",
  DownloadURLFileSize: "downloadFileSize",
  ReleaseNotes: "releaseNotes",
  OtherNotes: "otherNotes",
  Name: "name",
  DetailsURL: "detailsUrl",
  DownloadURL: "downloadUrl",
};

const KNOWN_DOWNLOAD_INFO_KEYS = new Set([
  "Success",
  "ID",
  "DownloadTypeID",
  "DownloadStatusID",
  "Name",
  "NameLocalized",
  "ShortDescription",
  "DeviceToProductFamilyName",
  "Release",
  "Version",
  "DisplayVersion",
  "GFE_DisplayVersion",
  "CDKitUSBEmitterDriverVersion",
  "CDKitGPUDriverVersion",
  "IsBeta",
  "IsWHQL",
  "IsRecommended",
  "IsFeaturePreview",
  "IsNewest",
  "IsDC",
  "IsCRD",
  "HasNetInst",
  "CudaToolkitVersion",
  "IsArchive",
  "IsActive",
  "IsEmailRequired",
  "ReleaseDateTime",
  "DetailsURL",
  "DownloadURL",
  "EMAN_REVRES_BD",
  "EMITR_BD",
  "DownloadURLFileSize",
  "BannerURL",
  "BannerURLGfe",
  "ReleaseNotes",
  "OtherNotes",
  "InstallationNotes",
  "Overview",
  "LanguageName",
  "OSName",
  "OsCode",
  "OSList",
  "Is64Bit",
  "Messaging",
  "series",
]);

let browserQueryModulePromise = null;

function getPaths(rootDir, dataDirName = DEFAULT_DATA_DIR_NAME) {
  const dataDir = path.join(rootDir, dataDirName);
  return {
    rootDir,
    dataDir,
    rawPayloadDir: path.join(rootDir, RAW_PAYLOAD_DIR_NAME),
    databaseFile: path.join(dataDir, DATABASE_FILE_NAME),
    browserDatabaseFile: path.join(dataDir, BROWSER_DATABASE_FILE_NAME),
    browserDatabaseGzipFile: path.join(dataDir, BROWSER_DATABASE_GZIP_FILE_NAME),
    browserDatabaseMetaFile: path.join(dataDir, BROWSER_DATABASE_META_FILE_NAME),
    browserTempDatabaseFile: path.join(dataDir, BROWSER_TEMP_DATABASE_FILE_NAME),
  };
}

function loadBrowserQueryModule() {
  if (!browserQueryModulePromise) {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, "..", "browser", "query-filters.mjs")).href;
    browserQueryModulePromise = import(moduleUrl);
  }

  return browserQueryModulePromise;
}

async function writeTextFileAtomic(targetPath, text) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;

  try {
    await fs.writeFile(tempPath, text, "utf8");
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function hashFileSha256(targetPath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(targetPath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function writeBrowserDatabaseMetadata(paths, builtAt) {
  const stat = await fs.stat(paths.browserDatabaseFile);
  const gzipStat = await fs.stat(paths.browserDatabaseGzipFile);
  const sha256 = await hashFileSha256(paths.browserDatabaseFile);
  const metadata = {
    schemaVersion: 1,
    databaseFileName: BROWSER_DATABASE_FILE_NAME,
    compressedDatabaseFileName: BROWSER_DATABASE_GZIP_FILE_NAME,
    compression: "gzip",
    builtAt: builtAt || new Date().toISOString(),
    uncompressedSize: stat.size,
    compressedSize: gzipStat.size,
    sha256,
  };

  await writeTextFileAtomic(
    paths.browserDatabaseMetaFile,
    `${JSON.stringify(metadata, null, 2)}\n`
  );

  return metadata;
}

async function writeBrowserDatabaseGzip(paths) {
  const tempPath = `${paths.browserDatabaseGzipFile}.tmp-${process.pid}-${crypto.randomUUID()}`;

  try {
    await pipeline(
      fsSync.createReadStream(paths.browserDatabaseFile),
      createGzip({ level: 9, mtime: 0 }),
      fsSync.createWriteStream(tempPath)
    );
    await fs.rename(tempPath, paths.browserDatabaseGzipFile);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function persistRawPayload(paths, id, bodyText) {
  const normalizedId = normalizeId(id);
  if (!normalizedId) {
    throw new Error(`Cannot persist raw payload for non-numeric ID: ${id}`);
  }

  const targetPath = path.join(paths.rawPayloadDir, `${normalizedId}.json`);
  const normalizedBodyText = bodyText.endsWith("\n") ? bodyText : `${bodyText}\n`;
  await writeTextFileAtomic(targetPath, normalizedBodyText);
}

function safeDecode(value) {
  if (typeof value !== "string") {
    return "";
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hexValue) => String.fromCodePoint(Number.parseInt(hexValue, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimalValue) => String.fromCodePoint(Number.parseInt(decimalValue, 10)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function buildLookupValueSearchUrl(typeId) {
  return `${NVIDIA_LOOKUP_VALUE_SEARCH_URL_PREFIX}${typeId}`;
}

function parseLookupAttributes(attributeText) {
  const attrs = {};
  const attrPattern = /([A-Za-z0-9_:-]+)="([^"]*)"/g;
  let match;

  while ((match = attrPattern.exec(attributeText)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }

  return attrs;
}

function getLookupDefinition(typeId) {
  const numericTypeId = Number(typeId);
  return LOOKUP_TYPE_DEFINITIONS.find((definition) => definition.typeId === numericTypeId) || null;
}

function parseLookupValueSearchXml(xmlText, typeId) {
  const definition = getLookupDefinition(typeId);
  if (!definition) {
    throw new Error(`Unsupported NVIDIA lookup TypeID ${typeId}`);
  }

  if (typeof xmlText !== "string" || !/<LookupValueSearch\b/i.test(xmlText)) {
    throw new Error(`lookup TypeID ${typeId} response did not contain LookupValueSearch XML`);
  }

  const entryPattern = /<LookupValue\b([^>]*)>\s*<Name>([\s\S]*?)<\/Name>\s*<Value>([\s\S]*?)<\/Value>\s*<\/LookupValue>/g;
  const entries = [];
  let match;

  while ((match = entryPattern.exec(xmlText)) !== null) {
    const attrs = parseLookupAttributes(match[1]);
    const extraAttrs = {};
    Object.entries(attrs).forEach(([key, value]) => {
      if (!KNOWN_LOOKUP_ATTRS.has(key)) {
        extraAttrs[key] = value;
      }
    });

    const parentValue = attrs.ParentID || "";
    entries.push({
      typeId: definition.typeId,
      lookupName: definition.lookupName,
      value: decodeXmlEntities(match[3]).trim(),
      name: decodeXmlEntities(match[2]).trim(),
      parentTypeId: parentValue ? definition.parentTypeId : null,
      parentValue,
      code: attrs.Code || "",
      requiresProduct: attrs.RequiresProduct || "",
      isSelectLess: attrs.IsSelectLess || "",
      ordinal: entries.length,
      extraAttrs,
    });
  }

  if (entries.length === 0) {
    throw new Error(`lookup TypeID ${typeId} response did not contain any LookupValue entries`);
  }

  const duplicateValue = entries.find((entry, index) => (
    entries.findIndex((candidate) => candidate.value === entry.value) !== index
  ));

  if (duplicateValue) {
    throw new Error(`lookup TypeID ${typeId} contains duplicate value ${duplicateValue.value}`);
  }

  return entries;
}

function sortObjectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, value[key]])
  );
}

function hashLookupEntries(entries) {
  const normalized = entries.map((entry) => ({
    code: entry.code,
    extraAttrs: sortObjectKeys(entry.extraAttrs),
    isSelectLess: entry.isSelectLess,
    lookupName: entry.lookupName,
    name: entry.name,
    parentTypeId: entry.parentTypeId,
    parentValue: entry.parentValue,
    requiresProduct: entry.requiresProduct,
    typeId: entry.typeId,
    value: entry.value,
  }))
    .sort((left, right) => left.value.localeCompare(right.value));

  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizeId(value) {
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  return String(Number.parseInt(normalized, 10));
}

function stripTrailingCommasFromJsonLike(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  let changed = false;
  let escaped = false;
  let inString = false;
  let result = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      result += char;

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }

      if (text[lookahead] === "}" || text[lookahead] === "]") {
        changed = true;
        continue;
      }
    }

    result += char;
  }

  return changed ? result : text;
}

function escapeControlCharactersInJsonStrings(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  let changed = false;
  let escaped = false;
  let inString = false;
  let result = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!inString) {
      if (char === "\"") {
        inString = true;
      }

      result += char;
      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      result += char;
      inString = false;
      continue;
    }

    const code = char.charCodeAt(0);
    if (code < 0x20) {
      changed = true;

      if (char === "\n") {
        result += "\\n";
      } else if (char === "\r") {
        result += "\\r";
      } else if (char === "\t") {
        result += "\\t";
      } else if (char === "\b") {
        result += "\\b";
      } else if (char === "\f") {
        result += "\\f";
      } else {
        result += `\\u${code.toString(16).padStart(4, "0")}`;
      }

      continue;
    }

    result += char;
  }

  return changed ? result : text;
}

function repairDriverPayloadText(bodyText) {
  const withoutTrailingCommas = stripTrailingCommasFromJsonLike(bodyText);
  return escapeControlCharactersInJsonStrings(withoutTrailingCommas);
}

function parseDriverPayloadText(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    const sanitizedBodyText = repairDriverPayloadText(bodyText);
    if (sanitizedBodyText !== bodyText) {
      return JSON.parse(sanitizedBodyText);
    }

    throw error;
  }
}

function getDriverDetailsPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  if (typeof payload.Success === "string" && Array.isArray(payload.IDS)) {
    return payload;
  }

  if (
    payload.driverDetails
    && typeof payload.driverDetails === "object"
    && !Array.isArray(payload.driverDetails)
    && typeof payload.driverDetails.Success === "string"
    && Array.isArray(payload.driverDetails.IDS)
  ) {
    return payload.driverDetails;
  }

  return null;
}

function getDownloadInfos(payload) {
  const driverDetailsPayload = getDriverDetailsPayload(payload);
  if (!driverDetailsPayload) {
    return [];
  }

  const ids = driverDetailsPayload.IDS;

  return ids
    .map((entry) => (entry && typeof entry === "object" ? entry.downloadInfo : null))
    .filter((entry) => entry && typeof entry === "object");
}

function shouldUseAemDriverFallback(payload) {
  const driverDetailsPayload = getDriverDetailsPayload(payload);
  if (!driverDetailsPayload || driverDetailsPayload.Success !== "0" || !Array.isArray(driverDetailsPayload.IDS)) {
    return false;
  }

  return driverDetailsPayload.IDS.some((entry) => (
    entry
    && typeof entry === "object"
    && typeof entry.GlobalTryCatchBlock === "string"
    && entry.GlobalTryCatchBlock.trim() !== ""
  ));
}

function getMessageCodes(downloadInfo) {
  if (!downloadInfo || !Array.isArray(downloadInfo.Messaging)) {
    return [];
  }

  return downloadInfo.Messaging
    .map((message) => (message && typeof message.MessageCode === "string" ? message.MessageCode : ""))
    .filter(Boolean);
}

function getSuccessfulDownloadInfo(payload) {
  return getDownloadInfos(payload).find((downloadInfo) => {
    const id = normalizeId(downloadInfo.ID);
    return downloadInfo.Success === "1" && id !== null;
  }) || null;
}

function classifyPayload(payload) {
  const successfulDownloadInfo = getSuccessfulDownloadInfo(payload);
  if (successfulDownloadInfo) {
    return {
      kind: "found",
      downloadInfo: successfulDownloadInfo,
    };
  }

  const downloadInfos = getDownloadInfos(payload);
  const notFoundInfo = downloadInfos.find((downloadInfo) => {
    const messageCodes = getMessageCodes(downloadInfo);
    return messageCodes.includes("DownloadIDNotFound") || messageCodes.includes("DriverDownloadIDNotFound");
  });
  if (notFoundInfo) {
    return {
      kind: "not_found",
      reason: "semantic DownloadIDNotFound response",
    };
  }

  return {
    kind: "unexpected",
    reason: "body did not match a known success or semantic not-found shape",
  };
}

function unique(values) {
  return [...new Set(values)];
}

function expectStringField(downloadInfo, key, { required = false } = {}) {
  const value = downloadInfo[key];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`core shape mismatch: missing required field ${key}`);
    }

    return "";
  }

  if (typeof value !== "string") {
    throw new Error(`core shape mismatch: field ${key} must be a string`);
  }

  return value;
}

function validateSeriesShape(series) {
  if (series === undefined) {
    return [];
  }

  if (!Array.isArray(series)) {
    throw new Error("core shape mismatch: field series must be an array when present");
  }

  return series.map((entry, seriesIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`core shape mismatch: series[${seriesIndex}] must be an object`);
    }

    const seriesname = entry.seriesname;
    if (seriesname !== undefined && typeof seriesname !== "string") {
      throw new Error(`core shape mismatch: series[${seriesIndex}].seriesname must be a string`);
    }

    const products = entry.products === undefined ? [] : entry.products;
    if (!Array.isArray(products)) {
      throw new Error(`core shape mismatch: series[${seriesIndex}].products must be an array`);
    }

    const normalizedProducts = products.map((product, productIndex) => {
      if (!product || typeof product !== "object" || Array.isArray(product)) {
        throw new Error(`core shape mismatch: series[${seriesIndex}].products[${productIndex}] must be an object`);
      }

      const productName = product.productName;
      if (productName !== undefined && typeof productName !== "string") {
        throw new Error(`core shape mismatch: series[${seriesIndex}].products[${productIndex}].productName must be a string`);
      }

      return {
        productName: safeDecode(productName || ""),
      };
    });

    return {
      seriesname: safeDecode(seriesname || ""),
      products: normalizedProducts,
    };
  });
}

function extractFoundDriver(payload) {
  const downloadInfo = getSuccessfulDownloadInfo(payload);
  if (!downloadInfo) {
    throw new Error("Cannot extract a driver record from a non-success payload");
  }

  const id = expectStringField(downloadInfo, "ID", { required: true });
  expectStringField(downloadInfo, "Success", { required: true });
  Object.keys(REQUIRED_SUMMARY_FIELDS).forEach((key) => {
    expectStringField(downloadInfo, key);
  });

  const normalizedId = normalizeId(id);
  if (!normalizedId) {
    throw new Error("core shape mismatch: field ID must be numeric");
  }

  const normalizedSeries = validateSeriesShape(downloadInfo.series);
  const seriesNames = unique(normalizedSeries.map((entry) => entry.seriesname).filter(Boolean));
  const productNames = unique(
    normalizedSeries.flatMap((entry) => entry.products.map((product) => product.productName).filter(Boolean))
  );

  const extraFields = {};
  Object.entries(downloadInfo).forEach(([key, value]) => {
    if (!KNOWN_DOWNLOAD_INFO_KEYS.has(key)) {
      extraFields[key] = value;
    }
  });

  return {
    summaryRecord: {
      id: normalizedId,
      release: downloadInfo.Release || "",
      version: downloadInfo.Version || "",
      displayVersion: downloadInfo.DisplayVersion || "",
      gfeDisplayVersion: downloadInfo.GFE_DisplayVersion || "",
      releaseDateTime: downloadInfo.ReleaseDateTime || "",
      osName: safeDecode(downloadInfo.OSName || ""),
      osCode: downloadInfo.OsCode || "",
      languageName: safeDecode(downloadInfo.LanguageName || ""),
      is64Bit: downloadInfo.Is64Bit || "",
      isWHQL: downloadInfo.IsWHQL || "",
      isRecommended: downloadInfo.IsRecommended || "",
      isDC: downloadInfo.IsDC || "",
      isCRD: downloadInfo.IsCRD || "",
      isBeta: downloadInfo.IsBeta || "",
      isFeaturePreview: downloadInfo.IsFeaturePreview || "",
      downloadFileSize: downloadInfo.DownloadURLFileSize || "",
      releaseNotes: safeDecode(downloadInfo.ReleaseNotes || ""),
      otherNotes: safeDecode(downloadInfo.OtherNotes || ""),
      name: safeDecode(downloadInfo.Name || ""),
      detailsUrl: downloadInfo.DetailsURL || "",
      downloadUrl: downloadInfo.DownloadURL || "",
      seriesNames,
      productNames,
    },
    extraFields,
  };
}

function buildSummaryRecord(payload) {
  return extractFoundDriver(payload).summaryRecord;
}

function buildRequestUrl(id) {
  const normalizedId = normalizeId(id);
  if (!normalizedId) {
    throw new Error("Driver ID must be numeric");
  }

  return `${NVIDIA_DRIVER_DETAILS_URL_PREFIX}${normalizedId}`;
}

function buildFallbackRequestUrl(id) {
  const normalizedId = normalizeId(id);
  if (!normalizedId) {
    throw new Error("Driver ID must be numeric");
  }

  return `${NVIDIA_AEM_DRIVER_DETAILS_URL_PREFIX}${encodeURI(JSON.stringify({ ddID: normalizedId }))}`;
}

function configureDatabase(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

function finalizeStandaloneDatabase(db, databaseFilePath) {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (error) {
    // Ignore checkpoint failures during shutdown and still attempt to close.
  }

  db.close();

  if (!databaseFilePath) {
    return;
  }

  for (const companionPath of [`${databaseFilePath}-wal`, `${databaseFilePath}-shm`]) {
    try {
      fsSync.rmSync(companionPath, { force: true });
    } catch (error) {
      // Ignore cleanup failures; the database itself has already been closed.
    }
  }
}

function parseBooleanInteger(value) {
  return String(value) === "1" ? 1 : 0;
}

function parseReleaseDateUnix(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const normalized = value.trim();
  const match = normalized.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) {
    const parsed = Date.parse(normalized);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return Math.floor(parsed / 1000);
  }

  const monthIndex = RELEASE_DATE_MONTHS.get(match[1].toLowerCase());
  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  if (monthIndex === undefined || !Number.isInteger(day) || !Number.isInteger(year)) {
    return null;
  }

  return Math.floor(Date.UTC(year, monthIndex, day) / 1000);
}

function parseFileSizeBytes(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^([\d.]+)\s*(bytes|kb|mb|gb|tb)$/i);
  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const unit = match[2].toLowerCase();
  const multipliers = {
    bytes: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
  };

  return Math.round(amount * multipliers[unit]);
}

function normalizeBrowserUrlHost(value) {
  return String(value || "").trim().toLowerCase();
}

function buildLiteralBrowserUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return {
      host: null,
      localeSegment: null,
      path: null,
      templateKind: null,
      value: BROWSER_URL_VALUE_MISSING,
    };
  }

  return {
    host: null,
    localeSegment: null,
    path: null,
    templateKind: null,
    value,
  };
}

function classifyBrowserDetailsUrl(value, driverId) {
  if (typeof value !== "string" || value.trim() === "") {
    return buildLiteralBrowserUrl("");
  }

  const normalizedId = normalizeId(driverId);
  try {
    const parsed = new URL(value);
    if (parsed.search || parsed.hash) {
      return buildLiteralBrowserUrl(value);
    }

    const modernMatch = parsed.pathname.match(/^\/([^/]+)\/drivers\/details\/(\d+)\/?$/i);
    if (
      modernMatch
      && normalizeBrowserUrlHost(parsed.hostname) === "www.nvidia.com"
      && normalizeId(modernMatch[2]) === normalizedId
    ) {
      return {
        host: null,
        localeSegment: modernMatch[1].toLowerCase(),
        path: null,
        templateKind: BROWSER_DETAIL_URL_TEMPLATE_KINDS.MODERN_NVIDIA_DETAILS,
        value: null,
      };
    }

    const legacyMatch = parsed.pathname.match(/^\/Download\/driverResults\.aspx\/(\d+)\/([^/]+)\/?$/i);
    if (legacyMatch && normalizeId(legacyMatch[1]) === normalizedId) {
      return {
        host: normalizeBrowserUrlHost(parsed.hostname),
        localeSegment: legacyMatch[2].toLowerCase(),
        path: null,
        templateKind: BROWSER_DETAIL_URL_TEMPLATE_KINDS.LEGACY_DRIVER_RESULTS,
        value: null,
      };
    }
  } catch {
    return buildLiteralBrowserUrl(value);
  }

  return buildLiteralBrowserUrl(value);
}

function classifyBrowserDownloadUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return buildLiteralBrowserUrl("");
  }

  try {
    const parsed = new URL(value);
    const host = normalizeBrowserUrlHost(parsed.hostname);
    if (host.endsWith("download.nvidia.com") && parsed.pathname) {
      return {
        host,
        localeSegment: null,
        path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
        templateKind: BROWSER_DOWNLOAD_URL_TEMPLATE_KINDS.DOWNLOAD_HOST_PATH,
        value: null,
      };
    }
  } catch {
    return buildLiteralBrowserUrl(value);
  }

  return buildLiteralBrowserUrl(value);
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function hashBrowserNoteValue(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function initializeBrowserSchema(db) {
  db.exec(`
    CREATE TABLE lookup_sources (
      type_id INTEGER PRIMARY KEY,
      lookup_name TEXT NOT NULL,
      url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      entry_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT NOT NULL,
      last_changed_at TEXT NOT NULL
    );

    CREATE TABLE lookup_values (
      lookup_id INTEGER PRIMARY KEY,
      type_id INTEGER NOT NULL,
      value TEXT NOT NULL,
      lookup_name TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      requires_product TEXT NOT NULL DEFAULT '',
      is_select_less TEXT NOT NULL DEFAULT '',
      ordinal INTEGER NOT NULL,
      parent_lookup_id INTEGER,
      UNIQUE (type_id, value),
      FOREIGN KEY (parent_lookup_id) REFERENCES lookup_values(lookup_id)
    );

    CREATE TABLE text_values (
      text_id INTEGER PRIMARY KEY,
      text_type INTEGER NOT NULL,
      value TEXT NOT NULL,
      UNIQUE (text_type, value)
    );

    CREATE TABLE note_values (
      note_id INTEGER PRIMARY KEY,
      note_type INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      encoding TEXT NOT NULL,
      raw_size INTEGER NOT NULL,
      value_gzip BLOB NOT NULL,
      UNIQUE (note_type, content_hash)
    );

    CREATE TABLE url_hosts (
      host_id INTEGER PRIMARY KEY,
      host TEXT NOT NULL UNIQUE
    );

    CREATE TABLE download_url_paths (
      path_id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE
    );

    CREATE TABLE drivers (
      id INTEGER PRIMARY KEY,
      release_text_id INTEGER,
      version_text_id INTEGER,
      display_version_text_id INTEGER,
      name_text_id INTEGER,
      release_date_unix INTEGER,
      os_lookup_id INTEGER,
      os_name TEXT NOT NULL DEFAULT '',
      os_code TEXT NOT NULL DEFAULT '',
      language_lookup_id INTEGER,
      language_name TEXT NOT NULL DEFAULT '',
      product_type_lookup_ids_text TEXT NOT NULL DEFAULT '',
      series_lookup_ids_text TEXT NOT NULL DEFAULT '',
      product_lookup_ids_text TEXT NOT NULL DEFAULT '',
      is_64_bit INTEGER NOT NULL DEFAULT 0,
      is_whql INTEGER NOT NULL DEFAULT 0,
      is_recommended INTEGER NOT NULL DEFAULT 0,
      is_dc INTEGER NOT NULL DEFAULT 0,
      is_crd INTEGER NOT NULL DEFAULT 0,
      is_beta INTEGER NOT NULL DEFAULT 0,
      is_feature_preview INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (release_text_id) REFERENCES text_values(text_id),
      FOREIGN KEY (version_text_id) REFERENCES text_values(text_id),
      FOREIGN KEY (display_version_text_id) REFERENCES text_values(text_id),
      FOREIGN KEY (name_text_id) REFERENCES text_values(text_id),
      FOREIGN KEY (os_lookup_id) REFERENCES lookup_values(lookup_id),
      FOREIGN KEY (language_lookup_id) REFERENCES lookup_values(lookup_id)
    );

    CREATE TABLE driver_detail (
      driver_id INTEGER PRIMARY KEY,
      gfe_display_version_text_id INTEGER,
      download_file_size_bytes INTEGER,
      details_url_value TEXT,
      details_url_template_kind INTEGER,
      details_url_host_id INTEGER,
      details_url_locale_segment TEXT,
      download_url_value TEXT,
      download_url_template_kind INTEGER,
      download_url_host_id INTEGER,
      download_url_path_id INTEGER,
      release_notes_note_id INTEGER,
      other_notes_note_id INTEGER,
      extra_fields_json TEXT,
      FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
      FOREIGN KEY (gfe_display_version_text_id) REFERENCES text_values(text_id),
      FOREIGN KEY (release_notes_note_id) REFERENCES note_values(note_id),
      FOREIGN KEY (other_notes_note_id) REFERENCES note_values(note_id),
      FOREIGN KEY (details_url_host_id) REFERENCES url_hosts(host_id),
      FOREIGN KEY (download_url_host_id) REFERENCES url_hosts(host_id),
      FOREIGN KEY (download_url_path_id) REFERENCES download_url_paths(path_id)
    );

    CREATE TABLE browser_stats (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      found_count INTEGER NOT NULL DEFAULT 0,
      confirmed_not_found_count INTEGER NOT NULL DEFAULT 0,
      pending_frontier_count INTEGER NOT NULL DEFAULT 0,
      highest_found_id INTEGER,
      highest_found_version TEXT NOT NULL DEFAULT '',
      highest_found_display_version TEXT NOT NULL DEFAULT '',
      highest_found_name TEXT NOT NULL DEFAULT '',
      largest_gap_start_id INTEGER,
      largest_gap_end_id INTEGER,
      largest_gap_length INTEGER,
      built_at TEXT NOT NULL
    );

    CREATE INDEX idx_browser_lookup_values_parent ON lookup_values(parent_lookup_id);
    CREATE INDEX idx_browser_lookup_values_type_ordinal ON lookup_values(type_id, ordinal);
    CREATE INDEX idx_browser_lookup_values_type_name ON lookup_values(type_id, name);
    CREATE INDEX idx_browser_lookup_values_type_name_code_ordinal ON lookup_values(type_id, name, code, ordinal);
    CREATE INDEX idx_browser_text_values_type_value_nocase ON text_values(text_type, value COLLATE NOCASE);
    CREATE INDEX idx_browser_drivers_release_text_id ON drivers(release_text_id);
    CREATE INDEX idx_browser_drivers_version_text_id ON drivers(version_text_id);
    CREATE INDEX idx_browser_drivers_display_version_text_id ON drivers(display_version_text_id);
    CREATE INDEX idx_browser_drivers_name_text_id ON drivers(name_text_id);
    CREATE INDEX idx_browser_drivers_release_date_unix ON drivers(release_date_unix);
    CREATE INDEX idx_browser_drivers_os_lookup_id ON drivers(os_lookup_id);
    CREATE INDEX idx_browser_drivers_language_lookup_id ON drivers(language_lookup_id);
    CREATE INDEX idx_browser_drivers_bool_flags ON drivers(
      is_64_bit,
      is_whql,
      is_recommended,
      is_dc,
      is_crd,
      is_beta,
      is_feature_preview
    );
  `);
}

function createBrowserDetailLookupContext(db) {
  const gfeDisplayVersionTextIdByValue = new Map(
    db.prepare(`
      SELECT text_id, value
      FROM text_values
      WHERE text_type = ?
    `).all(BROWSER_TEXT_TYPES.GFE_DISPLAY_VERSION).map((row) => [row.value, Number(row.text_id)])
  );
  const releaseNotesNoteIdByValue = new Map(
    db.prepare(`
      SELECT note_id, content_hash
      FROM note_values
      WHERE note_type = ?
    `).all(BROWSER_NOTE_TYPES.RELEASE_NOTES).map((row) => [row.content_hash, Number(row.note_id)])
  );
  const otherNotesNoteIdByValue = new Map(
    db.prepare(`
      SELECT note_id, content_hash
      FROM note_values
      WHERE note_type = ?
    `).all(BROWSER_NOTE_TYPES.OTHER_NOTES).map((row) => [row.content_hash, Number(row.note_id)])
  );

  return {
    gfeDisplayVersionTextIdByValue,
    otherNotesNoteIdByValue,
    releaseNotesNoteIdByValue,
  };
}

function createBrowserUrlHostRegistry(db) {
  const hostIdByHost = new Map(
    db.prepare(`
      SELECT host_id, host
      FROM url_hosts
    `).all().map((row) => [row.host, Number(row.host_id)])
  );
  const insertHost = db.prepare(`
    INSERT OR IGNORE INTO url_hosts (host)
    VALUES (?)
  `);
  const selectHostId = db.prepare(`
    SELECT host_id
    FROM url_hosts
    WHERE host = ?
    LIMIT 1
  `);

  return {
    ensureHostId(host) {
      const normalizedHost = normalizeBrowserUrlHost(host);
      if (!normalizedHost) {
        return null;
      }

      const cachedHostId = hostIdByHost.get(normalizedHost);
      if (cachedHostId) {
        return cachedHostId;
      }

      insertHost.run(normalizedHost);
      const row = selectHostId.get(normalizedHost);
      const hostId = row ? Number(row.host_id) : null;
      if (!hostId) {
        throw new Error(`Browser DB build failed: could not persist URL host ${normalizedHost}`);
      }

      hostIdByHost.set(normalizedHost, hostId);
      return hostId;
    },
  };
}

function createBrowserDownloadPathRegistry(db) {
  const pathIdByPath = new Map(
    db.prepare(`
      SELECT path_id, path
      FROM download_url_paths
    `).all().map((row) => [row.path, Number(row.path_id)])
  );
  const insertPath = db.prepare(`
    INSERT OR IGNORE INTO download_url_paths (path)
    VALUES (?)
  `);
  const selectPathId = db.prepare(`
    SELECT path_id
    FROM download_url_paths
    WHERE path = ?
    LIMIT 1
  `);

  return {
    ensurePathId(pathValue) {
      const normalizedPathValue = typeof pathValue === "string" ? pathValue : "";
      if (!normalizedPathValue) {
        return null;
      }

      const cachedPathId = pathIdByPath.get(normalizedPathValue);
      if (cachedPathId) {
        return cachedPathId;
      }

      insertPath.run(normalizedPathValue);
      const row = selectPathId.get(normalizedPathValue);
      const pathId = row ? Number(row.path_id) : null;
      if (!pathId) {
        throw new Error(`Browser DB build failed: could not persist download path ${normalizedPathValue}`);
      }

      pathIdByPath.set(normalizedPathValue, pathId);
      return pathId;
    },
  };
}

function populateBrowserDriverDetailsInBatches(db, logStep, options = {}) {
  const driverBatchSize = Math.max(1, Number(options.driverBatchSize) || 2000);
  const foundDriverIds = db.prepare(`
    SELECT id
    FROM drivers
    ORDER BY id ASC
  `).pluck().all();

  if (foundDriverIds.length === 0) {
    logStep("copying browser detail rows: no found drivers");
    return;
  }

  const {
    gfeDisplayVersionTextIdByValue,
    otherNotesNoteIdByValue,
    releaseNotesNoteIdByValue,
  } = createBrowserDetailLookupContext(db);
  const hostRegistry = createBrowserUrlHostRegistry(db);
  const downloadPathRegistry = createBrowserDownloadPathRegistry(db);
  const selectDetailRows = db.prepare(`
    SELECT
      id,
      gfe_display_version,
      download_file_size,
      details_url,
      download_url,
      release_notes,
      other_notes,
      extra_fields_json
    FROM master.drivers
    WHERE status = 'found'
      AND id BETWEEN ? AND ?
    ORDER BY id ASC
  `);
  const insertDetail = db.prepare(`
    INSERT INTO driver_detail (
      driver_id,
      gfe_display_version_text_id,
      download_file_size_bytes,
      details_url_value,
      details_url_template_kind,
      details_url_host_id,
      details_url_locale_segment,
      download_url_value,
      download_url_template_kind,
      download_url_host_id,
      download_url_path_id,
      release_notes_note_id,
      other_notes_note_id,
      extra_fields_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let processedDrivers = 0;
  for (let index = 0; index < foundDriverIds.length; index += driverBatchSize) {
    const batchStartId = Number(foundDriverIds[index]);
    const batchEndId = Number(foundDriverIds[Math.min(index + driverBatchSize - 1, foundDriverIds.length - 1)]);

    for (const row of selectDetailRows.all(batchStartId, batchEndId)) {
      const detailsUrl = classifyBrowserDetailsUrl(row.details_url, row.id);
      const downloadUrl = classifyBrowserDownloadUrl(row.download_url);

      insertDetail.run(
        Number(row.id),
        row.gfe_display_version ? (gfeDisplayVersionTextIdByValue.get(row.gfe_display_version) || null) : null,
        parseFileSizeBytes(row.download_file_size),
        detailsUrl.value,
        detailsUrl.templateKind,
        detailsUrl.host ? hostRegistry.ensureHostId(detailsUrl.host) : null,
        detailsUrl.localeSegment,
        downloadUrl.value,
        downloadUrl.templateKind,
        downloadUrl.host ? hostRegistry.ensureHostId(downloadUrl.host) : null,
        downloadUrl.path ? downloadPathRegistry.ensurePathId(downloadUrl.path) : null,
        row.release_notes ? (releaseNotesNoteIdByValue.get(hashBrowserNoteValue(row.release_notes)) || null) : null,
        row.other_notes ? (otherNotesNoteIdByValue.get(hashBrowserNoteValue(row.other_notes)) || null) : null,
        row.extra_fields_json === "{}" || row.extra_fields_json === "" ? null : row.extra_fields_json
      );
    }

    processedDrivers = Math.min(foundDriverIds.length, index + driverBatchSize);
    logStep(
      `copying browser detail rows: ${processedDrivers}/${foundDriverIds.length} ` +
      `(${formatProgressPercent(processedDrivers, foundDriverIds.length)})`
    );
  }
}

function insertBrowserLookupValues(db) {
  const lookupRows = db.prepare(`
    SELECT
      type_id,
      value,
      lookup_name,
      name,
      parent_type_id,
      parent_value,
      code,
      requires_product,
      is_select_less,
      ordinal
    FROM master.lookup_values
    WHERE type_id IN (1, 2, 3, 4, 5)
    ORDER BY type_id ASC, ordinal ASC
  `).all();

  const insertLookup = db.prepare(`
    INSERT INTO lookup_values (
      type_id,
      value,
      lookup_name,
      name,
      code,
      requires_product,
      is_select_less,
      ordinal,
      parent_lookup_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const lookupIdByKey = new Map();

  db.transaction(() => {
    for (const row of lookupRows) {
      let parentLookupId = null;

      if (row.parent_type_id !== null && row.parent_value !== "") {
        const parentKey = `${row.parent_type_id}:${row.parent_value}`;
        parentLookupId = lookupIdByKey.get(parentKey) || null;
      }

      const info = insertLookup.run(
        row.type_id,
        row.value,
        row.lookup_name,
        row.name,
        row.code,
        row.requires_product,
        row.is_select_less,
        row.ordinal,
        parentLookupId
      );
      lookupIdByKey.set(`${row.type_id}:${row.value}`, Number(info.lastInsertRowid));
    }
  })();
}

function insertBrowserTextValues(db) {
  const definitions = [
    { textType: BROWSER_TEXT_TYPES.RELEASE, column: "release" },
    { textType: BROWSER_TEXT_TYPES.VERSION, column: "version" },
    { textType: BROWSER_TEXT_TYPES.DISPLAY_VERSION, column: "display_version" },
    { textType: BROWSER_TEXT_TYPES.DRIVER_NAME, column: "name" },
    { textType: BROWSER_TEXT_TYPES.GFE_DISPLAY_VERSION, column: "gfe_display_version" },
  ];

  for (const { textType, column } of definitions) {
    db.exec(`
      INSERT OR IGNORE INTO text_values (text_type, value)
      SELECT DISTINCT ${textType}, ${column}
      FROM master.drivers
      WHERE status = 'found'
        AND ${column} <> ''
      ORDER BY ${column} ASC
    `);
  }
}

function insertBrowserNoteValues(db) {
  const definitions = [
    { noteType: BROWSER_NOTE_TYPES.RELEASE_NOTES, column: "release_notes" },
    { noteType: BROWSER_NOTE_TYPES.OTHER_NOTES, column: "other_notes" },
  ];

  const insertNote = db.prepare(`
    INSERT OR IGNORE INTO note_values (
      note_type,
      content_hash,
      encoding,
      raw_size,
      value_gzip
    ) VALUES (?, ?, 'gzip', ?, ?)
  `);

  db.transaction(() => {
    for (const { noteType, column } of definitions) {
      const rows = db.prepare(`
        SELECT DISTINCT ${column} AS value
        FROM master.drivers
        WHERE status = 'found'
          AND ${column} <> ''
        ORDER BY ${column} ASC
      `).all();

      for (const row of rows) {
        const noteValue = String(row.value || "");
        if (!noteValue) {
          continue;
        }

        const gzippedValue = gzipSync(Buffer.from(noteValue, "utf8"), { level: 9 });
        insertNote.run(
          noteType,
          hashBrowserNoteValue(noteValue),
          Buffer.byteLength(noteValue, "utf8"),
          gzippedValue
        );
      }
    }
  })();
}

function assertBrowserLookupMappings(db) {
  const unmappedSeriesRows = db.prepare(`
    WITH distinct_series AS (
      SELECT DISTINCT ds.series_name AS name
      FROM master.driver_series ds
      JOIN master.drivers d
        ON d.id = ds.driver_id
      WHERE d.status = 'found'
    )
    SELECT distinct_series.name
    FROM distinct_series
    LEFT JOIN lookup_values lv
      ON lv.type_id = 2
      AND lv.name = distinct_series.name
    WHERE lv.lookup_id IS NULL
    ORDER BY distinct_series.name ASC
    LIMIT 10
  `).all();
  if (unmappedSeriesRows.length > 0) {
    throw new Error(
      `Browser DB build failed: unmapped series names ${unmappedSeriesRows.map((row) => row.name).join(", ")}`
    );
  }

  const productLookupNames = new Set(
    db.prepare(`
      SELECT name
      FROM lookup_values
      WHERE type_id = 3
    `).pluck().all()
  );
  const unmappedProductNames = db.prepare(`
    SELECT DISTINCT dp.product_name AS name
    FROM master.driver_products dp
    JOIN master.drivers d
      ON d.id = dp.driver_id
    WHERE d.status = 'found'
    ORDER BY dp.product_name ASC
  `).pluck().all().filter((name) => !productLookupNames.has(getCanonicalBrowserProductName(name))).slice(0, 10);
  if (unmappedProductNames.length > 0) {
    throw new Error(
      `Browser DB build failed: unmapped product names ${unmappedProductNames.join(", ")}`
    );
  }

}

function formatProgressPercent(completed, total) {
  if (!total) {
    return "100.0%";
  }

  return `${((completed / total) * 100).toFixed(1)}%`;
}

function sortCaseInsensitiveValues(values) {
  return [...values].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function getCanonicalBrowserProductName(productName) {
  return BROWSER_PRODUCT_NAME_ALIASES[productName] || productName;
}

function resolveBrowserProductLookup(productName, productLookupByName) {
  return productLookupByName.get(productName)
    || productLookupByName.get(getCanonicalBrowserProductName(productName))
    || null;
}

function formatLookupMembershipText(lookupIds) {
  if (lookupIds.size === 0) {
    return "";
  }

  return `|${[...lookupIds].sort((left, right) => left - right).join("|")}|`;
}

function createDriverAttributePayloadContext(db) {
  const lookupRows = db.prepare(`
    SELECT lookup_id, type_id, name, parent_lookup_id
    FROM lookup_values
    WHERE type_id IN (2, 3)
    ORDER BY type_id ASC, ordinal ASC
  `).all();
  const productLookupByName = new Map();
  const seriesLookupByName = new Map();
  const seriesLookupById = new Map();

  for (const row of lookupRows) {
    const entry = {
      lookupId: Number(row.lookup_id),
      name: row.name,
      parentLookupId:
        row.parent_lookup_id === null || row.parent_lookup_id === undefined
          ? null
          : Number(row.parent_lookup_id),
    };

    if (Number(row.type_id) === 2) {
      seriesLookupByName.set(row.name, entry);
      seriesLookupById.set(entry.lookupId, entry);
    } else if (Number(row.type_id) === 3) {
      productLookupByName.set(row.name, entry);
    }
  }

  return {
    productLookupByName,
    seriesLookupById,
    seriesLookupByName,
  };
}

function createEmptyDriverAttributeAggregate() {
  return {
    productLookupIds: new Set(),
    productTypeLookupIds: new Set(),
    seriesLookupIds: new Set(),
  };
}

function populateBrowserDriverAttributePayloadsInBatches(db, logStep, options = {}) {
  const driverBatchSize = Math.max(1, Number(options.driverBatchSize) || 2000);
  const foundDriverIds = db.prepare(`
    SELECT id
    FROM drivers
    ORDER BY id ASC
  `).pluck().all();

  if (foundDriverIds.length === 0) {
    logStep("aggregating driver attribute payloads: no found drivers");
    return;
  }

  const {
    productLookupByName,
    seriesLookupById,
    seriesLookupByName,
  } = createDriverAttributePayloadContext(db);
  const selectSeriesRows = db.prepare(`
    SELECT driver_id, series_name
    FROM master.driver_series
    WHERE driver_id BETWEEN ? AND ?
    ORDER BY driver_id ASC, series_name ASC
  `);
  const selectProductRows = db.prepare(`
    SELECT driver_id, product_name
    FROM master.driver_products
    WHERE driver_id BETWEEN ? AND ?
    ORDER BY driver_id ASC, product_name ASC
  `);
  const updateDriver = db.prepare(`
    UPDATE drivers
    SET
      product_type_lookup_ids_text = ?,
      series_lookup_ids_text = ?,
      product_lookup_ids_text = ?
    WHERE id = ?
  `);
  const applyBatch = db.transaction((aggregates) => {
    for (const [driverId, aggregate] of aggregates) {
      updateDriver.run(
        formatLookupMembershipText(aggregate.productTypeLookupIds),
        formatLookupMembershipText(aggregate.seriesLookupIds),
        formatLookupMembershipText(aggregate.productLookupIds),
        driverId
      );
    }
  });

  let processedDrivers = 0;
  for (let index = 0; index < foundDriverIds.length; index += driverBatchSize) {
    const batchStartId = Number(foundDriverIds[index]);
    const batchEndId = Number(foundDriverIds[Math.min(index + driverBatchSize - 1, foundDriverIds.length - 1)]);
    const aggregateByDriverId = new Map();
    const ensureAggregate = (driverId) => {
      if (!aggregateByDriverId.has(driverId)) {
        aggregateByDriverId.set(driverId, createEmptyDriverAttributeAggregate());
      }

      return aggregateByDriverId.get(driverId);
    };

    for (const row of selectProductRows.all(batchStartId, batchEndId)) {
      const driverId = Number(row.driver_id);
      const productLookup = resolveBrowserProductLookup(row.product_name, productLookupByName);
      if (!productLookup) {
        throw new Error(`Browser DB build failed: unmapped product name ${row.product_name}`);
      }

      const aggregate = ensureAggregate(driverId);
      aggregate.productLookupIds.add(productLookup.lookupId);

      if (productLookup.parentLookupId !== null) {
        const seriesLookup = seriesLookupById.get(productLookup.parentLookupId) || null;
        if (seriesLookup) {
          aggregate.seriesLookupIds.add(seriesLookup.lookupId);
          if (seriesLookup.parentLookupId !== null) {
            aggregate.productTypeLookupIds.add(seriesLookup.parentLookupId);
          }
          continue;
        }
      }

      throw new Error(`Browser DB build failed: unmapped series lookup for product ${row.product_name}`);
    }

    for (const row of selectSeriesRows.all(batchStartId, batchEndId)) {
      const driverId = Number(row.driver_id);
      const seriesLookup = seriesLookupByName.get(row.series_name);
      if (!seriesLookup) {
        throw new Error(`Browser DB build failed: unmapped series name ${row.series_name}`);
      }

      const aggregate = ensureAggregate(driverId);
      aggregate.seriesLookupIds.add(seriesLookup.lookupId);
      if (seriesLookup.parentLookupId !== null) {
        aggregate.productTypeLookupIds.add(seriesLookup.parentLookupId);
      }
    }

    applyBatch(aggregateByDriverId);
    processedDrivers = Math.min(foundDriverIds.length, index + driverBatchSize);
    logStep(
      `aggregating driver attribute payloads: ${processedDrivers}/${foundDriverIds.length} ` +
      `(${formatProgressPercent(processedDrivers, foundDriverIds.length)})`
    );
  }
}

async function buildBrowserDatabase(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const dataDirName = options.dataDirName || DEFAULT_DATA_DIR_NAME;
  const stdout = options.stdout || process.stdout;
  const paths = getPaths(rootDir, dataDirName);
  const logStep = (message) => {
    stdout.write(`${message}\n`);
  };

  await fs.mkdir(paths.dataDir, { recursive: true });
  const masterExists = await fs.stat(paths.databaseFile).then(() => true, () => false);
  if (!masterExists) {
    throw new Error(`Master database not found at ${paths.databaseFile}`);
  }

  logStep(`building browser database from ${paths.databaseFile}`);
  const tempPath = paths.browserTempDatabaseFile;
  await fs.rm(tempPath, { force: true }).catch(() => {});
  await fs.rm(`${tempPath}-journal`, { force: true }).catch(() => {});
  await fs.rm(`${tempPath}-wal`, { force: true }).catch(() => {});
  await fs.rm(`${tempPath}-shm`, { force: true }).catch(() => {});
  let targetDb = null;

  try {
    logStep(`using scratch database ${tempPath}`);
    logStep(`keeping ${paths.browserDatabaseFile} untouched until the final rename`);
    targetDb = new Database(tempPath);
    targetDb.pragma("page_size = 16384");
    targetDb.pragma("journal_mode = DELETE");
    targetDb.pragma("foreign_keys = ON");
    targetDb.pragma("temp_store = MEMORY");
    targetDb.pragma("auto_vacuum = NONE");
    targetDb.pragma("busy_timeout = 5000");
    targetDb.function("to_bool", { deterministic: true }, parseBooleanInteger);
    targetDb.function("to_release_date_unix", { deterministic: true }, parseReleaseDateUnix);
    targetDb.function("to_file_size_bytes", { deterministic: true }, parseFileSizeBytes);

    initializeBrowserSchema(targetDb);
    targetDb.exec(`ATTACH DATABASE ${quoteSqlString(paths.databaseFile)} AS master`);

    let statsRow;
    targetDb.transaction(() => {
      logStep("copying lookup sources");
      targetDb.exec(`
        INSERT INTO lookup_sources (
          type_id,
          lookup_name,
          url,
          content_hash,
          entry_count,
          last_checked_at,
          last_changed_at
        )
        SELECT
          type_id,
          lookup_name,
          url,
          content_hash,
          entry_count,
          last_checked_at,
          last_changed_at
        FROM master.lookup_sources
        WHERE type_id IN (1, 2, 3, 4, 5)
        ORDER BY type_id ASC
      `);

      logStep("copying lookup values");
      insertBrowserLookupValues(targetDb);

      logStep("building text dictionaries");
      insertBrowserTextValues(targetDb);

      logStep("building note dictionaries");
      insertBrowserNoteValues(targetDb);

      logStep("validating lookup mappings");
      assertBrowserLookupMappings(targetDb);

      logStep("copying found driver rows");
      targetDb.exec(`
        INSERT INTO drivers (
          id,
          release_text_id,
          version_text_id,
          display_version_text_id,
          name_text_id,
      release_date_unix,
      os_lookup_id,
      os_name,
      os_code,
      language_lookup_id,
      language_name,
      is_64_bit,
      is_whql,
      is_recommended,
          is_dc,
          is_crd,
          is_beta,
          is_feature_preview
        )
        SELECT
          d.id,
          release_tv.text_id,
          version_tv.text_id,
          display_tv.text_id,
          name_tv.text_id,
          to_release_date_unix(d.release_date_time),
          (
            SELECT lv.lookup_id
            FROM lookup_values lv
            WHERE lv.type_id = 4
              AND lv.name = d.os_name
              AND (lv.code = d.os_code OR lv.code = '')
            ORDER BY CASE WHEN lv.code = d.os_code THEN 0 ELSE 1 END, lv.ordinal
            LIMIT 1
          ),
          d.os_name,
          d.os_code,
          (
            SELECT lv.lookup_id
            FROM lookup_values lv
            WHERE lv.type_id = 5
              AND lv.name = d.language_name
            ORDER BY lv.ordinal
            LIMIT 1
          ),
          d.language_name,
          to_bool(d.is_64_bit),
          to_bool(d.is_whql),
          to_bool(d.is_recommended),
          to_bool(d.is_dc),
          to_bool(d.is_crd),
          to_bool(d.is_beta),
          to_bool(d.is_feature_preview)
        FROM master.drivers d
        LEFT JOIN text_values release_tv
          ON release_tv.text_type = ${BROWSER_TEXT_TYPES.RELEASE}
          AND release_tv.value = d.release
        LEFT JOIN text_values version_tv
          ON version_tv.text_type = ${BROWSER_TEXT_TYPES.VERSION}
          AND version_tv.value = d.version
        LEFT JOIN text_values display_tv
          ON display_tv.text_type = ${BROWSER_TEXT_TYPES.DISPLAY_VERSION}
          AND display_tv.value = d.display_version
        LEFT JOIN text_values name_tv
          ON name_tv.text_type = ${BROWSER_TEXT_TYPES.DRIVER_NAME}
          AND name_tv.value = d.name
        WHERE d.status = 'found'
        ORDER BY d.id ASC
      `);

      logStep("copying browser detail rows");
      populateBrowserDriverDetailsInBatches(targetDb, logStep);

      logStep("aggregating driver attribute payloads");
      populateBrowserDriverAttributePayloadsInBatches(targetDb, logStep);

      logStep("computing browser statistics");
      statsRow = targetDb.prepare(`
        WITH status_counts AS (
          SELECT
            SUM(CASE WHEN status = 'found' THEN 1 ELSE 0 END) AS found_count,
            SUM(CASE WHEN status = 'confirmed_not_found' THEN 1 ELSE 0 END) AS confirmed_not_found_count,
            SUM(CASE WHEN status = 'pending_frontier' THEN 1 ELSE 0 END) AS pending_frontier_count
          FROM master.drivers
        ),
        highest_found AS (
          SELECT id, version, display_version, name
          FROM master.drivers
          WHERE status = 'found'
          ORDER BY id DESC
          LIMIT 1
        ),
        ordered_missing AS (
          SELECT id, id - ROW_NUMBER() OVER (ORDER BY id) AS grp
          FROM master.drivers
          WHERE status = 'confirmed_not_found'
        ),
        missing_ranges AS (
          SELECT MIN(id) AS start_id, MAX(id) AS end_id, COUNT(*) AS length
          FROM ordered_missing
          GROUP BY grp
        ),
        largest_gap AS (
          SELECT start_id, end_id, length
          FROM missing_ranges
          ORDER BY length DESC, start_id ASC
          LIMIT 1
        )
        SELECT
          1 AS singleton,
          COALESCE(status_counts.found_count, 0) AS found_count,
          COALESCE(status_counts.confirmed_not_found_count, 0) AS confirmed_not_found_count,
          COALESCE(status_counts.pending_frontier_count, 0) AS pending_frontier_count,
          highest_found.id AS highest_found_id,
          COALESCE(highest_found.version, '') AS highest_found_version,
          COALESCE(highest_found.display_version, '') AS highest_found_display_version,
          COALESCE(highest_found.name, '') AS highest_found_name,
          largest_gap.start_id AS largest_gap_start_id,
          largest_gap.end_id AS largest_gap_end_id,
          largest_gap.length AS largest_gap_length,
          ? AS built_at
        FROM status_counts
        LEFT JOIN highest_found ON 1 = 1
        LEFT JOIN largest_gap ON 1 = 1
      `).get(new Date().toISOString());

      targetDb.prepare(`
        INSERT INTO browser_stats (
          singleton,
          found_count,
          confirmed_not_found_count,
          pending_frontier_count,
          highest_found_id,
          highest_found_version,
          highest_found_display_version,
          highest_found_name,
          largest_gap_start_id,
          largest_gap_end_id,
          largest_gap_length,
          built_at
        ) VALUES (
          @singleton,
          @found_count,
          @confirmed_not_found_count,
          @pending_frontier_count,
          @highest_found_id,
          @highest_found_version,
          @highest_found_display_version,
          @highest_found_name,
          @largest_gap_start_id,
          @largest_gap_end_id,
          @largest_gap_length,
          @built_at
        )
      `).run(statsRow);
    })();

    logStep("optimizing browser database");
    targetDb.exec("DETACH DATABASE master");
    targetDb.exec("ANALYZE");
    targetDb.exec("VACUUM");
    targetDb.close();
    targetDb = null;

    logStep(`finalizing ${paths.browserDatabaseFile}`);
    await fs.rename(tempPath, paths.browserDatabaseFile);
    logStep(`writing compressed browser database to ${paths.browserDatabaseGzipFile}`);
    await writeBrowserDatabaseGzip(paths);
    const browserDatabaseMetadata = await writeBrowserDatabaseMetadata(
      paths,
      statsRow?.built_at
    );
    logStep(`wrote browser database metadata to ${paths.browserDatabaseMetaFile}`);
    stdout.write(`built browser database at ${paths.browserDatabaseFile}\n`);

    return {
      exitCode: 0,
      browserDatabaseFile: paths.browserDatabaseFile,
      browserDatabaseGzipFile: paths.browserDatabaseGzipFile,
      browserDatabaseMetaFile: paths.browserDatabaseMetaFile,
      browserDatabaseMetadata,
    };
  } catch (error) {
    if (targetDb) {
      targetDb.close();
    }
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('found', 'confirmed_not_found', 'pending_frontier')),
      release TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      display_version TEXT NOT NULL DEFAULT '',
      gfe_display_version TEXT NOT NULL DEFAULT '',
      release_date_time TEXT NOT NULL DEFAULT '',
      os_name TEXT NOT NULL DEFAULT '',
      os_code TEXT NOT NULL DEFAULT '',
      language_name TEXT NOT NULL DEFAULT '',
      is_64_bit TEXT NOT NULL DEFAULT '',
      is_whql TEXT NOT NULL DEFAULT '',
      is_recommended TEXT NOT NULL DEFAULT '',
      is_dc TEXT NOT NULL DEFAULT '',
      is_crd TEXT NOT NULL DEFAULT '',
      is_beta TEXT NOT NULL DEFAULT '',
      is_feature_preview TEXT NOT NULL DEFAULT '',
      download_file_size TEXT NOT NULL DEFAULT '',
      release_notes TEXT NOT NULL DEFAULT '',
      other_notes TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      details_url TEXT NOT NULL DEFAULT '',
      download_url TEXT NOT NULL DEFAULT '',
      extra_fields_json TEXT NOT NULL DEFAULT '{}',
      last_checked_at TEXT NOT NULL,
      found_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS driver_series (
      driver_id INTEGER NOT NULL,
      series_name TEXT NOT NULL,
      PRIMARY KEY (driver_id, series_name),
      FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS driver_products (
      driver_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      PRIMARY KEY (driver_id, product_name),
      FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value_text TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lookup_sources (
      type_id INTEGER PRIMARY KEY,
      lookup_name TEXT NOT NULL,
      url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      entry_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT NOT NULL,
      last_changed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lookup_values (
      type_id INTEGER NOT NULL,
      value TEXT NOT NULL,
      lookup_name TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_type_id INTEGER,
      parent_value TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      requires_product TEXT NOT NULL DEFAULT '',
      is_select_less TEXT NOT NULL DEFAULT '',
      ordinal INTEGER NOT NULL,
      extra_attrs_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (type_id, value)
    );

    CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
    CREATE INDEX IF NOT EXISTS idx_drivers_version ON drivers(version);
    CREATE INDEX IF NOT EXISTS idx_drivers_display_version ON drivers(display_version);
    CREATE INDEX IF NOT EXISTS idx_drivers_release ON drivers(release);
    CREATE INDEX IF NOT EXISTS idx_drivers_os_code ON drivers(os_code);
    CREATE INDEX IF NOT EXISTS idx_driver_series_name ON driver_series(series_name);
    CREATE INDEX IF NOT EXISTS idx_driver_products_name ON driver_products(product_name);
    CREATE INDEX IF NOT EXISTS idx_lookup_values_parent ON lookup_values(parent_type_id, parent_value);
    CREATE INDEX IF NOT EXISTS idx_lookup_values_type_name ON lookup_values(type_id, name);
    CREATE INDEX IF NOT EXISTS idx_lookup_values_code ON lookup_values(type_id, code);
  `);
}

function createRepository(db, databaseFilePath = "") {
  let contentChanged = false;

  const statements = {
    upsertFound: db.prepare(`
      INSERT INTO drivers (
        id,
        status,
        release,
        version,
        display_version,
        gfe_display_version,
        release_date_time,
        os_name,
        os_code,
        language_name,
        is_64_bit,
        is_whql,
        is_recommended,
        is_dc,
        is_crd,
        is_beta,
        is_feature_preview,
        download_file_size,
        release_notes,
        other_notes,
        name,
        details_url,
        download_url,
        extra_fields_json,
        last_checked_at,
        found_at,
        updated_at
      ) VALUES (
        @id,
        'found',
        @release,
        @version,
        @displayVersion,
        @gfeDisplayVersion,
        @releaseDateTime,
        @osName,
        @osCode,
        @languageName,
        @is64Bit,
        @isWHQL,
        @isRecommended,
        @isDC,
        @isCRD,
        @isBeta,
        @isFeaturePreview,
        @downloadFileSize,
        @releaseNotes,
        @otherNotes,
        @name,
        @detailsUrl,
        @downloadUrl,
        @extraFieldsJson,
        @lastCheckedAt,
        @foundAt,
        @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        status = 'found',
        release = excluded.release,
        version = excluded.version,
        display_version = excluded.display_version,
        gfe_display_version = excluded.gfe_display_version,
        release_date_time = excluded.release_date_time,
        os_name = excluded.os_name,
        os_code = excluded.os_code,
        language_name = excluded.language_name,
        is_64_bit = excluded.is_64_bit,
        is_whql = excluded.is_whql,
        is_recommended = excluded.is_recommended,
        is_dc = excluded.is_dc,
        is_crd = excluded.is_crd,
        is_beta = excluded.is_beta,
        is_feature_preview = excluded.is_feature_preview,
        download_file_size = excluded.download_file_size,
        release_notes = excluded.release_notes,
        other_notes = excluded.other_notes,
        name = excluded.name,
        details_url = excluded.details_url,
        download_url = excluded.download_url,
        extra_fields_json = excluded.extra_fields_json,
        last_checked_at = excluded.last_checked_at,
        found_at = COALESCE(drivers.found_at, excluded.found_at),
        updated_at = excluded.updated_at
    `),
    upsertStatusOnly: db.prepare(`
      INSERT INTO drivers (
        id,
        status,
        last_checked_at,
        updated_at
      ) VALUES (
        ?,
        ?,
        ?,
        ?
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        updated_at = excluded.updated_at
    `),
    deleteSeriesByDriver: db.prepare("DELETE FROM driver_series WHERE driver_id = ?"),
    deleteProductsByDriver: db.prepare("DELETE FROM driver_products WHERE driver_id = ?"),
    insertSeries: db.prepare("INSERT OR IGNORE INTO driver_series (driver_id, series_name) VALUES (?, ?)"),
    insertProduct: db.prepare("INSERT OR IGNORE INTO driver_products (driver_id, product_name) VALUES (?, ?)"),
    setAppState: db.prepare(`
      INSERT INTO app_state (key, value_text, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_text = excluded.value_text,
        updated_at = excluded.updated_at
    `),
    getLookupSource: db.prepare(`
      SELECT type_id, lookup_name, url, content_hash, entry_count, last_checked_at, last_changed_at
      FROM lookup_sources
      WHERE type_id = ?
    `),
    upsertLookupSource: db.prepare(`
      INSERT INTO lookup_sources (
        type_id,
        lookup_name,
        url,
        content_hash,
        entry_count,
        last_checked_at,
        last_changed_at
      ) VALUES (
        @typeId,
        @lookupName,
        @url,
        @contentHash,
        @entryCount,
        @lastCheckedAt,
        @lastChangedAt
      )
      ON CONFLICT(type_id) DO UPDATE SET
        lookup_name = excluded.lookup_name,
        url = excluded.url,
        content_hash = excluded.content_hash,
        entry_count = excluded.entry_count,
        last_checked_at = excluded.last_checked_at,
        last_changed_at = excluded.last_changed_at
    `),
    markLookupSourceChecked: db.prepare(`
      UPDATE lookup_sources
      SET
        lookup_name = ?,
        url = ?,
        entry_count = ?,
        last_checked_at = ?
      WHERE type_id = ?
    `),
    deleteLookupValuesByType: db.prepare("DELETE FROM lookup_values WHERE type_id = ?"),
    insertLookupValue: db.prepare(`
      INSERT INTO lookup_values (
        type_id,
        value,
        lookup_name,
        name,
        parent_type_id,
        parent_value,
        code,
        requires_product,
        is_select_less,
        ordinal,
        extra_attrs_json,
        updated_at
      ) VALUES (
        @typeId,
        @value,
        @lookupName,
        @name,
        @parentTypeId,
        @parentValue,
        @code,
        @requiresProduct,
        @isSelectLess,
        @ordinal,
        @extraAttrsJson,
        @updatedAt
      )
    `),
<<<<<<< Updated upstream
=======
    lookupRowsByType: db.prepare(`
      SELECT
        value,
        name,
        parent_type_id,
        parent_value,
        code,
        requires_product,
        is_select_less
      FROM lookup_values
      WHERE type_id = ?
      ORDER BY value ASC
    `),
>>>>>>> Stashed changes
    lookupNamesByType: db.prepare(`
      SELECT name
      FROM lookup_values
      WHERE type_id = ?
      ORDER BY name ASC
    `),
    distinctFoundProductNames: db.prepare(`
      SELECT DISTINCT dp.product_name AS product_name
      FROM driver_products dp
      JOIN drivers d
        ON d.id = dp.driver_id
      WHERE d.status = 'found'
      ORDER BY dp.product_name ASC
    `),
<<<<<<< Updated upstream
=======
    distinctFoundSeriesNames: db.prepare(`
      SELECT DISTINCT ds.series_name AS series_name
      FROM driver_series ds
      JOIN drivers d
        ON d.id = ds.driver_id
      WHERE d.status = 'found'
      ORDER BY ds.series_name ASC
    `),
    distinctFoundOsNames: db.prepare(`
      SELECT DISTINCT os_name
      FROM drivers
      WHERE status = 'found'
        AND os_name <> ''
      ORDER BY os_name ASC
    `),
    distinctFoundLanguageNames: db.prepare(`
      SELECT DISTINCT language_name
      FROM drivers
      WHERE status = 'found'
        AND language_name <> ''
      ORDER BY language_name ASC
    `),
    distinctReferencedProductTypeValuesForFoundSeries: db.prepare(`
      SELECT DISTINCT lv.parent_value AS parent_value
      FROM lookup_values lv
      JOIN driver_series ds
        ON ds.series_name = lv.name
      JOIN drivers d
        ON d.id = ds.driver_id
      WHERE d.status = 'found'
        AND lv.type_id = 2
        AND lv.parent_type_id = 1
        AND lv.parent_value <> ''
      ORDER BY lv.parent_value ASC
    `),
>>>>>>> Stashed changes
    orderedDriverStatuses: db.prepare(`
      SELECT id, status
      FROM drivers
      WHERE id >= ?
      ORDER BY id ASC
    `),
    getDriverStatusById: db.prepare(`
      SELECT status
      FROM drivers
      WHERE id = ?
    `),
    getDriverFoundContentById: db.prepare(`
      SELECT
        id,
        status,
        release,
        version,
        display_version,
        gfe_display_version,
        release_date_time,
        os_name,
        os_code,
        language_name,
        is_64_bit,
        is_whql,
        is_recommended,
        is_dc,
        is_crd,
        is_beta,
        is_feature_preview,
        download_file_size,
        release_notes,
        other_notes,
        name,
        details_url,
        download_url,
        extra_fields_json
      FROM drivers
      WHERE id = ?
    `),
    selectSeriesByDriver: db.prepare(`
      SELECT series_name
      FROM driver_series
      WHERE driver_id = ?
      ORDER BY series_name ASC
    `),
    selectProductsByDriver: db.prepare(`
      SELECT product_name
      FROM driver_products
      WHERE driver_id = ?
      ORDER BY product_name ASC
    `),
  };

  function normalizeComparableValue(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function normalizeComparableList(values) {
    return (values || []).map((value) => String(value)).sort((left, right) => left.localeCompare(right));
  }

  function areComparableListsEqual(left, right) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false;
      }
    }

    return true;
  }

  function hasFoundDriverContentChange(summaryRecord, extraFieldsJson) {
    const driverId = Number(summaryRecord.id);
    const existing = statements.getDriverFoundContentById.get(driverId);
    if (!existing || existing.status !== "found") {
      return true;
    }

    const comparablePairs = [
      [existing.release, summaryRecord.release],
      [existing.version, summaryRecord.version],
      [existing.display_version, summaryRecord.displayVersion],
      [existing.gfe_display_version, summaryRecord.gfeDisplayVersion],
      [existing.release_date_time, summaryRecord.releaseDateTime],
      [existing.os_name, summaryRecord.osName],
      [existing.os_code, summaryRecord.osCode],
      [existing.language_name, summaryRecord.languageName],
      [existing.is_64_bit, summaryRecord.is64Bit],
      [existing.is_whql, summaryRecord.isWHQL],
      [existing.is_recommended, summaryRecord.isRecommended],
      [existing.is_dc, summaryRecord.isDC],
      [existing.is_crd, summaryRecord.isCRD],
      [existing.is_beta, summaryRecord.isBeta],
      [existing.is_feature_preview, summaryRecord.isFeaturePreview],
      [existing.download_file_size, summaryRecord.downloadFileSize],
      [existing.release_notes, summaryRecord.releaseNotes],
      [existing.other_notes, summaryRecord.otherNotes],
      [existing.name, summaryRecord.name],
      [existing.details_url, summaryRecord.detailsUrl],
      [existing.download_url, summaryRecord.downloadUrl],
      [existing.extra_fields_json, extraFieldsJson],
    ];

    for (const [existingValue, nextValue] of comparablePairs) {
      if (normalizeComparableValue(existingValue) !== normalizeComparableValue(nextValue)) {
        return true;
      }
    }

    const existingSeries = normalizeComparableList(
      statements.selectSeriesByDriver.all(driverId).map((row) => row.series_name)
    );
    const nextSeries = normalizeComparableList(summaryRecord.seriesNames);
    if (!areComparableListsEqual(existingSeries, nextSeries)) {
      return true;
    }

    const existingProducts = normalizeComparableList(
      statements.selectProductsByDriver.all(driverId).map((row) => row.product_name)
    );
    const nextProducts = normalizeComparableList(summaryRecord.productNames);
    if (!areComparableListsEqual(existingProducts, nextProducts)) {
      return true;
    }

    return false;
  }

  const persistFound = db.transaction((summaryRecord, extraFieldsJson, checkedAt) => {
    if (hasFoundDriverContentChange(summaryRecord, extraFieldsJson)) {
      contentChanged = true;
    }

    statements.upsertFound.run({
      id: Number(summaryRecord.id),
      release: summaryRecord.release,
      version: summaryRecord.version,
      displayVersion: summaryRecord.displayVersion,
      gfeDisplayVersion: summaryRecord.gfeDisplayVersion,
      releaseDateTime: summaryRecord.releaseDateTime,
      osName: summaryRecord.osName,
      osCode: summaryRecord.osCode,
      languageName: summaryRecord.languageName,
      is64Bit: summaryRecord.is64Bit,
      isWHQL: summaryRecord.isWHQL,
      isRecommended: summaryRecord.isRecommended,
      isDC: summaryRecord.isDC,
      isCRD: summaryRecord.isCRD,
      isBeta: summaryRecord.isBeta,
      isFeaturePreview: summaryRecord.isFeaturePreview,
      downloadFileSize: summaryRecord.downloadFileSize,
      releaseNotes: summaryRecord.releaseNotes,
      otherNotes: summaryRecord.otherNotes,
      name: summaryRecord.name,
      detailsUrl: summaryRecord.detailsUrl,
      downloadUrl: summaryRecord.downloadUrl,
      extraFieldsJson,
      lastCheckedAt: checkedAt,
      foundAt: checkedAt,
      updatedAt: checkedAt,
    });

    statements.deleteSeriesByDriver.run(Number(summaryRecord.id));
    statements.deleteProductsByDriver.run(Number(summaryRecord.id));

    summaryRecord.seriesNames.forEach((seriesName) => {
      statements.insertSeries.run(Number(summaryRecord.id), seriesName);
    });

    summaryRecord.productNames.forEach((productName) => {
      statements.insertProduct.run(Number(summaryRecord.id), productName);
    });
  });

  const persistStatusOnly = db.transaction((id, status, checkedAt) => {
    const existing = statements.getDriverStatusById.get(Number(id));
    if (!existing || existing.status !== status) {
      contentChanged = true;
    }

    statements.upsertStatusOnly.run(Number(id), status, checkedAt, checkedAt);
  });

  const promoteConfirmedNotFound = db.transaction((ids, checkedAt) => {
    ids.forEach((id) => {
      const existing = statements.getDriverStatusById.get(Number(id));
      if (!existing || existing.status !== "confirmed_not_found") {
        contentChanged = true;
      }

      statements.upsertStatusOnly.run(Number(id), "confirmed_not_found", checkedAt, checkedAt);
    });
  });

  const setStateEntries = db.transaction((entries) => {
    const now = new Date().toISOString();
    Object.entries(entries).forEach(([key, value]) => {
      statements.setAppState.run(key, String(value), now);
    });
  });

  function countCoveredFoundProductNames(productLookupNames) {
    const lookupNames = productLookupNames instanceof Set
      ? productLookupNames
      : new Set((productLookupNames || []).map((name) => String(name)));
    const foundProductNames = statements.distinctFoundProductNames.pluck().all();
    let coveredCount = 0;

    for (const productName of foundProductNames) {
      if (lookupNames.has(productName)) {
        coveredCount += 1;
      }
    }

    return {
      coveredCount,
      totalCount: foundProductNames.length,
    };
  }

<<<<<<< Updated upstream
=======
  function countCoveredFoundSeriesNames(seriesLookupNames) {
    const lookupNames = seriesLookupNames instanceof Set
      ? seriesLookupNames
      : new Set((seriesLookupNames || []).map((name) => String(name)));
    const foundSeriesNames = statements.distinctFoundSeriesNames.pluck().all();
    let coveredCount = 0;

    for (const seriesName of foundSeriesNames) {
      if (lookupNames.has(seriesName)) {
        coveredCount += 1;
      }
    }

    return {
      coveredCount,
      totalCount: foundSeriesNames.length,
    };
  }

  function countCoveredFoundOsNames(osLookupNames) {
    const lookupNames = osLookupNames instanceof Set
      ? osLookupNames
      : new Set((osLookupNames || []).map((name) => String(name)));
    const foundOsNames = statements.distinctFoundOsNames.pluck().all();
    let coveredCount = 0;

    for (const osName of foundOsNames) {
      if (lookupNames.has(osName)) {
        coveredCount += 1;
      }
    }

    return {
      coveredCount,
      totalCount: foundOsNames.length,
    };
  }

  function countCoveredFoundLanguageNames(languageLookupNames) {
    const lookupNames = languageLookupNames instanceof Set
      ? languageLookupNames
      : new Set((languageLookupNames || []).map((name) => String(name)));
    const foundLanguageNames = statements.distinctFoundLanguageNames.pluck().all();
    let coveredCount = 0;

    for (const languageName of foundLanguageNames) {
      if (lookupNames.has(languageName)) {
        coveredCount += 1;
      }
    }

    return {
      coveredCount,
      totalCount: foundLanguageNames.length,
    };
  }

  function countCoveredReferencedProductTypeValues(productTypeValues) {
    const lookupValues = productTypeValues instanceof Set
      ? productTypeValues
      : new Set((productTypeValues || []).map((value) => String(value)));
    const referencedValues = statements.distinctReferencedProductTypeValuesForFoundSeries.pluck().all();
    let coveredCount = 0;

    for (const parentValue of referencedValues) {
      if (lookupValues.has(String(parentValue))) {
        coveredCount += 1;
      }
    }

    return {
      coveredCount,
      totalCount: referencedValues.length,
    };
  }

  function getLookupCoverageForReplacement(definition, entries) {
    switch (Number(definition.typeId)) {
      case 1: {
        const existingValues = new Set(
          db.prepare(`
            SELECT value
            FROM lookup_values
            WHERE type_id = 1
            ORDER BY value ASC
          `).pluck().all().map((value) => String(value))
        );
        const candidateValues = new Set(entries.map((entry) => String(entry.value)));
        return {
          label: "referenced product type values",
          existing: countCoveredReferencedProductTypeValues(existingValues),
          candidate: countCoveredReferencedProductTypeValues(candidateValues),
        };
      }
      case 2: {
        const existingNames = new Set(statements.lookupNamesByType.pluck().all(2));
        const candidateNames = new Set(entries.map((entry) => String(entry.name)));
        return {
          label: "found series names",
          existing: countCoveredFoundSeriesNames(existingNames),
          candidate: countCoveredFoundSeriesNames(candidateNames),
        };
      }
      case 3: {
        const existingNames = new Set(statements.lookupNamesByType.pluck().all(3));
        const candidateNames = new Set(entries.map((entry) => String(entry.name)));
        return {
          label: "found product names",
          existing: countCoveredFoundProductNames(existingNames),
          candidate: countCoveredFoundProductNames(candidateNames),
        };
      }
      case 4: {
        const existingNames = new Set(statements.lookupNamesByType.pluck().all(4));
        const candidateNames = new Set(entries.map((entry) => String(entry.name)));
        return {
          label: "found operating system names",
          existing: countCoveredFoundOsNames(existingNames),
          candidate: countCoveredFoundOsNames(candidateNames),
        };
      }
      case 5: {
        const existingNames = new Set(statements.lookupNamesByType.pluck().all(5));
        const candidateNames = new Set(entries.map((entry) => String(entry.name)));
        return {
          label: "found language names",
          existing: countCoveredFoundLanguageNames(existingNames),
          candidate: countCoveredFoundLanguageNames(candidateNames),
        };
      }
      default:
        return null;
    }
  }

  function buildLookupDiffDiagnostics(typeId, entries) {
    const existingRows = statements.lookupRowsByType.all(typeId).map((row) => ({
      value: String(row.value),
      name: String(row.name),
      parentTypeId: row.parent_type_id === null || row.parent_type_id === undefined ? "" : String(row.parent_type_id),
      parentValue: row.parent_value === null || row.parent_value === undefined ? "" : String(row.parent_value),
      code: row.code === null || row.code === undefined ? "" : String(row.code),
      requiresProduct: row.requires_product === null || row.requires_product === undefined ? "" : String(row.requires_product),
      isSelectLess: row.is_select_less === null || row.is_select_less === undefined ? "" : String(row.is_select_less),
    }));
    const nextRows = entries.map((entry) => ({
      value: String(entry.value),
      name: String(entry.name),
      parentTypeId: entry.parentTypeId === null || entry.parentTypeId === undefined ? "" : String(entry.parentTypeId),
      parentValue: entry.parentValue === null || entry.parentValue === undefined ? "" : String(entry.parentValue),
      code: entry.code === null || entry.code === undefined ? "" : String(entry.code),
      requiresProduct: entry.requiresProduct === null || entry.requiresProduct === undefined ? "" : String(entry.requiresProduct),
      isSelectLess: entry.isSelectLess === null || entry.isSelectLess === undefined ? "" : String(entry.isSelectLess),
    }));

    const existingByValue = new Map(existingRows.map((row) => [row.value, row]));
    const nextByValue = new Map(nextRows.map((row) => [row.value, row]));
    const added = [];
    const removed = [];
    const renamed = [];
    const reparented = [];
    const attributeChanged = [];

    for (const row of nextRows) {
      if (!existingByValue.has(row.value)) {
        added.push(`${row.value}=${row.name}`);
      }
    }

    for (const row of existingRows) {
      if (!nextByValue.has(row.value)) {
        removed.push(`${row.value}=${row.name}`);
        continue;
      }

      const nextRow = nextByValue.get(row.value);
      if (row.name !== nextRow.name) {
        renamed.push(`${row.value}: ${row.name} -> ${nextRow.name}`);
      }

      if (row.parentTypeId !== nextRow.parentTypeId || row.parentValue !== nextRow.parentValue) {
        const fromParent = row.parentTypeId && row.parentValue ? `${row.parentTypeId}:${row.parentValue}` : "(none)";
        const toParent = nextRow.parentTypeId && nextRow.parentValue ? `${nextRow.parentTypeId}:${nextRow.parentValue}` : "(none)";
        reparented.push(`${row.value}: ${fromParent} -> ${toParent}`);
      }

      if (
        row.code !== nextRow.code ||
        row.requiresProduct !== nextRow.requiresProduct ||
        row.isSelectLess !== nextRow.isSelectLess
      ) {
        attributeChanged.push(row.value);
      }
    }

    return {
      previousEntryCount: existingRows.length,
      nextEntryCount: nextRows.length,
      addedCount: added.length,
      removedCount: removed.length,
      renamedCount: renamed.length,
      reparentedCount: reparented.length,
      attributeChangedCount: attributeChanged.length,
      addedSample: added.slice(0, 5),
      removedSample: removed.slice(0, 5),
      renamedSample: renamed.slice(0, 5),
      reparentedSample: reparented.slice(0, 5),
      attributeChangedSample: attributeChanged.slice(0, 5),
    };
  }

>>>>>>> Stashed changes
  const replaceLookupValues = db.transaction((definition, url, contentHash, entries, checkedAt) => {
    const existingSource = statements.getLookupSource.get(definition.typeId);
    const diffDiagnostics = existingSource
      ? buildLookupDiffDiagnostics(definition.typeId, entries)
      : {
          previousEntryCount: 0,
          nextEntryCount: entries.length,
          addedCount: entries.length,
          removedCount: 0,
          renamedCount: 0,
          reparentedCount: 0,
          attributeChangedCount: 0,
          addedSample: entries.slice(0, 5).map((entry) => `${entry.value}=${entry.name}`),
          removedSample: [],
          renamedSample: [],
          reparentedSample: [],
          attributeChangedSample: [],
        };

    if (existingSource && existingSource.content_hash === contentHash) {
      statements.markLookupSourceChecked.run(
        definition.lookupName,
        url,
        entries.length,
        checkedAt,
        definition.typeId
      );

      return {
        changed: false,
        entryCount: entries.length,
        previousHash: existingSource.content_hash,
        contentHash,
      };
    }

<<<<<<< Updated upstream
    if (definition.typeId === 3 && existingSource) {
      const existingLookupNames = new Set(statements.lookupNamesByType.pluck().all(definition.typeId));
      const candidateLookupNames = new Set(entries.map((entry) => String(entry.name)));
      const existingCoverage = countCoveredFoundProductNames(existingLookupNames);
      const candidateCoverage = countCoveredFoundProductNames(candidateLookupNames);

      if (candidateCoverage.coveredCount < existingCoverage.coveredCount) {
=======
    if (existingSource) {
      const coverage = getLookupCoverageForReplacement(definition, entries);

      if (coverage && coverage.candidate.coveredCount < coverage.existing.coveredCount) {
>>>>>>> Stashed changes
        statements.markLookupSourceChecked.run(
          definition.lookupName,
          url,
          Number(existingSource.entry_count),
          checkedAt,
          definition.typeId
        );

        return {
          changed: false,
          entryCount: Number(existingSource.entry_count),
          previousHash: existingSource.content_hash,
          contentHash: existingSource.content_hash,
          skippedCoverageRegression: true,
<<<<<<< Updated upstream
          retainedCoverageCount: existingCoverage.coveredCount,
          candidateCoverageCount: candidateCoverage.coveredCount,
          totalFoundProductCount: existingCoverage.totalCount,
          candidateEntryCount: entries.length,
=======
          coverageLabel: coverage.label,
          retainedCoverageCount: coverage.existing.coveredCount,
          candidateCoverageCount: coverage.candidate.coveredCount,
          totalReferencedCount: coverage.existing.totalCount,
          candidateEntryCount: entries.length,
          diffDiagnostics,
>>>>>>> Stashed changes
        };
      }
    }

    statements.deleteLookupValuesByType.run(definition.typeId);
    entries.forEach((entry) => {
      statements.insertLookupValue.run({
        typeId: entry.typeId,
        value: entry.value,
        lookupName: entry.lookupName,
        name: entry.name,
        parentTypeId: entry.parentTypeId,
        parentValue: entry.parentValue,
        code: entry.code,
        requiresProduct: entry.requiresProduct,
        isSelectLess: entry.isSelectLess,
        ordinal: entry.ordinal,
        extraAttrsJson: JSON.stringify(entry.extraAttrs),
        updatedAt: checkedAt,
      });
    });

    statements.upsertLookupSource.run({
      typeId: definition.typeId,
      lookupName: definition.lookupName,
      url,
      contentHash,
      entryCount: entries.length,
      lastCheckedAt: checkedAt,
      lastChangedAt: checkedAt,
    });

    return {
      changed: true,
      entryCount: entries.length,
      previousHash: existingSource ? existingSource.content_hash : null,
      contentHash,
      diffDiagnostics,
    };
  });

  function findNextUnresolvedId() {
    const rows = statements.orderedDriverStatuses.all(MIN_DRIVER_ID);
    let nextId = MIN_DRIVER_ID;

    for (const row of rows) {
      if (row.id < nextId) {
        continue;
      }

      if (row.id > nextId) {
        return nextId;
      }

      if (row.status === "pending_frontier") {
        return row.id;
      }

      nextId = row.id + 1;
    }

    return nextId;
  }

  function queryDrivers(filters) {
    const conditions = ["d.status = 'found'"];
    const params = [];

    const exactMappings = [
      ["version", "d.version = ?"],
      ["displayVersion", "d.display_version = ?"],
      ["release", "d.release = ?"],
      ["osCode", "d.os_code = ?"],
      ["is64Bit", "d.is_64_bit = ?"],
      ["isWHQL", "d.is_whql = ?"],
      ["isRecommended", "d.is_recommended = ?"],
      ["isDC", "d.is_dc = ?"],
      ["isCRD", "d.is_crd = ?"],
      ["isBeta", "d.is_beta = ?"],
      ["isFeaturePreview", "d.is_feature_preview = ?"],
    ];

    exactMappings.forEach(([key, sql]) => {
      if (filters[key]) {
        conditions.push(sql);
        params.push(filters[key]);
      }
    });

    const substringMappings = [
      ["osName", "LOWER(d.os_name) LIKE ?"],
      ["languageName", "LOWER(d.language_name) LIKE ?"],
      ["name", "LOWER(d.name) LIKE ?"],
    ];

    substringMappings.forEach(([key, sql]) => {
      if (filters[key]) {
        conditions.push(sql);
        params.push(`%${String(filters[key]).toLowerCase()}%`);
      }
    });

    if (filters.series) {
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM driver_series ds
          WHERE ds.driver_id = d.id
            AND LOWER(ds.series_name) LIKE ?
        )
      `);
      params.push(`%${String(filters.series).toLowerCase()}%`);
    }

    if (filters.product) {
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM driver_products dp
          WHERE dp.driver_id = d.id
            AND LOWER(dp.product_name) LIKE ?
        )
      `);
      params.push(`%${String(filters.product).toLowerCase()}%`);
    }

    const rows = db.prepare(`
      SELECT
        d.id,
        d.release,
        d.version,
        d.display_version,
        d.gfe_display_version,
        d.release_date_time,
        d.os_name,
        d.os_code,
        d.language_name,
        d.is_64_bit,
        d.is_whql,
        d.is_recommended,
        d.is_dc,
        d.is_crd,
        d.is_beta,
        d.is_feature_preview,
        d.download_file_size,
        d.release_notes,
        d.other_notes,
        d.name,
        d.details_url,
        d.download_url
      FROM drivers d
      WHERE ${conditions.join(" AND ")}
      ORDER BY d.id ASC
    `).all(...params);

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    const seriesRows = db.prepare(`
      SELECT driver_id, series_name
      FROM driver_series
      WHERE driver_id IN (${placeholders})
      ORDER BY driver_id ASC, series_name ASC
    `).all(...ids);
    const productRows = db.prepare(`
      SELECT driver_id, product_name
      FROM driver_products
      WHERE driver_id IN (${placeholders})
      ORDER BY driver_id ASC, product_name ASC
    `).all(...ids);

    const seriesMap = new Map();
    seriesRows.forEach((row) => {
      if (!seriesMap.has(row.driver_id)) {
        seriesMap.set(row.driver_id, []);
      }
      seriesMap.get(row.driver_id).push(row.series_name);
    });

    const productMap = new Map();
    productRows.forEach((row) => {
      if (!productMap.has(row.driver_id)) {
        productMap.set(row.driver_id, []);
      }
      productMap.get(row.driver_id).push(row.product_name);
    });

    return rows.map((row) => ({
      id: String(row.id),
      release: row.release,
      version: row.version,
      displayVersion: row.display_version,
      gfeDisplayVersion: row.gfe_display_version,
      releaseDateTime: row.release_date_time,
      osName: row.os_name,
      osCode: row.os_code,
      languageName: row.language_name,
      is64Bit: row.is_64_bit,
      isWHQL: row.is_whql,
      isRecommended: row.is_recommended,
      isDC: row.is_dc,
      isCRD: row.is_crd,
      isBeta: row.is_beta,
      isFeaturePreview: row.is_feature_preview,
      downloadFileSize: row.download_file_size,
      releaseNotes: row.release_notes,
      otherNotes: row.other_notes,
      name: row.name,
      detailsUrl: row.details_url,
      downloadUrl: row.download_url,
      seriesNames: seriesMap.get(row.id) || [],
      productNames: productMap.get(row.id) || [],
    }));
  }

  function normalizeStatsRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      status: row.status,
      version: row.version || "",
      displayVersion: row.display_version || "",
      name: row.name || "",
    };
  }

  function getStats(topGapLimit = 5) {
    const statusCounts = {
      found: 0,
      confirmedNotFound: 0,
      pendingFrontier: 0,
    };

    const countRows = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM drivers
      GROUP BY status
    `).all();

    countRows.forEach((row) => {
      if (row.status === "found") {
        statusCounts.found = row.count;
      } else if (row.status === "confirmed_not_found") {
        statusCounts.confirmedNotFound = row.count;
      } else if (row.status === "pending_frontier") {
        statusCounts.pendingFrontier = row.count;
      }
    });

    const knownBounds = db.prepare(`
      SELECT MIN(id) AS min_id, MAX(id) AS max_id
      FROM drivers
    `).get();

    const foundBounds = db.prepare(`
      SELECT MIN(id) AS min_id, MAX(id) AS max_id
      FROM drivers
      WHERE status = 'found'
    `).get();

    const highestKnown = normalizeStatsRow(db.prepare(`
      SELECT id, status, version, display_version, name
      FROM drivers
      ORDER BY id DESC
      LIMIT 1
    `).get());

    const lowestFound = normalizeStatsRow(db.prepare(`
      SELECT id, status, version, display_version, name
      FROM drivers
      WHERE status = 'found'
      ORDER BY id ASC
      LIMIT 1
    `).get());

    const highestFound = normalizeStatsRow(db.prepare(`
      SELECT id, status, version, display_version, name
      FROM drivers
      WHERE status = 'found'
      ORDER BY id DESC
      LIMIT 1
    `).get());

    const pendingFrontier = db.prepare(`
      SELECT
        COUNT(*) AS pending_count,
        MIN(id) AS first_pending_id,
        MAX(id) AS last_pending_id
      FROM drivers
      WHERE status = 'pending_frontier'
    `).get();

    const appStateRows = db.prepare(`
      SELECT key, value_text
      FROM app_state
      WHERE key IN (
        'schema_version',
        'last_stop_reason',
        'last_processed_id',
        'last_run_at',
        'last_lookup_refresh_at',
        'max_trailing_not_found'
      )
    `).all();

    const appState = {};
    appStateRows.forEach((row) => {
      appState[row.key] = row.value_text;
    });

    const gapRows = db.prepare(`
      WITH ordered AS (
        SELECT id, id - ROW_NUMBER() OVER (ORDER BY id) AS grp
        FROM drivers
        WHERE status = 'confirmed_not_found'
      ),
      ranges AS (
        SELECT
          MIN(id) AS start_id,
          MAX(id) AS end_id,
          COUNT(*) AS length
        FROM ordered
        GROUP BY grp
      )
      SELECT start_id, end_id, length
      FROM ranges
      ORDER BY length DESC, start_id ASC
      LIMIT ?
    `).all(topGapLimit);

    const previousKnownStatement = db.prepare(`
      SELECT id, status, version, display_version, name
      FROM drivers
      WHERE id < ?
      ORDER BY id DESC
      LIMIT 1
    `);
    const nextKnownStatement = db.prepare(`
      SELECT id, status, version, display_version, name
      FROM drivers
      WHERE id > ?
      ORDER BY id ASC
      LIMIT 1
    `);

    const topConfirmedNotFoundGaps = gapRows.map((gap) => ({
      startId: gap.start_id,
      endId: gap.end_id,
      length: gap.length,
      previousKnown: normalizeStatsRow(previousKnownStatement.get(gap.start_id)),
      nextKnown: normalizeStatsRow(nextKnownStatement.get(gap.end_id)),
    }));

    const lookupSources = db.prepare(`
      SELECT
        type_id,
        lookup_name,
        url,
        content_hash,
        entry_count,
        last_checked_at,
        last_changed_at
      FROM lookup_sources
      ORDER BY type_id ASC
    `).all().map((row) => ({
      typeId: row.type_id,
      lookupName: row.lookup_name,
      url: row.url,
      contentHash: row.content_hash,
      entryCount: row.entry_count,
      lastCheckedAt: row.last_checked_at,
      lastChangedAt: row.last_changed_at,
    }));

    const nextUnresolvedId = findNextUnresolvedId();

    return {
      statusCounts,
      totals: {
        knownRows: statusCounts.found + statusCounts.confirmedNotFound + statusCounts.pendingFrontier,
        minKnownId: knownBounds.min_id,
        maxKnownId: knownBounds.max_id,
        minFoundId: foundBounds.min_id,
        maxFoundId: foundBounds.max_id,
      },
      crawlPosition: {
        nextUnresolvedId,
        resolvedThroughId: nextUnresolvedId > MIN_DRIVER_ID ? nextUnresolvedId - 1 : null,
        highestKnown,
      },
      frontier: {
        pendingCount: pendingFrontier.pending_count,
        firstPendingId: pendingFrontier.first_pending_id,
        lastPendingId: pendingFrontier.last_pending_id,
      },
      foundExtremes: {
        lowestFound,
        highestFound,
      },
      lastRun: {
        schemaVersion: appState.schema_version || null,
        stopReason: appState.last_stop_reason || null,
        lastProcessedId: appState.last_processed_id || null,
        lastRunAt: appState.last_run_at || null,
        lastLookupRefreshAt: appState.last_lookup_refresh_at || null,
        maxTrailingNotFound: appState.max_trailing_not_found || null,
      },
      lookups: lookupSources,
      largestConfirmedNotFoundGap: topConfirmedNotFoundGaps[0] || null,
      topConfirmedNotFoundGaps,
    };
  }

  function writeStopState(reason, lastProcessedId, maxTrailingNotFound) {
    setStateEntries({
      schema_version: SQLITE_SCHEMA_VERSION,
      last_stop_reason: reason,
      last_processed_id: lastProcessedId === undefined || lastProcessedId === null ? "" : String(lastProcessedId),
      last_run_at: new Date().toISOString(),
      max_trailing_not_found: String(maxTrailingNotFound),
    });
  }

  return {
    db,
    close() {
      finalizeStandaloneDatabase(db, databaseFilePath);
    },
    listDriverStatuses(startId = MIN_DRIVER_ID) {
      return statements.orderedDriverStatuses.all(startId).map((row) => ({
        id: Number(row.id),
        status: row.status,
      }));
    },
    findNextUnresolvedId,
    persistFound(summaryRecord, extraFieldsJson, checkedAt) {
      persistFound(summaryRecord, extraFieldsJson, checkedAt);
    },
    persistPendingFrontier(id, checkedAt) {
      persistStatusOnly(id, "pending_frontier", checkedAt);
    },
    promoteConfirmedNotFound(ids, checkedAt) {
      promoteConfirmedNotFound(ids, checkedAt);
    },
    replaceLookupValues(definition, url, contentHash, entries, checkedAt) {
      const result = replaceLookupValues(definition, url, contentHash, entries, checkedAt);
      if (result.changed) {
        contentChanged = true;
      }
      return result;
    },
    getStats(topGapLimit) {
      return getStats(topGapLimit);
    },
    queryDrivers,
    writeStopState,
    setStateEntries(entries) {
      setStateEntries(entries);
    },
    setSchemaVersion() {
      setStateEntries({ schema_version: SQLITE_SCHEMA_VERSION });
    },
    hasContentChanges() {
      return contentChanged;
    },
  };
}

async function openRepository(rootDir, dataDirName = DEFAULT_DATA_DIR_NAME) {
  const paths = getPaths(rootDir, dataDirName);
  await fs.mkdir(paths.dataDir, { recursive: true });

  const db = new Database(paths.databaseFile);
  configureDatabase(db);
  initializeSchema(db);

  const repository = createRepository(db, paths.databaseFile);
  repository.setSchemaVersion();
  return repository;
}

function stringifyError(error) {
  if (error && error.stack) {
    return error.stack;
  }

  return String(error);
}

function formatHardFailureMessage(status, bodyText) {
  return `Unexpected HTTP status ${status}\n${bodyText}\n`;
}

function formatUnexpectedBodyMessage(reason, bodyText) {
  return `Unexpected 200 response: ${reason}\n${bodyText}\n`;
}

function formatRetryMessage(id, status, bodyText, attemptNumber, retries, delayMs) {
  return `${formatHardFailureMessage(status, bodyText)}HTTP ${status} for driver ID ${id}; retry ${attemptNumber}/${retries} in ${delayMs / 1000}s\n`;
}

function formatUnexpectedBodyRetryMessage(id, reason, bodyText, attemptNumber, retries, delayMs) {
  return `${formatUnexpectedBodyMessage(reason, bodyText)}Unexpected 200 response for driver ID ${id}; retry ${attemptNumber}/${retries} in ${delayMs / 1000}s\n`;
}

function formatDurationMs(timeoutMs) {
  if (timeoutMs % 1000 === 0) {
    return `${timeoutMs / 1000}s`;
  }

  return `${timeoutMs}ms`;
}

function formatTimeoutMessage(id, timeoutMs) {
  return `Request timed out after ${formatDurationMs(timeoutMs)} for driver ID ${id}\n`;
}

function formatTimeoutRetryMessage(id, timeoutMs, attemptNumber, retries, delayMs) {
  return `${formatTimeoutMessage(id, timeoutMs)}Request timeout for driver ID ${id}; retry ${attemptNumber}/${retries} in ${delayMs / 1000}s\n`;
}

function formatLookupHardFailureMessage(typeId, status, bodyText) {
  return `Unexpected HTTP status ${status} for NVIDIA lookup TypeID ${typeId}\n${bodyText}\n`;
}

function formatLookupUnexpectedBodyMessage(typeId, reason, bodyText) {
  return `Unexpected NVIDIA lookup TypeID ${typeId} response: ${reason}\n${bodyText}\n`;
}

function formatLookupRetryMessage(typeId, reason, attemptNumber, retries, delayMs) {
  return `NVIDIA lookup TypeID ${typeId} ${reason}; retry ${attemptNumber}/${retries} in ${delayMs / 1000}s\n`;
}

function formatLookupTimeoutMessage(typeId, timeoutMs) {
  return `Request timed out after ${formatDurationMs(timeoutMs)} for NVIDIA lookup TypeID ${typeId}\n`;
}

function formatLookupDiffDiagnostics(updateResult) {
  const diagnostics = updateResult.diffDiagnostics;
  if (!diagnostics) {
    return [];
  }

  const lines = [
    `  entries: ${diagnostics.previousEntryCount} -> ${diagnostics.nextEntryCount}`,
  ];

  const maybePushSample = (label, count, sample) => {
    if (!count) {
      return;
    }

    const suffix = sample && sample.length > 0
      ? ` sample: ${sample.join("; ")}`
      : "";
    lines.push(`  ${label} (${count})${suffix}`);
  };

  maybePushSample("added values", diagnostics.addedCount, diagnostics.addedSample);
  maybePushSample("removed values", diagnostics.removedCount, diagnostics.removedSample);
  maybePushSample("renamed values", diagnostics.renamedCount, diagnostics.renamedSample);
  maybePushSample("reparented values", diagnostics.reparentedCount, diagnostics.reparentedSample);
  maybePushSample("attribute-changed values", diagnostics.attributeChangedCount, diagnostics.attributeChangedSample);

  return lines;
}

function isAbortError(error) {
  return Boolean(error) && (error.name === "AbortError" || error.code === "ABORT_ERR");
}

function createRuntimeControl() {
  let shutdownRequested = false;
  const activeAbortControllers = new Set();
  const shutdownAbortController = new AbortController();

  return {
    get shutdownRequested() {
      return shutdownRequested;
    },
    get shutdownSignal() {
      return shutdownAbortController.signal;
    },
    abortActiveRequests() {
      for (const controller of activeAbortControllers) {
        controller.abort();
      }
    },
    requestShutdown() {
      if (!shutdownRequested) {
        shutdownRequested = true;
        shutdownAbortController.abort();
      }
      this.abortActiveRequests();
    },
    setActiveAbortController(controller) {
      if (controller) {
        activeAbortControllers.add(controller);
      }
      if (shutdownRequested && controller) {
        controller.abort();
      }
    },
    clearActiveAbortController(controller) {
      if (controller) {
        activeAbortControllers.delete(controller);
      }
    },
  };
}

async function defaultSleepImpl(delayMs, signal) {
  await sleep(delayMs, undefined, signal ? { signal } : undefined);
}

async function sleepBeforeRetry(delayMs, runtimeControl, sleepImpl) {
  if (runtimeControl.shutdownRequested) {
    return false;
  }

  try {
    await sleepImpl(delayMs, runtimeControl.shutdownSignal);
    return !runtimeControl.shutdownRequested;
  } catch (error) {
    if (isAbortError(error) && runtimeControl.shutdownRequested) {
      return false;
    }

    throw error;
  }
}

async function fetchDriverOutcome({
  id,
  requestUrl,
  fetchImpl,
  runtimeControl,
  retries,
  timeoutMs,
  sleepImpl,
  stderr,
}) {
  let retryCount = 0;

  while (!runtimeControl.shutdownRequested) {
    const abortController = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    runtimeControl.setActiveAbortController(abortController);

    try {
      const response = await fetchImpl(requestUrl, {
        signal: abortController.signal,
      });
      let responseStatus = response.status;
      let bodyText = await response.text();

      if (responseStatus !== 200) {
        if (responseStatus === 404 || retryCount >= retries) {
          return {
            id,
            type: "http_error",
            status: responseStatus,
            bodyText,
          };
        }

        const delayMs = 1000 * (2 ** retryCount);
        retryCount += 1;
        stderr.write(formatRetryMessage(id, responseStatus, bodyText, retryCount, retries, delayMs));

        const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
        if (!shouldContinue) {
          return {
            id,
            type: "shutdown_abort",
          };
        }

        continue;
      }

      let payload;
      try {
        payload = parseDriverPayloadText(bodyText);
      } catch (error) {
        const reason = `invalid JSON (${error.message})`;
        if (retryCount >= retries) {
          return {
            id,
            type: "invalid_json",
            bodyText,
            reason,
          };
        }

        const delayMs = 1000 * (2 ** retryCount);
        retryCount += 1;
        stderr.write(formatUnexpectedBodyRetryMessage(id, reason, bodyText, retryCount, retries, delayMs));

        const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
        if (!shouldContinue) {
          return {
            id,
            type: "shutdown_abort",
          };
        }

        continue;
      }

      if (shouldUseAemDriverFallback(payload)) {
        const fallbackResponse = await fetchImpl(buildFallbackRequestUrl(id), {
          signal: abortController.signal,
        });
        responseStatus = fallbackResponse.status;
        bodyText = await fallbackResponse.text();

        if (responseStatus !== 200) {
          if (responseStatus === 404 || retryCount >= retries) {
            return {
              id,
              type: "http_error",
              status: responseStatus,
              bodyText,
            };
          }

          const delayMs = 1000 * (2 ** retryCount);
          retryCount += 1;
          stderr.write(formatRetryMessage(id, responseStatus, bodyText, retryCount, retries, delayMs));

          const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
          if (!shouldContinue) {
            return {
              id,
              type: "shutdown_abort",
            };
          }

          continue;
        }

        try {
          payload = parseDriverPayloadText(bodyText);
        } catch (error) {
          const reason = `invalid JSON (${error.message})`;
          if (retryCount >= retries) {
            return {
              id,
              type: "invalid_json",
              bodyText,
              reason,
            };
          }

          const delayMs = 1000 * (2 ** retryCount);
          retryCount += 1;
          stderr.write(formatUnexpectedBodyRetryMessage(id, reason, bodyText, retryCount, retries, delayMs));

          const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
          if (!shouldContinue) {
            return {
              id,
              type: "shutdown_abort",
            };
          }

          continue;
        }
      }

      const classification = classifyPayload(payload);
      if (classification.kind === "unexpected") {
        if (retryCount >= retries) {
          return {
            id,
            type: "unexpected_body",
            bodyText,
            reason: classification.reason,
          };
        }

        const delayMs = 1000 * (2 ** retryCount);
        retryCount += 1;
        stderr.write(formatUnexpectedBodyRetryMessage(id, classification.reason, bodyText, retryCount, retries, delayMs));

        const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
        if (!shouldContinue) {
          return {
            id,
            type: "shutdown_abort",
          };
        }

        continue;
      }

      if (classification.kind === "found") {
        try {
          const extractedDriver = extractFoundDriver(payload);
          return {
            id,
            type: "found",
            bodyText,
            extractedDriver,
          };
        } catch (error) {
          if (retryCount >= retries) {
            return {
              id,
              type: "unexpected_body",
              bodyText,
              reason: error.message,
            };
          }

          const delayMs = 1000 * (2 ** retryCount);
          retryCount += 1;
          stderr.write(formatUnexpectedBodyRetryMessage(id, error.message, bodyText, retryCount, retries, delayMs));

          const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
          if (!shouldContinue) {
            return {
              id,
              type: "shutdown_abort",
            };
          }

          continue;
        }
      }

      return {
        id,
        type: "not_found",
      };
    } catch (error) {
      if (timedOut) {
        if (retryCount >= retries) {
          return {
            id,
            type: "request_timeout",
            timeoutMs,
          };
        }

        const delayMs = 1000 * (2 ** retryCount);
        retryCount += 1;
        stderr.write(formatTimeoutRetryMessage(id, timeoutMs, retryCount, retries, delayMs));

        const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
        if (!shouldContinue) {
          return {
            id,
            type: "shutdown_abort",
          };
        }

        continue;
      }

      if (isAbortError(error)) {
        return {
          id,
          type: runtimeControl.shutdownRequested ? "shutdown_abort" : "cancelled",
        };
      }

      return {
        id,
        type: "request_failed",
        error,
      };
    } finally {
      clearTimeout(timeoutHandle);
      runtimeControl.clearActiveAbortController(abortController);
    }
  }

  return {
    id,
    type: "shutdown_abort",
  };
}

async function fetchLookupOutcome({
  definition,
  requestUrl,
  fetchImpl,
  runtimeControl,
  retries,
  timeoutMs,
  sleepImpl,
  stderr,
}) {
  let retryCount = 0;

  while (!runtimeControl.shutdownRequested) {
    const abortController = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    runtimeControl.setActiveAbortController(abortController);

    try {
      const response = await fetchImpl(requestUrl, {
        signal: abortController.signal,
      });
      const bodyText = await response.text();

      if (response.status !== 200) {
        if (retryCount >= retries) {
          return {
            type: "http_error",
            status: response.status,
            bodyText,
          };
        }

        const delayMs = 1000 * (2 ** retryCount);
        retryCount += 1;
        stderr.write(formatLookupHardFailureMessage(definition.typeId, response.status, bodyText));
        stderr.write(formatLookupRetryMessage(definition.typeId, `returned HTTP ${response.status}`, retryCount, retries, delayMs));

        const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
        if (!shouldContinue) {
          return {
            type: "shutdown_abort",
          };
        }

        continue;
      }

      try {
        const entries = parseLookupValueSearchXml(bodyText, definition.typeId);
        return {
          type: "lookup_values",
          bodyText,
          entries,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (retryCount >= retries) {
          return {
            type: "unexpected_body",
            bodyText,
            reason,
          };
        }

        const delayMs = 1000 * (2 ** retryCount);
        retryCount += 1;
        stderr.write(formatLookupUnexpectedBodyMessage(definition.typeId, reason, bodyText));
        stderr.write(formatLookupRetryMessage(definition.typeId, "had an unexpected body", retryCount, retries, delayMs));

        const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
        if (!shouldContinue) {
          return {
            type: "shutdown_abort",
          };
        }

        continue;
      }
    } catch (error) {
      if (timedOut) {
        if (retryCount >= retries) {
          return {
            type: "request_timeout",
            timeoutMs,
          };
        }

        const delayMs = 1000 * (2 ** retryCount);
        retryCount += 1;
        stderr.write(formatLookupTimeoutMessage(definition.typeId, timeoutMs));
        stderr.write(formatLookupRetryMessage(definition.typeId, "timed out", retryCount, retries, delayMs));

        const shouldContinue = await sleepBeforeRetry(delayMs, runtimeControl, sleepImpl);
        if (!shouldContinue) {
          return {
            type: "shutdown_abort",
          };
        }

        continue;
      }

      if (isAbortError(error)) {
        return {
          type: runtimeControl.shutdownRequested ? "shutdown_abort" : "cancelled",
        };
      }

      return {
        type: "request_failed",
        error,
      };
    } finally {
      clearTimeout(timeoutHandle);
      runtimeControl.clearActiveAbortController(abortController);
    }
  }

  return {
    type: "shutdown_abort",
  };
}

async function refreshLookupValues(options = {}) {
  const repository = options.repository;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleepImpl = options.sleepImpl || defaultSleepImpl;
  const stderr = options.stderr || process.stderr;
  const runtimeControl = options.runtimeControl || createRuntimeControl();
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const changedTypes = [];
  const checkedTypes = [];

  if (!repository || typeof repository.replaceLookupValues !== "function") {
    throw new Error("A SQLite repository is required to refresh NVIDIA lookup values");
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }

  for (const definition of LOOKUP_TYPE_DEFINITIONS) {
    if (runtimeControl.shutdownRequested) {
      return {
        exitCode: 130,
        reason: "sigint",
        changedTypes,
        checkedTypes,
      };
    }

    const url = buildLookupValueSearchUrl(definition.typeId);
    const outcome = await fetchLookupOutcome({
      definition,
      requestUrl: url,
      fetchImpl,
      runtimeControl,
      retries,
      timeoutMs,
      sleepImpl,
      stderr,
    });

    if (outcome.type === "shutdown_abort" || outcome.type === "cancelled") {
      return {
        exitCode: 130,
        reason: "sigint",
        changedTypes,
        checkedTypes,
      };
    }

    if (outcome.type === "request_failed") {
      stderr.write(`Request failed for NVIDIA lookup TypeID ${definition.typeId}\n${stringifyError(outcome.error)}\n`);
      return {
        exitCode: 1,
        reason: "lookup_request_failed",
        changedTypes,
        checkedTypes,
      };
    }

    if (outcome.type === "request_timeout") {
      stderr.write(formatLookupTimeoutMessage(definition.typeId, outcome.timeoutMs));
      return {
        exitCode: 1,
        reason: "lookup_request_timeout",
        changedTypes,
        checkedTypes,
      };
    }

    if (outcome.type === "http_error") {
      stderr.write(formatLookupHardFailureMessage(definition.typeId, outcome.status, outcome.bodyText));
      return {
        exitCode: 1,
        reason: "lookup_unexpected_http_status",
        changedTypes,
        checkedTypes,
      };
    }

    if (outcome.type === "unexpected_body") {
      stderr.write(formatLookupUnexpectedBodyMessage(definition.typeId, outcome.reason, outcome.bodyText));
      return {
        exitCode: 1,
        reason: "lookup_unexpected_response_body",
        changedTypes,
        checkedTypes,
      };
    }

    if (outcome.type !== "lookup_values") {
      throw new Error(`Unhandled NVIDIA lookup result type: ${outcome.type}`);
    }

    const checkedAt = new Date().toISOString();
    const contentHash = hashLookupEntries(outcome.entries);
    const updateResult = repository.replaceLookupValues(
      definition,
      url,
      contentHash,
      outcome.entries,
      checkedAt
    );

    if (updateResult.skippedCoverageRegression) {
      stderr.write(
        `Preserving existing NVIDIA lookup TypeID ${definition.typeId} ${definition.lookupName} snapshot; ` +
<<<<<<< Updated upstream
        `candidate coverage would regress from ${updateResult.retainedCoverageCount}/${updateResult.totalFoundProductCount} ` +
        `to ${updateResult.candidateCoverageCount}/${updateResult.totalFoundProductCount} found product names.\n`
      );
=======
        `candidate coverage would regress from ${updateResult.retainedCoverageCount}/${updateResult.totalReferencedCount} ` +
        `to ${updateResult.candidateCoverageCount}/${updateResult.totalReferencedCount} ${updateResult.coverageLabel}.\n`
      );
      for (const line of formatLookupDiffDiagnostics(updateResult)) {
        stderr.write(`${line}\n`);
      }
>>>>>>> Stashed changes
    }

    checkedTypes.push({
      typeId: definition.typeId,
      lookupName: definition.lookupName,
      entryCount: updateResult.entryCount,
      changed: updateResult.changed,
    });

    if (updateResult.changed) {
      changedTypes.push({
        typeId: definition.typeId,
        lookupName: definition.lookupName,
        entryCount: updateResult.entryCount,
      });
      for (const line of formatLookupDiffDiagnostics(updateResult)) {
        stderr.write(`${line}\n`);
      }
    }
  }

  repository.setStateEntries({
    last_lookup_refresh_at: new Date().toISOString(),
  });

  return {
    exitCode: 0,
    reason: changedTypes.length > 0 ? "lookup_values_updated" : "lookup_values_unchanged",
    changedTypes,
    checkedTypes,
  };
}

async function crawlDatabase(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const paths = getPaths(rootDir, options.dataDirName);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleepImpl = options.sleepImpl || defaultSleepImpl;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const runtimeControl = options.runtimeControl || createRuntimeControl();
  const maxTrailingNotFound = options.maxTrailingNotFound || DEFAULT_MAX_TRAILING_NOT_FOUND;
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }

  if (!Number.isInteger(maxTrailingNotFound) || maxTrailingNotFound <= 0) {
    throw new Error("maxTrailingNotFound must be a positive integer");
  }

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("concurrency must be a positive integer");
  }

  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error("retries must be a non-negative integer");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer");
  }

  const repository = await openRepository(rootDir, options.dataDirName);

  const withContentChanged = (result) => ({
    ...result,
    contentChanged: repository.hasContentChanges(),
  });

  try {
    if (options.prepopulateNotFoundIdsFile) {
      const { ids: seededNotFoundIds, resolvedPath } = await loadNotFoundIdsFile(rootDir, options.prepopulateNotFoundIdsFile);
      if (seededNotFoundIds.length > 0) {
        const seededAt = new Date().toISOString();
        repository.promoteConfirmedNotFound(seededNotFoundIds, seededAt);
        repository.setStateEntries({
          last_stop_reason: "seeded_confirmed_not_found_from_file",
          last_processed_id: "",
          last_run_at: seededAt,
          max_trailing_not_found: String(maxTrailingNotFound),
        });
        stdout.write(`seeded ${seededNotFoundIds.length} confirmed-not-found IDs from ${resolvedPath}\n`);
      }
    }

    if (options.refreshLookups !== false) {
      const lookupRefreshResult = await refreshLookupValues({
        repository,
        fetchImpl,
        sleepImpl,
        stderr,
        runtimeControl,
        retries,
        timeoutMs,
      });

      lookupRefreshResult.changedTypes.forEach((lookup) => {
        stdout.write(`lookup TypeID ${lookup.typeId} ${lookup.lookupName} updated ${lookup.entryCount} values\n`);
      });

      if (lookupRefreshResult.exitCode !== 0) {
        repository.writeStopState(lookupRefreshResult.reason, "", maxTrailingNotFound);
        return withContentChanged(lookupRefreshResult);
      }
    }

    const knownStatuses = new Map(
      repository.listDriverStatuses(MIN_DRIVER_ID).map((row) => [Number(row.id), row.status])
    );
    const findNextCrawlableId = (startId) => {
      let nextId = Math.max(Number(startId), MIN_DRIVER_ID);

      while (true) {
        const status = knownStatuses.get(nextId);
        if (!status || status === "pending_frontier") {
          return nextId;
        }

        nextId += 1;
      }
    };
    const markStatus = (id, status) => {
      knownStatuses.set(Number(id), status);
    };

    let nextScheduledId = findNextCrawlableId(MIN_DRIVER_ID);
    let nextIdToProcess = nextScheduledId;
    let consecutiveMissingIds = [];
    let stopResult = null;
    const bufferedResults = new Map();

    function finalizeStop(result) {
      if (!stopResult) {
        stopResult = result;
      }
      return stopResult;
    }

    async function processBufferedResults() {
      while (!stopResult && bufferedResults.has(nextIdToProcess)) {
        const result = bufferedResults.get(nextIdToProcess);
        bufferedResults.delete(nextIdToProcess);
        const id = String(result.id);

        if (result.type === "cancelled") {
          nextIdToProcess = findNextCrawlableId(Number(id) + 1);
          continue;
        }

        if (result.type === "shutdown_abort") {
          repository.writeStopState("sigint", id, maxTrailingNotFound);
          finalizeStop({
            exitCode: 130,
            reason: "sigint",
          });
          runtimeControl.abortActiveRequests();
          break;
        }

        if (result.type === "request_failed") {
          stderr.write(`Request failed for driver ID ${id}\n${stringifyError(result.error)}\n`);
          repository.writeStopState("request_failed", id, maxTrailingNotFound);
          finalizeStop({
            exitCode: 1,
            reason: "request_failed",
          });
          runtimeControl.abortActiveRequests();
          break;
        }

        if (result.type === "request_timeout") {
          stderr.write(formatTimeoutMessage(id, result.timeoutMs));
          repository.writeStopState("request_timeout", id, maxTrailingNotFound);
          finalizeStop({
            exitCode: 1,
            reason: "request_timeout",
          });
          runtimeControl.abortActiveRequests();
          break;
        }

        if (result.type === "http_error") {
          stderr.write(formatHardFailureMessage(result.status, result.bodyText));
          repository.writeStopState("unexpected_http_status", id, maxTrailingNotFound);
          finalizeStop({
            exitCode: 1,
            reason: "unexpected_http_status",
          });
          runtimeControl.abortActiveRequests();
          break;
        }

        if (result.type === "invalid_json" || result.type === "unexpected_body") {
          stderr.write(formatUnexpectedBodyMessage(result.reason, result.bodyText));
          repository.writeStopState("unexpected_response_body", id, maxTrailingNotFound);
          finalizeStop({
            exitCode: 1,
            reason: "unexpected_response_body",
          });
          runtimeControl.abortActiveRequests();
          break;
        }

        if (result.type === "found") {
          const checkedAt = new Date().toISOString();
          try {
            await persistRawPayload(paths, id, result.bodyText);
            repository.persistFound(
              result.extractedDriver.summaryRecord,
              JSON.stringify(result.extractedDriver.extraFields),
              checkedAt
            );
          } catch (error) {
            stderr.write(`Failed to persist found driver ID ${id}\n${stringifyError(error)}\n`);
            repository.writeStopState("persist_found_failed", id, maxTrailingNotFound);
            finalizeStop({
              exitCode: 1,
              reason: "persist_found_failed",
            });
            runtimeControl.abortActiveRequests();
            break;
          }

          markStatus(id, "found");

          if (consecutiveMissingIds.length > 0) {
            repository.promoteConfirmedNotFound(consecutiveMissingIds, checkedAt);
            consecutiveMissingIds.forEach((missingId) => {
              markStatus(missingId, "confirmed_not_found");
            });
            consecutiveMissingIds = [];
          }

          stdout.write(`found ${id}${result.extractedDriver.summaryRecord.version ? ` version ${result.extractedDriver.summaryRecord.version}` : ""}\n`);
          nextIdToProcess = findNextCrawlableId(Number(id) + 1);
          continue;
        }

        if (result.type === "not_found") {
          const checkedAt = new Date().toISOString();
          repository.persistPendingFrontier(id, checkedAt);
          markStatus(id, "pending_frontier");
          consecutiveMissingIds.push(id);
          stdout.write(`not-found ${id}\n`);

          if (consecutiveMissingIds.length >= maxTrailingNotFound) {
            repository.writeStopState("max_trailing_not_found_reached", id, maxTrailingNotFound);
            stdout.write(`stop after ${maxTrailingNotFound} consecutive semantic not-found responses\n`);
            finalizeStop({
              exitCode: 0,
              reason: "max_trailing_not_found_reached",
            });
            runtimeControl.abortActiveRequests();
            break;
          }

          nextIdToProcess = findNextCrawlableId(Number(id) + 1);
          continue;
        }

        throw new Error(`Unhandled crawl result type: ${result.type}`);
      }
    }

    let resultDrainPromise = Promise.resolve();

    const pool = new PromisePool(() => {
      if (stopResult || runtimeControl.shutdownRequested) {
        return null;
      }

      const id = nextScheduledId;
      nextScheduledId = findNextCrawlableId(id + 1);
      const requestUrl = buildRequestUrl(String(id));

      return fetchDriverOutcome({
        id,
        requestUrl,
        fetchImpl,
        runtimeControl,
        retries,
        timeoutMs,
        sleepImpl,
        stderr,
      }).then((result) => {
        resultDrainPromise = resultDrainPromise.then(async () => {
          bufferedResults.set(result.id, result);
          await processBufferedResults();
        });

        return resultDrainPromise;
      });
    }, concurrency);

    await pool.start();
    await resultDrainPromise;

    if (stopResult) {
      return withContentChanged(stopResult);
    }

    if (runtimeControl.shutdownRequested) {
      repository.writeStopState("sigint", nextIdToProcess, maxTrailingNotFound);
      return withContentChanged({
        exitCode: 130,
        reason: "sigint",
      });
    }

    throw new Error("Crawler finished without a terminal stop condition");
  } finally {
    repository.close();
  }
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}

async function loadNotFoundIdsFile(rootDir, filePath) {
  const resolvedPath = path.resolve(rootDir, filePath);
  const text = await fs.readFile(resolvedPath, "utf8");
  const ids = [];
  const seen = new Set();

  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const parsed = parsePositiveInteger(trimmed, `notFoundIds line ${index + 1}`);
    const normalized = String(parsed);
    if (seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    ids.push(normalized);
  });

  return {
    ids,
    resolvedPath,
  };
}

async function writeChangeStatusFile(rootDir, filePath, changed) {
  const resolvedPath = path.resolve(rootDir, filePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, changed ? "1\n" : "0\n", "utf8");
}

async function loadRawPayloadFiles(rawDirPath) {
  const directoryEntries = await fs.readdir(rawDirPath, { withFileTypes: true });
  return directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && normalizeId(path.basename(entry.name, ".json")))
    .map((entry) => ({
      id: normalizeId(path.basename(entry.name, ".json")),
      path: path.join(rawDirPath, entry.name),
    }))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

async function prepopulateFromDataRawDirectory(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const rawDirPath = path.resolve(rootDir, options.rawDirPath);
  const stdout = options.stdout || process.stdout;
  const repository = await openRepository(rootDir, options.dataDirName);

  try {
    if (options.prepopulateNotFoundIdsFile) {
      const { ids: seededNotFoundIds, resolvedPath } = await loadNotFoundIdsFile(rootDir, options.prepopulateNotFoundIdsFile);
      if (seededNotFoundIds.length > 0) {
        repository.promoteConfirmedNotFound(seededNotFoundIds, new Date().toISOString());
        stdout.write(`seeded ${seededNotFoundIds.length} confirmed-not-found IDs from ${resolvedPath}\n`);
      }
    }

    const files = await loadRawPayloadFiles(rawDirPath);
    let importedCount = 0;

    for (const file of files) {
      const bodyText = await fs.readFile(file.path, "utf8");
      let payload;

      try {
        payload = parseDriverPayloadText(bodyText);
      } catch (error) {
        throw new Error(`Failed to parse raw payload ${file.path}: ${error.message}`);
      }

      const classification = classifyPayload(payload);
      if (classification.kind !== "found") {
        throw new Error(`Raw payload ${file.path} did not contain a successful driver payload`);
      }

      const extractedDriver = extractFoundDriver(payload);
      const checkedAt = new Date().toISOString();
      repository.persistFound(
        extractedDriver.summaryRecord,
        JSON.stringify(extractedDriver.extraFields),
        checkedAt
      );
      importedCount += 1;
    }

    repository.setStateEntries({
      last_stop_reason: "prepopulated_from_data_raw",
      last_processed_id: "",
      last_run_at: new Date().toISOString(),
    });

    stdout.write(`prepopulated ${importedCount} found driver rows from ${rawDirPath}\n`);
    return {
      exitCode: 0,
      contentChanged: repository.hasContentChanges(),
      importedCount,
      rawDirPath,
    };
  } finally {
    repository.close();
  }
}

function parseCrawlArgs(argv) {
  let maxTrailingNotFound = DEFAULT_MAX_TRAILING_NOT_FOUND;
  let concurrency = DEFAULT_CONCURRENCY;
  let retries = DEFAULT_RETRIES;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let prepopulateNotFoundIdsFile = null;
  let prepopulateFromDataRawDir = null;
  let writeChangeStatusFile = null;
  let positionalMaxTrailingNotFound = null;
  let sawNamedMaxTrailingNotFound = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--max-trailing-not-found") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --max-trailing-not-found");
      }

      if (positionalMaxTrailingNotFound !== null || sawNamedMaxTrailingNotFound) {
        throw new Error("maxTrailingNotFound can only be specified once");
      }

      maxTrailingNotFound = parsePositiveInteger(value, "maxTrailingNotFound");
      sawNamedMaxTrailingNotFound = true;
      index += 1;
      continue;
    }

    if (arg === "--concurrency") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --concurrency");
      }

      concurrency = parsePositiveInteger(value, "concurrency");
      index += 1;
      continue;
    }

    if (arg === "--retries") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --retries");
      }

      retries = parseNonNegativeInteger(value, "retries");
      index += 1;
      continue;
    }

    if (arg === "--timeout") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --timeout");
      }

      timeoutMs = Math.round(parsePositiveNumber(value, "timeout") * 1000);
      index += 1;
      continue;
    }

    if (arg === "--prepopulate-notfoundids") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --prepopulate-notfoundids");
      }

      prepopulateNotFoundIdsFile = value;
      index += 1;
      continue;
    }

    if (arg === "--prepopulate-from-data-raw") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --prepopulate-from-data-raw");
      }

      prepopulateFromDataRawDir = value;
      index += 1;
      continue;
    }

    if (arg === "--write-change-status") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --write-change-status");
      }

      writeChangeStatusFile = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown crawl flag: ${arg}`);
    }

    if (positionalMaxTrailingNotFound !== null) {
      throw new Error("Only one positional maxTrailingNotFound value is allowed");
    }

    if (sawNamedMaxTrailingNotFound) {
      throw new Error("maxTrailingNotFound can only be specified once");
    }

    positionalMaxTrailingNotFound = parsePositiveInteger(arg, "maxTrailingNotFound");
  }

  if (positionalMaxTrailingNotFound !== null) {
    maxTrailingNotFound = positionalMaxTrailingNotFound;
  }

  return {
    maxTrailingNotFound,
    concurrency,
    retries,
    timeoutMs,
    prepopulateNotFoundIdsFile,
    prepopulateFromDataRawDir,
    writeChangeStatusFile,
  };
}

function parseStatsArgs(argv) {
  let topGaps = 5;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--top-gaps") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --top-gaps");
      }

      topGaps = parsePositiveInteger(value, "topGaps");
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown stats flag: ${arg}`);
    }

    throw new Error(`Unexpected stats argument: ${arg}`);
  }

  return {
    topGaps,
  };
}

function parseBuildBrowserDbArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("-")) {
      throw new Error(`Unknown buildbrowserdb flag: ${arg}`);
    }

    throw new Error(`Unexpected buildbrowserdb argument: ${arg}`);
  }

  return {};
}

function hasHelpFlag(argv) {
  return argv.some((arg) => HELP_FLAGS.has(arg));
}

function shouldPrintUsageForError(error) {
  const message = error && error.message ? String(error.message) : "";
  if (!message) {
    return false;
  }

  return (
    /^Missing value for /.test(message) ||
    /^Unknown (crawl|stats|buildbrowserdb|query) flag: /.test(message) ||
    /^Unexpected (stats|buildbrowserdb) argument: /.test(message) ||
    /^Only one positional maxTrailingNotFound value is allowed$/.test(message) ||
    /^maxTrailingNotFound can only be specified once$/.test(message) ||
    /^.+ must be a positive integer$/.test(message) ||
    /^.+ must be a positive number$/.test(message) ||
    /^.+ must be a non-negative integer$/.test(message)
  );
}

function formatOptionLine(flag, description, width = 33) {
  const paddedFlag = flag.padEnd(width, " ");
  return `  ${paddedFlag}${description}`;
}

async function usageText(mode = "all") {
  const browserQueryModule = await loadBrowserQueryModule();
  const queryFlagDefinitions = browserQueryModule.getQueryFlagDefinitions();
  const lines = ["Usage:"];

  if (mode === "all" || mode === "crawl") {
    lines.push("  node app.js [--max-trailing-not-found <n>] [--concurrency <n>] [--retries <n>] [--timeout <seconds>] [--prepopulate-notfoundids <file>] [--prepopulate-from-data-raw <dir>]");
    lines.push("  node app.js [maxTrailingNotFound]");
    lines.push("");
    lines.push("Crawl options:");
    lines.push("  The crawler refreshes NVIDIA lookup TypeIDs 1-5 before downloading driver records.");
    lines.push(formatOptionLine("--max-trailing-not-found <n>", `Stop after <n> trailing semantic not-found responses (default: ${DEFAULT_MAX_TRAILING_NOT_FOUND}).`));
    lines.push(formatOptionLine("--concurrency <n>", `Keep <n> requests in flight while still processing IDs in ascending order (default: ${DEFAULT_CONCURRENCY}).`));
    lines.push(formatOptionLine("--retries <n>", `Retry HTTP errors except 404, plus unexpected 200 bodies, up to <n> times with 1,2,4... second backoff (default: ${DEFAULT_RETRIES}). HTTP 404 still fails immediately.`));
    lines.push(formatOptionLine("--timeout <seconds>", `Abort and retry a request once it runs longer than <seconds> (default: ${formatDurationMs(DEFAULT_TIMEOUT_MS)}).`));
    lines.push(formatOptionLine("--prepopulate-notfoundids <file>", "Preseed confirmed-not-found IDs from a newline-separated file before crawling."));
    lines.push(formatOptionLine("--prepopulate-from-data-raw <dir>", "Import found driver rows from a data-raw directory and exit without crawling."));
    lines.push(formatOptionLine("--write-change-status <file>", "Write 1 when driver or lookup content changed, otherwise 0, after crawl/prepopulate completes."));
    lines.push(formatOptionLine("-h, --help", "Show this help text."));
  }

  if (mode === "all" || mode === "buildbrowserdb") {
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }

    lines.push("  node app.js buildbrowserdb [--help]");
    lines.push("");
    lines.push("Browser DB options:");
    lines.push(formatOptionLine("--help", "Show buildbrowserdb help."));
    lines.push("  Rebuilds data/browser.sqlite from data/nvidia-driver-database.sqlite,");
    lines.push("  writes data/browser.sqlite.gz and data/browser.sqlite.meta.json beside it,");
    lines.push("  and exits.");
  }

  if (mode === "all" || mode === "stats") {
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }

    lines.push("  node app.js stats [--top-gaps <n>] [--help]");
    lines.push("");
    lines.push("Stats options:");
    lines.push(formatOptionLine("--top-gaps <n>", "Include the top <n> confirmed not-found gaps in the output (default: 5)."));
    lines.push(formatOptionLine("-h, --help", "Show stats help."));
  }

  if (mode === "all" || mode === "query") {
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }

    lines.push(`  node app.js query ${browserQueryModule.getQueryUsageFragment()} [--help]`);
    lines.push("");
    lines.push("Query options:");
    for (const definition of queryFlagDefinitions) {
      lines.push(formatOptionLine(`${definition.flag} <${definition.valueLabel}>`, definition.description));
    }
    lines.push(formatOptionLine("-h, --help", "Show query help."));
  }

  return lines.join("\n");
}

async function queryDatabase(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const stdout = options.stdout || process.stdout;
  const repository = await openRepository(rootDir, options.dataDirName);

  try {
    const filters = options.filters || {};
    const records = repository.queryDrivers(filters);
    stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return {
      exitCode: 0,
      count: records.length,
    };
  } finally {
    repository.close();
  }
}

async function statsDatabase(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const stdout = options.stdout || process.stdout;
  const repository = await openRepository(rootDir, options.dataDirName);

  try {
    const topGaps = options.topGaps || 5;
    const stats = repository.getStats(topGaps);
    stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return {
      exitCode: 0,
      stats,
    };
  } finally {
    repository.close();
  }
}

async function runCli(argv, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  try {
    if (argv.length > 0 && argv[0] === "stats") {
      if (hasHelpFlag(argv.slice(1))) {
        stdout.write(`${await usageText("stats")}\n`);
        return 0;
      }

      const { topGaps } = parseStatsArgs(argv.slice(1));
      return (await statsDatabase({
        ...options,
        rootDir,
        stdout,
        topGaps,
      })).exitCode;
    }

    if (argv.length > 0 && argv[0] === "buildbrowserdb") {
      if (hasHelpFlag(argv.slice(1))) {
        stdout.write(`${await usageText("buildbrowserdb")}\n`);
        return 0;
      }

      parseBuildBrowserDbArgs(argv.slice(1));
      return (await buildBrowserDatabase({
        ...options,
        rootDir,
        stdout,
      })).exitCode;
    }

    if (argv.length > 0 && argv[0] === "query") {
      if (hasHelpFlag(argv.slice(1))) {
        stdout.write(`${await usageText("query")}\n`);
        return 0;
      }

      const browserQueryModule = await loadBrowserQueryModule();
      const filters = browserQueryModule.parseQueryFilters(argv.slice(1));
      return (await queryDatabase({
        ...options,
        rootDir,
        filters,
        stdout,
      })).exitCode;
    }

    if (hasHelpFlag(argv)) {
      stdout.write(`${await usageText("all")}\n`);
      return 0;
    }

    const {
      maxTrailingNotFound,
      concurrency,
      retries,
      timeoutMs,
      prepopulateNotFoundIdsFile,
      prepopulateFromDataRawDir,
      writeChangeStatusFile: changeStatusFile,
    } = parseCrawlArgs(argv);

    if (prepopulateFromDataRawDir) {
      const result = await prepopulateFromDataRawDirectory({
        ...options,
        rootDir,
        stdout,
        rawDirPath: prepopulateFromDataRawDir,
        prepopulateNotFoundIdsFile,
      });
      if (changeStatusFile) {
        await writeChangeStatusFile(rootDir, changeStatusFile, result.contentChanged);
      }
      return result.exitCode;
    }

    const result = await crawlDatabase({
      ...options,
      rootDir,
      stdout,
      stderr,
      maxTrailingNotFound,
      concurrency,
      retries,
      timeoutMs,
      prepopulateNotFoundIdsFile,
    });
    if (changeStatusFile) {
      await writeChangeStatusFile(rootDir, changeStatusFile, result.contentChanged);
    }
    return result.exitCode;
  } catch (error) {
    const usageMode = argv.length > 0 && argv[0] === "query"
      ? "query"
      : argv.length > 0 && argv[0] === "buildbrowserdb"
        ? "buildbrowserdb"
        : argv.length > 0 && argv[0] === "stats"
        ? "stats"
        : "all";
    if (shouldPrintUsageForError(error)) {
      stderr.write(`${error.message}\n${await usageText(usageMode)}\n`);
    } else {
      stderr.write(`${error.message}\n`);
    }
    return 1;
  }
}

module.exports = {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_TRAILING_NOT_FOUND,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  LOOKUP_TYPE_DEFINITIONS,
  MIN_DRIVER_ID,
  buildRequestUrl,
  buildLookupValueSearchUrl,
  buildBrowserDatabase,
  buildSummaryRecord,
  classifyPayload,
  createRuntimeControl,
  crawlDatabase,
  getPaths,
  loadBrowserQueryModule,
  openRepository,
  parseCrawlArgs,
  parseBuildBrowserDbArgs,
  parseLookupValueSearchXml,
  parseStatsArgs,
  queryDatabase,
  refreshLookupValues,
  runCli,
  safeDecode,
  statsDatabase,
};
