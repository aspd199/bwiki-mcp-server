import { WIKI_RESOURCE_URI_PREFIX } from './constants.ts';

// wiki key 与 `mcp://wikis/` URI 段之间的映射。

export type WikiKeyProblem = 'empty' | 'resource-uri-collision' | 'not-encodable';

// 仅拒绝两种 key：以资源前缀开头的，以及无法进行百分号编码的。
export function wikiKeyProblem(key: string): WikiKeyProblem | undefined {
	if (key.trim() === '') {
		return 'empty';
	}
	if (key.startsWith(WIKI_RESOURCE_URI_PREFIX)) {
		return 'resource-uri-collision';
	}
	try {
		encodeURIComponent(key);
	} catch {
		return 'not-encodable';
	}
	return undefined;
}

export function wikiKeyProblemMessage(problem: WikiKeyProblem): string {
	switch (problem) {
		case 'empty':
			return 'cannot be empty';
		case 'resource-uri-collision':
			return `cannot start with "${WIKI_RESOURCE_URI_PREFIX}"`;
		default:
			return 'is not valid Unicode';
	}
}

// RFC 3986 允许路径段中直接出现 ":"，转义会改变 host:port 形式的 key。
// 每个 "%" 都开启一个三字符转义，故 "%3A" 总是 ":" 的完整转义。
export function encodeWikiKey(key: string): string {
	return encodeURIComponent(key).replaceAll('%3A', ':');
}

// 编码非法时返回 undefined：decodeURIComponent 遇裸 "%" 会抛错。
export function decodeWikiKey(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch (error) {
		if (error instanceof URIError) {
			return undefined;
		}
		throw error;
	}
}
