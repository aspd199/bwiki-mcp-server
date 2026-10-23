/**
 * 读取 BWiki 农场的站点名册。
 *
 * 农场内所有 wiki 共用 wiki.biligame.com，按路径第一段区分。名册由
 * `<bwikilist />` 标签渲染为表格，每行四个单元格：名称、域名、申请人、创建时间。
 * 站点代号取自域名链接的路径段，统一以 https 报告。
 */

import { FARM_HOST, loadConfigFromFile } from '../config/loadConfig.ts';
import { USER_AGENT } from '../runtime/constants.ts';

export interface FarmWiki {
	/** 站点代号，即 URL 的路径段。 */
	key: string;
	/** 名册中的显示名称。 */
	sitename: string;
	/** 含代号的完整地址。 */
	server: string;
	/** 申请人。 */
	applicant?: string;
	/** 创建时间。 */
	createdAt?: string;
	/** 是否出现在配置中。 */
	configured: boolean;
}

/** 名册表格的一行。 */
interface RosterRow {
	name: string;
	code: string;
	applicant: string;
	createdAt: string;
}

/** 渲染名册的标签。 */
const BWIKILIST_TAG = '<bwikilist />';

/**
 * 经某个 wiki 的 parser 取回名册 HTML。
 *
 * cookie 可为空：名册是公开内容，匿名可取。
 */
export async function fetchFarmRoster(apiUrl: string, cookie: string): Promise<string> {
	const headers: Record<string, string> = {
		'User-Agent': USER_AGENT,
		'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
	};
	if (cookie !== '') {
		headers.Cookie = cookie;
	}
	const resp = await fetch(apiUrl, {
		method: 'POST',
		headers,
		body: new URLSearchParams({
			action: 'parse',
			text: BWIKILIST_TAG,
			contentmodel: 'wikitext',
			format: 'json',
		}).toString(),
	});
	if (!resp.ok) {
		throw new Error(`bwikilist 请求失败: HTTP ${resp.status}`);
	}
	const data: unknown = await resp.json();
	const html = parseTextOf(data);
	if (html === null) {
		throw new Error('bwikilist 响应中没有 parse.text');
	}
	return html;
}

/**
 * 将名册 HTML 解析为行。
 *
 * 单元格数量必须为 4，否则跳过该行。
 */
export function parseRoster(html: string): RosterRow[] {
	const rows: RosterRow[] = [];
	for (const match of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
		const body = match[1];
		// 表头用 <th>，数据行用 <td>。
		if (/<th[\s>]/i.test(body)) continue;
		const rawCells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
		if (rawCells.length !== 4) continue;
		const [rawName = '', rawDomain = '', rawApplicant = '', rawCreatedAt = ''] = rawCells;
		// 先读域名单元格再剥离标签，代号在 href 里。
		const code = wikiCodeFromDomain(rawDomain);
		if (!code) continue;
		rows.push({
			name: stripTags(rawName),
			code,
			applicant: stripTags(rawApplicant),
			createdAt: stripTags(rawCreatedAt),
		});
	}
	return rows;
}

/**
 * 从域名单元格取出站点代号（href 的首个路径段）。
 * 同时校验 host，跳过非农场域名。
 */

function wikiCodeFromDomain(cell: string): string {
	const href = cell.match(/href="([^"]+)"/i)?.[1];
	if (!href) return '';
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		// 相对 href 仅在以 / 开头时采用。
		const path = href.startsWith('/') ? href : '';
		const code = path.split('/').filter(Boolean)[0] ?? '';
		return /^[a-z0-9-]+$/.test(code) ? code : '';
	}
	if (url.hostname !== FARM_HOST) return '';
	const code = url.pathname.split('/').filter(Boolean)[0] ?? '';
	return /^[a-z0-9-]+$/.test(code) ? code : '';
}

/** Text of a parse response's `text` field, which is either a string or {"*": …}. */
function parseTextOf(data: unknown): string | null {
	if (typeof data !== 'object' || data === null) return null;
	const parse = (data as { parse?: unknown }).parse;
	if (typeof parse !== 'object' || parse === null) return null;
	const text = (parse as { text?: unknown }).text;
	if (typeof text === 'string') return text;
	if (typeof text === 'object' && text !== null) {
		const star = (text as { '*': unknown })['*'];
		if (typeof star === 'string') return star;
	}
	return null;
}

/** HTML to plain text: drop tags, decode the few entities the roster uses. */
function stripTags(html: string): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, ' ')
		.trim();
}

/** 名册全部站点，并标注哪些已在配置中。匿名可取，凭证不影响结果。 */
export async function discoverFarmWikis(apiUrl: string, cookie: string): Promise<FarmWiki[]> {
	const html = await fetchFarmRoster(apiUrl, cookie);
	const rows = parseRoster(html);
	const config = loadConfigFromFile();
	const configuredKeys = new Set(Object.keys(config.wikis));

	const seen = new Set<string>();
	const wikis: FarmWiki[] = [];
	for (const row of rows) {
		if (seen.has(row.code)) continue;
		seen.add(row.code);
		wikis.push({
			key: row.code,
			sitename: row.name,
			server: `https://wiki.biligame.com/${row.code}`,
			configured: configuredKeys.has(row.code),
			...(row.applicant ? { applicant: row.applicant } : {}),
			...(row.createdAt ? { createdAt: row.createdAt } : {}),
		});
	}
	return wikis;
}
