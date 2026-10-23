import type { ToolContext } from '../runtime/context.ts';
import type { SiteInfo, LicenseInfo, SiteInfoCache } from './siteInfoCache.ts';
import { normalizeServer } from './normalizeServer.ts';
import { withSharedWorkScope } from '../runtime/requestContext.ts';
import { callDeadline, WIKI_CONNECT_TIMEOUT_MS } from '../runtime/callDeadline.ts';

interface SiteInfoApiResponse {
	query?: {
		general?: {
			server?: string;
			articlepath?: string;
			lang?: string;
			'wikibase-sparql'?: string;
		};
		rightsinfo?: { url?: string; text?: string };
		namespaces?: Record<string, { id?: number; content?: boolean }>;
	};
}

// 同一 wiki 的并发未命中合并为一次请求。WeakMap 按缓存实例隔离。
const inflightByCache = new WeakMap<SiteInfoCache, Map<string, Promise<SiteInfo>>>();

async function fetchSiteInfo(ctx: ToolContext, wikiKey: string): Promise<SiteInfo> {
	// '' 仅用于未知 wikiKey，属防御性默认值。
	const config = ctx.wikis.get(wikiKey);
	const configured: SiteInfo = {
		server: config?.server ?? '',
		articlepath: config?.articlepath ?? '',
	};
	// 刷新失败时沿用上次结果，一分钟后重试。
	const fallBack = (): SiteInfo => {
		ctx.siteInfoCache.deferRefetch(wikiKey);
		return ctx.siteInfoCache.get(wikiKey) ?? configured;
	};

	try {
		const mwn = await ctx.mwn(wikiKey);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn.request returns ApiResponse; narrow to the siteinfo shape we requested
		const response = (await mwn.request({
			action: 'query',
			meta: 'siteinfo',
			siprop: 'general|rightsinfo|namespaces',
			formatversion: '2',
		})) as SiteInfoApiResponse;

		// 空 server 视为抓取失败，否则会生成相对链接。
		const general = response.query?.general;
		if (!general || typeof general.server !== 'string' || general.server === '') {
			return fallBack();
		}

		const rights = response.query?.rightsinfo;
		const license: LicenseInfo | undefined =
			rights?.url && rights.text ? { url: rights.url, title: rights.text } : undefined;

		const contentNamespaces = readContentNamespaces(response.query?.namespaces);

		const resolved: SiteInfo = {
			server: normalizeServer(general.server),
			articlepath:
				typeof general.articlepath === 'string'
					? general.articlepath.replace('/$1', '')
					: configured.articlepath,
			...(typeof general.lang === 'string' && general.lang !== '' ? { lang: general.lang } : {}),
			...(typeof general['wikibase-sparql'] === 'string' && general['wikibase-sparql'] !== ''
				? { sparqlEndpoint: general['wikibase-sparql'] }
				: {}),
			...(license ? { license } : {}),
			...(contentNamespaces.length > 0 ? { contentNamespaces } : {}),
		};
		ctx.siteInfoCache.set(wikiKey, resolved);
		return resolved;
	} catch {
		return fallBack();
	}
}

// 从 meta=siteinfo 解析站点地址与许可协议，按 wiki 缓存一小时。不抛异常，
// 首次失败时回落到配置值且不缓存，
// 短暂不可达的站点会在下次调用时重试。
export async function resolveSiteInfo(ctx: ToolContext, wikiKey: string): Promise<SiteInfo> {
	const cached = ctx.siteInfoCache.get(wikiKey);
	if (cached && ctx.siteInfoCache.isFresh(wikiKey)) {
		return cached;
	}

	let inflight = inflightByCache.get(ctx.siteInfoCache);
	if (!inflight) {
		inflight = new Map();
		inflightByCache.set(ctx.siteInfoCache, inflight);
	}
	const existing = inflight.get(wikiKey);
	if (existing) {
		return existing;
	}

	// 交付给所有并发调用方，故脱离触发者在独立预算下运行；
	// 放弃的调用方留下的请求仍会填充缓存。
	const promise = withSharedWorkScope(callDeadline(WIKI_CONNECT_TIMEOUT_MS, 'connecting'), () =>
		fetchSiteInfo(ctx, wikiKey),
	).finally(() => {
		inflight.delete(wikiKey);
	});
	inflight.set(wikiKey, promise);
	return promise;
}

// MediaWiki 总把主命名空间计为内容，故结果为空说明站点未报告命名空间表。
// 负号命名空间（Media、Special）被丢弃，因搜索 API 拒绝它们。
function readContentNamespaces(
	namespaces: Record<string, { id?: number; content?: boolean }> | undefined,
): number[] {
	if (!namespaces) {
		return [];
	}

	const ids = new Set<number>();
	for (const entry of Object.values(namespaces)) {
		if (entry.content === true && typeof entry.id === 'number' && entry.id >= 0) {
			ids.add(entry.id);
		}
	}
	return [...ids].sort((a, b) => a - b);
}
