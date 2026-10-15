/**
 * 通知邮件的模板层（纯函数，零依赖）。
 *
 * 结构：
 * - `TEMPLATE_SCENARIOS` 四个场景（新评论/回复/已公开/未通过），每个场景一套 `{ 主题, HTML }`；
 * - `DEFAULT_TEMPLATES` 是**内置默认模板**，本身就是用 `{{变量}}` 写的 —— 所以「默认」与「自定义」
 *   走的是同一条渲染路径，后台编辑框里显示的也就是它；
 * - 纯文本正文由 HTML **自动降级**生成（去标签、保留链接与换行），因此后台只需要 4 个 HTML 输入框；
 * - 设置里对应字段留空 = 用内置默认。
 *
 * 安全约定：HTML 模式下所有变量都经过转义（正文额外把换行变成 `<br>`），
 * 因此模板作者无法通过变量注入标签；主题行不做 HTML 转义但会清理控制字符（防邮件头注入）。
 */
import { normalizeCrlf, sanitizeHeaderText } from './mime.js';
import { htmlToText, renderTemplate } from './template-engine.js';
/** 四个场景（后台页按此顺序展示）。 */
export const TEMPLATE_SCENARIOS = [
    { key: 'admin-new-comment', label: '新评论 → 站长', hint: '收到评论时发给你自己，按「新评论通知范围」过滤状态' },
    { key: 'reply-to-parent', label: '回复 → 被回复者', hint: '该回复最终公开时，发给被回复的评论作者' },
    { key: 'comment-approved', label: '已公开 → 评论者', hint: '评论通过审核并公开时，通知评论者本人' },
    { key: 'comment-rejected', label: '未通过 → 评论者', hint: '默认关闭；开启后判为垃圾/回收站时发送' }
];
/** 每个场景在插件设置里对应的两个键（主题 / HTML 正文）。 */
export const TEMPLATE_SETTING_KEYS = {
    'admin-new-comment': { subject: 'templateAdminNewSubject', html: 'templateAdminNewHtml' },
    'reply-to-parent': { subject: 'templateReplySubject', html: 'templateReplyHtml' },
    'comment-approved': { subject: 'templateApprovedSubject', html: 'templateApprovedHtml' },
    'comment-rejected': { subject: 'templateRejectedSubject', html: 'templateRejectedHtml' }
};
/** 模板正文允许的最大长度（与 manifest 的 maxLength 保持一致）。 */
export const TEMPLATE_MAX_LENGTH = 20000;
/** 主题行允许的最大长度。 */
export const TEMPLATE_SUBJECT_MAX_LENGTH = 300;
/** 可用变量清单（后台页据此渲染「点选插入」的芯片）。 */
export const TEMPLATE_VARIABLES = [
    { name: 'siteTitle', label: '站点标题' },
    { name: 'siteUrl', label: '站点地址' },
    { name: 'kindLabel', label: '通知类型', hint: '如「新评论 → 站长」' },
    { name: 'postTitle', label: '文章标题' },
    { name: 'postUrl', label: '文章地址', hint: '绝对地址，可直接放进 href' },
    { name: 'commentUrl', label: '直达该评论的链接', hint: '带 #comment-<id>，点开就跳到那一楼' },
    { name: 'adminUrl', label: '后台评论审核页' },
    { name: 'commentId', label: '评论 ID' },
    { name: 'authorName', label: '评论者昵称' },
    { name: 'authorEmail', label: '评论者邮箱' },
    { name: 'authorUrl', label: '评论者网址', hint: '访客没填时为空' },
    { name: 'content', label: '评论正文', hint: 'HTML 模板里会保留换行；请放在正文位置，不要放进 href' },
    { name: 'contentExcerpt', label: '评论正文（500 字截断）' },
    { name: 'status', label: '状态全称', hint: '待审核 / 已公开 / 垃圾评论 / 回收站' },
    { name: 'statusShort', label: '状态简称', hint: '待审 / 已公开 / 垃圾 / 回收站' },
    { name: 'statusKey', label: '状态标识', hint: 'pending / approved / spam / trash' },
    { name: 'parentAuthorName', label: '被回复者昵称' },
    { name: 'parentAuthorEmail', label: '被回复者邮箱' },
    { name: 'mailDate', label: '生成时间', hint: 'YYYY-MM-DD HH:mm' },
    { name: 'year', label: '年份' }
];
const EXCERPT_LIMIT = 500;
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const STATUS_LABEL = {
    pending: '待审核',
    approved: '已公开',
    spam: '垃圾评论',
    trash: '回收站'
};
const STATUS_SHORT = {
    pending: '待审',
    approved: '已公开',
    spam: '垃圾',
    trash: '回收站'
};
/* ------------------------------ 内置默认模板 ------------------------------ */
const BUTTON_STYLE = 'display:inline-block;margin:2px 10px 8px 0;padding:8px 14px;border:1px solid #d1d5db;border-radius:6px;color:#111827;text-decoration:none;font-size:13px;';
const QUOTE_STYLE = 'margin:14px 0;padding:12px 14px;border-left:3px solid #d1d5db;background:#f9fafb;color:#111827;word-break:break-word;font-size:14px;';
const TITLE_STYLE = 'margin:0 0 12px;font-size:15px;font-weight:600;';
const MUTED_STYLE = 'margin:0;color:#6b7280;font-size:12px;line-height:1.6;';
const LABEL_CELL = 'padding:2px 12px 2px 0;color:#6b7280;white-space:nowrap;';
const VALUE_CELL = 'padding:2px 0;color:#111827;word-break:break-word;';
/** 统一的邮件外壳：内联样式、无外部资源；页脚文案也在模板里，可被自定义。 */
function shell(inner) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{siteTitle}}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f3f4f6;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:22px 22px 16px;font-family:${FONT_STACK};font-size:14px;line-height:1.7;color:#111827;">
${inner}
    <hr style="margin:18px 0 10px;border:0;border-top:1px solid #e5e7eb;">
    <p style="${MUTED_STYLE}">本邮件由 {{siteTitle}} 自动发送，请勿直接回复。</p>
  </div>
