import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { Identity } from '../bwiki/identity.ts';
import { loginViaOfficialPage } from '../bwiki/passportLogin.ts';
import { DEFAULT_SESSION_FILE, loadConfigFromFile } from '../config/loadConfig.ts';

/**
 * 以 bilibili 账号登录 BWiki。
 *
 * 唯一无需会话即可运行的工具。打开官方登录页，由用户自行完成登录，
 * 再通过 DevTools 协议取出 HttpOnly 的 SESSDATA。
 */

const inputSchema = {} as const;

type LoginArgs = z.infer<z.ZodObject<typeof inputSchema>>;

interface LoginResult {
	state: string;
	userId: string;
	canEdit: boolean;
	sessionFile: string;
	message: string;
}

export const bwikiLogin: Tool<typeof inputSchema> = {
	name: 'bwiki-login',
	description:
		'Opens the official bilibili passport login page in a local browser (Edge or Chrome already installed on this machine) and waits for the login to complete. Any bilibili login method works: QR scan, password, SMS, WeChat, Weibo or QQ. Once the wiki recognizes the session it is saved to disk, so later tool calls run as this user without logging in again. The window stays open until login finishes or 180 seconds elapse. The only tool that works before a session exists.',
	inputSchema,
	annotations: {
		title: 'Log in to BWiki',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	// 非 wiki 相关：会话建立前没有目标站点。
	wikiScoped: false,
	failureVerb: 'log in',

	async handle(_args: LoginArgs, ctx: ToolContext): Promise<CallToolResult> {
		const config = loadConfigFromFile();
		const wiki = config.wikis[config.defaultWiki];
		if (!wiki) {
			throw new Error(
				`Config error: the default wiki "${config.defaultWiki}" is not present in config.json`,
			);
		}
		const apiUrl = `${wiki.server}${wiki.scriptpath}/api.php`;

		// 先确认浏览器存在，避免页面打不开而挂住。
		const result = await loginViaOfficialPage();

		// 先换取 wiki 会话 cookie 再保存，此时才能确认身份。
		const identity = new Identity(apiUrl);
		const established = await identity.establish(result.cookie);

		const sessionFile = wiki.passportSessionFile || DEFAULT_SESSION_FILE;
		await mkdir(dirname(sessionFile), { recursive: true });
		await writeFile(
			sessionFile,
			JSON.stringify(
				{
					passportCookie: result.cookie,
					wikiCookie: established.wikiCookie,
					userId: established.name,
					savedAt: Date.now(),
				},
				null,
				2,
			),
			'utf8',
		);
		ctx.logger.info(`bwiki-login: logged in as ${established.name}, session written to ${sessionFile}`);

		const payload: LoginResult = {
			state: 'confirmed',
			userId: established.name,
			canEdit: established.canEdit,
			sessionFile,
			message: `登录成功，身份：${established.name}`,
		};
		return ctx.format.ok(payload);
	},
};
