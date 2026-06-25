/**
 * BiliRoaming - 修复用户空间
 *
 * 修复因区域限制/账号状态被隐藏或限制的用户空间数据
 *
 * 拦截接口:
 *   - api.bilibili.com/x/v2/space               新版空间 API (iOS/Android 主要入口)
 *   - api.bilibili.com/x/space/acc/info         用户信息（旧版）
 *   - api.bilibili.com/x/space?                 Xposed hook 兼容
 *   - api.bilibili.com/x/space/arc/search       用户视频列表
 *   - api.bilibili.com/x/community-service (user/feed)  用户动态
 *
 * 修复字段:
 *   - area_limit: 1 -> 0         解除区域限制
 *   - card.status: -1 -> 1       恢复被屏蔽用户（若数据存在）
 *   - badge 文本中去掉受限/限定标记
 *
 * 注销账号修复 (code: -404):
 *   参照 Xposed BiliRoaming 的 fixSpace 逻辑，
 *   1. 通过 account.bilibili.com/api/member/getCardByMid 获取用户基础信息
 *   2. 构造完整 BiliSpace 格式响应（含 setting/tab/images/archive 等字段）
 *   3. getCardByMid 不可用时降级为空卡但 code=0
 *
 * 参数 (argument):
 *   space=true   启用空间修复
 *   space=false  不处理（默认关闭）
 *
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026-06-24 v2
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

let obj;
try {
    obj = JSON.parse(body);
} catch (e) {
    console.log(`BiliRoaming space_fix parse error: ${e}`);
    $done({});
    return;
}

// Determine which space API we're hitting
// /x/v2/space — unified v2 space API (iOS/Android 新版)
// /x/space? — old Xposed hook point
// /x/space/acc/info — user profile info (旧版)
// /x/v2/space/archive — 视频列表 (新版，正常返回但需 area_limit fix)
const isV2Space = url.includes('/v2/space') || url.includes('/x/space?');
const isAccInfo = url.includes('/space/acc/info');
const isArcSearch = url.includes('/space/arc/search') || url.includes('/space/wbi/arc/search');
const isSpaceArchive = url.includes('/v2/space/archive') || url.includes('/space/wbi/arc/search');
const isFeed = url.includes('/community-service') && url.includes('/user/feed');

// 用户信息 (any variant: v2, old acc/info, Xposed hook point)
if (isV2Space || isAccInfo) {
    fixAccInfo(obj, url, (fixedObj) => {
        $done({ body: JSON.stringify(fixedObj) });
    });
    return;
}

// 用户视频列表
if (isArcSearch || isSpaceArchive) {
    obj = fixSpaceArc(obj);
}

// 用户动态
if (isFeed) {
    obj = fixSpaceFeed(obj);
}

$done({ body: JSON.stringify(obj) });

/**
 * 修复用户信息
 * 1. 被区域限制的用户 → 去掉 area_limit 标记
 * 2. 被封禁但数据还在的用户 → 恢复 status
 * 3. 已注销用户 (code: -404) → 通过 getCardByMid 恢复基础信息
 */
