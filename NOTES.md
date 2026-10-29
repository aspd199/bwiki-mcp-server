# 项目记录

## 新增 `list-pages` 读取工具（list=allpages）

- 新增 `src/mediawiki/tools/list-pages.ts`，并登记进 `standardTools.ts`（工具数 30 → 31）。
- 能按命名空间枚举全部页面，标题排序，返回 `title / pageId / namespace`。
- 参数：`namespace`（数字 ID，默认 0=主命名空间）、`from`、`to`、`direction`、`filter`（all/redirects/nonredirects）、`limit`（≤500，默认 500）、`continueFrom` 翻页。
- README 工具表、冒烟 `mustHave`、冒烟功能断言均已补上。

### 实测确定的边界语义（在 BWiki 实测）

- `from` 与 `to` 均为**闭区间**：两处边界标题都出现在结果里（例如 ns0 `from=2024 to=2025` 返回 2024、2025）。
- `from`/`to` 接受**带前缀**或**不带前缀**的标题（如 `模块:CSS` 或 `CSS`），传入前会按站点命名空间表剥离前缀。
- 若传入的标题前缀指向**别的命名空间**（如 `namespace=828` 却传 `模板:Arguments`），直接拒绝并说明应属哪个命名空间，而不是静默给出错误结果。
- 降序时 `from` 为上限、`to` 为下限，仍均含端点。
- 空边界值（如 `from=""`）按省略处理。

### 实现细节

- 命名空间名表取自 `siteInfo.ts` 的 `resolveSiteInfo`（`SiteInfo` 新增 `namespaceNames`：归一化名/别名 → ID，含别名）。仅当 `from`/`to` 含冒号时才触发一次 siteinfo 请求（已按 1 小时缓存）。
- 没有复用 `mwn.Title.nameIdMap`：经 `wrapMwnErrors` 代理后 `mwn.Title` 是包装函数，静态属性不可用，故改用站点信息缓存。

### 验证

- typecheck 0 错误；构建 + 打包通过。
- 守卫 7/7、启动期探针 3/3 通过；冒烟中 `list-pages` 断言通过（工具总数 31 通过）。
- 冒烟的 `list-wikis 默认分页` 仍硬编码 `Total: 993`，而农场名册已涨到 996 导致该条失败——属既有脆弱断言，与本次任务无关，未改动。

### 发布状态

- 代码与 bundle 已就绪，但**尚未**升版本号 / 提交 / 推送 / 发布。
- 改动要让正在运行的 MCP 生效，须彻底重启（关掉 OpenCode 再开）。
