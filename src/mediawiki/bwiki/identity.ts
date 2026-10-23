/**
 * 将 bilibili passport cookie 换为可用的 wiki 会话。
 *
 * 已登录时 userinfo.name 为数字 UID，未登录时为出口 IP；
 * `id` 恒为 0、`anon` 不可靠，只能以 name 判断。
 */

import { Mwn } from 'mwn';
import { CHROME_USER_AGENT } from '../runtime/constants.ts';

export interface WikiIdentity {
	/** bilibili UID。 */
	name: string;
	canEdit: boolean;
	/** 后续请求使用的 cookie。 */
	wikiCookie: string;
}

export class NotLoggedInError extends Error {
	constructor(message = '未登录或登录已过期') {
		super(message);
		this.name = 'NotLoggedInError';
	}
}

export class Identity {
	constructor(private readonly apiUrl: string) {}

	/** 携带 passport cookie 请求一次，取回 wiki 自种的会话 cookie。 */
	private async touchWiki(passportCookie: string): Promise<string> {
		try {
			const resp = await fetch(`${this.apiUrl}?action=query&meta=siteinfo&format=json`, {
				method: 'GET',
				headers: { 'User-Agent': CHROME_USER_AGENT, Cookie: passportCookie },
				redirect: 'manual',
			});
			const setCookie =
				typeof resp.headers.getSetCookie === 'function'
					? resp.headers.getSetCookie()
					: [resp.headers.get('set-cookie')].filter(Boolean);
			const wikiPart = (setCookie as string[])
				.flatMap((line) => line.split(/,(?=\s*[^=;,\s]+=)/))
				.map((c) => c.split(';', 1)[0]?.trim() ?? '')
				.filter((c) => /gamecenter_wiki/i.test(c))
				.join('; ');
			return wikiPart ? `${passportCookie}; ${wikiPart}` : passportCookie;
		} catch {
			// 非致命：API 可能直接接受 passport cookie。
			return passportCookie;
		}
	}

	/**
	 * 认证并返回身份；wiki 不识别该 cookie 时抛出 NotLoggedInError。
	 */
	async establish(passportCookie: string): Promise<WikiIdentity> {
		if (!passportCookie) {
			throw new NotLoggedInError('缺少 bilibili 登录态');
		}

		const wikiCookie = await this.touchWiki(passportCookie);

		const bot = new Mwn({ apiUrl: this.apiUrl, userAgent: CHROME_USER_AGENT });
		for (const pair of wikiCookie.split(';').map((c) => c.trim()).filter(Boolean)) {
			const eq = pair.indexOf('=');
			const name = eq > 0 ? pair.slice(0, eq) : '';
			const value = eq > 0 ? pair.slice(eq + 1) : '';
			if (!name || !value) continue;
			// 不写 Domain，host-only。
			await bot.cookieJar.setCookie(`${name}=${value}; Path=/`, this.apiUrl);
		}
		await bot.getSiteInfo();

		const user = await bot.userinfo();
		const name: string | undefined = user?.name ?? user?.userName;
		const rights: string[] = (user?.rights ?? []) as string[];
		const groups: string[] = (user?.groups ?? []) as string[];

		// 数字 name 是 BWiki 唯一可靠的登录信号。
		if (!name || /^\d{5,}$/.test(name) === false) {
			throw new NotLoggedInError(
				`wiki 未识别登录态 (name=${name ?? 'none'}, groups=${groups.join(',') || '*'})`,
			);
		}

		const canEdit =
			rights.includes('edit') ||
			groups.some((g) => ['user', 'bilibili', 'bot', 'sysop'].includes(g));

		return { name, canEdit, wikiCookie };
	}
}
