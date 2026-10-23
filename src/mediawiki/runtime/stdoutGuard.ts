import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { Mwn } from 'mwn';
import { emitTelemetryEvent } from './logger.ts';

/**
 * stdio 下 stdout 只承载 JSON-RPC 帧，任何杂散输出都会让客户端解析失败。
 * 本模块把 mwn 与 console 的输出改道到结构化 stderr 日志。
 */
export function guardStdout(): void {
	const sink = createLogSink();

	// 把 mwn 的日志输出指离 process.stdout，同时禁用其彩色转义。
	Mwn.setLoggingConfig({ stream: sink });

	// mwn 另有一处硬编码的 console.log，一并替换其 stdout 一侧。
	// process.stdout 本身不改：SDK 直接写入。
	// inspectOptions 保持默认，避免把 Set-Cookie 等敏感字段展开进日志。
	globalThis.console = new Console({ stdout: sink, stderr: process.stderr });
}

function createLogSink(): Writable {
	return new Writable({
		write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void): void {
			try {
				report(String(chunk));
			} finally {
				// 必须调用回调，否则流会一直挂起。
				callback();
			}
		},
	});
}

function report(text: string): void {
		// 每条输出以换行结尾，逐行拆分以保持一个事件一行。
	for (const line of text.split('\n')) {
		if (line.trim() === '') {
			continue;
		}
		try {
			emitTelemetryEvent('warning', { event: 'stray_stdout', text: line });
		} catch {
			// 记录器若抛出，保留原始行以免丢失。
			process.stderr.write(line + '\n');
		}
	}
}
