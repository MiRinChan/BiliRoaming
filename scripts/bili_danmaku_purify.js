/**
 * BiliRoaming - 弹幕净化
 *
 * 移除 DmSegMobileReply protobuf 响应中的 colorful_src 字段 (field 5),
 * 禁用大会员彩色弹幕的渐变渲染效果, 保留普通用户发送的单色弹幕。
 *
 * 拦截接口 (REST protobuf):
 *   - api.bilibili.com/x/v2/dm/list/seg.so   APP 端弹幕分段
 *   - api.bilibili.com/x/v2/dm/web/seg.so    Web 端弹幕分段
 *
 * 参数:
 *   弹幕 = select,"off","white","pink",tag=净化—弹幕
 *     off   - 不做修改，透传
 *     white - 启用净化
 *     pink  - 启用净化
 *
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026-06-25
 */

// === 解析参数 ===
var DANMAKU_ENABLED = readArg('弹幕', 'off') !== 'off';

var url = $request.url;
var body = $response.body;

if (!DANMAKU_ENABLED || !body || !url) {
    $done({});
    return;
}

// 匹配 REST 弹幕分段接口 (APP / Web)
if (!(url.includes('seg.so') && url.includes('/dm/'))) {
    $done({});
    return;
}

handleDanmakuPurify();

/**
 * 弹幕净化主入口
 * getResponseBytes → unwrap → removeColorfulSrc → rewrap → setResponseBytes
 */
function handleDanmakuPurify() {
    try {
        var rawBytes = getResponseBytes();
        if (!rawBytes || rawBytes.length < 2) {
            $done({});
            return;
        }

        // 检测是否有 colorful_src 的快速路径:
        // seg.so 响应通常以 0x0A (field 1, elems) 开头,
        // 如果只有 field 1 且无 field 5, 大概率无需修改
        var decompressed = unwrap(rawBytes);
        if (!decompressed || decompressed.length === 0) {
            $done({});
            return;
        }

        // 移除 colorful_src (field 5) — 禁用渐变色效果
        var modified = removeColorfulSrc(decompressed);

        if (modified === null) {
            $done({});  // 无变化, 透传
            return;
        }

        // 重新打包
        var output = rewrap(rawBytes, modified);
        if (!output) {
            $done({});
            return;
        }

        setResponseBytes(output);

    } catch (e) {
        console.log('BiliRoaming danmaku purify: ' + e);
        $done({});
    }
}

/**
 * 移除 DmSegMobileReply 中的 colorful_src 字段 (field 5, wire type 2)
 *
 * 逐 field 扫描 protobuf 字节流, 跳过 field 5 wt 2 (colorful_src),
 * 其余 field 原样拷贝。这是 DmSegMobileReply 顶层字段,
 * 不在嵌套消息内。
 *
 * DmSegMobileReply 结构:
 *   elems         = 1 (wt 2)  → 保留
 *   state         = 2 (wt 0)  → 保留
 *   ai_flag       = 3 (wt 2)  → 保留 (若存在)
 *   segment_rules = 4 (wt 2)  → 保留 (若存在)
 *   colorful_src  = 5 (wt 2)  → 移除
 *   context_src   = 6 (wt 2)  → 保留 (若存在)
 *
 * @param {Uint8Array} buf - DmSegMobileReply protobuf 字节
 * @returns {Uint8Array|null} 修改后的字节, 无 colorful_src 返回 null
 */
