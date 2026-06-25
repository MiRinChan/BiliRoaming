/**
 * BiliRoaming - 弹幕净化
 *
 * 将 DmSegMobile gRPC 响应中大会员彩色弹幕的颜色替换为指定颜色（白色或粉色）。
 *
 * 拦截接口 (gRPC):
 *   - grpc.biliapi.net/bilibili.community.service.dm.v1.DM/DmSegMobile  弹幕列表
 *   - grpc.biliapi.net/bilibili.community.service.dm.v1.DM/DmView       弹幕显示配置
 *
 * DmView 处理: 移除 DmColorConfig (fn=6) 颜色规则 + 关闭 dm_render_exp 渐变渲染,
 * 确保客户端不覆盖 DmSegMobile 里的颜色修改。
 *
 * 参数:
 *   弹幕 = select,"off","white","pink",tag=净化—弹幕
 *     off   - 不做修改，透传
 *     white - 彩色弹幕 → #FFFFFF (白色)
 *     pink  - 彩色弹幕 → #FFAEC9 (粉色)
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

if (!TARGET_COLOR) {
    $done({});
    return;
}

var url = $request.url;
var body = $response.body;

if (!body || !url) {
    $done({});
    return;
}

if (!(url.includes('DmSegMobile') || url.includes('DmView') || url.includes('grpc.biliapi'))) {
    $done({});
    return;
}

// DmView: 清除颜色配置, 关闭渐变渲染
if (url.includes('DmView')) {
    handleDmViewPurify();
    return;
}

// DmSegMobile: 逐条替换弹幕颜色
handleDanmakuPurify(TARGET_COLOR);

/**
 * 弹幕净化主入口
 * 与 bili_purify.js 的 handleGrpcCommentAtFilter 结构一致:
 *   getResponseBytes → unwrap → modify → rewrap → setResponseBytes
 *
 * @param {number} targetColor - 目标 RGB 颜色值
 */
function handleDanmakuPurify(targetColor) {
    try {
        var rawBytes = getResponseBytes();
        if (!rawBytes || rawBytes.length < 2) {
            $done({});
            return;
        }

        // 自动检测并剥离 gRPC frame / gzip, 得到 protobuf 字节
        var decompressed = unwrap(rawBytes);
        if (!decompressed || decompressed.length === 0) {
            $done({});
            return;
        }

        // 替换弹幕颜色
        var modified = modifyDanmakuColor(decompressed, targetColor);

        if (modified === null) {
            $done({});  // 无变化, 透传
            return;
        }

        // 重新打包: protobuf → gzip → gRPC frame
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
 * 净化 DmView: 移除 DmColorConfig 颜色规则 + 关闭 dm_render_exp 渐变
 *
 * 客户端根据 DmView 返回的 DmColorConfig 对弹幕应用渐变色渲染,
 * 仅修改 DmSegMobile 中的 color 字段不足以阻止渐变效果。
 * 需要同时清理 DmView 配置:
 *   - fn=6 DmColorConfig: 整段移除
 *   - fn=23 JSON 字符串: 将 "dm_render_exp":<n> 替换为 "dm_render_exp":0
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
        console.log('BiliRoaming dmview purify error: ' + e);
        $done({});
    }
}

