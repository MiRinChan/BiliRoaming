/**
 * BiliRoaming - 净化B站内容（去广告/去推广/去噪声/@提及过滤）
 *
 * 根据参数配置，从多个 B站 API 响应中移除广告、推广及其他不需要的内容
 *
 * 拦截接口 (REST):
 *   - api.bilibili.com/x/web-interface/index/top/feed   首页推荐
 *   - api.bilibili.com/x/web-interface/popular           热门
 *   - api.bilibili.com/x/web-interface/search            搜索
 *   - api.bilibili.com/x/web-interface/view              视频详情
 *   - api.bilibili.com/x/polymer/web-dynamic             动态
 *   - api.bilibili.com/xlive (various)                   直播
 *   - api.bilibili.com/x/v2/reply                        评论
 *
 * 拦截接口 (gRPC):
 *   - grpc.biliapi.net/bilibili.main.community.reply.v1.Reply/MainList  评论列表
 *
 * 参数 (独立开关, 新版):
 *   首页推荐 = switch,true    过滤首页推荐中的广告和推广
 *   搜索 = switch,true        过滤搜索结果中的推广、广告
 *   视频详情 = switch,true    过滤视频详情中的运营卡片、广告
 *   动态 = switch,true        过滤动态中的同城/校园标签、广告
 *   直播 = switch,true        过滤直播间中的浮窗广告、banner
 *   评论 = switch,true        过滤评论区中的置顶推广、引导
 *   评论@提及 = switch,false  过滤仅含@提及、无实质内容的评论
 *
 * 兼容旧版参数:
 *   pure=feed,search,detail,dynamic,live,comment,comment_at
 *
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026-06-25
 */

// === 解析参数 ===
// 独立开关：每个模块一个 switch，tag=净化 下分组显示
// 若存在新版开关则优先使用；否则回退到旧版 pure= 格式
const HAS_INDIVIDUAL = hasArgKey('首页推荐') || hasArgKey('搜索') ||
                       hasArgKey('视频详情') || hasArgKey('动态') ||
                       hasArgKey('直播') || hasArgKey('评论');

const PURIFY_FEED       = HAS_INDIVIDUAL ? readBoolArg('首页推荐', true)    : legacyPure('feed', true);
const PURIFY_SEARCH     = HAS_INDIVIDUAL ? readBoolArg('搜索', true)        : legacyPure('search', true);
const PURIFY_DETAIL     = HAS_INDIVIDUAL ? readBoolArg('视频详情', true)    : legacyPure('detail', true);
const PURIFY_DYNAMIC    = HAS_INDIVIDUAL ? readBoolArg('动态', true)        : legacyPure('dynamic', true);
const PURIFY_LIVE       = HAS_INDIVIDUAL ? readBoolArg('直播', true)        : legacyPure('live', true);
const PURIFY_COMMENT    = HAS_INDIVIDUAL ? readBoolArg('评论', true)        : legacyPure('comment', true);
const PURIFY_COMMENT_AT = HAS_INDIVIDUAL ? readBoolArg('评论@提及', false)  : false; // 旧版 pure 不支持 comment_at

const ENABLED = PURIFY_FEED || PURIFY_SEARCH || PURIFY_DETAIL || PURIFY_DYNAMIC ||
                PURIFY_LIVE || PURIFY_COMMENT || PURIFY_COMMENT_AT;

const url = $request.url;
const body = $response.body;

if (!body || !ENABLED) {
    $done({});
    return;
}

// gRPC 评论回复 — 二进制 protobuf 响应，在 JSON 解析前处理
if (PURIFY_COMMENT_AT && (url.includes('MainList') || url.includes('grpc.biliapi'))) {
    handleGrpcCommentAtFilter();
    // handleGrpcCommentAtFilter 内部调用 $done()
    return;
}

