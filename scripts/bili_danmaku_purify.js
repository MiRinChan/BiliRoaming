/**
 * BiliRoaming - 弹幕净化
 *
 * 双重处理:
 *   1. DmSegMobile (gRPC) / seg.so (REST) — 弹幕列表:
 *      若 DmSegMobileReply 包含 colorful_src (field 5, 大会员渐变色数据):
 *        a. 移除 colorful_src 字段, 禁用渐变渲染
 *        b. 将非白色弹幕颜色替换为目标色
 *      若无 colorful_src → 透传不修改 (避免误伤普通用户单色弹幕)
 *
 *   2. DmView (gRPC) — 弹幕配置:
 *      移除 DmColorConfig (fn=6) + 关闭 dm_render_exp 渐变渲染
 *
 * 拦截接口:
 *   grpc.biliapi.net/.../DmSegMobile    (gRPC 弹幕列表, iOS APP 主要路径)
 *   grpc.biliapi.net/.../DmView         (gRPC 弹幕配置)
 *   api.bilibili.com/x/v2/dm/list/seg.so  (REST 弹幕, APP 备用)
 *   api.bilibili.com/x/v2/dm/web/seg.so   (REST 弹幕, Web 端)
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

// 匹配: gRPC DmSegMobile / DmView, 或 REST seg.so
var IS_SEG = url.includes('DmSegMobile') || (url.includes('seg.so') && url.includes('/dm/'));
var IS_VIEW = url.includes('DmView');

if (!IS_SEG && !IS_VIEW) {
    // 兜底: grpc.biliapi 且 url 未匹配但 Script rule 已触发则按 seg 处理
    if (url.includes('grpc.biliapi')) {
        IS_SEG = true;
    } else {
        $done({});
        return;
    }
}

if (IS_VIEW) {
    handleDmViewPurify();
} else {
    handleDanmakuPurify(TARGET_COLOR);
}

// ==================== DmSegMobile 弹幕列表净化 ====================

/**
 * 弹幕列表净化主入口
 *   两趟处理: 先扫描 colorful_src, 有则移除 + 替换颜色
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

        // 第一趟: 检测 colorful_src (field 5)
        var hasColorfulSrc = scanForColorfulSrc(decompressed);
        if (!hasColorfulSrc) {
            $done({});  // 无渐变数据, 透传
            return;
        }

        // 第二趟: 移除 colorful_src + 替换非白色弹幕颜色
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
        console.log('BiliRoaming danmaku purify: ' + e);
        $done({});
    }
}

/**
 * 扫描 DmSegMobileReply, 检测是否存在 colorful_src (field 5, wt 2)
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
 * 净化 DmSegMobileReply:
 *   - field 1 wt 2 (elems): 对每个 DanmakuElem 替换非白色颜色
 *   - field 5 wt 2 (colorful_src): 整段移除
 *   - 其余: 原样拷贝
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
            // colorful_src: 整段移除
            if (lastCopyEnd < off) {
                outputParts.push(buf.slice(lastCopyEnd, off));
            }
            off++;
            var lenResult = readVarint(buf, off);
            off += lenResult[1] + Number(lenResult[0]);
            lastCopyEnd = off;
            changedCount++;

        } else if (fn === 1 && wt === 2) {
            // DanmakuElem 嵌套消息
            off++;
            var lenResult = readVarint(buf, off);
            var elemLen = Number(lenResult[0]);
            var lenVarintLen = lenResult[1];
            off += lenVarintLen;

            var elemStart = off - 1 - lenVarintLen;
            var elemBytes = buf.slice(off, off + elemLen);
            off += elemLen;

            var newElemBytes = rebuildElemWithColor(elemBytes, targetColor);
            if (newElemBytes !== null) {
                if (lastCopyEnd < elemStart) {
                    outputParts.push(buf.slice(lastCopyEnd, elemStart));
                }
                var newLenVarint = encodeVarint(newElemBytes.length);
                var newTagAndLen = new Uint8Array(1 + newLenVarint.length);
                newTagAndLen[0] = 0x0A;
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

    var totalLen = 0;
    for (var i = 0; i < outputParts.length; i++) totalLen += outputParts[i].length;
    var result = new Uint8Array(totalLen);
    var pos = 0;
    for (var i = 0; i < outputParts.length; i++) {
        result.set(outputParts[i], pos);
        pos += outputParts[i].length;
    }

    console.log('BiliRoaming danmaku purify: modified ' + changedCount + ' records, removed colorful_src');
    return result;
}

/**
 * 重建单个 DanmakuElem, 将非白色 color (fn=5, wt=0) 替换为目标色
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
            off++;
            var colorResult = readVarint(elemBytes, off);
            var oldColor = Number(colorResult[0]);
            var oldVarintLen = colorResult[1];
            off += oldVarintLen;

            if (oldColor !== 0xFFFFFF && oldColor !== targetColor) {
                var newVarint = encodeVarint(targetColor);
                var newField = new Uint8Array(1 + newVarint.length);
                newField[0] = 0x28;
                newField.set(newVarint, 1);
                newParts.push(newField);
                newTotalLen += newField.length;
                changed = true;
            } else {
                var orig = new Uint8Array(1 + oldVarintLen);
                orig[0] = tag;
                orig.set(elemBytes.slice(off - oldVarintLen, off), 1);
                newParts.push(orig);
                newTotalLen += orig.length;
            }
        } else {
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

// ==================== DmView 弹幕配置净化 ====================

/**
 * 净化 DmView: 移除 DmColorConfig (fn=6) + 关闭 dm_render_exp 渐变
 */
