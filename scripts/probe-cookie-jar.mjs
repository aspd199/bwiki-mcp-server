/**
 * Can tough-cookie's jar hold the bilibili passport cookie for a
 * wiki.biligame.com request?
 *
 * mwn wires an axios interceptor to send whatever the jar holds for the
 * request URL, and exposes `cookieJar` publicly, so injecting the passport
 * cookie is the cleanest way to authenticate. tough-cookie enforces domain
 * scoping, though: SESSDATA's real domain is .bilibili.com, while the
 * request goes to wiki.biligame.com. A mismatched domain would be silently
 * dropped by the jar.
 *
 * This checks which domain form actually survives.
 */

import { CookieJar } from "tough-cookie";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeTarget } from "./probe-target.mjs";

const sessionPath = process.platform === "win32"
  ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "bwiki-mcp-server", "session.json")
  : join(homedir(), ".config", "bwiki-mcp-server", "session.json");

const stored = JSON.parse(readFileSync(sessionPath, "utf8"));
const sess = (stored.passportCookie.match(/SESSDATA=([^;]+)/) || [])[1];
if (!sess) {
  console.error("session.json 里没有 SESSDATA");
  process.exit(1);
}

const { apiUrl: url } = probeTarget();

async function trySet(label, cookieString) {
  const jar = new CookieJar();
  try {
    await jar.setCookie(cookieString, url);
  } catch (err) {
    console.log(`${label}\n   设置失败: ${String(err).slice(0, 140)}`);
    return;
  }
  const header = await jar.getCookieString(url);
  const kept = /SESSDATA=/.test(header);
  console.log(`${label}`);
  console.log(`   jar 保留了 SESSDATA = ${kept}`);
  console.log(`   发出的头 = ${header.replace(/=[^;]+/g, "=<redacted>") || "(空)"}`);
}

console.log("目标请求:", url, "\n");

await trySet("[A] Domain=.bilibili.com（真实域）", `SESSDATA=${sess}; Domain=.bilibili.com; Path=/`);
await trySet("[B] Domain=.biligame.com（wiki 域）", `SESSDATA=${sess}; Domain=.biligame.com; Path=/`);
await trySet("[C] host-only wiki.biligame.com", `SESSDATA=${sess}; Domain=wiki.biligame.com; Path=/`);
await trySet("[D] 无 Domain 属性", `SESSDATA=${sess}; Path=/`);
