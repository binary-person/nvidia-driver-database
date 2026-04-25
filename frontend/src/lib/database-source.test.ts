import { describe, expect, it } from 'vitest';
import {
	isLocalHostname,
	LOCAL_DATABASE_PATH,
	LOCAL_DATABASE_METADATA_PATH,
	PUBLIC_DATABASE_URL,
	PUBLIC_DATABASE_METADATA_URL,
	resolveDatabaseSource
} from './database-source';

describe('database-source', () => {
	it('treats local development hosts as local database sources', () => {
		expect(isLocalHostname('localhost')).toBe(true);
		expect(isLocalHostname('127.0.0.1')).toBe(true);
		expect(isLocalHostname('[::1]')).toBe(true);
		expect(isLocalHostname('0.0.0.0')).toBe(true);
	});

	it('resolves the local database URL with the current base path', () => {
		const source = resolveDatabaseSource({
			hostname: 'localhost',
			basePath: '/nvidia-driver-database'
		});

		expect(source.kind).toBe('local');
		expect(source.compression).toBe('gzip');
		expect(source.url).toBe(`/nvidia-driver-database${LOCAL_DATABASE_PATH}`);
		expect(source.metadataUrl).toBe(`/nvidia-driver-database${LOCAL_DATABASE_METADATA_PATH}`);
	});

	it('resolves the public proxy URL and appends cache busting when requested', () => {
		const source = resolveDatabaseSource({
			hostname: 'binary-person.github.io',
			basePath: '/nvidia-driver-database',
			cacheBustToken: 123
		});

		expect(source.kind).toBe('public');
		expect(source.compression).toBe('gzip');
		expect(source.url).toBe(`${PUBLIC_DATABASE_URL}?v=123`);
		expect(source.metadataUrl).toBe(`${PUBLIC_DATABASE_METADATA_URL}?v=123`);
	});
});
