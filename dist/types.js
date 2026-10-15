/**
 * 插件内部类型。
 *
 * 这里刻意**镜像** `rice.comments` 事件 payload 的形状，而不是从共享包 import：
 * 除 `index.ts` 之外的所有模块都不依赖宿主运行时与类型包，因此可以被 `node --test`
 * 直接离线验证（评测的只是本插件自己的决策与协议实现）。
 */
export {};
//# sourceMappingURL=types.js.map