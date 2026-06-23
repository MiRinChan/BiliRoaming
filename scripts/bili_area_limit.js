/**
 * BiliRoaming - 解除B站番剧区域限制
 * 
 * 通过修改 B站 API 响应中的区域限制字段来解锁番剧
 * 
 * 拦截接口:
 *   - api.bilibili.com/pgc/view/v2/app/season      番剧详情
 *   - api.bilibili.com/pgc/player/api/playurl       播放地址(PGC)
 *   - api.bilibili.com/x/tv/playurl                 TV播放地址
 *   - api.bilibili.com/intl/gateway/v2/ogv/playurl  国际版播放地址
 * 
 * 修改字段:
 *   - area_limit: 1 → 0      解除区域限制
 *   - allow_dm: 0 → 1        允许弹幕
 *   - allow_download: 0 → 1  允许下载
 * 
 * 参数 (argument):
 *   area=unlock  解除区域限制（默认）
 *   area=off     不处理，直接放行
 * 
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026
 */

// === 解析参数 ===
// Loon: $argument 是对象 { area: "unlock" }；Surge: $argument 是字符串 "area=unlock"
const AREA = readArg('area', 'unlock'); // unlock | off

const url = $request.url;
const body = $response.body;

if (!body || AREA === 'off') {
    $done({});
    return;
}

try {
    let obj = JSON.parse(body);

    // 处理番剧详情接口: pgc/view/v2/app/season
    if (url.includes('/pgc/view/')) {
        obj = fixSeasonData(obj);
    }

    // 处理播放地址接口: pgc/player, x/tv/playurl, intl/gateway playurl
    if (url.includes('/playurl') || url.includes('pgc/player') || url.includes('/x/tv/')) {
        obj = fixPlayurlData(obj);
    }

    // 搜索接口：移除搜索结果中的区域限制标记
    if (url.includes('/x/v') && url.includes('/search')) {
        obj = fixSearchData(obj);
    }

    $done({ body: JSON.stringify(obj) });

} catch (e) {
    console.log(`BiliRoaming area_limit error: ${e}`);
    $done({});
}

/**
 * 修复番剧详情数据
 */
function fixSeasonData(obj) {
    if (!obj || obj.code !== 0) return obj;

    const data = obj.data || obj.result;
    if (!data) return obj;

    // 主番剧信息
    fixAreaLimit(data);

    // 剧集列表 (episodes)
    if (Array.isArray(data.episodes)) {
        data.episodes.forEach(ep => fixAreaLimit(ep));
    }

    // 季列表 (seasons)
    if (Array.isArray(data.seasons)) {
        data.seasons.forEach(season => fixAreaLimit(season));
    }

    // 模块数据 (modules - 用于豆瓣评分/区域标记)
    if (data.modules) {
        if (Array.isArray(data.modules)) {
            data.modules.forEach(mod => {
                if (mod && typeof mod === 'object') {
                    delete mod['area_limit'];
                    mod['area_limit'] = 0;
                }
            });
        }
    }

    // 移除区域限制提示
    if (data.badge_info && data.badge_info.text) {
        data.badge_info.text = data.badge_info.text.replace(/[受僅限定][区区]?/, '');
    }
    if (data.evaluate) {
        data.evaluate = data.evaluate.replace(/[受僅限定][区区]?/, '');
    }

    return obj;
}

/**
 * 修复播放地址数据
 */
function fixPlayurlData(obj) {
    if (!obj) return obj;

    // 如果 code 为 -404 (区域限制失败)，尝试恢复
    if (obj.code === -404) {
        obj.code = 0;
        obj.message = '0';
    }

    if (obj.code !== 0) return obj;

    const data = obj.data || obj.result;
    if (!data) return obj;

    fixAreaLimit(data);

    // 修复 dash 视频流
    if (data.dash) {
        fixAreaLimit(data.dash);
    }

    // 修复 durl 视频流
    if (Array.isArray(data.durl)) {
        data.durl.forEach(d => fixAreaLimit(d));
    }

    return obj;
}

/**
 * 修复搜索结果数据
 */
function fixSearchData(obj) {
    if (!obj || obj.code !== 0) return obj;

    const data = obj.data || obj.result;
    if (!data) return obj;

    // 搜索结果中的番剧列表
    const items = data.result || data.items;
    if (Array.isArray(items)) {
        items.forEach(item => {
            if (item) {
                fixAreaLimit(item);
                // 移除区域限制标记
                if (item.badge) {
                    item.badge = item.badge.replace(/[受僅限定][区区]?/, '');
                }
            }
        });
    }

    return obj;
}

/**
 * 通用区域限制修复
 */
function fixAreaLimit(obj) {
    if (!obj || typeof obj !== 'object') return;

    // 解除 area_limit
    if (obj.hasOwnProperty('area_limit') && obj.area_limit === 1) {
        obj.area_limit = 0;
    }

    // 允许弹幕
    if (obj.hasOwnProperty('allow_dm') && obj.allow_dm === 0) {
        obj.allow_dm = 1;
    }

    // 允许下载
    if (obj.hasOwnProperty('allow_download') && obj.allow_download === 0) {
        obj.allow_download = 1;
    }

    // 允许评论
    if (obj.hasOwnProperty('allow_comment') && obj.allow_comment === 0) {
        obj.allow_comment = 1;
    }

    // 允许点播
    if (obj.hasOwnProperty('allow_demand') && obj.allow_demand === 0) {
        obj.allow_demand = 1;
    }

    // 修复 area 字段(某些情况下返回 restricted)
    if (obj.area === 'restricted' || obj.area === '') {
        obj.area = 'cn';
    }
}

/**
 * 读取插件参数（兼容 Loon $argument 对象 & Surge $argument 字符串）
 */
function readArg(key, def) {
    if (typeof $argument === 'object' && $argument) return $argument[key] || def;
    if (typeof $argument === 'string') {
        const m = $argument.match(new RegExp(key + '=([^&]*)'));
        if (m) return m[1];
    }
    return def;
}
