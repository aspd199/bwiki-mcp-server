import type { MwnProvider } from './mwnProvider.ts';
import type { SiteInfoCache } from './siteInfoCache.ts';
import type { WikiProbe } from './wikiProbe.ts';

/**
 * 使站点相关的缓存失效，供移除站点时使用。
 */
export interface WikiCache {
	/** Drops every cache entry keyed by `wikiKey`. */
	invalidate(wikiKey: string): void;
}

export class WikiCacheImpl implements WikiCache {
	public constructor(
		private readonly mwnProvider: Pick<MwnProvider, 'invalidate'>,
		private readonly siteInfoCache: Pick<SiteInfoCache, 'delete'>,
		private readonly wikiProbe: Pick<WikiProbe, 'invalidate'>,
	) {}

	public invalidate(wikiKey: string): void {
		this.mwnProvider.invalidate(wikiKey);
		this.siteInfoCache.delete(wikiKey);
		this.wikiProbe.invalidate(wikiKey);
	}
}
