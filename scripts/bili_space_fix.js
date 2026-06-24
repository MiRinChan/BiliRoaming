/**
 * BiliRoaming - 修复用户空间
 *
 * 修复因区域限制/账号状态被隐藏或限制的用户空间数据
 *
 * 拦截接口:
 *   - api.bilibili.com/x/space/acc/info             用户信息
 *   - api.bilibili.com/x/space/arc/search            用户视频列表
 *   - api.bilibili.com/x/community-service/*/user/feed  用户动态
 *
 * 修改字段:
 *   - area_limit: 1 → 0         解除区域限制
 *   - card.status: -1 → 1       恢复被屏蔽用户（若数据存在）
 *   - badge 文本中去掉"受限/限定"标记
 *
 * 参数 (argument):
 *   space=true   启用空间修复
 *   space=false  不处理（默认关闭）
 *
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026
 */

// === 解析参数 ===
const spaceRaw = readArg('space', false);
const ENABLED = spaceRaw === true || spaceRaw === 'true' || spaceRaw === 'unlock';

const url = $request.url;
const body = $response.body;

if (!body || !ENABLED) {
    $done({});
    return;
}

try {
    let obj = JSON.parse(body);

    // 用户信息
    if (url.includes('/space/acc/info')) {
        obj = fixAccInfo(obj);
    }

    // 用户视频列表
    if (url.includes('/space/arc/search') || url.includes('/space/wbi/arc/search')) {
        obj = fixSpaceArc(obj);
    }

    // 用户动态
    if (url.includes('/community-service') && url.includes('/user/feed')) {
        obj = fixSpaceFeed(obj);
    }

    $done({ body: JSON.stringify(obj) });

} catch (e) {
    console.log(`BiliRoaming space_fix error: ${e}`);
    $done({});
}

/**
 * 修复用户信息
 * 1. 被区域限制的用户 → 去掉 area_limit 标记
 * 2. 被封禁但数据还在的用户 → 恢复 status
 */
function fixAccInfo(obj) {
    if (!obj) return obj;

    // 如果服务器返回 -404（用户完全不存在），MITM 无法恢复
    if (obj.code !== 0) return obj;

    const data = obj.data;
    if (!data) return obj;

    if (data.card) {
        fixAreaLimit(data.card);

        // 恢复被标记为 ban 的用户（如果实际数据存在）
        if (data.card.status === -1 && data.card.mid && data.card.mid > 0) {
            data.card.status = 1;
        }

        // 修复 official_verify 被屏蔽的情况
        if (data.card.official_verify === -1) {
            data.card.official_verify = 1;
        }

        // 去掉受限相关 badge
        if (data.card.badge) {
            data.card.badge = data.card.badge.replace(/[受僅限定][区区]?/g, '');
        }
    }

    // 修复空间头图
    if (data.space && data.space.s_img) {
        fixAreaLimit(data.space);
    }

    return obj;
}

/**
 * 修复用户视频列表
 * 遍历每个视频，解除区域限制标记
 */
function fixSpaceArc(obj) {
    if (!obj || obj.code !== 0) return obj;

    const data = obj.data;
    if (!data) return obj;

    // 不同版本 API 的列表路径
    const vlist = data.list?.vlist || data.vlist || data.archives;
    if (Array.isArray(vlist)) {
        vlist.forEach(video => {
            fixAreaLimit(video);

            // 去掉受限标记
            if (video.badge) {
                video.badge = video.badge.replace(/[受僅限定][区区]?/g, '');
            }
            if (video.title) {
                video.title = video.title.replace(/[\[【\(（]?[受僅限定][区区]?[\]】\)）]?/g, '');
            }

            // 恢复被屏蔽的播放数和弹幕数
            if (video.play === -1 || video.play === '--') video.play = 0;
            if (video.danmaku === -1 || video.danmaku === '--') video.danmaku = 0;
            if (video.video_review === -1) video.video_review = 0;
        });
    }

    // B站新 API 可能使用 archives 数组
    if (Array.isArray(data.archives)) {
        data.archives.forEach(video => {
            fixAreaLimit(video);
            if (video.badge) {
                video.badge = video.badge.replace(/[受僅限定][区区]?/g, '');
            }
        });
    }

    // 如果列表为空且是区域限制导致，尝试修复（保持原样，因为真的没有数据）
    // 但对于 area_limit=1 但 list 存在的情况，已经通过 fixAreaLimit 处理

    return obj;
}

/**
 * 修复用户动态
 * 遍历动态卡片，解除区域限制
 */
function fixSpaceFeed(obj) {
    if (!obj || obj.code !== 0) return obj;

    const data = obj.data;
    if (!data) return obj;

    const items = data.items || data.cards || data.list;
    if (Array.isArray(items)) {
        items.forEach(item => {
            if (!item) return;
            fixAreaLimit(item);

            // 清理受限标记
            if (item.badge) {
                item.badge = item.badge.replace(/[受僅限定][区区]?/g, '');
            }

            // 恢复被屏蔽的动态内容
            if (item.modules) {
                if (item.modules.module_dynamic) {
                    fixAreaLimit(item.modules.module_dynamic);
                }
                if (item.modules.module_author) {
                    fixAreaLimit(item.modules.module_author);
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

    if (obj.area === 'restricted' || obj.area === '') {
        obj.area = '';
    }

    // 恢复被封禁/被删除用户的状态
    if (Object.hasOwn(obj, 'status') && obj.status === -1) {
        obj.status = 1;
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
    }
    return def;
}
