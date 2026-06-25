/**
 * BiliRoaming - 解除B站番剧区域限制
 *
 * 通过修改 B站 API 响应中的区域限制字段来解锁番剧。
 * 当主 API 返回 code -404 时，通过海外 API 端点获取数据并重建响应。
 *
 * 拦截接口:
 *   - api.bilibili.com/pgc/view/v2/app/season      番剧详情
 *   - api.bilibili.com/pgc/player/api/playurl       播放地址(PGC)
 *   - api.bilibili.com/x/tv/playurl                 TV播放地址
 *   - api.bilibili.com/intl/gateway/v2/ogv/playurl  国际版播放地址
 *   - api.bilibili.com/x/v2/search                  搜索结果
 *   - api.bilibili.com/intl/gateway/v2/ogv/view/app/season  国际版番剧详情 (fallback)
 *
 * 修改字段:
 *   - area_limit: 1 → 0      解除区域限制
 *   - allow_dm: 0 → 1        允许弹幕
 *   - allow_download: 0 → 1  允许下载
 *   - status: 13 → 2         解锁 VIP 限定剧集
 *   - 移除 limit / dialog    清除区域限制标记
 *
 * 参数 (argument):
 *   area=true   解除区域限制
 *   area=false  不处理（默认关闭）
 *
 * 适用于: Loon, Surge, Quantumult X, Stash
 * Update: 2026-06-25 v3 — 添加海外 API 回退、剧集状态修复
 *
 * 参考: yujincheng08/BiliRoaming Xposed 模块
 *   - BangumiSeasonHook.fixBangumi()
 *   - BangumiPlayUrlHook.needProxy()
 *   - BiliRoamingApi.getPlayUrl() / fixThailandSeason()
 */

// === 解析参数 ===
const areaRaw = readArg('area', false);
if (areaRaw !== false && areaRaw !== true && areaRaw !== 'true' && areaRaw !== 'unlock') {
    console.log(`BiliRoaming area_limit invalid arg: ${areaRaw}`);
}
const ENABLED = areaRaw === true || areaRaw === 'true' || areaRaw === 'unlock';

const url = $request.url;
const body = $response.body;

if (!body || !ENABLED) {
    $done({});
    return;
}

let obj;
try {
    obj = JSON.parse(body);
} catch (e) {
    console.log(`BiliRoaming area_limit parse error: ${e}`);
    $done({});
    return;
}

// 判断当前拦截的接口类型
const isSeason = url.includes('/pgc/view/');
const isIntlSeason = url.includes('/intl/gateway/') && url.includes('/season');
const isPlayurl = url.includes('/playurl') || url.includes('pgc/player') || url.includes('/x/tv/');
const isSearch = url.includes('/x/v') && url.includes('/search');

// ============================================================
// 番剧详情 — 正常响应: 修复字段
// ============================================================
if ((isSeason || isIntlSeason) && obj.code === 0) {
    obj = fixSeasonData(obj);
    $done({ body: JSON.stringify(obj) });
    return;
}

// ============================================================
// 番剧详情 — 区域限制 (code -404): 通过海外 API 获取数据
// ============================================================
if (isSeason && obj.code === -404) {
    const seasonId = extractParam(url, 'season_id');
    if (!seasonId) {
        console.log('BiliRoaming area_limit: -404 but no season_id in URL');
        $done({});
        return;
    }
    const epId = extractParam(url, 'ep_id') || '';

    // 国际版 API (bstar) — 对同一内容可能有不同的区域限制策略
    const intlUrl = 'https://api.bilibili.com/intl/gateway/v2/ogv/view/app/season'
        + '?season_id=' + seasonId
        + (epId ? '&ep_id=' + epId : '')
        + '&s_locale=zh_SG'
        + '&mobi_app=bstar_a'
        + '&build=1080003';

    console.log(`BiliRoaming area_limit: -404 for season ${seasonId}, trying intl API`);

    fetchSeasonFromIntl(intlUrl, seasonId, function(fixedObj) {
        $done({ body: JSON.stringify(fixedObj) });
    });
    return;
}

