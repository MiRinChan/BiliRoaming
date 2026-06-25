/**
 * BiliRoaming - 链接净化
 *
 * 拦截 B站分享 API，根据参数把 b23.tv / bili2233.cn 短链接替换为更稳定的
 * av / BV / bangumi 页面链接。
 *
 * 参数:
 *   mode=short  透传（默认）
 *   mode=av     替换为 bilibili.com/video/av{oid}
 *   mode=bv     替换为 bilibili.com/video/BVxxxxx
 */
(function main() {
    var mode = readArg('mode', 'short');

    if (['short', 'av', 'bv'].indexOf(mode) === -1) {
        console.log('BiliRoaming long_link invalid arg: ' + mode);
        finish();
        return;
    }

    if (mode === 'short' || !$response.body || $request.method !== 'POST') {
        finish();
        return;
    }

    var response = parseJson($response.body);
    if (!response || response.code !== 0 || !response.data || !response.data.content) {
        finish();
        return;
    }

    var content = response.data.content;
    var shortLink = findShortLink(content);
    if (!shortLink) {
        finishWithBody(response);
        return;
    }

    if (mode === 'av') {
        rewriteToAv(response, content, shortLink);
        finishWithBody(response);
        return;
    }

    rewriteToBv(response, content, shortLink, function(fixed) {
        finishWithBody(fixed);
    });
})();

function rewriteToAv(response, content, shortLink) {
    var form = parseForm($request.body || '');
    var oid = form.oid;
    var avFromPath;

    if (oid && /^\d+$/.test(String(oid))) {
        response.data.content = replaceLink(
            content,
            shortLink.raw,
            'https://www.bilibili.com/video/av' + oid
        );
        return;
    }

    avFromPath = shortLink.path.match(/^(av\d+)/i);
    if (avFromPath) {
        response.data.content = replaceLink(
            content,
            shortLink.raw,
            'https://www.bilibili.com/video/' + avFromPath[1]
        );
    }
}

function rewriteToBv(response, content, shortLink, done) {
    var directUrl = extractContentUrl(shortLink.path);

    if (directUrl) {
        response.data.content = replaceLink(content, shortLink.raw, stripTracking(directUrl));
        done(response);
        return;
    }

    resolveRedirect(shortLink.path, function(resolvedUrl) {
        if (resolvedUrl) {
            response.data.content = replaceLink(content, shortLink.raw, stripTracking(resolvedUrl));
        }
        done(response);
    });
}

function findShortLink(content) {
    var match = String(content).match(/https?:\/\/(?:bili2233\.cn|b23\.tv)\/(\S+)/);
    var raw;
    var path;

    if (!match) return null;

    raw = match[0];
    path = match[1].replace(/[\s?].*$/, '');
    path = path.replace(/[)\]}>，。！？、,.!?]+$/, '');

    return {
        raw: raw,
        path: path
    };
}

function replaceLink(content, rawLink, replacement) {
    return String(content).replace(rawLink, replacement);
}

/**
 * 从短路径直接提取 BV/AV/SS/EP 页面链接。
 */
function extractContentUrl(shortPath) {
    var match = shortPath.match(/^(BV[A-Za-z0-9]{10})/);
    if (match) return 'https://www.bilibili.com/video/' + match[1];

    match = shortPath.match(/^(av\d+)/i);
    if (match) return 'https://www.bilibili.com/video/' + match[1];

    match = shortPath.match(/^(ss\d+)/i);
    if (match) return 'https://www.bilibili.com/bangumi/play/' + match[1];

    match = shortPath.match(/^(ep\d+)/i);
    if (match) return 'https://www.bilibili.com/bangumi/play/' + match[1];

    return null;
}

/**
 * HTTP HEAD 跟随 b23.tv 重定向。没有可用 HTTP runtime 时保持原文。
 */
function resolveRedirect(shortPath, callback) {
    var url = 'https://b23.tv/' + shortPath;
    var done = once(callback);
    var timeout = setTimeout(function() {
        done(null);
    }, 3000);

    function settle(url) {
        clearTimeout(timeout);
        done(url);
    }

    if (typeof $httpClient !== 'undefined' && $httpClient.head) {
        $httpClient.head({ url: url, 'auto-redirect': false }, function(error, response) {
            var headers;
            var location;

            if (!error && response) {
                headers = response.headers || {};
                location = headers.Location || headers.location;
                if (!location && response.status === 302 && response.url && response.url !== url) {
                    location = response.url;
                }
            }

            settle(location || null);
        });
        return;
    }

    if (typeof $task !== 'undefined' && $task.fetch) {
        $task.fetch({ url: url, method: 'HEAD' }).then(
            function(response) {
                var headers = response.headers || {};
                settle(headers.Location || headers.location || null);
            },
            function() {
                settle(null);
            }
        );
        return;
    }

    settle(null);
}

/**
 * 保留分页和时间戳参数，去掉分享追踪参数，并附加哔哩漫游处理标记。
 */
function stripTracking(url) {
    var splitAt;
    var base;
    var query;
    var parts;
    var keep = [];
    var i;
    var param;
    var eqAt;
    var key;
    var value;

    if (!url || typeof url !== 'string') return url;

    splitAt = url.indexOf('?');
    if (splitAt === -1) return url + '?unique_k=2333';

    base = url.slice(0, splitAt);
    query = url.slice(splitAt + 1);
    parts = query.split('&');

    for (i = 0; i < parts.length; i++) {
        param = parts[i];
        eqAt = param.indexOf('=');
        key = eqAt > 0 ? param.slice(0, eqAt) : param;

        if (key === 'p' || key === 't') {
            keep.push(param);
        } else if (key === 'start_progress') {
            value = eqAt > 0 ? parseInt(param.slice(eqAt + 1), 10) : 0;
            if (!isNaN(value) && value > 0) {
                keep.push('t=' + Math.floor(value / 1000));
            }
        }
    }

    keep.push('unique_k=2333');
    return base + '?' + keep.join('&');
}

function parseForm(body) {
    var result = {};
    var pairs;
    var i;
    var pair;
    var eqAt;
    var key;
    var value;

    if (!body) return result;

    try {
        pairs = String(body).split('&');
        for (i = 0; i < pairs.length; i++) {
            pair = pairs[i];
            eqAt = pair.indexOf('=');
            if (eqAt <= 0) continue;

            key = decodeURIComponent(pair.slice(0, eqAt));
            value = decodeURIComponent(pair.slice(eqAt + 1).replace(/\+/g, ' '));
            result[key] = value;
        }
    } catch (_) {
        return {};
    }

    return result;
}

function parseJson(body) {
    try {
        return JSON.parse(body);
    } catch (error) {
        console.log('BiliRoaming long_link parse error: ' + error);
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

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function once(callback) {
    var called = false;
    return function(value) {
        if (called) return;
        called = true;
        callback(value);
    };
}

function finishWithBody(obj) {
    $done({ body: JSON.stringify(obj) });
}

function finish() {
    $done({});
}
