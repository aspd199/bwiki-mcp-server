/**
 * Does sending a Referer change how BWiki's edge responds?
 *
 * Premise to check: BWiki sits behind Tencent Cloud EdgeOne, which may score a
 * bare API request (no Referer, no page navigation) as anomalous and answer
 * 567/514. If a Referer naming the wiki itself changes that, it is worth
 * sending on every request.
 *
 * How the question is answered honestly: the response status is the only thing
 * recorded, and each request is a single read-only `meta=siteinfo`. Nothing is
 * written. Requests are spaced past the project's 1.1s interval so the probe
 * does not provoke the very blocking it is measuring.
 *
 * What this CANNOT establish: EdgeOne's scoring is not observable from here. A
 * single pair of successful responses proves only that neither form was
 * blocked at this moment - it says nothing about whether Referer lowers risk
 * under sustained load or from a different network. The result is reported as
 * "not blocked in N tries", never as "Referer reduces 567 risk".
 *
 * Usage: node scripts/probe-referer.mjs
 */

import { Mwn } from "mwn";
import { probeTarget } from "./probe-target.mjs";

const { apiUrl: API_URL, server } = probeTarget();
const PAGE_URL = `${server}/`;
const INTERVAL_MS = 2500;

// A real Chrome UA: the same one the server now sends.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One read-only call, with or without a Referer.
 *
 * axios (which mwn wraps) refuses to expose a status for a non-2xx response
 * unless validateStatus lets it through, so the status is captured rather than
 * thrown.
 */
async function probe({ label, referer }) {
  const bot = new Mwn({ apiUrl: API_URL, userAgent: UA });
  const headers = referer ? { Referer: referer } : {};
  bot.setRequestOptions({ headers, validateStatus: () => true });

  const started = Date.now();
  try {
    const res = await bot.rawRequest({
      url: API_URL,
      method: "GET",
      params: { action: "query", meta: "siteinfo", format: "json" },
    });
    const status = res.status;
    const ok = status === 200 && typeof res.data === "object";
    return {
      label,
      status,
      ok,
      ms: Date.now() - started,
      detail: ok ? "正常 JSON" : String(res.data ?? "").slice(0, 120),
    };
  } catch (err) {
    return {
      label,
      status: err.response?.status ?? "no-response",
      ok: false,
      ms: Date.now() - started,
      detail: String(err.message).slice(0, 120),
    };
  }
}

const cases = [
  { label: "无 Referer", referer: undefined },
  { label: "Referer=页面地址", referer: PAGE_URL },
  { label: "Referer=站点根", referer: `${server}/` },
  { label: "无 Referer（复测）", referer: undefined },
  { label: "Referer=页面地址（复测）", referer: PAGE_URL },
];

const results = [];
for (const c of cases) {
  const r = await probe(c);
  results.push(r);
  const mark = r.ok ? "OK  " : "FAIL";
  console.log(`${mark} ${String(r.status).padEnd(4)} ${r.label.padEnd(22)} ${r.ms}ms  ${r.ok ? "" : r.detail}`);
  await sleep(INTERVAL_MS);
}

// ---------------------------------------------------------------- verdict

const blocked = results.filter((r) => r.status === 567 || r.status === 514);
const failed = results.filter((r) => !r.ok);

console.log("");
if (blocked.length > 0) {
  console.log(`被 EdgeOne 拦截 ${blocked.length} 次（567/514）——此时不宜继续试探，冷却 ≥3 分钟。`);
} else if (failed.length === 0) {
  console.log(`${results.length}/${results.length} 全部正常，未出现 567/514。`);
  console.log("结论：本次未观测到 Referer 对响应状态有影响。");
  console.log("注意：这不能证明 Referer 降低拦截风险——单次探测看不到 EdgeOne 的评分逻辑。");
} else {
  console.log(`${failed.length} 次失败，但不是 EdgeOne 拦截：`);
  for (const f of failed) console.log(`  - ${f.label}: ${f.status} ${f.detail}`);
}
