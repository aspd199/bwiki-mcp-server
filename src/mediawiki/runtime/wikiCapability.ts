import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.ts';
import type { ExtensionPack } from '../tools/extensions/types.ts';
import { extensionPacks } from '../tools/extensions/index.ts';
import { standardTools } from '../tools/standardTools.ts';
import { isWikiScoped } from './wikiArg.ts';
import { getRuntimeToken } from './requestContext.ts';
import { bearerPassthroughEnabled, hasStaticCredentials } from './authShape.ts';

// 会修改 wiki 的工具。
export const WRITE_TOOL_NAMES: readonly string[] = standardTools
	.filter(isWriteTool)
	.map((tool) => tool.name);

/** 依据工具自身的注解判断是否写操作。 */
export function isWriteTool(tool: {
	readonly annotations: { readonly readOnlyHint: boolean };
	readonly wikiScoped?: boolean;
}): boolean {
	return !tool.annotations.readOnlyHint && isWikiScoped(tool);
}

const WRITE_TOOL_SET: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

// 工具名 → 提供它的扩展包。
const PACK_BY_TOOL: ReadonlyMap<string, ExtensionPack> = ((): ReadonlyMap<
	string,
	ExtensionPack
> => {
	const map = new Map<string, ExtensionPack>();
	for (const pack of extensionPacks) {
		for (const tool of pack.tools) {
			map.set(tool.name, pack);
		}
	}
	return map;
})();

/** 校验工具能否作用于目标站点，不能则返回错误结果。 */
export async function checkWikiCapability(
	toolName: string,
	wikiKey: string,
	ctx: ToolContext,
): Promise<CallToolResult | undefined> {
	// HTTP 传输下，需要认证的站点若无 token 会以晦涩错误失败，故提前拒绝。
	if (ctx.transport === 'http') {
		const cfg = ctx.wikis.get(wikiKey);
		if (cfg) {
			const oauthOnly = typeof cfg.oauth2ClientId === 'string' && cfg.oauth2ClientId.trim() !== '';
			const hasStatic = hasStaticCredentials(cfg);
			const anonymous = getRuntimeToken() === undefined;
			if (oauthOnly && !hasStatic && anonymous) {
				// 两种情形，提示调用方可采取的动作。
				return ctx.format.error(
					'authentication',
					bearerPassthroughEnabled()
						? `Wiki "${wikiKey}" requires an authenticated user. Send an Authorization: Bearer ` +
								'token obtained from that wiki for this caller.'
						: `Wiki "${wikiKey}" requires an authenticated user, and this server has no way ` +
								'to obtain one: hosted OAuth sign-in is not configured. The operator needs to ' +
								'enable it (MCP_PUBLIC_URL and MCP_OAUTH_JWT_SIGNING_KEY).',
				);
			}
		}
	}
	const pack = PACK_BY_TOOL.get(toolName);
	if (pack) {
		const present = await ctx.wikiProbe.hasAnyExtension(wikiKey, pack.extensionNames);
		if (!present) {
			// hasAnyExtension 在扩展缺失与探测失败时都返回 false，
			// 用 inspect() 区分，避免把不可达站点报成「未安装」。
			const { reachable } = await ctx.wikiProbe.inspect(wikiKey);
			if (!reachable) {
				return ctx.format.invalidInput(
					`Wiki "${wikiKey}" could not be reached to check for the ${pack.extensionNames[0]} extension.`,
				);
			}
			return ctx.format.invalidInput(
				`The ${pack.extensionNames[0]} extension is not installed on wiki "${wikiKey}".`,
			);
		}
		const refusal = await wikiGateRefusal(pack, toolName, wikiKey, ctx);
		if (refusal !== undefined) {
			return ctx.format.invalidInput(refusal);
		}
	}
	if (WRITE_TOOL_SET.has(toolName)) {
		const config = ctx.wikis.get(wikiKey);
		if (config?.readOnly === true) {
			return ctx.format.permissionDenied(`Wiki "${wikiKey}" is configured read-only.`);
		}
	}
	return undefined;
}

/** 需要附加门槛的工具在目标站点不可运行的原因。 */
async function wikiGateRefusal(
	pack: ExtensionPack,
	toolName: string,
	wikiKey: string,
	ctx: ToolContext,
): Promise<string | undefined> {
	const gate = pack.wikiGate;
	if (gate === undefined || !gate.tools.includes(toolName)) {
		return undefined;
	}
	// 与上方扩展检查读取的是同一份 siteinfo 缓存。
	if (gate.isSatisfied(await ctx.wikiProbe.inspect(wikiKey))) {
		return undefined;
	}
	return gate.refusal(wikiKey);
}
