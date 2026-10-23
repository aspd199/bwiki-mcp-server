import type { ApiDeleteResponse, ApiMoveResponse, ApiUndeleteResponse } from 'mwn';
import type { ApiDeleteParams, ApiMoveParams, ApiUndeleteParams } from 'types-mediawiki-api';

/**
 * mwn 的页面写操作，`reason` 允许为 `undefined`。
 *
 * 值为 `undefined` 时不上送该参数，这是完全不写理由的唯一方式。
 */
export interface PageWrites {
	delete(
		title: string | number,
		reason: string | undefined,
		options?: ApiDeleteParams,
	): Promise<ApiDeleteResponse>;
	undelete(
		title: string,
		reason: string | undefined,
		options?: ApiUndeleteParams,
	): Promise<ApiUndeleteResponse>;
	move(
		fromTitle: string,
		toTitle: string,
		reason: string | undefined,
		options?: ApiMoveParams,
	): Promise<ApiMoveResponse>;
}
