import type { Tool } from '../../runtime/tool.ts';
import type { WikiIdentity } from '../../wikis/wikiProbe.ts';
import type { ErrorCategory } from '../../errors/classifyError.ts';

/**
 * 扩展名之外的能力条件，由站点的 siteinfo 快照回答。
 * 由按调用的能力校验统一执行，拒绝文案由扩展包提供。
 */
export interface WikiGate {
	/**
	 * 该条件适用的工具名；其余工具不受影响。
	 */
	readonly tools: readonly string[];
	readonly isSatisfied: (identity: WikiIdentity) => boolean;
	/** 不满足条件时的拒绝文案。 */
	readonly refusal: (wikiKey: string) => string;
}

export interface ExtensionPack {
	/** 稳定 id，用于规则名与遥测。 */
	readonly id: string;

	/** 可见的候选扩展名，可列多个别名。 */
	readonly extensionNames: readonly string[];

	/** 本包提供的工具。 */
	// oxlint-disable-next-line typescript/no-explicit-any
	readonly tools: readonly Tool<any>[];

	/** 部分工具的附加门槛，与扩展门槛同时生效。 */
	readonly wikiGate?: WikiGate;

	/**
	 * 本包扩展引入的错误码，及其应归入的类别。
	 *
	 * 经 mwn 访问 wiki 的包不自行捕获错误，由 dispatcher 统一分类；
	 * 在此声明错误码可让词汇与包一起维护，移除包即移除其错误码。
	 *
	 * 启动时与核心词汇及各包交叉校验，防止重复声明。
	 */
	readonly errorCodes?: Readonly<Record<string, ErrorCategory>>;

	/**
	 * 对按情况编号的码族同样适用，如 Wikibase 的 `not-recognized-<shape>`。
	 *
	 * 每个形态一个码。
	 */
	readonly errorCodePrefixes?: readonly (readonly [RegExp, ErrorCategory])[];
}
