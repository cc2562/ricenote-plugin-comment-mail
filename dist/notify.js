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
import { isEmailAddress, normalizeBaseUrl } from './settings.js';
import { renderMail } from './templates.js';
const STATUSES = ['pending', 'approved', 'spam', 'trash'];
/**
 * 把事件 payload 收敛成可信形状。
 *
 * payload 来自另一个插件（`rice.comments`），这里做一次防御性校验：
 * 形状不对就整条忽略，绝不让脏数据把事件处理器打崩（那会污染评论提交链路）。
 */
export function normalizeCommentPayload(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const record = raw;
    const id = Number(record.id);
    const postId = Number(record.postId);
    const status = typeof record.status === 'string' ? record.status : undefined;
    if (!Number.isInteger(id) || id <= 0)
        return undefined;
    if (!Number.isInteger(postId) || postId <= 0)
        return undefined;
    if (!status || !STATUSES.includes(status))
        return undefined;
    const parentId = record.parentId === null || record.parentId === undefined ? null : Number(record.parentId);
    const payload = {
        id,
        postId,
        parentId: parentId !== null && Number.isInteger(parentId) ? parentId : null,
        authorName: stringOr(record.authorName, ''),
        authorEmail: stringOr(record.authorEmail, '').toLowerCase(),
        content: stringOr(record.content, ''),
        status
    };
    const postTitle = stringOr(record.postTitle, '');
    if (postTitle.length > 0)
        payload.postTitle = postTitle;
    const postUrl = stringOr(record.postUrl, '');
    if (postUrl.length > 0)
        payload.postUrl = postUrl;
    const parentAuthorName = stringOr(record.parentAuthorName, '');
    if (parentAuthorName.length > 0)
        payload.parentAuthorName = parentAuthorName;
    const parentAuthorEmail = stringOr(record.parentAuthorEmail, '');
    if (parentAuthorEmail.length > 0)
        payload.parentAuthorEmail = parentAuthorEmail.toLowerCase();
    const from = typeof record.from === 'string' ? record.from : undefined;
    if (from && STATUSES.includes(from))
        payload.from = from;
    return payload;
}
/** `content.comment.created.v1`：新评论 → 站长；若评论已直接公开，同时通知被回复者。 */
export function tasksForNewComment(payload, input) {
    const tasks = adminTasks(payload, input);
    if (payload.status === 'approved')
        tasks.push(...replyTasks(payload, input));
    return tasks;
}
/** `content.comment.status.changed.v1`：公开 → 回复通知 + 评论者通知；垃圾/回收站 → 可选通知。 */
export function tasksForStatusChange(payload, input) {
    // 状态没变就没有通知（平台只会在真正变化时发事件，这里再兜一层）
    if (payload.from !== undefined && payload.from === payload.status)
        return [];
    const tasks = [];
    if (payload.status === 'approved') {
        tasks.push(...replyTasks(payload, input));
        if (input.settings.notifyCommenterOnApproved) {
            tasks.push(...commenterTasks(payload, input, 'comment-approved'));
        }
    }
    else if (payload.status === 'spam' || payload.status === 'trash') {
        if (input.settings.notifyCommenterOnRejected) {
            tasks.push(...commenterTasks(payload, input, 'comment-rejected'));
        }
    }
    return tasks;
}
/** 拼装指向某条评论的绝对地址（`#comment-<id>` 与评论插槽的 DOM id 对应）。 */
export function commentUrlOf(payload, siteUrl) {
    const base = normalizeBaseUrl(siteUrl);
    const raw = (payload.postUrl ?? '').trim().split('#')[0] ?? '';
    let target;
    if (/^https?:\/\//i.test(raw))
        target = raw;
    else if (raw.startsWith('/'))
        target = `${base}${raw}`;
    else
        target = base.length > 0 ? `${base}/` : '/';
    return `${target}#comment-${payload.id}`;
}
/** 后台评论审核页地址（评论审核页由 rice.comments 提供在 `/admin/comments`）。 */
export function adminCommentsUrlOf(siteUrl) {
    return `${normalizeBaseUrl(siteUrl)}/admin/comments`;
}
/* ------------------------------ 内部实现 ------------------------------ */
function adminTasks(payload, input) {
    const settings = input.settings;
    if (!settings.notifyAdminOnNew)
        return [];
    if (!isInAdminScope(payload.status, settings.newCommentFilter))
        return [];
    const recipients = settings.adminRecipients.filter(isEmailAddress);
    if (recipients.length === 0)
        return [];
    const rendered = renderMail(mailContextOf(payload, input, 'admin-new-comment'), input.templates);
    const replyTo = adminReplyTo(payload, settings);
    return recipients.map((to) => createTask(payload, 'admin-new-comment', to, rendered, `admin:${payload.id}:${to.toLowerCase()}`, replyTo));
}
function replyTasks(payload, input) {
    const settings = input.settings;
    if (!settings.notifyParentOnReply)
        return [];
    if (payload.parentId === null)
        return [];
    const target = (payload.parentAuthorEmail ?? '').trim();
    if (!isEmailAddress(target))
        return [];
    const lower = target.toLowerCase();
    // 自己回复自己不必通知
    if (payload.authorEmail.length > 0 && lower === payload.authorEmail.toLowerCase())
        return [];
    // 被回复者就是站长收件人时，他已在「新评论」通知里见过这条评论
    if (settings.adminRecipients.some((address) => address.toLowerCase() === lower))
        return [];
    const rendered = renderMail(mailContextOf(payload, input, 'reply-to-parent'), input.templates);
    return [createTask(payload, 'reply-to-parent', target, rendered, `reply:${payload.id}:${lower}`)];
}
function commenterTasks(payload, input, kind) {
    const target = payload.authorEmail.trim();
    if (!isEmailAddress(target))
        return [];
    const lower = target.toLowerCase();
    // 站长自己发的评论不再给自己回一封
    if (input.settings.adminRecipients.some((address) => address.toLowerCase() === lower))
        return [];
    const rendered = renderMail(mailContextOf(payload, input, kind), input.templates);
    return [createTask(payload, kind, target, rendered, `${kind}:${payload.id}:${lower}`)];
}
function createTask(payload, kind, to, rendered, dedupeKey, replyTo) {
    return {
        kind,
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        dedupeKey,
        commentId: payload.id,
        ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {}),
        ...(replyTo ? { replyTo } : {})
    };
}
/** 站长通知的 Reply-To：优先评论者邮箱（便于直接回信），否则用兜底地址。 */
function adminReplyTo(payload, settings) {
    if (settings.adminMailReplyToCommenter && isEmailAddress(payload.authorEmail)) {
        return payload.authorEmail;
    }
    return isEmailAddress(settings.smtpReplyTo) ? settings.smtpReplyTo : undefined;
}
function isInAdminScope(status, filter) {
    if (filter === 'all')
        return true;
    if (filter === 'approved-only')
        return status === 'approved';
    return status === 'pending' || status === 'approved';
}
/**
 * 文章地址：事件的 `postUrl` 是**站内路径**（如 `/post/hello`），
 * 而邮件里的链接必须是绝对地址，这里统一补上站点前缀。
 */
