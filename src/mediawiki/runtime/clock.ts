// 经过时间（缓存 TTL、宽限期、日志时长）用此计时，而不用 Date.now，
// 后者会因宿主机校时前后跳动。此值自进程启动起单调递增。
//
// moves forwards.
//
// Date.now 仍适用于跨进程有意义的时间点：JWT 声明、对外发布的
// 时间戳、重启后仍需有效的 token 过期时间。
export function monotonicNow(): number {
	// performance.now 依赖 this，不能作为裸回调传递。
	return performance.now();
}
