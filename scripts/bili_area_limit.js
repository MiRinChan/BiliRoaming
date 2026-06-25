/**
 * BiliRoaming - 番剧区域限制修复
 *
 * 修改 B站 PGC / 播放地址 / 搜索响应中的限制字段。主站接口返回 -404 时，
 * 尝试通过国际版 bstar API 获取数据并重建兼容响应。
 *
 * 参数:
 *   area=true    启用
 *   area=unlock  启用
 *   area=false   透传（默认）
 */
(function main() {
    var areaArg = readArg('area', false);
    var enabled = isEnabled(areaArg);
    var response;
    var url = $request.url || '';

    if (!isKnownArg(areaArg)) {
        console.log('BiliRoaming area_limit invalid arg: ' + areaArg);
    }

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
        if (isSeasonUrl(url)) {
            handleSeason(response, url);
            return;
        }

        if (isPlayurlUrl(url)) {
            handlePlayurl(response, url);
            return;
        }

        if (isSearchUrl(url)) {
            handleSearch(response);
            return;
        }

        finish();
    } catch (error) {
        console.log('BiliRoaming area_limit error: ' + error);
        finish();
    }
})();

function handleSeason(response, url) {
    var seasonId;
    var epId;
    var intlUrl;

    if (response.code === 0) {
        finishWithBody(fixSeasonResponse(response));
        return;
    }

    if (!isMainSeasonUrl(url) || response.code !== -404) {
        finish();
        return;
    }

    seasonId = extractParam(url, 'season_id');
    if (!seasonId) {
        console.log('BiliRoaming area_limit: -404 but no season_id in URL');
        finish();
        return;
    }

    epId = extractParam(url, 'ep_id') || '';
    intlUrl = buildIntlSeasonUrl(seasonId, epId);

    console.log('BiliRoaming area_limit: -404 for season ' + seasonId + ', trying intl API');
    fetchIntlJson(intlUrl, 8000, function(error, intlResponse) {
        if (!error && intlResponse && intlResponse.code === 0) {
            console.log('BiliRoaming area_limit: season restored from intl API for ' + seasonId);
            finishWithBody(rebuildSeasonFromIntl(intlResponse, seasonId));
            return;
        }

        console.log('BiliRoaming area_limit: intl season fetch failed, pass-through -404');
        finishWithBody(response);
    });
}

function handlePlayurl(response, url) {
    var epId;
    var cid;
    var intlUrl;

    if (response.code === 0) {
        finishWithBody(fixPlayurlResponse(response));
        return;
    }

    if (response.code !== -404) {
        finish();
        return;
    }

    epId = extractParam(url, 'ep_id') || extractParam(url, 'avid') || '';
    cid = extractParam(url, 'cid') || '';
    if (!epId && !cid) {
        console.log('BiliRoaming area_limit: playurl -404 but no ep_id/cid in URL');
        finish();
        return;
    }

    intlUrl = buildIntlPlayurlUrl({
        ep_id: epId,
        cid: cid,
        qn: extractParam(url, 'qn') || '80',
        fnval: extractParam(url, 'fnval') || '4048',
        fourk: extractParam(url, 'fourk') || '1'
    });

    console.log('BiliRoaming area_limit: playurl -404 for ep=' + epId + ' cid=' + cid + ', trying intl API');
    fetchIntlJson(intlUrl, 8000, function(error, intlResponse) {
        if (!error && intlResponse && intlResponse.code === 0) {
            console.log('BiliRoaming area_limit: playurl restored from intl API');
            finishWithBody(rebuildPlayurlFromIntl(intlResponse));
            return;
        }

        console.log('BiliRoaming area_limit: intl playurl fetch failed, pass-through -404');
        finishWithBody(response);
    });
}

function handleSearch(response) {
    if (response.code === 0) {
        finishWithBody(fixSearchResponse(response));
        return;
    }

    finish();
}

