export const DEFAULT_CONTENT_MAX_BYTES = 75000;

/** The response content byte budget in force, for callers that cap before rendering. */
export function contentMaxBytes(): number {
	const raw = process.env.MCP_CONTENT_MAX_BYTES;
	if (raw === undefined || raw === '') {
		return DEFAULT_CONTENT_MAX_BYTES;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_CONTENT_MAX_BYTES;
	}
	return parsed;
}

export type TruncationInfo =
	| {
			reason: 'more-available';
			returnedCount: number;
			itemNoun: string;
			toolName: string;
			continueWith: { param: string; value: string | number };
	  }
	| {
			reason: 'capped-no-continuation';
			returnedCount: number;
			limit: number;
			itemNoun: string;
			narrowHint: string;
	  }
	| {
			reason: 'content-truncated';
			returnedBytes: number;
			totalBytes: number;
			itemNoun: string;
			toolName: string;
			sections?: string[];
			remedyHint: string;
	  };

export interface TruncatedContent {
	text: string;
	truncated: boolean;
	returnedBytes: number;
	totalBytes: number;
}

export interface CappedLines {
	lines: string[];
	returnedBytes: number;
	totalBytes: number;
	truncated: boolean;
}

const ELLIPSIS = '…';
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, 'utf8');

/**
 * 按行保留整行，避免返回半行内容。首行即超限时在行内截断并标记。
 */
export function capLinesByBytes(lines: string[]): CappedLines {
	const maxBytes = contentMaxBytes();
	const totalBytes = Buffer.byteLength(lines.join('\n'), 'utf8');
	if (totalBytes <= maxBytes) {
		return { lines, returnedBytes: totalBytes, totalBytes, truncated: false };
	}

	const kept: string[] = [];
	let returnedBytes = 0;
	for (const line of lines) {
		const separator = kept.length === 0 ? 0 : 1;
		const size = separator + Buffer.byteLength(line, 'utf8');
		if (returnedBytes + size > maxBytes) {
			break;
		}
		kept.push(line);
		returnedBytes += size;
	}

	if (kept.length === 0) {
		const { text } = truncateByBytes(lines[0], Math.max(0, maxBytes - ELLIPSIS_BYTES));
		const only = `${text}${ELLIPSIS}`;
		return {
			lines: [only],
			returnedBytes: Buffer.byteLength(only, 'utf8'),
			totalBytes,
			truncated: true,
		};
	}
	return { lines: kept, returnedBytes, totalBytes, truncated: true };
}

// UTF-8 续字节形如 0b10xxxxxx；下一个字节若是它，说明切在多字节字符内部。
// 说明切点落在多字节字符内部。
function isContinuationByte(byte: number): boolean {
	return (byte & 0xc0) === 0x80;
}

export function truncateByBytes(
	text: string,
	maxBytes: number = contentMaxBytes(),
): TruncatedContent {
	const buffer = Buffer.from(text, 'utf8');
	const totalBytes = buffer.byteLength;
	if (totalBytes <= maxBytes) {
		return { text, truncated: false, returnedBytes: totalBytes, totalBytes };
	}
	// 回退到字符边界，使结果与输入字节前缀一致。
	// 否则 Node 会把残字节解码为 U+FFFD，既超出预算又与原文不符。
	//
	// 在此处夹紧而非调用点：maxBytes 是公开参数，负数会让 subarray 从末尾计数。
	let end = Math.max(0, maxBytes);
	while (end > 0 && isContinuationByte(buffer[end])) {
		end--;
	}
	return {
		text: buffer.subarray(0, end).toString('utf8'),
		truncated: true,
		returnedBytes: end,
		totalBytes,
	};
}
