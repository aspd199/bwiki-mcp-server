import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl, formatEditComment } from '../wikis/utils.ts';
import { contentMaxBytes } from '../results/truncation.ts';
import { editableChildrenOf } from '../services/sectionSubtree.ts';

/**
 * wiki 对「nocreate 且页面不存在」报 missingtitle。
 * mwn 把它作为异常抛出，message 形如
 * `missingtitle: The page you specified doesn't exist.`。
 */
function isMissingTitle(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /\bmissingtitle\b/.test(message);
}

const OPERATIONS = ['replace', 'append', 'prepend', 'find-replace'] as const;
type Operation = (typeof OPERATIONS)[number];

interface ApiEditResponse {
	result?: string;
	pageid?: number;
	title?: string;
	newrevid?: number;
	newtimestamp?: string;
	contentmodel?: string;
}

// `section='new'` 已移除，保留专用错误提示。
const SECTION_NEW_REMOVED =
	'update-page no longer creates sections. To add one, use operation=\'append\' with a source that begins with the heading, for example "\\n\\n== History ==\\n\\nBody.".';

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	operation: z
		.enum(OPERATIONS)
		.optional()
		.describe(
			"What the write does to the target: 'replace' overwrites it with source, 'append' and 'prepend' add source to it, and 'find-replace' rewrites only the text find names and leaves the rest of the target byte for byte. With section=N, 'append' writes at the end of that section and 'prepend' immediately above that section's heading, which inserts a new section before an existing one. Defaults to 'replace'.",
		),
	source: z
		.string()
		.optional()
		.describe(
			'The content to write, in the existing page\'s content model. Required for every operation except find-replace, and refused for that one. An appended source that opens a new section must begin on its own line, as in "\\n\\n== History ==\\n\\nBody."; without the leading newline the heading runs on from the last line of the page and is not recognised as a heading.',
		),
	find: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The existing wikitext to rewrite, matched in full and exactly, whitespace and template markup included. Required when operation is 'find-replace'. A find that matches nothing, or more than one place, is refused without writing: extend it with the text around it to name one occurrence.",
		),
	replaceWith: z
		.string()
		.optional()
		.describe(
			"What find becomes. Required when operation is 'find-replace'; an empty string deletes the text find matched.",
		),
	latestId: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Base revision ID for edit-conflict detection; any get-page read that returns wikitext reports it as latestRevisionId. Required when section is set, because the wiki resolves a section number against this revision rather than against whichever is current. If omitted on a write that is not scoped to a section, the update is applied without conflict detection.',
		),
	comment: z.string().optional().describe('Summary of the edit'),
	section: z
		.number({
			error: (issue) => (issue.input === 'new' ? SECTION_NEW_REMOVED : undefined),
		})
		.int()
		.nonnegative()
		.optional()
		.describe(
			'Section number (0 = lead; 1..N = heading sections), from the section list get-page reports. Confines the write to that section: omit it to act on the whole page. A replace also takes out every subsection nested under the section; see removeSubsections.',
		),
	mode: z
		.enum(['append', 'prepend'])
		.optional()
		.describe(
			"Deprecated older spelling of operation='append' and operation='prepend'. Send operation instead.",
		),
	bot: z
		.boolean()
		.optional()
		.describe(
			'Marks the edit as a bot edit, which Special:RecentChanges hides by default. Takes effect only when the authenticated account has the `bot` right (granted by the bot group, or by the high-volume grant on a bot password or OAuth consumer); without it the edit saves unflagged and the response reports botMarked: false. Use when performing bulk or automated edit runs, or when the user requests it.',
		),
	removeUnreadContent: z
		.boolean()
		.optional()
		.describe(
			'Confirms that replacing content larger than a single read returns is meant to discard the part that was never returned. Required only when the target holds more bytes than one response carries and source holds fewer.',
		),
	removeSubsections: z
		.boolean()
		.optional()
		.describe(
			'Confirms that replacing this section is meant to remove the subsections nested under it. Required only when section is set and source contains fewer subsection headings than the section currently has.',
		),
} as const;

