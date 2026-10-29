/**
 * End-to-end smoke test: launch the stdio server and drive it like a client.
 *
 * Everything before this has been checked per-unit (auth probe, compat probe,
 * typecheck). What this verifies is the wiring between them: the process
 * starts, advertises the BWiki tool set, and the tools behave correctly for
 * the session state they find.
 *
 * It runs WITHOUT a stored session on purpose: browser login cannot be
 * completed unattended, and a test that needs a human to scan a QR code is
 * not a test. So the wiki operations are asserted to be refused with an
 * authentication error rather than answered as an anonymous visitor.
 *
 * The logged-in path is covered by driving the server by hand through an MCP
 * client; that is the only way to get a real session into the process.
 *
 * The bundled single-file entry is what gets launched, so what is exercised is
 * what ships - not a source tree that needs node_modules next to it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { probeTarget } from "./probe-target.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = probeTarget();
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${String(detail).slice(0, 300)}`);
}

/** The bundled single file is the shipped entry point. */
const entry = join(root, "dist", "bundle.cjs");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: root,
  env: {
    ...process.env,
    CONFIG: join(root, "config.json"),
    // 无会话时不得弹出浏览器：测试环境无人完成登录。
    BWIKI_MCP_NO_BROWSER_LOGIN: "1",
  },
  stderr: "inherit",
});

const client = new Client({ name: "bwiki-mcp-server-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  report("连接到 stdio 服务", true);
} catch (err) {
  report("连接到 stdio 服务", false, err.message);
  console.log("\n0/1 通过（服务未能启动，先编译：npm run build:mediawiki）");
  process.exit(1);
}

// ---------------------------------------------------------------- tools/list

try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  report("列出工具", tools.length > 0, `${tools.length} 个工具: ${names.join(", ")}`);

  const mustHave = [
    "get-page", "search-page", "whoami", "get-site-info",
    "create-page", "update-page", "delete-page", "upload-file",
    "parse-wikitext", "get-recent-changes", "list-pages",
  ];
  const missing = mustHave.filter((n) => !names.includes(n));
  report("BWiki 需要的工具齐全", missing.length === 0, missing.length ? `缺: ${missing.join(", ")}` : "全部在场");

  const gone = ["add-wiki", "remove-wiki", "oauth-status", "oauth-logout"];
  const stillThere = gone.filter((n) => names.includes(n));
  report("OAuth / 增删站点工具已移除", stillThere.length === 0, stillThere.length ? `仍在: ${stillThere.join(", ")}` : "已移除");

  // list-wikis is always offered now: it reports the BWiki farm roster, which
  // is worth reading however many wikis are configured. Upstream hid it below
  // two configured wikis because it only ever listed config.json.
  const hasListWikis = names.includes("list-wikis");
  report("list-wikis 常驻", hasListWikis, hasListWikis ? "在场" : "缺席");
} catch (err) {
  report("列出工具", false, err.message);
}

// ---------------------------------------------------------------- identity

// Tool output is a human-readable text block, not JSON, so assertions match on
// substrings rather than parsing.
function textOf(res) {
  return res.content?.[0]?.text ?? "";
}

/**
 * True when the call was refused for want of a session.
 *
 * The smoke test runs without one on purpose: browser login cannot be
 * completed unattended. In that state every wiki operation is expected to be
 * refused, so a refusal is a pass, not a failure.
 */
function refusedForNoSession(res) {
  const text = textOf(res);
  return (
    res.isError === true &&
    /authentication|未登录|需要登录/.test(text)
  );
}

try {
  const res = await client.callTool({ name: "whoami", arguments: {} });
  const text = textOf(res);
  if (refusedForNoSession(res)) {
    report("whoami 未登录时被拒", true, text.slice(0, 120));
  } else {
    report("whoami 认出 bilibili UID", /\b\d{5,}\b/.test(text), text.slice(0, 120));
  }
} catch (err) {
  report("whoami", false, err.message);
}

// ---------------------------------------------------------------- read

try {
  const res = await client.callTool({ name: "get-page", arguments: { title: "首页" } });
  const text = textOf(res);
  if (refusedForNoSession(res)) {
    report("get-page 未登录时被拒", true, text.slice(0, 120));
  } else {
    report("get-page 读到内容", text.length > 50 && !res.isError, `返回 ${text.length} 字符: ${text.slice(0, 80).replace(/\n/g, " ")}`);
  }
} catch (err) {
  report("get-page", false, err.message);
}

// ---------------------------------------------------------------- search