function fixAccInfo(obj, url, done) {
    if (!obj) return done(obj);

    // 正常响应 (code === 0): 修复字段
    if (obj.code === 0) {
        const data = obj.data;
        if (!data) return done(obj);

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

            // 去掉受限相关 badge / description / sign
            if (data.card.badge) {
                data.card.badge = data.card.badge.replace(/[受僅限定][区区]?/g, '');
            }
            if (data.card.description) {
                data.card.description = data.card.description.replace(/[受僅限定][区区]?/g, '');
            }
            if (data.card.sign) {
                data.card.sign = data.card.sign.replace(/[受僅限定][区区]?/g, '');
            }
            // 规范化 mid 类型（确保为字符串，兼容新版 API 返回数字）
            if (data.card.mid !== undefined && data.card.mid !== null) {
                data.card.mid = String(data.card.mid);
            }
        }

        // 修复空间头图
        if (data.space && data.space.s_img) {
            fixAreaLimit(data.space);
        }

        return done(obj);
    }

    // 已注销/封禁用户 (code: -404): 参照 Xposed fixSpace 逻辑
    if (obj.code === -404) {
        const mid = extractMid(url);
        if (!mid) return done(obj);

        // 判断是 v2 空间 API (/x/v2/space) 还是旧版 (/x/space/acc/info)
        const isV2 = url.includes('/v2/space') || url.includes('/x/space?');

        // 尝试通过 account.bilibili.com 获取用户基础信息
        // getCardByMid 对已注销账号仍然可能返回数据
        const cardUrl = `https://account.bilibili.com/api/member/getCardByMid?mid=${mid}`;

        if (typeof $httpClient !== 'undefined') {
            // Surge / Loon / Stash
            $httpClient.get(cardUrl, (error, response, data) => {
                let restored = false;
                if (!error && data) {
                    try {
                        const cardResp = JSON.parse(data);
                        if (cardResp.code === 0 && cardResp.card) {
                            obj = buildFakeAccInfo(mid, cardResp.card, isV2);
                            restored = true;
                            console.log(`BiliRoaming space_fix: restored deactivated user ${mid}`);
                        }
                    } catch (e) {
                        console.log(`BiliRoaming space_fix card parse error: ${e}`);
                    }
                }
                // getCardByMid 也失败时，仍构造最小响应避免客户端白屏
                if (!restored) {
                    obj = buildFakeAccInfo(mid, null, isV2);
                    console.log(`BiliRoaming space_fix: getCardByMid failed, fallback for ${mid}`);
                }
                done(obj);
            });
            return;
        }

        if (typeof $task !== 'undefined' && typeof $task.fetch === 'function') {
            // Quantumult X
            $task.fetch(cardUrl).then(
                (response) => {
                    let restored = false;
                    try {
                        const cardResp = JSON.parse(response.body);
                        if (cardResp.code === 0 && cardResp.card) {
                            obj = buildFakeAccInfo(mid, cardResp.card, isV2);
                            restored = true;
                            console.log(`BiliRoaming space_fix: restored deactivated user ${mid}`);
                        }
                    } catch (e) {
                        console.log(`BiliRoaming space_fix card parse error: ${e}`);
                    }
                    if (!restored) {
                        obj = buildFakeAccInfo(mid, null, isV2);
                        console.log(`BiliRoaming space_fix: getCardByMid failed, fallback for ${mid}`);
                    }
                    done(obj);
                },
                (err) => {
                    console.log(`BiliRoaming space_fix fetch error: ${err}`);
                    obj = buildFakeAccInfo(mid, null, isV2);
                    done(obj);
                }
            );
            return;
        }

        // 无 HTTP 客户端可用 (如 Node.js 测试环境): 直接透传
        console.log(`BiliRoaming space_fix: no HTTP client available for -404 fix, mid=${mid}`);
    }

    // 其他错误码: 透传
    return done(obj);
}

/**
 * 从 getCardByMid 响应构建空间数据
 * iOS 兼容为主，description/sign 标记对齐 Xposed getSpace()
 * @param {string} mid - 用户 mid
 * @param {object|null} card - getCardByMid 返回的 card 对象（可为 null）
 * @param {boolean} isV2 - 是否为 /x/v2/space API
 */
