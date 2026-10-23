import type { Mwn } from 'mwn';

export interface SectionEntry {
	/** MediaWiki's own section id, as sent to `section=`. Non-numeric when transcluded. */
	index: string;
	/** Heading depth as an `=` count, 2..6, from the API's `level`. */
	level: number;
	/** Heading text. */
	line: string;
	/** False when the section is transcluded and cannot be edited on this page. */
	editable: boolean;
}

export interface SectionService {
	list(mwn: Mwn, title: string, revisionId?: number): Promise<SectionEntry[]>;
	listInSource(mwn: Mwn, title: string, source: string): Promise<SectionEntry[]>;
}

interface PageSectionsApi {
	index?: string;
	level?: string;
	line?: string;
}

// 转写来的节 index 为 `T-n`，不可在本页编辑，且会移动后续节的编号。
function isEditableIndex(index: string): boolean {
	return /^[1-9]\d*$/.test(index);
}

export class SectionServiceImpl implements SectionService {
	// 按指定版本读取大纲，与写入解析节号所用版本一致。
	public async list(mwn: Mwn, title: string, revisionId?: number): Promise<SectionEntry[]> {
		return this.parseSections(mwn, {
			action: 'parse',
			...(revisionId === undefined ? { page: title } : { oldid: String(revisionId) }),
			prop: 'sections',
			formatversion: '2',
		});
	}

	// 用 wiki 自身的解析器解析，使结果与 `list` 一致。
	public async listInSource(mwn: Mwn, title: string, source: string): Promise<SectionEntry[]> {
		return this.parseSections(mwn, {
			action: 'parse',
			text: source,
			title,
			contentmodel: 'wikitext',
			prop: 'sections',
			formatversion: '2',
		});
	}

	private async parseSections(mwn: Mwn, params: Record<string, string>): Promise<SectionEntry[]> {
		const response =
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			(await mwn.request(params)) as { parse?: { sections?: PageSectionsApi[] } } | undefined;
		return (response?.parse?.sections ?? []).map((s) => {
			const index = s.index ?? '';
			return {
				index,
				level: Number.parseInt(s.level ?? '', 10) || 0,
				line: s.line ?? '',
				editable: isEditableIndex(index),
			};
		});
	}
}

// 对外发布的大纲：每节一行，附可用于编辑的节号。
// 转写标题不列出：它们出现在页面上但无节号可寻址，
// 列出会让后续节的编号错位。更详细的条目仅供内部校验使用。
export function toOutlineLines(entries: readonly SectionEntry[]): string[] {
	return ['0 (Lead)', ...entries.filter((e) => e.editable).map((e) => `${e.index} (${e.line})`)];
}
