import { logger } from './logger.ts';
import { classifyAuthShape } from './authShape.ts';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import type { ActiveWiki } from '../wikis/activeWiki.ts';
import type { UploadDirs } from '../wikis/uploadDirs.ts';
import { SERVER_VERSION } from './constants.ts';

// 标题与版本由打包器注入，不读 server.json。
const serverInfo = {
	title: 'BWiki MCP Server',
	version: SERVER_VERSION,
};

export type CreateServerOptions =
	| { transport: 'stdio' }
	| {
			transport: 'http';
			http: {
				host: string;
				port: number;
				allowedHosts?: readonly string[];
				allowedOrigins?: readonly string[];
				maxRequestBody: string;
			};
	  };

export interface BannerDeps {
	readonly wikiRegistry: WikiRegistry;
	readonly activeWiki: ActiveWiki;
	readonly uploadDirs: UploadDirs;
	// 托管 OAuth 代理对默认站点启用时，横幅报告 oauth-proxy 认证方式。
	readonly proxyEnabled?: boolean;
}

export function emitStartupBanner(opts: CreateServerOptions, deps: BannerDeps): void {
	const wikis = deps.wikiRegistry.getAll();
	const data: Record<string, unknown> = {
		event: 'startup',
		version: serverInfo.version,
		transport: opts.transport,
		auth_shape: classifyAuthShape(wikis, opts.transport, deps.proxyEnabled ?? false),
		default_wiki: deps.activeWiki.getDefaultKey(),
		wikis: Object.keys(wikis),
		allow_wiki_management: deps.wikiRegistry.isManagementAllowed(),
		upload_dirs_configured: deps.uploadDirs.list().length > 0,
	};
	if (opts.transport === 'http') {
		data.host = opts.http.host;
		data.port = opts.http.port;
		if (opts.http.allowedHosts !== undefined) {
			data.allowed_hosts = opts.http.allowedHosts;
		}
		if (opts.http.allowedOrigins !== undefined) {
			data.allowed_origins = opts.http.allowedOrigins;
		}
		data.max_request_body = opts.http.maxRequestBody;
	}
	logger.info('', data);
}
