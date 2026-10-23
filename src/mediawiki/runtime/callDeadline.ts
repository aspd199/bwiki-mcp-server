import type { WikiTimeoutPhase } from '../errors/wikiTimeoutError.ts';

/**
 * 单次工具调用的总预算，含重试与连接、抓取等各阶段。
 */
export const WIKI_CALL_TIMEOUT_MS = 150_000;

/**
 * 首次连接站点的预算，独立于调用预算。
 */
export const WIKI_CONNECT_TIMEOUT_MS = 30_000;

/**
 * `AbortSignal.timeout` 不携带时长与语义，故另行记录。
 */
export interface CallDeadline {
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	readonly phase: WikiTimeoutPhase;
}

export function callDeadline(timeoutMs: number, phase: WikiTimeoutPhase): CallDeadline {
	return { signal: AbortSignal.timeout(timeoutMs), timeoutMs, phase };
}