/**
 * 遍历 DmView protobuf:
 *   - 移除 fn=6 (DmColorConfig, wt=2) 字段
 *   - 修改 fn=23 (JSON string, wt=2) 中的 dm_render_exp 值
 *
 * @param {Uint8Array} buf - DmView protobuf 字节
 * @returns {Uint8Array|null} 修改后的字节, 无变化返回 null
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
            // 移除 DmColorConfig 整段 (gradient color rules)
            if (lastCopyEnd < off) {
                outputParts.push(buf.slice(lastCopyEnd, off));
            }
            off++; // skip tag
            var lenResult = readVarint(buf, off);
            off += lenResult[1] + Number(lenResult[0]);
            lastCopyEnd = off;
            changed = true;
        } else if (fn === 23 && wt === 2) {
            // 修改 JSON 字符串中的 dm_render_exp
            off++;
            var lenResult = readVarint(buf, off);
            var jsonLen = Number(lenResult[0]);
            var lenVarintLen = lenResult[1];
            off += lenVarintLen;

            var jsonBytes = buf.slice(off, off + jsonLen);
            off += jsonLen;

            var jsonStr = bytesToString(jsonBytes);
            // 将 "dm_render_exp":1 或 "dm_render_exp":2 等替换为 :0
            var newJsonStr = jsonStr.replace(/"dm_render_exp"\s*:\s*\d+/g, '"dm_render_exp":0');

            if (newJsonStr !== jsonStr) {
                if (lastCopyEnd < off - jsonLen - 1 - lenVarintLen) {
                    outputParts.push(buf.slice(lastCopyEnd, off - jsonLen - 1 - lenVarintLen));
                }
                var newJsonBytes = stringToBytes(newJsonStr);
                var newLenVarint = encodeVarint(newJsonBytes.length);
                // tag: fn=23, wt=2 → (23<<3)|2 = 0xBA
                outputParts.push(new Uint8Array([0xBA]));
                outputParts.push(newLenVarint);
                outputParts.push(newJsonBytes);
                lastCopyEnd = off;
                changed = true;
            }
        } else {
            off = skipField(buf, off);
        }
    }

    if (!changed) return null;

    if (lastCopyEnd < buf.length) {
        outputParts.push(buf.slice(lastCopyEnd));
    }

    // 拼接
    var totalLen = 0;
    for (var i = 0; i < outputParts.length; i++) totalLen += outputParts[i].length;
    var result = new Uint8Array(totalLen);
    var pos = 0;
    for (var i = 0; i < outputParts.length; i++) {
        result.set(outputParts[i], pos);
        pos += outputParts[i].length;
    }

    console.log('BiliRoaming dmview purify: removed DmColorConfig, disabled dm_render_exp');
    return result;
}

/**
 * Uint8Array → ASCII string
 * 仅用于 JSON 解析, 输入必须是 ASCII 安全字节
 */
function bytesToString(bytes) {
    var str = '';
    for (var i = 0; i < bytes.length; i++) {
        str += String.fromCharCode(bytes[i]);
    }
    return str;
}

/**
 * ASCII string → Uint8Array
 */
function stringToBytes(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i) & 0xFF;
    }
    return bytes;
}

/**
 * varint 编码: uint32 → Uint8Array
 * 每字节低 7 位存数据, 最高位为 1 表示后续还有字节
 *
 * @param {number} v - 要编码的无符号整数
 * @returns {Uint8Array}
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

/**
 * 遍历 DmSegMobileReply protobuf, 对每个 DanmakuElem 替换弹幕颜色
 *
 * Protobuf 结构:
 *   DmSegMobileReply:
 *     repeated DanmakuElem elems = 1;   (tag 0x0A, field 1, wire type 2)
 *
 *   DanmakuElem:
 *     uint32 color = 5;                  (wire type 0, varint)
 *
 * 策略: 逐 field 拷贝到输出 buffer。遇到 field 1 wt 2 (DanmakuElem) 时,
 * 调用 rebuildElemWithColor 检查并替换颜色; 若颜色未被修改则直接拷贝原文。
 *
 * @param {Uint8Array} buf - DmSegMobileReply protobuf 字节
 * @param {number} targetColor - 目标 RGB 颜色值
 * @returns {Uint8Array|null} 修改后的 protobuf, 无变化返回 null
 */