function handleDmViewPurify() {
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

        var modified = purifyDmViewConfig(decompressed);
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
        console.log('BiliRoaming dmview purify: ' + e);
        $done({});
    }
}

/**
 * 遍历 DmView protobuf:
 *   - 移除 fn=6 (DmColorConfig, wt=2)
 *   - 将 fn=23 (JSON string, wt=2) 中的 dm_render_exp 置 0
 */
function purifyDmViewConfig(buf) {
    var off = 0;
    var outputParts = [];
    var changed = false;
    var lastCopyEnd = 0;

    while (off < buf.length) {
        var tag = buf[off];
        var fn = tag >> 3;
        var wt = tag & 0x07;

        if (fn === 6 && wt === 2) {
            if (lastCopyEnd < off) {
                outputParts.push(buf.slice(lastCopyEnd, off));
            }
            off++;
            var lenResult = readVarint(buf, off);
            off += lenResult[1] + Number(lenResult[0]);
            lastCopyEnd = off;
            changed = true;
            console.log('BiliRoaming dmview purify: removed DmColorConfig');
        } else if (fn === 23 && wt === 2) {
            off++;
            var lenResult = readVarint(buf, off);
            var jsonLen = Number(lenResult[0]);
            var lenVarintLen = lenResult[1];
            off += lenVarintLen;

            var jsonBytes = buf.slice(off, off + jsonLen);
            off += jsonLen;

            var jsonStr = bytesToString(jsonBytes);
            var newJsonStr = jsonStr.replace(/"dm_render_exp"\s*:\s*\d+/g, '"dm_render_exp":0');

            if (newJsonStr !== jsonStr) {
                if (lastCopyEnd < off - jsonLen - 1 - lenVarintLen) {
                    outputParts.push(buf.slice(lastCopyEnd, off - jsonLen - 1 - lenVarintLen));
                }
                var newJsonBytes = stringToBytes(newJsonStr);
                outputParts.push(new Uint8Array([0xBA])); // fn=23, wt=2
                outputParts.push(encodeVarint(newJsonBytes.length));
                outputParts.push(newJsonBytes);
                lastCopyEnd = off;
                changed = true;
                console.log('BiliRoaming dmview purify: disabled dm_render_exp');
            }
        } else {
            off = skipField(buf, off);
        }
    }

    if (!changed) return null;

    if (lastCopyEnd < buf.length) {
        outputParts.push(buf.slice(lastCopyEnd));
    }

    var totalLen = 0;
    for (var i = 0; i < outputParts.length; i++) totalLen += outputParts[i].length;
    var result = new Uint8Array(totalLen);
    var pos = 0;
    for (var i = 0; i < outputParts.length; i++) {
        result.set(outputParts[i], pos);
        pos += outputParts[i].length;
    }
    return result;
}

function bytesToString(bytes) {
    var str = '';
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return str;
}

function stringToBytes(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    return bytes;
}

// ==================== IO 层 ====================

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

// ==================== 解包 / 打包 ====================

/**
 * 自动检测 gRPC frame + gzip, 解包到 protobuf
 */
