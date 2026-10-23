import type { WikiConfig } from '../config/loadConfig.ts';
import { wikiKeyProblem, wikiKeyProblemMessage } from '../runtime/wikiKey.ts';

export interface WikiRegistry {
	getAll(): Readonly<Record<string, WikiConfig>>;
	get(key: string): Readonly<WikiConfig> | undefined;
	add(key: string, config: WikiConfig): void;
	remove(key: string): void;
	isManagementAllowed(): boolean;
}

export class DuplicateWikiKeyError extends Error {
	public constructor(key: string) {
		super(`Wiki "${key}" already exists in configuration`);
		this.name = 'DuplicateWikiKeyError';
	}
}

export class WikiRegistryImpl implements WikiRegistry {
	public constructor(
		private readonly wikis: Record<string, WikiConfig>,
		private readonly managementAllowed: boolean,
	) {}

	public getAll(): Readonly<Record<string, WikiConfig>> {
		return this.wikis;
	}

	public get(key: string): Readonly<WikiConfig> | undefined {
		// 只查自有属性：直接下标访问会取到 Object.prototype 上的成员，
		// 使伪造的 key 通过存在性检查。
		return Object.hasOwn(this.wikis, key) ? this.wikis[key] : undefined;
	}

	public add(key: string, config: WikiConfig): void {
		if (!key || key.trim() === '') {
			throw new Error('Wiki key cannot be empty');
		}
		// 拒绝会改动原型链的 key。
		if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
			throw new Error(`Wiki key "${key}" is not allowed`);
		}
		const problem = wikiKeyProblem(key);
		if (problem !== undefined) {
			throw new Error(`Wiki key "${key}" is not allowed: it ${wikiKeyProblemMessage(problem)}`);
		}
		if (Object.hasOwn(this.wikis, key)) {
			throw new DuplicateWikiKeyError(key);
		}
		this.wikis[key] = config;
	}

	public remove(key: string): void {
		delete this.wikis[key];
	}

	public isManagementAllowed(): boolean {
		return this.managementAllowed;
	}
}
