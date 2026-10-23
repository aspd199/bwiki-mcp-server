/**
 * Are the headers the server actually sends what we think they are?
 *
 * The build passing and a tool call succeeding say nothing about which headers
 * went out - a Referer that is silently dropped looks exactly like a Referer
 * that is sent. So this points an Mwn instance at a local listener, which
 * records what arrived, and asserts on the record.
 *
 * Only the header assembly is under test: the request never leaves the
 * machine and never touches BWiki.
 *
 * Usage: node scripts/probe-headers.mjs   (after npm run build)
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.cwd();
const { Mwn } = await import("mwn");
const { USER_AGENT, refererFor } = await import(
  pathToFileURL(join(root, "dist", "runtime", "constants.js")).href
);

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${String(detail).slice(0, 200)}`);
}

// ---------------------------------------------------------------- listener

/** Collects the headers of each request, then answers a bare JSON body. */
const seen = [];
const server = createServer((req, res) => {
  seen.push(req.headers);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ batchcomplete: true, query: {} }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const apiUrl = `http://127.0.0.1:${port}/example/api.php`;

// ---------------------------------------------------------------- one call

const bot = new Mwn({ apiUrl, userAgent: USER_AGENT });
// The same wiring mwnProvider uses (applyReferer).
const referer = refererFor(apiUrl);
if (referer !== undefined) {
  bot.axiosInstance.defaults.headers = {
    ...bot.axiosInstance.defaults.headers,
    common: { ...(bot.axiosInstance.defaults.headers?.common ?? {}), Referer: referer },
  };
}

await bot.rawRequest({
  url: apiUrl,
  method: "GET",
  params: { action: "query", meta: "siteinfo", format: "json" },
});

server.close();

// ---------------------------------------------------------------- assertions

const headers = seen.at(-1) ?? {};
report("请求确实到达", seen.length > 0, `收到 ${seen.length} 个请求`);
report(
  "User-Agent 是 Chrome 桌面版",
  /^Mozilla\/5\.0 .*Chrome\/\d+/.test(String(headers["user-agent"])),
  String(headers["user-agent"]),
);
report(
  "Referer 指向同一 wiki",
  String(headers.referer ?? "") === `http://127.0.0.1:${port}/example/`,
  String(headers.referer),
);
report(
  "refererFor 对 BWiki 地址推导正确",
  refererFor("https://example.org/example/api.php") === "https://example.org/example/",
  refererFor("https://example.org/example/api.php"),
);
report(
  "refererFor 对非法地址返回 undefined",
  refererFor("not-a-url") === undefined,
  String(refererFor("not-a-url")),
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
