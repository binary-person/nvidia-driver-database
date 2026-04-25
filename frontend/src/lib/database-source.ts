export const LOCAL_DATABASE_PATH = '/database/browser.sqlite.gz';
export const LOCAL_DATABASE_METADATA_PATH = '/database/browser.sqlite.meta.json';
export const PUBLIC_DATABASE_URL =
	'https://github-releases-proxy.binary-person.workers.dev/nvidia-driver-database/database/browser.sqlite.gz';
export const PUBLIC_DATABASE_METADATA_URL =
	'https://github-releases-proxy.binary-person.workers.dev/nvidia-driver-database/database/browser.sqlite.meta.json';

const LOCAL_HOSTNAMES = new Set(['', 'localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

export interface DatabaseSource {
	compression: 'gzip';
	kind: 'local' | 'public';
	label: string;
	metadataUrl: string;
	url: string;
}

export function isLocalHostname(hostname: string): boolean {
	return LOCAL_HOSTNAMES.has(hostname.trim().toLowerCase());
}

function appendCacheBust(url: string, cacheBustToken?: string | number | null): string {
	if (cacheBustToken === undefined || cacheBustToken === null || cacheBustToken === '') {
		return url;
	}

	const separator = url.includes('?') ? '&' : '?';
	return `${url}${separator}v=${encodeURIComponent(String(cacheBustToken))}`;
}

function normalizeBasePath(basePath: string): string {
	if (!basePath || basePath === '/') {
		return '';
	}

	return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

export function resolveDatabaseSource(options: {
	hostname: string;
	basePath?: string;
	cacheBustToken?: string | number | null;
}): DatabaseSource {
	const basePath = normalizeBasePath(options.basePath ?? '');
	const local = isLocalHostname(options.hostname);
	const url = local
		? appendCacheBust(`${basePath}${LOCAL_DATABASE_PATH}`, options.cacheBustToken)
		: appendCacheBust(PUBLIC_DATABASE_URL, options.cacheBustToken);
	const metadataUrl = local
		? appendCacheBust(`${basePath}${LOCAL_DATABASE_METADATA_PATH}`, options.cacheBustToken)
		: appendCacheBust(PUBLIC_DATABASE_METADATA_URL, options.cacheBustToken);

	return {
		compression: 'gzip',
		kind: local ? 'local' : 'public',
		label: local ? 'Local browser database' : 'Public browser database',
		metadataUrl,
		url
	};
}
