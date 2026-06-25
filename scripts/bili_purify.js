/**
 * BiliRoaming - 净化B站内容
 *
 * 净化功能暂时移除，后续逐步恢复。
 *
 * 当前保留:
 *   （无）
 *
 * 计划恢复:
 *   首页推荐 = switch,true    过滤首页推荐中的广告和推广
 *   搜索 = switch,true        过滤搜索结果中的推广、广告
 *   视频详情 = switch,true    过滤视频详情中的运营卡片、广告
 *   动态 = switch,true        过滤动态中的同城/校园标签、广告
 *   直播 = switch,true        过滤直播间中的浮窗广告、banner
 *   评论 = switch,true        过滤评论区中的置顶推广、引导
 *   评论@提及 = switch,false  过滤仅含@提及、无实质内容的评论
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
 * 适用于: Loon, Surge, Quantumult X
 * Update: 2026-06-25
 */

const url = $request.url;
const body = $response.body;

if (!body) {
    $done({});
    return;
}

// All purification features temporarily removed.
// $done({}) passes through the original response unmodified.
$done({});