function removeColorfulSrc(buf) {
    var off = 0;
    var outputParts = [];
    var removedCount = 0;
    var lastCopyEnd = 0;

    while (off < buf.length) {
        var tag = buf[off];
        var fn = tag >> 3;
        var wt = tag & 0x07;

        if (fn === 5 && wt === 2) {
            // colorful_src: 整段移除
            if (lastCopyEnd < off) {
                outputParts.push(buf.slice(lastCopyEnd, off));
            }
            off++;  // 跳过 tag 字节
            var lenResult = readVarint(buf, off);
            off += lenResult[1] + Number(lenResult[0]);
            lastCopyEnd = off;
            removedCount++;
        } else {
            off = skipField(buf, off);
        }
    }

    if (removedCount === 0) return null;

    // 拷贝剩余尾部
    if (lastCopyEnd < buf.length) {
        outputParts.push(buf.slice(lastCopyEnd));
    }

    // 拼接所有保留片段
    if (outputParts.length === 0) {
        // 极端情况: 仅有 colorful_src 没有 elems (不可能)
        return new Uint8Array(0);
    }

    if (outputParts.length === 1) {
        return outputParts[0];
    }

    var totalLen = 0;
    for (var i = 0; i < outputParts.length; i++) totalLen += outputParts[i].length;
    var result = new Uint8Array(totalLen);
    var pos = 0;
    for (var i = 0; i < outputParts.length; i++) {
        result.set(outputParts[i], pos);
        pos += outputParts[i].length;
    }

    console.log('BiliRoaming danmaku purify: removed ' + removedCount + ' colorful_src field(s)');
    return result;
}

// ==================== IO 层 (Loon 优先, 兼容 Surge) ====================

/**
 * 获取响应原始字节
 * Loon:  $response.body 为 base64 字符串
 * Surge: $response.bodyBytes 为 Uint8Array
 */
function getResponseBytes() {
    // Loon 优先: base64 字符串 body
    if (typeof $response.body === 'string' && $response.body.length > 0) {
        var bytes = decodeBase64($response.body);
        if (bytes) return bytes;
    }

    // Surge: bodyBytes
    if (typeof $response.bodyBytes !== 'undefined' && $response.bodyBytes) {
        return $response.bodyBytes;
    }

    return null;
}

/**
 * 设置响应原始字节
 * Loon:  $done({ body: base64str })
 * Surge: $done({ bodyBytes: Uint8Array })
 */
function setResponseBytes(bytes) {
    var b64 = encodeBase64(bytes);
    $done({ body: b64 });
}

// ==================== 解包 / 打包 (REST protobuf, 无 gRPC frame) ====================

/**
 * 解包到 protobuf
 * REST seg.so 响应通常为裸 protobuf 字节。
 * 少数情况下可能有额外 gzip 压缩 (0x1F 0x8B 魔数)。
 */
function unwrap(rawBytes) {
    // 检测 gzip 魔数: 额外解压一层
    if (rawBytes.length >= 2 && rawBytes[0] === 0x1F && rawBytes[1] === 0x8B) {
        var decompressed = ungzip(rawBytes);
        if (decompressed) return decompressed;
    }

    // 已是裸 protobuf
    return rawBytes;
}

/**
 * 反向打包: protobuf → (gzip, 如原始有)
 *
 * 若原始响应包含 gzip 魔数则 re-compress;
 * 否则直接返回 protobuf 字节。
 * REST 接口无 gRPC frame。
 */
function rewrap(originalRaw, protobufBytes) {
    if (originalRaw.length >= 2 && originalRaw[0] === 0x1F && originalRaw[1] === 0x8B) {
        var compressed = gzip(protobufBytes);
        if (compressed) return compressed;
        // gzip 失败 → 回退到裸字节
    }
    return protobufBytes;
}

// ==================== Base64 (优先使用 $utils, 回退手动) ====================

function decodeBase64(str) {
    if (typeof $utils !== 'undefined' && typeof $utils.base64ToBytes === 'function') {
        try {
            var result = $utils.base64ToBytes(str);
            if (result) return result;
        } catch (e) { /* fall through */ }
    }
    return manualBase64ToBytes(str);
}

function encodeBase64(bytes) {
    if (typeof $utils !== 'undefined' && typeof $utils.bytesToBase64 === 'function') {
        try {
            var result = $utils.bytesToBase64(bytes);
            if (result) return result;
        } catch (e) { /* fall through */ }
    }
    return manualBytesToBase64(bytes);
}

