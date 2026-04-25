import fs from 'node:fs';
import path from 'node:path';
import type { Connect } from 'vite';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';

const databaseRequestPath = '/database/browser.sqlite.gz';
const databaseMetadataRequestPath = '/database/browser.sqlite.meta.json';
const localDatabaseGzipFile = path.resolve(import.meta.dirname, '..', 'data', 'browser.sqlite.gz');
const localDatabaseMetadataFile = path.resolve(import.meta.dirname, '..', 'data', 'browser.sqlite.meta.json');

function createDatabaseMiddleware(): Connect.NextHandleFunction {
	return (req, res, next) => {
		const url = req.url ? new URL(req.url, 'http://localhost') : null;
		if (!url || (url.pathname !== databaseRequestPath && url.pathname !== databaseMetadataRequestPath)) {
			next();
			return;
		}

		const targetPath =
			url.pathname === databaseMetadataRequestPath ? localDatabaseMetadataFile : localDatabaseGzipFile;
		const contentType =
			url.pathname === databaseMetadataRequestPath
				? 'application/json; charset=utf-8'
				: 'application/gzip';
		const missingPath =
			url.pathname === databaseMetadataRequestPath ? localDatabaseMetadataFile : localDatabaseGzipFile;

		if (!fs.existsSync(targetPath)) {
			res.statusCode = 404;
			res.setHeader('Content-Type', 'text/plain; charset=utf-8');
			res.end(
				`Local browser database artifact not found at ${missingPath}. Run the crawler, then node app.js buildbrowserdb.`
			);
			return;
		}

		const stat = fs.statSync(targetPath);

		res.statusCode = 200;
		res.setHeader('Content-Type', contentType);
		res.setHeader('Content-Length', String(stat.size));
		res.setHeader('Cache-Control', 'no-store');
		fs.createReadStream(targetPath).pipe(res);
	};
}

function serveLocalDatabasePlugin() {
	return {
		name: 'serve-local-sqlite-database',
		configureServer(server: { middlewares: Connect.Server }) {
			server.middlewares.use(createDatabaseMiddleware());
		},
		configurePreviewServer(server: { middlewares: Connect.Server }) {
			server.middlewares.use(createDatabaseMiddleware());
		}
	};
}

export default defineConfig({
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm']
	},
	plugins: [serveLocalDatabasePlugin(), sveltekit()]
});
