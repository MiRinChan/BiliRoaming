/**
 * BiliRoaming - 用户空间修复
 *
 * 修复被区域限制、账号状态或注销状态影响的用户空间响应。
 *
 * 参数:
 *   space=true   启用空间修复
 *   space=false  透传（默认）
 */
(function main() {
    var enabled = isEnabled(readArg('space', false));
    var response;
    var url = $request.url || '';

    if (!enabled || !$response.body) {
        finish();
        return;
    }

    response = parseJson($response.body);
    if (!response) {
        finish();
        return;
    }

    try {
        if (isProfileUrl(url)) {
            fixProfile(response, url, finishWithBody);
            return;
        }

        if (isArchiveUrl(url)) {
            response = fixArchive(response);
        }

        if (isFeedUrl(url)) {
            response = fixFeed(response);
        }

        finishWithBody(response);
    } catch (error) {
        console.log('BiliRoaming space_fix error: ' + error);
        finish();
    }
})();

function isProfileUrl(url) {
    return url.indexOf('/space/acc/info') !== -1
        || url.indexOf('/x/space?') !== -1
        || /\/x\/v\d+\/space\?/.test(url);
}

function isArchiveUrl(url) {
    return url.indexOf('/space/arc/search') !== -1
        || url.indexOf('/space/wbi/arc/search') !== -1
        || url.indexOf('/v2/space/archive') !== -1;
}

function isFeedUrl(url) {
    return url.indexOf('/community-service') !== -1 && url.indexOf('/user/feed') !== -1;
}

function isV2ProfileUrl(url) {
    return url.indexOf('/x/space?') !== -1 || /\/x\/v\d+\/space\?/.test(url);
}

/**
 * 修复用户信息。
 */
function fixProfile(response, url, done) {
    var mid;
    var cardUrl;
    var started;

    if (!response) {
        done(response);
        return;
    }

    if (response.code === 0) {
        fixProfileData(response.data);
        done(response);
        return;
    }

    if (response.code !== -404) {
        done(response);
        return;
    }

    mid = extractMid(url);
    if (!mid) {
        done(response);
        return;
    }

    cardUrl = 'https://account.bilibili.com/api/member/getCardByMid?mid=' + encodeURIComponent(mid);
    started = fetchText(cardUrl, 8000, function(error, body) {
        var card = parseCard(body);

        if (card) {
            console.log('BiliRoaming space_fix: restored deactivated user ' + mid);
            done(buildFakeAccInfo(mid, card, isV2ProfileUrl(url)));
            return;
        }

        console.log('BiliRoaming space_fix: getCardByMid failed, fallback for ' + mid);
        done(buildFakeAccInfo(mid, null, isV2ProfileUrl(url)));
    });

    if (!started) {
        console.log('BiliRoaming space_fix: no HTTP client available for -404 fix, mid=' + mid);
        done(response);
    }
}

function fixProfileData(data) {
    if (!data) return;

    if (data.card) {
        fixUserCard(data.card);
    }

    if (data.space) {
        fixAreaLimit(data.space);
    }

    if (data.images) {
        fixAreaLimit(data.images);
    }
}

function fixUserCard(card) {
    if (!card || typeof card !== 'object') return;

    fixAreaLimit(card);

    if (card.status === -1 && Number(card.mid) > 0) {
        card.status = 1;
    }

    if (card.official_verify === -1) {
        card.official_verify = 1;
    }

    if (card.badge) card.badge = cleanLimitText(card.badge);
    if (card.description) card.description = cleanLimitText(card.description);
    if (card.sign) card.sign = cleanLimitText(card.sign);

    if (card.mid !== undefined && card.mid !== null) {
        card.mid = String(card.mid);
    }
}

function parseCard(body) {
    var response;

    if (!body) return null;

    try {
        response = JSON.parse(body);
    } catch (error) {
        console.log('BiliRoaming space_fix card parse error: ' + error);
        return null;
    }

    if (response && response.code === 0 && response.card) {
        return response.card;
    }

    return null;
}

