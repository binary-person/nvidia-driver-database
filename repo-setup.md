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

## Daily crawl and release setup

The repo includes a daily automation script:

```sh
./daily.sh
```

That script currently does all of the following:

- runs `node app.js --concurrency 2 --write-change-status data/.daily-change-status`
- skips the expensive follow-up steps entirely when the crawl made no real driver or lookup content changes
- rebuilds `data/browser.sqlite`
- rewrites `data/browser.sqlite.gz`
- rewrites `data/browser.sqlite.meta.json`
- writes a compressed master database at `data/nvidia-driver-database.sqlite.gz`
- writes a compressed archive of the raw payload directory at `data/data-raw.tar.gz`

The crawler change-status file is:

```text
data/.daily-change-status
```

Its contents are:

- `1` when the crawl or prepopulate step changed meaningful driver/lookup content
- `0` when the run only touched bookkeeping or rechecked already-known rows

When `./daily.sh` sees `0`, it stops before rebuilding the browser DB and before
any release upload work.

For normal local/manual release publishing, `./daily.sh` also manages the GitHub
release asset upload itself. By default it targets:

- release tag: `database`
- release title: `Database assets`
- repo: `binary-person/nvidia-driver-database`

Those can be overridden with:

```text
GH_RELEASE_TAG
GH_RELEASE_TITLE
GH_REPO
```

The uploaded release assets are:

```text
data/browser.sqlite
data/browser.sqlite.gz
data/browser.sqlite.meta.json
data/nvidia-driver-database.sqlite.gz
data/data-raw.tar.gz
```

Uploads use `gh release upload --clobber`, so same-named assets are replaced in
place on each changed run.

If you want the crawl to keep running in a detached local tmux session, use:

```sh
./run-in-tmux.sh
```

That launcher starts `./daily.sh` in a tmux session and appends output to:

```text
tmux.log
```

with automatic simple log rotation.

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

## Scheduled database publishing

The workflow at `.github/workflows/daily-database.yml` handles the scheduled
database release flow on GitHub Actions:

- runs every day at `23:00 UTC`
- also supports manual `workflow_dispatch`
- only runs on `main`
- uses Node.js `24`
- restores `data/nvidia-driver-database.sqlite` from the previous release's `nvidia-driver-database.sqlite.gz` when available
- restores `data-raw/` from the previous release's `data-raw.tar.gz` when available
- installs root dependencies with `npm ci`
- runs `./daily.sh` with `GH_ACTIONS=1`

In `GH_ACTIONS=1` mode, `./daily.sh` still performs the crawl/build/archive
work, but it intentionally skips all `gh release` commands. The workflow then:

- reads `data/.daily-change-status`
- skips release work entirely when the value is `0`
- ensures the `database` release exists when the value is `1`
- uploads the database assets with `--clobber`

## Out of scope

This workflow does not publish the SQLite database itself. Public database asset publishing is handled separately by `./daily.sh` on another machine
