<div align="center">

<img width="160" src="https://raw.githubusercontent.com/yujincheng08/BiliRoaming/master/imgs/icon.png" alt="logo">

# 哔哩漫游 / BiliRoaming

用于 Loon、Surge、Quantumult X、Stash 的 Bilibili MITM 响应改写脚本集合。

Logo 来自 [哔哩哔哩漫游娘](https://www.weibo.com/p/230418139a6f1100102vlj6)

</div>

## 功能 / Features

| 参数 | 默认值 | 功能 |
| --- | --- | --- |
| `area` | `false` | 修复番剧详情、播放地址、搜索结果中的区域限制字段；主站 `-404` 时尝试国际版 API 回退。 |
| `mode` | `short` | 分享链接净化：保留短链，或替换为 `av` / `BV` 页面链接。 |
| `space` | `false` | 修复被限制或注销状态影响的用户空间、投稿列表和动态字段。 |

当前插件只包含 `scripts/` 下这三个功能脚本：

```text
scripts/
  bili_area_limit.js
  bili_long_link.js
  bili_space_fix.js
```

广告净化、弹幕净化等旧设计文档没有对应的当前插件入口。

## 使用方法 / Usage

在支持插件订阅的客户端中导入：

```text
https://raw.githubusercontent.com/MiRinChan/BiliRoaming/master/BiliRoaming.plugin
```

启用 MITM 后，在插件参数中按需打开 `area`、`space`，或把 `mode` 从 `short` 改为 `av` / `bv`。

## 开发 / Development

脚本在代理工具的 JavaScriptCore 环境中运行，每个文件都必须自包含，不能依赖共享模块或 Node.js runtime。

本仓库没有包管理器和构建步骤。当前本地测试使用 Node.js `vm` 模拟 `$request`、`$response`、`$done`：

```bash
nix shell nixpkgs#nodejs --command node tests/scripts.test.js
```

语法检查：

```bash
nix shell nixpkgs#nodejs --command node --check scripts/bili_area_limit.js
nix shell nixpkgs#nodejs --command node --check scripts/bili_long_link.js
nix shell nixpkgs#nodejs --command node --check scripts/bili_space_fix.js
```

## 特别鸣谢 / Acknowledgements

- [yujincheng08/BiliRoaming](https://github.com/yujincheng08/BiliRoaming)
- [iAcn/BiliRoaming](https://github.com/iAcn/BiliRoaming)

## License

[GNU General Public License, version 3](LICENSE)
