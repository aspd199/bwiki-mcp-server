import type { Mwn, RawRequestParams } from 'mwn';
import type { CallDeadline } from '../runtime/callDeadline.ts';
import { WikiTimeoutError } from '../errors/wikiTimeoutError.ts';

/** 标记该错误不参与 mwn 的重试。 */
interface RetryableError {
	disableRetry?: boolean;
}

/**
 * 返回 `bot` 的视图：其 API 调用在 `deadline` 到期或调用方取消时中止。
 *
 * 拦截 `rawRequest`，所有 API 调用都经过它。用 Proxy 而非子类或克隆，
 * 以转发 mwn 缓存的 CSRF token 与登录状态。被包装的方法不绑定 `this`，
 * 使 mwn 内部的 `this.rawRequest(...)` 同样被拦截。
 *
 * 中止的请求需标记 `disableRetry`，否则 mwn 会当作瞬时失败重试。
 */
export function withCallBounds(bot: Mwn, deadline: CallDeadline, cancellation?: AbortSignal): Mwn {
	const signal =
		cancellation === undefined ? deadline.signal : AbortSignal.any([deadline.signal, cancellation]);
	return new Proxy(bot, {
		get(target, prop, receiver): unknown {
			if (prop === 'massQuery') {
				// massQuery 把每批的错误放进结果数组而非抛出，
				// 中止时会表现为缺失数据，故在此还原为抛出。
				return async (...args: Parameters<Mwn['massQuery']>): Promise<unknown> => {
					// 作用于 receiver，使内部 `this.request` 仍受约束。
					const responses = await bot.massQuery.apply(receiver, args);
					if (signal.aborted) {
						const failure = responses.find((response) => response instanceof Error);
						if (failure) {
							throw failure;
						}
					}
					return responses;
				};
			}
			if (prop !== 'rawRequest') {
				return Reflect.get(target, prop, receiver);
			}
			return async (requestOptions: RawRequestParams): Promise<unknown> => {
				try {
					return await target.rawRequest({ ...requestOptions, signal });
				} catch (err: unknown) {
					if (signal.aborted) {
						// AbortSignal.any 转发胜出信号的 reason，可据此判断哪个先触发。
						if (deadline.signal.aborted && signal.reason === deadline.signal.reason) {
							throw new WikiTimeoutError(deadline.timeoutMs, deadline.phase);
						}
						// 尽力而为：冻结对象赋值会抛 TypeError。
						if (typeof err === 'object' && err !== null && Object.isExtensible(err)) {
							(err as RetryableError).disableRetry = true;
						}
					}
					throw err;
				}
			};
		},
	});
}
