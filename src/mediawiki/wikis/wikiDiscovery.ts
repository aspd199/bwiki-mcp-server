import { errorMessage } from '../errors/isErrnoException.ts';
import { WikiTimeoutError } from '../errors/wikiTimeoutError.ts';
import type { CallDeadline } from '../runtime/callDeadline.ts';
import { makeApiRequest, fetchPageHtml } from '../httpFetch.ts';
import { assertPublicDestination } from '../ssrfGuard.ts';
import { logger } from '../runtime/logger.ts';
import { normalizeServer } from './normalizeServer.ts';

const COMMON_SCRIPT_PATHS = ['/w', ''];

/** Whether a rejection is the budget expiring rather than the host answering. */
function isAborted(error: unknown): boolean {
	return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

interface MediaWikiActionApiSiteInfoGeneral {
	sitename: string;
	articlepath: string;
	scriptpath: string;
	server: string;
	servername: string;
}

interface MediaWikiActionApiSiteInfoQuery {
	general: MediaWikiActionApiSiteInfoGeneral;
}

interface MediaWikiActionApiResponse {
	query?: MediaWikiActionApiSiteInfoQuery;
}

export interface WikiInfo {
	sitename: string;
	articlepath: string;
	scriptpath: string;
	server: string;
	servername: string;
}

async function fetchWikiInfoFromApi(
	wikiServer: string,
	scriptPath: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	const baseUrl = `${wikiServer}${scriptPath}/api.php`;
	const params = {
		action: 'query',
		meta: 'siteinfo',
		siprop: 'general',
		format: 'json',
		origin: '*',
	};

	let data: MediaWikiActionApiResponse | null = null;
	try {
		data = await makeApiRequest<MediaWikiActionApiResponse>(baseUrl, params, {
			signal: deadline.signal,
		});
	} catch (error) {
		// 路径错误返回 404，继续尝试下一个候选。
		// 超时不是路径错误，不能按此报告。
		if (isAborted(error)) {
			throw new WikiTimeoutError(deadline.timeoutMs, deadline.phase);
		}
		logger.error('Error fetching wiki info', {
			baseUrl,
			error: errorMessage(error),
		});
		return null;
	}

	if (data === null || data.query?.general === undefined) {
		return null;
	}

	const general = data.query.general;

	if (typeof general.scriptpath !== 'string') {
		return null;
	}

	return {
		sitename: general.sitename,
		scriptpath: general.scriptpath,
		articlepath: general.articlepath.replace('/$1', ''),
		server: normalizeServer(general.server),
		servername: general.servername,
	};
}

async function fetchUsingCommonScriptPaths(
	wikiServer: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	for (const candidatePath of COMMON_SCRIPT_PATHS) {
		const apiResult = await fetchWikiInfoFromApi(wikiServer, candidatePath, deadline);
		if (apiResult) {
			return apiResult;
		}
	}
	return null;
}

function extractScriptPathFromSearchForm(htmlContent: string, wikiServer: string): string | null {
	const searchFormMatch = htmlContent.match(
		/<form[^>]+id=['"]searchform['"][^>]+action=['"]([^'"]*index\.php[^'"]*)['"]/i,
	);
	if (searchFormMatch && searchFormMatch[1]) {
		const actionAttribute = searchFormMatch[1];
		try {
			const fullActionUrl = new URL(actionAttribute, wikiServer);
			const path = fullActionUrl.pathname;
			const indexPathIndex = path.toLowerCase().lastIndexOf('/index.php');
			if (indexPathIndex !== -1) {
				return path.slice(0, indexPathIndex);
			}
		} catch (error) {
			logger.warning('Error extracting script path from search form', {
				error: errorMessage(error),
			});
		}
	}
	return null;
}

function extractScriptPathsFromHtml(htmlContent: string | null, wikiServer: string): string[] {
	const candidatesFromHtml: string[] = [];
	if (htmlContent) {
		const fromSearchForm = extractScriptPathFromSearchForm(htmlContent, wikiServer);
		if (fromSearchForm !== null) {
			candidatesFromHtml.push(fromSearchForm);
		}
	}

	const uniqueCandidatesFromHtml = [...new Set(candidatesFromHtml)];
	return uniqueCandidatesFromHtml.filter(
		(p) => typeof p === 'string' && (p === '' || p.trim() !== ''),
	);
}

async function fetchUsingScriptPathsFromHtml(
	wikiServer: string,
	originalWikiUrl: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	const htmlContent = await fetchPageHtml(originalWikiUrl, { signal: deadline.signal });
	// fetchPageHtml 把所有失败都当作无内容（含中止），故在此单独检查预算。
	if (deadline.signal.aborted) {
		throw new WikiTimeoutError(deadline.timeoutMs, deadline.phase);
	}
	const htmlScriptPathCandidates = extractScriptPathsFromHtml(htmlContent, wikiServer);
	const pathsToTry =
		htmlScriptPathCandidates.length > 0 ? htmlScriptPathCandidates : COMMON_SCRIPT_PATHS;

	for (const candidatePath of pathsToTry) {
		const apiResult = await fetchWikiInfoFromApi(wikiServer, candidatePath, deadline);
		if (apiResult) {
			return apiResult;
		}
	}

	return null;
}

async function getWikiInfo(
	wikiServer: string,
	originalWikiUrl: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	return (
		(await fetchUsingCommonScriptPaths(wikiServer, deadline)) ??
		(await fetchUsingScriptPathsFromHtml(wikiServer, originalWikiUrl, deadline))
	);
}

function parseWikiUrl(wikiUrl: string): string {
	const url = new URL(wikiUrl);
	return `${url.protocol}//${url.host}`;
}

/**
 * `deadline` 覆盖整个发现过程而非单次请求。
 * `fetchCore` 自身不设超时，故需此处兜底。
 *
 * `assertPublicDestination` 内的 DNS 查询不接受信号，会一直占用预算。
 */
export async function discoverWiki(
	wikiUrl: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	await assertPublicDestination(wikiUrl);
	const wikiServer = parseWikiUrl(wikiUrl);
	const info = await getWikiInfo(wikiServer, wikiUrl, deadline);
	if (info !== null) {
		await assertPublicDestination(info.server);
	}
	return info;
}
