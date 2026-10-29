# BWiki MCP Server

一个 MCP（Model Context Protocol）服务器，让 LLM 客户端以自己登录的 bilibili 账号读写的 [BWiki](https://wiki.biligame.com)——bilibili 旗下游戏 WIKI 所在的 wiki 农场。

## 特性

- **bilibili 通行证认证。** 通过官方 bilibili 登录页登录，由本机真实浏览器驱动。扫码、密码、短信、微信/微博/QQ 等全部登录方式都可用，因为这些都不是本项目自己实现的。
- **不降级为匿名。** 没有会话，或已有会话不再被识别时，服务器拒绝服务并断开连接，绝不悄悄退回匿名访问。
- **写操作前校验身份。** BWiki 对失效的 cookie 不会拒绝，而是把请求当作匿名访客处理，于是过期凭证仍能让写操作成功，只是页面署名变成调用方的出口 IP。因此每次写操作前都先校验身份，校验失败即终止会话。
- **感知 wiki 农场。** 一份凭证覆盖农场内所有 WIKI；`list-wikis` 从农场名册枚举站点，而不只是读本地配置。
- **克制地发请求。** 所有请求串行化，间隔超过一秒；遭遇 EdgeOne 拦截（HTTP 567/514）时自动冷却，而不是反复重试。
- **仅限 HTTPS。** 非 HTTPS 的外部请求一律拒绝，会话 cookie 以 host-only 方式注入。

## 工具

所有操作 wiki 的工具都接受可选参数 `wiki`，用于指定目标站点——传站点代号即可（可用 `list-wikis` 查到）。省略时使用配置中的默认站点（见[配置](#配置)）。每个响应都会注明本次调用作用的站点；成功的响应同时提供两种载荷：`content` 中是叙述文本，`structuredContent` 中是 JSON。

### 页面读操作

| 名称 | 说明 |
|---|---|
| `compare-pages` | 按版本号、标题或指定 wikitext 对比同一页面的两个版本。 |
| `get-category-members` | 列出分类成员（每次最多 500 条，用 `continueFrom` 翻页）。 |
| `get-file` | 获取一个文件页面。 |
| `get-file-data` | 以内联 base64 返回图片字节，供模型直接查看。返回缩放后的版本（用 `width` 指定）；不可渲染的类型会报错。 |
| `get-links-here` | 列出引用了某页面的页面，包含经由重定向到达的（每次最多 500 条）。 |
| `get-page` | 获取一个 wiki 页面。 |
| `get-page-history` | 列出页面的近期修订。 |
| `get-pages` | 一次获取多个页面（最多 50 个）。 |
| `get-recent-changes` | 列出全站近期变更，可按时间、命名空间、用户、标签、类型过滤。 |
| `get-revision` | 获取页面的指定修订版本。 |
| `get-site-info` | 获取站点的关键设置：MediaWiki 版本、内容语言、命名空间、已安装扩展、许可协议。 |
| `list-pages` | 按命名空间列出页面，按标题排序（每次最多 500 条，用 `continueFrom` 翻页）。 |
| `list-wikis` | 列出农场内的 WIKI——代号、站点名、地址、是否只读或默认，以及是否已在本地配置。支持 `limit`、`query`、`configuredOnly`。 |
| `parse-wikitext` | 把 wikitext 渲染成 HTML，不保存。 |
| `search-page` | 对页面标题与正文做全文搜索。 |
| `search-page-by-prefix` | 按标题前缀搜索页面。 |
| `whoami` | 报告当前会话认证的身份——用户名、是否匿名、所属用户组。 |

### 页面写操作

写操作要求已登录，且账号在目标站点具备相应的用户权限。

| 名称 | 说明 |
|---|---|
| `create-page` | 创建新页面。 |
| `delete-page` | 删除页面。 |
| `move-page` | 移动（重命名）页面。 |
| `protect-page` | 保护或取消保护页面。 |
| `undelete-page` | 恢复已删除的页面。 |
| `update-file` | 用本地文件上传文件的新版本。 |
| `update-file-from-url` | 用 URL 上传文件的新版本。 |
| `update-page` | 覆盖页面、在末尾追加或开头插入内容，或只改写其中一段。 |
| `upload-file` | 从本地文件上传新文件。 |
| `upload-file-from-url` | 从 URL 上传新文件。 |

### 会话管理

| 名称 | 说明 |
|---|---|
| `bwiki-login` | 打开官方 bilibili 登录页，等待登录完成并保存会话。唯一无需会话即可运行的工具。 |
| `bwiki-logout` | 删除已保存的会话。 |

### 扩展包

各扩展包的工具只在安装了对应扩展的站点上注册。

**Semantic MediaWiki**

| 名称 | 说明 |
|---|---|
| `smw-list-properties` | 列出 Semantic MediaWiki 属性，并附可直接复制的 `smw-query` 模板。 |
| `smw-query` | 执行 Semantic MediaWiki 的 `#ask` 查询。 |

## 环境要求

- Node.js 20 或更高版本。
- 已安装 Microsoft Edge 或 Google Chrome。登录流程通过 `puppeteer-core` 驱动其中之一，不会额外下载浏览器。
- 一个 bilibili 账号，且具备你要调用的工具所需的用户权限。

## 安装

先构建服务器，再把 MCP 客户端指向构建产物。

```bash
git clone https://github.com/aspd199/bwiki-mcp-server.git bwiki-mcp-server
cd bwiki-mcp-server
npm install
npm run build && npm run bundle
```

然后把 `config.example.json` 复制为 `config.json`，填入要使用的站点（见[配置](#配置)）。没有配置文件时服务器拒绝启动。

构建产出 `dist/bundle.cjs`，单文件，不依赖 `node_modules`。

### 标准配置

多数客户端读取同一套服务器配置块。把它粘贴到下表对应的文件中，并把 `mcpServers` 换成该客户端的根键：

| 客户端 | 配置文件 | 根键 |
| --- | --- | --- |
| Cursor | `~/.cursor/mcp.json`，或项目内 `.cursor/mcp.json` | `mcpServers` |
| VS Code | 工作区 `.vscode/mcp.json`，或命令 **MCP: Open User Configuration** | `servers` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` |
| Devin Desktop（原 Windsurf） | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Zed | `~/.config/zed/settings.json` | `context_servers` |
| LM Studio | `~/.lmstudio/mcp.json` | `mcpServers` |

```json
{
  "mcpServers": {
    "bwiki-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/bwiki-mcp-server/dist/bundle.cjs"],
      "env": {
        "CONFIG": "/absolute/path/to/bwiki-mcp-server/config.json"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add bwiki-mcp-server -e CONFIG=/absolute/path/to/config.json -- node /absolute/path/to/dist/bundle.cjs
```

### OpenCode

OpenCode 使用自己的配置结构而非 `mcpServers`；把下面这段加入项目根目录的 `opencode.json`，或全局的 `~/.config/opencode/opencode.json`。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bwiki-mcp-server": {
      "type": "local",
      "command": ["node", "/absolute/path/to/dist/bundle.cjs"],
      "environment": {
        "CONFIG": "/absolute/path/to/config.json"
      }
    }
  }
}
```

## 配置

服务器读取一个 JSON 配置文件，默认是工作目录下的 `config.json`，也可由 `CONFIG` 指定其他路径。

**只填站点代号。** BWiki 所有 WIKI 共用 `wiki.biligame.com` 这个 host，按路径第一段区分，所以地址完全由代号推出——没有 server、没有路径要填。

```json
{
  "wikis": ["你的站点代号"]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `wikis` | 是 | 要使用的站点代号数组，第一个即默认站点（工具调用省略 `wiki` 参数时用它）。至少填一个，否则服务器拒绝启动。 |
| `uploadDirs` | 否 | 上传工具允许读取的绝对路径目录。不填或空数组即禁用上传。见[上传目录](#上传目录)。 |

站点代号怎么查：调用 `list-wikis` 工具，它会列出整个农场的代号。例如 `["station-a", "station-b"]` 表示同时配置两个站点。

由代号自动推出的值（不需要也不允许写在配置里）：

| 推出项 | 规则 |
|---|---|
| 站点地址 | `https://wiki.biligame.com/<代号>` |
| 页面路径 | `/<代号>` |
| API 入口 | `https://wiki.biligame.com/<代号>/api.php` |
| 站点名称 | 从 wiki 自身的 siteinfo 实时读取，配置文件无法与之不符 |

写成旧的对象格式（`{"wikis": {"代号": {}}}`）会被明确拒绝并提示改为数组，而不是静默忽略。

只需列出你打算调用的 WIKI。`list-wikis` 无论如何都会报告整个农场，所以新增一个站点只是一条配置的事，不需要先做站点发现。

### 上传目录

`upload-file` 与 `update-file` 从本地磁盘读取文件，`uploadDirs` 决定它们能读哪些位置。

**默认禁用。** 不配置时这两个工具直接拒绝，不会上传任何文件：

```
uploads are disabled on this server (no upload directories configured).
```

启用需要列出允许的绝对路径：

```json
{
  "wikis": ["你的站点代号"],
  "uploadDirs": ["D:/Pictures/wiki", "/home/me/wiki-assets"]
}
```

规则：

| 规则 | 说明 |
|---|---|
| 必须是绝对路径 | 相对路径在加载时报错 |
| 目录必须已存在 | 启动时解析真实路径，不存在则拒绝启动 |
| 须在允许目录或其子目录下 | 调用方给出的文件路径经 `realpath` 解析后按前缀匹配 |
| 符号链接按其真实位置判定 | 允许目录内的链接若指向外部，该文件仍会被拒绝 |

也可以用环境变量 `MCP_UPLOAD_DIRS`，以 `:` 分隔，与配置项合并生效。

`upload-file-from-url` 与 `update-file-from-url` 读取的是远程 URL，不受此限制。

## 认证

登录方式只有一种：官方 bilibili 登录页。

1. 调用 `bwiki-login`，会打开浏览器窗口并停在通行证登录页。
2. 用你习惯的方式登录——扫码、密码、短信、微信/微博/QQ 均可。
3. 工具会等待登录完成，通过 DevTools 协议取出会话 cookie，向 wiki 确认该身份有效后写入磁盘。

会话文件位置：

- Windows：`%APPDATA%\bwiki-mcp-server\session.json`
- 其他平台：`~/.config/bwiki-mcp-server/session.json`

`bwiki-logout` 会删除它。会话就是普通文件，请像对待其他凭证一样对待它。

### 会话失效时会怎样

服务启动前，启动检查会先验证已保存的会话。验证不通过时，服务器会带原因退出，而不是建立连接。

运行期间，BWiki 不会拒绝失效的 cookie，而是把请求当作匿名访客处理，并用调用方的出口 IP 顶替用户名。成功响应里没有任何字段会告诉你身份已经变了。因此：

- **写操作**前会先校验身份。若 wiki 不再报告 bilibili UID，写操作被拒绝，响应说明原因，随后连接关闭。服务器绝不会以 IP 身份写入。
- **读操作**不做校验。匿名读返回的本来就是同一份公开内容，多花一次请求买不到任何东西。
- **传输失败不算登出。** wiki 不可达说明不了凭证状态，因此报为上游错误、连接保持。一次网络抖动不该让你重新扫码。

一旦判定会话失效，这个结论会保持：后续写操作直接拒绝，不再重复探测。

## 环境变量

| 名称 | 说明 | 默认值 |
|---|---|---|
| `CONFIG` | 配置文件路径 | `config.json` |
| `MCP_LOG_LEVEL` | 日志最低级别。可选 `debug`、`info`、`notice`、`warning`、`error`、`critical`、`alert`、`emergency`、`silent`。 | `debug` |
| `MCP_CONTENT_MAX_BYTES` | 工具返回内容正文的字节上限，按每个响应计一次。可按所用客户端的响应预算调整。 | `75000` |
| `MCP_FILE_DATA_MAX_BYTES` | `get-file-data` 响应中 base64 数据的硬上限。超限的调用直接报错，不截断。 | `1000000` |
| `MCP_UPLOAD_MAX_BYTES` | `*-from-url` 上传工具在服务端抓取时的内存上限。超出该大小的文件会转交 wiki 自身的复制上传，不在本服务器缓存。 | `104857600` |
| `MCP_UPLOAD_DIRS` | 上传工具允许读取的绝对路径目录，以 `:` 分隔。与 `uploadDirs` 合并生效。 | 未设置 |
| `MCP_USER_AGENT` | 替换所有外部请求的 `User-Agent` 头。不设置时使用内置的 Chrome 桌面版 UA。 | 内置 Chrome UA |
| `MCP_TRUSTED_HOSTS` | 有外发 SSRF 防护：解析到私有或回环地址的目标一律拒绝，此变量列出的主机可豁免。 | 未设置 |

## 安全

- **凭证只存在一个文件里。** `session.json` 保存 bilibili 会话，只由 `bwiki-login` 写入。它不会被记入日志，不会通过 MCP 资源暴露，也不会返回给调用方。
- **cookie 是 host-only 的。** 不写入 `Domain` 属性。一旦写入，它会被当作域级 cookie，向任何以 `wiki.biligame.com` 结尾的主机发送。
- **仅限 HTTPS。** 任何请求（包括 SSRF 重定向后的请求）都必须使用 HTTPS。
- **User-Agent 默认采用 Chrome 桌面版。** BWiki 位于腾讯云 EdgeOne 之后，会按 UA 的自动化特征评分，自称 `bwiki-mcp-server/...` 这类字符串更容易被判定为机器人。需要用于统计或联系的目的时，可用 `MCP_USER_AGENT` 覆盖，但我们不建议改成带 bot 字样的形式。
- **限速是有意为之。** 请求串行发出，间隔超过一秒。收到 HTTP 567 或 514 表示已被 EdgeOne 拦截；服务器会暂停三分钟而不是重试，此时你也应当停止调用，而不是想办法绕过。
- **写操作即你的行为。** 服务器以保存的 bilibili 账号身份行事。每条工具调用日志都会标明该账号（形如 `bilibili:<你的 UID>`），使每次写入都可追溯。

## 开发

```bash
npm run build              # 编译 TypeScript 到 dist/
npm run bundle             # 打包为 dist/bundle.cjs
npm run typecheck          # tsc --noEmit
npm test                   # 针对构建产物的 stdio 冒烟测试
npm run test:guard         # 会话存活守卫的单元检查
npm run test:boot-session  # 启动期会话校验行为
```

`npm run test:writes` 会完整走一遍写路径——创建、读回、修改、验证、查历史、删除——在真实 wiki 上留下真实页面。它不在 `npm test` 之内，不得无人值守地运行。

`npm publish` 前会自动执行构建（`prepublishOnly` 钩子），无需手动跑 `build` 与 `bundle`。

### 目录结构

- `src/mediawiki/` — 工具实现与运行时，由 [ProfessionalWiki/MediaWiki-MCP-Server](https://github.com/ProfessionalWiki/MediaWiki-MCP-Server)（MIT）改编而来。
- `src/mediawiki/bwiki/` — BWiki 专有层：通行证登录、会话拦截、运行期存活校验、请求限速、农场名册、身份判定。
- `src/mediawiki/tools/` — 每个工具一个文件。
- `src/mediawiki/wikis/` — 站点注册与选择，以及负责注入会话 cookie、控制请求节奏的 mwn 提供层。
- `src/mediawiki/runtime/` — 上下文、调度、注册、日志与关闭处理。
- `scripts/` — 构建与探针脚本。
- `docs/` — 登录方案、mwn 兼容性、会话失效处理的结论记录。

## 许可

MIT。`src/mediawiki/` 的部分代码改编自 [MediaWiki-MCP-Server](https://github.com/ProfessionalWiki/MediaWiki-MCP-Server)，该项目的许可同样是 MIT。
