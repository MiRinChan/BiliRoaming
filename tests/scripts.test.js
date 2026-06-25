const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function runScript(scriptName, options) {
    options = options || {};

    return new Promise((resolve, reject) => {
        const scriptPath = path.join(ROOT, 'scripts', scriptName);
        const source = fs.readFileSync(scriptPath, 'utf8');
        const wrappedSource = '(function(){\n' + source + '\n}).call(this);';
        let settled = false;

        const context = {
            $argument: options.argument,
            $request: {
                url: options.url || 'https://api.bilibili.com/',
                method: options.method || 'GET',
                body: options.requestBody
            },
            $response: {
                body: options.body,
                headers: options.headers || {}
            },
            $done: (result) => {
                if (settled) {
                    reject(new Error(scriptName + ' called $done more than once'));
                    return;
                }
                settled = true;
                resolve(result || {});
            },
            console: {
                log: () => {}
            },
            setTimeout,
            clearTimeout
        };

        if (options.httpClient) context.$httpClient = options.httpClient;
        if (options.task) context.$task = options.task;
        if (options.withoutObjectHasOwn) {
            context.Object = function ObjectShim() {};
            context.Object.prototype = Object.prototype;
        }

        try {
            vm.runInNewContext(wrappedSource, context, {
                filename: scriptPath,
                timeout: 1000
            });
        } catch (error) {
            reject(error);
            return;
        }

        setTimeout(() => {
            if (!settled) reject(new Error(scriptName + ' did not call $done'));
        }, options.timeout || 25);
    });
}

function json(result) {
    assert(result.body, 'expected modified response body');
    return JSON.parse(result.body);
}

async function testAreaLimitDoesNotRequireObjectHasOwn() {
    const input = {
        code: 0,
        data: {
            rights: {
                area_limit: 1,
                allow_dm: 0,
                allow_download: 0
            },
            area_limit: 1,
            allow_download: 0,
            episodes: [
                {
                    area_limit: 1,
                    allow_dm: 0,
                    allow_download: 0,
                    status: 13,
                    badge: '泰区会员限定'
                }
            ],
            limit: { reason: 'area' },
            dialog: { text: 'area' }
        }
    };

    const result = await runScript('bili_area_limit.js', {
        argument: 'true',
        url: 'https://api.bilibili.com/pgc/view/v2/app/season?season_id=1',
        body: JSON.stringify(input),
        withoutObjectHasOwn: true
    });

    const output = json(result);
    assert.strictEqual(output.data.rights.area_limit, 0);
    assert.strictEqual(output.data.rights.allow_dm, 1);
    assert.strictEqual(output.data.rights.allow_download, 1);
    assert.strictEqual(output.data.area_limit, 0);
    assert.strictEqual(output.data.allow_download, 1);
    assert.strictEqual(output.data.episodes[0].status, 2);
    assert.strictEqual(output.data.episodes[0].badge, '');
    assert.strictEqual(output.data.limit, null);
    assert.strictEqual(output.data.dialog, null);
}

async function testAreaLimitRestoresSeasonFromIntlFallback() {
    const input = {
        code: -404,
        message: 'not found'
    };
    const intlResponse = {
        code: 0,
        result: {
            title: 'Intl Season',
            actors: '声优',
            episodes: [
                {
                    id: 1001,
                    title: '1',
                    long_title: '受限标题',
                    status: 13,
                    badge: '泰区会员',
                    cid: 0,
                    aid: 0
                }
            ]
        }
    };

    const result = await runScript('bili_area_limit.js', {
        argument: 'true',
        url: 'https://api.bilibili.com/pgc/view/v2/app/season?season_id=77&ep_id=1001',
        body: JSON.stringify(input),
        httpClient: {
            get: (url, callback) => {
                assert(url.includes('/intl/gateway/v2/ogv/view/app/season'));
                assert(url.includes('season_id=77'));
                callback(null, { status: 200 }, JSON.stringify(intlResponse));
            }
        }
    });

    const output = json(result);
    const episode = output.result.episodes[0];
    assert.strictEqual(output.code, 0);
    assert.strictEqual(output.result.season_id, 77);
    assert.strictEqual(output.result.actor.info, '声优');
    assert.strictEqual(episode.ep_id, 1001);
    assert.strictEqual(episode.status, 2);
    assert.strictEqual(episode.badge, '');
    assert.strictEqual(episode.long_title, '标题');
    assert.strictEqual(episode.area_limit, 0);
    assert.strictEqual(episode.rights.allow_dm, 1);
}