function buildFakeAccInfo(mid, card, isV2) {
    card = card || {};
    const levelInfo = card.level_info || {};
    const officialVerify = card.official_verify || {};
    const vipInfo = card.vip || {};
    const face = card.face || '';

    return {
        code: 0,
        message: '0',
        ttl: 1,
        data: {
            relation: -999,
            guest_relation: -999,
            default_tab: 'video',
            is_params: true,
            setting: {
                fav_video: 0, coins_video: 0, likes_video: 0, bangumi: 0,
                played_game: 0, groups: 0, comic: 0, bbq: 0, dress_up: 0,
                disable_following: 0, live_playback: 1, close_space_medal: 0,
                only_show_wearing: 0
            },
            tab: {
                archive: true, article: true, clip: true, album: true,
                favorite: false, bangumi: false, coin: false, like: false,
                community: false, dynamic: true, audios: true, shop: false,
                mall: false, ugc_season: false, comic: false, cheese: false,
                sub_comic: false, activity: false, series: false
            },
            card: {
                mid: String(mid),
                name: card.name || '',
                approve: false,
                sex: card.sex || '保密',
                rank: card.rank || '0',
                face: face,
                DisplayRank: '0',
                regtime: 0,
                spacesta: 0,
                birthday: '',
                place: '',
                // align: description 标记
                description: '该页面由哔哩漫游修复',
                article: 0,
                attentions: [],
                fans: card.fans || 0,
                friend: card.friend || 0,
                attention: card.attention || 0,
                // align: sign 标记
                sign: '【该页面由哔哩漫游修复】' + (card.sign || ''),
                level_info: {
                    current_level: levelInfo.current_level || 0,
                    current_min: levelInfo.current_min || 0,
                    current_exp: levelInfo.current_exp || 0,
                    next_exp: levelInfo.next_exp || 0
                },
                pendant: {
                    pid: 0, name: '', image: '', expire: 0,
                    image_enhance: '', image_enhance_frame: ''
                },
                nameplate: {
                    nid: 0, name: '', image: '', image_small: '',
                    level: '', condition: ''
                },
                official_verify: {
                    type: officialVerify.type || -1,
                    desc: officialVerify.desc || ''
                },
                vip: {
                    vipType: vipInfo.vipType || 0,
                    vipDueDate: vipInfo.vipDueDate || 0,
                    dueRemark: '',
                    accessStatus: 0,
                    vipStatus: vipInfo.vipStatus || 0,
                    vipStatusWarn: '',
                    themeType: 0,
                    label: {
                        path: '',
                        text: vipInfo.label ? vipInfo.label.text || '' : '',
                        label_theme: vipInfo.label ? vipInfo.label.label_theme || '' : '',
                        text_color: '', bg_style: 0, bg_color: '', border_color: ''
                    }
                },
                silence: 0,
                end_time: 0,
                silence_url: '',
                likes: { like_num: 0, skr_tip: '该页面由哔哩漫游修复' },
                pr_info: {},
                relation: { status: 1 },
                is_deleted: 0,
                honours: { colour: { dark: '#CE8620', normal: '#F0900B' }, tags: null },
                profession: {}
            },
            images: {
                imgUrl: face || 'https://github.com/MiRinChan/BiliRoaming/releases/download/image/IMG_20260624_232433.png',
                night_imgurl: face || 'https://github.com/MiRinChan/BiliRoaming/releases/download/image/IMG_20260624_232433.png',
                has_garb: true,
                goods_available: true
            },
            live: {
                roomStatus: 0, roundStatus: 0, liveStatus: 0,
                url: '', title: '', cover: '', online: 0, roomid: 0,
                broadcast_type: 0, online_hidden: 0, link: ''
            },
            archive: {
                order: [
                    { title: '最新发布', value: 'pubdate' },
                    { title: '最多播放', value: 'click' }
                ],
                count: 9999,
                item: []
            },
            series: { item: [] },
            play_game: { count: 0, item: [] },
            article: { count: 0, item: [], lists_count: 0, lists: [] },
            season: { count: 0, item: [] },
            coin_archive: { count: 0, item: [] },
            like_archive: { count: 0, item: [] },
            audios: { count: 0, item: [] },
            favourite2: { count: 0, item: [] },
            comic: { count: 0, item: [] },
            ugc_season: { count: 0, item: [] },
            cheese: { count: 0, item: [] },
            fans_effect: {},
            tab2: [
                { title: '动态', param: 'dynamic' },
                { title: '投稿', param: 'contribute', items: [{ title: '视频', param: 'video' }] }
            ]
        }
    };
}

/**
 * 从 URL 中提取 mid 参数
 */
function extractMid(url) {
    // 匹配 mid= 或 vmid= 参数
    const midMatch = url.match(/[?&](?:mid|vmid)=(\d+)/);
    if (midMatch) return midMatch[1];

    // 匹配路径中的 mid (space.bilibili.com/{mid})
    // URL 格式: .../x/space/acc/info?mid=123
    return null;
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
        // Surge [{key}] template passes raw value without key= prefix
        if ($argument && !$argument.includes('=')) return $argument;
    }
    return def;
}
