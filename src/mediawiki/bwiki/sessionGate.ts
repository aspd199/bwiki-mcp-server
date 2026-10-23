/**
 * 启动期会话校验。认证失败不结束进程，转为未登录态交由登录门处理。
 *
 * 判定依据是 `userinfo.name` 是否为数字 UID，不能用 `anon` 或 `id`。
 */

import { Mwn } from 'mwn';
import { USER_AGENT } from '../runtime/constants.ts';
import { DEFAULT_SESSION_FILE } from '../config/loadConfig.ts';
import { readSessionFile, wikiCookiePartsFor, type StoredSession } from './cookie.ts';

export class NoSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NoSessionError';
	}
}

/**
 * 读取已存会话并确认其有效。无效时返回 null，不抛出。
 *
 * 供启动期使用：无会话不阻止启动，首次工具调用时会触发登录流程。
 */
export async function readStoredSessionIfValid(
	file: string = DEFAULT_SESSION_FILE,
): Promise<StoredSession | null> {
	const session = await readSessionFile(file);
	if (!session) {
		return null;
	}

	let name: string | undefined;
	try {
		name = await probeIdentity(session);
	} catch {
		// 网络问题时视为无效，保持未登录态；首次调用会重新触发登录。
		return null;
	}

	// 数字即 UID；其他（如 IP 地址）表示会话已失效。
	if (!name || !/^\d{5,}$/.test(name)) {
		return null;
	}
	return session;
}

/** 询问某个已配置 wiki 当前身份。任一站点的结论对全部有效。 */
async function probeIdentity(session: StoredSession): Promise<string | undefined> {
	const { apiUrl } = await firstWikiEndpoint();
	const bot = new Mwn({ apiUrl, userAgent: USER_AGENT });
	for (const cookie of wikiCookiePartsFor(session)) {
		try {
			// 不写 Domain，使其为 host-only。
			await bot.cookieJar.setCookie(`${cookie}; Path=/`, apiUrl);
		} catch {
			// 格式错误的条目不中断启动，由下方探测判断是否有可用凭证。
		}
	}
	const user = await bot.userinfo();
	return user?.name ?? user?.userName;
}

/** The api.php URL of the first configured wiki. */
async function firstWikiEndpoint(): Promise<{ apiUrl: string }> {
	const { loadConfigFromFile } = await import('../config/loadConfig.ts');
	const { createAppState } = await import('../wikis/state.ts');
	const state = createAppState(loadConfigFromFile());
	const { config: wiki } = state.activeWiki.get();
	return { apiUrl: `${wiki.server}${wiki.scriptpath}/api.php` };
}
