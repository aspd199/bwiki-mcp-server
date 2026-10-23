/**
 * 命令行登录。不经 MCP，供打包产物直接调用。
 *
 * 只取 bilibili 凭证并落盘，不向 wiki 发任何请求：wiki 账号与 bilibili
 * 绑定，凭证有效即可用；时效性由 MCP 启动时的 sessionGate 校验。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_SESSION_FILE } from '../config/loadConfig.ts';
import { loginViaOfficialPage } from './passportLogin.ts';

/** 写入会话文件。 */
async function writeSession(cookie: string, userId: string, file: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(
		file,
		JSON.stringify(
			{
				passportCookie: cookie,
				// 留空：api.php 直接接受 passport cookie，无需先换 wiki 会话。
				wikiCookie: '',
				userId,
				savedAt: Date.now(),
			},
			null,
			2,
		),
		'utf8',
	);
}

export async function runLogin(argv: readonly string[]): Promise<number> {
	const file = argv[0] || DEFAULT_SESSION_FILE;

	console.log('正在打开 bilibili 登录页，请在浏览器中完成登录…');

	let result;
	try {
		result = await loginViaOfficialPage();
	} catch (err) {
		console.error(`登录失败：${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	if (!result.userId) {
		console.error('未取到 bilibili 用户 ID，会话未保存。请重试。');
		return 1;
	}

	try {
		await writeSession(result.cookie, result.userId, file);
	} catch (err) {
		console.error(`写入会话文件失败：${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	console.log(`登录成功，用户 ID：${result.userId}`);
	console.log(`会话已保存到：${file}`);
	return 0;
}

export async function runLogout(argv: readonly string[]): Promise<number> {
	const file = argv[0] || DEFAULT_SESSION_FILE;
	const { rm } = await import('node:fs/promises');
	try {
		await rm(file, { force: true });
	} catch (err) {
		console.error(`删除会话文件失败：${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	console.log(`已登出，会话文件已删除：${file}`);
	return 0;
}