type UpdatePageArgs = z.infer<z.ZodObject<typeof inputSchema>>;

// 解析本次调用的操作。`mode` 为旧写法，仍接受。
// 各操作必填哪些字段由下方逻辑判断，schema 无法表达。
type WritePlan =
	| { readonly error: string }
	| { readonly operation: 'find-replace'; readonly find: string; readonly replaceWith: string }
	| { readonly operation: 'replace' | 'append' | 'prepend'; readonly source: string };

function writePlan(args: UpdatePageArgs): WritePlan {
	const { operation, mode, source, find, replaceWith, section, latestId } = args;
	if (operation !== undefined && mode !== undefined && operation !== mode) {
		return {
			error: `operation is '${operation}' but mode is '${mode}'. mode is the older spelling of the same choice; send operation alone.`,
		};
	}
	const resolved: Operation = operation ?? mode ?? 'replace';
	// 节号按当前版本解析，因此需与读取时的版本一致。
	// 仅 replace 强制要求，误写的代价是该节内容被覆盖。
	if (resolved === 'replace' && section !== undefined && section > 0 && latestId === undefined) {
		return {
			error: `Section ${section} names a different section once the page changes, so replacing a section needs latestId to say which revision the number was read from. Any get-page read that returns wikitext reports it as latestRevisionId.`,
		};
	}
	if (resolved === 'find-replace') {
		if (find === undefined || replaceWith === undefined) {
			return {
				error:
					"operation 'find-replace' needs find, the existing wikitext to rewrite, and replaceWith, what it becomes.",
			};
		}
		if (source !== undefined) {
			return {
				error:
					"operation 'find-replace' rewrites only the text find matches, so it takes no source. To overwrite the whole target instead, send source with operation 'replace'.",
			};
		}
		return { operation: resolved, find, replaceWith };
	}
	if (source === undefined) {
		return { error: `operation '${resolved}' needs source, the content to write.` };
	}
	if (find !== undefined || replaceWith !== undefined) {
		return {
			error: `find and replaceWith belong to operation 'find-replace', not '${resolved}'.`,
		};
	}
	if (args.removeUnreadContent !== undefined && resolved !== 'replace') {
		return {
			error: `removeUnreadContent confirms a replace that discards content too large to have been read, so it applies only to operation 'replace', not '${resolved}'.`,
		};
	}
	if (
		args.removeSubsections !== undefined &&
		(resolved !== 'replace' || args.section === undefined)
	) {
		return {
			error:
				"removeSubsections confirms a section replace that drops the subsections nested under it, so it applies only to operation 'replace' with section set.",
		};
	}
	return { operation: resolved, source };
}

// 各写操作共用 title/summary/scope/flags，仅内容字段与基准版本不同。
function commonEditParams(
	ctx: ToolContext,
	{ title, comment, section, bot }: UpdatePageArgs,
): Record<string, string | number | boolean> {
	const summary = formatEditComment(ctx, 'update-page', comment);
	return {
		action: 'edit',
		title,
		...(summary !== undefined ? { summary } : {}),
		nocreate: true,
		...(section !== undefined ? { section: String(section) } : {}),
		...(bot === true ? { bot: true } : {}),
	};
}

function buildEditParams(
	ctx: ToolContext,
	args: UpdatePageArgs,
	plan: { operation: 'replace' | 'append' | 'prepend'; source: string },
): Record<string, string | number | boolean> {
	const sourceField =
		plan.operation === 'append'
			? 'appendtext'
			: plan.operation === 'prepend'
				? 'prependtext'
				: 'text';
	return {
		...commonEditParams(ctx, args),
		[sourceField]: plan.source,
		...(args.latestId !== undefined ? { baserevid: args.latestId } : {}),
	};
}

