/**
 * BiliRoaming - 净化B站内容（去广告/去推广/去噪声）
 *
 * 根据参数配置，从多个 B站 API 响应中移除广告、推广及其他不需要的内容
 *
 * 拦截接口:
 *   - api.bilibili.com/x/web-interface/index/top/feed   首页推荐
 *   - api.bilibili.com/x/web-interface/popular           热门
 *   - api.bilibili.com/x/web-interface/search            搜索
 *   - api.bilibili.com/x/web-interface/view              视频详情
 *   - api.bilibili.com/x/polymer/web-dynamic             动态
 *   - api.bilibili.com/xlive/...                         直播
 *   - api.bilibili.com/x/v2/reply                        评论
 *
 * 参数 (argument):
 *   pure=all        全部启用（默认）
 *   pure=feed       仅首页推荐
 *   pure=search     仅搜索
 *   pure=detail     仅视频详情
 *   pure=dynamic    仅动态
 *   pure=live       仅直播
 *   pure=comment    仅评论
 *   支持逗号分隔多选: pure=feed,search,detail
 *
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026
 */

// === 解析参数 ===
const PURIFY_RAW = readArg('pure', 'all');
const VALID_MODULES = ['feed', 'search', 'detail', 'dynamic', 'live', 'comment'];
let PURIFY_SET;

if (PURIFY_RAW === 'all') {
    PURIFY_SET = new Set(VALID_MODULES);
} else {
    PURIFY_SET = new Set(
        String(PURIFY_RAW).split(',').map(s => s.trim()).filter(s => VALID_MODULES.includes(s))
    );
}
const ENABLED = PURIFY_SET.size > 0;

const url = $request.url;
const body = $response.body;

if (!body || !ENABLED) {
    $done({});
    return;
}

try {
    let obj = JSON.parse(body);
    if (!obj || obj.code !== 0) {
        $done({});
        return;
    }

    // 首页推荐
    if (url.includes('/index/top/feed') && PURIFY_SET.has('feed')) {
        obj = purifyFeed(obj);
    }

    // 热门
    if (url.includes('/popular') && PURIFY_SET.has('feed')) {
        obj = purifyPopular(obj);
    }

    // 搜索
    if ((url.includes('/search') || url.includes('/x/v2/search')) && PURIFY_SET.has('search')) {
        obj = purifySearch(obj);
    }

    // 视频详情
    if (url.includes('/web-interface/view') && PURIFY_SET.has('detail')) {
        obj = purifyDetail(obj);
    }

    // 动态
    if (url.includes('/polymer/web-dynamic') && PURIFY_SET.has('dynamic')) {
        obj = purifyDynamic(obj);
    }

    // 直播
    if (url.includes('xlive') && PURIFY_SET.has('live')) {
        obj = purifyLive(obj);
    }

    // 评论
    if ((url.includes('/reply') || url.includes('/v2/reply')) && PURIFY_SET.has('comment')) {
        obj = purifyComment(obj);
    }

    $done({ body: JSON.stringify(obj) });

} catch (e) {
    console.log(`BiliRoaming purify error: ${e}`);
    $done({});
}

/**
 * 净化首页推荐
 * 移除: is_ad 广告、banner_item 横幅、operation_card 运营卡片、card_type ad
 */
function purifyFeed(obj) {
    const data = obj.data;
    if (!data) return obj;

    if (Array.isArray(data)) {
        obj.data = data.filter(item => {
            if (!item) return false;
            // 移除广告卡片
            if (item.is_ad === true || item.card_type === 'ad') return false;
            // 移除 banner 卡片
            if (item.banner_item || item.card_goto === 'banner') return false;

            // 清理内部字段
            delete item['ad_info'];
            delete item['ad_index'];
            delete item['banner_item'];
            delete item['operation_card'];
            delete item['rcmd_reason'];

            // 清理 card_type 中的非标准类型
            if (item.card_type && !['video', 'normal', 'ugc', 'pgc'].includes(item.card_type)) {
                return false;
            }

            return true;
        });
    }

    if (data.item && Array.isArray(data.item)) {
        data.item = data.item.filter(item => {
            if (!item) return false;
            if (item.is_ad === true || item.card_type === 'ad') return false;
            if (item.banner_item || item.card_goto === 'banner') return false;
            delete item['ad_info'];
            delete item['ad_index'];
            delete item['banner_item'];
            delete item['operation_card'];
            return true;
        });
    }

    return obj;
}

/**
 * 净化热门
 * 移除: 广告位、推广推荐理由
 */
function purifyPopular(obj) {
    const data = obj.data;
    if (!data) return obj;

    const items = data.list || data.result || data;
    if (Array.isArray(items)) {
        const cleaned = [];
        for (const item of items) {
            if (!item) continue;
            // 跳过广告位
            if (item.ad_index !== undefined) continue;
            // 清理推广推荐理由
            if (item.rcmd_reason) {
                const reason = String(item.rcmd_reason).replace(/[广推][告荐]/g, '');
                item.rcmd_reason = reason || '';
            }
            delete item['threePointDislike'];
            cleaned.push(item);
        }
        if (Array.isArray(data.list)) data.list = cleaned;
        else if (Array.isArray(data.result)) data.result = cleaned;
    }

    return obj;
}

