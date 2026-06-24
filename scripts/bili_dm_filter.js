/**
 * BiliRoaming - 弹幕过滤
 *
 * 1. 弹幕等级过滤 — 根据用户等级屏蔽低等级弹幕
 * 2. 渐变色弹幕过滤 — 移除 VIP 专属渐变色弹幕
 *
 * 拦截接口:
 *   - api.bilibili.com/x/v2/dm              弹幕分段接口 (protobuf → JSON)
 *   - api.bilibili.com/x/v2/dm/web/seg.so   网页弹幕接口
 *
 * Bilibili /x/v2/dm 返回的 DmWebViewReply protobuf 转 JSON 结构:
 *   {
 *     "dms": [
 *       {
 *         "id": 123456,         // 弹幕 ID
 *         "dm_time": 45.5,      // 视频时间 (秒)
 *         "mode": 1,            // 弹幕模式 (1=滚动, 4=底部, 5=顶部)
 *         "font_size": 25,      // 字号
 *         "color": 16777215,    // 颜色 (0xffffff), 60001=VIP渐变色
 *         "crc32_id": "xxx",    // 发送者 UID 的 CRC32 hash
 *         "text": "弹幕内容",
 *         "send_time": 1719230400,
 *         "weight": 2,          // 弹幕权重 (≈用户等级权重)
 *         "action": "",
 *         "pool": 0,            // 0=普通, 1=字幕, 2=特殊
 *         "id_str": "123456",
 *         "attr": 0,            // 属性位掩码 (bit0=渐变色?)
 *         "uid": 987654         // 发送者 UID
 *       }
 *     ]
 *   }
 *
 * 参数 (argument):
 *   dm_level=0       弹幕等级过滤 (0=不过滤, 1~6=屏蔽该等级以下的弹幕)
 *                    基于 weight 字段: weight<0 为低权重, weight>=5 为高权重
 *                    映射: dm_level=1 → weight<1, dm_level=3 → weight<3
 *   dm_gradient=false 过滤渐变色弹幕 (true=移除渐变色/特殊色弹幕)
 *
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026-06-24
 */

// === 解析参数 ===
const DM_LEVEL = parseInt(readArg('dm_level', '0'), 10) || 0;
const DM_GRADIENT = readArg('dm_gradient', false) === true ||
    readArg('dm_gradient', false) === 'true';

const ENABLED = DM_LEVEL > 0 || DM_GRADIENT;

const url = $request.url;
const body = $response.body;

if (!body || !ENABLED) {
    $done({});
    return;
}

// 只处理弹幕分段接口
if (!url.includes('/x/v2/dm')) {
    $done({});
    return;
}

try {
    let obj = JSON.parse(body);

    if (!obj || obj.code !== 0) {
        $done({});
        return;
    }

    const data = obj.data;
    if (!data) {
        $done({});
        return;
    }

    // 弹幕列表可能在 data.dms 或 data.dm 或直接是数组
    let dmList = data.dms || data.dm || data;

    // 如果 data 本身就是数组 (部分版本)
    if (Array.isArray(data)) {
        dmList = data;
    }

    if (!Array.isArray(dmList)) {
        $done({});
        return;
    }

    const originalCount = dmList.length;
    let filtered = 0;
    let gradientFiltered = 0;

    // 过滤弹幕
    const newDmList = [];
    for (const dm of dmList) {
        if (!dm || typeof dm !== 'object') continue;

        // 1. 等级过滤 — 基于 weight 字段
        if (DM_LEVEL > 0) {
            const weight = dm.weight !== undefined ? dm.weight : 0;
            // weight 表示弹幕权重，高 weight 通常对应高等级用户
            // 移动端 API 中 weight 范围通常 0-9
            // 映射: dm_level=1 屏蔽 weight<1, dm_level=3 屏蔽 weight<3, 以此类推
            const effectiveWeight = Math.max(0, Math.min(9, Number(weight) || 0));
            if (effectiveWeight < DM_LEVEL) {
                filtered++;
                continue;
            }
        }

        // 2. 渐变色过滤
        if (DM_GRADIENT) {
            // 渐变色弹幕特征:
            //   - color == 60001 (VIP 专属渐变色标记)
            //   - attr 字段 bit 位指示渐变色
            //   - pool == 2 (特殊弹幕池)
            //   - 存在 gradient / color_type 等渐变元数据字段

            const color = dm.color;
            const attr = dm.attr || 0;
            const pool = dm.pool || 0;

            // 60001 是 Bilibili VIP 渐变色弹幕的特殊色值标记
            if (color === 60001 || color === '60001') {
                gradientFiltered++;
                continue;
            }

            // attr bit 位: 某些 API 版本用 attr 属性位标记渐变色
            // attr & 0x1 或 attr & 0x4 可能指示特殊/渐变弹幕
            if (attr & 0x1 || attr & 0x4) {
                gradientFiltered++;
                continue;
            }

            // pool == 2 表示特殊弹幕池 (通常包含渐变色弹幕)
            if (pool === 2) {
                gradientFiltered++;
                continue;
            }

            // 检测渐变相关元数据字段
            if (dm.gradient !== undefined || dm.color_type !== undefined ||
                dm.gradient_colors !== undefined) {
                gradientFiltered++;
                continue;
            }
        }

        newDmList.push(dm);
    }

    // 将过滤后的结果写回
    if (Array.isArray(data.dms)) {
        data.dms = newDmList;
    } else if (Array.isArray(data.dm)) {
        data.dm = newDmList;
    } else if (Array.isArray(data)) {
        obj.data = newDmList;
    }

    const remaining = newDmList.length;
    if (originalCount !== remaining) {
        console.log(`BiliRoaming dm_filter: ${originalCount} → ${remaining} ` +
            `(level:${filtered}, gradient:${gradientFiltered})`);
    }

    $done({ body: JSON.stringify(obj) });

} catch (e) {
    console.log(`BiliRoaming dm_filter error: ${e}`);
    $done({});
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
