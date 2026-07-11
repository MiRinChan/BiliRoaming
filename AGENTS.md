# Repository Guidelines

## Project Structure & Module Organization

This repository contains a proxy-tool plugin for CarlyLeeRoaming. `CarlyLeeRoaming.plugin` is the main manifest: it defines proxy rules, MITM hostnames, user arguments, and URL-to-script mappings. Runtime scripts live in `scripts/` and are fetched independently by tools such as Loon, Surge, Quantumult X, and Stash:

- `scripts/bili_area_limit.js` handles bangumi area-limit response rewriting.
- `scripts/bili_long_link.js` cleans Bilibili share links.
- `scripts/bili_space_fix.js` repairs restricted user-space responses.

Design notes and implementation plans are stored under `docs/superpowers/`. Keep documentation changes close to the relevant feature or script.

## Build, Test, and Development Commands

There is no package manager, build step, or Node.js dependency. Scripts are plain JavaScript intended for proxy JavaScript runtimes.

- `rg "pattern" scripts/` searches script behavior quickly.
- `git diff -- CarlyLeeRoaming.plugin scripts/` reviews plugin and runtime changes before committing.
- Manual validation: host the changed script, update the matching `script-path` in `CarlyLeeRoaming.plugin`, load the plugin in the target proxy app, trigger the Bilibili API, and inspect the modified response.

## Coding Style & Naming Conventions

Use 4-space indentation and keep scripts self-contained; helpers such as `readArg()` may be duplicated because each script is fetched separately. Prefer ES5-compatible JavaScript for proxy runtime compatibility. Use clear function names such as `fixSeasonData`, `extractParam`, or `buildFakeAccInfo`. Log failures with the `CarlyLeeRoaming` prefix and fail open with `$done({})` so original responses pass through.

## Testing Guidelines

No automated test suite currently exists. Test changes against the proxy tools and endpoints touched by the edit. For JSON rewrites, verify both normal `code === 0` responses and fail-open paths such as empty bodies, parse errors, disabled arguments, and unsupported URLs.

## Commit & Pull Request Guidelines

Recent commits use Conventional Commit-style prefixes such as `refactor:`, `docs:`, and `debug:`. Keep subjects imperative and scoped, for example `docs: update plugin usage notes`. Pull requests should describe the affected script or manifest section, list manual testing steps, link related issues when available, and include screenshots or response snippets for user-visible behavior changes.

## Agent-Specific Instructions

Before editing, check whether the target script is referenced by `CarlyLeeRoaming.plugin`. Do not introduce shared runtime dependencies unless the plugin loading model changes. Keep unrelated cleanup out of feature or bug-fix patches.
