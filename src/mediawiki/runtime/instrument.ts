import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { emitTelemetryEvent } from './logger.ts';
import { recordToolCall } from './metrics.ts';
import { monotonicNow } from './clock.ts';
import type { ErrorCategory } from '../errors/classifyError.ts';

// cancelled 与 ErrorCategory 并列：调用方自行取消，不算故障。
export type ToolOutcome = 'success' | 'cancelled' | ErrorCategory;

const WARNING_OUTCOMES: ReadonlySet<ToolOutcome> = new Set([
	'not_found',
	'invalid_input',
	'permission_denied',
	'conflict',
	'authentication',
	'rate_limited',
]);

export function levelFor(outcome: ToolOutcome): 'info' | 'warning' | 'error' {
	// 取消属正常行为，非降级。
	if (outcome === 'success' || outcome === 'cancelled') {
		return 'info';
	}
	if (outcome === 'upstream_failure') {
		return 'error';
	}
	return WARNING_OUTCOMES.has(outcome) ? 'warning' : 'error';
}

export function hashCaller(token: string | undefined): string {
	if (!token) {
		return 'anonymous';
	}
	const hex = createHash('sha256').update(token).digest('hex');
	return `sha256:${hex.slice(0, 12)}`;
}

/**
 * 审计日志中的调用方标识。
 *
 * stdio 下每次调用都以会话中的 bilibili 用户执行。若无 UID 则标为 no-session。
 */
export function callerLabel(runtimeToken: string | undefined, bilibiliUid: string | undefined): string {
	if (runtimeToken) {
		return hashCaller(runtimeToken);
	}
	if (bilibiliUid) {
		return `bilibili:${bilibiliUid}`;
	}
	return 'no-session';
}

export interface ParsedEnvelope {
	category?: ErrorCategory;
	message?: string;
}

/**
 * 校验 ParsedEnvelope 形状。未知 category 原样透传。
 */
function isParsedEnvelope(obj: unknown): obj is ParsedEnvelope {
	if (obj === null || typeof obj !== 'object') {
		return false;
	}
	if ('category' in obj && obj.category !== undefined && typeof obj.category !== 'string') {
		return false;
	}
	if ('message' in obj && obj.message !== undefined && typeof obj.message !== 'string') {
		return false;
	}
	return true;
}

export function parseEnvelope(text: string | undefined): ParsedEnvelope {
	if (!text) {
		return {};
	}
	try {
		const obj: unknown = JSON.parse(text);
		if (isParsedEnvelope(obj)) {
			return obj;
		}
	} catch {
		// leave empty
	}
	return {};
}

export function detectTruncation(result: CallToolResult): boolean {
	const sc = result.structuredContent;
	if (sc !== undefined && sc !== null && typeof sc === 'object') {
		return 'truncation' in sc;
	}
	return false;
}

export function extractUpstreamStatus(err: unknown): number | undefined {
	if (err !== null && typeof err === 'object') {
		const response = (err as { response?: { status?: unknown } }).response;
		if (response && typeof response.status === 'number') {
			return response.status;
		}
	}
	return undefined;
}

export function safeTarget<TArgs>(
	target: ((args: TArgs) => string) | undefined,
	args: TArgs,
): string {
	if (target === undefined) {
		return '';
	}
	try {
		return target(args);
	} catch {
		return '';
	}
}

export interface EmitToolCallOptions<TArgs> {
	readonly toolName: string;
	readonly target?: (args: TArgs) => string;
	readonly args: TArgs;
	readonly started: number;
	readonly result: CallToolResult;
	readonly outcome: ToolOutcome;
	readonly upstreamStatus: number | undefined;
	readonly errorMessage: string | undefined;
	readonly runtimeToken: string | undefined;
	readonly wikiKey: string;
	/** The bilibili user the stored session acts as, when it is known. */
	readonly bilibiliUid: string | undefined;
}

export function emitToolCall<TArgs>(opts: EmitToolCallOptions<TArgs>): void {
	const level = levelFor(opts.outcome);
	const targetValue = safeTarget(opts.target, opts.args);
	const truncated = opts.outcome === 'success' ? detectTruncation(opts.result) : false;
	const durationMs = Math.round(monotonicNow() - opts.started);
	// 结构化日志要求 snake_case 键名。
	const data: Record<string, unknown> = {
		event: 'tool_call',
		tool: opts.toolName,
		wiki: opts.wikiKey,
		outcome: opts.outcome,
		duration_ms: durationMs,
		caller: callerLabel(opts.runtimeToken, opts.bilibiliUid),
		truncated,
	};
	if (targetValue !== '') {
		data.target = targetValue;
	}
	if (opts.upstreamStatus !== undefined) {
		data.upstream_status = opts.upstreamStatus;
	}
	if (opts.errorMessage !== undefined) {
		data.error_message = opts.errorMessage;
	}
	emitTelemetryEvent(level, data);
	// 遥测不得影响工具调用，异常在此吞掉。
	try {
		recordToolCall({
			tool: opts.toolName,
			wiki: opts.wikiKey,
			outcome: opts.outcome,
			durationMs,
			upstreamStatus: opts.upstreamStatus,
		});
	} catch {
		// swallow
	}
}
