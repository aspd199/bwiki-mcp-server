import { execFile } from 'node:child_process';
import type { ExecSecret } from '../config/loadConfig.ts';
import { CredentialResolutionError } from '../errors/credentialResolutionError.ts';

const TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 200;

function failureMessage(err: unknown, stderr: string, command: string, descriptor: string): string {
	if (err !== null && typeof err === 'object') {
		const code = (err as { code?: unknown }).code;
		const killed = (err as { killed?: unknown }).killed;
		const signal = (err as { signal?: unknown }).signal;

		if (code === 'ENOENT') {
			return `Could not resolve ${descriptor}: command "${command}" not found`;
		}
		if (killed === true || signal === 'SIGTERM' || code === 'ETIMEDOUT') {
			return `Could not resolve ${descriptor}: command "${command}" timed out after ${TIMEOUT_MS / 1000}s. If it prompts for interactive approval (e.g. a 1Password unlock), approve the prompt and retry — the command re-runs on the next attempt.`;
		}
		if (typeof code === 'number' && code !== 0) {
			return `Could not resolve ${descriptor}: command "${command}" exited with status ${code}. stderr: ${stderr.slice(0, STDERR_LIMIT)}`;
		}
	}
	return `Could not resolve ${descriptor}: ${err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)}`;
}

// exec 凭证命令全进程串行执行，避免并发触发多次解锁提示。
// 超时从出队执行时开始计，等待时间不计入。
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task);
	// 无论成败都推进队列，并标记 rejection 已处理。
	queue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * 执行 {exec:…} 凭证命令并返回去空白的 stdout。
 *
 * 用 execFile 的异步形式，不阻塞事件循环；stdin 立即关闭以免挂起。
 * 错误信息只含命令名与截断后的 stderr，不含 stdout 与密钥本身。
 */
export async function runExecSecret(spec: ExecSecret, descriptor: string): Promise<string> {
	const { command, args } = spec.exec;
	const stdout = await enqueue(
		() =>
			new Promise<string>((resolve, reject) => {
				const child = execFile(
					command,
					args,
					{ timeout: TIMEOUT_MS, encoding: 'utf-8' },
					(err, out, errOut) => {
						if (err) {
							reject(
								new CredentialResolutionError(
									failureMessage(err, errOut ?? '', command, descriptor),
								),
							);
							return;
						}
						resolve(out);
					},
				);
				child.stdin?.end();
			}),
	);

	const trimmed = stdout.replace(/\r?\n+$/, '');
	if (trimmed === '') {
		throw new CredentialResolutionError(
			`Could not resolve ${descriptor}: command "${command}" produced no output`,
		);
	}
	return trimmed;
}