</body>
</html>`;
}
const ADMIN_INNER = `    <p style="${TITLE_STYLE}">《{{postTitle}}》收到一条新评论</p>
    <table role="presentation" style="margin:0 0 6px;border-collapse:collapse;font-size:13px;">
      <tr><td style="${LABEL_CELL}">评论者</td><td style="${VALUE_CELL}">{{authorName}}</td></tr>
      <tr><td style="${LABEL_CELL}">邮箱</td><td style="${VALUE_CELL}">{{authorEmail}}</td></tr>
      <tr><td style="${LABEL_CELL}">状态</td><td style="${VALUE_CELL}">{{status}}</td></tr>
      <tr><td style="${LABEL_CELL}">时间</td><td style="${VALUE_CELL}">{{mailDate}}</td></tr>
    </table>
    <blockquote style="${QUOTE_STYLE}">{{content}}</blockquote>
    <a href="{{commentUrl}}" style="${BUTTON_STYLE}">查看文章并回复</a>
    <a href="{{adminUrl}}" style="${BUTTON_STYLE}">后台审核评论</a>`;
const REPLY_INNER = `    <p style="${TITLE_STYLE}">{{authorName}} 在《{{postTitle}}》中回复了你</p>
    <p style="margin:0 0 12px;color:#6b7280;">{{parentAuthorName}}，你好：</p>
    <blockquote style="${QUOTE_STYLE}">{{content}}</blockquote>
    <a href="{{commentUrl}}" style="${BUTTON_STYLE}">查看并回复</a>`;
const APPROVED_INNER = `    <p style="${TITLE_STYLE}">你在《{{postTitle}}》中的评论已通过审核并公开显示</p>
    <blockquote style="${QUOTE_STYLE}">{{contentExcerpt}}</blockquote>
    <a href="{{commentUrl}}" style="${BUTTON_STYLE}">查看文章</a>`;
const REJECTED_INNER = `    <p style="${TITLE_STYLE}">你在《{{postTitle}}》中的评论未通过审核</p>
    <table role="presentation" style="margin:0 0 6px;border-collapse:collapse;font-size:13px;">
      <tr><td style="${LABEL_CELL}">状态</td><td style="${VALUE_CELL}">{{status}}</td></tr>
      <tr><td style="${LABEL_CELL}">时间</td><td style="${VALUE_CELL}">{{mailDate}}</td></tr>
    </table>
    <blockquote style="${QUOTE_STYLE}">{{contentExcerpt}}</blockquote>
    <p style="${MUTED_STYLE}">如认为判定有误，可回信联系站长。</p>`;
/** 内置默认模板（后台编辑框里展示的就是这些内容）。 */
export const DEFAULT_TEMPLATES = {
    'admin-new-comment': {
        subject: '【{{siteTitle}}】新评论（{{statusShort}}）：{{postTitle}}',
        html: shell(ADMIN_INNER)
    },
    'reply-to-parent': {
        subject: '【{{siteTitle}}】{{authorName}} 回复了你',
        html: shell(REPLY_INNER)
    },
    'comment-approved': {
        subject: '【{{siteTitle}}】你的评论已公开',
        html: shell(APPROVED_INNER)
    },
    'comment-rejected': {
        subject: '【{{siteTitle}}】你的评论未通过审核',
        html: shell(REJECTED_INNER)
    }
};
/* ------------------------------ 渲染 ------------------------------ */
/** 渲染一封通知邮件：默认模板与自定义模板走同一条路径。 */
export function renderMail(context, overrides = {}) {
    const raw = buildVariables(context);
    const htmlVars = toHtmlVariables(raw);
    const fallback = DEFAULT_TEMPLATES[context.kind];
    const override = overrides[context.kind] ?? {};
    const subjectTemplate = pickOverride(override.subject) ?? fallback.subject;
    const htmlTemplate = pickOverride(override.html) ?? fallback.html;
    const subject = renderTemplate(subjectTemplate, raw);
    const html = renderTemplate(htmlTemplate, htmlVars);
    const warnings = [];
    if (subject.unknown.length > 0) {
        warnings.push(`主题模板里有未识别的变量：${subject.unknown.map(asPlaceholder).join('、')}`);
    }
    if (html.unknown.length > 0) {
        warnings.push(`正文模板里有未识别的变量：${html.unknown.map(asPlaceholder).join('、')}`);
    }
    return {
        // 主题是邮件头，必须挡掉 CR/LF（防头注入）
        subject: sanitizeHeaderText(subject.output),
        // 主题行不支持换行，统一压平
        html: html.output,
        text: htmlToText(html.output),
        warnings
    };
}
/** 变量名 → 原始值（未转义）。 */
export function buildVariables(context) {
    const now = context.now ?? new Date();
    return {
        siteTitle: oneLine(context.siteTitle) || '站点',
        siteUrl: oneLine(context.siteUrl),
        kindLabel: scenarioLabel(context.kind),
        postTitle: oneLine(context.postTitle) || '未命名文章',
        postUrl: oneLine(context.postUrl),
        commentUrl: oneLine(context.commentUrl),
        adminUrl: oneLine(context.adminCommentsUrl),
        commentId: String(context.commentId),
        authorName: oneLine(context.authorName) || '匿名',
        authorEmail: oneLine(context.authorEmail),
        authorUrl: oneLine(context.authorUrl ?? ''),
        content: cleanBody(context.content),
        contentExcerpt: excerpt(context.content, EXCERPT_LIMIT),
        status: STATUS_LABEL[context.status],
        statusShort: STATUS_SHORT[context.status],
        statusKey: context.status,
        parentAuthorName: oneLine(context.parentAuthorName ?? ''),
        parentAuthorEmail: oneLine(context.parentAuthorEmail ?? ''),
        mailDate: formatDate(now),
        year: String(now.getFullYear())
    };
}
/** HTML 模式变量表：全部转义；正文额外把换行转成 `<br>`。 */
export function toHtmlVariables(raw) {
    const result = {};
    for (const [name, value] of Object.entries(raw)) {
        result[name] = name === 'content' || name === 'contentExcerpt' ? escapeHtmlWithBreaks(value) : escapeHtml(value);
    }
    return result;
}
/** HTML 转义（邮件模板不走宿主模板引擎，必须自己转义）。 */
export function escapeHtml(raw) {
    return (raw ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/** 转义 + 保留换行（HTML 正文用）。 */
export function escapeHtmlWithBreaks(raw) {
    return escapeHtml(raw).replace(/\r\n|\r|\n/g, '<br>');
}
/** 正文摘要：去掉控制字符、压缩空行、超长截断。 */
export function excerpt(raw, limit = EXCERPT_LIMIT) {
    const cleaned = cleanBody(raw);
    if (cleaned.length <= limit)
        return cleaned;
    return `${cleaned.slice(0, limit)}……（内容过长已截断，完整内容请在站内查看）`;
}
/* ------------------------------ 预览用示例数据 ------------------------------ */
/** 后台「预览」用的示例上下文（故意带中文、多行正文与链接）。 */
export function sampleMailContext(kind = 'admin-new-comment') {
    return {
        kind,
        siteTitle: '示例站点',
        siteUrl: 'https://blog.example.com',
        postTitle: '如何用 ricenote 搭一个干净的博客',
        postUrl: '/post/hello-world',
        commentUrl: 'https://blog.example.com/post/hello-world#comment-42',
        adminCommentsUrl: 'https://blog.example.com/admin/comments',
        commentId: 42,
        authorName: '小明',
        authorEmail: 'xiaoming@example.com',
        authorUrl: 'https://example.com/blog',
        content: '写得很清楚，谢谢！\n有两个小问题：\n1. 主题需要构建吗？\n2. 评论通知可以关掉吗？',
        status: 'pending',
        parentAuthorName: '站长',
        parentAuthorEmail: 'owner@example.com',
        now: new Date('2026-10-15T21:48:00+08:00')
    };
}
/* ------------------------------ 内部工具 ------------------------------ */
function pickOverride(value) {
    if (typeof value !== 'string')
        return undefined;
    return value.trim().length > 0 ? value : undefined;
}
function asPlaceholder(name) {
    return `{{${name}}}`;
}
function scenarioLabel(kind) {
    return TEMPLATE_SCENARIOS.find((item) => item.key === kind)?.label ?? kind;
}
/** 单行字段：去掉换行与控制字符（避免拼进属性或邮件头）。 */
function oneLine(raw) {
    return normalizeCrlf(raw ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}
/** 多行字段（正文）：保留换行，去掉其他控制字符，压缩连续空行。 */
function cleanBody(raw) {
    return normalizeCrlf(raw ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/[ \t]+\r\n/g, '\r\n')
        .replace(/(?:\r\n){3,}/g, '\r\n\r\n')
        .trim();
}
function formatDate(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
//# sourceMappingURL=templates.js.map