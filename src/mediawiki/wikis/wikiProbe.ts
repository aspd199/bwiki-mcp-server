import { makeApiRequest } from '../httpFetch.ts';
import type { WikiRegistry } from './wikiRegistry.ts';
import type { LicenseInfo } from './siteInfoCache.ts';
import { normalizeServer } from './normalizeServer.ts';
import { errorMessage } from '../errors/isErrnoException.ts';
import { logger } from '../runtime/logger.ts';
import { monotonicNow } from '../runtime/clock.ts';

const TTL_SUCCESS_MS = 60 * 60 * 1000; // 1 hour
const TTL_FAILURE_MS = 60 * 1000; // 60 seconds

// 限制 siteinfo 探测时长，避免不可达的 wiki 挂住 list-wikis 与启动期 reconcile。
const PROBE_TIMEOUT_MS = 5_000;

/** A wiki's public identity, read from siteinfo on a successful probe. */
export interface WikiIdentity {
	/** Public server base, normalized to https; absent if siteinfo omitted it. */
	server?: string;
	/** Article path with the `/$1` placeholder stripped; absent if omitted. */
	articlepath?: string;
	/** Content license from rightsinfo; absent unless both url and title exist. */
	license?: LicenseInfo;
	/** Wikibase 查询服务的 SPARQL 端点。 */
	sparqlEndpoint?: string;
}

/**
 * 匿名探测站点公开 siteinfo，成功缓存 1 小时、失败缓存 60 秒。
 */
export interface WikiProbe {
	hasExtension(wikiKey: string, extensionName: string): Promise<boolean>;
	/** 站点是否声明了给定扩展名中的任意一个。 */
	hasAnyExtension(wikiKey: string, extensionNames: readonly string[]): Promise<boolean>;
	/** 站点的能力快照。探测失败时 reachable 为 false。 */
	inspect(
		wikiKey: string,
	): Promise<{ reachable: boolean; extensions: ReadonlySet<string> } & WikiIdentity>;
	invalidate(wikiKey: string): void;
}

interface SiteInfoResponse {
	query?: {
		extensions?: { name?: string }[];
		general?: { server?: string; articlepath?: string; 'wikibase-sparql'?: string };
		rightsinfo?: { url?: string; text?: string };
	};
}

type CacheEntry =
	| ({ kind: 'success'; extensions: Set<string>; expiresAt: number } & WikiIdentity)
	| { kind: 'failed'; expiresAt: number };

export class WikiProbeImpl implements WikiProbe {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, Promise<CacheEntry>>();

	public constructor(
		private readonly wikis: WikiRegistry,
		private readonly now: () => number = monotonicNow,
	) {}

	public async hasExtension(wikiKey: string, extensionName: string): Promise<boolean> {
		const entry = await this.resolveEntry(wikiKey);
		if (entry.kind === 'failed') {
			return false;
		}
		return entry.extensions.has(extensionName);
	}

	public async hasAnyExtension(
		wikiKey: string,
		extensionNames: readonly string[],
	): Promise<boolean> {
		const entry = await this.resolveEntry(wikiKey);
		if (entry.kind === 'failed') {
			return false;
		}
		for (const name of extensionNames) {
			if (entry.extensions.has(name)) {
				return true;
			}
		}
		return false;
	}

	public async inspect(
		wikiKey: string,
	): Promise<{ reachable: boolean; extensions: ReadonlySet<string> } & WikiIdentity> {
		const entry = await this.resolveEntry(wikiKey);
		if (entry.kind === 'failed') {
			return { reachable: false, extensions: new Set() };
		}
		return {
			reachable: true,
			extensions: entry.extensions,
			...(entry.server !== undefined ? { server: entry.server } : {}),
			...(entry.articlepath !== undefined ? { articlepath: entry.articlepath } : {}),
			...(entry.license !== undefined ? { license: entry.license } : {}),
			...(entry.sparqlEndpoint !== undefined ? { sparqlEndpoint: entry.sparqlEndpoint } : {}),
		};
	}

	public invalidate(wikiKey: string): void {
		this.cache.delete(wikiKey);
	}

	private async resolveEntry(wikiKey: string): Promise<CacheEntry> {
		const cached = this.cache.get(wikiKey);
		if (cached && cached.expiresAt > this.now()) {
			return cached;
		}

		const inflight = this.inflight.get(wikiKey);
		if (inflight) {
			return inflight;
		}

		const probe = this.probe(wikiKey).finally(() => {
			this.inflight.delete(wikiKey);
		});
		this.inflight.set(wikiKey, probe);
		return probe;
	}

	// 从不抛出：失败记为 failed 缓存条目。
	private async probe(wikiKey: string): Promise<CacheEntry> {
		const config = this.wikis.get(wikiKey);
		if (!config) {
			const failed: CacheEntry = { kind: 'failed', expiresAt: this.now() + TTL_FAILURE_MS };
			this.cache.set(wikiKey, failed);
			return failed;
		}

		const apiUrl = `${config.server}${config.scriptpath}/api.php`;
		try {
			const data = await makeApiRequest<SiteInfoResponse>(
				apiUrl,
				{
					action: 'query',
					meta: 'siteinfo',
					siprop: 'extensions|general|rightsinfo',
					format: 'json',
				},
				{ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
			);
			// 扩展名列表决定工具可见性，格式错误视为硬失败；其余字段尽力而为。
			const list = data.query?.extensions;
			if (!Array.isArray(list)) {
				throw new Error('Malformed siteinfo extensions response');
			}
			const names = new Set<string>();
			for (const ext of list) {
				if (typeof ext.name === 'string' && ext.name !== '') {
					names.add(ext.name);
				}
			}

			const general = data.query?.general;
			const server =
				typeof general?.server === 'string' && general.server !== ''
					? normalizeServer(general.server)
					: undefined;
			const articlepath =
				typeof general?.articlepath === 'string'
					? general.articlepath.replace('/$1', '')
					: undefined;
			const sparqlEndpoint =
				typeof general?.['wikibase-sparql'] === 'string' && general['wikibase-sparql'] !== ''
					? general['wikibase-sparql']
					: undefined;
			const rights = data.query?.rightsinfo;
			const license: LicenseInfo | undefined =
				rights?.url && rights.text ? { url: rights.url, title: rights.text } : undefined;

			const entry: CacheEntry = {
				kind: 'success',
				extensions: names,
				expiresAt: this.now() + TTL_SUCCESS_MS,
				...(server !== undefined ? { server } : {}),
				...(articlepath !== undefined ? { articlepath } : {}),
				...(license !== undefined ? { license } : {}),
				...(sparqlEndpoint !== undefined ? { sparqlEndpoint } : {}),
			};
			this.cache.set(wikiKey, entry);
			return entry;
		} catch (error) {
			logger.warning('Wiki siteinfo probe failed', {
				wikiKey,
				error: errorMessage(error),
			});
			const failed: CacheEntry = { kind: 'failed', expiresAt: this.now() + TTL_FAILURE_MS };
			this.cache.set(wikiKey, failed);
			return failed;
		}
	}
}
