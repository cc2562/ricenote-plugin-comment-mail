/**
 * 插件设置的读取与收敛。
 *
 * 两个关键约定（来自平台）：
 * - `ctx.config.get()` 返回的是**启动期快照**（manifest 默认值 ← 数据库覆盖），
 *   因此这里读一次、做一次 clamp，运行期不再重复读取；改设置必须重启生效。
 * - 插件设置**没有 secret 类型也没有加密存储**，所以 SMTP 密码只从环境变量读取。
 */
import { TEMPLATE_MAX_LENGTH, TEMPLATE_SETTING_KEYS, TEMPLATE_SUBJECT_MAX_LENGTH } from './templates.js';
export const ENV_PASSWORD = 'RICE_MAIL_PASSWORD';
export const ENV_USER = 'RICE_MAIL_USER';
const FILTERS = ['all', 'exclude-spam', 'approved-only'];
const SECURE_MODES = ['ssl', 'starttls', 'none'];
/** 读取并收敛全部设置。 */
export function readSettings(config) {
    return {
        notifyAdminOnNew: bool(config.get('notifyAdminOnNew', true), true),
        adminRecipients: emailList(config.get('adminRecipients', [])),
        newCommentFilter: pick(config.get('newCommentFilter', 'exclude-spam'), FILTERS, 'exclude-spam'),
        notifyParentOnReply: bool(config.get('notifyParentOnReply', true), true),
        notifyCommenterOnApproved: bool(config.get('notifyCommenterOnApproved', true), true),
        notifyCommenterOnRejected: bool(config.get('notifyCommenterOnRejected', false), false),
        adminMailReplyToCommenter: bool(config.get('adminMailReplyToCommenter', true), true),
        smtpHost: text(config.get('smtpHost', ''), 253),
        smtpPort: clampInt(config.get('smtpPort', 465), 1, 65535, 465),
        smtpSecure: pick(config.get('smtpSecure', 'ssl'), SECURE_MODES, 'ssl'),
        smtpUser: text(config.get('smtpUser', ''), 320),
        smtpFromAddress: text(config.get('smtpFromAddress', ''), 320),
        smtpFromName: text(config.get('smtpFromName', ''), 120),
        smtpReplyTo: text(config.get('smtpReplyTo', ''), 320),
        smtpTimeoutMs: clampInt(config.get('smtpTimeoutMs', 15000), 1000, 60000, 15000),
        rateLimitPerMinute: clampInt(config.get('rateLimitPerMinute', 30), 1, 120, 30)
    };
}
/**
 * 读取模板覆盖。
 *
 * 规则很简单：设置里留空 = 用内置默认模板；非空即作为该场景的模板。
 * 主题与 HTML 正文可以只覆盖其中一个。
 */
export function readTemplateOverrides(config) {
    const overrides = {};
    for (const [key, names] of Object.entries(TEMPLATE_SETTING_KEYS)) {
        const subject = multiline(config.get(names.subject, ''), TEMPLATE_SUBJECT_MAX_LENGTH);
        const html = multiline(config.get(names.html, ''), TEMPLATE_MAX_LENGTH);
        if (subject.length === 0 && html.length === 0)
            continue;
        overrides[key] = {
            ...(subject.length > 0 ? { subject } : {}),
            ...(html.length > 0 ? { html } : {})
        };
    }
    return overrides;
}
/** 哪些场景自定义了模板（后台展示用）。 */
export function customizedTemplateKeys(overrides) {
    return Object.entries(overrides)
        .filter(([, value]) => Boolean(value?.subject || value?.html))
        .map(([key]) => key);
}
/**
 * 解析凭据。
 *
 * 密码**只从环境变量来**；账号允许被 `RICE_MAIL_USER` 覆盖，方便把整套凭据放进部署环境
 * 而不必改动设置（设置里留空账号时也必须配 `RICE_MAIL_USER` 才会认证）。
 */
