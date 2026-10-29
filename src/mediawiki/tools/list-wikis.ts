import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { discoverFarmWikis, type FarmWiki } from '../bwiki/farm.ts';
import { wikiCookiePartsFor, readSessionFile } from '../bwiki/cookie.ts';
import { DEFAULT_SESSION_FILE, loadConfigFromFile } from '../config/loadConfig.ts';

/**
 * 列出 BWiki 农场的站点。
 *
 * 名册来自农场自身的 `<bwikilist />` 标签，一次请求取回全部站点；
 * 其余字段均由名册与本地配置对照得出，不探测任何站点。
 */

const inputSchema = {
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe(
			'How many wikis to return, newest first. Defaults to 50. The full roster is about a thousand entries, so raise this only when the whole list is genuinely needed.',
		),
	query: z
		.string()
		.optional()
		.describe(
			'Only return wikis whose name or key contains this text, matched case-insensitively (for example "demo" matches a key "Demo").',
		),
	configuredOnly: z
		.boolean()
		.optional()
		.describe(
			'Only return wikis this server is configured for (the ones a tool call can target). Defaults to false, which returns the whole farm roster.',
		),
} as const;

type ListWikisArgs = z.infer<z.ZodObject<typeof inputSchema>>;

const DEFAULT_LIMIT = 50;

interface WikiSummary {
	key: string;
	sitename: string;
	server: string;
	readOnly: boolean;
	isDefault: boolean;
	configured: boolean;
	/** 是否出现在农场名册中。为 false 而 configured 为 true 表示代号有误或站点已关停。 */
	inRoster: boolean;
	/** 申请人，仅农场站点有。 */
	applicant?: string;
	createdAt?: string;
}

interface ListWikisResult {
	wikis: WikiSummary[];
	total: number;
	returned: number;
	truncated: boolean;
}

export const listWikis: Tool<typeof inputSchema> = {
	name: 'list-wikis',
	description:
		"Lists the wikis of the BWiki farm: each one's key (pass as the `wiki` argument to other tools), display name, base URL, registrant, creation date, and whether this server is already configured for it. The roster comes from the farm itself, so it includes wikis this server cannot act on yet — only a configured wiki accepts a tool call. Results are paginated (default 50) because the farm has about a thousand wikis; use `query` to find one by name or key, or `configuredOnly` to see just the usable ones.",
	inputSchema,
	annotations: {
		title: 'List wikis',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	wikiScoped: false,
	failureVerb: 'list wikis',

	async handle(args: ListWikisArgs, ctx: ToolContext): Promise<CallToolResult> {
		const defaultKey = ctx.activeWiki.getDefaultKey();
		const all = ctx.wikis.getAll();

		// 经一个已配置的 wiki 取回名册。名册公开，无会话时匿名取。
		const { key: sourceKey, config: source } = ctx.activeWiki.get();
		const apiUrl = `${source.server}${source.scriptpath}/api.php`;
		const roster = await discoverFarmWikis(apiUrl, await storedCookieFor(sourceKey));

		// 名册未收录但已配置的站点也要列出，它们才实际可用。
		const rosterKeys = new Set(roster.map((w) => w.key));
		const configuredOnly: FarmWiki[] = Object.entries(all)
			.filter(([key]) => !rosterKeys.has(key))
			.map(([key, config]) => ({
				key,
				sitename: config.sitename,
				server: config.server,
				configured: true,
			}));

		const everything = [...roster, ...configuredOnly];

		const query = args.query?.trim().toLowerCase();
		const matched = query
			? everything.filter((w) => w.key.toLowerCase().includes(query) || w.sitename.toLowerCase().includes(query))
			: everything;
		const filtered = args.configuredOnly === true ? matched.filter((w) => w.configured) : matched;

		// 新加入的在前。
		const ordered = [...filtered].reverse();
		const limit = args.limit ?? DEFAULT_LIMIT;
		const page = ordered.slice(0, limit);

		// 不探测站点：列表只由名册与本地配置对照得出，一次请求即全部信息。
		const wikis: WikiSummary[] = page.map((wiki): WikiSummary => {
			const config = all[wiki.key];
			const configured = config !== undefined;
			return {
				key: wiki.key,
				sitename: wiki.sitename,
				server: wiki.server,
				readOnly: config?.readOnly === true,
				isDefault: wiki.key === defaultKey,
				configured,
				inRoster: rosterKeys.has(wiki.key),
				...(wiki.applicant !== undefined ? { applicant: wiki.applicant } : {}),
				...(wiki.createdAt !== undefined ? { createdAt: wiki.createdAt } : {}),
			};
		});

		const payload: ListWikisResult = {
			wikis,
			total: filtered.length,
			returned: wikis.length,
			truncated: filtered.length > wikis.length,
		};
		return ctx.format.ok(payload);
	},
};

/**
 * 已存会话的 Cookie 头值，无会话时返回空串。
 *
 * 名册是公开内容，匿名可取；带凭证只为读同一份数据，不影响结果。
 */
async function storedCookieFor(wikiKey: string): Promise<string> {
	const config = loadConfigFromFile();
	const file = config.wikis[wikiKey]?.passportSessionFile || DEFAULT_SESSION_FILE;
	const session = await readSessionFile(file);
	if (!session) {
		return '';
	}
	return wikiCookiePartsFor(session).join('; ');
}
