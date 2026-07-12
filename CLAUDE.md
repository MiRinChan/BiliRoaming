# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

CarlyLeeRoaming is a collection of JavaScript HTTP response rewrite scripts for network proxy tools (Loon, Surge, Quantumult X, Stash). Scripts intercept Bilibili API responses and modify JSON fields in-flight to unlock regional restrictions, remove ads/promotions, clean up share links, and fix user space pages affected by region locks or account status.

## Architecture

```
CarlyLeeRoaming.plugin      # Plugin manifest: proxy rules, MITM hostnames, script URL mappings, user-facing arguments
scripts/
  bili_long_link.js     # Replace b23.tv short links with clean av/BV URLs
  bili_space_fix.js     # Fix restricted/deactivated user space pages (v2 and legacy APIs)
  bili_vip_ad_purify.js # Remove VIP membership ads from Bilibili surfaces
```

### How scripts execute

Each script runs as an HTTP response handler inside the proxy tool's JavaScript engine. The runtime provides globals: `$request` (URL, method, body), `$response` (status, headers, body), `$done({body, headers})` to return the (optionally modified) response, and optionally `$httpClient` (Surge/Loon) or `$task.fetch` (Quantumult X) for outbound HTTP requests.

**Standard flow in every script:**
1. Parse user arguments via `readArg()` — a local helper duplicated in each file that handles both Loon's `$argument` object and Surge's `$argument` string format
2. If the feature is disabled OR the response body is empty → `$done({})` (pass-through, no modification)
3. `JSON.parse($response.body)`, check `code === 0`
4. Dispatch to fix functions based on URL path matching
5. `$done({ body: JSON.stringify(modifiedObj) })`
6. On any error, log and `$done({})` (fail-open: never block the response)

### Script-specific details

**`bili_long_link.js`** — Intercepts the POST share-click API. In `av` mode, extracts `oid` from the request body. In `bv` mode, attempts direct extraction from the short path, falling back to an HTTP HEAD redirect-follow with a 3-second timeout. Strips Bilibili tracking parameters from the final URL.

**`bili_space_fix.js`** — The most complex script. Normal flow (`code === 0`): patches `area_limit` and `status: -1 → 1` on user cards, space images, video lists, and feed items. For deactivated accounts (`code === -404`): makes an outbound HTTP request to `account.bilibili.com/api/member/getCardByMid` to fetch residual user data, then constructs a synthetic `buildFakeAccInfo()` response with a full BiliSpace v2 schema so the client doesn't show a blank/error page. Falls back to a minimal synthetic response if the card fetch also fails.

### Key patterns

- **No shared code**: Each script is self-contained and fetched independently by the proxy tool from GitHub raw URLs. The `readArg()` and `fixAreaLimit()` helpers are duplicated intentionally.
- **Fail-open**: Errors always result in `$done({})` — the original response passes through unmodified.
- **Compatibility shims**: `readArg()` handles both object and string `$argument`; `$httpClient` vs `$task.fetch` branching handles Surge/Loon vs Quantumult X.
- **URL matching via `String.includes()`**: Simple substring checks on the request URL path, not regex.
- **Argument format**: Arguments in the plugin config use `[{key}]` template syntax — Surge passes a raw string (e.g., `"true"`), Loon passes a parsed object (e.g., `{space: true}`).

## Plugin configuration

`CarlyLeeRoaming.plugin` uses the Loon/Surge plugin format:
- `[Rule]` — DOMAIN-SUFFIX rules to route Bilibili traffic through the proxy
- `[Script]` — Maps URL regex patterns to script files with tags and arguments
- `[MITM]` — Hostnames requiring MITM decryption
- `[Argument]` — User-configurable toggles exposed in the proxy app UI

Scripts are referenced by GitHub raw URLs (`https://raw.githubusercontent.com/.../master/scripts/...`). When developing, point these to a local or fork URL.

## No build/test tooling

This project has no build system, package manager, linter, or test suite. Scripts are plain ES5-compatible JavaScript targeting the proxy tool's JS engine (JavaScriptCore on iOS/macOS). There is no Node.js dependency.

### Manual testing

To test a script change:
1. Host the modified script at a reachable URL (or use a local file server)
2. Point the `script-path` in `CarlyLeeRoaming.plugin` to that URL
3. Load the plugin in Loon/Surge/Quantumult X
4. Trigger the relevant Bilibili API call and inspect the modified response

### Style conventions

- ES5 syntax (no arrow functions in most places, though some newer code uses them; `var`/`let`/`const` mixed)
- 4-space indentation
- JSDoc-style block comments for functions
- Chinese comments and log messages for Bilibili-specific domain terms
