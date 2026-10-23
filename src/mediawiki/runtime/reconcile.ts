import type { RegisteredTool } from '@modelcontextprotocol/server';
import type { WikiConfig } from '../config/loadConfig.ts';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import type { WikiProbe } from '../wikis/wikiProbe.ts';
import type { ExtensionPack } from '../tools/extensions/types.ts';
import { WRITE_TOOL_NAMES } from './wikiCapability.ts';

export type Reconcile = () => Promise<void>;

export interface ReconcileDeps {
	readonly wikiRegistry: WikiRegistry;
	readonly transport: 'http' | 'stdio';
	readonly wikiProbe: WikiProbe;
	readonly extensionPacks: readonly ExtensionPack[];
}

export interface ReconcileContext {
	readonly allWikis: Readonly<Record<string, WikiConfig>>;
	readonly wikiCount: number;
	readonly allowManagement: boolean;
	readonly transport: 'http' | 'stdio';
	readonly wikiProbe: WikiProbe;
}

export interface ToolGatingRule {
	readonly name: string;
	readonly affects: readonly string[];
	readonly isAllowed: (ctx: ReconcileContext) => boolean | Promise<boolean>;
}

const STDIO_ONLY_TOOLS: readonly string[] = ['oauth-status', 'oauth-logout'];

const STATIC_RULES: readonly ToolGatingRule[] = [
	{
		name: 'read-only',
		affects: WRITE_TOOL_NAMES,
		// 任一已配置站点可写即保留写工具；只读站点由按调用的校验拒绝。
		isAllowed: (c) => Object.values(c.allWikis).some((w) => w.readOnly !== true),
	},
	{
		name: 'stdio-only',
		affects: STDIO_ONLY_TOOLS,
		isAllowed: (c) => c.transport === 'stdio',
	},
	{
		name: 'wiki-mgmt',
		affects: ['add-wiki'],
		isAllowed: (c) => c.allowManagement,
	},
	{
		name: 'remove-wiki',
		affects: ['remove-wiki'],
		isAllowed: (c) => c.allowManagement && c.wikiCount >= 2,
	},
	{
		// 始终提供：本工具的 list-wikis 报告整个农场名册，与配置数量无关。
		name: 'list-wikis',
		affects: ['list-wikis'],
		isAllowed: () => true,
	},
];

function buildExtensionRules(packs: readonly ExtensionPack[]): readonly ToolGatingRule[] {
	return packs.flatMap((pack) => [
		{
			name: `${pack.id}-extension`,
			affects: pack.tools.map((t) => t.name),
			// 任一已配置站点具备该扩展即提供；缺失者由按调用校验拒绝。
			isAllowed: async (c: ReconcileContext) => {
				const results = await Promise.all(
					Object.keys(c.allWikis).map((key) =>
						c.wikiProbe.hasAnyExtension(key, pack.extensionNames),
					),
				);
				return results.some((r) => r);
			},
		},
		...wikiGateRule(pack),
	]);
}

// 需要额外能力的扩展包自行声明该条件，reconcile 无需知晓具体包。
function wikiGateRule(pack: ExtensionPack): ToolGatingRule[] {
	const gate = pack.wikiGate;
	if (gate === undefined) {
		return [];
	}
	return [
		{
			name: `${pack.id}-wiki-gate`,
			affects: gate.tools,
			// 按站点取交集：仅在某个站点同时满足扩展与门槛时提供该工具。
			isAllowed: async (c: ReconcileContext) => {
				const results = await Promise.all(
					Object.keys(c.allWikis).map(async (key) => {
						const identity = await c.wikiProbe.inspect(key);
						return (
							pack.extensionNames.some((name) => identity.extensions.has(name)) &&
							gate.isSatisfied(identity)
						);
					}),
				);
				return results.some((r) => r);
			},
		},
	];
}

function buildContext(deps: ReconcileDeps): ReconcileContext {
	const allWikis = deps.wikiRegistry.getAll();
	return {
		allWikis,
		wikiCount: Object.keys(allWikis).length,
		allowManagement: deps.wikiRegistry.isManagementAllowed(),
		transport: deps.transport,
		wikiProbe: deps.wikiProbe,
	};
}

export async function computeDesiredEnabledState(
	toolNames: Iterable<string>,
	ctx: ReconcileContext,
	rules: readonly ToolGatingRule[],
): Promise<Map<string, boolean>> {
	const results = await Promise.all(
		rules.map(async (r) => ({ rule: r, allowed: await r.isAllowed(ctx) })),
	);

	// 默认允许；任一规则否决即禁用。
	const desired = new Map<string, boolean>();
	for (const name of toolNames) {
		desired.set(name, true);
	}
	for (const { rule, allowed } of results) {
		if (allowed) {
			continue;
		}
		for (const toolName of rule.affects) {
			if (desired.has(toolName)) {
				desired.set(toolName, false);
			}
		}
	}
	return desired;
}

export async function reconcileTools(
	tools: Map<string, RegisteredTool>,
	deps: ReconcileDeps,
): Promise<void> {
	const ctx = buildContext(deps);
	const rules = [...STATIC_RULES, ...buildExtensionRules(deps.extensionPacks)];
	const desired = await computeDesiredEnabledState(tools.keys(), ctx, rules);
	for (const [name, shouldEnable] of desired) {
		toggle(tools.get(name), shouldEnable);
	}
}

function toggle(tool: RegisteredTool | undefined, shouldBeEnabled: boolean): void {
	if (!tool) {
		return;
	}
	if (shouldBeEnabled && !tool.enabled) {
		tool.enable();
	} else if (!shouldBeEnabled && tool.enabled) {
		tool.disable();
	}
}
