import { Readable } from 'node:stream';
import fetch, { Response, FetchError } from 'node-fetch';
import { USER_AGENT, refererFor } from './runtime/constants.ts';
import { FARM_HOST } from './config/loadConfig.ts';
import { isErrnoException } from './errors/isErrnoException.ts';
import { assertPublicDestination, buildPinnedAgent, SsrfValidationError } from './ssrfGuard.ts';
import {
	firstRequest,
	nextHop,
	type FetchSpec,
	type HopRequest,
	type HopResponse,
} from './requestChain.ts';

/** The request, plus its cancellation. */
type FetchOptions = FetchSpec & { signal?: AbortSignal };

/** A failing source's explanation is worth reporting; its length is the source's choice. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;

// 表示"服务端无法访问源站"的 syscall 错误码，应转交 wiki 侧 copy-upload。
// DNS 失败来自 assertPublicDestination 的解析，早于 node-fetch，故为普通 Error。
const RESCUABLE_SYSCALL_CODES = new Set([
	'ENOTFOUND',
	'EAI_AGAIN',
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'EHOSTUNREACH',
	'ENETUNREACH',
]);

const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const FETCH_TIMEOUT_MS = 30_000;

// 服务端抓取的内存上限，超限时转交 wiki 侧 copy-upload，不报错。
function resolveUploadMaxBytes(): number {
	const raw = process.env.MCP_UPLOAD_MAX_BYTES;
	if (raw === undefined || raw === '') {
		return DEFAULT_UPLOAD_MAX_BYTES;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_UPLOAD_MAX_BYTES;
	}
	return parsed;
}

/** A fetched URL responded with a non-2xx status: the source was reachable but rejected the request. */
export class HttpStatusError extends Error {
	public readonly status: number;
	/** The response body, kept apart from the message for callers that report the source's own diagnostics. */
	public readonly body?: string;
	public constructor(status: number, url: string, body?: string) {
		super(`HTTP error! status: ${status} for URL: ${url}.${body ? ` Response: ${body}` : ''}`);
		this.name = 'HttpStatusError';
		this.status = status;
		this.body = body;
	}
}

/** A fetched body exceeded the server-side size cap for the fetch that asked for it. */
export class FileTooLargeError extends Error {
	public readonly size: number;
	public readonly limit: number;
	/** `limitName` names the setting behind the cap, when a setting is what set it. */
	public constructor(size: number, limit: number, limitName?: string) {
		const source = limitName === undefined ? '' : ` (${limitName})`;
		super(`Fetched body is ${size} bytes, over the ${limit}-byte limit${source}.`);
		this.name = 'FileTooLargeError';
		this.size = size;
		this.limit = limit;
	}
}

/** 按重定向链逐跳请求，未交付的响应统一在此释放。 */
async function fetchCore(baseUrl: string, options?: FetchOptions): Promise<Response> {
	let request = firstRequest(baseUrl, options);
	for (;;) {
		const response = await sendHop(request, options?.signal);
		const decision = nextHop(request, readHop(response));
		if (decision.kind === 'deliver') {
			return await delivered(response);
		}
		destroyBody(response);
		if (decision.kind === 'refuse') {
			throw decision.error;
		}
		request = decision.request;
	}
}

/**
 * 仅对 BWiki 目标返回 Referer。
 *
 * 此通道也承载 `upload-file-from-url`，向无关主机伪造来源是不正确的。
 */
function refererHeaderFor(targetUrl: string): Record<string, string> {
	const referer = refererFor(targetUrl);
	if (referer === undefined) return {};
	return new URL(referer).hostname === FARM_HOST
		? { Referer: referer }
		: {};
}

/** One hop, through the SSRF guard and an agent pinned to what it resolved. */
async function sendHop(request: HopRequest, signal?: AbortSignal): Promise<Response> {	const addresses = await assertPublicDestination(request.url);
	const agent = buildPinnedAgent(request.url, addresses);
	// 已中止的请求若带 body，node-fetch 会销毁流并触发未处理的 error 事件。
	// 在此提前拒绝，抛出 signal 自身的原因以保留 AbortError。
	signal?.throwIfAborted();
	return await fetch(request.url, {
		headers: { 'User-Agent': USER_AGENT, ...refererHeaderFor(request.url), ...request.headers },
		method: request.method,
		...(request.body === undefined ? {} : { body: request.body }),
		redirect: 'manual',
		agent,
		signal,
	});
}

/** The two fields the decision reads. */
function readHop(response: Response): HopResponse {
	return { status: response.status, location: response.headers.get('location') };
}

/** A 2xx passes through; anything else becomes the source's own diagnostics. */
async function delivered(response: Response): Promise<Response> {
	if (response.ok) {
		return response;
	}
	const errorBody = await readTruncated(response, MAX_ERROR_BODY_BYTES).catch(() => '');
	throw new HttpStatusError(response.status, response.url, errorBody);
}

