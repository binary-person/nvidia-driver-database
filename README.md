# nvidia-driver-database

https://binary-person.github.io/nvidia-driver-database/

Nvidia driver data is crawled daily by GitHub Actions cronjob

## Repo information

This repo has two pieces:

- a Node.js crawler in the repo root that builds the master database at `data/nvidia-driver-database.sqlite`
- a static SvelteKit frontend in `frontend/` that fetches the derived browser database as `data/browser.sqlite.gz`, streams it into a single in-memory SQLite WASM buffer, and queries it in a worker

The crawler also writes archival copies of successful NVIDIA payloads to
`data-raw/<id>.json`. Those files are not part of normal runtime querying; they
exist only so the SQLite database can be rebuilt or migrated later without
recrawling NVIDIA.

The crawler also keeps NVIDIA's lookup tables for product type, series, product,
OS, and language in SQLite so the search hierarchy is queryable.

The browser database is rebuilt from the master database with:

```sh
node app.js buildbrowserdb
```

That command also writes:

- `data/browser.sqlite.gz`
- `data/browser.sqlite.meta.json`

The metadata sidecar contains the browser DB's exact uncompressed size,
compressed size, SHA-256 hash, and build timestamp for the frontend loader.

The static frontend is built for GitHub Pages and reads the public database
through the release proxy URL.

Quick start:

```sh
npm install
node app.js
node app.js buildbrowserdb
npm --prefix frontend install
npm --prefix frontend run dev
```

The full setup and deployment notes live in [repo-setup.md](repo-setup.md).
