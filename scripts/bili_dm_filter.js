/**
 * BiliRoaming - 弹幕过滤
 *
 * 1. 弹幕等级过滤 — 根据用户等级屏蔽低等级弹幕
 * 2. 渐变色弹幕过滤 — 移除 VIP 专属渐变色弹幕
 *
 * 拦截接口:
 *   - grpc.biliapi.net/bilibili.community.service.dm.v1.DM/DmSegMobile
 *     gRPC + gzip-compressed protobuf DmSegMobileReply
 *
 * 响应格式（自动检测）:
 *   A. gRPC frame (5B) → gzip → protobuf   (Surge, 部分 Loon 版本)
 *   B. gzip → protobuf                       (Loon 自动剥离 frame)
 *   C. 裸 protobuf                           (Loon 自动解压)
 *
 * DmSegMobileReply protobuf:
 *   repeated DanmakuElem elems = 1;  (tag 0x0A, wire type 2)
 *
 * DanmakuElem 关键字段:
 *   uint32 color  = 5;  (tag 0x28)  普通颜色为 RGB 整数值, 60001 = VIP 渐变色
 *   int32  weight = 9;  (tag 0x48)  弹幕权重, 值域 0~9
 *   int32  pool   = 11; (tag 0x58)  0=普通, 1=字幕, 2=特殊
 *   int32  attr   = 13; (tag 0x68)  属性位掩码
 *
 * 参数 (argument):
 *   dm_level=0       弹幕等级过滤 (0=不过滤, 1~6=屏蔽 weight 低于该值的弹幕)
 *   dm_gradient=false 过滤渐变色弹幕
 *
 * 适用于: Loon (优先), Surge
 * Update: 2026-06-24 v3
 */

// ==================== 参数解析 ====================

const DM_LEVEL = parseInt(readArg('dm_level', '0'), 10) || 0;
const DM_GRADIENT = readArg('dm_gradient', false) === true ||
    readArg('dm_gradient', false) === 'true';

const ENABLED = DM_LEVEL > 0 || DM_GRADIENT;

const url = $request.url;

if (!ENABLED) {
    $done({});
    return;
}

// 匹配 DmSegMobile gRPC 或 /x/v2/dm REST
if (!url.includes('DmSegMobile') && !url.includes('/x/v2/dm')) {
    $done({});
    return;
}

// ==================== 主流程 ====================

try {
    const rawBytes = getResponseBytes();
    if (!rawBytes || rawBytes.length < 2) {
        $done({});
        return;
    }

    // 自动检测并剥离 gRPC frame / gzip, 得到 protobuf 字节
    const decompressed = unwrap(rawBytes);
    if (!decompressed || decompressed.length === 0) {
        $done({});
        return;
    }

    // 过滤 protobuf DanmakuElem
    const filtered = filterDanmakuElems(decompressed);

    if (filtered === null) {
        $done({});  // 无变化, 透传
        return;
    }

    // 重新包装: protobuf → gzip → gRPC frame
    const output = rewrap(rawBytes, filtered);
    if (!output) {
        $done({});
        return;
    }

    setResponseBytes(output);

} catch (e) {
    console.log(`BiliRoaming dm_filter error: ${e}`);
    $done({});
}

// ==================== 响应解包 / 打包 ====================

/**
 * 自动检测格式并解包到 protobuf
 * 支持: gRPC+gzip, gzip, 裸 protobuf
 */
function unwrap(rawBytes) {
    let buf = rawBytes;

    // 1. 检测 gRPC frame: 首字节为 flag (0x00 或 0x01), 后 4 字节 BE 长度
    if (buf.length >= 5 && (buf[0] === 0x00 || buf[0] === 0x01)) {
        const claimedLen = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];
        const actualAvail = buf.length - 5;
        // 验证: 长度合理 (不超过可用字节数 + 合理偏差)
        if (claimedLen > 0 && claimedLen <= actualAvail + 100) {
            buf = buf.slice(5, 5 + Math.min(claimedLen, actualAvail));
        }
        // 如果长度不合理, 不剥离 (可能不是 gRPC frame)
    }

    // 2. 尝试 gzip 解压 (gzip magic: 0x1F 0x8B)
    if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) {
        const decompressed = ungzip(buf);
        if (decompressed) return decompressed;
    }

    // 3. 已经是裸 protobuf
    return buf;
}