async function testSpaceFixDoesNotRequireObjectHasOwn() {
    const input = {
        code: 0,
        data: {
            list: {
                vlist: [
                    {
                        area_limit: 1,
                        allow_dm: 0,
                        allow_download: 0,
                        status: -1,
                        title: '【受限】投稿',
                        play: '--',
                        danmaku: -1,
                        video_review: -1
                    }
                ]
            }
        }
    };

    const result = await runScript('bili_space_fix.js', {
        argument: 'true',
        url: 'https://api.bilibili.com/x/space/arc/search?mid=42',
        body: JSON.stringify(input),
        withoutObjectHasOwn: true
    });

    const output = json(result);
    const video = output.data.list.vlist[0];
    assert.strictEqual(video.area_limit, 0);
    assert.strictEqual(video.allow_dm, 1);
    assert.strictEqual(video.allow_download, 1);
    assert.strictEqual(video.status, 1);
    assert.strictEqual(video.title, '投稿');
    assert.strictEqual(video.play, 0);
    assert.strictEqual(video.danmaku, 0);
    assert.strictEqual(video.video_review, 0);
}

async function testSpaceFixRestoresProfileFromCardFallback() {
    const input = {
        code: -404,
        message: 'not found'
    };
    const cardResponse = {
        code: 0,
        card: {
            mid: 42,
            name: 'Mirin',
            face: 'https://example.test/face.jpg',
            sign: 'hello',
            level_info: {
                current_level: 6
            },
            official_verify: {
                type: 0,
                desc: 'official'
            },
            vip: {
                vipType: 2,
                vipStatus: 1,
                label: {
                    text: '年度大会员'
                }
            }
        }
    };

    const result = await runScript('bili_space_fix.js', {
        argument: 'true',
        url: 'https://api.bilibili.com/x/v2/space?vmid=42',
        body: JSON.stringify(input),
        httpClient: {
            get: (url, callback) => {
                assert.strictEqual(
                    url,
                    'https://account.bilibili.com/api/member/getCardByMid?mid=42'
                );
                callback(null, { status: 200 }, JSON.stringify(cardResponse));
            }
        }
    });

    const output = json(result);
    assert.strictEqual(output.code, 0);
    assert.strictEqual(output.data.card.mid, '42');
    assert.strictEqual(output.data.card.name, 'Mirin');
    assert.strictEqual(output.data.card.face, 'https://example.test/face.jpg');
    assert.strictEqual(output.data.card.level_info.current_level, 6);
    assert.strictEqual(output.data.card.official_verify.desc, 'official');
    assert.strictEqual(output.data.card.vip.label.text, '年度大会员');
}

async function testLongLinkRewritesDirectBvPath() {
    const input = {
        code: 0,
        data: {
            content: '分享 https://b23.tv/BV1xx411c7mD?share_source=copy'
        }
    };

    const result = await runScript('bili_long_link.js', {
        argument: 'bv',
        method: 'POST',
        url: 'https://api.bilibili.com/x/share/click',
        body: JSON.stringify(input)
    });

    const output = json(result);
    assert.strictEqual(
        output.data.content,
        '分享 https://www.bilibili.com/video/BV1xx411c7mD?unique_k=2333'
    );
}

async function testLongLinkRewritesAvFromRequestBody() {
    const input = {
        code: 0,
        data: {
            content: '分享 https://b23.tv/abc123'
        }
    };

    const result = await runScript('bili_long_link.js', {
        argument: 'av',
        method: 'POST',
        url: 'https://api.bilibili.com/x/share/click',
        requestBody: 'oid=123456&foo=bar',
        body: JSON.stringify(input)
    });

    const output = json(result);
    assert.strictEqual(
        output.data.content,
        '分享 https://www.bilibili.com/video/av123456'
    );
}

const tests = [
    testAreaLimitDoesNotRequireObjectHasOwn,
    testAreaLimitRestoresSeasonFromIntlFallback,
    testSpaceFixDoesNotRequireObjectHasOwn,
    testSpaceFixRestoresProfileFromCardFallback,
    testLongLinkRewritesDirectBvPath,
    testLongLinkRewritesAvFromRequestBody
];

(async () => {
    for (const test of tests) {
        await test();
        process.stdout.write('.');
    }
    process.stdout.write('\n' + tests.length + ' tests passed\n');
})().catch((error) => {
    console.error('\n' + (error && error.stack || error));
    process.exit(1);
});