function modifyDanmakuColor(buf, targetColor) {
    var off = 0;
    var outputParts = [];
    var changedCount = 0;
    var lastCopyEnd = 0;

    while (off < buf.length) {
        var tag = buf[off];
        var fn = tag >> 3;
        var wt = tag & 0x07;

        if (fn === 1 && wt === 2) {
            // DanmakuElem 嵌套消息: tag 0x0A (field 1, wire type 2)
            off++;

            var lenResult = readVarint(buf, off);
            var elemLen = Number(lenResult[0]);
            var lenVarintLen = lenResult[1];
            off += lenVarintLen;

            var elemStart = off - 1 - lenVarintLen;  // tag 字节位置
            var elemBytes = buf.slice(off, off + elemLen);
            off += elemLen;

            // 检查并替换颜色
            var newElemBytes = rebuildElemWithColor(elemBytes, targetColor);
            if (newElemBytes !== null) {
                // 颜色已修改, 写入新 elem
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

    console.log('BiliRoaming danmaku purify: changed ' + changedCount + ' danmaku colors');
    return result;
}

/**
 * 重建单个 DanmakuElem 消息, 将 color field (fn=5, wt=0) 替换为目标色
 *
 * 逐 field 扫描 elemBytes: color field 用新 varint 替换, 其余 field 原样拷贝。
 * 这样可正确处理 varint 长度变化 (3B→4B 或 4B→3B) 而无需手动调整偏移。
 *
 * @param {Uint8Array} elemBytes - 单个 DanmakuElem 的 protobuf 字节
 * @param {number} targetColor - 目标 RGB 颜色值
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
            // color field: varint
            off++;
            var colorResult = readVarint(elemBytes, off);
            var oldColor = Number(colorResult[0]);
            var oldVarintLen = colorResult[1];
            off += oldVarintLen;

            if (oldColor !== 0xFFFFFF && oldColor !== targetColor) {
                // 需要替换为目标色
                var newVarint = encodeVarint(targetColor);
                var newField = new Uint8Array(1 + newVarint.length);
                newField[0] = 0x28;  // field 5, wire type 0
                newField.set(newVarint, 1);
                newParts.push(newField);
                newTotalLen += newField.length;
                changed = true;
            } else {
                // 已经是白色或目标色, 原样拷贝
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

    // 组装新 elem
    var result = new Uint8Array(newTotalLen);
    var pos = 0;
    for (var i = 0; i < newParts.length; i++) {
        result.set(newParts[i], pos);
        pos += newParts[i].length;
    }
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

// ==================== gRPC 解包 / 打包 ====================

/**
 * 自动检测格式并解包到 protobuf
 * 支持: gRPC+gzip, gRPC+raw, gzip, 裸 protobuf
 */
function unwrap(rawBytes) {
    var buf = rawBytes;

    // 1. 检测 gRPC frame: 首字节为 flag (0x00 或 0x01), 后 4 字节 BE 长度
    if (buf.length >= 5 && (buf[0] === 0x00 || buf[0] === 0x01)) {
        var claimedLen = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];
        var actualAvail = buf.length - 5;
        if (claimedLen > 0 && claimedLen <= actualAvail + 100) {
            buf = buf.slice(5, 5 + Math.min(claimedLen, actualAvail));
        }
    }

    // 2. 尝试 gzip 解压 (gzip magic: 0x1F 0x8B)
    if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) {
        var decompressed = ungzip(buf);
        if (decompressed) return decompressed;
    }

    // 3. 已经是裸 protobuf
    return buf;
}

/**
 * 反向打包: protobuf → gzip → gRPC frame
 */
function rewrap(originalRaw, protobufBytes) {
    var compressed = gzip(protobufBytes);
    if (!compressed) return null;

    // 检测原始响应是否有 gRPC frame
    if (originalRaw.length >= 5 && (originalRaw[0] === 0x00 || originalRaw[0] === 0x01)) {
        var flag = originalRaw[0];
        var frame = new Uint8Array(5 + compressed.length);
        frame[0] = flag;
        frame[1] = (compressed.length >>> 24) & 0xFF;
        frame[2] = (compressed.length >>> 16) & 0xFF;
        frame[3] = (compressed.length >>> 8) & 0xFF;
        frame[4] = compressed.length & 0xFF;
        frame.set(compressed, 5);
        return frame;
    }

    // 无 frame: 直接返回压缩后数据
    return compressed;
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

/** 跳过一个 protobuf field (tag 已消费) */
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