/**
 * 反向打包: protobuf → gzip → gRPC frame
 */
function rewrap(originalRaw, protobufBytes) {
    const compressed = gzip(protobufBytes);
    if (!compressed) return null;

    // 检测原始响应是否有 gRPC frame
    if (originalRaw.length >= 5 && (originalRaw[0] === 0x00 || originalRaw[0] === 0x01)) {
        const flag = originalRaw[0];
        const frame = new Uint8Array(5 + compressed.length);
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

// ==================== 弹幕过滤逻辑 ====================

/**
 * 扫描 DmSegMobileReply protobuf, 移除匹配的 DanmakuElem
 * @param {Uint8Array} buf - protobuf 字节
 * @returns {Uint8Array|null} 过滤后的字节, 无变化返回 null
 */
function filterDanmakuElems(buf) {
    let off = 0;
    const outputParts = [];
    let filteredCount = 0;
    let keptCount = 0;
    let lastCopyEnd = 0;

    while (off < buf.length) {
        const tag = buf[off];
        const fieldNum = tag >> 3;
        const wireType = tag & 0x07;

        if (fieldNum === 1 && wireType === 2) {
            // DanmakuElem 嵌套消息: tag 0x0A
            off++;

            const [length, vlen] = readVarint(buf, off);
            off += vlen;

            const elemStart = off - 1 - vlen;
            const elemBytes = buf.slice(off, off + Number(length));
            off += Number(length);

            if (shouldFilterElem(elemBytes)) {
                if (lastCopyEnd < elemStart) {
                    outputParts.push(buf.slice(lastCopyEnd, elemStart));
                }
                lastCopyEnd = off;
                filteredCount++;
            } else {
                keptCount++;
            }
        } else {
            // 跳过一个顶层字段
            off = skipField(buf, off);
        }
    }

    if (filteredCount === 0) return null;

    if (lastCopyEnd < buf.length) {
        outputParts.push(buf.slice(lastCopyEnd));
    }

    if (outputParts.length === 0) {
        console.log(`BiliRoaming dm_filter: all filtered (${filteredCount})`);
        return new Uint8Array(0);
    }

    if (outputParts.length === 1) {
        console.log(`BiliRoaming dm_filter: kept=${keptCount}, filtered=${filteredCount}`);
        return outputParts[0];
    }

    let totalLen = 0;
    for (const p of outputParts) totalLen += p.length;
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const p of outputParts) {
        result.set(p, pos);
        pos += p.length;
    }

    console.log(`BiliRoaming dm_filter: kept=${keptCount}, filtered=${filteredCount}`);
    return result;
}

/**
 * 检查单个 DanmakuElem 是否应被过滤
 * @param {Uint8Array} elem - DanmakuElem protobuf 字节 (不含外层 tag+length)
 */
function shouldFilterElem(elem) {
    let off = 0;
    let weight = 0;
    let color = 0;
    let pool = 0;
    let attr = 0;

    while (off < elem.length) {
        const tag = elem[off];
        const fn = tag >> 3;
        const wt = tag & 0x07;
        off++;

        if (wt === 0) {
            const [val, vlen] = readVarint(elem, off);
            off += vlen;
            if (fn === 9) weight = Number(val);
            else if (fn === 5) color = Number(val);
            else if (fn === 11) pool = Number(val);
            else if (fn === 13) attr = Number(val);
        } else {
            off = skipFieldPayload(elem, off, wt);
        }
    }

    if (DM_LEVEL > 0 && weight < DM_LEVEL) return true;

    if (DM_GRADIENT) {
        if (color === 60001) return true;
        if (pool === 2) return true;
        if (attr & (0x1 | 0x4)) return true;
    }

    return false;
}

// ==================== Protobuf 辅助 ====================

function readVarint(buf, offset) {
    let result = 0n;
    let shift = 0n;
    let read = 0;
    while (offset + read < buf.length) {
        const b = BigInt(buf[offset + read]);
        read++;
        result |= (b & 0x7Fn) << shift;
        shift += 7n;
        if (!(b & 0x80n)) break;
    }
    return [result, read];
}

/** 跳过一个 protobuf 字段 (tag 已消费) */
function skipField(buf, off) {
    if (off >= buf.length) return off;
    const tag = buf[off];
    const wt = tag & 0x07;
    off++;
    return skipFieldPayload(buf, off, wt);
}

function skipFieldPayload(buf, off, wt) {
    if (wt === 0) {
        const [, vlen] = readVarint(buf, off);
        return off + vlen;
    } else if (wt === 2) {
        const [len, vlen] = readVarint(buf, off);
        return off + vlen + Number(len);
    } else if (wt === 5) {
        return off + 4;
    } else if (wt === 1) {
        return off + 8;
    }
    return off; // wt 3,4 (start/end group) — 废弃
}

// ==================== IO 层 (Loon 优先) ====================

/**
 * 获取响应原始字节
 * Loon:  $response.body 为 base64 字符串
 * Surge: $response.bodyBytes 为 Uint8Array
 */
function getResponseBytes() {
    // Loon 优先: base64 字符串 body
    if (typeof $response.body === 'string' && $response.body.length > 0) {
        const bytes = decodeBase64($response.body);
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
    // Loon 优先: 输出 base64 body
    const b64 = encodeBase64(bytes);
    $done({ body: b64 });
}

// ==================== Base64 (优先使用内置, 回退手动) ====================

function decodeBase64(str) {
    // Loon / Surge 内置
    if (typeof $utils !== 'undefined' && typeof $utils.base64ToBytes === 'function') {
        try {
            const result = $utils.base64ToBytes(str);
            if (result) return result;
        } catch (e) { /* fall through */ }
    }
    // 手动解码
    return manualBase64ToBytes(str);
}

function encodeBase64(bytes) {
    // Loon / Surge 内置
    if (typeof $utils !== 'undefined' && typeof $utils.bytesToBase64 === 'function') {
        try {
            const result = $utils.bytesToBase64(bytes);
            if (result) return result;
        } catch (e) { /* fall through */ }
    }
    // 手动编码
    return manualBytesToBase64(bytes);
}

// ==================== gzip (统一走 $utils) ====================

function ungzip(data) {
    if (typeof $utils !== 'undefined' && typeof $utils.ungzip === 'function') {
        try {
            const result = $utils.ungzip(data);
            if (result) return result;
        } catch (e) { /* fall through */ }
    }
    return null;
}

function gzip(data) {
    if (typeof $utils !== 'undefined' && typeof $utils.gzip === 'function') {
        try {
            const result = $utils.gzip(data);
            if (result) return result;
        } catch (e) { /* fall through */ }
    }
    return null;
}

// ==================== 手动 Base64 (无 $utils 时的回退) ====================

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function manualBase64ToBytes(b64) {
    // 仅对看起来像 base64 的字符串解码
    if (b64.length < 10 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
    let s = b64.replace(/[^A-Za-z0-9+/]/g, '');
    const outLen = Math.floor((s.length * 3) / 4);
    const result = new Uint8Array(outLen);
    let idx = 0;
    for (let i = 0; i < s.length; i += 4) {
        const c0 = B64.indexOf(s[i]);
        const c1 = B64.indexOf(s[i + 1]);
        const c2 = i + 2 < s.length ? B64.indexOf(s[i + 2]) : 0;
        const c3 = i + 3 < s.length ? B64.indexOf(s[i + 3]) : 0;
        if (c0 < 0 || c1 < 0) return null;
        result[idx++] = (c0 << 2) | (c1 >> 4);
        if (idx < outLen) result[idx++] = ((c1 & 0xF) << 4) | (c2 >> 2);
        if (idx < outLen) result[idx++] = ((c2 & 0x3) << 6) | c3;
    }
    return result;
}

function manualBytesToBase64(bytes) {
    let result = '';
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < len ? bytes[i + 1] : 0;
        const b2 = i + 2 < len ? bytes[i + 2] : 0;
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
        const m = $argument.match(new RegExp(key + '=([^&]*)'));
        if (m) return m[1];
        if ($argument && !$argument.includes('=')) return $argument;
    }
    return def;
}
