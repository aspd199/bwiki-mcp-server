import type { WikiConfig } from '../config/loadConfig.ts';
import type { WikiRegistry } from './wikiRegistry.ts';
import { getRequestWiki } from '../runtime/requestContext.ts';

export interface ActiveWiki {
	// 本次调用的站点：请求上下文中的站点，否则用默认。
	get(): { key: string; config: Readonly<WikiConfig> };
	// 配置的默认站点 key。
	getDefaultKey(): string;
}

export class ActiveWikiImpl implements ActiveWiki {
	public constructor(
		private readonly defaultKey: string,
		private readonly registry: WikiRegistry,
	) {}

	public get(): { key: string; config: Readonly<WikiConfig> } {
		const key = getRequestWiki() ?? this.defaultKey;
		const config = this.registry.get(key);
		if (!config) {
			throw new Error(`Wiki "${key}" not found in registry`);
		}
		return { key, config };
	}

	public getDefaultKey(): string {
		return this.defaultKey;
	}
}