// ============================================================
// 播放地址 — 正常响应: 修复字段
// ============================================================
if (isPlayurl && obj.code === 0) {
    obj = fixPlayurlData(obj);
    $done({ body: JSON.stringify(obj) });
    return;
}

// ============================================================
// 播放地址 — 区域限制 (code -404)
// ============================================================
if (isPlayurl && obj.code === -404) {
    const epId = extractParam(url, 'ep_id') || extractParam(url, 'avid') || '';
    const cid = extractParam(url, 'cid') || '';
    const qn = extractParam(url, 'qn') || '80';
    const fnval = extractParam(url, 'fnval') || '4048';
    const fourk = extractParam(url, 'fourk') || '1';

    if (!epId && !cid) {
        console.log('BiliRoaming area_limit: playurl -404 but no ep_id/cid in URL');
        $done({});
        return;
    }

    const intlUrl = 'https://api.bilibili.com/intl/gateway/v2/ogv/playurl'
        + '?ep_id=' + epId
        + '&cid=' + cid
        + '&qn=' + qn
        + '&fnval=' + fnval
        + '&fnver=0'
        + '&fourk=' + fourk;

    console.log(`BiliRoaming area_limit: playurl -404 for ep=${epId} cid=${cid}, trying intl API`);

    fetchPlayurlFromIntl(intlUrl, function(fixedObj) {
        $done({ body: JSON.stringify(fixedObj) });
    });
    return;
}

// ============================================================
// 搜索 — 正常响应: 修复字段
// ============================================================
if (isSearch && obj.code === 0) {
    obj = fixSearchData(obj);
    $done({ body: JSON.stringify(obj) });
    return;
}

// 其他情况: 透传
$done({});

// ============================================================
// 番剧详情修复
// ============================================================
function fixSeasonData(obj) {
    if (!obj || obj.code !== 0) return obj;

    const data = obj.data || obj.result;
    if (!data) return obj;

    // 主番剧信息: 修复区域限制 & 下载权限
    fixAreaLimit(data);
    allowDownload(data);

    // 剧集列表 (episodes)
    if (Array.isArray(data.episodes)) {
        data.episodes.forEach(function(ep) {
            fixAreaLimit(ep);
            allowDownload(ep);
            fixEpisodeStatus(ep);
        });
    }

    // 季列表 (seasons)
    if (Array.isArray(data.seasons)) {
        data.seasons.forEach(function(season) {
            fixAreaLimit(season);
            allowDownload(season);
        });
    }

    // 模块数据 (modules - 豆瓣评分/区域标记)
    if (data.modules) {
        if (Array.isArray(data.modules)) {
            data.modules.forEach(function(mod) {
                if (mod && typeof mod === 'object') {
                    // 模块级别的区域限制
                    if (Object.hasOwn(mod, 'area_limit')) {
                        mod.area_limit = 0;
                    }
                    // 模块内嵌剧集 (如 style 为正数的模块)
                    if (mod.data && Array.isArray(mod.data.episodes)) {
                        mod.data.episodes.forEach(function(ep) {
                            fixAreaLimit(ep);
                            allowDownload(ep);
                            fixEpisodeStatus(ep);
                        });
                    }
                }
            });
        }
    }

    // 预览区域 (prevueSection)
    if (data.prevueSection && Array.isArray(data.prevueSection)) {
        data.prevueSection.forEach(function(section) {
            if (section && Array.isArray(section.episodes)) {
                section.episodes.forEach(function(ep) {
                    fixAreaLimit(ep);
                    allowDownload(ep);
                });
            }
        });
    }

    // 正片区域 (section / sections)
    var sections = data.section || data.sections;
    if (Array.isArray(sections)) {
        sections.forEach(function(section) {
            if (section && Array.isArray(section.episodes)) {
                section.episodes.forEach(function(ep) {
                    fixAreaLimit(ep);
                    allowDownload(ep);
                    fixEpisodeStatus(ep);
                });
            }
        });
    }

    // 移除区域限制提示标记
    removeAreaBadges(data);

    // 移除 limit 和 dialog (region-lock UI 元素)
    delete data['limit'];
    data['limit'] = null;
    delete data['dialog'];
    data['dialog'] = null;

    return obj;
}

/**
 * 移除各处的区域限制文字标记
 */
