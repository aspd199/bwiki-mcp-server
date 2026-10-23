/**
 * wiki 的 {exec:…} 凭证命令失败、超时或无输出时抛出。
 * 直到首次使用该站点才出现，启动时不触发。
 * 消息仅含命令名与截断后的 stderr，不含 stdout 与密钥本身。
 */
export class CredentialResolutionError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'CredentialResolutionError';
	}
}
