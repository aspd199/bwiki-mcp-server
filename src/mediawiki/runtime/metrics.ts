/**
 * 工具调用指标。本项目仅 stdio 传输，无 /metrics 端点，故为空实现。
 */

export interface RecordToolCallInput {
	readonly tool: string;
	readonly wiki: string;
	readonly outcome: 'success' | 'cancelled' | string;
	readonly durationMs: number;
	readonly upstreamStatus: number | undefined;
}

export function isMetricsEnabled(): boolean {
	return false;
}

export function initMetrics(): void {
	// 无 /metrics 端点，空实现。
}

export function recordToolCall(_input: RecordToolCallInput): void {
	// 空实现，见文件头。
}

export function recordReadyFailure(): void {
	// 空实现：/ready 属 HTTP 传输。
}

export function recordRateLimited(_caller: 'caller' | 'anonymous'): void {
	// 空实现：限流属 HTTP 传输。
}

export function setInFlightProvider(_fn: () => number): void {
	// 空实现：在途统计属 HTTP 传输。
}

export function setSubscriptionStreamsProvider(_fn: () => number): void {
	// 空实现：订阅流属 HTTP 传输。
}

export function recordStoreFlush(_durationMs: number): void {
	// 空实现：OAuth 相关，本构建不含。
}

export function recordStoreFlushFailure(): void {
	// 空实现：OAuth 相关，本构建不含。
}

export function setProxyStoreStatsProvider(_fn: () => { readonly upstreamTokens: number; readonly clients: number }): void {
	// 空实现：OAuth 相关，本构建不含。
}

export function __resetMetricsForTesting(): void {
	// 空实现：保留以兼容上游测试接缝。
}
