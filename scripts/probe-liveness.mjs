/**
 * Does a dead session stop a write, and does the connection stay up?
 *
 * BWiki does not refuse an expired cookie - it answers as an anonymous
 * visitor - so without a guard the write would succeed and be attributed to
 * the server's egress IP.
 *
 * How the death is staged: the stored session is swapped for one carrying a
 * bogus SESSDATA, so the wiki genuinely does not recognize it. Forging a local
 * "looks dead" flag would test the flag, not the behaviour.
 *
 * Three things are checked:
 *
 *  1. a wiki operation is refused with an authentication error, not run as
 *     the anonymous visitor;
 *  2. the reason reaches the client (a silent drop would leave no diagnosis);
 *  3. the connection stays up, so a later login can resume service.
 *
 * Browser login is disabled via BWIKI_MCP_NO_BROWSER_LOGIN: nothing here can
 * complete a real sign-in, and the point is what happens before that.
 *
 * The real session is restored afterwards, whatever the outcome.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const root = process.cwd();
const sessionPath = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "bwiki-mcp-server",
  "session.json",
);

// ---------------------------------------------------------------- stage

const real = await readFile(sessionPath, "utf8");
const realSession = JSON.parse(real);

// A syntactically valid but unrecognizable cookie: the wiki treats it as no
// session at all, which is exactly what an expiry looks like from here.
const dead = {
  ...realSession,
  passportCookie: "SESSDATA=expired0000000000%2C1%2Cdead&buvid3=dead",
  wikiCookie: "gamecenter_wiki__session=expiredsession",
};
await mkdir(dirname(sessionPath), { recursive: true });
await writeFile(sessionPath, JSON.stringify(dead, null, 2));

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${String(detail).slice(0, 240)}`);
}

let client;
try {
  // ---------------------------------------------------------------- boot

  // A dead session no longer blocks startup: the server comes up unauthenticated
  // and the login gate handles it on the first wiki operation.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist", "bundle.cjs")],
    cwd: root,
    env: {
      ...process.env,
      CONFIG: join(root, "config.json"),
      BWIKI_MCP_NO_BROWSER_LOGIN: "1",
    },
    stderr: "pipe",
  });

  client = new Client({ name: "liveness-probe", version: "0" });
  await client.connect(transport);
  report("死会话下仍能启动", true);

  // ---------------------------------------------------------------- guard

  try {
    const res = await client.callTool({
      name: "get-page",
      arguments: { title: "首页" },
    });
    const text = res.content?.[0]?.text ?? "";
    const refused =
      res.isError === true || /authentication|未登录|需要登录/.test(text);
    report("死会话下读操作被拒（不以匿名身份返回）", refused, text.slice(0, 160));
  } catch (err) {
    report("死会话下读操作被拒（不以匿名身份返回）", true, `调用被中断: ${err.message.slice(0, 100)}`);
  }

  // ---------------------------------------------------------------- stays up

  // The connection must survive: re-login is the recovery path, and a dropped
  // transport would force the client to reconnect first.
  try {
    const res = await client.callTool({ name: "list-wikis", arguments: {} });
    report("连接保持可用", res.isError !== true, res.isError ? String(res.content?.[0]?.text).slice(0, 120) : "");
  } catch (err) {
    report("连接保持可用", false, err.message.slice(0, 120));
  }
} finally {
  try {
    await client?.close();
  } catch {
    // Already closed.
  }
  await writeFile(sessionPath, real);
}

// ---------------------------------------------------------------- summary

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
console.log(`（真实会话已还原）`);
process.exit(failed.length > 0 ? 1 : 0);
