// 本传输层在 MCP 处理器收到请求之前自行检测到的条件所用的 JSON-RPC 错误码。
// JSON-RPC 保留 -32768..-32000，MCP 不允许在其中新分配，
// 未定义的用途应放在保留区间之外，故这些码位于其上方。
// -32001 在 SDK 中还表示 session not found，需避开。
//
// convention.
export const AUTHENTICATION_REQUIRED_ERROR_CODE = -31001;
export const UPSTREAM_UNAVAILABLE_ERROR_CODE = -31002;
export const PAYLOAD_TOO_LARGE_ERROR_CODE = -31003;
export const RATE_LIMITED_ERROR_CODE = -31004;
