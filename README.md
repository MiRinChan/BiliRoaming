# [redacted]

一些基于网络代理工具的响应字段改写辅助脚本。

---

## 背景

某些内容分发平台会根据请求来源的地理位置返回不同的元数据标记。本工具通过在本地处理经过的响应数据，调整相关内容展示字段。

---

## 文件结构

```
├── BiliRoaming.plugin
├── scripts/
│   ├── bili_area_limit.js
│   └── bili_long_link.js
├── LICENSE
└── README.md
```

---

## License

[GNU General Public License, version 3](LICENSE)
