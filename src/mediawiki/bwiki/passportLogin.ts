/**
 * 通过本机浏览器完成官方通行证登录。
 *
 * SESSDATA 是 .bilibili.com 上的 HttpOnly cookie，页面脚本与 Node 进程均无法读取，
 * 故由 puppeteer-core 通过 DevTools 协议取出。使用一次性 profile，不触碰用户真实配置。
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BrowserChoice {
  executablePath: string;
  name: string;
}

/** Browsers to try, in order of preference. */
const CANDIDATES: Array<{ name: string; path: string }> = [
  { name: "Edge", path: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" },
  { name: "Edge", path: "C:/Program Files/Microsoft/Edge/Application/msedge.exe" },
  { name: "Chrome", path: "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe" },
  { name: "Chrome", path: "C:/Program Files/Google/Chrome/Application/chrome.exe" },
  { name: "Chrome", path: "C:/Program Files/Google/Chrome/Application/chrome.exe" },
  {
    name: "Chromium",
    path: join(process.env.LOCALAPPDATA ?? "", "Chromium", "Application", "chrome.exe"),
  },
];

export function findBrowser(): BrowserChoice | null {
  for (const c of CANDIDATES) {
    if (c.path && existsSync(c.path)) {
      return { executablePath: c.path, name: c.name };
    }
  }
  return null;
}

export interface OfficialLoginResult {
  /** Cookie header value for the wiki, e.g. "SESSDATA=...; bili_jct=...". */
  cookie: string;
  /** The bilibili UID. */
  userId: string;
}

/** How long to wait for the user to finish logging in. */
const LOGIN_TIMEOUT_MS = 180_000;

/** Polling interval while waiting for the credential to appear. */
const POLL_INTERVAL_MS = 2000;

/**
 * 打开通行证登录页并等待登录完成。浏览器窗口保持可见。
 */
export async function loginViaOfficialPage(): Promise<OfficialLoginResult> {
  const choice = findBrowser();
  if (!choice) {
    throw new Error(
      "找不到本机浏览器。请安装 Edge 或 Chrome 后重试。",
    );
  }

  // 按需加载，缺失时给出明确错误。
  let puppeteer: any;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch {
    throw new Error(
      "puppeteer-core 未安装。运行 npm install 后重试。",
    );
  }

  // 一次性 profile：不触碰用户真实配置，也避免残留会话跳过登录。
  const profileDir = await mkdtemp(join(tmpdir(), "bwiki-mcp-server-login-"));

  const browser = await puppeteer.launch({
    executablePath: choice.executablePath,
    headless: false,
    defaultViewport: null,
    userDataDir: profileDir,
    args: ["--start-maximized", "--no-first-run", "--no-default-browser-check"],
  });

  try {
    const page = await browser.newPage();
    await page.goto("https://passport.biligame.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const cookies = await browser.cookies();
      const bilibili = cookies.filter(
        (c: any) => /bilibili|bigfun/.test(c.domain) && c.name === "SESSDATA",
      );
      if (bilibili.length > 0) {
  // 用 .bilibili.com 上的 cookie 重建请求头。
        const wanted = cookies.filter(
          (c: any) =>
            c.domain === ".bilibili.com" &&
            ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"].includes(c.name),
        );
        const cookie = wanted.map((c: any) => `${c.name}=${c.value}`).join("; ");
        const userId = cookies.find((c: any) => c.name === "DedeUserID")?.value ?? "";
        return { cookie, userId };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error("等待登录超时（180 秒）");
  } finally {
    await browser.close().catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
