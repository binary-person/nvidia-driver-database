const QUERY_FLAG_DEFINITIONS = Object.freeze([
  { flag: "--version", key: "version", valueLabel: "version", description: "Exact match on driver version." },
  { flag: "--display-version", key: "displayVersion", valueLabel: "displayVersion", description: "Exact match on display version." },
  { flag: "--release", key: "release", valueLabel: "release", description: "Exact match on release family." },
  { flag: "--os-code", key: "osCode", valueLabel: "osCode", description: "Exact match on NVIDIA OS code." },
  { flag: "--os-name", key: "osName", valueLabel: "osName", description: "Case-insensitive substring match on OS name." },
  { flag: "--language", key: "languageName", valueLabel: "language", description: "Case-insensitive substring match on language name." },
  { flag: "--is-64-bit", key: "is64Bit", valueLabel: "0|1", description: "Exact match on the 64-bit flag." },
  { flag: "--is-whql", key: "isWHQL", valueLabel: "0|1", description: "Exact match on the WHQL flag." },
  { flag: "--is-recommended", key: "isRecommended", valueLabel: "0|1", description: "Exact match on the recommended flag." },
  { flag: "--is-dc", key: "isDC", valueLabel: "0|1", description: "Exact match on NVIDIA's DCH-package flag." },
  { flag: "--is-crd", key: "isCRD", valueLabel: "0|1", description: "Exact match on NVIDIA's Creator/Studio-driver flag." },
  { flag: "--is-beta", key: "isBeta", valueLabel: "0|1", description: "Exact match on the beta flag." },
  { flag: "--is-feature-preview", key: "isFeaturePreview", valueLabel: "0|1", description: "Exact match on the feature-preview flag." },
  { flag: "--name", key: "name", valueLabel: "driverName", description: "Case-insensitive substring match on driver name." },
  { flag: "--series", key: "series", valueLabel: "seriesName", description: "Case-insensitive substring match on series name." },
  { flag: "--product", key: "product", valueLabel: "productName", description: "Case-insensitive substring match on product name." },
]);

const QUERY_FLAG_TO_KEY = new Map(
  QUERY_FLAG_DEFINITIONS.map((definition) => [definition.flag, definition.key])
);

export function getQueryFlagDefinitions() {
  return QUERY_FLAG_DEFINITIONS;
}

export function getQueryUsageFragment() {
  return QUERY_FLAG_DEFINITIONS
    .map((definition) => `[${definition.flag} <${definition.valueLabel}>]`)
    .join(" ");
}

export function parseQueryFilters(argv) {
  const filters = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = QUERY_FLAG_TO_KEY.get(flag);
    if (!key) {
      throw new Error(`Unknown query flag: ${flag}`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }

    filters[key] = value;
    index += 1;
  }

  return filters;
}
