/**
 * 请求限速。
 *
 * 在每次请求前等待，而非失败后重试。遇到 567/514 时整个进程冷却 3 分钟。
 * 全进程共用一个队列，不按 wiki 区分。
 */

import { logger } from '../runtime/logger.ts';

/** EdgeOne 的拦截状态码。 */
export const EDGEONE_BLOCK_STATUS = new Set([567, 514]);

/** 567/514 后的冷却时长。 */
export const COOLDOWN_MS = 3 * 60 * 1000;

/** 相邻两次请求的最小间隔。 */
export const MIN_INTERVAL_MS = 1100;

export interface ThrottleOptions {
	minIntervalMs?: number;
	cooldownMs?: number;
}

/** 串行队列：请求逐一发出，按 `minIntervalMs` 间隔。 */
export class RequestThrottle {
	private readonly minIntervalMs: number;
	private readonly cooldownMs: number;

	/** 串行化：下一次请求必须等此 promise 完成。 */
	private tail: Promise<void> = Promise.resolve();

	/** Timestamp of the last request that actually went out. */
	private lastSentAt = 0;

	/** When the cooldown started, or 0 when there is none. */
	private cooldownUntil = 0;

	constructor(options: ThrottleOptions = {}) {
		this.minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
		this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
	}

	/** True while a recorded block is still in force. */
	get inCooldown(): boolean {
		return Date.now() < this.cooldownUntil;
	}

	/**
	 * 按间隔等待后执行 `send`。
	 *
	 * 调用方用 `reportBlock(status)` 回传状态。冷却作用于下一次请求。
	 */
	async run<T>(send: () => Promise<T>): Promise<T> {
		// 排在已有等待之后，并发调用也会串行。
		const prior = this.tail;
		let release: () => void = () => {};
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});

		try {
			await prior;
			await this.waitTurn();
		} finally {
			release();
		}

		return send();
	}

	/** 记录被拦截，进入冷却。仅识别 567 与 514。 */
	reportBlock(status: number | undefined, context?: string): void {
		if (status === undefined || !EDGEONE_BLOCK_STATUS.has(status)) return;
		if (this.inCooldown) return;
		this.cooldownUntil = Date.now() + this.cooldownMs;
		logger.error(
			`BWiki blocked the request (HTTP ${status}). ` +
				`Pausing all requests for ${Math.round(this.cooldownMs / 1000)} seconds.` +
				(context ? ` Context: ${context}` : ''),
		);
	}

	/** 记录请求完成，供下一次计算间隔。成功与否都要调用。 */
	noteSent(): void {
		this.lastSentAt = Date.now();
	}

	/** 等待轮到本次请求。 */
	private async waitTurn(): Promise<void> {
		for (;;) {
			const now = Date.now();
			const cooldownRemaining = this.cooldownUntil - now;
			if (cooldownRemaining > 0) {
				await sleep(cooldownRemaining);
				continue;
			}
			const sinceLast = now - this.lastSentAt;
			if (sinceLast < this.minIntervalMs) {
				await sleep(this.minIntervalMs - sinceLast);
			}
			return;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