/**
 * 从 getCardByMid 响应构建 BiliSpace 格式数据。
 */
function buildFakeAccInfo(mid, card, isV2) {
    var levelInfo;
    var officialVerify;
    var vipInfo;
    var face;

    card = card || {};
    levelInfo = card.level_info || {};
    officialVerify = card.official_verify || {};
    vipInfo = card.vip || {};
    face = card.face || '';

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
                fav_video: 0,
                coins_video: 0,
                likes_video: 0,
                bangumi: 0,
                played_game: 0,
                groups: 0,
                comic: 0,
                bbq: 0,
                dress_up: 0,
                disable_following: 0,
                live_playback: 1,
                close_space_medal: 0,
                only_show_wearing: 0
            },
            tab: {
                archive: true,
                article: true,
                clip: true,
                album: true,
                favorite: false,
                bangumi: false,
                coin: false,
                like: false,
                community: false,
                dynamic: true,
                audios: true,
                shop: false,
                mall: false,
                ugc_season: false,
                comic: false,
                cheese: false,
                sub_comic: false,
                activity: false,
                series: false
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
                description: '该页面由哔哩漫游修复',
                article: 0,
                attentions: [],
                fans: card.fans || 0,
                friend: card.friend || 0,
                attention: card.attention || 0,
                sign: '【该页面由哔哩漫游修复】' + (card.sign || ''),
                level_info: {
                    current_level: levelInfo.current_level || 0,
                    current_min: levelInfo.current_min || 0,
                    current_exp: levelInfo.current_exp || 0,
                    next_exp: levelInfo.next_exp || 0
                },
                pendant: {
                    pid: 0,
                    name: '',
                    image: '',
                    expire: 0,
                    image_enhance: '',
                    image_enhance_frame: ''
                },
                nameplate: {
                    nid: 0,
                    name: '',
                    image: '',
                    image_small: '',
                    level: '',
                    condition: ''
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
                        text_color: '',
                        bg_style: 0,
                        bg_color: '',
                        border_color: ''
                    }
                },
                silence: 0,
                end_time: 0,
                silence_url: '',
                likes: {
                    like_num: 0,
                    skr_tip: '该页面由哔哩漫游修复'
                },
                pr_info: {},
                relation: {
                    status: 1
                },
                is_deleted: 0,
                honours: {
                    colour: {
                        dark: '#CE8620',
                        normal: '#F0900B'
                    },
                    tags: null
                },
                profession: {}
            },
            images: {
                imgUrl: face || 'https://github.com/MiRinChan/BiliRoaming/releases/download/image/IMG_20260624_232433.png',
                night_imgurl: face || 'https://github.com/MiRinChan/BiliRoaming/releases/download/image/IMG_20260624_232433.png',
                has_garb: true,
                goods_available: true
            },
            live: {
                roomStatus: 0,
                roundStatus: 0,
                liveStatus: 0,
                url: '',
                title: '',
                cover: '',
                online: 0,
                roomid: 0,
                broadcast_type: 0,
                online_hidden: 0,
                link: ''
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
 * 修复用户投稿列表。
 */
function fixArchive(response) {
    var data;

    if (!response || response.code !== 0) return response;

    data = response.data;
    if (!data) return response;

    visitArchiveLists(data, function(video) {
        fixVideoItem(video);
    });

    return response;
}

function visitArchiveLists(data, visitor) {
    var lists = [];
    var i;

    addList(lists, data.list && data.list.vlist);
    addList(lists, data.vlist);
    addList(lists, data.archives);

    for (i = 0; i < lists.length; i++) {
        lists[i].forEach(visitor);
    }
}

function addList(lists, list) {
    if (Array.isArray(list) && lists.indexOf(list) === -1) {
        lists.push(list);
    }
}

function fixVideoItem(video) {
    if (!video || typeof video !== 'object') return;

    fixAreaLimit(video);

    if (video.badge) video.badge = cleanLimitText(video.badge);
    if (video.title) video.title = cleanLimitTitle(video.title);

    if (video.play === -1 || video.play === '--') video.play = 0;
    if (video.danmaku === -1 || video.danmaku === '--') video.danmaku = 0;
    if (video.video_review === -1) video.video_review = 0;
}

/**
 * 修复用户动态。
 */
function fixFeed(response) {
    var data;
    var items;

    if (!response || response.code !== 0) return response;

    data = response.data;
    if (!data) return response;

    items = data.items || data.cards || data.list;
    if (!Array.isArray(items)) return response;

    items.forEach(function(item) {
        if (!item) return;

        fixAreaLimit(item);
        if (item.badge) item.badge = cleanLimitText(item.badge);

        if (item.modules) {
            fixAreaLimit(item.modules.module_dynamic);
            fixAreaLimit(item.modules.module_author);
        }
    });

    return response;
}

function fixAreaLimit(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.rights && typeof obj.rights === 'object') {
        obj.rights.area_limit = 0;
        obj.rights.allow_dm = 1;
        obj.rights.allow_download = 1;
    }

    if (hasOwn(obj, 'area_limit') && obj.area_limit === 1) obj.area_limit = 0;
    if (hasOwn(obj, 'allow_dm') && obj.allow_dm === 0) obj.allow_dm = 1;
    if (hasOwn(obj, 'allow_download') && obj.allow_download === 0) obj.allow_download = 1;
    if (hasOwn(obj, 'allow_comment') && obj.allow_comment === 0) obj.allow_comment = 1;
    if (hasOwn(obj, 'allow_demand') && obj.allow_demand === 0) obj.allow_demand = 1;
    if (hasOwn(obj, 'status') && obj.status === -1) obj.status = 1;

    if (obj.area === 'restricted') {
        obj.area = '';
    }
}

