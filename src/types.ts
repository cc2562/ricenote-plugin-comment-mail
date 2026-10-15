/**
 * 插件内部类型。
 *
 * 这里刻意**镜像** `rice.comments` 事件 payload 的形状，而不是从共享包 import：
 * 除 `index.ts` 之外的所有模块都不依赖宿主运行时与类型包，因此可以被 `node --test`
 * 直接离线验证（评测的只是本插件自己的决策与协议实现）。
 */

/** 评论审核状态（与 rice.comments 的四态一致）。 */
export type CommentStatus = 'pending' | 'approved' | 'spam' | 'trash';

/** `content.comment.created.v1` / `content.comment.status.changed.v1` 的 payload。 */
export interface CommentEventPayload {
  id: number;
  postId: number;
  postTitle?: string;
  /** 前台路径（`/post/xxx`），**不含**站点前缀；取不到文章时为 undefined。 */
  postUrl?: string;
  parentId: number | null;
  parentAuthorName?: string;
  parentAuthorEmail?: string;
  authorName: string;
  /** 已小写；站长允许访客不填邮箱时为空串。 */
  authorEmail: string;
  /** 评论正文原文（未消毒），进入邮件前必须转义。 */
  content: string;
  status: CommentStatus;
  /** 仅 `status.changed` 携带：变更前的状态。 */
  from?: CommentStatus;
}

/** 通知种类（用于邮件主题、后台记录分类与限流统计）。 */
export type MailKind =
  | 'admin-new-comment'
  | 'reply-to-parent'
  | 'comment-approved'
  | 'comment-rejected';

/** 一条渲染完成的待投递邮件。 */
export interface MailTask {
  kind: MailKind;
  /** 单个收件人：多收件人时逐封单发，彼此看不到对方邮箱。 */
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  /** 去重键：同一评论对同一收件人只发一次。 */
  dedupeKey: string;
  commentId: number;
  /** 模板渲染告警（如未识别的变量），由调用方记日志；不影响投递。 */
  warnings?: string[];
}

/** 投递记录状态。 */
export type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'dropped';

/** 后台可见的一条投递记录。 */
export interface DeliveryRecord {
  id: string;
  /** 入队时间（ISO 8601）。 */
  createdAt: string;
  updatedAt: string;
  kind: MailKind;
  commentId: number;
  to: string;
  subject: string;
  status: DeliveryStatus;
  /** 已尝试投递次数（含失败）。 */
  attempts: number;
  /** 下次重试时间（ISO 8601）；无待重试时不存在。 */
  nextAttemptAt?: string;
  /** 失败原因（**已脱敏**、已截断）。 */
  error?: string;
  /** 失败/待发记录保留原始任务以便手动重发；投递成功后释放。 */
  task?: MailTask;
}

/** SMTP 连接参数（来自插件设置 + 环境变量凭据）。 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: 'ssl' | 'starttls' | 'none';
  user: string;
  password: string;
  timeoutMs: number;
}