// ==================== gzip (统一走 $utils) ====================

function ungzip(data) {
    if (typeof $utils !== 'undefined' && typeof $utils.ungzip === 'function') {
        try {
            var result = $utils.ungzip(data);
            if (result) return result;
        } catch (e) { /* fall through */ }
    }
    return null;
}

function gzip(data) {
    if (typeof $utils !== 'undefined' && typeof $utils.gzip === 'function') {
        try {
            var result = $utils.gzip(data);
            if (result) return result;
        } catch (e) { /* fall through */ }
    }
    return null;
}

// ==================== Protobuf 辅助 ====================

/**
 * 读取 protobuf varint
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {[number, number]} [value, bytesRead]
 */
function readVarint(buf, offset) {
    var result = 0;
    var shift = 0;
    var read = 0;
    while (offset + read < buf.length) {
        var b = buf[offset + read];
        read++;
        result |= (b & 0x7F) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
    }
    return [result, read];
}

/** 跳过一个 protobuf field (tag 未消费) */
function skipField(buf, off) {
    if (off >= buf.length) return off;
    var tag = buf[off];
    var wt = tag & 0x07;
    off++;
    return skipFieldPayload(buf, off, wt);
}

function skipFieldPayload(buf, off, wt) {
    if (wt === 0) {
        var vResult = readVarint(buf, off);
        return off + vResult[1];
    } else if (wt === 2) {
        var lenResult = readVarint(buf, off);
        return off + lenResult[1] + Number(lenResult[0]);
    } else if (wt === 5) {
        return off + 4;
    } else if (wt === 1) {
        return off + 8;
    }
    return off;
}

// ==================== 手动 Base64 (无 $utils 时的回退) ====================

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function manualBase64ToBytes(b64) {
    if (b64.length < 10 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
    var s = b64.replace(/[^A-Za-z0-9+/]/g, '');
    var outLen = Math.floor((s.length * 3) / 4);
    var result = new Uint8Array(outLen);
    var idx = 0;
    for (var i = 0; i < s.length; i += 4) {
        var c0 = B64.indexOf(s[i]);
        var c1 = B64.indexOf(s[i + 1]);
        var c2 = i + 2 < s.length ? B64.indexOf(s[i + 2]) : 0;
        var c3 = i + 3 < s.length ? B64.indexOf(s[i + 3]) : 0;
        if (c0 < 0 || c1 < 0) return null;
        result[idx++] = (c0 << 2) | (c1 >> 4);
        if (idx < outLen) result[idx++] = ((c1 & 0xF) << 4) | (c2 >> 2);
        if (idx < outLen) result[idx++] = ((c2 & 0x3) << 6) | c3;
    }
    return result;
}

function manualBytesToBase64(bytes) {
    var result = '';
    var len = bytes.length;
    for (var i = 0; i < len; i += 3) {
        var b0 = bytes[i];
        var b1 = i + 1 < len ? bytes[i + 1] : 0;
        var b2 = i + 2 < len ? bytes[i + 2] : 0;
        result += B64[b0 >> 2];
        result += B64[((b0 & 0x3) << 4) | (b1 >> 4)];
        result += i + 1 < len ? B64[((b1 & 0xF) << 2) | (b2 >> 6)] : '=';
        result += i + 2 < len ? B64[b2 & 0x3F] : '=';
    }
    return result;
}

// ==================== 参数解析 ====================

/**
 * 读取插件参数（兼容 Loon $argument 对象 & Surge $argument 字符串）
 */
function readArg(key, def) {
    if (typeof $argument === 'object' && $argument && key in $argument) return $argument[key];
    if (typeof $argument === 'string') {
        var m = $argument.match(new RegExp(key + '=([^&]*)'));
        if (m) return m[1];
        // Surge [{key}] template passes raw value without key= prefix
        if ($argument && !$argument.includes('=')) return $argument;
    }
    return def;
}
