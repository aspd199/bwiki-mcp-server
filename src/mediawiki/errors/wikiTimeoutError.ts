/** How far a call got before its budget ran out. */
export type WikiTimeoutPhase = 'connecting' | 'calling';

/**
 * 请求因耗尽时间预算（而非调用方取消）而放弃时抛出。
 * `disableRetry` 阻止 mwn 对已触发的信号继续重试。
 */
export class WikiTimeoutError extends Error {
	public readonly disableRetry = true;

	public constructor(
		timeoutMs: number,
		public readonly phase: WikiTimeoutPhase,
	) {
		const seconds = Math.round(timeoutMs / 1000);
		super(
			phase === 'connecting'
				? `Gave up trying to reach the wiki after ${seconds} seconds`
				: `Gave up waiting for the wiki after ${seconds} seconds`,
		);
		this.name = 'WikiTimeoutError';
	}
}