function absolutePostUrl(raw, siteUrl) {
    const value = (raw ?? '').trim();
    if (value.length === 0)
        return '';
    if (/^https?:\/\//i.test(value))
        return value;
    if (!value.startsWith('/'))
        return '';
    // 不假设调用方已经去掉尾斜杠，这里再归一化一次，避免拼出 `//post/xxx`
    const base = normalizeBaseUrl(siteUrl);
    return base.length > 0 ? `${base}${value}` : value;
}
/** 组装模板渲染上下文（链接由本插件拼装，绝不使用访客提供的地址）。 */
function mailContextOf(payload, input, kind) {
    return {
        kind,
        siteTitle: input.siteTitle,
        siteUrl: input.siteUrl,
        postTitle: payload.postTitle ?? '',
        postUrl: absolutePostUrl(payload.postUrl ?? '', input.siteUrl),
        commentUrl: commentUrlOf(payload, input.siteUrl),
        adminCommentsUrl: adminCommentsUrlOf(input.siteUrl),
        commentId: payload.id,
        authorName: payload.authorName,
        authorEmail: payload.authorEmail,
        content: payload.content,
        status: payload.status,
        ...(payload.parentAuthorName ? { parentAuthorName: payload.parentAuthorName } : {}),
        ...(payload.parentAuthorEmail ? { parentAuthorEmail: payload.parentAuthorEmail } : {})
    };
}
function stringOr(value, fallback) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number')
        return String(value);
    return fallback;
}
//# sourceMappingURL=notify.js.map