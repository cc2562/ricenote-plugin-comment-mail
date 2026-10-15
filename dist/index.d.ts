/**
 * 评论邮件通知插件（`ccrice.comment-mail`）。
 *
 * 职责边界（与平台的契合点）：
 * - 订阅 `rice.comments` 的 `content.comment.created.v1` 与 `content.comment.status.changed.v1`；
 *   事件处理器**只做决策与入队**，立即返回 —— 因为事件总线会 `await` 全部订阅者，
 *   在这里同步发信会把评论提交/审核接口一起拖慢。
 * - 真正的投递由 `MailQueue` 的常驻 worker 完成（单并发、退避重试、滑动窗口限速）。
 * - 后台页通过 `routes:admin` 的管理 API 拿到自检结论、生效参数与投递记录。
 *
 * 能力面只有 `events:subscribe` + `routes:admin`；不建表（无 `database:own`），
 * 因为平台没有可用的持久化队列，投递记录刻意只留在内存里。
 */
declare const _default: import("@ricenote/plugin-sdk").Plugin;
export default _default;