function unwrap(rawBytes) {
    var buf = rawBytes;

    // 1. gRPC frame: flag (0x00/0x01) + 4B BE length
    if (buf.length >= 5 && (buf[0] === 0x00 || buf[0] === 0x01)) {
        var claimedLen = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];
        var actualAvail = buf.length - 5;
        if (claimedLen > 0 && claimedLen <= actualAvail + 100) {
            buf = buf.slice(5, 5 + Math.min(claimedLen, actualAvail));
        }
    }

    // 2. gzip
    if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) {
        var decompressed = ungzip(buf);
        if (decompressed) return decompressed;
    }

    return buf;
}

/**
 * protobuf → gzip → gRPC frame (如原始有)
 */
function rewrap(originalRaw, protobufBytes) {
    var data = protobufBytes;

    // gzip (如原始有)
    if (originalRaw.length >= 2 && originalRaw[0] === 0x1F && originalRaw[1] === 0x8B) {
        var compressed = gzip(protobufBytes);
        if (compressed) data = compressed;
    }

    // gRPC frame (如原始有)
    if (originalRaw.length >= 5 && (originalRaw[0] === 0x00 || originalRaw[0] === 0x01)) {
        var flag = originalRaw[0];
        var frame = new Uint8Array(5 + data.length);
        frame[0] = flag;
        frame[1] = (data.length >>> 24) & 0xFF;
        frame[2] = (data.length >>> 16) & 0xFF;
        frame[3] = (data.length >>> 8) & 0xFF;
        frame[4] = data.length & 0xFF;
        frame.set(data, 5);
        return frame;
    }

    return data;
}

// ==================== Base64 ====================

function decodeBase64(str) {
    if (typeof $utils !== 'undefined' && typeof $utils.base64ToBytes === 'function') {
        try { var r = $utils.base64ToBytes(str); if (r) return r; } catch (e) {}
    }
    return manualBase64ToBytes(str);
}

function encodeBase64(bytes) {
    if (typeof $utils !== 'undefined' && typeof $utils.bytesToBase64 === 'function') {
        try { var r = $utils.bytesToBase64(bytes); if (r) return r; } catch (e) {}
    }
    return manualBytesToBase64(bytes);
}

// ==================== gzip ====================

function ungzip(data) {
    if (typeof $utils !== 'undefined' && typeof $utils.ungzip === 'function') {
        try { var r = $utils.ungzip(data); if (r) return r; } catch (e) {}
    }
    return null;
}

function gzip(data) {
    if (typeof $utils !== 'undefined' && typeof $utils.gzip === 'function') {
        try { var r = $utils.gzip(data); if (r) return r; } catch (e) {}
    }
    return null;
}

// ==================== Protobuf 辅助 ====================

function readVarint(buf, offset) {
    var result = 0, shift = 0, read = 0;
    while (offset + read < buf.length) {
        var b = buf[offset + read]; read++;
        result |= (b & 0x7F) << shift; shift += 7;
        if (!(b & 0x80)) break;
    }
    return [result, read];
}

function skipField(buf, off) {
    if (off >= buf.length) return off;
    var wt = buf[off] & 0x07; off++;
    return skipFieldPayload(buf, off, wt);
}

function skipFieldPayload(buf, off, wt) {
    if (wt === 0) { var vr = readVarint(buf, off); return off + vr[1]; }
    else if (wt === 2) { var lr = readVarint(buf, off); return off + lr[1] + Number(lr[0]); }
    else if (wt === 5) { return off + 4; }
    else if (wt === 1) { return off + 8; }
    return off;
}

// ==================== 手动 Base64 ====================

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function manualBase64ToBytes(b64) {
    if (b64.length < 10 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
    var s = b64.replace(/[^A-Za-z0-9+/]/g, '');
    var outLen = Math.floor((s.length * 3) / 4);
    var result = new Uint8Array(outLen);
    for (var i = 0, idx = 0; i < s.length; i += 4) {
        var c0 = B64.indexOf(s[i]), c1 = B64.indexOf(s[i + 1]);
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
    var result = '', len = bytes.length;
    for (var i = 0; i < len; i += 3) {
        var b0 = bytes[i], b1 = i + 1 < len ? bytes[i + 1] : 0, b2 = i + 2 < len ? bytes[i + 2] : 0;
        result += B64[b0 >> 2] + B64[((b0 & 0x3) << 4) | (b1 >> 4)];
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
