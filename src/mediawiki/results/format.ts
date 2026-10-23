// 将工具载荷渲染为 Markdown 文本。

const INLINE_STRING_LIMIT = 120;

// 应保持全大写的缩写。
const ABBREVIATIONS = new Set([
	'Id',
	'Url',
	'Uri',
	'Html',
	'Json',
	'Mime',
	'Api',
	'Mw',
	'Css',
	'Sql',
	'Xml',
	'Csrf',
	'Http',
	'Https',
	'Utf',
	'Ip',
	'Md',
	'Tsv',
	'Csv',
	'Pdf',
	'Svg',
	'Wsl',
]);

export function formatPayload(data: unknown): string {
	const rendered = renderValue(data, '').trim();
	return rendered.length > 0 ? rendered : '(empty)';
}

function humanizeKey(key: string): string {
	const words = key
		.replace(/([A-Z])/g, ' $1')
		.trim()
		.split(/\s+/);
	return words
		.map((word, i) => {
			const titleCased = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
			if (ABBREVIATIONS.has(titleCased)) {
				return titleCased.toUpperCase();
			}
			return i === 0 ? titleCased : word.toLowerCase();
		})
		.join(' ');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderValue(value: unknown, indent: string): string {
	if (value === null || value === undefined) {
		return '—';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return renderArray(value, indent);
	}
	if (isPlainObject(value)) {
		return renderObject(value, indent);
	}
	return stringifyUnknown(value);
}

function renderObject(obj: Record<string, unknown>, indent: string): string {
	const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
	if (entries.length === 0) {
		return '(empty)';
	}
	return entries.map(([key, value]) => renderField(humanizeKey(key), value, indent)).join('\n');
}

function renderField(label: string, value: unknown, indent: string): string {
	const prefix = `${indent}${label}:`;
	if (value === null || value === undefined) {
		return `${prefix} —`;
	}
	if (typeof value === 'string') {
		if (value === '') {
			return `${prefix} (empty)`;
		}
		if (value.length <= INLINE_STRING_LIMIT && !value.includes('\n')) {
			return `${prefix} ${value}`;
		}
		// 以空行收尾，否则值内的 "Summary: …" 会与字段混淆。
		return `${prefix}\n\n${value}\n`;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return `${prefix} ${value}`;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return `${prefix} (none)`;
		}
		return `${prefix}\n${renderArray(value, indent)}`;
	}
	if (isPlainObject(value)) {
		return `${prefix}\n${renderObject(value, indent + '  ')}`;
	}
	return `${prefix} ${stringifyUnknown(value)}`;
}

function renderArray(arr: unknown[], indent: string): string {
	const itemIndent = `${indent}- `;
	const continuationIndent = `${indent}  `;
	return arr
		.map((item) => {
			if (item === null || item === undefined) {
				return `${itemIndent}—`;
			}
			if (typeof item === 'string') {
				return `${itemIndent}${item === '' ? '(empty)' : item}`;
			}
			if (typeof item === 'number' || typeof item === 'boolean') {
				return `${itemIndent}${item}`;
			}
			if (Array.isArray(item)) {
				return `${itemIndent}\n${renderArray(item, continuationIndent)}`;
			}
			if (isPlainObject(item)) {
				const objText = renderObject(item, continuationIndent);
				const lines = objText.split('\n');
				if (lines.length === 0) {
					return `${itemIndent}(empty)`;
				}
				// 首个字段放在短横线后，其余按缩进续排。
				const [first, ...rest] = lines;
				const firstStripped = first.startsWith(continuationIndent)
					? first.slice(continuationIndent.length)
					: first;
				return [`${itemIndent}${firstStripped}`, ...rest].join('\n');
			}
			return `${itemIndent}${stringifyUnknown(item)}`;
		})
		.join('\n');
}

// 兜底渲染器：优先 JSON.stringify，失败则退回构造函数名。
function stringifyUnknown(value: unknown): string {
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) {
			return json;
		}
	} catch {
		// 退回构造函数名
	}
	const ctor =
		typeof value === 'object' && value !== null
			? (value.constructor?.name ?? 'Object')
			: typeof value;
	return `[${ctor}]`;
}