function removeAreaBadges(data) {
    if (!data) return;

    // badge_info
    if (data.badge_info && data.badge_info.text) {
        data.badge_info.text = data.badge_info.text.replace(/[受僅限定][区区]?/g, '');
    }
    // evaluate
    if (data.evaluate) {
        data.evaluate = data.evaluate.replace(/[受僅限定][区区]?/g, '');
    }
    // 每集 badge
    if (Array.isArray(data.episodes)) {
        data.episodes.forEach(function(ep) {
            if (ep && ep.badge) {
                ep.badge = ep.badge.replace(/[受僅限定][区区]?/g, '');
            }
            if (ep && ep.long_title) {
                ep.long_title = ep.long_title.replace(/[受僅限定][区区]?/g, '');
            }
        });
    }
}

// ============================================================
// 播放地址修复
// ============================================================
function fixPlayurlData(obj) {
    if (!obj) return obj;

    // code -404: 区域限制失败，该响应通常无有效数据
    if (obj.code === -404) return obj;

    if (obj.code !== 0) return obj;

    var data = obj.data || obj.result;
    if (!data) return obj;

    fixAreaLimit(data);

    // 修复 dash 视频流
    if (data.dash) {
        fixAreaLimit(data.dash);
    }

    // 修复 durl 视频流
    if (Array.isArray(data.durl)) {
        data.durl.forEach(function(d) { fixAreaLimit(d); });
    }

    return obj;
}

// ============================================================
// 搜索结果修复
// ============================================================
function fixSearchData(obj) {
    if (!obj || obj.code !== 0) return obj;

    var data = obj.data || obj.result;
    if (!data) return obj;

    var items = data.result || data.items;
    if (Array.isArray(items)) {
        items.forEach(function(item) {
            if (item) {
                fixAreaLimit(item);
                // 移除区域限制标记
                if (item.badge) {
                    item.badge = item.badge.replace(/[受僅限定][区区]?/g, '');
                }
            }
        });
    }

    return obj;
}

// ============================================================
// 通用修复函数
// ============================================================

/**
 * 通用区域限制修复
 * 参照 Xposed 模块 fixRight() — 同时处理 area_limit 缺失的情况
 */
function fixAreaLimit(obj) {
    if (!obj || typeof obj !== 'object') return;

    // 处理 rights 子对象（如有）
    if (obj.rights && typeof obj.rights === 'object') {
        obj.rights.area_limit = 0;
        obj.rights.allow_dm = 1;
        obj.rights.allow_download = 1;
    }

    // 顶层字段
    if (Object.hasOwn(obj, 'area_limit') && obj.area_limit === 1) {
        obj.area_limit = 0;
    }

    if (Object.hasOwn(obj, 'allow_dm') && obj.allow_dm === 0) {
        obj.allow_dm = 1;
    }

    if (Object.hasOwn(obj, 'allow_download') && obj.allow_download === 0) {
        obj.allow_download = 1;
    }

    if (Object.hasOwn(obj, 'allow_comment') && obj.allow_comment === 0) {
        obj.allow_comment = 1;
    }

    if (Object.hasOwn(obj, 'allow_demand') && obj.allow_demand === 0) {
        obj.allow_demand = 1;
    }

    // 修复 area 字段（某些情况下返回 restricted）
    if (obj.area === 'restricted' || obj.area === '') {
        obj.area = '';
    }
}

/**
 * 设置 allow_download = 1（不依赖 fixAreaLimit 的 hasOwn 检查）
 * 参照 Xposed 模块 allowDownload() — 对嵌套对象强制设置
 */
function allowDownload(obj) {
    if (!obj || typeof obj !== 'object') return;

    // 直接设置（覆盖任何现有值）
    obj.allow_download = 1;

    // 同样处理 rights 子对象
    if (obj.rights && typeof obj.rights === 'object') {
        obj.rights.allow_download = 1;
        // only_vip_download → 0 允许非会员下载
        obj.rights.only_vip_download = 0;
    }
}

/**
 * 修复剧集状态: status 13 (VIP锁定/泰区会员限定) → 2 (已解锁)
 * 参照 Xposed 模块 fixEpisodesStatus()
 */