function isMainSeasonUrl(url) {
    return url.indexOf('/pgc/view/') !== -1;
}

function isSeasonUrl(url) {
    return isMainSeasonUrl(url)
        || (url.indexOf('/intl/gateway/') !== -1 && url.indexOf('/season') !== -1);
}

function isPlayurlUrl(url) {
    return url.indexOf('/playurl') !== -1
        || url.indexOf('pgc/player') !== -1
        || url.indexOf('/x/tv/') !== -1;
}

function isSearchUrl(url) {
    return url.indexOf('/x/v') !== -1 && url.indexOf('/search') !== -1;
}

// ============================================================
// 正常响应修复
// ============================================================

function fixSeasonResponse(response) {
    var data;
    var sections;

    if (!response || response.code !== 0) return response;

    data = response.data || response.result;
    if (!data) return response;

    fixAreaLimit(data);
    allowDownload(data);

    fixEpisodeList(data.episodes);
    fixSeasonList(data.seasons);
    fixModules(data.modules);
    fixSectionList(data.prevueSection, false);

    sections = data.section || data.sections;
    fixSectionList(sections, true);

    removeAreaBadges(data);
    clearRegionDialog(data);

    return response;
}

function fixEpisodeList(episodes) {
    if (!Array.isArray(episodes)) return;

    episodes.forEach(function(episode) {
        fixEpisode(episode);
    });
}

function fixSeasonList(seasons) {
    if (!Array.isArray(seasons)) return;

    seasons.forEach(function(season) {
        fixAreaLimit(season);
        allowDownload(season);
    });
}

function fixModules(modules) {
    if (!Array.isArray(modules)) return;

    modules.forEach(function(module) {
        if (!module || typeof module !== 'object') return;

        if (hasOwn(module, 'area_limit')) {
            module.area_limit = 0;
        }

        if (module.data && Array.isArray(module.data.episodes)) {
            fixEpisodeList(module.data.episodes);
        }
    });
}

function fixSectionList(sections, fixStatus) {
    if (!Array.isArray(sections)) return;

    sections.forEach(function(section) {
        if (!section || !Array.isArray(section.episodes)) return;

        section.episodes.forEach(function(episode) {
            fixAreaLimit(episode);
            allowDownload(episode);
            if (fixStatus) fixEpisodeStatus(episode);
        });
    });
}

function fixEpisode(episode) {
    fixAreaLimit(episode);
    allowDownload(episode);
    fixEpisodeStatus(episode);
}

function fixPlayurlResponse(response) {
    var data;

    if (!response || response.code !== 0) return response;

    data = response.data || response.result;
    if (!data) return response;

    fixAreaLimit(data);

    if (data.dash) {
        fixAreaLimit(data.dash);
        fixMediaList(data.dash.video);
        fixMediaList(data.dash.audio);
    }

    fixMediaList(data.durl);

    return response;
}

function fixMediaList(list) {
    if (!Array.isArray(list)) return;

    list.forEach(function(item) {
        fixAreaLimit(item);
    });
}

function fixSearchResponse(response) {
    var data;
    var items;

    if (!response || response.code !== 0) return response;

    data = response.data || response.result;
    if (!data) return response;

    items = data.result || data.items;
    if (!Array.isArray(items)) return response;

    items.forEach(function(item) {
        if (!item) return;
        fixAreaLimit(item);
        if (item.badge) item.badge = cleanLimitText(item.badge);
    });

    return response;
}

function removeAreaBadges(data) {
    if (!data) return;

    if (data.badge_info && data.badge_info.text) {
        data.badge_info.text = cleanLimitText(data.badge_info.text);
    }

    if (data.evaluate) {
        data.evaluate = cleanLimitText(data.evaluate);
    }

    if (Array.isArray(data.episodes)) {
        data.episodes.forEach(function(episode) {
            if (!episode) return;
            if (episode.badge) episode.badge = cleanLimitText(episode.badge);
            if (episode.long_title) episode.long_title = cleanLimitText(episode.long_title);
        });
    }
}

