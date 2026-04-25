# Repo Setup

## Prerequisites

- Node.js 20 or newer
- npm
- A generated master crawler database at `data/nvidia-driver-database.sqlite`

## Root crawler setup

Install the root dependencies:

```sh
npm install
```

Generate or update the SQLite database with the crawler:

```sh
node app.js
```

Build the derived browser database:

```sh
node app.js buildbrowserdb
```

That build also emits:

```text
data/browser.sqlite.gz
data/browser.sqlite.meta.json
```

The metadata sidecar includes the exact uncompressed browser DB size,
compressed size, SHA-256 hash, and build timestamp.

At startup, the crawler refreshes NVIDIA search lookup TypeIDs `1` through `5`
into SQLite before it starts downloading driver IDs. These lookup tables preserve
the product type -> series -> product parent chain plus OS and language values.

Useful crawler options are available through:

```sh
node app.js --help
```

The crawler writes the master database to:

```text
data/nvidia-driver-database.sqlite
```

The frontend expects the derived browser database at:

```text
data/browser.sqlite
```

the compressed browser artifact at:

```text
data/browser.sqlite.gz
```

and its metadata sidecar at:

```text
data/browser.sqlite.meta.json
```

Successful driver payloads are also archived verbatim at:

```text
data-raw/<id>.json
```

Those files are archival only. The app and frontend do not query them during
normal operation; they exist so the SQLite database can be rebuilt later
without recrawling NVIDIA.

If the browser DB artifacts do not exist, the local frontend will show an in-app
error telling you to run the crawler first and then `node app.js buildbrowserdb`.

## Frontend setup

Install the frontend dependencies:

```sh
npm --prefix frontend install
```

Start the local frontend:

```sh
npm --prefix frontend run dev
```

On each load, the browser frontend fetches `browser.sqlite.gz`, fetches
`browser.sqlite.meta.json`, preallocates one in-memory SQLite WASM buffer from
the metadata's uncompressed size, streams gunzip directly into that buffer, and
then queries the in-memory database from a worker. For a large database, that
initial load can take a while and uses a meaningful amount of RAM.

Run the frontend checks:

```sh
npm --prefix frontend run check
npm --prefix frontend run test
```

Build the static frontend locally:

```sh
npm --prefix frontend run build
```

Build the static frontend with the GitHub Pages base path:

```sh
GITHUB_PAGES=true npm --prefix frontend run build
```

## Database URL behavior

The browser frontend resolves the database automatically from the current host:

- `localhost`, `127.0.0.1`, `[::1]`, and `0.0.0.0` load `/database/browser.sqlite.gz` plus `/database/browser.sqlite.meta.json`
- all other hosts load `https://github-releases-proxy.binary-person.workers.dev/nvidia-driver-database/database/browser.sqlite.gz` plus `https://github-releases-proxy.binary-person.workers.dev/nvidia-driver-database/database/browser.sqlite.meta.json`

For local development and local preview, Vite serves the repo browser database artifacts directly from:

```text
data/browser.sqlite.gz
data/browser.sqlite.meta.json
```

Use the in-app `Reload database` action when you want to force a fresh refetch
from the current source URL.

## Browser support

The large-database frontend depends on:

- streamed `fetch()` response bodies
- `DecompressionStream('gzip')`
- SQLite WASM running in a worker

Use a current Chromium, Firefox, or Safari release with support for those
features. If streamed gzip decompression is unavailable, the app will show an
in-app error instead of attempting a larger fallback load path.

## GitHub Pages deployment

The workflow at `.github/workflows/deploy-frontend.yml`:

- runs on pushes to `main`
- installs frontend dependencies with `npm ci`
- runs `npm --prefix frontend run check`
- runs `npm --prefix frontend run test`
- builds the static SvelteKit app with `GITHUB_PAGES=true`
- writes `frontend/build/.nojekyll`
- deploys `frontend/build` to the `gh-pages` branch root

## Out of scope

This workflow does not publish the SQLite database itself. Public database asset publishing is handled separately by `./daily.sh` on another machine