/**
 * 最多读取 `maxBytes`，其余丢弃。截断而非拒绝，以免掩盖原错误。
 * nothing.
 */
async function readTruncated(response: Response, maxBytes: number): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	if (response.body !== null) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node-fetch v3 body is always a Node.js Readable; narrowing to AsyncIterable<Buffer> is safe at this boundary
		for await (const chunk of response.body as AsyncIterable<Buffer>) {
			chunks.push(chunk);
			total += chunk.length;
			if (total >= maxBytes) {
				break;
			}
		}
	}
	destroyBody(response);
	return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
}

export async function makeApiRequest<T>(
	url: string,
	params?: Record<string, string>,
	options?: { signal?: AbortSignal },
): Promise<T> {
	const response = await fetchCore(url, {
		params,
		headers: { Accept: 'application/json' },
		signal: options?.signal,
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- HTTP response body; trusted JSON envelope at this boundary
	return (await response.json()) as T;
}

/**
 * 以 form-encoded 方式 POST，经 SSRF 校验后返回响应文本。
 *
 * 非 2xx 抛 HttpStatusError，超限抛 FileTooLargeError。
 */
export async function postForm(
	url: string,
	form: Record<string, string>,
	options?: { headers?: Record<string, string>; signal?: AbortSignal; maxBytes?: number },
): Promise<string> {
	const response = await fetchCore(url, {
		body: new URLSearchParams(form).toString(),
		headers: { ...options?.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
		signal: options?.signal,
	});
	if (options?.maxBytes === undefined) {
		return await response.text();
	}
	return (await readCapped(response, options.maxBytes)).toString('utf8');
}

/**
 * 在字节上限内读入响应体，按声明长度与累计长度各校验一次。
 * 拒绝前先释放响应体，否则会占用连接。
 */
async function readCapped(
	response: Response,
	maxBytes: number,
	limitName?: string,
): Promise<Buffer> {
	try {
		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > maxBytes) {
			throw new FileTooLargeError(declared, maxBytes, limitName);
		}
		const chunks: Buffer[] = [];
		let total = 0;
		if (response.body !== null) {
			// node-fetch v3 的 body 是可异步迭代的 Node Readable。
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node-fetch v3 body is always a Node.js Readable; narrowing to AsyncIterable<Buffer> is safe at this boundary
			for await (const chunk of response.body as AsyncIterable<Buffer>) {
				total += chunk.length;
				if (total > maxBytes) {
					throw new FileTooLargeError(total, maxBytes, limitName);
				}
				chunks.push(chunk);
			}
		}
		return Buffer.concat(chunks);
	} catch (error) {
		destroyBody(response);
		throw error;
	}
}

/** 释放不会被读取的响应体所持有的连接。 */
function destroyBody(response: Response): void {
	// v3 的类型声明为 NodeJS.ReadableStream（无 destroy），故用 instanceof 收窄。
	if (response.body instanceof Readable) {
		response.body.destroy();
	}
}

export async function fetchPageHtml(
	url: string,
	options?: { signal?: AbortSignal },
): Promise<string | null> {
	try {
		const response = await fetchCore(url, { signal: options?.signal });
		return await response.text();
	} catch {
		return null;
	}
}

/**
 * 经 SSRF 校验抓取 URL 字节，受大小与超时限制，不向源站发送 wiki 凭证。
 * 异常类型见 shouldRescueToWiki() 的判断。
 */
export async function fetchFileBytes(
	url: string,
	options?: { maxBytes?: number; timeoutMs?: number },
): Promise<Buffer> {
	const maxBytes = options?.maxBytes ?? resolveUploadMaxBytes();
	const timeoutMs = options?.timeoutMs ?? FETCH_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await readCapped(
			await fetchCore(url, { signal: controller.signal }),
			maxBytes,
			'MCP_UPLOAD_MAX_BYTES',
		);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 服务端抓取失败时是否转交 wiki 侧 copy-upload。
 * 源站不可达或超限时转交；源站已拒绝请求时不转交。
 */
export function shouldRescueToWiki(error: unknown): boolean {
	if (error instanceof HttpStatusError) {
		return false;
	}
	if (
		error instanceof FileTooLargeError ||
		error instanceof SsrfValidationError ||
		error instanceof FetchError
	) {
		return true;
	}
	if (isErrnoException(error)) {
		if (error.name === 'AbortError') {
			return true;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isErrnoException narrows to Error; `code` is optional and read only for the membership test below
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'string' && RESCUABLE_SYSCALL_CODES.has(code)) {
			return true;
		}
	}
	return false;
}
