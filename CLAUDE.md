# CLAUDE.md

This file gives repository-specific guidance for agents working in BiliRoaming.

## Overview

BiliRoaming is a small set of standalone JavaScript HTTP response rewrite scripts for network proxy tools such as Loon, Surge, Quantumult X, and Stash. The scripts run inside the proxy tool's JavaScript runtime, inspect Bilibili API responses, and return either a modified response body or `$done({})` to pass through unchanged.

Current runtime globals:

- `$request`: URL, method, and request body
- `$response`: response body and headers
- `$done({ body, headers })`: return the rewritten response
- `$httpClient`: optional Surge/Loon/Stash outbound HTTP client
- `$task.fetch`: optional Quantumult X outbound HTTP client

## Current Files

```text
BiliRoaming.plugin      # Plugin manifest: proxy rules, MITM hostnames, script mappings, arguments
scripts/
  bili_area_limit.js    # PGC area-limit field repair and intl API fallback
  bili_long_link.js     # Replace b23.tv / bili2233.cn short links with clean av/BV URLs
  bili_space_fix.js     # Repair restricted/deactivated user space responses
tests/
  scripts.test.js       # Node vm regression tests for the standalone scripts
```

There is no current `bili_purify.js` or `bili_danmaku_purify.js` script in the plugin. Historical design files under `docs/superpowers/` may mention those removed or unimplemented ideas; do not treat them as current requirements unless the user explicitly asks to revive them.

## Script Flow

Each script follows the same shape:

1. Parse user arguments with a local `readArg()` helper.
2. If the feature is disabled or the response body is empty, call `$done({})`.
3. Parse JSON where applicable.
4. Route by URL path and response `code`.
5. Modify the response object in place.
6. Return `$done({ body: JSON.stringify(obj) })`.
7. On errors, log and fail open with `$done({})`.

Scripts are fetched independently by proxy tools, so shared helpers are duplicated intentionally. Do not introduce shared local modules unless the plugin delivery model changes.

## Script Details

### `bili_area_limit.js`

Handles PGC season, playurl, TV playurl, intl OGV playurl/season, and search responses. Normal `code === 0` responses get `area_limit`, `allow_dm`, `allow_download`, `allow_comment`, and `allow_demand` fields repaired across known nested structures. Episode status `13` is normalized to `2`, and `limit` / `dialog` UI restriction markers are cleared.

For main season/playurl `code === -404`, the script tries international bstar API endpoints and rebuilds a compatible response. If the outbound request fails, it returns the original `-404` body.

### `bili_long_link.js`

Handles POST responses from `/x/share/click`. In `av` mode it uses `oid` from the request body. In `bv` mode it first extracts direct `BV` / `av` / `ss` / `ep` paths, then falls back to an HTTP HEAD redirect lookup with a timeout. Tracking parameters are stripped, keeping only useful playback position fields.

### `bili_space_fix.js`

Handles profile, archive, and feed space APIs. Normal `code === 0` responses get area/status/badge fields repaired. Profile `code === -404` responses attempt `account.bilibili.com/api/member/getCardByMid` and build a synthetic BiliSpace-compatible response when residual card data is available; if not, the script falls back without blocking the response.

## Compatibility Rules

- Production scripts should stay ES5-friendly for older JavaScriptCore runtimes.
- Avoid `Object.hasOwn`, optional chaining, arrow functions, template literals, and other newer syntax in `scripts/*.js`.
- Use `Object.prototype.hasOwnProperty.call(obj, key)` through the local `hasOwn()` helper.
- Keep the scripts self-contained.
- Preserve fail-open behavior.
- Use 4-space indentation.
- Keep Bilibili-specific comments and log messages in Chinese when helpful.

## Testing

There is no package manager or build system. Use the declared Nix one-shot environment when Node.js is needed:

```bash
nix shell nixpkgs#nodejs --command node tests/scripts.test.js
```

Syntax-check all production scripts and the test harness:

```bash
nix shell nixpkgs#nodejs --command bash -c 'for f in scripts/bili_area_limit.js scripts/bili_long_link.js scripts/bili_space_fix.js tests/scripts.test.js; do node --check "$f" || exit 1; done'
```

The tests execute the actual script files through Node's `vm` module and inject `$request`, `$response`, `$done`, `$httpClient`, and `$task` shims.
