/**
 * Do the write tools actually write?
 *
 * ⚠ NOT RUN YET. This script writes to the live wiki, so it is deliberately
 * not part of smoke-stdio.mjs and must not run unattended. Run it by hand with
 * the operator aware that a real page appears and is deleted on the wiki:
 *
 *     node scripts/probe-writes.mjs
 *
 * The gap it exists to close: everything verified so far covers registration,
 * auth, and the read path. The write path has only been checked at the mwn
 * layer (probe-mwn-compat), which is a different contract from the tools' —
 * they build their own params, pass their own basetimestamp, and treat a
 * missing page differently from an existing one.
 *
 * A wrong write is worse than a wrong read, so the cycle is done in full and
 * cleaned up: create a throwaway page, read it back, edit it, verify the edit,
 * check the history, then delete it and confirm it is gone. The page name
 * carries a timestamp so a run that dies mid-way leaves something obviously
 * disposable rather than looking like wiki content.
 *
 * Parameter shapes below come from the tools' own inputSchema (create-page
 * takes `source` and `comment`, update-page takes `operation` and `source`,
 * delete-page takes `comment`) — checked against the source, not assumed.
 *
 * The write guard (session liveness) also fires here, so a passing run proves
 * the guard does not block a healthy session.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const root = process.cwd();
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${String(detail).slice(0, 260)}`);
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
const title = `bwiki-mcp-server 写入探针 ${stamp}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "bundle.cjs")],
  cwd: root,
  env: {
      ...process.env,
      CONFIG: join(root, "config.json"),
      // 无会话时不得弹出浏览器：探针环境无人完成登录。
      BWIKI_MCP_NO_BROWSER_LOGIN: "1",
    },
  stderr: "inherit",
});
const client = new Client({ name: "write-probe", version: "0" });
await client.connect(transport);

const textOf = (res) => res.content?.[0]?.text ?? "";
const call = (name, args) => client.callTool({ name, arguments: args });

let created = false;

try {
  // ------------------------------------------------------------ create

  const createRes = await call("create-page", {
    title,
    source: "这是 bwiki-mcp-server 的写入探针临时页，会被立即删除。\n\n初始内容。",
    comment: "bwiki-mcp-server 写入探针",
  });
  created = !createRes.isError;
  report("create-page 创建成功", created, textOf(createRes).slice(0, 200));

  // ------------------------------------------------------------ read back

  const readRes = await call("get-page", { title });
  const readText = textOf(readRes);
  report("创建后可读回", !readRes.isError && readText.includes("初始内容"), readText.slice(0, 160));

  // ------------------------------------------------------------ update

  const updateRes = await call("update-page", {
    title,
    operation: "replace",
    source: "这是 bwiki-mcp-server 的写入探针临时页，会被立即删除。\n\n已修改的内容。",
    comment: "bwiki-mcp-server 写入探针（修改）",
  });
  report("update-page 修改成功", !updateRes.isError, textOf(updateRes).slice(0, 200));

  // ------------------------------------------------------------ verify

  const verifyRes = await call("get-page", { title });
  const verifyText = textOf(verifyRes);
  report(
    "修改已生效",
    verifyText.includes("已修改的内容") && !verifyText.includes("初始内容。"),
    verifyText.slice(0, 160),
  );

  // ------------------------------------------------------------ history

  const histRes = await call("get-page-history", { title });
  const histText = textOf(histRes);
  const revisions = (histText.match(/r?evision|\b\d{6,}\b/gi) ?? []).length;
  report("历史记录可读", !histRes.isError && histText.length > 0, `命中 ${revisions} 处: ${histText.slice(0, 120)}`);

  // ------------------------------------------------------------ delete

  const delRes = await call("delete-page", {
    title,
    comment: "bwiki-mcp-server 写入探针清理",
  });
  report("delete-page 删除成功", !delRes.isError, textOf(delRes).slice(0, 200));
  created = false;

  // ------------------------------------------------------------ confirm gone

  const goneRes = await call("get-page", { title });
  const goneText = textOf(goneRes);
  report(
    "删除后不可读",
    goneRes.isError === true || /not found|不存在|missing|no page/i.test(goneText),
    goneText.slice(0, 160),
  );
} catch (err) {
  report("写入流程", false, err.message);
} finally {
  // Leave nothing behind if an assertion failed mid-cycle.
  if (created) {
    try {
      await call("delete-page", { title, comment: "bwiki-mcp-server 写入探针清理（失败回退）" });
      console.log(`      （已清理残留页面：${title}）`);
    } catch {
      console.log(`      ⚠ 未能清理，请手动删除：${title}`);
    }
  }
  await client.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项:");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length > 0 ? 1 : 0);
