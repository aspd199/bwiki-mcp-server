import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiPage, ApiRevision } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import type { TruncationInfo } from '../results/truncation.ts';

const PAGE_HISTORY_LIMIT = 20;

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	olderThan: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Revision ID — return revisions older than this (exclusive). Mutually exclusive with newerThan.',
		),
	newerThan: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Revision ID — return revisions newer than this (exclusive). Mutually exclusive with olderThan.',
		),
	filter: z.string().optional().describe('Change tag — return only revisions carrying this tag'),
} as const;

export const getPageHistory: Tool<typeof inputSchema> = {
	name: 'get-page-history',
	description: `Returns revision metadata (revision ID, timestamp, user, comment, size, minor flag) for a wiki page, in segments of ${PAGE_HISTORY_LIMIT} revisions, newest first. Paginate with olderThan or newerThan (mutually exclusive). If the title does not exist, an error is returned. Boolean flags appear only when true.`,
	inputSchema,
	annotations: {
		title: 'Get page history',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'retrieve page history',
	target: (a) => a.title,

	async handle({ title, olderThan, newerThan, filter }, ctx: ToolContext): Promise<CallToolResult> {
		if (olderThan && newerThan) {
			return ctx.format.invalidInput('olderThan and newerThan are mutually exclusive');
		}

		const mwn = await ctx.mwn();
		const boundaryId = olderThan ?? newerThan;

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			prop: 'revisions',
			titles: title,
			rvprop: 'ids|timestamp|user|userid|comment|size|flags|tags',
			// 指定边界时多取一条：rvstartid 是闭区间，边界在下方过滤掉。
			rvlimit: PAGE_HISTORY_LIMIT + (boundaryId ? 1 : 0),
			formatversion: '2',
		};

		// olderThan 与 newerThan 都用 rvstartid 作为枚举锚点，仅方向不同。
		// 默认 rvdir=older 从新到旧，故 olderThan 无需覆盖 rvdir。
		if (boundaryId) {
			params.rvstartid = boundaryId;
			if (newerThan) {
				params.rvdir = 'newer';
			}
		}

		if (filter) {
			params.rvtag = filter;
		}

		const response = await mwn.request(params);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const page = response.query?.pages?.[0] as ApiPage | undefined;

		if (page?.missing) {
			return ctx.format.notFound(`Page "${title}" not found`);
		}

		const revisions: ApiRevision[] = page?.revisions ?? [];

		// rvstartid 为闭区间，过滤掉边界以保持排他语义，
		// 并对结果截断以防边界不在窗口内。
		const filteredRevisions = boundaryId
			? revisions.filter((rev) => rev.revid !== boundaryId).slice(0, PAGE_HISTORY_LIMIT)
			: revisions;

		let truncation: TruncationInfo | null = null;
		if (response.continue?.rvcontinue && filteredRevisions.length > 0) {
			const walkingForward = newerThan !== undefined;
			const anchorRev = filteredRevisions[filteredRevisions.length - 1].revid!;
			truncation = {
				reason: 'more-available',
				returnedCount: filteredRevisions.length,
				itemNoun: 'revisions',
				toolName: 'get-page-history',
				continueWith: {
					param: walkingForward ? 'newerThan' : 'olderThan',
					value: anchorRev,
				},
			};
		}

		return ctx.format.ok({
			revisions: filteredRevisions.map((r) => {
				const tags = (r as ApiRevision & { tags?: string[] }).tags;
				return {
					revisionId: r.revid!,
					timestamp: r.timestamp!,
					user: r.user,
					userid: r.userid,
					size: r.size,
					...(r.comment ? { comment: r.comment } : {}),
					...(r.minor ? { minor: true } : {}),
					...(tags && tags.length > 0 ? { tags } : {}),
				};
			}),
			...(truncation !== null ? { truncation } : {}),
		});
	},
};