try {
    let obj = JSON.parse(body);
    if (!obj || obj.code !== 0) {
        $done({});
        return;
    }

    // 首页推荐
    if (url.includes('/index/top/feed') && PURIFY_FEED) {
        obj = purifyFeed(obj);
    }

    // 热门
    if (url.includes('/popular') && PURIFY_FEED) {
        obj = purifyPopular(obj);
    }

    // 搜索
    if ((url.includes('/search') || url.includes('/x/v2/search')) && PURIFY_SEARCH) {
        obj = purifySearch(obj);
    }

    // 视频详情
    if (url.includes('/web-interface/view') && PURIFY_DETAIL) {
        obj = purifyDetail(obj);
    }

    // 动态
    if (url.includes('/polymer/web-dynamic') && PURIFY_DYNAMIC) {
        obj = purifyDynamic(obj);
    }

    // 直播
    if (url.includes('xlive') && PURIFY_LIVE) {
        obj = purifyLive(obj);
    }

    // 评论
    if ((url.includes('/reply') || url.includes('/v2/reply')) && PURIFY_COMMENT) {
        obj = purifyComment(obj);
    }

    $done({ body: JSON.stringify(obj) });

} catch (e) {
    console.log(`BiliRoaming purify error: ${e}`);
    $done({});
}

/**
 * 净化首页推荐
 * 移除: is_ad 广告、banner_item 横幅、operation_card 运营卡片
 *
 * 参照 Xposed 模块 PegasusHook — 通过 card_goto / card_type / goto 三字段
 * 匹配 "ad", "cm", "cm_v2" 来检测广告，而非仅检查 is_ad 布尔值。
 * B站 API 可能返回 is_ad: 1 (数字) 或 is_ad: true (布尔)，
 * 且在较新版本中广告主要通过 card_goto: "cm" 标识。
 */