function fixEpisodeStatus(ep) {
    if (!ep || typeof ep !== 'object') return;

    if (ep.status === 13) {
        ep.status = 2;
    }
    if (ep.episode_status === 13) {
        ep.episode_status = 2;
    }

    // 清除 "泰区会员" 等限制标记
    if (ep.badge && /[泰会员VIP仅限]/.test(ep.badge)) {
        ep.badge = '';
    }
}

/**
 * 判断番剧是否有观看权限
 * 参照 Xposed 模块 isBangumiWithWatchPermission()
 * 注意: area_limit 缺失时默认视为限制 (optBoolean("area_limit", true))
 */
function hasWatchPermission(data) {
    if (!data) return false;

    // 检查 rights 对象
    if (data.rights && typeof data.rights === 'object') {
        var al = data.rights.area_limit;
        // area_limit === 0 或 false → 有权限; 缺失/1/true → 限制
        if (al === 0 || al === false) return true;
        if (al === 1 || al === true || al === undefined) return false;
    }

    // 没有 rights 对象时检查顶层
    if (Object.hasOwn(data, 'area_limit')) {
        return data.area_limit === 0;
    }

    // 默认视为有限制（更安全的默认值）
    return false;
}

// ============================================================
// 海外 API 回退
// ============================================================

/**
 * 从国际版 API 获取番剧详情（code -404 回退）
 * 参照 Xposed 模块 BiliRoamingApi.getSeason() + fixThailandSeason()
 */
function fetchSeasonFromIntl(intlUrl, seasonId, callback) {
    var settled = false;

    var timeout = setTimeout(function() {
        if (!settled) { settled = true; callback(obj); }
    }, 8000);

    function done(result) {
        if (!settled) { settled = true; clearTimeout(timeout); callback(result); }
    }

    if (typeof $httpClient !== 'undefined') {
        // Surge / Loon / Stash
        $httpClient.get(intlUrl, function(error, response, data) {
            if (!error && data) {
                try {
                    var intlObj = JSON.parse(data);
                    if (intlObj.code === 0) {
                        var rebuilt = rebuildSeasonFromIntl(intlObj, seasonId);
                        console.log('BiliRoaming area_limit: season restored from intl API for ' + seasonId);
                        done(rebuilt);
                        return;
                    }
                } catch (e) {
                    console.log('BiliRoaming area_limit: intl season parse error: ' + e);
                }
            }
            console.log('BiliRoaming area_limit: intl season fetch failed, pass-through -404');
            done(obj);
        });
        return;
    }

    if (typeof $task !== 'undefined' && typeof $task.fetch === 'function') {
        // Quantumult X
        $task.fetch(intlUrl).then(
            function(response) {
                try {
                    var intlObj = JSON.parse(response.body);
                    if (intlObj.code === 0) {
                        var rebuilt = rebuildSeasonFromIntl(intlObj, seasonId);
                        console.log('BiliRoaming area_limit: season restored from intl API for ' + seasonId);
                        done(rebuilt);
                        return;
                    }
                } catch (e) {
                    console.log('BiliRoaming area_limit: intl season parse error: ' + e);
                }
                done(obj);
            },
            function(err) {
                console.log('BiliRoaming area_limit: intl season fetch error: ' + err);
                done(obj);
            }
        );
        return;
    }

    // 无 HTTP 客户端可用: 透传
    console.log('BiliRoaming area_limit: no HTTP client available for season fallback');
    done(obj);
}

/**
 * 从国际版 API 获取播放地址（code -404 回退）
 */
