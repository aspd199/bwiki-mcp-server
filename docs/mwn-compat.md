# mwn 在 MediaWiki 1.37 上的兼容性

> 测试环境：BWiki 农场内的一个站点（MediaWiki 1.37.0 / PHP 7.3）。农场内所有站点同平台同版本，结论通用。
> 探针脚本：`scripts/probe-mwn-compat.mjs`

## 结论

mwn 可直接用于 BWiki，上游的工具实现基本可原样复用：17 项验证全部通过。

## 验证项

| 项 | 结果 |
|---|---|
| `getSiteInfo()` | 副作用是填充命名空间表 |
| `siteinfo general` | `generator=MediaWiki 1.37.0`，`lang=zh-cn` |
| `userinfo()` | 认出 bilibili UID |
| `read()` | 正常取到内容 |
| `prop=revisions` + `rvslots`（v2 形状） | `pages[0].revisions[0].slots.main.content` |
| `getPagesInCategory()` | 正常 |
| `getPagesByPrefix()` | 正常 |
| `parseWikitext()` | 预渲染正确 |
| `getCsrfToken()` | 正常返回 |
| `bot.request()` 默认带 formatversion=2 | `query.pages` 是数组 |
| `create()` / `edit()` / `edit()` 还原 | 创建、修改、还原均正常 |
| mwn 默认请求方法 = POST | 正常 |
| 长正文 GET/POST | 均可用 |
| `search()` | 正常返回 |

## 请求方法

mwn 内置 `getMethod()`：`action=query` 与非文本的 `action=parse` 走 GET，其余（edit、upload 等）走 POST。

`MULTIPART_THRESHOLD = 8000`——单字段超过 8000 字符自动改用 `multipart/form-data`。

**上游无需为 BWiki 改请求方法。** 读操作的参数都很短，GET 不会超长。

## namespaces 的形状

`meta=siteinfo&siprop=namespaces` 在 1.37 上返回对象 `Record<string, RawNamespace>`，即使带 `formatversion=2` 也是如此；`query.pages` 则是数组。

这是 MediaWiki 版本差异。`get-site-info.ts` 本就按对象形状处理（`Object.keys(namespaces)`），无需改动。

## 认证注入

`mwn.cookieJar` 是 public 字段，axios 拦截器每次请求都从 jar 取 cookie：

```typescript
await bot.cookieJar.setCookie(`SESSDATA=${sessdata}; Path=/`, `${server}/api.php`);
```

不写 `Domain` 属性，使 cookie 为 host-only。写入 `Domain=.biligame.com` 会变成域级 cookie，被发送到任何以该串结尾的主机。tough-cookie 对 `Domain=.bilibili.com` 直接报 `Cookie not in this host's domain`。wiki 服务端只认 cookie 名，不关心 domain 以外的属性。

## mwn API 的易错点

| 直觉 | 实际 |
|---|---|
| `getSiteInfo()` 返回 siteinfo | 返回 undefined（副作用是喂给 `Title.processNamespaceData`） |
| `getCurrentUser()` | 不存在，用 `userinfo()` |
| `getRevisions()` | 不存在，用 `request({action:'query', prop:'revisions'})` |
| `getCategories()` / `getLinks()` | 不存在，用 `getPagesInCategory()` / `getPagesByPrefix()` |
| `edit(title, (content, title) => ...)` | transform 签名是 `({timestamp, content}) => string \| {text, summary, title}` |
| `edit()` 能创建页面 | 不能，只改已存在的；创建用 `create()` |
| `rawRequest()` 调 API | 用途是外部 URL，缺 `url` 参数会报 "No URL provided" |
| `setRequestOptions()` 设请求头 | 只写不读，须用 `axiosInstance.defaults.headers.common` |

## 调用顺序

1. `getSiteInfo()` 必须在 `getPagesInCategory` / `getPagesByPrefix` 之前，否则报 "namespace data unavailable"。
2. `getCsrfToken()` 必须在任何写操作之前。

## 对上游的改动

由 BWiki 的风控与认证要求带来、与 1.37 无关的三处改动，均已完成：

1. `src/mediawiki/wikis/mwnProvider.ts` —— 认证改为 cookie 注入
2. `src/mediawiki/bwiki/throttle.ts` —— 请求间隔 ≥1.1s，567/514 冷却 3 分钟
3. `src/mediawiki/bwiki/liveness.ts` —— 会话失效即断连，见 [session-liveness.md](session-liveness.md)

工具实现本身（`src/mediawiki/tools/`、`services/`、`results/`）无需改动，1.37 的 API 形状与上游假设一致。