try {
  const res = await client.callTool({ name: "search-page", arguments: { query: "首页", limit: 3 } });
  const text = textOf(res);
  if (refusedForNoSession(res)) {
    report("search-page 未登录时被拒", true, text.slice(0, 120));
  } else {
    const hits = (text.match(/^- /gm) ?? []).length;
    report("search-page 有命中", hits > 0 || /结果|Result/i.test(text), `${hits} 条: ${text.slice(0, 100).replace(/\n/g, " ")}`);
  }
} catch (err) {
  report("search-page", false, err.message);
}

// ---------------------------------------------------------------- extension gate

try {
  const res = await client.callTool({ name: "smw-query", arguments: { query: "[[分类:首页]]", limit: 3 } });
  const text = textOf(res);
  const isError = res.isError === true;
  if (refusedForNoSession(res)) {
    report("smw-query 未登录时被拒", true, text.slice(0, 120));
  } else {
    // Either it answers (SMW registered and the wiki has it) or it reports the
    // tool is unavailable. Both are the gate working; a crash is not.
    report("smw-query 走扩展注册门", !isError || /unavailable|not available|disabled/i.test(text), text.slice(0, 150));
  }
} catch (err) {
  report("smw-query", false, err.message);
}

// ---------------------------------------------------------------- list-wikis

// The farm roster is ~1000 wikis, so the tool paginates by default and offers
// a query filter. Both are exercised, plus the configured-only view. The roster
// grows, so the total is asserted to be reported and non-zero and for the page
// to be smaller than the total (i.e. actually paginated) rather than to equal a
// number that changes upstream.
try {
  const res = await client.callTool({ name: "list-wikis", arguments: {} });
  const text = textOf(res);
  const total = res.structuredContent?.total ?? Number(text.match(/Total: (\d+)/)?.[1] ?? NaN);
  const listed = res.structuredContent?.wikis?.length ?? NaN;
  report(
    "list-wikis 默认分页",
    !res.isError && total > 0 && (Number.isNaN(listed) || listed < total),
    `Total: ${total}，本页 ${Number.isNaN(listed) ? "?" : listed} 条`,
  );
} catch (err) {
  report("list-wikis", false, err.message);
}

try {
  const res = await client.callTool({ name: "list-wikis", arguments: { query: target.key } });
  const text = textOf(res);
  report("list-wikis query 过滤", !res.isError && text.includes(`Key: ${target.key}`), text.slice(0, 200).split("\n").join(" | "));
} catch (err) {
  report("list-wikis query", false, err.message);
}

try {
  const res = await client.callTool({ name: "list-wikis", arguments: { configuredOnly: true } });
  const text = textOf(res);
  // The configured count comes from config.json, so it is read rather than
  // assumed: adding a wiki must not make this assertion lie.
  const configured = Array.isArray(target.config.wikis) ? target.config.wikis.length : 1;
  report(
    "list-wikis 只报已配置",
    !res.isError && text.includes(`Total: ${configured}`),
    `${text.match(/Total: \d+/)?.[0] ?? "(无)"}（配置中 ${configured} 个）`,
  );
} catch (err) {
  report("list-wikis configuredOnly", false, err.message);
}

// ---------------------------------------------------------------- list-pages

// Namespace enumeration walks the namespace itself rather than a query, so it
// is the one listing path no other tool exercises.
try {
  const res = await client.callTool({ name: "list-pages", arguments: { namespace: 0, limit: 3 } });
  const text = textOf(res);
  if (refusedForNoSession(res)) {
    report("list-pages 未登录时被拒", true, text.slice(0, 120));
  } else {
    const count = res.structuredContent?.pages?.length ?? 0;
    report("list-pages 列出命名空间页面", !res.isError && count > 0, `${count} 条: ${text.slice(0, 100).replace(/\n/g, " ")}`);
  }
} catch (err) {
  report("list-pages", false, err.message);
}

// ---------------------------------------------------------------- https only

// Every request carries the session cookie, so an http URL anywhere would put
// that credential on the wire in clear text. These are the places an http URL
// could enter, checked against the built code.
try {
  const { assertPublicDestination } = await import(pathToFileURL(join(root, 'dist', 'ssrfGuard.js')).href);
  for (const url of [target.apiUrl.replace("https://", "http://"), 'ftp://example.com/f']) {
    let refused = false;
    try { await assertPublicDestination(url); } catch { refused = true; }
    report(`拒绝 ${url.split('/')[0]} URL`, refused, url);
  }
  const addrs = await assertPublicDestination(target.apiUrl);
  report('https 仍放行', addrs.length > 0, `${addrs.length} 个地址`);
} catch (err) {
  report('https 校验', false, err.message);
}

// ---------------------------------------------------------------- summary

await client.close().catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项:");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(0);
