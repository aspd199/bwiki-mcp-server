/**
 * 登录门：无会话或会话失效时，为工具调用提供交互式登录。
 *
 * 不阻塞调用方：登录页在后台等待用户操作，本次调用立即返回提示，
 * 用户完成登录后重发请求即可。并发调用共享同一次登录流程。
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../runtime/logger.ts';
import { DEFAULT_SESSION_FILE } from '../config/loadConfig.ts';
import { loginViaOfficialPage, type OfficialLoginResult } from './passportLogin.ts';
import { sessionLiveness } from './liveness.ts';
import type { MwnProvider } from '../wikis/mwnProvider.ts';

export interface LoginGate {
	/** 确保已登录。未登录时启动登录流程并立即返回等待提示。 */
	ensureLoggedIn(): { ready: boolean; message: string };
	/** 强制重新登录：复位登录态后启动登录流程，供会话失效时使用。 */
	restartLogin(): { ready: boolean; message: string };
	/** 清除已存会话并复位登录态，供 logout 使用。 */
	forget(): Promise<void>;
	/** 标记为已登录，由启动期会话校验通过时调用。 */
	markLoggedIn(): void;
	/** 当前是否已登录。 */
	isLoggedIn(): boolean;
}

interface SessionRecord {
	passportCookie: string;
	wikiCookie: string;
	userId: string;
	savedAt: number;
}

/** 写会话文件，格式与 bwiki-login 一致。 */
async function writeSessionFile(file: string, cookie: string, userId: string): Promise<void> {
	const record: SessionRecord = {
		passportCookie: cookie,
		// 留空：api.php 直接接受 passport cookie。
		wikiCookie: '',
		userId,
		savedAt: Date.now(),
	};
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(record, null, 2), 'utf8');
}

export class LoginGateImpl implements LoginGate {
	private inflight: Promise<boolean> | null = null;
	private loggedIn = false;
	private noBrowser = false;

	public constructor(
		private readonly sessionFile: string = DEFAULT_SESSION_FILE,
		private readonly mwnProvider?: Pick<MwnProvider, 'invalidatePassportSession'>,
	) {}

	public isLoggedIn(): boolean {
		return this.loggedIn;
	}

	/** 标记为已登录，由启动期会话校验通过时调用。 */
	markLoggedIn(): void {
		this.loggedIn = true;
	}

	/**
	 * 强制重新登录。复位登录态后启动登录流程，立即返回。
	 *
	 * 供会话失效时使用：此时 loggedIn 仍为 true，ensureLoggedIn 会直接放行，
	 * 必须显式复位才能重新走登录。
	 */
	public restartLogin(): { ready: boolean; message: string } {
		this.loggedIn = false;
		return this.ensureLoggedIn();
	}

	public ensureLoggedIn(): { ready: boolean; message: string } {
		if (this.loggedIn) {
			return { ready: true, message: '' };
		}
		// 启动后立即返回，不在本次调用里等待用户操作。
		// 并发调用共享同一次登录，避免弹出多个浏览器窗口。
		const alreadyRunning = this.inflight !== null;
		if (!alreadyRunning) {
			this.inflight = this.startLogin().finally(() => {
				this.inflight = null;
			});
		}
		return {
			ready: false,
			message: this.noBrowser
				? '未登录，且当前环境禁止打开浏览器（BWIKI_MCP_NO_BROWSER_LOGIN）。' +
					'请先在命令行运行 bwiki-mcp-server login 完成登录。'
				: alreadyRunning
					? '登录已在进行中：请在已打开的 bilibili 登录页完成登录，成功后重发本次请求。'
					: '需要登录：已打开 bilibili 登录页，请在浏览器中完成登录，' +
						'成功后重发本次请求。若浏览器未弹出，可调用 bwiki-login 工具。',
		};
	}

	private async startLogin(): Promise<boolean> {
		// 会话曾被判失效时先复位，否则后续 assertAlive 仍会拒绝。
		sessionLiveness.reset();

		// 无人值守环境（测试、CI）不弹浏览器，直接记为失败。
		if (process.env.BWIKI_MCP_NO_BROWSER_LOGIN === '1') {
			logger.info('login gate: browser login disabled by BWIKI_MCP_NO_BROWSER_LOGIN');
			this.noBrowser = true;
			return false;
		}

		try {
			const result: OfficialLoginResult = await loginViaOfficialPage();
			if (!result.userId) {
				logger.error('login gate: no bilibili user id returned');
				return false;
			}
			await writeSessionFile(this.sessionFile, result.cookie, result.userId);
			// 丢弃可能缓存了「无会话」结论的 provider，使新实例读到期望文件。
			this.mwnProvider?.invalidatePassportSession();
			sessionLiveness.setIdentity(result.userId);
			this.loggedIn = true;
			logger.info(`login gate: logged in as ${result.userId}`);
			return true;
		} catch (err) {
			logger.error(`login gate: login failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	public async forget(): Promise<void> {
		this.loggedIn = false;
		this.mwnProvider?.invalidatePassportSession();
		await rm(this.sessionFile, { force: true }).catch(() => undefined);
	}
}