// 每次前进一个字符而非整个匹配长度，以正确处理自重叠（如 `\n\n`）。
function occurrenceCount(haystack: string, needle: string): number {
	let count = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
		count++;
	}
	return count;
}

function scopeName(title: string, section: number | undefined): string {
	return section === undefined ? `page "${title}"` : `section ${section} of "${title}"`;
}

// 超出单次响应上限的内容无法被完整读取，缩短它的 replace 会丢失未读到的部分。
// 增大或等长的写入放行。
async function unreadContentError(
	args: UpdatePageArgs,
	source: string,
	mwn: Mwn,
): Promise<string | undefined> {
	if (args.removeUnreadContent === true) {
		return undefined;
	}
	const cap = contentMaxBytes();
	// 用 prop=info 取字节长度，它不跟随重定向，量的正是本次写入的目标页。
	const response =
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		(await mwn.request({
			action: 'query',
			prop: 'info',
			titles: args.title,
			formatversion: '2',
		})) as { query?: { pages?: { length?: number }[] } } | undefined;
	const pageBytes = response?.query?.pages?.[0]?.length;
	// 整页在预算内则其任一节也在。取不到长度的页面交由 wiki 自身报错。
	if (pageBytes === undefined || pageBytes <= cap) {
		return undefined;
	}
	const sourceBytes = Buffer.byteLength(source, 'utf8');
	if (args.section === undefined) {
		return sourceBytes < pageBytes
			? unreadContentMessage(`Page "${args.title}"`, pageBytes, sourceBytes, cap)
			: undefined;
	}
	// 写入按 latestId 解析节号，校验须基于同一版本。
	// 插入节后编号会移动，故须基于同一版本比较。
	const sectionRead =
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		(await mwn.request({
			action: 'query',
			prop: 'revisions',
			...(args.latestId === undefined ? { titles: args.title } : { revids: args.latestId }),
			rvprop: 'content',
			rvslots: 'main',
			rvsection: args.section,
			formatversion: '2',
		})) as
			| { query?: { pages?: { revisions?: { slots?: { main?: { content?: string } } }[] }[] } }
			| undefined;
	const current = sectionRead?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
	// 版本中不存在的节交由编辑自身报错。
	if (typeof current !== 'string') {
		return undefined;
	}
	const sectionBytes = Buffer.byteLength(current, 'utf8');
	if (sectionBytes <= cap || sourceBytes >= sectionBytes) {
		return undefined;
	}
	return unreadContentMessage(`Section ${args.section}`, sectionBytes, sourceBytes, cap);
}

function unreadContentMessage(
	target: string,
	targetBytes: number,
	sourceBytes: number,
	cap: number,
): string {
	return `${target} holds ${targetBytes} bytes, more than the ${cap} bytes one read returns, so the ${sourceBytes}-byte source supplied cannot contain all of it and this replace would delete the rest. To change part of it without resending it, use operation='find-replace'. To replace it with something shorter deliberately, pass removeUnreadContent: true.`;
}

// 替换某一节会连同其下的子节一起替换。
// 由 wiki 自身解析两侧标题，按数量比较，重命名可通过。
async function subsectionRemovalError(
	args: UpdatePageArgs,
	source: string,
	ctx: ToolContext,
	mwn: Mwn,
): Promise<string | undefined> {
	const { section, removeSubsections } = args;
	if (section === undefined || removeSubsections === true) {
		return undefined;
	}
	// 首段无标题，不含子节。
	if (section === 0) {
		return undefined;
	}
	// 与写入使用同一版本。
	const entries = await ctx.sections.list(mwn, args.title, args.latestId);
	const index = String(section);
	// 子树遍历计入每个条目以正确闭合；转写来的子节点不计入。
	const children = editableChildrenOf(entries, index);
	if (children.length === 0) {
		return undefined;
	}
	const parent = entries.find((e) => e.index === index);
	if (parent === undefined) {
		return undefined;
	}
	// 模板展开的节带 `T-` 前缀 id，排除。只计调用方写入的标题。
	const sourceSections = await ctx.sections.listInSource(mwn, args.title, source);
	const carriedBack = sourceSections.filter((e) => e.editable && e.level > parent.level).length;
	if (carriedBack >= children.length) {
		return undefined;
	}
	const names = children.map((c) => c.line).join(', ');
	return `Section ${index} (${parent.line}) contains ${children.length} subsection${children.length === 1 ? '' : 's'}: ${names}. The source supplied would remove them. Include them in source to keep them, or pass removeSubsections: true to remove them deliberately.`;
}

