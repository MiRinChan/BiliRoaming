/**
 * BiliRoaming - 弹幕净化
 *
 * 若 DmSegMobileReply 包含 colorful_src (field 5, 大会员渐变色数据):
 *   1. 移除 colorful_src 字段, 禁用渐变渲染
 *   2. 将每个 DanmakuElem 的非白色颜色替换为目标色 (白色 #FFFFFF 或粉色 #FFAEC9)
 *
 * 若不含 colorful_src (普通段): 透传不修改, 避免误伤普通用户的单色弹幕。
 *
 * 拦截接口 (REST protobuf):
 *   - api.bilibili.com/x/v2/dm/list/seg.so   APP 端弹幕分段
 *   - api.bilibili.com/x/v2/dm/web/seg.so    Web 端弹幕分段
 *
 * 参数:
 *   弹幕 = select,"off","white","pink",tag=净化—弹幕
 *     off   - 不做修改，透传
 *     white - 彩色弹幕 → #FFFFFF
 *     pink  - 彩色弹幕 → #FFAEC9
 *
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026-06-25
 */

// === 解析参数 ===
var DANMAKU_MODE = readArg('弹幕', 'off');

var TARGET_COLOR;
if (DANMAKU_MODE === 'white') {
    TARGET_COLOR = 0xFFFFFF;
} else if (DANMAKU_MODE === 'pink') {
    TARGET_COLOR = 0xFFAEC9;
}

var url = $request.url;
var body = $response.body;

if (!TARGET_COLOR || !body || !url) {
    $done({});
    return;
}

// 匹配 REST 弹幕分段接口 (APP / Web)
if (!(url.includes('seg.so') && url.includes('/dm/'))) {
    $done({});
    return;
}

handleDanmakuPurify(TARGET_COLOR);

/**
 * 弹幕净化主入口
 *   两趟处理: 先扫描有无 colorful_src (field 5), 有则移除 + 替换颜色
 */
function handleDanmakuPurify(targetColor) {
    try {
        var rawBytes = getResponseBytes();
        if (!rawBytes || rawBytes.length < 2) {
            $done({});
            return;
        }

        var decompressed = unwrap(rawBytes);
        if (!decompressed || decompressed.length === 0) {
            $done({});
            return;
        }

        // 第一趟: 快速扫描, 检测 colorful_src (field 5)
        var hasColorfulSrc = scanForColorfulSrc(decompressed);

        if (!hasColorfulSrc) {
            $done({});  // 无 colorful_src, 透传避免误伤
            return;
        }

        // 第二趟: 移除 colorful_src + 替换弹幕颜色
        var modified = purifyReply(decompressed, targetColor);
        if (modified === null) {
            $done({});
            return;
        }

        var output = rewrap(rawBytes, modified);
        if (!output) {
            $done({});
            return;
        }

        setResponseBytes(output);

    } catch (e) {
        console.log('BiliRoaming danmaku purify error: ' + e);
        $done({});
    }
}

/**
 * 第一趟: 快速扫描 DmSegMobileReply, 检测是否存在 colorful_src (field 5, wt 2)
 *
 * @param {Uint8Array} buf
 * @returns {boolean}
 */
function scanForColorfulSrc(buf) {
    var off = 0;
    while (off < buf.length) {
        var tag = buf[off];
        var fn = tag >> 3;
        var wt = tag & 0x07;

        if (fn === 5 && wt === 2) return true;

        off = skipField(buf, off);
    }
    return false;
}

/**
 * 第二趟: 净化 DmSegMobileReply
 *
 * 对每个顶层 field:
 *   - field 1 wt 2 (elems/DanmakuElem): 调用 rebuildElemWithColor 替换颜色
 *   - field 5 wt 2 (colorful_src): 整段移除
 *   - 其余: 原样拷贝
 *
 * @param {Uint8Array} buf - DmSegMobileReply protobuf 字节
 * @param {number} targetColor - 目标 RGB 颜色
 * @returns {Uint8Array|null} 修改后的字节
 */
function purifyReply(buf, targetColor) {
    var off = 0;
    var outputParts = [];
    var changedCount = 0;
    var lastCopyEnd = 0;

    while (off < buf.length) {
        var tag = buf[off];
        var fn = tag >> 3;
        var wt = tag & 0x07;

        if (fn === 5 && wt === 2) {
            // colorful_src: 移除
            if (lastCopyEnd < off) {
                outputParts.push(buf.slice(lastCopyEnd, off));
            }
            off++;
            var lenResult = readVarint(buf, off);
            off += lenResult[1] + Number(lenResult[0]);
            lastCopyEnd = off;
            changedCount++;

        } else if (fn === 1 && wt === 2) {
            // DanmakuElem 嵌套消息: tag 0x0A
            off++;

            var lenResult = readVarint(buf, off);
            var elemLen = Number(lenResult[0]);
            var lenVarintLen = lenResult[1];
            off += lenVarintLen;

            var elemStart = off - 1 - lenVarintLen;  // tag 字节位置
            var elemBytes = buf.slice(off, off + elemLen);
            off += elemLen;

            // 尝试替换颜色
            var newElemBytes = rebuildElemWithColor(elemBytes, targetColor);
            if (newElemBytes !== null) {
                // 颜色已修改
                if (lastCopyEnd < elemStart) {
                    outputParts.push(buf.slice(lastCopyEnd, elemStart));
                }
                var newLenVarint = encodeVarint(newElemBytes.length);
                var newTagAndLen = new Uint8Array(1 + newLenVarint.length);
                newTagAndLen[0] = 0x0A;  // field 1, wire type 2
                newTagAndLen.set(newLenVarint, 1);
                outputParts.push(newTagAndLen);
                outputParts.push(newElemBytes);
                lastCopyEnd = off;
                changedCount++;
            }
        } else {
            off = skipField(buf, off);
        }
    }

    if (changedCount === 0) return null;

    if (lastCopyEnd < buf.length) {
        outputParts.push(buf.slice(lastCopyEnd));
    }

    // 拼接所有片段
    var totalLen = 0;
    for (var i = 0; i < outputParts.length; i++) totalLen += outputParts[i].length;
    var result = new Uint8Array(totalLen);
    var pos = 0;
    for (var i = 0; i < outputParts.length; i++) {
        result.set(outputParts[i], pos);
        pos += outputParts[i].length;
    }

    console.log('BiliRoaming danmaku purify: modified ' + changedCount + ' elems, removed colorful_src');
    return result;
}

