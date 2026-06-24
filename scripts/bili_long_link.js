/**
 * BiliRoaming - 链接净化（替换 b23.tv 短链接）
 *
 * 拦截 B站分享 API，根据设置将 b23.tv 短链接替换为指定格式
 *
 * 拦截接口:
 *   - api.bilibili.com/x/share/click (POST)   短链接生成
 *
 * 参数 (argument):
 *   mode=short  不替换（默认）
 *   mode=av     替换为 av 号链接  bilibili.com/video/av{oid}
 *   mode=bv     替换为 BV 号链接  bilibili.com/video/BVxxxxx
 *
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026
 */

// === 解析参数 ===
// Loon: $argument 是对象 { mode: "av" }；Surge: $argument 是字符串 "mode=av"
const MODE = readArg('mode', 'short'); // short | av | bv
if (!['short', 'av', 'bv'].includes(MODE)) {
    console.log(`BiliRoaming long_link invalid arg: ${MODE}`);
    $done({});
    return;
}

const method = $request.method;
const body = $response.body;

if (!body || method !== 'POST') {
    $done({});
    return;
}

// SHORT 模式: 不处理，直接放行
if (MODE === 'short') {
    $done({});
    return;
}

// AV 模式需要解析请求体获取 oid
let reqBody = {};
if (MODE === 'av' && $request.body) {
    try {
        $request.body.split('&').forEach(pair => {
            const idx = pair.indexOf('=');
            if (idx > 0) {
                reqBody[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
            }
        });
    } catch (_) { }
}

try {
    let obj = JSON.parse(body);

    if (obj.code !== 0 || !obj.data || !obj.data.content) {
        $done({});
        return;
    }

    const content = obj.data.content;

    const shortLinkRe = /https?:\/\/(?:bili2233\.cn|b23\.tv)\/(\S+)/;
    const match = content.match(shortLinkRe);

    if (!match) {
        $done({ body: JSON.stringify(obj) });
        return;
    }

    const shortPath = match[1].replace(/[\s\?].*$/, '');

    if (MODE === 'av') {
        // AV 模式: 从请求体 oid 构造 av 号链接
        const oid = reqBody['oid'];
        if (oid && /^\d+$/.test(String(oid))) {
            const avUrl = `https://www.bilibili.com/video/av${oid}`;
            obj.data.content = content.replace(shortLinkRe, avUrl);
            $done({ body: JSON.stringify(obj) });
            return;
        }
        // 兜底: 尝试从路径提取 av 号
        const avFromPath = shortPath.match(/^(av\d+)/i);
        if (avFromPath) {
            obj.data.content = content.replace(shortLinkRe, `https://www.bilibili.com/video/${avFromPath[1]}`);
        }
        $done({ body: JSON.stringify(obj) });
        return;
    }

    if (MODE === 'bv') {
        // BV 模式: 优先从路径直接提取
        const directUrl = extractBvUrl(shortPath);
        if (directUrl) {
            obj.data.content = content.replace(shortLinkRe, directUrl);
            $done({ body: JSON.stringify(obj) });
            return;
        }
        // 随机短码 → 跟随重定向获取 BV 链接
        resolveRedirect(shortPath, resolvedUrl => {
            if (resolvedUrl) {
                obj.data.content = content.replace(shortLinkRe, resolvedUrl);
            }
            $done({ body: JSON.stringify(obj) });
        });
        return;
    }

    $done({ body: JSON.stringify(obj) });

} catch (e) {
    console.log(`BiliRoaming long_link error: ${e}`);
    $done({});
}

/**
 * 从短路径直接提取 BV/AV/SS/EP 链接（BV 模式用）
 */
function extractBvUrl(shortPath) {
    const bvMatch = shortPath.match(/^(BV[A-Za-z0-9]{10})/);
    if (bvMatch) return `https://www.bilibili.com/video/${bvMatch[1]}`;

    const avMatch = shortPath.match(/^(av\d+)/i);
    if (avMatch) return `https://www.bilibili.com/video/${avMatch[0]}`;

    const ssMatch = shortPath.match(/^(ss\d+)/i);
    if (ssMatch) return `https://www.bilibili.com/bangumi/play/${ssMatch[1]}`;

    const epMatch = shortPath.match(/^(ep\d+)/i);
    if (epMatch) return `https://www.bilibili.com/bangumi/play/${epMatch[1]}`;

    return null;
}

/**
 * HTTP HEAD 跟随 b23.tv 重定向（BV 模式兜底）
 * 兼容 Surge ($httpClient)、Loon ($httpClient)、Quantumult X ($task)
 */
function resolveRedirect(shortPath, callback) {
    const url = `https://b23.tv/${shortPath}`;
    let settled = false;

    // 3 秒超时兜底，防止请求挂起导致响应阻塞
    const timeout = setTimeout(() => {
        if (!settled) { settled = true; callback(null); }
    }, 3000);

    const done = (result) => {
        if (!settled) { settled = true; clearTimeout(timeout); callback(result); }
    };

    if (typeof $httpClient !== 'undefined') {
        // Surge/Loon: 跟随重定向前捕获 Location 头
        $httpClient.head({ url, 'auto-redirect': false }, (error, response) => {
            if (!error && response) {
                const loc = (response.headers && (response.headers.Location || response.headers.location))
                    || (response.status === 302 && response.url && response.url !== url && response.url);
                if (loc) return done(loc);
            }
            done(null);
        });
    } else if (typeof $task !== 'undefined') {
        // Quantumult X
        $task.fetch({ url, method: 'HEAD' }).then(
            response => {
                const loc = response.headers?.Location || response.headers?.location;
                done(loc || null);
            },
            () => {
                done(null);
            }
        );
    } else {
        done(null);
    }
}

/**
 * 读取插件参数（兼容 Loon $argument 对象 & Surge $argument 字符串）
 */
function readArg(key, def) {
    if (typeof $argument === 'object' && $argument && key in $argument) return $argument[key];
    if (typeof $argument === 'string') {
        const m = $argument.match(new RegExp(key + '=([^&]*)'));
        if (m) return m[1];
        // Surge [{key}] template passes raw value without key= prefix
        if ($argument && !$argument.includes('=')) return $argument;
    }
    return def;
}