// 提交编辑并组织响应，各操作共用。
async function submitEdit(
	ctx: ToolContext,
	mwn: Mwn,
	params: Record<string, string | number | boolean>,
	args: UpdatePageArgs,
): Promise<CallToolResult> {
	const response =
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		(await ctx.edit.submit(mwn, params)) as { edit?: ApiEditResponse } | undefined;
	const edit = response?.edit;
	if (!edit || edit.result !== 'Success') {
		return ctx.format.error(
			'upstream_failure',
			`Failed to update page: ${JSON.stringify(edit ?? response)}`,
		);
	}
	const resolvedTitle = edit.title ?? args.title;
	return ctx.format.ok({
		pageId: edit.pageid,
		title: resolvedTitle,
		latestRevisionId: edit.newrevid,
		latestRevisionTimestamp: edit.newtimestamp,
		contentModel: edit.contentmodel,
		...(args.bot === true ? { botMarked: await ctx.edit.botRight(mwn) } : {}),
		url: await buildPageUrl(ctx, resolvedTitle),
	});
}

// `find` 必须完整精确匹配：wikitext 中一个前导空格就会改变行含义。
// 按索引拼接而非 String#replace，后者会把替换内容里的 `$&` `$1` 当作引用。
async function findReplace(
	args: UpdatePageArgs,
	plan: { find: string; replaceWith: string },
	ctx: ToolContext,
	mwn: Mwn,
): Promise<CallToolResult> {
	const { title, section, latestId } = args;
	const { find, replaceWith } = plan;
	const readParams: Record<string, string | number | boolean> = {
		rvprop: 'ids|content',
		// 不跟随重定向：否则会把目标页内容拼到重定向页上。
		redirects: false,
	};
	if (section !== undefined) {
		readParams.rvsection = section;
	}
	const page = await mwn.read(title, readParams);
	if (page.missing) {
		// 指明下一步：只说 not found 会让调用方反复试标题，而正确动作是换 create-page。
		return ctx.format.notFound(
			`Page "${title}" not found. To create it, use create-page.`,
		);
	}
	if (page.invalid) {
		return ctx.format.invalidInput(`"${title}" is not a valid page title`);
	}
	const rev = page.revisions?.[0];
	const current = rev?.content;
	if (typeof current !== 'string') {
		// 这三种情况 API 都返回空内容而非错误，需在此区分。
		if (section !== undefined) {
			// 与 dispatcher 的报错保持一致。
			return ctx.format.notFound(`Section ${section} does not exist`, 'nosuchsection');
		}
		// mwn 的类型未声明 texthidden，按结构读取。
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		if ((rev as { texthidden?: boolean } | undefined)?.texthidden === true) {
			return ctx.format.permissionDenied(
				`The current revision of "${title}" has its text hidden, so it cannot be read to edit`,
			);
		}
		return ctx.format.error('upstream_failure', `The wiki returned no content for "${title}"`);
	}
	// latestId 表示调用方要求页面未被改动过。
	if (latestId !== undefined && rev?.revid !== latestId) {
		return ctx.format.conflict(
			`Page "${title}" is at revision ${rev?.revid}, not ${latestId}, so it has been edited since the revision named. Re-read it and send the edit again.`,
		);
	}

	const scope = scopeName(title, section);
	const occurrences = occurrenceCount(current, find);
	if (occurrences === 0) {
		// 重试时首次已成功的情况看起来和锚点失效一样。
		// 仅当 replaceWith 不比 find 短且唯一出现时才提示已生效。
		const applied =
			replaceWith.length >= find.length && occurrenceCount(current, replaceWith) === 1
				? ' The text replaceWith names is already present, so this edit may have landed already.'
				: '';
		return ctx.format.invalidInput(
			`No replacement was made: find did not appear in ${scope}.${applied} Read the current wikitext with get-page and copy find from it exactly, whitespace and template markup included.`,
		);
	}
	if (occurrences > 1) {
		return ctx.format.invalidInput(
			`No replacement was made: find appears ${occurrences} times in ${scope}. Extend find with the text around it so it names one occurrence${section === undefined ? ', or set section to search one section only' : ''}.`,
		);
	}

	const at = current.indexOf(find);
	const updated = current.slice(0, at) + replaceWith + current.slice(at + find.length);
	return submitEdit(
		ctx,
		mwn,
		{
			...commonEditParams(ctx, args),
			text: updated,
			// 基准版本用刚读取的版本，而非调用方指定的。
			...(rev?.revid !== undefined ? { baserevid: rev.revid } : {}),
		},
		args,
	);
}

