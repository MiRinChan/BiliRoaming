# Historical Note: Purify And Space Fix

Date: 2026-06-24

This document originally described two additions:

- a purifier script for ads/promotions
- a space-fix script for restricted or deactivated user pages

Only the space-fix work remains in the current plugin. The purifier script and `pure` argument are not present in `BiliRoaming.plugin`.

## Current Status

Current files:

```text
scripts/bili_space_fix.js
BiliRoaming.plugin
tests/scripts.test.js
```

Current plugin argument:

```text
space = switch,false,tag=空间修复,desc=修复被限制的用户空间
```

Current script coverage:

| API family | Matching shape | Behavior |
| --- | --- | --- |
| Profile | `/x/v*/space?`, `/x/space?`, `/x/space/acc/info` | Repair card/space area fields; try getCardByMid fallback for `-404`. |
| Archive | `/x/space/arc/search`, `/x/space/wbi/arc/search`, `/x/v2/space/archive` | Repair video item restriction fields and hidden counters. |
| Feed | `/x/community-service/.../user/feed` | Repair item/module restriction fields. |

## Do Not Assume

- Do not add `bili_purify.js` from this historical design unless the user explicitly asks for a purifier feature.
- Do not add `pure` to `BiliRoaming.plugin` unless that feature is reimplemented and tested.
- Treat this file as historical context, not an implementation plan.
