/**
 * 扩展包。BWiki 仅安装 Semantic MediaWiki，故只保留 `smwPack`。
 */

import type { ExtensionPack } from './types.ts';
import { smwPack } from './smw/index.ts';

export type { ExtensionPack } from './types.ts';
import type { ErrorCategory, ExtensionErrorVocabulary } from '../../errors/classifyError.ts';
import { coreErrorCodes } from '../../errors/classifyError.ts';

/**
 * 校验门槛声明的工具名均属于该包，不匹配则在启动时失败。
 */
export function assertWikiGatesNameOwnTools(packs: readonly ExtensionPack[]): void {
	for (const pack of packs) {
		const provided = new Set(pack.tools.map((tool) => tool.name));
		for (const name of pack.wikiGate?.tools ?? []) {
			if (!provided.has(name)) {
				throw new Error(
					`Extension pack "${pack.id}" declares a wikiGate for "${name}", which it does not provide.`,
				);
			}
		}
	}
}

/**
 * 各扩展包的错误码合并为一套，供中央分类器使用。
 *
 * 若两个包声明同一码，或与核心词汇冲突，则在启动时失败。
 */
export function extensionErrorVocabulary(
	packs: readonly ExtensionPack[],
): ExtensionErrorVocabulary {
	const core = coreErrorCodes();
	const codes: Record<string, ErrorCategory> = {};
	const owner = new Map<string, string>();
	const prefixes: (readonly [RegExp, ErrorCategory])[] = [];

	for (const pack of packs) {
		for (const [code, category] of Object.entries(pack.errorCodes ?? {})) {
			if (Object.hasOwn(core, code)) {
				throw new Error(
					`Extension pack "${pack.id}" declares error code "${code}", which MediaWiki itself defines.`,
				);
			}
			const claimed = owner.get(code);
			if (claimed !== undefined) {
				throw new Error(
					`Extension packs "${claimed}" and "${pack.id}" both declare error code "${code}".`,
				);
			}
			owner.set(code, code);
			codes[code] = category;
		}
		prefixes.push(...(pack.errorCodePrefixes ?? []));
	}

	return { codes, prefixes };
}

export const extensionPacks: readonly ExtensionPack[] = [smwPack];

assertWikiGatesNameOwnTools(extensionPacks);
extensionErrorVocabulary(extensionPacks);
