/**
 * BiliRoaming - 复制长链接（替换 b23.tv 短链接）
 * 
 * 拦截 B站分享 API，将返回的 b23.tv 短链接替换为完整长链接
 * 
 * 拦截接口:
 *   - api.bilibili.com/x/share/click (POST)   短链接生成
 * 
 * 策略:
 *   1. b23.tv/BVxxx    → 直接提取 BV 号拼接长链
 *   2. b23.tv/avxxx    → 直接提取 AV 号拼接长链
 *   3. b23.tv/随机码   → 从请求参数 oid + share_id 拼接长链
 * 
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2024
 */

const method = $request.method;
const body = $response.body;

if (!body || method !== 'POST') {
    $done({});
    return;
}

// 解析请求体，用于随机短码兜底构造长链
let reqBody = {};
try {
    if ($request.body) {
        reqBody = JSON.parse($request.body);
    }
} catch (_) { }

try {
    let obj = JSON.parse(body);

    if (obj.code !== 0 || !obj.data || !obj.data.content) {
        $done({});
        return;
    }

    const content = obj.data.content;

    // 尝试从短链接中直接提取视频标识
    const shortLinkPattern = /https?:\/\/(?:bili2233\.cn|b23\.tv)\/(\S+)/;
    const match = content.match(shortLinkPattern);

    if (match) {
        const shortPath = match[1];
        let longUrl = resolveShortUrl(shortPath, reqBody);

        if (longUrl) {
            // 替换内容中的短链接
            const newContent = content.replace(
                /https?:\/\/(?:bili2233\.cn|b23\.tv)\/\S+/,
                longUrl
            );
            obj.data.content = newContent;
        }
    }

    $done({ body: JSON.stringify(obj) });

} catch (e) {
    console.log(`BiliRoaming long_link error: ${e}`);
    $done({});
}

/**
 * 从短链接路径解析出完整长链接
 */
function resolveShortUrl(shortPath, reqBody) {
    // 清理可能的多余字符（空格、问号后的参数等）
    shortPath = shortPath.replace(/[\s\?].*$/, '');

    // b23.tv/BV1GJ411x7h7 → https://www.bilibili.com/video/BV1GJ411x7h7
    const bvMatch = shortPath.match(/^(BV[A-Za-z0-9]{10})/);
    if (bvMatch) {
        return `https://www.bilibili.com/video/${bvMatch[1]}`;
    }

    // b23.tv/av80433022 → https://www.bilibili.com/video/av80433022
    const avMatch = shortPath.match(/^(av\d+)/i);
    if (avMatch) {
        return `https://www.bilibili.com/video/${avMatch[1]}`;
    }

    // SS 番剧: b23.tv/ss12345 格式 (部分情况)
    const ssMatch = shortPath.match(/^(ss\d+)/i);
    if (ssMatch) {
        return `https://www.bilibili.com/bangumi/play/${ssMatch[1]}`;
    }

    // EP 单集: b23.tv/ep12345 格式 (部分情况)
    const epMatch = shortPath.match(/^(ep\d+)/i);
    if (epMatch) {
        return `https://www.bilibili.com/bangumi/play/${epMatch[1]}`;
    }

    // === 随机短码兜底：从请求参数构造长链 ===
    // x/share/click 请求体包含 oid（对象ID）和 type（类型）
    // type: 1=番剧, 2=视频, 3=音频, 4=相簿, etc.
    const oid = reqBody?.oid;
    if (oid) {
        const type = reqBody?.type;
        // 番剧
        if (type === 1) {
            return `https://www.bilibili.com/bangumi/play/ss${oid}`;
        }
        // 视频（纯数字视为 av 号）
        if (String(oid).match(/^\d+$/)) {
            return `https://www.bilibili.com/video/av${oid}`;
        }
    }

    return null;
}
