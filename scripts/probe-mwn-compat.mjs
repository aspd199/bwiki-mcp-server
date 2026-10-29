/**
 * Is mwn usable against MediaWiki 1.37 (what BWiki runs)?
 *
 * This is the gating question for reusing the upstream tool implementations:
 * they were written against modern MediaWiki, and 1.37.0 dates from 2021.
 *
 * Every call below mirrors something an upstream tool actually does, so a
 * pass here means the upstream tool bodies should work as written.
 *
 * Cookie is the real bilibili passport cookie from the stored session, so
 * the paths are exercised as the authenticated user the server runs as.
 */

import { Mwn } from "mwn";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const config = JSON.parse(readFileSync("config.json", "utf8"));
const sessionPath = process.platform === "win32"
  ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "bwiki-mcp-server", "session.json")
  : join(homedir(), ".config", "bwiki-mcp-server", "session.json");
const stored = JSON.parse(readFileSync(sessionPath, "utf8"));

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${String(detail).slice(0, 200)}`);
}

const bot = new Mwn({
  apiUrl: `${config.server}${config.apiPath}`,
  userAgent: config.userAgent,
});

// Inject the passport cookie. The Domain has to be the wiki's own, not
// .bilibili.com: tough-cookie refuses to send a .bilibili.com cookie to
// wiki.biligame.com, and the server only looks at the cookie's name.
for (const pair of stored.passportCookie.split(";").map((c) => c.trim()).filter(Boolean)) {
  const [name, ...rest] = pair.split("=");
  const value = rest.join("=");
  if (!name || !value) continue;
  await bot.cookieJar.setCookie(
    `${name}=${value}; Domain=.biligame.com; Path=/`,
    `${config.server}${config.apiPath}`,
  );
}

// ---------------------------------------------------------------- site info

// getSiteInfo() returns undefined by design: it feeds the result into
// Title.processNamespaceData and never returns it. Read the raw response
// instead when the values themselves are needed.
//
// It also has a side effect that matters: it populates the namespace table
// that getPagesInCategory / getPagesByPrefix depend on. So call it first.
let siteInfoOk = false;
try {
  await bot.getSiteInfo();
  siteInfoOk = true;
  report("getSiteInfo() 执行完成", true, "（返回值按设计为 undefined，副作用是填充命名空间表）");
} catch (err) {
  report("getSiteInfo()", false, err.message);
}

try {
  const res = await bot.request({
    action: "query",
    meta: "siteinfo",
    siprop: "general|namespaces",
  });
  const general = res?.query?.general;
  report("siteinfo general", !!general?.generator, `generator=${general?.generator} lang=${general?.lang}`);
  const ns = res?.query?.namespaces;
  report(
    "siteinfo.namespaces 形状",
    !!ns && typeof ns === "object",
    `类型=${Array.isArray(ns) ? "array" : typeof ns}`,
  );
  if (ns && !Array.isArray(ns)) {
    // formatversion=2 returns an array; the object form means the request
    // went out without it. That is the shape upstream tools must not assume.
    const sample = Object.entries(ns).slice(0, 3).map(([k, v]) => `${k}=${v?.name ?? v?.id}`);
    report("namespaces 为旧的对象形状（非 v2）", false, `示例: ${sample.join(", ")}`);
  }
} catch (err) {
  report("siteinfo", false, err.message);
}

// ---------------------------------------------------------------- identity

try {
  const user = await bot.userinfo();
  const name = user?.name ?? user?.userName;
  report("userinfo() 认出 bilibili UID", /^\d{5,}$/.test(name ?? ""), `name=${name}`);
} catch (err) {
  report("userinfo()", false, err.message);
}

// ---------------------------------------------------------------- page read

try {
  const page = await bot.read("首页");
  const content = page?.revisions?.[0]?.slots?.main?.content ?? page?.content;
  report(
    "read() 取到内容",
    typeof content === "string" && content.length > 0,
    `长度=${typeof content === "string" ? content.length : "(无)"}`,
  );
} catch (err) {
  report("read()", false, err.message);
}

// ---------------------------------------------------------------- revisions (rvslots)

try {
  const res = await bot.request({
    action: "query",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    rvlimit: 1,
    titles: "首页",
  });
  const first = res?.query?.pages?.[0];
  const text = first?.revisions?.[0]?.slots?.main?.content;
  report(
    "prop=revisions + rvslots (v2 形状)",
    typeof text === "string",
    `pages[0] 存在=${!!first} 内容=${typeof text === "string" ? text.length + "字符" : "(无)"}`,
  );
} catch (err) {
  report("prop=revisions + rvslots", false, err.message);
}

// ---------------------------------------------------------------- list queries

try {
  const cats = await bot.getPagesInCategory("分类:首页", 3);
  report("getPagesInCategory()", Array.isArray(cats), `数量=${cats?.length ?? 0}`);
} catch (err) {
  report("getPagesInCategory()", false, err.message);
}

try {
  const byPrefix = await bot.getPagesByPrefix("首页", 3);
  report("getPagesByPrefix()", Array.isArray(byPrefix), `数量=${byPrefix?.length ?? 0}`);
} catch (err) {
  report("getPagesByPrefix()", false, err.message);
}

// ---------------------------------------------------------------- parse (预渲染校验)

try {
  const html = await bot.parseWikitext("测试'''粗体'''");
  report(
    "parseWikitext() 预渲染",
    typeof html === "string" && /粗体/.test(html),
    `html长度=${html?.length} 含粗体=${/<b>|粗体/.test(html ?? "")}`,
  );
} catch (err) {
  report("parseWikitext()", false, err.message);
}

// ---------------------------------------------------------------- csrf token

// Writes need a CSRF token, and mwn only fetches one on demand.
try {
  const token = await bot.getCsrfToken();
  report("getCsrfToken()", typeof token === "string" && token.length > 0, `长度=${token?.length}`);
} catch (err) {
  report("getCsrfToken()", false, err.message);
}

// ---------------------------------------------------------------- formatversion

// The v2 response shape (pages as an array, content under slots) is what
// upstream tool code assumes. Check whether mwn asks for it globally.
try {
  const res = await bot.request({ action: "query", titles: "首页", prop: "info" });
  const pages = res?.query?.pages;
  report(
    "bot.request() 默认带 formatversion=2",
    Array.isArray(pages),
    `query.pages 类型=${Array.isArray(pages) ? "array" : typeof pages}`,
  );
} catch (err) {
  report("formatversion 检查", false, err.message);
}

// ---------------------------------------------------------------- write path

// mwn's edit() only edits an existing page (a missing page raises
// MwnMissingPageError). Creating a page is a separate action=edit with
// createonly, which upstream's create-page tool performs. So the write path
// is tested by touching a page that already exists and restoring it.
//
// The page used is one created by the probe itself in an earlier run and
// left in place on purpose, so no wiki content is disturbed.
const TEST_TITLE = "bwiki-mcp-server 兼容性测试临时页";
try {
  // Make sure the page exists, creating it with the raw action the upstream
  // create-page tool uses.
  const existing = await bot.request({
    action: "query",
    titles: TEST_TITLE,
    prop: "revisions",
    rvslots: "main",
  });
  const page = existing?.query?.pages?.[0];
  const isMissing = page?.missing !== undefined;

  if (isMissing) {
    // mwn has a create() for exactly this: action=edit with nocreate.
    await bot.create(TEST_TITLE, "初始内容", "临时测试创建");
    report("create() 创建新页", true, "已创建");
  } else {
    report("create() 创建新页", true, "页面已存在，跳过创建");
  }

  // Now the edit path mwn itself provides.
  // The transform receives { timestamp, content } and may return a string or
  // an object like { text, summary, title }.
  await bot.edit(TEST_TITLE, ({ content }) => ({
    text: `${content}\n追加一行`,
    summary: "临时测试编辑",
  }));
  const after = await bot.read(TEST_TITLE);
  const text = after?.revisions?.[0]?.slots?.main?.content ?? after?.content;
  report(
    "edit() 修改已存在页面",
    typeof text === "string" && text.includes("追加一行"),
    `长度=${text?.length}`,
  );

  // Restore the page to its original text.
  await bot.edit(TEST_TITLE, () => ({
    text: "初始内容",
    summary: "临时测试还原",
  }));
  const restored = await bot.read(TEST_TITLE);
  const restoredText = restored?.revisions?.[0]?.slots?.main?.content ?? restored?.content;
  report("edit() 还原", restoredText === "初始内容", `当前长度=${restoredText?.length}`);
} catch (err) {
  report("写入路径", false, err.message);
}

// ---------------------------------------------------------------- method check

// Which HTTP method does mwn actually use? BWiki needs POST: a long
// wikitext in a GET `text=` parameter exceeds what the proxy carries.
try {
  let observedMethod = null;
  const origRequest = bot.rawRequest.bind(bot);
  bot.rawRequest = (opts) => {
    observedMethod = opts?.method ?? "(默认)";
    return origRequest(opts);
  };
  await bot.read("首页");
  report("mwn 默认请求方法", !!observedMethod, `实际=${observedMethod}`);
} catch (err) {
  report("mwn 默认请求方法", false, err.message);
}

// ---------------------------------------------------------------- long body

try {
  const long = "x".repeat(9000);
  const viaGet = await fetch(
    `${config.server}${config.apiPath}?action=parse&format=json&formatversion=2&text=${encodeURIComponent(long)}`,
    { headers: { "User-Agent": config.userAgent } },
  );
  const getBody = await viaGet.text();

  const viaPost = await fetch(`${config.server}${config.apiPath}`, {
    method: "POST",
    headers: {
      "User-Agent": config.userAgent,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({ action: "parse", format: "json", formatversion: "2", text: long }).toString(),
  });
  const postBody = await viaPost.text();

  const getOk = viaGet.status === 200 && getBody.trim().startsWith("{");
  const postOk = viaPost.status === 200 && postBody.trim().startsWith("{");
  report(
    "长正文 GET/POST 都可用",
    getOk && postOk,
    `GET=${viaGet.status}(${getOk ? "ok" : "fail"}) POST=${viaPost.status}(${postOk ? "ok" : "fail"})`,
  );
} catch (err) {
  report("长正文 GET/POST 对比", false, err.message);
}

// ---------------------------------------------------------------- summary

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
process.exit(0);
