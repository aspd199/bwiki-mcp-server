import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import { errorMessage } from '../errors/isErrnoException.ts';
import { logger } from '../runtime/logger.ts';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import type { Reconcile } from '../runtime/reconcile.ts';
import { dispatch } from '../runtime/dispatcher.ts';
import { register } from '../runtime/register.ts';

import { extensionPacks } from './extensions/index.ts';
import { standardTools } from './standardTools.ts';

// 站点管理工具（add-wiki / remove-wiki）刻意不提供：
// 本服务的站点由配置决定，不存在运行时可添加的注册表。
//
// add or remove.

export function registerAllTools(
	server: McpServer,
	reconcile: Reconcile,
	ctx: ToolContext,
): Map<string, RegisteredTool> {
	const registered = new Map<string, RegisteredTool>();

	for (const tool of standardTools) {
		try {
			registered.set(tool.name, register(server, tool, dispatch(tool, ctx)));
		} catch (error) {
			logger.error('Error registering tool', { error: errorMessage(error) });
		}
	}

	// 扩展门槛工具默认禁用，待 reconcile() 确认扩展已安装后启用，
	// 以避免 tools/list 先于初始 reconcile 到达。
	for (const pack of extensionPacks) {
		for (const tool of pack.tools) {
			const reg = registered.get(tool.name);
			if (reg && reg.enabled) {
				reg.disable();
			}
		}
	}

	return registered;
}
