import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import ipaddr from 'ipaddr.js';

export class SsrfValidationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'SsrfValidationError';
	}
}

// 这些废弃的 IPv6 段被 ipaddr.js 判为 unicast，需显式视为非公开地址。
const EXTRA_BLOCKED_V6: Record<string, [ipaddr.IPv6, number]> = {
	deprecatedSiteLocal: [ipaddr.IPv6.parse('fec0::'), 10],
	deprecated6bone: [ipaddr.IPv6.parse('3ffe::'), 16],
};

// 允许解析到非公开地址的主机白名单，逗号分隔，每次调用时读环境变量。
// 裸主机名匹配任意端口，host:port 仅匹配该端口；精确匹配，无通配。
function readTrustedHosts(): Set<string> {
	const raw = process.env.MCP_TRUSTED_HOSTS;
	if (raw === undefined || raw === '') {
		return new Set();
	}
	return new Set(
		raw
			.split(',')
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry) => entry !== ''),
	);
}

export async function assertPublicDestination(urlString: string): Promise<LookupAddress[]> {
// siteinfo 的 server 为协议相对 URL（如 //host），统一补为 https。
	const normalized = urlString.startsWith('//') ? 'https:' + urlString : urlString;
	const url = new URL(normalized);
// 仅允许 https：会话 cookie 随每个请求发送，http 会明文外泄。
	if (url.protocol !== 'https:') {
		throw new SsrfValidationError(
			`Refusing to fetch URL with scheme "${url.protocol}": only https is allowed: ${urlString}`,
		);
	}

	const hostname =
		url.hostname.startsWith('[') && url.hostname.endsWith(']')
			? url.hostname.slice(1, -1)
			: url.hostname;

	const addresses = await lookup(hostname, { all: true });
	if (addresses.length === 0) {
		throw new SsrfValidationError(
			`DNS lookup for "${hostname}" returned no addresses: ${normalized}`,
		);
	}

// 白名单主机只跳过公开地址校验，仍使用已解析的地址固定连接。
	const trusted = readTrustedHosts();
	if (
		trusted.size > 0 &&
		(trusted.has(hostname.toLowerCase()) || trusted.has(url.host.toLowerCase()))
	) {
		return addresses;
	}

	for (const { address } of addresses) {
		assertAddressIsUnicast(address, normalized);
	}
	return addresses;
}

export function buildPinnedAgent(
	urlString: string,
	addresses: LookupAddress[],
): HttpAgent | HttpsAgent {
	const url = new URL(urlString);
// 用预解析的地址固定连接，防止校验与连接之间的 DNS 重绑定。
// 该机制假定直连；若将来引入 HTTPS 代理，需在代理层另做防护。
	// 若将来引入代理，需在代理层另做防护。
	const pinnedLookup = (
		_hostname: string,
		options: { all?: boolean },
		callback: (
			err: NodeJS.ErrnoException | null,
			addressOrAll: string | LookupAddress[],
			family?: number,
		) => void,
	): void => {
		if (options.all) {
			callback(null, addresses);
			return;
		}
		const first = addresses[0];
		callback(null, first.address, first.family);
	};

	const AgentCtor = url.protocol === 'https:' ? HttpsAgent : HttpAgent;
	return new AgentCtor({ lookup: pinnedLookup });
}

function assertAddressIsUnicast(address: string, urlString: string): void {
	let parsed: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		parsed = ipaddr.parse(address);
	} catch {
		throw new SsrfValidationError(
			`Refusing to fetch URL resolving to unparseable address "${address}": ${urlString}`,
		);
	}

	if (
		parsed.kind() === 'ipv6' &&
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by parsed.kind() === 'ipv6'; ipaddr.js doesn't expose a type predicate
		(parsed as ipaddr.IPv6).isIPv4MappedAddress()
	) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by parsed.kind() === 'ipv6'; ipaddr.js doesn't expose a type predicate
		parsed = (parsed as ipaddr.IPv6).toIPv4Address();
	}

	const range = parsed.range();
	if (range !== 'unicast') {
		throw new SsrfValidationError(nonPublicAddressMessage(address, range, urlString));
	}

	if (parsed.kind() === 'ipv6') {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by parsed.kind() === 'ipv6'; ipaddr.js doesn't expose a type predicate
		const v6 = parsed as ipaddr.IPv6;
		const extraMatch = ipaddr.subnetMatch(v6, EXTRA_BLOCKED_V6, 'unicast');
		if (extraMatch !== 'unicast') {
			throw new SsrfValidationError(nonPublicAddressMessage(address, extraMatch, urlString));
		}
	}
}

// 该拒绝会出现在工具输出中，故提示中说明只有运维可解除。
function nonPublicAddressMessage(address: string, range: string, urlString: string): string {
	return (
		`Refusing to fetch URL resolving to non-public address ${address} (${range}); ` +
		`the server operator must add the host to MCP_TRUSTED_HOSTS to allow it: ${urlString}`
	);
}
