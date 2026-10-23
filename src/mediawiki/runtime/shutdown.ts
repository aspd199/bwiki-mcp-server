import type { Server as HttpServer } from 'node:http';
import { emitTelemetryEvent, logger } from './logger.ts';
import { monotonicNow } from './clock.ts';

const DEFAULT_GRACE_MS = 10_000;
const MAX_GRACE_MS = 600_000;

export function resolveShutdownGrace(env: NodeJS.ProcessEnv): number {
	const raw = env.MCP_SHUTDOWN_GRACE_MS;
	if (raw === undefined) {
		return DEFAULT_GRACE_MS;
	}
	const n = Number(raw);
	if (raw === '' || !Number.isInteger(n) || n < 0 || n > MAX_GRACE_MS) {
		logger.warning(
			`Ignoring invalid MCP_SHUTDOWN_GRACE_MS=${JSON.stringify(raw)}; ` +
				`expected an integer between 0 and ${MAX_GRACE_MS}. Using default ${DEFAULT_GRACE_MS}ms.`,
		);
		return DEFAULT_GRACE_MS;
	}
	return n;
}

export interface InFlightCounterReader {
	readonly count: () => number;
}

export type StdioCloseable = { close(): Promise<void> | void };

export interface ShutdownDeps {
	readonly transport: 'http' | 'stdio';
	readonly graceMs: number;
	readonly httpServer?: HttpServer;
	// /mcp handler 在排空之后再关闭：先关会中断正在处理的请求。
	readonly mcpHandler?: { close: () => Promise<void> };
	readonly inFlight?: InFlightCounterReader;
	readonly stdioTransport?: StdioCloseable;
	readonly process?: NodeJS.Process;
	readonly pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 50;

function hasCloseIdleConnections(server: unknown): server is { closeIdleConnections: () => void } {
	return (
		server !== null &&
		typeof server === 'object' &&
		'closeIdleConnections' in server &&
		typeof server.closeIdleConnections === 'function'
	);
}

export function registerShutdownHandlers(deps: ShutdownDeps): void {
	const proc = deps.process ?? process;
	let draining = false;

	const handler = (signal: 'SIGTERM' | 'SIGINT'): void => {
		if (draining) {
			proc.exit(1);
			return;
		}
		draining = true;
		runDrain(signal, deps, proc).catch(() => {
			// 保险：避免未处理的 rejection 进入 Node 默认处理器。
		});
	};

	proc.on('SIGTERM', () => handler('SIGTERM'));
	proc.on('SIGINT', () => handler('SIGINT'));
}

async function runDrain(
	signal: 'SIGTERM' | 'SIGINT',
	deps: ShutdownDeps,
	proc: NodeJS.Process,
): Promise<void> {
	const start = monotonicNow();
	const inFlightAtSignal = deps.inFlight?.count() ?? 0;

	emitTelemetryEvent('info', {
		event: 'shutdown',
		signal,
		transport: deps.transport,
		grace_ms: deps.graceMs,
		in_flight_at_signal: inFlightAtSignal,
	});

	if (deps.transport === 'http') {
		if (deps.httpServer) {
			// 停止接受新连接。close 回调不 await，排空由 inFlight 计数决定。
			deps.httpServer.close();
			// 特性检测：关闭空闲的 keep-alive 连接。
			if (hasCloseIdleConnections(deps.httpServer)) {
				deps.httpServer.closeIdleConnections();
			}
		}
	} else if (deps.stdioTransport) {
		try {
			await deps.stdioTransport.close();
		} catch {
			// 忽略：关闭失败不应阻塞排空。
		}
	}

	const graceExceeded = await waitForDrain(
		deps.inFlight,
		deps.graceMs,
		deps.pollIntervalMs ?? DEFAULT_POLL_MS,
	);

	if (deps.mcpHandler) {
		try {
			// 在排空之后：此时只剩订阅流，按规范以空结果关闭。
			await deps.mcpHandler.close();
		} catch {
			// 关闭失败不应阻塞退出。
		}
	}

	const drained = inFlightAtSignal - (deps.inFlight?.count() ?? 0);
	emitTelemetryEvent('info', {
		event: 'shutdown_complete',
		signal,
		transport: deps.transport,
		in_flight_drained: drained,
		grace_exceeded: graceExceeded,
		duration_ms: Math.round(monotonicNow() - start),
	});

	proc.exit(graceExceeded ? 1 : 0);
}

async function waitForDrain(
	inFlight: InFlightCounterReader | undefined,
	graceMs: number,
	pollMs: number,
): Promise<boolean> {
	if (!inFlight) {
		return false;
	}
	// "0" 表示无请求进入中间件，而非无 socket 活动。
	if (inFlight.count() === 0) {
		return false;
	}
	const deadline = monotonicNow() + graceMs;
	while (monotonicNow() < deadline) {
		await new Promise((r) => {
			setTimeout(r, pollMs);
		});
		if (inFlight.count() === 0) {
			return false;
		}
	}
	return inFlight.count() > 0;
}
