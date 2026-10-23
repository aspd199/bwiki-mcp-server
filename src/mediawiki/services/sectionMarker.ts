import type { TruncationInfo } from '../results/truncation.ts';
import { toOutlineLines, type SectionEntry } from './sectionService.ts';
import { editableChildrenOf } from './sectionSubtree.ts';

/**
 * 内容被截断时的提示，按读取范围给出不同的后续动作。
 */
export function sectionContentTruncation({
	entries,
	section,
	itemNoun,
	toolName,
	returnedBytes,
	totalBytes,
}: {
	readonly entries: readonly SectionEntry[];
	readonly section: number | undefined;
	readonly itemNoun: string;
	readonly toolName: string;
	readonly returnedBytes: number;
	readonly totalBytes: number;
}): TruncationInfo {
	const base = {
		reason: 'content-truncated',
		returnedBytes,
		totalBytes,
		itemNoun,
		toolName,
	} as const;

	if (section === undefined) {
		const outline = toOutlineLines(entries);
		// 只有首段的页面没有可收窄的标题，节 0 即整页，
		// 故不提示重新调用 get-page。
		if (outline.length === 1) {
			return {
				...base,
				remedyHint: 'The page has no sections, so no narrower read returns more of it.',
			};
		}
		return {
			...base,
			sections: outline,
			remedyHint: 'To read a specific section, call get-page with section=N.',
		};
	}

	const subsections = editableChildrenOf(entries, String(section));
	if (subsections.length === 0) {
		return {
			...base,
			remedyHint:
				"No narrower read returns more of this section. To change part of it, use update-page with operation='find-replace'.",
		};
	}
	return {
		...base,
		sections: subsections.map((s) => `${s.index} (${s.line})`),
		remedyHint:
			'To read part of this section, call get-page again with one of the subsection numbers listed.',
	};
}
