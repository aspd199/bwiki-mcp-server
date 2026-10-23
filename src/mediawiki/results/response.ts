import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ErrorEnvelope } from '../results/schemas.ts';
import type { ErrorCategory } from '../errors/classifyError.ts';
import { formatPayload } from './format.ts';

export interface ResponseFormatter {
	ok(payload: unknown): CallToolResult;
	error(category: ErrorCategory, message: string, code?: string): CallToolResult;
	notFound(message: string, code?: string): CallToolResult;
	invalidInput(message: string): CallToolResult;
	conflict(message: string, code?: string): CallToolResult;
	permissionDenied(message: string, code?: string): CallToolResult;
}

export function structuredResult(data: unknown): CallToolResult {
	return {
		content: [{ type: 'text', text: formatPayload(data) }],
		// structuredContent 镜像类型化载荷，使 dispatcher 无需重解析文本即可检测截断。
		structuredContent: data,
	};
}

export function errorResult(
	category: ErrorCategory,
	message: string,
	code?: string,
): CallToolResult {
	// 错误信封以 JSON 放在 content[0].text，并置 isError: true。
	// 客户端据 isError 区分成败，需要类型化结构时再解析文本块。
	const envelope: ErrorEnvelope =
		code !== undefined ? { category, message, code } : { category, message };
	return {
		content: [{ type: 'text', text: JSON.stringify(envelope) }],
		isError: true,
	};
}

export class ResponseFormatterImpl implements ResponseFormatter {
	public ok(payload: unknown): CallToolResult {
		return structuredResult(payload);
	}

	public error(category: ErrorCategory, message: string, code?: string): CallToolResult {
		return errorResult(category, message, code);
	}

	public notFound(message: string, code?: string): CallToolResult {
		return this.error('not_found', message, code);
	}

	public invalidInput(message: string): CallToolResult {
		return this.error('invalid_input', message);
	}

	public conflict(message: string, code?: string): CallToolResult {
		return this.error('conflict', message, code);
	}

	public permissionDenied(message: string, code?: string): CallToolResult {
		return this.error('permission_denied', message, code);
	}
}