/**
 * 净化搜索
 * 移除: 推广热搜、特殊推广结果、banner
 */
 function purifySearch(obj) {
    const data = obj.data;
    if (!data) return obj;

    // 移除推广热搜
    if (data.hot_search && Array.isArray(data.hot_search)) {
        data.hot_search = data.hot_search.filter(h => {
            if (!h) return false;
            return !(h.is_promoted === true || h.promote === true);
        });
    }

    // 移除搜索结果中的推广
    const resultList = data.result || data.items;
    if (Array.isArray(resultList)) {
        for (let i = resultList.length - 1; i >= 0; i--) {
            const item = resultList[i];
            if (!item) { resultList.splice(i, 1); continue; }
            // 移除 special_type 推广
            if (item.special_type === 1 || item.is_ad === true) {
                resultList.splice(i, 1);
                continue;
            }
            // 移除 gooto=game/shop/live 等推广类型
            if (item.goto && ['game', 'shop', 'ad'].includes(item.goto)) {
                resultList.splice(i, 1);
                continue;
            }
            // 清理内部字段
            delete item['ad_info'];
            delete item['highlight_tag'];
            delete item['is_special_rank'];
        }
    }

    // 移除 banner 推广
    delete data['banner'];
    delete data['top_banner'];
    delete data['ad_banner'];
    delete data['search_banner'];

    return obj;
}

/**
 * 净化视频详情
 * 移除: operation_card、cm_config、cmds、直播预约、相关推广
 */
function purifyDetail(obj) {
    const data = obj.data;
    if (!data) return obj;

    // 清空运营卡片
    delete data['operation_card'];
    data['operation_card'] = null;

    // 清空广告配置
    delete data['cm_config'];
    data['cm_config'] = null;

    // 清空浮窗指令 (三连关注、关联视频、投票弹幕等)
    delete data['cmds'];
    data['cmds'] = null;

    // 移除视频下方推荐中的推广
    if (Array.isArray(data.relates)) {
        data.relates = data.relates.filter(r => {
            if (!r) return false;
            // 过滤番剧/游戏/课程等非视频推荐
            const go = r.goto || r.card_type;
            if (go && ['pgc', 'game', 'shop', 'course', 'activity'].includes(go)) return false;
            return true;
        });
    }

    // 移除直播预约
    delete data['live_order'];
    data['live_order'] = null;

    // 移除 UP 大会员标识
    if (data.owner && data.owner.vip) {
        if (data.owner.vip.label) {
            data.owner.vip.label = { text: '' };
        }
    }

    // 移除评论区的置顶推广
    if (data.reply && Array.isArray(data.reply.hots)) {
        data.reply.hots = [];
    }

    // 移除荣誉信息
    delete data['honor'];
    delete data['honor_reply'];

    // 移除视频下方分集列表（可配置，这里默认不处理）
    // 移除相关推广
    if (Array.isArray(data.operation_cards)) {
        data.operation_cards = [];
    }

    if (data.rights) {
        delete data.rights['elec'];
    }

    return obj;
}

/**
 * 净化动态
 * 移除: 同城/校园标签、话题、广告/屏蔽动态
 */
function purifyDynamic(obj) {
    const data = obj.data;
    if (!data) return obj;

    if (Array.isArray(data.cards)) {
        data.cards = data.cards.filter(card => {
            if (!card) return false;
            const desc = card.desc || {};
            const ctype = desc.type;

            // 移除广告类动态
            if (ctype === 1 && desc.orig_type === 64) {
                // type 1 + orig_type 64 = 专栏推广
                return false;
            }
            if (desc.ad || desc.is_ad) return false;

            // 移除屏蔽内容（如充电专属）
            if (card.blocked || desc.status === -1) return false;

            // 移除跳转广告动态
            if (desc.rid && desc.orig_type === 8) return false;

            // 净化标签：去掉同城/校园
            if (desc.extra) {
                const extra = desc.extra;
                delete extra['is_space_top'];
                if (extra.tags && Array.isArray(extra.tags)) {
                    extra.tags = extra.tags.filter(t => {
                        if (!t || !t.tag_name) return false;
                        const name = String(t.tag_name);
                        if (name === '同城' || name === '校园') return false;
                        return true;
                    });
                    if (extra.tags.length === 0) delete extra['tags'];
                }
            }

            // 净化卡片内的 topic
            const cardObj = JSON.parse(card.card || '{}');
            if (cardObj.topic_list && Array.isArray(cardObj.topic_list)) {
                cardObj.topic_list = [];
                card.card = JSON.stringify(cardObj);
            }

            return true;
        });
    }

    // 也处理 result 路径
    if (data.result && Array.isArray(data.result.cards)) {
        data.result.cards = data.result.cards.filter(card => {
            if (!card) return false;
            if (card.blocked) return false;
            return true;
        });
    }

    return obj;
}

/**
 * 净化直播
 * 移除: 浮窗广告、banner推广
 */
function purifyLive(obj) {
    const data = obj.data;
    if (!data) return obj;

    // 移除直播间浮窗
    delete data['popups'];
    data['popups'] = [];

    // 移除 banner
    delete data['banner'];
    data['banner'] = null;

    // 移除推广直播间列表
    if (Array.isArray(data.promote_list)) {
        data.promote_list = [];
    }

    // 移除商城推广
    delete data['shop_banner'];

    return obj;
}

/**
 * 净化评论
 * 移除: 置顶推广、评论引导
 */
function purifyComment(obj) {
    const data = obj.data;
    if (!data) return obj;

    // 移除置顶评论
    if (data.top) {
        // 如果是 UP 自己置顶的不删，检查是否是推广
        if (data.top_reply && data.top_reply.is_ad) {
            delete data['top'];
            delete data['top_reply'];
        }
        if (data.top && data.top.is_ad) {
            delete data['top'];
        }
    }

    // 移除评论引导
    delete data['reply_guide'];

    // 移除评论区 banner
    delete data['banner'];

    // 移除评论中的蓝字关键词搜索引导
    if (Array.isArray(data.replies)) {
        for (const reply of data.replies) {
            if (reply && reply.content) {
                // 移除评论引导文本
                delete reply['guide'];
                delete reply['operation'];
            }
        }
    }

    return obj;
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
