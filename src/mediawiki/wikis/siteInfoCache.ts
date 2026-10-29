import { monotonicNow } from '../runtime/clock.ts';

const TTL_SUCCESS_MS = 60 * 60 * 1000; // 1 hour
const TTL_FAILURE_MS = 60 * 1000; // 60 seconds

export type LicenseInfo = { url: string; title: string };

export type SiteInfo = {
	server: string;
	articlepath: string;
	/** The wiki's content language ($wgLanguageCode); absent when siteinfo omitted it. */
	lang?: string;
	license?: LicenseInfo;
	/**
	 * 站点视为内容的命名空间 ID（$wgContentNamespaces），升序。
	 * siteinfo 未报告时缺省。
	 */
	contentNamespaces?: readonly number[];
	/**
	 * 命名空间名与别名到 ID 的映射，键已按 MediaWiki 规则归一化
	 * （小写，空格作下划线）。用于把带前缀的标题还原成不含前缀的标题。
	 * siteinfo 未报告时缺省。
	 */
	namespaceNames?: Readonly<Record<string, number>>;
	/**
	 * Wikibase 查询服务的 SPARQL 端点，由 siteinfo 发布。
	 */
	sparqlEndpoint?: string;
};

export interface SiteInfoCache {
	/** The wiki's siteinfo as last stored, however old. */
	get(wikiKey: string): SiteInfo | undefined;
	/** False once the stored siteinfo is due for a refetch, or when none is stored. */
	isFresh(wikiKey: string): boolean;
	set(wikiKey: string, value: SiteInfo): void;
	/** Puts off the next refetch of the stored siteinfo by a minute, after one has failed. */
	deferRefetch(wikiKey: string): void;
	delete(wikiKey: string): void;
}

// 条目一小时后过期，使站点设置变更无需重启即可生效。
export class SiteInfoCacheImpl implements SiteInfoCache {
	private readonly cache = new Map<string, { value: SiteInfo; expiresAt: number }>();

	public constructor(private readonly now: () => number = monotonicNow) {}

	public get(wikiKey: string): SiteInfo | undefined {
		return this.cache.get(wikiKey)?.value;
	}

	public isFresh(wikiKey: string): boolean {
		const entry = this.cache.get(wikiKey);
		return entry !== undefined && entry.expiresAt > this.now();
	}

	public set(wikiKey: string, value: SiteInfo): void {
		this.cache.set(wikiKey, { value, expiresAt: this.now() + TTL_SUCCESS_MS });
	}

	public deferRefetch(wikiKey: string): void {
		const entry = this.cache.get(wikiKey);
		if (entry) {
			this.cache.set(wikiKey, { value: entry.value, expiresAt: this.now() + TTL_FAILURE_MS });
		}
	}

	public delete(wikiKey: string): void {
		this.cache.delete(wikiKey);
	}
}
