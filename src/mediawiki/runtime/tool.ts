import type { ZodRawShape, z } from 'zod';
import type { ToolAnnotations, CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.ts';

export interface Tool<TSchema extends ZodRawShape, TCtx extends ToolContext = ToolContext> {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: TSchema;
	/**
	 * 必填，用于判定该工具是否为写操作。
	 */
	readonly annotations: ToolAnnotations & { readonly readOnlyHint: boolean };
	/**
	 * 错误消息中 "Failed to <verb>" 的动词，缺省用 `name`。
	 */
	readonly failureVerb?: string;
	/**
	 * 从入参中提取用于 `tool_call` 遥测的 target 字段。
	 */
	readonly target?: (args: z.infer<z.ZodObject<TSchema>>) => string;
	/**
	 * 该工具是否作用于 wiki，决定是否接受 `wiki` 参数。默认为 `true`。
	 */
	readonly wikiScoped?: boolean;
	readonly handle: (args: z.infer<z.ZodObject<TSchema>>, ctx: TCtx) => Promise<CallToolResult>;
}