function fetchPlayurlFromIntl(intlUrl, callback) {
    var settled = false;

    var timeout = setTimeout(function() {
        if (!settled) { settled = true; callback(obj); }
    }, 8000);

    function done(result) {
        if (!settled) { settled = true; clearTimeout(timeout); callback(result); }
    }

    if (typeof $httpClient !== 'undefined') {
        $httpClient.get(intlUrl, function(error, response, data) {
            if (!error && data) {
                try {
                    var intlObj = JSON.parse(data);
                    if (intlObj.code === 0) {
                        var rebuilt = rebuildPlayurlFromIntl(intlObj);
                        console.log('BiliRoaming area_limit: playurl restored from intl API');
                        done(rebuilt);
                        return;
                    }
                } catch (e) {
                    console.log('BiliRoaming area_limit: intl playurl parse error: ' + e);
                }
            }
            console.log('BiliRoaming area_limit: intl playurl fetch failed, pass-through -404');
            done(obj);
        });
        return;
    }

    if (typeof $task !== 'undefined' && typeof $task.fetch === 'function') {
        $task.fetch(intlUrl).then(
            function(response) {
                try {
                    var intlObj = JSON.parse(response.body);
                    if (intlObj.code === 0) {
                        var rebuilt = rebuildPlayurlFromIntl(intlObj);
                        console.log('BiliRoaming area_limit: playurl restored from intl API');
                        done(rebuilt);
                        return;
                    }
                } catch (e) {
                    console.log('BiliRoaming area_limit: intl playurl parse error: ' + e);
                }
                done(obj);
            },
            function(err) {
                console.log('BiliRoaming area_limit: intl playurl fetch error: ' + err);
                done(obj);
            }
        );
        return;
    }

    console.log('BiliRoaming area_limit: no HTTP client available for playurl fallback');
    done(obj);
}

/**
 * 用国际版 API (bstar) 响应重建标准番剧详情格式
 * 参照 Xposed 模块 fixThailandSeason() + fixBangumi() 合并逻辑
 *
 * 国际版 API 响应格式可能与 CN 版不同:
 *   - 用 result 而非 data 包装
 *   - episodes[] 字段名可能不同 (id→ep_id, title→index, long_title→indexTitle)
 *   - cid/aid 可能为 0
 */
function rebuildSeasonFromIntl(intlObj, seasonId) {
    var src = (intlObj.result || intlObj.data || {});
    if (!src || typeof src !== 'object') return obj;

    // === 构建基础响应（保留国际版的主体数据） ===
    var rebuilt = {
        code: 0,
        message: '0',
        result: {}
    };
    var result = rebuilt.result;

    // 复制顶层字段
    var topKeys = ['season_id', 'season_title', 'title', 'cover', 'horizontal_cover',
                    'evaluate', 'publish', 'type', 'type_name', 'subtitle', 'staff',
                    'style', 'styles', 'actor', 'actors', 'rating', 'stat', 'newest_ep',
                    'total', 'series', 'payment', 'user_status', 'up_info', 'short_link',
                    'share_url', 'record', 'positive'];
    topKeys.forEach(function(k) {
        if (src[k] !== undefined) result[k] = src[k];
    });

    // 强制 season_id
    result.season_id = parseInt(seasonId, 10) || seasonId;

    // === 转换剧集列表 ===
    if (Array.isArray(src.episodes)) {
        result.episodes = src.episodes.map(function(ep) {
            return normalizeEpisode(ep);
        });
    } else {
        result.episodes = [];
    }

    // === 转换模块 ===
    if (Array.isArray(src.modules)) {
        result.modules = src.modules.map(function(mod) {
            if (mod && mod.data && Array.isArray(mod.data.episodes)) {
                mod.data.episodes = mod.data.episodes.map(function(ep) {
                    return normalizeEpisode(ep);
                });
            }
            if (mod && Object.hasOwn(mod, 'area_limit')) {
                mod.area_limit = 0;
            }
            return mod;
        });
    } else {
        result.modules = [];
    }

    // === 转换预览/正片区域 ===
    ['prevueSection', 'section', 'sections'].forEach(function(key) {
        if (Array.isArray(src[key])) {
            result[key] = src[key].map(function(section) {
                if (section && Array.isArray(section.episodes)) {
                    section.episodes = section.episodes.map(function(ep) {
                        return normalizeEpisode(ep);
                    });
                }
                return section;
            });
        }
    });

    // === 修复权限 ===
    if (!result.rights) result.rights = {};
    result.rights.area_limit = 0;
    result.rights.allow_dm = 1;
    result.rights.allow_download = 1;
    result.rights.only_vip_download = 0;

    // === 用户状态 ===
    if (!result.user_status) result.user_status = {};
    result.user_status.follow = result.user_status.follow || 1;

    // === 清理 ===
    delete result['limit'];
    result['limit'] = null;
    delete result['dialog'];
    result['dialog'] = null;

    // actor 字段兼容（国际版用 actors 字符串）
    if (!result.actor && src.actors) {
        result.actor = { info: String(src.actors) };
    }

    return rebuilt;
}

