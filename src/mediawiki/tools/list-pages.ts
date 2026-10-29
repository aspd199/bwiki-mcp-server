import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import type { TruncationInfo } from '../results/truncation.ts';
import { resolveSiteInfo } from '../wikis/siteInfo.ts';

enum PageFilter {
	all = 'all',
	redirects = 'redirects',
	nonredirects = 'nonredirects',
}

enum ListDirection {
	ascending = 'ascending',
	descending = 'descending',
}

interface AllPagesEntry {
	pageid: number;
	ns: number;
	title: string;
}

/**
 * apfrom/apto 与 page_title 比较，而 page_title 不含命名空间前缀。
 * 实测传「模块:CSS」这类带前缀的标题不会报错，只会返回错位的结果，
 * 故先按站点命名空间表剥离前缀；前缀指向别的命名空间时直接拒绝。
 */
function boundaryKey(
	names: Readonly<Record<string, number>> | undefined,
	value: string,
	namespace: number,
	field: 'from' | 'to',
): { key: string } | { error: string } {
	const colon = value.indexOf(':');
	if (colon <= 0 || names === undefined) {
		return { key: value };
	}
	const prefix = value.slice(0, colon).toLowerCase().replace(/ /g, '_');
	const resolved = names[prefix];
	if (resolved === undefined) {
		return { key: value };
	}
	if (resolved !== namespace) {
		return {
			error: `${field} "${value}" names a page in namespace ${resolved}, but namespace is ${namespace}. Both bounds must name titles in the namespace being listed.`,
		};
	}
	return { key: value.slice(colon + 1) };
}

const inputSchema = {
	namespace: z
		.number()
		.int()
		.nonnegative()
		.default(0)
		.describe(
			'Namespace ID to enumerate (0 is the main namespace). get-site-info lists a wiki\'s namespace IDs and their localized names.',
		),
	from: z
		.string()
		.optional()
		.describe(
			'Title to start listing at, included in the results. Either the page title as displayed ("Module:CSS") or without the namespace prefix ("CSS"); the prefix is stripped before the request.',
		),
	to: z
		.string()
		.optional()
		.describe(
			'Title to stop listing at, also included in the results. Takes the same forms as from. With direction=descending it is the lower bound instead.',
		),
	direction: z
		.nativeEnum(ListDirection)
		.default(ListDirection.ascending)
		.describe('Order in which titles are listed; descending starts at from and walks backwards'),
	filter: z
		.nativeEnum(PageFilter)
		.default(PageFilter.all)
		.describe('Restrict the listing to redirects, to non-redirects, or to all pages'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe('Maximum pages to return (1..500, default 500)'),
	continueFrom: z
		.string()
		.optional()
		.describe('Opaque continuation token from the previous response; omit on first call'),
} as const;

export const listPages: Tool<typeof inputSchema> = {
	name: 'list-pages',
	description:
		"Enumerates every page of a namespace in title order, returning each page's title, page ID, and namespace ID. Use it to survey a whole namespace (for example every module or every template), which search-page and search-page-by-prefix cannot do: those need query terms or a title prefix, and search-page omits pages its full-text index does not cover. namespace takes a namespace ID (0 is the main namespace); get-site-info reports the IDs and their localized names. from and to bound the title range, both ends included; either may be given as the page title with its namespace prefix (as displayed) or without it, and a prefix naming a different namespace is refused rather than silently misread. direction reverses the walk, and filter restricts it to redirects or non-redirects. Returns up to 500 titles per call; paginate with continueFrom (opaque cursor echoed from the previous response), which keeps the same namespace, range, direction, and filter. Only titles, IDs, and namespace IDs are returned - no sizes or timestamps; for page content, use get-page.",
	inputSchema,
	annotations: {
		title: 'List pages',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'list pages',
	target: (a) => (a.from !== undefined ? a.from : `namespace ${a.namespace}`),

	async handle(
		{ namespace, from, to, direction, filter, limit, continueFrom },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();

		// 仅当边界带冒号时才需要命名空间表，避免无谓的一次 siteinfo 请求。
		const needsNames =
			(from !== undefined && from.includes(':')) || (to !== undefined && to.includes(':'));
		const names = needsNames
			? (await resolveSiteInfo(ctx, ctx.activeWiki.get().key)).namespaceNames
			: undefined;

		const fromKey =
			from !== undefined && from !== ''
				? boundaryKey(names, from, namespace, 'from')
				: undefined;
		if (fromKey !== undefined && 'error' in fromKey) {
			return ctx.format.invalidInput(fromKey.error);
		}
		const toKey =
			to !== undefined && to !== ''
				? boundaryKey(names, to, namespace, 'to')
				: undefined;
		if (toKey !== undefined && 'error' in toKey) {
			return ctx.format.invalidInput(toKey.error);
		}

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			list: 'allpages',
			apnamespace: namespace,
			apdir: direction,
			formatversion: '2',
		};
		if (fromKey !== undefined) {
			params.apfrom = fromKey.key;
		}
		if (toKey !== undefined) {
			params.apto = toKey.key;
		}
		if (filter !== PageFilter.all) {
			params.apfilterredir = filter;
		}
		params.aplimit = limit ?? 500;
		if (continueFrom) {
			params.apcontinue = continueFrom;
		}

		const response = await mwn.request(params);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const pages: AllPagesEntry[] = (response.query?.allpages ?? []) as AllPagesEntry[];

		const nextCursor: string | undefined = response.continue?.apcontinue;
		const truncation: TruncationInfo | null = nextCursor
			? {
					reason: 'more-available',
					returnedCount: pages.length,
					itemNoun: 'pages',
					toolName: 'list-pages',
					continueWith: { param: 'continueFrom', value: nextCursor },
				}
			: null;

		return ctx.format.ok({
			pages: pages.map((p) => ({
				title: p.title,
				pageId: p.pageid,
				namespace: p.ns,
			})),
			...(truncation !== null ? { truncation } : {}),
		});
	},
};
