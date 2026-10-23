import { ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer, Resource } from '@modelcontextprotocol/server';
import type { ToolContext } from '../runtime/context.ts';
import type { WikiConfig, PublicWikiConfig } from '../config/loadConfig.ts';
import { WIKI_RESOURCE_URI_PREFIX } from '../runtime/constants.ts';
import { resolveSiteInfo } from '../wikis/siteInfo.ts';
import { decodeWikiKey, encodeWikiKey } from '../runtime/wikiKey.ts';

// 按字段名构造对外视图，新增 WikiConfig 字段默认不公开。
// 凭证与运维设置（OAuth、tags、attributeEdits 等）均不包含在内。
function toPublicConfig(wikiConfig: Readonly<WikiConfig>): PublicWikiConfig {
	return {
		sitename: wikiConfig.sitename,
		server: wikiConfig.server,
		articlepath: wikiConfig.articlepath,
		scriptpath: wikiConfig.scriptpath,
		private: wikiConfig.private,
		readOnly: wikiConfig.readOnly,
	};
}

export function registerAllResources(server: McpServer, ctx: ToolContext): void {
	const resourceTemplate = new ResourceTemplate(`${WIKI_RESOURCE_URI_PREFIX}{wikiKey}`, {
		list: () => {
			const allWikis = ctx.wikis.getAll();
			const resources: Resource[] = [];
			for (const wikiKey in allWikis) {
				const wikiConfig = allWikis[wikiKey];
				resources.push({
					uri: `${WIKI_RESOURCE_URI_PREFIX}${encodeWikiKey(wikiKey)}`,
					name: `wikis/${wikiKey}`,
					// 只读缓存：列出资源时不为每个站点发起 siteinfo 请求，
					// 故描述中显示配置的地址，待首次读取后才换成权威值。
					description: `Wiki "${wikiConfig.sitename}" hosted at ${ctx.siteInfoCache.get(wikiKey)?.server ?? wikiConfig.server}`,
				});
			}
			return { resources };
		},
	});

	server.registerResource('wikis', resourceTemplate, {}, async (uri, variables) => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP ResourceTemplate variables typed as string|string[]; URI template guarantees a single string
		const matched = variables.wikiKey as string;
		// SDK 匹配 URI 模板时不进行百分号解码。
		const wikiKey = decodeWikiKey(matched);

		if (wikiKey === undefined) {
			throw new ResourceNotFoundError(uri.toString());
		}

		const wikiConfig = ctx.wikis.get(wikiKey);

		if (!wikiConfig) {
			throw new ResourceNotFoundError(uri.toString());
		}

		const result: Record<string, unknown> = { ...toPublicConfig(wikiConfig) };

		const siteInfo = await resolveSiteInfo(ctx, wikiKey);
		result.server = siteInfo.server;
		result.articlepath = siteInfo.articlepath;
		if (siteInfo.license) {
			result.license = siteInfo.license;
		}

		return {
			contents: [
				{
					uri: uri.toString(),
					text: JSON.stringify(result, null, 2),
					mimeType: 'application/json',
				},
			],
		};
	});
}