function purifyFeed(obj) {
    const data = obj.data;
    if (!data) return obj;

    if (Array.isArray(data)) {
        obj.data = data.filter(item => {
            if (!item) return false;
            // 广告检测: is_ad 真值 或 card_goto/card_type/goto 匹配 ad/cm
            if (isAdItem(item)) return false;
            // 移除 banner 卡片
            if (item.banner_item || item.card_goto === 'banner') return false;

            // 清理内部字段
            delete item['ad_info'];
            delete item['ad_index'];
            delete item['banner_item'];
            delete item['operation_card'];
            delete item['rcmd_reason'];

            return true;
        });
    }

    if (data.item && Array.isArray(data.item)) {
        data.item = data.item.filter(item => {
            if (!item) return false;
            if (isAdItem(item)) return false;
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
 * 移除: 广告位、推广推荐理由、cm 推广卡片
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
            // 跳过推广卡片 (card_goto === 'cm')
            if (isAdItem(item)) continue;
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
 * 移除: 推广热搜、特殊推广结果、banner、cm/special 推广卡片
 *
 * 参照 Xposed 模块 ProtoBufHook — 额外过滤 hasCm / hasSpecial 标记的条目
 */
function purifySearch(obj) {
    const data = obj.data;
    if (!data) return obj;

    // 移除推广热搜
    if (data.hot_search && Array.isArray(data.hot_search)) {
        data.hot_search = data.hot_search.filter(h => {
            if (!h) return false;
            return !(h.is_promoted === true || h.is_promoted === 1 || h.promote === true || h.promote === 1);
        });
    }

    // 移除搜索结果中的推广
    const resultList = data.result || data.items;
    if (Array.isArray(resultList)) {
        for (let i = resultList.length - 1; i >= 0; i--) {
            const item = resultList[i];
            if (!item) { resultList.splice(i, 1); continue; }
            // 移除 special_type 推广
            if (item.special_type === 1 || isAdItem(item)) {
                resultList.splice(i, 1);
                continue;
            }
            // 移除 cm/special 标记的推广卡片 (Xposed ProtoBufHook)
            if (item.card_goto === 'cm' || item.has_cm || item.hasCm || item.has_special || item.hasSpecial) {
                resultList.splice(i, 1);
                continue;
            }
            // 移除 gooto=game/shop/ad/cm 等推广类型
            if (item.goto && ['game', 'shop', 'ad', 'cm'].includes(item.goto)) {
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
            // 过滤番剧/游戏/课程/cm 等非视频推荐
            const go = r.goto || r.card_type || r.card_goto;
            if (go && ['pgc', 'game', 'shop', 'course', 'activity', 'ad', 'cm'].includes(go)) return false;
            // 推广卡片通用检测
            if (isAdItem(r)) return false;
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
            // 广告检测: desc.ad / desc.is_ad 真值 或 card_goto 匹配
            if (desc.ad || desc.is_ad || desc.is_ad === 1) return false;
            if (desc.card_goto && ['ad', 'cm', 'cm_v2'].includes(desc.card_goto)) return false;

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
 * 移除: 置顶推广、评论引导、纯 @ 回复（可选）
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
        for (let i = data.replies.length - 1; i >= 0; i--) {
            const reply = data.replies[i];
            if (!reply) continue;

            // 移除评论引导文本
            delete reply['guide'];
            delete reply['operation'];

            // @ 纯提及过滤：移除仅包含 @ 提及、无其他实质内容的评论
            if (PURIFY_COMMENT_AT && isAtOnlyComment(reply.content)) {
                data.replies.splice(i, 1);
            }
        }
    }

    // 同样处理 sub_replies / replies 嵌套
    function filterSubReplies(replies) {
        if (!Array.isArray(replies)) return;
        for (let i = replies.length - 1; i >= 0; i--) {
            const r = replies[i];
            if (!r) continue;
            if (PURIFY_COMMENT_AT && isAtOnlyComment(r.content)) {
                replies.splice(i, 1);
            }
        }
    }

    if (Array.isArray(data.replies)) {
        for (const reply of data.replies) {
            if (reply && Array.isArray(reply.replies)) {
                filterSubReplies(reply.replies);
            }
        }
    }

    return obj;
}

/**
 * 通用广告/推广卡片检测
 * 参照 Xposed 模块 PegasusHook — 通过 card_goto / card_type / goto 三字段
 * 匹配 "ad", "cm", "cm_v2" 来检测广告。
 *
 * B站 API 的 is_ad 字段可能是:
 *   - 布尔 true (旧版)
 *   - 数字 1   (新版 JSON)
 * 同时较新版本主要通过 card_goto: "cm" 来标识推广内容，
 * 而非设置 is_ad 字段。因此需要同时检查三字段。
 */
function isAdItem(item) {
    if (!item || typeof item !== 'object') return false;

    // is_ad 真值检测 (兼容 true / 1 / "1")
    if (item.is_ad || item.is_ad === 1) return true;

    // Xposed PegasusHook: card_goto / card_type / goto 三字段字符串匹配
    var adTypes = ['ad', 'cm', 'cm_v2'];
    var fields = [item.card_goto, item.card_type, item.goto];
    for (var i = 0; i < fields.length; i++) {
        var val = fields[i];
        if (val && adTypes.indexOf(String(val)) !== -1) return true;
    }

    return false;
}

/**
 * 检测评论内容是否仅包含 @ 提及，无其他实质内容
 * 匹配:
 *   - @张三
 *   - @张三 @李四
 *   - 回复 @张三 :    (B站回复格式，无实质内容)
 *   - 回复 @张三 : [笑哭]  (@提及 + 表情)
 * 不匹配:
 *   - @张三 你好
 *   - 你好 @张三
 *   - 回复 @张三 : 好的
 *   - [@笑哭]         (表情引用，非 @提及)
 */
function isAtOnlyComment(text) {
    if (!text || typeof text !== 'string') return false;

    var msg = text.trim();
    if (!msg) return false;

    // 先去除表情/贴纸引用 [xxx]（可能内含 @ 字符）
    var noEmoji = msg.replace(/\[[^\]]+\]/g, '');

    // 必须包含至少一个有效 @提及（@ 后跟字母/数字/下划线/中日韩/假名）
    if (!/@[\w一-鿿぀-ゟ゠-ヿ]/.test(noEmoji)) {
        return false;
    }

    // 去除 B站回复前缀 "回复 @xxx :" 或 "回复 @xxx："
    var stripped = noEmoji.replace(/^回复\s*@[\w一-鿿぀-ゟ゠-ヿ]+\s*[:：]\s*/, '');

    // 去除所有 @提及（@ + 用户名）
    stripped = stripped.replace(/@[\w一-鿿぀-ゟ゠-ヿ]+/g, '');

    // 去除剩余空白和标点
    stripped = stripped.replace(/[\s　 -⁯︀-️!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~，。！？；：、…～【】「」『』（）《》〈〉←-⇿]+/g, '');

    return stripped.trim().length === 0;
}

// ==================== gRPC 评论 @ 提及过滤 ====================

/**
 * 处理 gRPC Reply/MainList 评论接口，过滤仅含 @ 提及的评论
 * 响应格式（自动检测）:
 *   A. gRPC frame (5B) → gzip → protobuf   (标准 gRPC)
 *   B. gRPC frame (5B) → 裸 protobuf       (Loon 自动解压)
 *   C. 裸 protobuf                          (Loon 自动解 frame + 解压)
 *   D. base64 编码的二进制                  (Loon $response.body)
 */
function handleGrpcCommentAtFilter() {
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

        // 过滤 @ 提及评论
        var filtered = filterGrpcReplies(decompressed);

        if (filtered === null) {
            $done({});  // 无变化, 透传
            return;
        }

        // 重新打包: protobuf → gzip → gRPC frame
        var output = rewrap(rawBytes, filtered);
        if (!output) {
            $done({});
            return;
        }

        setResponseBytes(output);

    } catch (e) {
        console.log('BiliRoaming comment_at filter error: ' + e);
        $done({});
    }
}

/**
 * 扫描 Reply/MainList protobuf, 移除仅含 @ 提及的 Reply
 *
 * Protobuf 结构:
 *   MainListReply:
 *     repeated Reply replies = 2;   (tag 0x12, field 2)
 *     Cursor cursor = 3;           (tag 0x1A)
 *
 *   Reply:
 *     Content content = 12;         (tag 0x62)
 *
 *   Content:
 *     string message = 1;           (tag 0x0A)
 *
 * @param {Uint8Array} buf - protobuf 字节
 * @returns {Uint8Array|null} 过滤后的字节, 无变化返回 null
 */
function filterGrpcReplies(buf) {
    var off = 0;
    var outputParts = [];
    var filteredCount = 0;
    var keptCount = 0;
    var lastCopyEnd = 0;

    while (off < buf.length) {
        var tag = buf[off];
        var fieldNum = tag >> 3;
        var wireType = tag & 0x07;

        if (fieldNum === 2 && wireType === 2) {
            // Reply 嵌套消息: tag 0x12 (field 2, wire type 2)
            off++;

            var lengthResult = readVarint(buf, off);
            var length = Number(lengthResult[0]);
            off += lengthResult[1];

            var replyStart = off - 1 - lengthResult[1];
            var replyBytes = buf.slice(off, off + length);
            off += length;

            if (shouldFilterReply(replyBytes)) {
                if (lastCopyEnd < replyStart) {
                    outputParts.push(buf.slice(lastCopyEnd, replyStart));
                }
                lastCopyEnd = off;
                filteredCount++;
            } else {
                keptCount++;
            }
        } else {
            off = skipField(buf, off);
        }
    }

    if (filteredCount === 0) return null;

    if (lastCopyEnd < buf.length) {
        outputParts.push(buf.slice(lastCopyEnd));
    }

    if (outputParts.length === 0) {
        console.log('BiliRoaming comment_at: all filtered (' + filteredCount + ')');
        return new Uint8Array(0);
    }

    if (outputParts.length === 1) {
        console.log('BiliRoaming comment_at: kept=' + keptCount + ', filtered=' + filteredCount);
        return outputParts[0];
    }

    var totalLen = 0;
    for (var i = 0; i < outputParts.length; i++) totalLen += outputParts[i].length;
    var result = new Uint8Array(totalLen);
    var pos = 0;
    for (var i = 0; i < outputParts.length; i++) {
        result.set(outputParts[i], pos);
        pos += outputParts[i].length;
    }

    console.log('BiliRoaming comment_at: kept=' + keptCount + ', filtered=' + filteredCount);
    return result;
}

/**
 * 检查单个 Reply 消息是否应被过滤（仅含 @ 提及）
 * @param {Uint8Array} replyBytes - Reply protobuf 字节
 * @returns {boolean}
 */
function shouldFilterReply(replyBytes) {
    var off = 0;

    while (off < replyBytes.length) {
        var tag = replyBytes[off];
        var fn = tag >> 3;
        var wt = tag & 0x07;
        off++;

        if (fn === 12 && wt === 2) {
            // content 字段: tag 0x62
            var lenResult = readVarint(replyBytes, off);
            var clen = Number(lenResult[0]);
            off += lenResult[1];
            var contentBytes = replyBytes.slice(off, off + clen);

            // 提取 content.message (fn=1, string)
            var msgText = extractContentMessage(contentBytes);
            if (msgText !== null && isAtOnlyComment(msgText)) {
                return true;
            }

            off += clen;
        } else {
            off = skipFieldPayload(replyBytes, off, wt);
        }
    }

    return false;
}

/**
 * 从 Content protobuf 中提取 message 文本 (field 1, wire type 2)
 * @param {Uint8Array} contentBytes
 * @returns {string|null} 消息文本, 无 message 字段返回 null
 */
function extractContentMessage(contentBytes) {
    var off = 0;
    while (off < contentBytes.length) {
        var tag = contentBytes[off];
        var fn = tag >> 3;
        var wt = tag & 0x07;
        off++;

        if (fn === 1 && wt === 2) {
            var lenResult = readVarint(contentBytes, off);
            var mlen = Number(lenResult[0]);
            off += lenResult[1];
            try {
                var msgText = '';
                for (var i = 0; i < mlen; i++) {
                    // 简单的 UTF-8 解码 (仅处理 BMP)
                    var b = contentBytes[off + i];
                    if (b < 0x80) {
                        msgText += String.fromCharCode(b);
                    } else if ((b & 0xE0) === 0xC0) {
                        msgText += String.fromCharCode(((b & 0x1F) << 6) | (contentBytes[off + i + 1] & 0x3F));
                        i += 1;
                    } else if ((b & 0xF0) === 0xE0) {
                        msgText += String.fromCharCode(((b & 0x0F) << 12) | ((contentBytes[off + i + 1] & 0x3F) << 6) | (contentBytes[off + i + 2] & 0x3F));
                        i += 2;
                    } else if ((b & 0xF8) === 0xF0) {
                        // 4字节 UTF-8 (代理对: String.fromCharCode 需要两个 char)
                        var cp = ((b & 0x07) << 18) | ((contentBytes[off + i + 1] & 0x3F) << 12) | ((contentBytes[off + i + 2] & 0x3F) << 6) | (contentBytes[off + i + 3] & 0x3F);
                        if (cp > 0xFFFF) {
                            cp -= 0x10000;
                            msgText += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
                        } else {
                            msgText += String.fromCharCode(cp);
                        }
                        i += 3;
                    }
                }
                return msgText;
            } catch (e) {
                return null;
            }
        } else {
            off = skipFieldPayload(contentBytes, off, wt);
        }
    }
    return null;
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
    // Loon 优先: 输出 base64 body
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
        // 验证: 长度合理 (不超过可用字节数 + 合理偏差)
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
    // Loon / Surge 内置
    if (typeof $utils !== 'undefined' && typeof $utils.base64ToBytes === 'function') {
        try {
            var result = $utils.base64ToBytes(str);
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
            var result = $utils.bytesToBase64(bytes);
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

/** 跳过一个 protobuf 字段 (tag 已消费) */
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
    return off; // wt 3,4 (start/end group) — 废弃
}

// ==================== 手动 Base64 (无 $utils 时的回退) ====================

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function manualBase64ToBytes(b64) {
    // 仅对看起来像 base64 的字符串解码
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

/**
 * 读取布尔型开关参数（兼容 Loon $argument 对象 & Surge $argument 字符串）
 */
function readBoolArg(key, def) {
    var val = readArg(key, def);
    if (val === true || val === 'true' || val === 1 || val === '1') return true;
    if (val === false || val === 'false' || val === 0 || val === '0') return false;
    return !!def;
}

/**
 * 检测 $argument 中是否存在指定 key（不关心值）
 */
function hasArgKey(key) {
    if (typeof $argument === 'object' && $argument && key in $argument) return true;
    if (typeof $argument === 'string' && $argument.indexOf(key + '=') !== -1) return true;
    return false;
}

/**
 * 兼容旧版 pure= 参数格式
 * 将 pure=feed,search 或 pure=all 映射到各模块的布尔值
 */
function legacyPure(module, def) {
    var pureRaw = readArg('pure', '');
    if (!pureRaw && def !== undefined) return def;
    if (pureRaw === 'all') return true;
    if (typeof pureRaw !== 'string' || !pureRaw) return def;
    var items = pureRaw.split(',').map(function(s) { return s.trim(); });
    return items.indexOf(module) !== -1;
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
