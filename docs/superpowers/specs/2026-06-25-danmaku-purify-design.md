# Historical Note: Danmaku Purify Design

Date: 2026-06-25

This design is archived. The current plugin does not include a danmaku purifier, does not define a `弹幕` argument, and does not map any gRPC `DmSegMobile` / `DmView` response script.

## Current Status

Not implemented in the current tree:

```text
scripts/bili_danmaku_purify.js
BiliRoaming.plugin [Argument] 弹幕
BiliRoaming.plugin [Script] DanmakuPurify
```

Current `scripts/` contents are:

```text
bili_area_limit.js
bili_long_link.js
bili_space_fix.js
```

## Revival Requirements

If the user asks to revive danmaku purification, create a fresh design and implementation plan first. At minimum, verify:

- how the target proxy runtime exposes binary response bodies
- gRPC frame and gzip handling on each supported client
- protobuf field handling for `DmSegMobile` and `DmView`
- fail-open behavior for malformed or unsupported responses
- plugin argument and script entries
- regression tests for binary unwrap/modify/rewrap behavior

Do not execute the old plan as-is.
