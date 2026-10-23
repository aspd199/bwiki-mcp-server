import { McpServer } from '@modelcontextprotocol/server';
import type { RegisteredTool } from '@modelcontextprotocol/server';
import { registerAllTools } from './tools/index.ts';
import { registerAllResources } from './resources/index.ts';
import { reconcileTools } from './runtime/reconcile.ts';
import { extensionPacks } from './tools/extensions/index.ts';
import type { ToolContext } from './runtime/context.ts';
import { SERVER_NAME, SERVER_VERSION } from './runtime/constants.ts';

// 这些值由打包器注入，不读 server.json。
const SERVER_VERSION_STRING: string = SERVER_VERSION;

const SERVER_INSTRUCTIONS: string = `Tools and resources for working with one or more BWiki wikis (wiki.biligame.com). Each configured wiki appears as an \`mcp://wikis/{wikiKey}\` resource. Every tool that operates on a wiki accepts an optional \`wiki\` argument naming the wiki to act on — pass a wiki key (or its \`mcp://wikis/{wikiKey}\` URI). Omit it to use the configured default wiki. There is no stateful "current wiki": each call targets exactly the wiki it names, and every response reports the wiki it ran against. Call \`list-wikis\` to see the whole farm roster and which wikis this server is configured for.

Authentication is mandatory and is not a tool argument: the server holds a bilibili passport session obtained with \`bwiki-login\`, and every wiki call is made as that user. If the session is missing or the wiki stops recognizing it, the server ends the connection rather than falling back to anonymous access, which would attribute wiki actions to an IP address. Run \`bwiki-login\` again to re-establish it.

Writes, deletes, and uploads act as the signed-in bilibili user, and their edit summaries carry attribution.

Tool errors fall into seven categories: \`not_found\`, \`permission_denied\`, \`invalid_input\`, \`conflict\`, \`authentication\`, \`rate_limited\`, and \`upstream_failure\`. Reads that exceed a per-call cap return a truncation marker describing what was returned and how to fetch the rest.`;

// 变更事件的发布方式。stdio 下写到订阅流，HTTP 下用 handler 的 notify。
export interface ChangePublisher {
	toolsChanged(): void;
	resourcesChanged(): void;
}

export interface CreateServerOptions {
	publisher?: ChangePublisher;
}

// 此处可缓存的内容仅在 reconcile 时变化，订阅方通过 listChanged 得知；
// TTL 只为轮询的客户端限制陈旧时间。作用域设为 private，
// 以免同一中间件后的另一部署复用本部署的列表。
const CACHE_HINT = { ttlMs: 60_000, cacheScope: 'private' } as const;

export const createServer = async (
	ctx: ToolContext,
	options: CreateServerOptions = {},
): Promise<McpServer> => {
	const server = new McpServer(
		{
			name: SERVER_NAME,
			title: 'BWiki MCP Server',
			version: SERVER_VERSION_STRING,
			description:
				'MCP server for BWiki (wiki.biligame.com), authenticated as a bilibili user.',
		},
		{
			capabilities: {
				resources: {
					listChanged: true,
				},
				tools: {
					listChanged: true,
				},
			},
			instructions: SERVER_INSTRUCTIONS,
			cacheHints: {
				'tools/list': CACHE_HINT,
				'resources/list': CACHE_HINT,
				'resources/templates/list': CACHE_HINT,
				'resources/read': CACHE_HINT,
				'server/discover': CACHE_HINT,
			},
		},
	);

	const publisher: ChangePublisher = options.publisher ?? {
		// 已注册工具的状态切换会自行发出 listChanged，只有资源列表需显式推送。
		toolsChanged: (): void => {},
		resourcesChanged: (): void => {
			server.sendResourceListChanged();
		},
	};

	const tools = new Map<string, RegisteredTool>();
	const applyGates = (): Promise<void> =>
		reconcileTools(tools, {
			wikiRegistry: ctx.wikis,
			transport: ctx.transport,
			wikiProbe: ctx.wikiProbe,
			extensionPacks,
		});
	// reconcile 回调：重新计算可见性，再通知客户端列表可能已变化。
	//
	// changed.
	const reconcile = async (): Promise<void> => {
		await applyGates();
		publisher.resourcesChanged();
		publisher.toolsChanged();
	};

	const registered = registerAllTools(server, reconcile, ctx);
	for (const [name, tool] of registered) {
		tools.set(name, tool);
	}
	registerAllResources(server, ctx);

	// 构造期只计算不发布：新实例尚无订阅者。
	//
	// request.
	await applyGates();

	return server;
};
