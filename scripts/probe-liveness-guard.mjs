/**
 * Does the write guard actually stop a write when identity is gone?
 *
 * The runtime case - a session that dies after boot - cannot be staged from
 * outside: the cookie is already in the mwn instance's jar in memory, and
 * rewriting the session file changes nothing for a running process. Forging a
 * death from outside would test the forger, not the guard.
 *
 * So the guard is tested where its decision is actually made: sessionLiveness
 * against a bot whose userinfo reports an IP instead of a UID. That is exactly
 * the response BWiki gives an expired cookie - measured, not assumed (the boot
 * probe showed name=203.0.113.7 for a dead session).
 *
 * What is checked:
 *
 *  1. a UID passes, so the guard does not block healthy writes;
 *  2. an IP fails and records the death;
 *  3. once dead, the verdict is sticky - a later call does not re-probe and
 *     then act anyway;
 *  4. a transport failure does NOT count as death, because the wiki being
 *     unreachable says nothing about the credential.
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.cwd();
// The wiki key is only a label in this test (the bot is a fake), but it is read
// from the config so no site name is baked into the repo.
const { key: WIKI_KEY } = (await import("./probe-target.mjs")).probeTarget();
const { sessionLiveness, isBilibiliUid, SessionExpiredError } = await import(
  pathToFileURL(join(root, "dist", "bwiki", "liveness.js")).href
);

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${String(detail).slice(0, 200)}`);
}

/** A bot stand-in whose userinfo reports whatever the test needs. */
function fakeBot(userinfo) {
  return {
    userinfo: async () => {
      if (userinfo instanceof Error) throw userinfo;
      return userinfo;
    },
  };
}

// ---------------------------------------------------------------- 1. UID 通过

try {
  await sessionLiveness.assertAlive(fakeBot({ name: "100000000" }), WIKI_KEY);
  report("UID 身份放行", true, "name=100000000");
} catch (err) {
  report("UID 身份放行", false, err.message);
}

report("isBilibiliUid 判定纯数字", isBilibiliUid("100000000") && !isBilibiliUid("203.0.113.7"), "");

// ---------------------------------------------------------------- 4. 传输失败不算死亡

// Checked before the death cases, because marking death is sticky: once it is
// recorded, later assertions would only be reading that record back.
const beforeDeath = sessionLiveness.deathReason;
try {
  await sessionLiveness.assertAlive(fakeBot(new Error("ECONNRESET")), WIKI_KEY);
  report("传输失败不计为登出", false, "错误被吞掉了");
} catch (err) {
  const isDeath = err instanceof SessionExpiredError;
  report(
    "传输失败不计为登出",
    !isDeath && beforeDeath === null && sessionLiveness.deathReason === null,
    `抛出 ${err.name}: ${err.message.slice(0, 60)}`,
  );
}

// ---------------------------------------------------------------- 2. IP 判死

let deathRecorded = null;
sessionLiveness.setDeathHandler((reason) => {
  deathRecorded = reason;
});

try {
  await sessionLiveness.assertAlive(fakeBot({ name: "203.0.113.7" }), WIKI_KEY);
  report("匿名身份（IP）判为失效", false, "被放行了");
} catch (err) {
  report(
    "匿名身份（IP）判为失效",
    err instanceof SessionExpiredError && sessionLiveness.deathReason !== null,
    err.message.slice(0, 140),
  );
  report("死亡处理器被调用", typeof deathRecorded === "string" && deathRecorded.length > 0, String(deathRecorded).slice(0, 100));
  report("原因里点明要重新登录", /bwiki-login/.test(sessionLiveness.deathReason ?? ""), "");
}

// ---------------------------------------------------------------- 3. 结论是黏的

// A second call must not re-probe and then proceed: once the credential is
// known dead, every later write is refused without another round-trip.
let probedAgain = false;
const watchingBot = {
  userinfo: async () => {
    probedAgain = true;
    return { name: "100000000" };
  },
};
try {
  await sessionLiveness.assertAlive(watchingBot, WIKI_KEY);
  report("失效后结论保持", false, "第二次被放行");
} catch (err) {
  report(
    "失效后结论保持",
    err instanceof SessionExpiredError && probedAgain === false,
    `未再探测 wiki（probedAgain=${probedAgain}）`,
  );
}

// ---------------------------------------------------------------- summary

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
