/**
 * Which wiki the probe scripts should talk to, and where it lives.
 *
 * The scripts used to hard-code one site, which is how a development test site
 * ended up baked into anything that read them. Now the site comes from the same
 * config.json the server reads, so a checkout carries no site name of its own.
 *
 * The config names wikis by code only (`{"wikis": ["somewiki"]}`); the address
 * is derived from the code the same way the server derives it.
 *
 * Resolution order, first match wins:
 *
 *   1. `BWIKI_PROBE_WIKI` - an environment variable, for pointing a probe at
 *      one wiki without editing the config.
 *   2. the config's first entry, which is the server's default wiki.
 *
 * A missing or empty config is an error here rather than a silent default, for
 * the same reason the server refuses to start without one: there is no site
 * that is correct to guess.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FARM_ORIGIN = "https://wiki.biligame.com";

const root = process.cwd();
const configPath = process.env.CONFIG ?? join(root, "config.json");

function readConfig() {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `找不到配置文件 ${configPath}。先复制 config.example.json 为 config.json 并填入站点代号。`,
    );
  }
  return JSON.parse(raw);
}

/** The codes a config names, accepting the one-wiki string shorthand. */
function codesOf(config) {
  const raw = config.wikis;
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (Array.isArray(raw)) return raw.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim());
  return [];
}

/**
 * The wiki key and its derived URLs, in the form the probes need.
 *
 * `server` carries the wiki code on BWiki (all wikis share one host and differ
 * by path), so the API URL sits at the wiki root.
 */
export function probeTarget() {
  const config = readConfig();
  const codes = codesOf(config);

  const key = process.env.BWIKI_PROBE_WIKI?.trim() || codes[0] || "";
  if (!key) {
    throw new Error(
      `配置 ${configPath} 里没有站点。设 "wikis": ["<站点代号>"] 或环境变量 BWIKI_PROBE_WIKI。`,
    );
  }
  if (process.env.BWIKI_PROBE_WIKI?.trim() && !codes.includes(key)) {
    throw new Error(`配置里没有站点 "${key}"。可选: ${codes.join(", ") || "（无）"}`);
  }

  const server = `${FARM_ORIGIN}/${key}`;
  return {
    key,
    server,
    apiUrl: `${server}/api.php`,
    config,
    configPath,
  };
}
