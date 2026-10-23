#!/usr/bin/env node

/**
 * 进程入口。仅支持 stdio 传输。
 *
 * 子命令：
 *   login [会话文件路径]   命令行登录，不经 MCP
 *   logout [会话文件路径]  删除会话文件
 * 无子命令时启动 MCP stdio 服务，此时才读取配置。
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { logger } from './runtime/logger.ts';
import { createServer } from './server.ts';
import { emitStartupBanner } from './runtime/banner.ts';
import { createToolContext } from './runtime/createContext.ts';
import { registerShutdownHandlers } from './runtime/shutdown.ts';
import { loadConfigFromFile } from './config/loadConfig.ts';
import { createAppState } from './wikis/state.ts';
import { readStoredSessionIfValid } from './bwiki/sessionGate.ts';
import { sessionLiveness } from './bwiki/liveness.ts';
import { runLogin, runLogout } from './bwiki/cliLogin.ts';

/** 子命令入口。返回 true 表示已处理，进程应以其返回码退出。 */
async function runSubcommand(argv: readonly string[]): Promise<number | null> {
	const command = argv[0];
	if (command === 'login') return runLogin(argv.slice(1));
	if (command === 'logout') return runLogout(argv.slice(1));
	if (command === '--help' || command === '-h') {
		console.log(
			[
				'用法：',
				'  <程序>            启动 MCP stdio 服务（需先有会话）',
				'  <程序> login     打开 bilibili 登录页并保存会话',
				'  <程序> logout    删除已保存的会话',
				'',
				'login 与 logout 可选的第一个参数为会话文件路径，默认取平台默认位置。',
			].join('\n'),
		);
		return 0;
	}
	if (command !== undefined && !command.startsWith('-')) {
		console.error(`未知命令：${command}。可用命令：login、logout。`);
		return 1;
	}
	return null;
}

async function main(): Promise<void> {
	const exitCode = await runSubcommand(process.argv.slice(2));
	if (exitCode !== null) {
		process.exit(exitCode);
	}

	// 先查配置：无站点可服务的错误不应报成登录问题。
	const config = loadConfigFromFile();
	if (Object.keys(config.wikis).length === 0) {
		throw new Error(
			`No wikis configured. ${config.defaultWiki === '' ? 'config.json is missing or has an empty "wikis" object.' : ''} ` +
				'Copy config.example.json to config.json and add an entry under "wikis", or set CONFIG to an existing file.',
		);
	}

	const state = createAppState(config);

	// 会话缺失或失效不阻止启动：首次工具调用时会触发登录流程。
	// 此时校验只为记录身份，失败时保持未登录态。
	const session = await readStoredSessionIfValid();
	if (session) {
		sessionLiveness.setIdentity(session.userId);
		state.loginGate.markLoggedIn();
	}

	emitStartupBanner(
		{ transport: 'stdio' },
		{
			wikiRegistry: state.wikiRegistry,
			activeWiki: state.activeWiki,
			uploadDirs: state.uploadDirs,
		},
	);
	const ctx = createToolContext({ logger, state, transport: 'stdio' });

	// serveStdio 持有连接，工厂实例服务其整个生命周期。
	const handle = serveStdio(() => createServer(ctx), {
		onerror: (error) => logger.error(`stdio serving error: ${error.message}`),
	});

	// 会话失效不断开连接：由登录门弹出登录页，用户重新登录后即可继续使用。
	sessionLiveness.setDeathHandler((reason) => {
		logger.error(`session ended, re-login required: ${reason}`);
	});

	// stdio 无在途队列，graceMs 记 0。
	registerShutdownHandlers({
		transport: 'stdio',
		graceMs: 0,
		stdioTransport: handle,
	});
}

main().catch((error) => {
	// 启动失败兜底：不依赖 logger，直接退出而非重新抛出。
	console.error('Server error:', error);
	process.exit(1);
});
