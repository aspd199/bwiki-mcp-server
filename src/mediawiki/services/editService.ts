import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ApiParams, Mwn } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import type { ApiUploadResponse } from 'mwn';
import type { ActiveWiki } from '../wikis/activeWiki.ts';

export interface EditService {
	/** Wraps mwn.request with CSRF + tag injection + formatversion=2. For action:edit and similar. */
	submit(mwn: Mwn, params: Record<string, unknown>): Promise<unknown>;

	/**
	 * Uploads a local file via a multipart action=upload. Reads the file into
	 * memory and delegates to submitUploadFromBytes: mwn.upload builds the
	 * multipart body from fs.createReadStream, whose length is unknown, and
	 * BWiki hangs up on that.
	 */
	submitUpload(
		mwn: Mwn,
		filepath: string,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse>;

	/** Uploads in-memory bytes via a multipart action=upload — parallel to submitUpload but without a local filepath. Injects CSRF token, tags, and ignorewarnings. The bytes are passed to form-data as a Buffer (a plain Readable has no length and form-data rejects it with "Unknown stream"). */
	submitUploadFromBytes(
		mwn: Mwn,
		data: Buffer,
		filename: string,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse>;

	/** Pure helper: returns options with tags injected from the targeted wiki's config. Used by mwn.create/delete/undelete callers. */
	applyTags<T extends Record<string, unknown>>(options: T): T;

	/**
	 * 查询账号是否具备 `bot` 权限。探测失败不阻塞写入，结果按 Mwn 实例缓存。
	 */
	botRight(mwn: Mwn): Promise<boolean | undefined>;
}

export class EditServiceImpl implements EditService {
	public constructor(private readonly activeWiki: ActiveWiki) {}

	private readonly botRightCache = new WeakMap<Mwn, Promise<boolean>>();

	public async botRight(mwn: Mwn): Promise<boolean | undefined> {
		let pending = this.botRightCache.get(mwn);
		if (!pending) {
			pending = this.queryBotRight(mwn);
			this.botRightCache.set(mwn, pending);
		}
		try {
			return await pending;
		} catch {
			// 失败的探测不缓存，以便下次重试。
			if (this.botRightCache.get(mwn) === pending) {
				this.botRightCache.delete(mwn);
			}
			return undefined;
		}
	}

	private async queryBotRight(mwn: Mwn): Promise<boolean> {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const response = (await mwn.request({
			action: 'query',
			meta: 'userinfo',
			uiprop: 'rights',
			formatversion: '2',
		})) as { query?: { userinfo?: { rights?: string[] } } };
		return response.query?.userinfo?.rights?.includes('bot') ?? false;
	}

	public async submit(mwn: Mwn, params: Record<string, unknown>): Promise<unknown> {
		const token = await mwn.getCsrfToken();
		const tags = this.activeWiki.get().config.tags;
		const fullParams: Record<string, unknown> = { ...params, token, formatversion: '2' };
		if (tags !== null && tags !== undefined) {
			fullParams.tags = tags;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn ApiParams shape; we assemble fullParams to match the typed contract
		return mwn.request(fullParams as ApiParams);
	}

	public async submitUpload(
		mwn: Mwn,
		filepath: string,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse> {
		// 不调 mwn.upload：它用 fs.createReadStream 构造 multipart，而 Readable
		// 没有已知长度，BWiki 会挂断连接（约 55 秒后 socket hang up）。
		// 改成读成 Buffer 走 submitUploadFromBytes，长度已知，可正常发送。
		const data = await readFile(filepath);
		return this.submitUploadFromBytes(mwn, data, basename(filepath), title, text, params);
	}

	public async submitUploadFromBytes(
		mwn: Mwn,
		data: Buffer,
		filename: string,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse> {
		const token = await mwn.getCsrfToken();
		const tags = this.activeWiki.get().config.tags;
		// 直接把 Buffer 交给 mwn 的 multipart `file` 字段：
		// form-data 可直接计算 Buffer 长度，而 Readable 无已知长度会被拒绝。
		const fullParams: Record<string, unknown> = {
			action: 'upload',
			file: { stream: data, name: filename },
			filename: title,
			text,
			ignorewarnings: true,
			token,
			...params,
		};
		if (tags !== null && tags !== undefined) {
			fullParams.tags = tags;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn ApiParams shape; the multipart `file` field is mwn's documented upload form
		const response = (await mwn.request(fullParams as ApiParams, {
			headers: { 'Content-Type': 'multipart/form-data' },
		})) as { upload: ApiUploadResponse };
		return response.upload;
	}

	public applyTags<T extends Record<string, unknown>>(options: T): T {
		const tags = this.activeWiki.get().config.tags;
		if (tags === null || tags === undefined) {
			return { ...options };
		}
		return { ...options, tags };
	}
}
