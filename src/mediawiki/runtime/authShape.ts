import type { WikiConfig } from '../config/loadConfig.ts';
import { isCredentialConfigured } from '../config/loadConfig.ts';

// 仅由配置推导的认证方式分类。

export function hasStaticCredentials(wiki: WikiConfig): boolean {
	if (isCredentialConfigured(wiki.token)) {
		return true;
	}
	return isCredentialConfigured(wiki.username) && isCredentialConfigured(wiki.password);
}

export type AuthShape = 'anonymous' | 'static-credential' | 'bearer-passthrough' | 'oauth-proxy';
export type Transport = 'stdio' | 'http';

// 转发客户端 bearer 已废弃，默认关闭：MCP 服务器不应接受非本服务签发的 token。
export function bearerPassthroughEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MCP_ALLOW_BEARER_PASSTHROUGH === 'true';
}

export function classifyAuthShape(
	wikis: Readonly<Record<string, WikiConfig>>,
	transport: Transport,
	proxyEnabled = false,
	passthroughEnabled = bearerPassthroughEnabled(),
): AuthShape {
	const anyStatic = Object.values(wikis).some(hasStaticCredentials);
	if (anyStatic) {
		return 'static-credential';
	}
	if (transport !== 'http') {
		return 'anonymous';
	}
	// 托管 OAuth 代理启用时，本服务自身即为授权服务器。
	if (proxyEnabled) {
		return 'oauth-proxy';
	}
	return passthroughEnabled ? 'bearer-passthrough' : 'anonymous';
}
