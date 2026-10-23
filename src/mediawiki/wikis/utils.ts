import type { ToolContext } from '../runtime/context.ts';
import { resolveSiteInfo } from './siteInfo.ts';

export async function buildPageUrl(ctx: ToolContext, title: string): Promise<string> {
	const { key } = ctx.activeWiki.get();
	const { server, articlepath } = await resolveSiteInfo(ctx, key);
	// MediaWiki 习惯：空格转为下划线。encodeURI 保留 '/' 与 ':'，
	// 并对空格与非 ASCII 字符编码。
	return `${server}${articlepath}/${encodeURI(title.replace(/ /g, '_'))}`;
}

/**
 * 写入应带的编辑摘要，为空时返回 `undefined`。
 * 摘要缺失与空串含义不同，MediaWiki 仅在参数缺失时写入自己的删除理由。
 */
export function formatEditComment(
	ctx: ToolContext,
	tool: string,
	comment?: string,
): string | undefined {
	const given = comment === '' ? undefined : comment;
	if (ctx.activeWiki.get().config.attributeEdits === false) {
		return given;
	}
	const suffix = `(via ${tool} on MediaWiki MCP Server)`;
	if (given === undefined) {
		return `Automated edit ${suffix}`;
	}
	return `${given} ${suffix}`;
}
