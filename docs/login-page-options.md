# 登录方案

## 结论

采用 bilibili 官方登录页 `https://passport.biligame.com/login`，由 puppeteer-core 驱动本机浏览器。

```
bwiki-login
  └─ puppeteer-core 启动本机 Edge/Chrome（一次性 profile，不下载浏览器）
       └─ 打开官方登录页
            └─ 用户扫码 / 密码 / 短信 / 微信 / 微博 / QQ 登录
                 └─ CDP 读出 HttpOnly 的 SESSDATA
                      └─ identity.establish() 换 wiki 会话并落盘
```

## 凭证读取

`SESSDATA` 是 `.bilibili.com` 上的 HttpOnly cookie，只能通过 CDP 读取。

| 方式 | 结果 |
|---|---|
| 页面 JS 读 | 只读得到 `b_nut`、`buvid3`、`buvid_fp` |
| Node 读浏览器 cookie 库 | 浏览器运行时独占锁，读不到 |
| CDP（puppeteer） | 正常读出，`httpOnly=true` |

## 浏览器依赖

使用 `puppeteer-core`，不下载浏览器。按 Edge → Chrome → Chromium 顺序探测本机安装。

## wiki 对 cookie 的接受度

`api.php` 直接接受 bilibili 的 `SESSDATA`，无需 wiki 先铸 `gamecenter_wiki__session`。去掉 `SESSDATA` 即退化为匿名（`userinfo.name` 变为出口 IP）。

| 凭证 | 结果 |
|---|---|
| 仅 wiki session cookie | 认证通过，`canEdit=true` |
| 仅 bilibili passport cookie | 认证通过，`canEdit=true` |
| 去掉 SESSDATA | 匿名，`name` 为出口 IP |

验证脚本：`scripts/probe-mwn-auth.mjs`

## 官方页行为

- `?gourl=<url>` 参数被接受，但回调时凭证不进 URL，只在 HttpOnly cookie 里。
- passport 域名为 `passport.biligame.com`（host 含 `biligame`）或 `passport.bilibili.com`（其他），两者端点等价。
- CORS 白名单含 `https://www.bilibili.com` 与 `https://wiki.biligame.com`，不含 `127.0.0.1`，故官方组件无法在本地页面运行。
- 密码登录强制要求 geetest captcha，无法在无人值守场景完成；官方页在浏览器中运行，captcha 由用户正常完成。

## 参考

- 官方登录组件：`https://s1.hdslb.com/bfs/seed/jinkela/short/mini-login-v2/miniLogin.umd.min.js`
- BWiki 游戏中心 header：`https://s1.hdslb.com/bfs/seed/game-web/duang/header/header.js`
- passport 端点细节：[seiuna/bilibili-api](https://github.com/seiuna/bilibili-api) `src/core/auth.ts`
