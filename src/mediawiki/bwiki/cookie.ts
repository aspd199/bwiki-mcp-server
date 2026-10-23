/**
 * 会话 cookie 处理。
 *
 * 会话文件同时保存 passport cookie 与 wiki 会话 cookie，两者均可认证，优先后者。
 */
import { readFile } from 'node:fs/promises';
import { DEFAULT_SESSION_FILE } from '../config/loadConfig.ts';

export interface StoredSession {
	passportCookie: string;
	wikiCookie: string;
	userId: string;
	refreshToken?: string;
	savedAt: number;
}

/**
 * 读取会话文件，缺失或不可用时返回 null。
 *
 * 文件缺失与格式错误视为同一种情况，
 * 因为下一步动作相同。
 */
export async function readSessionFile(file: string = DEFAULT_SESSION_FILE): Promise<StoredSession | null> {
	try {
		const parsed = JSON.parse(await readFile(file, 'utf8')) as StoredSession;
		return parsed.passportCookie && parsed.userId ? parsed : null;
	} catch {
		return null;
	}
}

/** The stored cookies as `name=value` pairs, in the order to try them. */
export function wikiCookiePartsFor(session: StoredSession): string[] {
	const candidates = [session.wikiCookie, session.passportCookie];
	const parts: string[] = [];
	for (const raw of candidates) {
		if (!raw) continue;
		for (const pair of raw.split(';').map((c) => c.trim()).filter(Boolean)) {
			const eq = pair.indexOf('=');
			const name = eq > 0 ? pair.slice(0, eq) : '';
			const value = eq > 0 ? pair.slice(eq + 1) : '';
			if (name && value && !parts.includes(pair)) {
				parts.push(pair);
			}
		}
	}
	return parts;
}

/** True when the cookie string carries something that could be sent. */
export function hasUsableCookie(session: StoredSession): boolean {
	return wikiCookiePartsFor(session).length > 0;
}