function clearRegionDialog(data) {
    if (!data || typeof data !== 'object') return;

    delete data.limit;
    data.limit = null;
    delete data.dialog;
    data.dialog = null;
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

    if (obj.area === 'restricted') {
        obj.area = '';
    }
}

function allowDownload(obj) {
    if (!obj || typeof obj !== 'object') return;

    obj.allow_download = 1;

    if (obj.rights && typeof obj.rights === 'object') {
        obj.rights.allow_download = 1;
        obj.rights.only_vip_download = 0;
    }
}

function fixEpisodeStatus(episode) {
    if (!episode || typeof episode !== 'object') return;

    if (episode.status === 13) episode.status = 2;
    if (episode.episode_status === 13) episode.episode_status = 2;

    if (episode.badge && /[泰会员會VIP仅僅限]/.test(episode.badge)) {
        episode.badge = '';
    }
}

function cleanLimitText(text) {
    return String(text).replace(/[受僅仅限定][区區]?/g, '');
}

// ============================================================
// 国际版 API 回退
// ============================================================

function buildIntlSeasonUrl(seasonId, epId) {
    var url = 'https://api.bilibili.com/intl/gateway/v2/ogv/view/app/season'
        + '?season_id=' + encodeURIComponent(seasonId);

    if (epId) {
        url += '&ep_id=' + encodeURIComponent(epId);
    }

    return url + '&s_locale=zh_SG&mobi_app=bstar_a&build=1080003';
}

function buildIntlPlayurlUrl(params) {
    return 'https://api.bilibili.com/intl/gateway/v2/ogv/playurl'
        + '?ep_id=' + encodeURIComponent(params.ep_id || '')
        + '&cid=' + encodeURIComponent(params.cid || '')
        + '&qn=' + encodeURIComponent(params.qn || '80')
        + '&fnval=' + encodeURIComponent(params.fnval || '4048')
        + '&fnver=0'
        + '&fourk=' + encodeURIComponent(params.fourk || '1');
}

function rebuildSeasonFromIntl(intlResponse, seasonId) {
    var source = intlResponse.result || intlResponse.data || {};
    var response;
    var result;
    var topKeys;

    if (!source || typeof source !== 'object') return intlResponse;

    response = {
        code: 0,
        message: '0',
        result: {}
    };
    result = response.result;

    topKeys = [
        'season_id',
        'season_title',
        'title',
        'cover',
        'horizontal_cover',
        'evaluate',
        'publish',
        'type',
        'type_name',
        'subtitle',
        'staff',
        'style',
        'styles',
        'actor',
        'actors',
        'rating',
        'stat',
        'newest_ep',
        'total',
        'series',
        'payment',
        'user_status',
        'up_info',
        'short_link',
        'share_url',
        'record',
        'positive'
    ];

    topKeys.forEach(function(key) {
        if (source[key] !== undefined) {
            result[key] = source[key];
        }
    });

    result.season_id = parseInt(seasonId, 10) || seasonId;
    result.episodes = Array.isArray(source.episodes) ? source.episodes.map(normalizeEpisode) : [];
    result.modules = normalizeModules(source.modules);

    copyNormalizedSections(source, result);

    if (!result.rights) result.rights = {};
    result.rights.area_limit = 0;
    result.rights.allow_dm = 1;
    result.rights.allow_download = 1;
    result.rights.only_vip_download = 0;

    if (!result.user_status) result.user_status = {};
    result.user_status.follow = result.user_status.follow || 1;

    clearRegionDialog(result);

    if (!result.actor && source.actors) {
        result.actor = { info: String(source.actors) };
    }

    return response;
}

