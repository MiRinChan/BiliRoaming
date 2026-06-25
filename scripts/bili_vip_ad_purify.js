/**
 * BiliRoaming - 大会员广告净化
 *
 * 删除 B站响应中广告/推广容器里的大会员推广内容。只处理广告语境中的
 * 大会员内容，避免误删用户资料里的正常 vip 状态字段。
 *
 * 参数:
 *   vip_ad=true   启用
 *   vip_ad=false  透传（默认）
 */
(function main() {
    var enabled = isEnabled(readArg('vip_ad', false));
    var response;
    var changed;

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
        changed = cleanObject(response);
        if (changed) {
            finishWithBody(response);
            return;
        }

        finish();
    } catch (error) {
        console.log('BiliRoaming vip_ad_purify error: ' + error);
        finish();
    }
})();

function cleanObject(obj) {
    var changed = false;
    var key;
    var value;

    if (!obj || typeof obj !== 'object') return false;

    for (key in obj) {
        if (!hasOwn(obj, key)) continue;

        value = obj[key];
        if (Array.isArray(value) && !isVipAdKey(key)) {
            if (cleanArray(value, key)) changed = true;
            continue;
        }

        if (shouldRemoveValue(key, value)) {
            delete obj[key];
            changed = true;
            continue;
        }

        if (value && typeof value === 'object') {
            if (cleanObject(value)) changed = true;
        }
    }

    return changed;
}

function cleanArray(list, key) {
    var result = [];
    var changed = false;
    var i;
    var item;

    for (i = 0; i < list.length; i++) {
        item = list[i];

        if (shouldRemoveValue(key, item) || shouldRemoveArrayItem(item)) {
            changed = true;
            continue;
        }

        if (Array.isArray(item)) {
            if (cleanArray(item, key)) changed = true;
        } else if (item && typeof item === 'object') {
            if (cleanObject(item)) changed = true;
        }

        result.push(item);
    }

    if (!changed) return false;

    list.length = 0;
    for (i = 0; i < result.length; i++) {
        list.push(result[i]);
    }

    return true;
}

function shouldRemoveValue(key, value) {
    if (isVipAdKey(key)) return true;
    if (isAdContainerKey(key) && hasVipSignal(value)) return true;
    if (isAdLikeObject(value) && hasVipSignal(value)) return true;
    return false;
}

function shouldRemoveArrayItem(item) {
    if (!item || typeof item !== 'object') return false;
    return isAdLikeObject(item) && hasVipSignal(item);
}

function isVipAdKey(key) {
    var normalized = normalizeKey(key);
    return normalized.indexOf('vip_ad') !== -1
        || normalized.indexOf('vipad') !== -1
        || normalized.indexOf('big_member_ad') !== -1
        || normalized.indexOf('bigmember_ad') !== -1
        || normalized.indexOf('member_ad') !== -1;
}

function isAdContainerKey(key) {
    var normalized = normalizeKey(key);

    return normalized === 'ad'
        || normalized === 'ads'
        || normalized === 'ad_info'
        || normalized === 'ad_list'
        || normalized === 'ad_items'
        || normalized.indexOf('ad_') === 0
        || normalized.indexOf('_ad') !== -1
        || normalized.indexOf('banner') !== -1
        || normalized.indexOf('popup') !== -1
        || normalized.indexOf('pop_up') !== -1
        || normalized.indexOf('dialog') !== -1
        || normalized.indexOf('splash') !== -1
        || normalized.indexOf('promote') !== -1
        || normalized.indexOf('promotion') !== -1
        || normalized.indexOf('operation') !== -1
        || normalized.indexOf('cm') === 0
        || normalized.indexOf('_cm') !== -1;
}

function isAdLikeObject(value) {
    var marker;

    if (!value || typeof value !== 'object') return false;

    if (value.is_ad === true || value.is_ad === 1) return true;
    if (value.ad_info || value.ad_cb || value.cm_mark || value.cm_config) return true;

    marker = firstString(value.card_goto, value.card_type, value.goto, value.type, value.style);
    return /^(ad|ads|cm|cm_v2|banner|popup|splash|promotion|promote)$/i.test(marker);
}

function hasVipSignal(value) {
    return scanVipSignal(value, 0);
}

function scanVipSignal(value, depth) {
    var key;
    var i;

    if (depth > 6 || value === null || value === undefined) return false;

    if (typeof value === 'string') {
        return /大会员|超级会员|超级大会员|年度大会员|bilibili:\/\/vip|\/vip|big[_-]?member|vip[_-]?(pay|center|privilege|mall)/i.test(value);
    }

    if (typeof value !== 'object') return false;

    if (Array.isArray(value)) {
        for (i = 0; i < value.length; i++) {
            if (scanVipSignal(value[i], depth + 1)) return true;
        }
        return false;
    }

    for (key in value) {
        if (!hasOwn(value, key)) continue;
        if (scanVipSignal(value[key], depth + 1)) return true;
    }

    return false;
}

function normalizeKey(key) {
    return String(key || '').toLowerCase();
}

function firstString() {
    var i;

    for (i = 0; i < arguments.length; i++) {
        if (typeof arguments[i] === 'string') {
            return arguments[i];
        }
    }

    return '';
}

function parseJson(body) {
    try {
        return JSON.parse(body);
    } catch (error) {
        console.log('BiliRoaming vip_ad_purify parse error: ' + error);
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

function finishWithBody(obj) {
    $done({ body: JSON.stringify(obj) });
}

function finish() {
    $done({});
}
