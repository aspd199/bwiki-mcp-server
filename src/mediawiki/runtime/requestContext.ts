import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallDeadline } from './callDeadline.ts';

interface RequestContext {
	runtimeToken?: string;
	wikiKey?: string;
	signal?: AbortSignal;
	deadline?: CallDeadline;
}

export const runtimeTokenStore = new AsyncLocalStorage<RequestContext>();

export function getRuntimeToken(): string | undefined {
	return runtimeTokenStore.getStore()?.runtimeToken;
}

// 请求的取消信号，请求外为 undefined。
export function getRequestSignal(): AbortSignal | undefined {
	return runtimeTokenStore.getStore()?.signal;
}

/**
 * 调用的时间预算，与 `signal` 分开，以免把预算耗尽误读为调用方取消。
 */
export function getRequestDeadline(): CallDeadline | undefined {
	return runtimeTokenStore.getStore()?.deadline;
}

export function getRequestWiki(): string | undefined {
	return runtimeTokenStore.getStore()?.wikiKey;
}

export function withRequestContext<T>(
	runtimeToken: string | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	return runtimeTokenStore.run({ runtimeToken }, fn);
}

// 将 `fields` 合并到当前上下文而非替换。
export function withRequestFields<T>(
	fields: Partial<RequestContext>,
	fn: () => Promise<T>,
): Promise<T> {
	const current = runtimeTokenStore.getStore() ?? {};
	return runtimeTokenStore.run({ ...current, ...fields }, fn);
}

/**
 * 在 `deadline` 预算下脱离触发者执行 `fn`，不与调用方的取消和剩余时间共享。
 *
 * 用于并发调用方共享的work：首个调用方取消不应波及其他等待者，
 * 其剩余预算同样不应被继承，否则结果取决于无关的时钟。
 */
export function withSharedWorkScope<T>(deadline: CallDeadline, fn: () => Promise<T>): Promise<T> {
	return withRequestFields({ signal: undefined, deadline }, fn);
}
