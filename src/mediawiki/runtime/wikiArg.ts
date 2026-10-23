import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { WIKI_RESOURCE_URI_PREFIX } from './constants.ts';
import { decodeWikiKey } from './wikiKey.ts';

export const WIKI_ARG_DESCRIPTION =
	'要操作的站点代号（如 config.json 里 wikis 列表中的某一项），也可写成完整的 mcp://wikis/{代号} URI。省略时使用配置中第一个站点。';

export const wikiArgSchema = z.string().optional().describe(WIKI_ARG_DESCRIPTION);

// 接受裸 key 或完整的 mcp://wikis/{key} URI，URI 形式需解码。
export function normalizeWikiArg(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith(WIKI_RESOURCE_URI_PREFIX)) {
		return trimmed;
	}
	const segment = trimmed.slice(WIKI_RESOURCE_URI_PREFIX.length).trim();
	return decodeWikiKey(segment) ?? segment;
}

export function isWikiScoped(tool: { wikiScoped?: boolean }): boolean {
	return tool.wikiScoped !== false;
}

// 返回注册用的 schema：wiki 相关工具会合并 `wiki` 字段。
// 仅需描述符的 `inputSchema`/`wikiScoped` 切片，故收窄参数类型。
//
// 描述符声明的是原始 shape，而 registerTool 需要 Standard Schema，
// 故在此统一包一层 z.object()。
export function buildToolInputSchema(tool: {
	readonly inputSchema: ZodRawShape;
	readonly wikiScoped?: boolean;
}): z.ZodObject<ZodRawShape> {
	if (!isWikiScoped(tool)) {
		return z.object(tool.inputSchema);
	}
	return z.object({ ...tool.inputSchema, wiki: wikiArgSchema });
}