/**
 * 规范化剧集对象字段名
 * 国际版 API 可能使用不同字段名
 */
function normalizeEpisode(ep) {
    if (!ep || typeof ep !== 'object') return ep;

    // 字段名映射
    if (ep.id !== undefined && ep.ep_id === undefined) {
        ep.ep_id = ep.id;
    }
    if (ep.title !== undefined && ep.index === undefined) {
        ep.index = ep.title;
    }
    if (ep.long_title !== undefined && ep.indexTitle === undefined) {
        ep.indexTitle = ep.long_title;
    }

    // 修复缺失的 cid / aid（国际版可能返回 0）
    if (!ep.cid || ep.cid === 0) {
        ep.cid = ep.ep_id || 0;
    }
    if (!ep.aid || ep.aid === 0) {
        ep.aid = ep.ep_id || 0;
    }

    // 修复权限字段
    if (!ep.rights) ep.rights = {};
    ep.rights.area_limit = 0;
    ep.rights.allow_dm = 1;
    ep.rights.allow_download = 1;
    ep.allow_download = 1;
    ep.area_limit = 0;

    // 修复 episode 状态
    if (ep.status === 13) ep.status = 2;
    if (ep.episode_status === 13) ep.episode_status = 2;

    // 清理标记
    if (ep.badge && /[泰会员VIP仅限]/.test(ep.badge)) {
        ep.badge = '';
    }
    if (ep.long_title) {
        ep.long_title = ep.long_title.replace(/[受僅限定][区区]?/g, '');
    }

    return ep;
}

/**
 * 用国际版 API (bstar) 响应重建标准播放地址格式
 * 参照 Xposed 模块 fixThailandPlayurl()
 */
function rebuildPlayurlFromIntl(intlObj) {
    var src = (intlObj.result || intlObj.data || {});
    if (!src || typeof src !== 'object') return obj;

    // 国际版播放地址可能在 video_info 里
    var videoInfo = src.video_info || src;

    var rebuilt = {
        code: 0,
        message: '0',
        result: {
            quality: videoInfo.quality || 0,
            format: videoInfo.format || '',
            timelength: videoInfo.timelength || 0,
            video_codecid: videoInfo.video_codecid || 0,
            accept_quality: videoInfo.accept_quality || [],
            support_formats: videoInfo.support_formats || [],
            dash: buildDash(videoInfo),
            durl: videoInfo.durl || [],
            accept_description: videoInfo.accept_description || [],
            accept_format: videoInfo.accept_format || ''
        }
    };

    return rebuilt;
}

/**
 * 从国际版播放地址数据构造 dash 对象
 */
function buildDash(videoInfo) {
    var dash = { duration: videoInfo.timelength || 0, minBufferTime: 1.5, min_buffer_time: 1.5 };

    // 国际版使用 dash_video / dash_audio 等字段名
    var videos = videoInfo.dash_video || videoInfo.dash && videoInfo.dash.video || [];
    var audios = videoInfo.dash_audio || videoInfo.dash && videoInfo.dash.audio || [];

    if (Array.isArray(videos)) {
        dash.video = videos.map(function(v) {
            if (!v.base_url && v.baseUrl) v.base_url = v.baseUrl;
            if (!v.backup_url && v.backupUrl) v.backup_url = v.backupUrl;
            if (!v.id && v.quality) v.id = v.quality;
            return v;
        });
    } else {
        dash.video = [];
    }

    if (Array.isArray(audios)) {
        dash.audio = audios.map(function(a) {
            if (!a.base_url && a.baseUrl) a.base_url = a.baseUrl;
            if (!a.backup_url && a.backupUrl) a.backup_url = a.backupUrl;
            return a;
        });
    } else {
        dash.audio = [];
    }

    return dash;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 从 URL 提取查询参数
 */
function extractParam(url, key) {
    var m = url.match(new RegExp('[?&]' + key + '=([^&]*)'));
    return m ? decodeURIComponent(m[1]) : null;
}

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
