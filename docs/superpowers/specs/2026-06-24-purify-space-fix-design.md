# CarlyLeeRoaming MITM Purify & Space Fix

Date: 2026-06-24

## Summary

Add two new MITM scripts to the CarlyLeeRoaming plugin:
- `bili_purify.js` — Remove ads, promotions, and noise from Bilibili feeds
- `bili_space_fix.js` — Restore blocked/area-limited user space content

## Files

```
scripts/
├── bili_area_limit.js    (existing, unchanged)
├── bili_long_link.js     (existing, unchanged)
├── bili_purify.js        (NEW)
└── bili_space_fix.js     (NEW)
CarlyLeeRoaming.plugin        (UPDATE: add new Script/MITM/Argument entries)
```

## bili_purify.js

### Argument
`pure=[all|feed|search|detail|dynamic|live|comment]` (default: all)

### Intercepted APIs

| Module | URL Pattern | Actions |
|--------|-----------|---------|
| feed | `/x/web-interface/index/top/feed` | Remove `is_ad`, `ad_info`, `banner_item`, `operation_card`; filter `card_type: ad` |
| popular | `/x/web-interface/popular` | Clear `ad_index`, promoted `rcmd_reason` |
| search | `/x/web-interface/search`, `/x/v2/search` | Remove hot_search promotions, `special_type: 1` results, banners |
| detail | `/x/web-interface/view` | Clear `operation_card`, `cm_config`, `cmds`; filter relates/live_order |
| dynamic | `/x/polymer/web-dynamic` | Remove city/campus tags, topic_list, ad/blocked cards |
| live | `/xlive` (prefix match) | Remove popups, banners |
| comment | `/x/v2/reply` | Remove top pinned ads, reply guides |

### Design Decisions
- Single script with module gating via `pure` parameter
- Compatible with Loon (`$argument` object) and Surge (`$argument` string)
- All modules ON by default (`pure=all`)
- User can select specific modules: `pure=feed,search` means only feed+search

## bili_space_fix.js

### Argument
`space=true` (default: false)

### Intercepted APIs

| API | URL Pattern | Actions |
|-----|-----------|---------|
| user info | `/x/space/acc/info` | Restore `status: -1` → `1`; fix `area_limit`; handle `-404` fallback |
| video list | `/x/space/arc/search` | Fix `area_limit` on each video; remove "受限" badge |
| user feed | `/x/community-service/v1/user/feed` | Fix `area_limit`; remove region badges |

### Design Decisions
- Simple boolean toggle
- For `-404` responses: cannot restore data that server refuses to serve (MITM limitation)
- Focus on: area limit removal on accessible profiles, and unhiding profiles where data IS returned but client refuses to display

## Plugin Rules Added

### Argument
```
pure = select,"all","feed","search","detail","dynamic","live","comment",tag=净化功能,desc=过滤B站广告和推广内容
space = switch,false,tag=空间修复,desc=修复被限制的用户空间
```

### Script (8 new rules for purify, 3 for space)
See CarlyLeeRoaming.plugin for exact rules.

## Non-Goals
- CDN/UPOS replacement (separate feature)
- Subtitle manipulation (separate feature)
- Anything requiring Xposed client hooks (custom themes, auto-like, etc.)