/**
 * 重建单个 DanmakuElem, 将非白色 color field (fn=5, wt=0) 替换为目标色
 *
 * 逐 field 扫描: color field 替换为目标 varint, 其余字段原样拷贝。
 * 已为目标色的弹幕跳过不修改。
 *
 * @param {Uint8Array} elemBytes - DanmakuElem protobuf 字节
 * @param {number} targetColor
 * @returns {Uint8Array|null} 修改后的 elem 字节, 无变化返回 null
 */
function rebuildElemWithColor(elemBytes, targetColor) {
    var off = 0;
    var newParts = [];
    var changed = false;
    var newTotalLen = 0;

    while (off < elemBytes.length) {
        var tag = elemBytes[off];
        var fn = tag >> 3;
        var wt = tag & 0x07;

        if (fn === 5 && wt === 0) {
            // color field (varint)
            off++;
            var colorResult = readVarint(elemBytes, off);
            var oldColor = Number(colorResult[0]);
            var oldVarintLen = colorResult[1];
            off += oldVarintLen;

            if (oldColor !== 0xFFFFFF && oldColor !== targetColor) {
                // 替换为目标色
                var newVarint = encodeVarint(targetColor);
                var newField = new Uint8Array(1 + newVarint.length);
                newField[0] = 0x28;  // field 5, wire type 0
                newField.set(newVarint, 1);
                newParts.push(newField);
                newTotalLen += newField.length;
                changed = true;
            } else {
                // 白色或已是目标色, 原样拷贝
                var orig = new Uint8Array(1 + oldVarintLen);
                orig[0] = tag;
                orig.set(elemBytes.slice(off - oldVarintLen, off), 1);
                newParts.push(orig);
                newTotalLen += orig.length;
            }
        } else {
            // 非 color field, 整段拷贝
            var fieldStart = off;
            off = skipField(elemBytes, off);
            newParts.push(elemBytes.slice(fieldStart, off));
            newTotalLen += (off - fieldStart);
        }
    }

    if (!changed) return null;

    var result = new Uint8Array(newTotalLen);
    var pos = 0;
    for (var i = 0; i < newParts.length; i++) {
        result.set(newParts[i], pos);
        pos += newParts[i].length;
    }
    return result;
}

/**
 * varint 编码: uint32 → Uint8Array
 */
function encodeVarint(v) {
    var parts = [];
    while (v > 0x7F) {
        parts.push((v & 0x7F) | 0x80);
        v >>>= 7;
    }
    parts.push(v & 0x7F);
    var result = new Uint8Array(parts.length);
    for (var i = 0; i < parts.length; i++) {
        result[i] = parts[i];
    }
    return result;
}

// ==================== IO 层 (Loon 优先, 兼容 Surge) ====================

function getResponseBytes() {
    if (typeof $response.body === 'string' && $response.body.length > 0) {
        var bytes = decodeBase64($response.body);
        if (bytes) return bytes;
    }
    if (typeof $response.bodyBytes !== 'undefined' && $response.bodyBytes) {
        return $response.bodyBytes;
    }
    return null;
}

function setResponseBytes(bytes) {
    var b64 = encodeBase64(bytes);
    $done({ body: b64 });
}

// ==================== 解包 / 打包 (REST protobuf, 无 gRPC frame) ====================

function unwrap(rawBytes) {
    if (rawBytes.length >= 2 && rawBytes[0] === 0x1F && rawBytes[1] === 0x8B) {
        var decompressed = ungzip(rawBytes);
        if (decompressed) return decompressed;
    }
    return rawBytes;
}

function rewrap(originalRaw, protobufBytes) {
    if (originalRaw.length >= 2 && originalRaw[0] === 0x1F && originalRaw[1] === 0x8B) {
        var compressed = gzip(protobufBytes);
        if (compressed) return compressed;
    }
    return protobufBytes;
}

// ==================== Base64 ====================

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

// ==================== gzip ====================

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

// ==================== 手动 Base64 ====================

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

function readArg(key, def) {
    if (typeof $argument === 'object' && $argument && key in $argument) return $argument[key];
    if (typeof $argument === 'string') {
        var m = $argument.match(new RegExp(key + '=([^&]*)'));
        if (m) return m[1];
        if ($argument && !$argument.includes('=')) return $argument;
    }
    return def;
}
