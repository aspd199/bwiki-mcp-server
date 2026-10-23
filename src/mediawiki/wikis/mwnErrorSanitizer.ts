const REDACTED = '[REDACTED]';

const SENSITIVE_HEADER_PATTERN = /^(?:proxy-)?authorization$/i;

function isRecord(x: unknown): x is Record<string, unknown> {
	return x !== null && typeof x === 'object';
}

function isThenable(x: unknown): x is Promise<unknown> {
	if (x === null || typeof x !== 'object') return false;
	if (!('then' in x) || typeof x.then !== 'function') return false;
	if (!('catch' in x) || typeof x.catch !== 'function') return false;
	return true;
}

function redactHeadersObject(obj: unknown): void {
	if (!isRecord(obj)) {
		return;
	}
	const headers = obj.headers;
	if (!isRecord(headers)) {
		return;
	}
	for (const key of Object.keys(headers)) {
		if (SENSITIVE_HEADER_PATTERN.test(key)) {
			headers[key] = REDACTED;
		}
	}
}

export function redactAuthorizationHeader(err: unknown, token?: string): void {
	// 运行时冗余，仅用于让 TS 收窄类型以便索引属性。
	if (!(err instanceof Error) || !isRecord(err)) {
		return;
	}
	redactHeadersObject(err.request);
	redactHeadersObject(err.config);
	if (isRecord(err.response)) {
		redactHeadersObject(err.response.config);
	}
	// 用字符串模式做字面替换，勿改为正则，token 中的特殊字符会被误解析。
	if (token && typeof err.message === 'string' && err.message.includes(token)) {
		err.message = err.message.replaceAll(token, REDACTED);
	}
	if (token && typeof err.stack === 'string' && err.stack.includes(token)) {
		err.stack = err.stack.replaceAll(token, REDACTED);
	}
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- predicate body's required cast to inspect Symbol.asyncIterator
		typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
	);
}

// 包装异步可迭代对象，使迭代中的异常也经过脱敏处理。
function wrapAsyncIterable<T>(
	iter: AsyncIterable<T>,
	token: string | undefined,
): AsyncIterableIterator<T> {
	const inner = iter[Symbol.asyncIterator]();
	const sanitise = <R>(p: Promise<R>): Promise<R> =>
		p.catch((err: unknown) => {
			redactAuthorizationHeader(err, token);
			throw err;
		});
	const wrapped: AsyncIterableIterator<T> = {
		[Symbol.asyncIterator](): AsyncIterableIterator<T> {
			return wrapped;
		},
		next: (...args) => sanitise(inner.next(...args)),
		return: inner.return ? (value) => sanitise(inner.return!(value)) : undefined,
		throw: inner.throw ? (e) => sanitise(inner.throw!(e)) : undefined,
	};
	return wrapped;
}

export function wrapMwnErrors<T extends object>(target: T, token?: string): T {
	return new Proxy(target, {
		get(obj, prop, receiver): unknown {
			const value = Reflect.get(obj, prop, receiver);
			if (typeof value !== 'function') {
				return value;
			}
			return function (this: unknown, ...args: unknown[]): unknown {
				try {
					// 以 receiver 调用：重新绑定会让外层代理失效。
					const result =
						// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Reflect.get returns unknown; the trapped property is the original function
						(value as (...a: unknown[]) => unknown).apply(this ?? obj, args);
					if (isThenable(result)) {
						return result.catch((err: unknown) => {
							redactAuthorizationHeader(err, token);
							throw err;
						});
					}
					if (isAsyncIterable(result)) {
						return wrapAsyncIterable(result, token);
					}
					return result;
				} catch (err) {
					redactAuthorizationHeader(err, token);
					throw err;
				}
			};
		},
	});
}
