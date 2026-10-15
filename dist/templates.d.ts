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
import type { CommentStatus } from './types.js';
export type TemplateKey = 'admin-new-comment' | 'reply-to-parent' | 'comment-approved' | 'comment-rejected';
export interface TemplateScenario {
    key: TemplateKey;
    label: string;
    hint: string;
}
/** 四个场景（后台页按此顺序展示）。 */
export declare const TEMPLATE_SCENARIOS: readonly TemplateScenario[];
/** 每个场景在插件设置里对应的两个键（主题 / HTML 正文）。 */
export declare const TEMPLATE_SETTING_KEYS: Record<TemplateKey, {
    subject: string;
    html: string;
}>;
/** 模板覆盖（设置里为空串的项不会出现在这里）。 */
export type TemplateOverrides = Partial<Record<TemplateKey, {
    subject?: string;
    html?: string;
}>>;
/** 模板正文允许的最大长度（与 manifest 的 maxLength 保持一致）。 */
export declare const TEMPLATE_MAX_LENGTH = 20000;
/** 主题行允许的最大长度。 */
export declare const TEMPLATE_SUBJECT_MAX_LENGTH = 300;
export interface TemplateVariable {
    name: string;
    label: string;
    hint?: string;
}
/** 可用变量清单（后台页据此渲染「点选插入」的芯片）。 */
export declare const TEMPLATE_VARIABLES: readonly TemplateVariable[];
/** 渲染一封通知邮件所需的业务上下文。 */
export interface MailContext {
    kind: TemplateKey;
    siteTitle: string;
    /** 站点绝对地址（已去尾斜杠，可为空）。 */
    siteUrl: string;
    postTitle: string;
    /** 文章前台路径（可为空）。 */
    postUrl: string;
    /** 直达该条评论的绝对地址。 */
    commentUrl: string;
    /** 后台评论审核页地址。 */
    adminCommentsUrl: string;
    commentId: number;
    authorName: string;
    authorEmail: string;
    authorUrl?: string;
    /** 评论正文原文（未消毒）。 */
    content: string;
    status: CommentStatus;
    parentAuthorName?: string;
    parentAuthorEmail?: string;
    now?: Date;
}
/** 渲染结果。 */
export interface RenderedMail {
    subject: string;
    text: string;
    html: string;
    /** 模板里未识别的变量等告警（原样保留在正文中，同时回报给调用方记日志）。 */
    warnings: string[];
}
/** 内置默认模板（后台编辑框里展示的就是这些内容）。 */
export declare const DEFAULT_TEMPLATES: Record<TemplateKey, {
    subject: string;
    html: string;
}>;
/** 渲染一封通知邮件：默认模板与自定义模板走同一条路径。 */
export declare function renderMail(context: MailContext, overrides?: TemplateOverrides): RenderedMail;
/** 变量名 → 原始值（未转义）。 */
export declare function buildVariables(context: MailContext): Record<string, string>;
/** HTML 模式变量表：全部转义；正文额外把换行转成 `<br>`。 */
export declare function toHtmlVariables(raw: Record<string, string>): Record<string, string>;
/** HTML 转义（邮件模板不走宿主模板引擎，必须自己转义）。 */
export declare function escapeHtml(raw: string): string;
/** 转义 + 保留换行（HTML 正文用）。 */
export declare function escapeHtmlWithBreaks(raw: string): string;
/** 正文摘要：去掉控制字符、压缩空行、超长截断。 */
export declare function excerpt(raw: string, limit?: number): string;
/** 后台「预览」用的示例上下文（故意带中文、多行正文与链接）。 */
export declare function sampleMailContext(kind?: TemplateKey): MailContext;