export const updatePage: Tool<typeof inputSchema> = {
	name: 'update-page',
	description:
		"Writes to an existing wiki page and returns the new revision ID. Fails if the page does not exist; for new pages, use create-page. operation says what the write does and section says where: omit section to act on the whole page, or set it to confine the write to one section. For changing part of a page, use operation='find-replace', which carries only the text being rewritten, so nothing outside find can be lost and the rest of the page never has to travel to or from the caller; a find that matches nothing, or more than one place, is refused without writing, which also makes it safe to resend a call whose result never arrived. For replacing a target outright, use operation='replace', whose source must carry every byte meant to survive; it is refused when source would shorten a target too large for one read to return whole, since the rest was never seen. With section set it also takes out every subsection nested under that section, is refused when source would drop them, and needs latestId to say which revision the section number was read from. operation='append' and 'prepend' add a delta: a new section at the end of the page is an append whose source begins with the heading, and with section set a prepend inserts one immediately above that section. Pass latestId (reported as latestRevisionId by any get-page read that returns wikitext) for edit-conflict detection: the write is rejected rather than silently clobbering a concurrent change. Each call is a separate revision, and resending an append or prepend whose result never arrived adds the delta a second time.",
	inputSchema,
	annotations: {
		title: 'Update page',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'update page',
	target: (a) => a.title,

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const plan = writePlan(args);
		if ('error' in plan) {
			return ctx.format.invalidInput(plan.error);
		}
		const mwn = await ctx.mwn();

		if (plan.operation === 'find-replace') {
			return findReplace(args, plan, ctx, mwn);
		}

		// 只有 replace 会连同子节一起替换，追加类操作不删除内容。
		if (plan.operation === 'replace') {
			// 先于子节校验：截断的内容可能看似丢失了子节。
			const unreadError = await unreadContentError(args, plan.source, mwn);
			if (unreadError) {
				return ctx.format.invalidInput(unreadError);
			}
			const removalError = await subsectionRemovalError(args, plan.source, ctx, mwn);
			if (removalError) {
				return ctx.format.invalidInput(removalError);
			}
		}
		try {
			return await submitEdit(ctx, mwn, buildEditParams(ctx, args, plan), args);
		} catch (err) {
			// nocreate 让 wiki 对不存在的页面报 missingtitle，原文是 MediaWiki 的
			// 英文错误，看不出下一步该换 create-page，故在此补一句指引。
			if (isMissingTitle(err)) {
				return ctx.format.notFound(
					`Page "${args.title}" not found. To create it, use create-page.`,
					'missingtitle',
				);
			}
			throw err;
		}
	},
};
