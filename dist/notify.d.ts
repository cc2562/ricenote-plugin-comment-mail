/**
 * 通知决策（纯函数）。
 *
 * 设计要点：
 * - **事件即触发、审核即闸门**：对外（访客）的邮件只在评论「最终公开」时发出。
 *   这样既不会给垃圾评论的被回复者发信，也不会把待审内容外发。
 * - **去重键**由这里给出（`kind:评论id:收件人`），由队列统一兜底执行 ——
 *   因此「创建即通过」与「先审后通过」两条路径不会重复发信。
 * - 决策与发送解耦：本文件不碰网络、不碰时钟（除 id 外），可离线单元验证。
 */
import { type EffectiveSettings } from './settings.js';
import { type TemplateOverrides } from './templates.js';
import type { CommentEventPayload, MailTask } from './types.js';
/** 决策输入：设置 + 模板 + 站点信息（站点地址是动态的，因此每次事件重新取值）。 */
export interface NotifyInput {
    settings: EffectiveSettings;
    /** 模板覆盖（留空场景用内置默认模板）。 */
    templates: TemplateOverrides;
    siteTitle: string;
    /** 站点绝对地址（已去尾斜杠；允许为空，此时链接退化为站内路径）。 */
    siteUrl: string;
}
/**
 * 把事件 payload 收敛成可信形状。
 *
 * payload 来自另一个插件（`rice.comments`），这里做一次防御性校验：
 * 形状不对就整条忽略，绝不让脏数据把事件处理器打崩（那会污染评论提交链路）。
 */
export declare function normalizeCommentPayload(raw: unknown): CommentEventPayload | undefined;
/** `content.comment.created.v1`：新评论 → 站长；若评论已直接公开，同时通知被回复者。 */
export declare function tasksForNewComment(payload: CommentEventPayload, input: NotifyInput): MailTask[];
/** `content.comment.status.changed.v1`：公开 → 回复通知 + 评论者通知；垃圾/回收站 → 可选通知。 */
export declare function tasksForStatusChange(payload: CommentEventPayload, input: NotifyInput): MailTask[];
/** 拼装指向某条评论的绝对地址（`#comment-<id>` 与评论插槽的 DOM id 对应）。 */
export declare function commentUrlOf(payload: CommentEventPayload, siteUrl: string): string;
/** 后台评论审核页地址（评论审核页由 rice.comments 提供在 `/admin/comments`）。 */
export declare function adminCommentsUrlOf(siteUrl: string): string;