function normalizeModules(modules) {
    if (!Array.isArray(modules)) return [];

    return modules.map(function(module) {
        if (!module || typeof module !== 'object') return module;

        if (module.data && Array.isArray(module.data.episodes)) {
            module.data.episodes = module.data.episodes.map(normalizeEpisode);
        }

        if (hasOwn(module, 'area_limit')) {
            module.area_limit = 0;
        }

        return module;
    });
}

function copyNormalizedSections(source, target) {
    ['prevueSection', 'section', 'sections'].forEach(function(key) {
        if (!Array.isArray(source[key])) return;

        target[key] = source[key].map(function(section) {
            if (section && Array.isArray(section.episodes)) {
                section.episodes = section.episodes.map(normalizeEpisode);
            }
            return section;
        });
    });
}

function normalizeEpisode(episode) {
    if (!episode || typeof episode !== 'object') return episode;

    if (episode.id !== undefined && episode.ep_id === undefined) episode.ep_id = episode.id;
    if (episode.title !== undefined && episode.index === undefined) episode.index = episode.title;
    if (episode.long_title !== undefined && episode.indexTitle === undefined) {
        episode.indexTitle = episode.long_title;
    }

    if (!episode.cid || episode.cid === 0) episode.cid = episode.ep_id || 0;
    if (!episode.aid || episode.aid === 0) episode.aid = episode.ep_id || 0;

    if (!episode.rights) episode.rights = {};
    episode.rights.area_limit = 0;
    episode.rights.allow_dm = 1;
    episode.rights.allow_download = 1;
    episode.allow_download = 1;
    episode.area_limit = 0;

    fixEpisodeStatus(episode);

    if (episode.long_title) {
        episode.long_title = cleanLimitText(episode.long_title);
    }

    return episode;
}

function rebuildPlayurlFromIntl(intlResponse) {
    var source = intlResponse.result || intlResponse.data || {};
    var videoInfo;

    if (!source || typeof source !== 'object') return intlResponse;

    videoInfo = source.video_info || source;

    return {
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
}

function buildDash(videoInfo) {
    var dash = {
        duration: videoInfo.timelength || 0,
        minBufferTime: 1.5,
        min_buffer_time: 1.5
    };
    var videos = videoInfo.dash_video || videoInfo.dash && videoInfo.dash.video || [];
    var audios = videoInfo.dash_audio || videoInfo.dash && videoInfo.dash.audio || [];

    dash.video = Array.isArray(videos) ? videos.map(normalizeDashItem) : [];
    dash.audio = Array.isArray(audios) ? audios.map(normalizeDashItem) : [];

    return dash;
}

function normalizeDashItem(item) {
    if (!item || typeof item !== 'object') return item;

    if (!item.base_url && item.baseUrl) item.base_url = item.baseUrl;
    if (!item.backup_url && item.backupUrl) item.backup_url = item.backupUrl;
    if (!item.id && item.quality) item.id = item.quality;

    return item;
}

// ============================================================
// Runtime helpers
// ============================================================

function fetchIntlJson(url, timeoutMs, callback) {
    var started = fetchText(url, timeoutMs, function(error, body) {
        var json;

        if (error || !body) {
            callback(error || new Error('empty body'), null);
            return;
        }

        json = parseJson(body);
        if (!json) {
            callback(new Error('invalid json'), null);
            return;
        }

        callback(null, json);
    });

    if (!started) {
        console.log('BiliRoaming area_limit: no HTTP client available for fallback');
        callback(new Error('no http client'), null);
    }
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

function extractParam(url, key) {
    var match = String(url).match(new RegExp('[?&]' + key + '=([^&]*)'));
    return match ? decodeURIComponent(match[1]) : null;
}

function parseJson(body) {
    try {
        return JSON.parse(body);
    } catch (error) {
        console.log('BiliRoaming area_limit parse error: ' + error);
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

function isKnownArg(value) {
    return value === false
        || value === true
        || value === 'false'
        || value === 'true'
        || value === 'unlock'
        || value === undefined
        || value === null
        || value === '';
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
