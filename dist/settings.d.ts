/**
 * 插件设置的读取与收敛。
 *
 * 两个关键约定（来自平台）：
 * - `ctx.config.get()` 返回的是**启动期快照**（manifest 默认值 ← 数据库覆盖），
 *   因此这里读一次、做一次 clamp，运行期不再重复读取；改设置必须重启生效。
 * - 插件设置**没有 secret 类型也没有加密存储**，所以 SMTP 密码只从环境变量读取。
 */
import type { SmtpConfig } from './types.js';
import { type TemplateKey, type TemplateOverrides } from './templates.js';
/** 只依赖结构，不 import 宿主类型，便于离线测试。 */
export interface SettingsSource {
    get<T>(key: string, fallback: T): T;
    all(): Record<string, unknown>;
}
export type NewCommentFilter = 'all' | 'exclude-spam' | 'approved-only';
/** 收敛后的生效设置（非法值一律回退到安全默认值）。 */
export interface EffectiveSettings {
    notifyAdminOnNew: boolean;
    adminRecipients: string[];
    newCommentFilter: NewCommentFilter;
    notifyParentOnReply: boolean;
    notifyCommenterOnApproved: boolean;
    notifyCommenterOnRejected: boolean;
    adminMailReplyToCommenter: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: 'ssl' | 'starttls' | 'none';
    smtpUser: string;
    smtpFromAddress: string;
    smtpFromName: string;
    smtpReplyTo: string;
    smtpTimeoutMs: number;
    rateLimitPerMinute: number;
}
/** 运行期凭据：密码只可能来自环境变量。 */
export interface MailCredentials {
    user: string;
    password: string;
    /** 认证账号是否由环境变量覆盖。 */
    userFromEnv: boolean;
    /** 环境变量里是否存在非空密码。 */
    passwordFromEnv: boolean;
}
/** 后台「配置自检」的一条结论。 */
export interface ReadinessItem {
    level: 'ok' | 'warn' | 'error';
    label: string;
    detail?: string;
}
export declare const ENV_PASSWORD = "RICE_MAIL_PASSWORD";
export declare const ENV_USER = "RICE_MAIL_USER";
/** 读取并收敛全部设置。 */
export declare function readSettings(config: SettingsSource): EffectiveSettings;
/**
 * 读取模板覆盖。
 *
 * 规则很简单：设置里留空 = 用内置默认模板；非空即作为该场景的模板。
 * 主题与 HTML 正文可以只覆盖其中一个。
 */
export declare function readTemplateOverrides(config: SettingsSource): TemplateOverrides;
/** 哪些场景自定义了模板（后台展示用）。 */
export declare function customizedTemplateKeys(overrides: TemplateOverrides): TemplateKey[];
/**
 * 解析凭据。
 *
 * 密码**只从环境变量来**；账号允许被 `RICE_MAIL_USER` 覆盖，方便把整套凭据放进部署环境
 * 而不必改动设置（设置里留空账号时也必须配 `RICE_MAIL_USER` 才会认证）。
 */
export declare function resolveCredentials(settings: EffectiveSettings, env?: Record<string, string | undefined>): MailCredentials;
/** 组装 SMTP 客户端参数。 */
export declare function toSmtpConfig(settings: EffectiveSettings, credentials: MailCredentials): SmtpConfig;
/** 后台展示用的「生效参数」（**不含任何凭据**）。 */
export declare function describeSettings(settings: EffectiveSettings, credentials: MailCredentials, siteTitle: string): Record<string, unknown>;
/** 配置自检：后台第一屏要能一眼看出「为什么发不出去」。 */
export declare function buildReadiness(settings: EffectiveSettings, credentials: MailCredentials): ReadinessItem[];
/** 宽松但严格的邮箱校验：恰好一个 `@`、无空白、域名带点、总长 ≤ 254。 */
export declare function isEmailAddress(value: string): boolean;
/** 站点地址归一化：去掉尾部斜杠，便于拼接路径。 */
export declare function normalizeBaseUrl(url: string): string;