export function resolveCredentials(settings, env = runtimeEnv()) {
    const envUser = text(env[ENV_USER] ?? '', 320);
    const envPassword = typeof env[ENV_PASSWORD] === 'string' ? env[ENV_PASSWORD] : '';
    const user = envUser.length > 0 ? envUser : settings.smtpUser;
    return {
        user,
        password: user.length > 0 ? envPassword : '',
        userFromEnv: envUser.length > 0,
        passwordFromEnv: envPassword.length > 0
    };
}
/** 组装 SMTP 客户端参数。 */
export function toSmtpConfig(settings, credentials) {
    return {
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        user: credentials.user,
        password: credentials.password,
        timeoutMs: settings.smtpTimeoutMs
    };
}
/** 后台展示用的「生效参数」（**不含任何凭据**）。 */
export function describeSettings(settings, credentials, siteTitle) {
    return {
        fromAddress: settings.smtpFromAddress,
        fromName: settings.smtpFromName.trim() || siteTitle,
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        authUser: credentials.user || '',
        authUserFromEnv: credentials.userFromEnv,
        authWithoutPassword: credentials.user.length > 0 && credentials.password.length === 0,
        timeoutMs: settings.smtpTimeoutMs,
        rateLimitPerMinute: settings.rateLimitPerMinute,
        adminRecipients: settings.adminRecipients,
        newCommentFilter: settings.newCommentFilter,
        notifyAdminOnNew: settings.notifyAdminOnNew,
        notifyParentOnReply: settings.notifyParentOnReply,
        notifyCommenterOnApproved: settings.notifyCommenterOnApproved,
        notifyCommenterOnRejected: settings.notifyCommenterOnRejected,
        adminMailReplyToCommenter: settings.adminMailReplyToCommenter,
        replyTo: settings.smtpReplyTo
    };
}
/** 配置自检：后台第一屏要能一眼看出「为什么发不出去」。 */
export function buildReadiness(settings, credentials) {
    const items = [];
    if (settings.smtpHost.length === 0) {
        items.push({ level: 'error', label: 'SMTP 服务器未配置', detail: '请在「扩展中心 → 插件设置 → 评论邮件通知」里填写服务器与端口。' });
    }
    else {
        items.push({ level: 'ok', label: 'SMTP 服务器', detail: `${settings.smtpHost}:${settings.smtpPort}（${settings.smtpSecure}）` });
    }
    if (settings.smtpFromAddress.length === 0) {
        items.push({ level: 'error', label: '发件地址未配置', detail: '缺少发件地址时不会发出任何邮件。' });
    }
    else if (!isEmailAddress(settings.smtpFromAddress)) {
        items.push({ level: 'error', label: '发件地址非法', detail: `「${settings.smtpFromAddress}」不是合法邮箱地址。` });
    }
    else {
        items.push({ level: 'ok', label: '发件地址', detail: settings.smtpFromAddress });
    }
    if (credentials.user.length > 0 && credentials.password.length === 0) {
        items.push({
            level: 'error',
            label: `缺少 SMTP 密码环境变量`,
            detail: `已配置认证账号「${credentials.user}」，请在服务端设置环境变量 ${ENV_PASSWORD} 后重启。密码不保存在插件设置里。`
        });
    }
    else if (credentials.user.length > 0) {
        items.push({ level: 'ok', label: 'SMTP 认证', detail: `账号 ${credentials.user}${credentials.userFromEnv ? '（来自环境变量）' : ''}` });
    }
    else {
        items.push({ level: 'warn', label: '未配置 SMTP 认证', detail: '仅适用于内网中继或允许匿名投递的服务器。' });
    }
    if (settings.smtpSecure === 'none' && credentials.user.length > 0) {
        items.push({ level: 'warn', label: '凭据将明文传输', detail: '当前为「不加密」连接，请优先使用隐式 TLS 或 STARTTLS。' });
    }
    if (settings.notifyAdminOnNew && settings.adminRecipients.length === 0) {
        items.push({ level: 'warn', label: '新评论通知已开启但没有收件人', detail: '请填写「站长收件人邮箱」，否则这条通知不会发出。' });
    }
    else if (settings.adminRecipients.length > 0) {
        const invalid = settings.adminRecipients.filter((address) => !isEmailAddress(address));
        if (invalid.length > 0) {
            items.push({ level: 'warn', label: '有收件人地址格式可疑', detail: `将被跳过：${invalid.join('、')}` });
        }
        else {
            items.push({ level: 'ok', label: '站长收件人', detail: `${settings.adminRecipients.length} 个地址` });
        }
    }
    if (settings.smtpReplyTo.length > 0 && !isEmailAddress(settings.smtpReplyTo)) {
        items.push({ level: 'warn', label: '兜底回复地址格式可疑', detail: `将被忽略：${settings.smtpReplyTo}` });
    }
    return items;
}
/* ------------------------------ 小工具 ------------------------------ */
/**
 * 读取运行环境变量。
 *
 * 刻意不直接写 `process.env`：本模块要能脱离 Node 类型定义进行离线单元验证，
 * 结构化地从 `globalThis` 取即可（Node 上恒有 `process.env`）。
 */
function runtimeEnv() {
    const runtime = globalThis;
    return runtime.process?.env ?? {};
}
/** 宽松但严格的邮箱校验：恰好一个 `@`、无空白、域名带点、总长 ≤ 254。 */
export function isEmailAddress(value) {
    const candidate = value.trim();
    if (candidate.length === 0 || candidate.length > 254)
        return false;
    if (/\s/.test(candidate) || /[\r\n]/.test(candidate))
        return false;
    const parts = candidate.split('@');
    if (parts.length !== 2)
        return false;
    const [local, domain] = parts;
    if (local.length === 0 || local.length > 64)
        return false;
    if (domain.length === 0 || domain.length > 253)
        return false;
    if (!/^[^@,;:<>()[\]\\"']+$/.test(local))
        return false;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(domain)) {
        return false;
    }
    return true;
}
/** 站点地址归一化：去掉尾部斜杠，便于拼接路径。 */
export function normalizeBaseUrl(url) {
    const trimmed = (url ?? '').trim();
    if (trimmed.length === 0)
        return '';
    return trimmed.replace(/\/+$/, '');
}
/** 去重 + 过滤非法项的邮箱列表。 */
function emailList(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const result = [];
    for (const item of value) {
        if (typeof item !== 'string')
            continue;
        const address = item.trim();
        if (address.length === 0)
            continue;
        const key = address.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(address);
        if (result.length >= 20)
            break;
    }
    return result;
}
function pick(value, allowed, fallback) {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}
function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function text(value, maxLength) {
    if (typeof value !== 'string')
        return '';
    // 设置值可能来自后台输入：去掉控制字符与换行，避免把 CRLF 带进 SMTP 命令与邮件头
    const cleaned = value.replace(/[\r\n]+/g, ' ').trim();
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}
/** 多行文本（模板）：**保留换行**，只去掉控制字符并截断。 */
function multiline(value, maxLength) {
    if (typeof value !== 'string')
        return '';
    const cleaned = value
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}
function clampInt(value, min, max, fallback) {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
//# sourceMappingURL=settings.js.map