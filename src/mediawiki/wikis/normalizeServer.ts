// siteinfo.general.server 可能是协议相对 URL（"//host"），统一补为 https。
//
// 供认证态 siteInfo 与匿名 wikiProbe 共用。
export function normalizeServer(server: string): string {
	return server.startsWith('//') ? 'https:' + server : server;
}
