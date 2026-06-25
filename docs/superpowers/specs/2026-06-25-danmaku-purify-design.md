# 弹幕净化 — 设计说明

## 目标

禁用B站大会员彩色（渐变/彩虹）弹幕，替换为普通白色或粉色单色弹幕。

## 原理

B站弹幕系统中：
- **任何用户**都可以发送任意颜色的**单色**弹幕（`DanmakuElem.color` 字段）
- **仅大会员**可以发送**彩色渐变**弹幕，由 `DmSegMobileReply.colorful_src` (field 5)
  提供渐变配色数据（`DmColorful` 列表）
- `DmView` 响应中的 `DmColorConfig` (field 6) 定义颜色渐变规则，
  `dm_render_exp` (field 23 JSON 中的字段) 控制渐变渲染开关

### 策略

1. **DmSegMobile / seg.so（弹幕列表）**：先扫描是否有 `colorful_src` (field 5)
   - 无 → 透传（普通段，无大会员渐变弹幕）
   - 有 → 删除 `colorful_src` + 将非白色弹幕颜色替换为目标色
2. **DmView（弹幕配置）**：删除 `DmColorConfig` (fn=6) + 关闭 `dm_render_exp`

## 参数

```
弹幕 = select,"off","white","pink",tag=净化—弹幕,desc=把大会员彩色弹幕换成普通弹幕
```

## 拦截接口

| 端点 | 协议 | 用途 |
|------|------|------|
| `grpc.biliapi.net/.../DmSegMobile` | gRPC | iOS APP 弹幕列表（主要路径） |
| `grpc.biliapi.net/.../DmView` | gRPC | iOS APP 弹幕配置 |
| `api.bilibili.com/x/v2/dm/list/seg.so` | REST | APP 弹幕备用 |
| `api.bilibili.com/x/v2/dm/web/seg.so` | REST | Web 弹幕 |

## 响应格式

- gRPC: gRPC frame (5B) → gzip → protobuf
- REST: 裸 protobuf 字节（少数情况有 gzip 压缩）
- `unwrap()` 自动检测并剥离 frame/gzip
- `rewrap()` 反向打包（保留原始 frame/gzip 结构）

## Protobuf 结构

```
DmSegMobileReply:
    repeated DanmakuElem elems = 1;       // tag 0x0A
    int32 state = 2;
    DanmakuAiFlag ai_flag = 3;
    repeated int64 segment_rules = 4;
    repeated DmColorful colorful_src = 5;  // tag 0x2A → 移除
    string context_src = 6;

DanmakuElem:
    uint32 color = 5;   // tag 0x28, wire type 0, varint
    (其余字段不关心)
```

## 处理流程

1. `readArg('弹幕', 'off')` — off 或 body 为空 → `$done({})`
2. URL 匹配：`DmSegMobile` / `seg.so` + `/dm/` → 弹幕列表；`DmView` → 弹幕配置
3. `getResponseBytes → unwrap → (scan) → purify → rewrap → setResponseBytes`

## 错误处理

- 任何异常 → `$done({})`（fail-open）

## Plugin 配置

```
[Argument]
弹幕 = select,"off","white","pink",tag=净化—弹幕,desc=把大会员彩色弹幕换成普通弹幕

[Script]
http-response .../DmSegMobile ..., tag=DanmakuPurify, argument=[{弹幕}]
http-response .../DmView      ..., tag=DanmakuViewPurify, argument=[{弹幕}]
http-response .../dm/list/seg.so ..., tag=DanmakuRestPurify, argument=[{弹幕}]
http-response .../dm/web/seg.so  ..., tag=DanmakuWebPurify, argument=[{弹幕}]
```
