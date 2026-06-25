# 弹幕净化 — 设计说明

## 目标

新增 `bili_danmaku_purify.js` 脚本，移除 `DmSegMobileReply` 中的 `colorful_src` 字段，
禁用大会员彩色弹幕的渐变渲染效果，保留普通用户发送的单色弹幕。

## 原理

B站弹幕系统中：
- **任何用户** 都可以发送任意颜色的**单色**弹幕（`color` 字段为 RGB 值）
- **仅大会员** 可以发送**彩色（渐变/彩虹）**弹幕，由 `DmSegMobileReply.colorful_src` (field 5)
  字段提供渐变配色数据

因此正确做法是**删除 `colorful_src`**，而非修改单个弹幕的 `color` 字段。
这样可以精确针对大会员渐变效果，不会误伤普通用户的合法单色弹幕。

## 参数

```
弹幕 = select,"off","white","pink",tag=净化—弹幕,desc=把大会员彩色弹幕换成普通弹幕
```

| 值 | 含义 |
|----|------|
| off | 不做修改，透传 |
| white | 启用净化（移除 colorful_src，禁用渐变效果） |
| pink | 启用净化（同上） |

注：white/pink 为历史遗留选项，实际效果相同——均移除 `colorful_src`。

参数解析兼容 Loon（object）和 Surge（string）。

## 拦截接口

```
api.bilibili.com/x/v2/dm/list/seg.so   APP 端弹幕分段 (REST protobuf)
api.bilibili.com/x/v2/dm/web/seg.so    Web 端弹幕分段 (REST protobuf)
```

iOS APP 使用 REST protobuf 接口而非 gRPC。抓包验证确认 APP 不会向
`grpc.biliapi.net` 发送 DmSegMobile 请求。

## 响应格式

裸 protobuf 字节（REST 响应，无 gRPC frame）。部分情况下可能有额外 gzip 压缩
（0x1F 0x8B 魔数）。脚本自动检测并解包。

## Protobuf 结构

```
DmSegMobileReply:
    repeated DanmakuElem elems = 1;    // tag 0x0A, 保留
    int32 state = 2;                    // tag 0x10, 保留
    DanmakuAiFlag ai_flag = 3;          // 保留 (若存在)
    repeated int64 segment_rules = 4;   // 保留 (若存在)
    repeated DmColorful colorful_src = 5;  // tag 0x2A → 移除
    string context_src = 6;             // 保留 (若存在)
```

## 处理流程

1. `readArg('弹幕', 'off')` — 若 off 或 body 为空 → `$done({})`
2. getResponseBytes → unwrap（检测 gzip 魔数自动解压，无 gRPC frame）
3. 遍历 DmSegMobileReply，找到 field 5 wire type 2 (colorful_src) 整段移除
4. 无修改 → `$done({})` 透传；有修改 → rewrap（若原始有 gzip 则 re-compress）→ setResponseBytes

## 复用代码

从 bili_purify.js 复制以下基础设施（约 280 行）：
- `readArg`
- `getResponseBytes` / `setResponseBytes`
- `decodeBase64` / `encodeBase64` (+ manual fallback)
- `ungzip` / `gzip`
- `readVarint` / `skipField` / `skipFieldPayload`

新增逻辑仅 ~60 行：`removeColorfulSrc` 函数。

## Plugin 配置

`BiliRoaming.plugin` 新增：
```
[Argument]
弹幕 = select,"off","white","pink",tag=净化—弹幕,desc=把大会员彩色弹幕换成普通弹幕

[Script]
http-response ^https?:\/\/ap[pi]\.bili(bili|api)\.(com|net)\/x\/v2\/dm\/list\/seg\.so script-path=..., requires-body=true, tag=DanmakuPurify, argument=[{弹幕}]
http-response ^https?:\/\/ap[pi]\.bili(bili|api)\.(com|net)\/x\/v2\/dm\/web\/seg\.so script-path=..., requires-body=true, tag=DanmakuWebPurify, argument=[{弹幕}]
```

## 错误处理

- 任何异常 → `$done({})`（fail-open，透传）
- gzip 解压失败 → 尝试裸 protobuf
- 无法解析的 protobuf → 透传
