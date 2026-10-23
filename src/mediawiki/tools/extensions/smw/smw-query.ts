import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import type { TruncationInfo } from '../../../results/truncation.ts';

const HARD_LIMIT = 500;

const inputSchema = {
	query: z
		.string()
		.describe(
			'SMW #ask query. Conditions: `[[Property::value]]`. Printouts: `|?Property`. ' +
				'Parameters: `|limit=N`, `|offset=N`, `|sort=Property`, `|order=asc/desc`.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(HARD_LIMIT)
		.optional()
		.describe('Overrides |limit= in query if both are set.'),
	continueFrom: z
		.string()
		.optional()
		.describe('Opaque continuation token from a previous response; omit on first call.'),
} as const;

interface SmwResultRow {
	fulltext?: string;
	namespace?: number;
	pageid?: number;
	printouts?: Record<string, unknown[]>;
}

interface SmwQueryResponse {
	query?: {
		results?: Record<string, SmwResultRow>;
		errors?: string[];
		meta?: { count?: number; offset?: number };
	};
	'query-continue-offset'?: number;
}

interface NormalizedRow {
	title: string;
	pageId?: number;
	namespace: number;
	printouts: Record<string, unknown[]>;
}

export const smwQuery: Tool<typeof inputSchema> = {
	name: 'smw-query',
	description:
		"Runs a Semantic MediaWiki `#ask` query against the targeted wiki. Enabled only when the wiki has SMW installed. One row per matching page, with the requested printouts as columns. For grounded property names, use smw-list-properties first.\n\nExamples:\n- Pages in a category: [[Category:Person]]|?Has occupation|limit=20\n- Numeric comparison: [[Born in::>1900]]|?Has name|?Born in\n- Multiple conditions: [[Category:Person]][[Born in::>1900]][[Has occupation::Architect]]\n\nNumeric operators: write `>N` and `<N`; SMW's default config treats them as ≥ and ≤. `>=` and `<=` are rejected unless the wiki enables strict comparators (`$smwStrictComparators`).\n\nUp to 500 rows per call; paginate with continueFrom. Syntax errors return the SMW message verbatim.",
	inputSchema,
	annotations: {
		title: 'Run SMW query',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'run SMW query',
	target: (a) => a.query,

	async handle({ query, limit, continueFrom }, ctx: ToolContext): Promise<CallToolResult> {
		const merged = mergeQueryParams(query, limit, continueFrom);
		const mwn = await ctx.mwn();
		const raw = await mwn.request({
			action: 'ask',
			query: merged,
			format: 'json',
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SMW action=ask response shape; trusted at this boundary
		const response = raw as SmwQueryResponse;

		const errors = response.query?.errors;
		if (Array.isArray(errors) && errors.length > 0) {
			return ctx.format.invalidInput(errors.join('; '));
		}

		const resultsMap = response.query?.results ?? {};
		const rows: NormalizedRow[] = Object.entries(resultsMap).map(([title, row]) =>
			normalizeRow(title, row),
		);

		// 按 action=ask 文档，query-continue-offset 应为数字。
		// 若某代理返回字符串，分页会静默停止。
		const continueOffset = response['query-continue-offset'];
		const truncation: TruncationInfo | null =
			typeof continueOffset === 'number'
				? {
						reason: 'more-available',
						returnedCount: rows.length,
						itemNoun: 'rows',
						toolName: 'smw-query',
						continueWith: { param: 'continueFrom', value: String(continueOffset) },
					}
				: null;

		return ctx.format.ok({
			rows,
			...(truncation !== null ? { truncation } : {}),
		});
	},
};

function normalizeRow(title: string, row: SmwResultRow): NormalizedRow {
	const printouts: Record<string, unknown[]> = {};
	for (const [key, value] of Object.entries(row.printouts ?? {})) {
		if (Array.isArray(value) && value.length > 0) {
			printouts[key] = value;
		}
	}
	return {
		title: row.fulltext ?? title,
		...(typeof row.pageid === 'number' ? { pageId: row.pageid } : {}),
		namespace: typeof row.namespace === 'number' ? row.namespace : 0,
		printouts,
	};
}

function mergeQueryParams(
	rawQuery: string,
	schemaLimit: number | undefined,
	continueFrom: string | undefined,
): string {
	// 从用户查询中移除已有的 |limit= 与 |offset=，再追加本服务的值。
	// 各 SMW 版本对重复参数的取舍不一致，故显式移除后重加。
	const stripped = rawQuery
		.split('|')
		.filter((segment, index) => {
			if (index === 0) {
				return true; // conditions
			}
			const trimmed = segment.trim();
			return !/^limit\s*=/i.test(trimmed) && !/^offset\s*=/i.test(trimmed);
		})
		.join('|');

	const embeddedLimitMatch = rawQuery.match(/\|\s*limit\s*=\s*(\d+)/i);
	const embeddedLimit = embeddedLimitMatch ? Number.parseInt(embeddedLimitMatch[1], 10) : undefined;

	let effectiveLimit: number;
	if (typeof schemaLimit === 'number') {
		effectiveLimit = Math.min(schemaLimit, HARD_LIMIT);
	} else if (typeof embeddedLimit === 'number' && Number.isFinite(embeddedLimit)) {
		effectiveLimit = Math.min(embeddedLimit, HARD_LIMIT);
	} else {
		effectiveLimit = HARD_LIMIT;
	}

	const parts: string[] = [stripped, `limit=${effectiveLimit}`];
	if (continueFrom !== undefined) {
		const parsed = Number.parseInt(continueFrom, 10);
		if (Number.isFinite(parsed) && parsed >= 0) {
			parts.push(`offset=${parsed}`);
		}
	}
	return parts.join('|');
}
