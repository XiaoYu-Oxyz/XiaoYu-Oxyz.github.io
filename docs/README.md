# 文档索引

| 文档 | 内容 |
|---|---|
| [PRD.md](PRD.md) | 产品需求、边界、明确否决的需求 |
| [重构记录.md](重构记录.md) | 57 轮改动的动机、做法与验证（含索引） |
| [止损点.md](止损点.md) | 改动值不值得做的判定框架、红线、暂不改清单 |
| [ACCESSIBILITY.md](ACCESSIBILITY.md) | 无障碍设计与回归清单 |
| [COMPATIBILITY.md](COMPATIBILITY.md) | 浏览器兼容底线与老设备退化项 |
| [scripts.md](scripts.md) | 本地一键构建/检查/发布 |
| [新学期.md](新学期.md) | 换学期数据的 4 步清单 |

## 相关目录

- `src/` 源码（app.css / app.js / index.template.html），`tools/build.py` 内联成单文件 `index.html`
- `tools/` 构建与体检脚本（build / verify / validate_data / color_audit / compat_lint / check_docs_links）
- `tests/` 五套测试（Python 单测、logic、ui-smoke、week-view、visual-smoke）
