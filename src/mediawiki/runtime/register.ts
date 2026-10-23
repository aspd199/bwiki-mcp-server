import type {
	McpServer,
	RegisteredTool,
	ServerContext,
	ToolCallback,
	CallToolResult,
} from '@modelcontextprotocol/server';
import type { ZodRawShape, z } from 'zod';
import type { Tool } from './tool.ts';
import type { ToolContext } from './context.ts';
import { buildToolInputSchema } from './wikiArg.ts';
import { withRequestFields } from './requestContext.ts';

/**
 * 在请求作用域中执行 `fn`，使 `ctx.mwn()` 能取得该请求的取消信号。
 */
function withRequestScope<T>(ctx: ServerContext | undefined, fn: () => Promise<T>): Promise<T> {
	const signal = ctx?.mcpReq?.signal;
	return signal === undefined ? fn() : withRequestFields({ signal }, fn);
}

export function register<TSchema extends ZodRawShape, TCtx extends ToolContext>(
	server: McpServer,
	tool: Tool<TSchema, TCtx>,
	handler: (args: z.infer<z.ZodObject<TSchema>>) => Promise<CallToolResult>,
): RegisteredTool {
	return server.registerTool(
		tool.name,
		{
			description: tool.description,
			// 断言为 TSchema 以适配 SDK 的泛型边界；合并进来的 `wiki` 由处理器忽略。
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic boundary; the merged schema is a superset of TSchema
			inputSchema: buildToolInputSchema(tool) as z.ZodObject<TSchema>,
			annotations: tool.annotations,
		},
		// SDK 传签名 `(args, ctx)`，此处取出其取消信号放入请求作用域。
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic boundary; MCP SDK's ToolCallback can't be unified with our typed handler
		((args: z.infer<z.ZodObject<TSchema>>, ctx: ServerContext) =>
			withRequestScope(ctx, () => handler(args))) as unknown as ToolCallback<z.ZodObject<TSchema>>,
	);
}
