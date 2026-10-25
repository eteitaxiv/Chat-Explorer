# AGENTS.md

## Project

Read-only web browser/search for SillyTavern archives (characters + chats). FastAPI backend, vanilla-JS frontend, deployed via Docker. No tests, no linter, no CI exist.

## Commands

```bash
# Production run (mounts ./data read-only; edit the volume path in docker-compose.yml first)
docker compose up -d --build        # serves http://localhost:8000

# Local dev (needs DATA_ROOT pointing at a SillyTavern user data folder)
DATA_ROOT=/path/to/st-data .venv/bin/python -m uvicorn app.main:app --reload --port 8000
```

- `.venv` is Python 3.13 with fastapi/uvicorn/pillow installed. There is no test suite or lint config; verify changes by running the app against a data folder and exercising the API/UI.
- `/api/status` is the health endpoint (also used by the Dockerfile HEALTHCHECK). All other `/api/*` routes return **503 until the background index build finishes** (`require_ready()` in `app/main.py`). The frontend blocks on a progress overlay polling `/api/status`.

## Architecture

Three backend modules, one frontend file:

- `app/stindex.py` - Indexing. `Index.build()` runs in a daemon thread at startup: scans `characters/` (PNG `tEXt` chunks `chara`/`ccv3`, base64 JSON cards; plain `.json` cards too) and `chats/<avatar>/*.jsonl`, computing per-file stats (`chat_stats`). Everything lives in memory (`cards`, `chats`, `avatar_dir` dicts); nothing is persisted and the data root is never written to (hard invariant - the mount is `:ro`).
- `app/search.py` - Search engine. Two-phase: `BytePrefilter` does a raw-byte needle check per file (with JSON-escaped variants), then only passing files are line-parsed and matched on decoded text via `Matcher`. `classify_message()` is the canonical decomposition of an ST message into `(kind, swipe_index, model, text)` pieces with kind in `visible`/`swipe`/`reasoning` - reuse it rather than re-deriving swipe logic. `parse_chat_full()` powers the chat viewer.
- `app/main.py` - FastAPI routes + zip assembly + avatar resizing (Pillow). Static frontend is mounted at `/` **last**; keep the mount after all API route definitions. Also hosts the cleaner routes (`/api/cleaner/*`), gated by `_probe_writable()` - a real create-and-delete probe per chat folder; the mounts may be `:ro` or owned by a uid that doesn't match the container user.
- `app/static/app.js` - Entire SPA: hash-based routing (`parseRoute`/`render`), views rendered by building HTML strings into `#view`. No framework, no build step.

Data flow: startup thread builds index -> frontend polls `/api/status` until `ready` -> sidebar from `/api/characters` -> character page `/api/character/{avatar}` -> viewer `/api/chat/{avatar}/{fname}` (re-parses the file on every request) -> search `/api/search` with ~14 query params validated against `searchmod.SCOPES`/`TARGETS`.

## Gotchas & conventions

- **Read-only invariant**: never open anything under `DATA_ROOT` for writing. The only exceptions are in-memory zip buffers for downloads (`MAX_ZIP_FILES = 2000`) and `app/cleaner.py` (branch-file deletion + in-place `.jsonl` rewrites), which must only ever be invoked through the `/api/cleaner/*` routes after the `cleaner_available()` check.
- **Cache busting**: `index.html` references `style.css?v=5` and `app.js?v=5`. Bump the version in both `<link>`/`<script>` tags when changing static assets, or browsers serve stale files.
- **XSS**: the frontend renders untrusted chat text via `innerHTML`; everything must pass through `esc()` in `app.js`. Search snippets come pre-escaped from the server with `<mark>` tags injected (`make_snippets`) - don't double-escape them client-side.
- **Search scope semantics**: `scope=all` means visible + hidden swipes but **excludes reasoning traces** (they need `scope=reasoning`). See the kind filters in `search_messages`.
- **JSON-escape prefilter**: ST stores newlines inside JSON strings as `\r\n` escape pairs; `_needle_variants` accounts for this. If you change matching, keep the byte prefilter and decoded-text matcher consistent or you'll get missed hits / false positives.
- **Swipe dedup**: in `classify_message`, the selected swipe is skipped when identical to `mes`, and message-level `extra.reasoning` is skipped when it duplicates the selected swipe's `swipe_info` reasoning. Preserve this to avoid double-counted hits.
- **Corrupt-data tolerance**: chat/card parsing swallows bad JSON lines and unreadable files (errors land in `ChatInfo.error`). Keep parsers tolerant; archives in the wild contain malformed lines.
- **Branch files**: `"<name> - Branch #<n>.jsonl"` is parsed by `BRANCH_RE` into `base_name`/`branch_no`; the search `branches` param filters on this.
- **Date filters** are plain string comparisons against ST's `send_date` values (ISO-like prefixes work; don't assume a single format).
- **Path safety**: `Index.chat_path()` and `_get_avatar_path()` reject separators/traversal; route new file-serving endpoints through them.
- `@app.on_event("startup")` is used (deprecated in modern FastAPI but works with the pinned version); follow the existing pattern rather than migrating piecemeal.
- Avatar keys are PNG/JSON **file stems** in `characters/`, which match folder names under `chats/`; group chats may have no card (synthesized `has_card: False` Card).
- Python style: `from __future__ import annotations`, dataclasses with `to_api()` methods defining the JSON contract, type-hinted signatures. Frontend style: plain functions, `$`/`api`/`toast` helpers, `"use strict"`.
