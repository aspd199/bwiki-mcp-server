type ErrnoLike = NodeJS.ErrnoException & {
	signal?: string;
	status?: number | null;
	stderr?: Buffer | string;
};

/**
 * 将捕获的未知值收窄为 ErrnoLike 的类型谓词。
 *
 * 实现只检查 `err instanceof Error`，其余 Errno 字段不在运行时校验。
 *
 * 调用方应做相等比较（如 `err.code === 'ENOENT'`），
 * 因为普通 `new Error('x')` 也能通过该谓词，其 `code` 为 undefined。
 */
export function isErrnoException(err: unknown): err is ErrnoLike {
	return err instanceof Error;
}

export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
	return err instanceof Error ? err.message : fallback;
}
