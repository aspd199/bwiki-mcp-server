import { z } from 'zod';
import type { Mwn } from 'mwn';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { formatEditComment } from '../wikis/utils.ts';

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	protections: z
		.record(z.string(), z.string())
		.describe(
			'Protection level for each action, e.g. {"edit": "autoconfirmed", "move": "sysop"}. The actions are edit and move, plus upload on a File page; a page that does not exist takes only create, which limits who can create the title. Levels are the wiki\'s own; MediaWiki\'s defaults are autoconfirmed (semi-protection) and sysop (full protection). "all" lifts the action\'s protection.',
		),
	expiry: z
		.string()
		.default('infinite')
		.describe(
			'When the protections named in protections end: infinite, a relative time such as "1 week", or a timestamp such as 2026-10-01T00:00:00Z.',
		),
	cascade: z
		.boolean()
		.optional()
		.describe(
			'Also protect every page transcluded into this one against editing. Applies only while edit protection is at a cascading level, sysop by default. Omit to keep the current setting.',
		),
	comment: z.string().optional().describe('Reason for changing the protection'),
} as const;

interface Protection {
	action: string;
	level: string;
	expiry: string;
}

interface CurrentProtection {
	type: string;
	level: string;
	expiry: string;
	cascade?: boolean;
	// 保护继承自级联页面时置位，非本页自身设置。
	source?: string;
}

interface ProtectionRead {
	curtimestamp: string;
	query?: { pages?: { protection?: CurrentProtection[] }[] };
}

interface ProtectResponse {
	protect: {
		title: string;
		cascade?: boolean;
		// 每个条目包含一个动作及其级别（解除为空串）与到期时间。
		protections: Record<string, string>[];
	};
}

export const protectPage: Tool<typeof inputSchema> = {
	name: 'protect-page',
	description:
		'Changes the protection of a wiki page and returns its title, its own protections afterwards with their expiries, and whether cascading is on. Each action named in protections is set to its level until expiry. Actions left out keep their current protection, so lifting all protection means naming every action the page takes with "all". Protection the page inherits from a cascade-protected page that transcludes it is neither changed nor listed. Fails if the authenticated user lacks the protect permission, if the wiki does not accept an action or level for this page, or if the expiry is invalid or in the past.',
	inputSchema,
	annotations: {
		title: 'Protect page',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'protect page',
	target: (a) => a.title,

	async handle(
		{ title, protections, expiry, cascade, comment },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const requested: Protection[] = Object.entries(protections).map(([action, level]) => ({
			action,
			level,
			expiry,
		}));
		if (requested.length === 0) {
			return ctx.format.invalidInput('protections must name at least one action');
		}

		const mwn = await ctx.mwn();
		// 请求中省略的动作会被 wiki 解除保护，故需重新发送其余保护。
		const current = await protectionsInForce(mwn, title);
		const kept: Protection[] = current
			.filter((p) => !Object.hasOwn(protections, p.type))
			.map((p) => ({ action: p.type, level: p.level, expiry: p.expiry }));
		const applied = [...requested, ...kept];

		const params = {
			action: 'protect',
			title,
			protections: applied.map((p) => `${p.action}=${p.level}`),
			expiry: applied.map((p) => p.expiry),
			cascade: cascade ?? current.some((p) => p.cascade === true),
			reason: formatEditComment(ctx, 'protect-page', comment),
		};
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- action=protect response shape; trusted at this boundary
		const response = (await ctx.edit.submit(mwn, params)) as ProtectResponse;

		return ctx.format.ok({
			title: response.protect.title,
			protections: response.protect.protections.flatMap(fromResponse).filter((p) => p.level !== ''),
			cascade: response.protect.cascade === true,
		});
	},
};

// 本页自身的保护，排除继承自级联页面的与已过期的。
// 过期保护在 wiki 清除前仍会列出，重发会因时间已过而整体失败。
// 过期以 wiki 时钟为准，可能与主机时钟不同。
async function protectionsInForce(mwn: Mwn, title: string): Promise<CurrentProtection[]> {
	const params = {
		action: 'query',
		prop: 'info',
		inprop: 'protection',
		titles: title,
		curtimestamp: true,
		formatversion: '2',
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
	const response = (await mwn.request(params)) as ProtectionRead;
	const now = Date.parse(response.curtimestamp);
	return (response.query?.pages?.[0]?.protection ?? []).filter(
		(p) => p.source === undefined && inForceAt(p.expiry, now),
	);
}

// "infinity" 无法解析为日期，故原样保留。
function inForceAt(expiry: string, now: number): boolean {
	const end = Date.parse(expiry);
	return Number.isNaN(end) || end > now;
}

function fromResponse({ expiry, ...levelByAction }: Record<string, string>): Protection[] {
	return Object.entries(levelByAction).map(([action, level]) => ({ action, level, expiry }));
}
