import type { Mwn } from 'mwn';
import { logger } from '../runtime/logger.ts';

/** BWiki 账号名即 bilibili UID：纯数字，长度至少 5。 */
const UID_PATTERN = /^\d{5,}$/;

export function isBilibiliUid(name: unknown): boolean {
	return typeof name === 'string' && UID_PATTERN.test(name);
}

export class SessionExpiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SessionExpiredError';
	}
}

/**
 * 会话存活状态，进程级单例。
 *
 * 所有 wiki 共用一份 session，故一处判死即对全部成立。
 */
class SessionLiveness {
	private dead: string | null = null;
	private onDeath: ((reason: string) => void) | null = null;
	private uid: string | null = null;

	/** 启动时设置一次。 */
	setDeathHandler(handler: (reason: string) => void): void {
		this.onDeath = handler;
	}

	/** 记录当前会话的 bilibili UID，供审计日志使用。 */
	setIdentity(uid: string | null): void {
		this.uid = uid;
	}

	get identity(): string | null {
		return this.uid;
	}

	get deathReason(): string | null {
		return this.dead;
	}

	/** 标记会话失效并触发退出。幂等。 */
	markDead(reason: string): void {
		if (this.dead !== null) return;
		this.dead = reason;
		logger.error(`bwiki session ended: ${reason}`);
		this.onDeath?.(reason);
	}

	/**
	 * 清除失效记录与身份，供重新登录后恢复服务。
	 * 不断开连接：调用方负责在恢复后放行后续请求。
	 */
	reset(): void {
		this.dead = null;
		this.uid = null;
	}

	/**
	 * 确认 wiki 仍将当前凭证识别为已登录用户。
	 *
	 * 失效时抛出 SessionExpiredError；传输失败按原样抛出，不计为登出。
	 */
	async assertAlive(bot: Mwn, wikiKey: string): Promise<void> {
		const known = this.dead;
		if (known !== null) {
			throw new SessionExpiredError(known);
		}

		const user = await bot.userinfo();

		const name = user?.name ?? user?.userName;
		if (isBilibiliUid(name)) {
			return;
		}

		const reason =
			`登录会话已失效：wiki "${wikiKey}" 不再识别当前身份 ` +
			`(userinfo.name=${name ?? 'none'}，应为 bilibili UID)。` +
			'为免以出口 IP 署名写入，服务将断开连接。请重新调用 bwiki-login 登录。';
		this.markDead(reason);
		throw new SessionExpiredError(reason);
	}
}

export const sessionLiveness = new SessionLiveness();
