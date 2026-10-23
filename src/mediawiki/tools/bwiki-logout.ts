import { z } from 'zod';
import { rm } from 'node:fs/promises';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { DEFAULT_SESSION_FILE, loadConfigFromFile } from '../config/loadConfig.ts';

/**
 * 登出 BWiki：删除已保存的会话文件，不结束当前连接。
 */
const inputSchema = {} as const;

type LogoutArgs = z.infer<z.ZodObject<typeof inputSchema>>;

interface LogoutResult {
	message: string;
	removed: string[];
}

export const bwikiLogout: Tool<typeof inputSchema> = {
	name: 'bwiki-logout',
	description:
		'Deletes the stored bilibili session from disk, so subsequent tool calls have no credential. Use when finishing with BWiki or switching accounts; run bwiki-login to sign in again. Does not close the connection.',
	inputSchema,
	annotations: {
		title: 'Log out of BWiki',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	wikiScoped: false,
	failureVerb: 'log out',

	async handle(_args: LogoutArgs, ctx: ToolContext): Promise<CallToolResult> {
		const config = loadConfigFromFile();
		const files = new Set<string>([DEFAULT_SESSION_FILE]);
		for (const wiki of Object.values(config.wikis)) {
			if (wiki.passportSessionFile) {
				files.add(wiki.passportSessionFile);
			}
		}

		const removed: string[] = [];
		for (const file of files) {
			try {
				await rm(file, { force: true });
				removed.push(file);
			} catch {
				// 删除失败的文件不出现在 `removed` 中，而非报错：
				// 单个文件被占用不应阻止其余文件删除。
				ctx.logger.warning(`bwiki-logout: could not remove ${file}`);
			}
		}
		// 复位登录态，使后续调用重新走登录门而非继续用旧凭证。
		await ctx.loginGate.forget();
		ctx.logger.info('bwiki-logout: session removed');

		const payload: LogoutResult = {
			message: '已登出',
			removed,
		};
		return ctx.format.ok(payload);
	},
};
