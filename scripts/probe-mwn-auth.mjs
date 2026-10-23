/**
 * Does the passport cookie authenticate when mwn carries it?
 *
 * This is the wiring the mwnProvider change depends on, checked against the
 * real wiki with the real stored session, rather than inferred from the code
 * path. Three things are verified, in order of how easily they could be wrong:
 *
 *  1. host-only Domain (wiki.biligame.com) vs Domain=.biligame.com — the
 *     domain rewrite is where tough-cookie refused before, so it is checked
 *     explicitly rather than assumed.
 *  2. the wiki cookie (gamecenter_wiki__session) alone, without SESSDATA —
 *     it is the credential the wiki minted itself, and if it works the login
 *     state can be read straight off disk with no exchange step.
 *  3. write permission — canEdit is what every edit tool actually needs, and
 *     an authenticated read alone would not prove the session can be used.
 */

import { Mwn } from "mwn";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const config = JSON.parse(readFileSync("config.json", "utf8"));
const sessionPath = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "bwiki-mcp-server", "session.json");
const stored = JSON.parse(readFileSync(sessionPath, "utf8"));

const API_URL = `${config.server}${config.apiPath}`;
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${String(detail).slice(0, 200)}`);
}

/** Build an mwn with one cookie string injected, domain as given. */
function botWith(cookie, domain) {
  const bot = new Mwn({ apiUrl: API_URL, userAgent: config.userAgent });
  for (const pair of cookie.split(";").map((c) => c.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const name = eq > 0 ? pair.slice(0, eq) : "";
    const value = eq > 0 ? pair.slice(eq + 1) : "";
    if (!name || !value) continue;
    bot.cookieJar.setCookieSync(`${name}=${value}; Domain=${domain}; Path=/`, API_URL);
  }
  return bot;
}

async function identityOf(bot) {
  const user = await bot.userinfo();
  return user?.name ?? user?.userName;
}

// ---------------------------------------------------------------- 1. domain

// The domain rewrite has bitten before: tough-cookie refuses a .bilibili.com
// cookie for wiki.biligame.com with "Cookie not in this host's domain". Both
// forms that could work are checked so the choice is a measured one.
for (const [label, domain] of [
  ["host-only (wiki.biligame.com)", new URL(API_URL).hostname],
  ["Domain=.biligame.com", ".biligame.com"],
]) {
  try {
    const name = await identityOf(botWith(stored.passportCookie, domain));
    report(`passport cookie 注入后认出 UID（${label}）`, /^\d{5,}$/.test(name ?? ""), `name=${name}`);
  } catch (err) {
    report(`passport cookie 注入（${label}）`, false, err.message);
  }
}

// ---------------------------------------------------------------- 2. wiki cookie

try {
  const name = await identityOf(botWith(stored.wikiCookie, new URL(API_URL).hostname));
  report("wikiCookie 单独即可认出 UID", /^\d{5,}$/.test(name ?? ""), `name=${name}`);
} catch (err) {
  report("wikiCookie 单独注入", false, err.message);
}

// ---------------------------------------------------------------- 3. write right

// `canEdit` is not a MediaWiki field — it is derived here from the rights list,
// the way the wiki itself decides whether an edit is allowed.
try {
  const info = await botWith(stored.wikiCookie, new URL(API_URL).hostname).request({
    action: "query",
    meta: "userinfo",
    uiprop: "groups|rights",
  });
  const user = info?.query?.userinfo;
  const canEdit = (user?.rights ?? []).includes("edit");
  report("具备 edit 权限", canEdit, `groups=${(user?.groups ?? []).join(",")}`);
} catch (err) {
  report("权限查询", false, err.message);
}

// ---------------------------------------------------------------- 4. host isolation

// BWiki's wikis share one host - wiki.biligame.com - and differ by path
// (one code per path). So "another wiki" is the same host on a different path, and
// sending the cookie there is correct, not a leak. What must NOT happen is the
// cookie reaching an unrelated host, which is what a host-only cookie is for.
try {
  const onWiki = botWith(stored.passportCookie, new URL(API_URL).hostname);
  await identityOf(onWiki);
  const sameHost = await onWiki.cookieJar.getCookieString(`${new URL(API_URL).origin}/another-wiki/api.php`);
  const otherHost = await onWiki.cookieJar.getCookieString("https://example.com/");
  report(
    "cookie 不离开 biligame.com",
    sameHost.length > 0 && !otherHost.includes("SESSDATA"),
    `同 host 其他 wiki=${sameHost.includes("SESSDATA") ? "收到（正确，农场共用 host）" : "未收到"} 异域=${otherHost.length}字符`,
  );
} catch (err) {
  report("host 隔离检查", false, err.message);
}

// ---------------------------------------------------------------- summary

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
process.exit(0);