function cleanLimitText(text) {
    return String(text).replace(/[受僅仅限定][区區]?/g, '');
}

function cleanLimitTitle(title) {
    return String(title).replace(/[\[【(（]?[受僅仅限定][区區]?[\]】)）]?/g, '');
}

function extractMid(url) {
    var match = String(url).match(/[?&](?:mid|vmid)=(\d+)/);
    return match ? match[1] : null;
}

function fetchText(url, timeoutMs, callback) {
    var done;
    var timer;

    if (typeof $httpClient !== 'undefined' && $httpClient.get) {
        done = once(function(error, body) {
            clearTimeout(timer);
            callback(error, body);
        });
        timer = setTimeout(function() {
            done(new Error('timeout'), null);
        }, timeoutMs);

        $httpClient.get(url, function(error, response, body) {
            done(error, body);
        });
        return true;
    }

    if (typeof $task !== 'undefined' && $task.fetch) {
        done = once(function(error, body) {
            clearTimeout(timer);
            callback(error, body);
        });
        timer = setTimeout(function() {
            done(new Error('timeout'), null);
        }, timeoutMs);

        $task.fetch(url).then(
            function(response) {
                done(null, response && response.body);
            },
            function(error) {
                done(error, null);
            }
        );
        return true;
    }

    return false;
}

function parseJson(body) {
    try {
        return JSON.parse(body);
    } catch (error) {
        console.log('BiliRoaming space_fix parse error: ' + error);
        return null;
    }
}

function readArg(key, def) {
    var match;

    if (typeof $argument === 'object' && $argument && hasOwn($argument, key)) {
        return $argument[key];
    }

    if (typeof $argument === 'string') {
        match = $argument.match(new RegExp(key + '=([^&]*)'));
        if (match) return match[1];
        if ($argument && $argument.indexOf('=') === -1) return $argument;
    }

    return def;
}

function isEnabled(value) {
    return value === true || value === 'true' || value === 'unlock';
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function once(callback) {
    var called = false;
    return function(error, body) {
        if (called) return;
        called = true;
        callback(error, body);
    };
}

function finishWithBody(obj) {
    $done({ body: JSON.stringify(obj) });
}

function finish() {
    $done({});
}
