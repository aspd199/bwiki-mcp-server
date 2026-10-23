import type { SectionEntry } from './sectionService.ts';

/**
 * `index` 之下的嵌套节：标题层级更深、直到第一个不更深为止。
 *
 * 这正是 MediaWiki 随该节一并替换的集合：
 * `Parser::extractSections` 以 `$curLevel <= $targetLevel` 判断边界，
 * 比较的是 `=` 的个数，故使用 `level` 而非 `toclevel`。
 */
export function childrenOf(entries: readonly SectionEntry[], index: string): SectionEntry[] {
	const position = entries.findIndex((e) => e.index === index);
	if (position === -1) {
		return [];
	}
	const parentLevel = entries[position].level;
	const children: SectionEntry[] = [];
	for (const entry of entries.slice(position + 1)) {
		if (entry.level <= parentLevel) {
			break;
		}
		children.push(entry);
	}
	return children;
}

/**
 * `index` 下调用方既能读到也能写回的节。
 * 转写标题显示在页面上但无节号可编辑，也不会出现在调用方写回的内容里。
 */
export function editableChildrenOf(
	entries: readonly SectionEntry[],
	index: string,
): SectionEntry[] {
	return childrenOf(entries, index).filter((c) => c.editable);
}
