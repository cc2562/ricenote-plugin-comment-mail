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
import { definePlugin } from '@ricenote/plugin-sdk';
import { buildMessage } from './mime.js';
import { adminCommentsUrlOf, normalizeCommentPayload, tasksForNewComment, tasksForStatusChange } from './notify.js';
import { MailQueue } from './queue.js';
import { DeliveryLog } from './records.js';
import { buildReadiness, customizedTemplateKeys, describeSettings, isEmailAddress, normalizeBaseUrl, readSettings, readTemplateOverrides, resolveCredentials, toSmtpConfig } from './settings.js';
import { SmtpError, sendMail } from './smtp.js';
import { DEFAULT_TEMPLATES, TEMPLATE_MAX_LENGTH, TEMPLATE_SCENARIOS, TEMPLATE_SETTING_KEYS, TEMPLATE_SUBJECT_MAX_LENGTH, TEMPLATE_VARIABLES, escapeHtml, renderMail, sampleMailContext } from './templates.js';
/** 与 manifest.permissions 中的声明保持一致。 */
const PERMISSION_MANAGE = 'comment-mail.manage';
/** 插件停用时留给队列的排空时间。 */
const DRAIN_TIMEOUT_MS = 5000;
/** 投递记录缓冲上限。 */
const RECORD_LIMIT = 200;
/** 测试发信的总体上限（SMTP 自身另有单步超时）。 */
const TEST_TIMEOUT_MS = 30_000;
const EVENT_CREATED = 'content.comment.created.v1';
const EVENT_STATUS_CHANGED = 'content.comment.status.changed.v1';
/** 单个插件实例一份运行期状态（start/stop 之间共享）。 */
let runtime;
const disposers = [];
/** 模板告警去重（同一条告警只记一次，避免评论量大时刷屏）。 */
const warnedTemplates = new Set();
export default definePlugin({
    async start(ctx) {
        const settings = readSettings(ctx.config);
        const credentials = resolveCredentials(settings);
        const templates = readTemplateOverrides(ctx.config);
        const log = new DeliveryLog({ limit: RECORD_LIMIT, secrets: [credentials.password] });
        const queue = new MailQueue({
            log,
            logger: ctx.logger,
            rateLimitPerMinute: settings.rateLimitPerMinute,
            deliver: (task) => deliverTask(ctx, settings, credentials, task)
        });
        // 事件处理器是同步函数：决策 + 入队后立即返回，绝不 await 任何 I/O。
        disposers.push(ctx.events.on(EVENT_CREATED, (payload) => {
            dispatch(ctx, payload, 'created', queue, settings, templates);
        }), ctx.events.on(EVENT_STATUS_CHANGED, (payload) => {
            dispatch(ctx, payload, 'changed', queue, settings, templates);
        }));
        registerAdminApi(ctx, () => runtime);
        runtime = { settings, credentials, templates, log, queue, startedAt: new Date().toISOString() };
        const readiness = buildReadiness(settings, credentials);
        ctx.logger.info('评论邮件通知插件已就绪', {
            smtp: settings.smtpHost ? `${settings.smtpHost}:${settings.smtpPort}（${settings.smtpSecure}）` : '（未配置）',
            from: settings.smtpFromAddress || '（未配置）',
            adminRecipients: settings.adminRecipients.length,
            customTemplates: customizedTemplateKeys(templates),
            trouble: readiness.filter((item) => item.level !== 'ok').map((item) => item.label)
        });
        if (customizedTemplateKeys(templates).length === 0) {
            ctx.logger.debug('邮件模板全部使用内置默认（设置里留空即为默认）');
        }
    },
    async stop(ctx) {
        const current = runtime;
        runtime = undefined;
        while (disposers.length > 0) {
            const dispose = disposers.pop();
            try {
                dispose?.();
            }
            catch (error) {
                ctx.logger.warn('注销事件订阅失败', { error: messageOf(error) });
            }
        }
        if (!current)
            return;
        // 先排空（期间忽略限速与退避等待），再停止；反过来的话队列会被立刻掐断。
        const { pending } = await current.queue.drain(DRAIN_TIMEOUT_MS);
        current.queue.stop();
        if (pending > 0) {
            ctx.logger.warn('插件停止时仍有评论邮件未投递（记录仅存内存，将随进程结束丢失）', { pending });
        }
        ctx.logger.info('评论邮件通知插件已停止');
    }
});
/* ------------------------------ 事件 → 队列 ------------------------------ */
function dispatch(ctx, raw, kind, queue, settings, templates) {
    try {
        const payload = normalizeCommentPayload(raw);
        if (!payload) {
            ctx.logger.warn('评论事件 payload 形状不符合预期，已忽略', { event: kind });
            return;
        }
        // 站点标题与地址是动态的：每次事件重新取值，后台改站点地址无需重启。
        const input = {
            settings,
            templates,
            siteTitle: ctx.site.title,
            siteUrl: normalizeBaseUrl(ctx.site.url)
        };
        const tasks = kind === 'created' ? tasksForNewComment(payload, input) : tasksForStatusChange(payload, input);
        for (const task of tasks) {
            warnTemplateOnce(ctx, task);
            const result = queue.enqueue(task);
            if (!result.accepted && result.reason === 'queue-full') {
                ctx.logger.warn('评论邮件入队被拒', { kind: task.kind, to: task.to });
            }
        }
    }
    catch (error) {
        // 事件订阅方出错不应影响评论写入，这里兜底记录即可
        ctx.logger.error('评论邮件通知决策失败', { error: messageOf(error) });
    }
}
/**
 * 模板告警去重记录。
 *
 * 模板里写了不存在的变量时，邮件里会**原样保留** `{{foo}}`（便于一眼看出问题），
 * 这里把它记进日志；同一条告警只在首次出现时记录，避免评论量大时刷屏。
 */
function warnTemplateOnce(ctx, task) {
    if (!task.warnings || task.warnings.length === 0)
        return;
    for (const warning of task.warnings) {
        const signature = `${task.kind}|${warning}`;
        if (warnedTemplates.has(signature))
            continue;
        warnedTemplates.add(signature);
        ctx.logger.warn('邮件模板需要检查', { kind: task.kind, warning, hint: '可在后台「评论邮件 → 邮件模板」里修正' });
    }
}
/* ------------------------------ 投递 ------------------------------ */
/** 组装 MIME 并通过自实现 SMTP 客户端投递（仅在队列 worker 中被调用）。 */
async function deliverTask(ctx, settings, credentials, task) {
    const config = toSmtpConfig(settings, credentials);
    if (!isEmailAddress(settings.smtpFromAddress)) {
        throw new SmtpError('发件地址未配置或不合法，无法投递', { retryable: false, code: 'CONFIG' });
    }
    if (!isEmailAddress(task.to)) {
        throw new SmtpError('收件地址不合法，无法投递', { retryable: false, code: 'CONFIG' });
    }
    const from = {
        address: settings.smtpFromAddress,
        name: settings.smtpFromName.trim() || ctx.site.title
    };
    const message = buildMessage({
        from,
        to: { address: task.to },
        subject: task.subject,
        text: task.text,
        html: task.html,
        ...(task.replyTo ? { replyTo: { address: task.replyTo } } : {})
    });
    const input = { from: settings.smtpFromAddress, to: [task.to], data: message };
    await sendMail(config, input);
}
/* ------------------------------ 后台 API ------------------------------ */
function registerAdminApi(ctx, getRuntime) {
    ctx.routes.adminApi({
        method: 'GET',
        path: '/comment-mail/status',
        permission: PERMISSION_MANAGE,
        handler: (_request, reply) => {
            const current = getRuntime();
            if (!current) {
                reply.json({ data: { ready: false, message: '插件尚未完成启动' } });
                return;
            }
            reply.json({
                data: {
                    ready: true,
                    startedAt: current.startedAt,
                    siteUrl: normalizeBaseUrl(ctx.site.url),
                    readiness: buildReadiness(current.settings, current.credentials),
                    settings: describeSettings(current.settings, current.credentials, ctx.site.title),
                    templates: {
                        customized: customizedTemplateKeys(current.templates),
                        total: TEMPLATE_SCENARIOS.length
                    },
                    queue: { ...current.queue.stats(), ...current.log.stats() },
                    records: current.log.list()
                }
            });
        }
    });
    /**
     * 模板编辑器的数据源。
     *
     * 只读插件自己的启动期快照（`ctx.config`）—— 因此这里返回的「当前生效」就是**正在用**的那一套，
     * 与保存后尚未重启的状态区分得很清楚（保存要写宿主设置接口，见后台页）。
     */
    ctx.routes.adminApi({
        method: 'GET',
        path: '/comment-mail/templates',
        permission: PERMISSION_MANAGE,
        handler: (_request, reply) => {
            const current = getRuntime();
            const overrides = current?.templates ?? {};
            const effective = {};
            for (const scenario of TEMPLATE_SCENARIOS) {
                const override = overrides[scenario.key] ?? {};
                const fallback = DEFAULT_TEMPLATES[scenario.key];
                effective[scenario.key] = {
                    subject: override.subject ?? fallback.subject,
                    html: override.html ?? fallback.html,
                    subjectOverridden: Boolean(override.subject),
                    htmlOverridden: Boolean(override.html)
                };
            }
            reply.json({
                data: {
                    pluginId: ctx.manifest.id,
                    scenarios: TEMPLATE_SCENARIOS,
                    variables: TEMPLATE_VARIABLES,
                    settingKeys: TEMPLATE_SETTING_KEYS,
                    limits: { subject: TEMPLATE_SUBJECT_MAX_LENGTH, html: TEMPLATE_MAX_LENGTH },
                    defaults: DEFAULT_TEMPLATES,
                    effective,
                    customized: customizedTemplateKeys(overrides)
                }
            });
        }
    });
    /**
     * 用示例数据渲染一份模板（**与真实发信走同一个渲染器**）。
     *
     * 未提交的字段用「当前生效值」，因此预览永远反映真实效果；
     * 未识别的变量会原样保留并出现在 `warnings` 里。
     */
    ctx.routes.adminApi({
        method: 'POST',
        path: '/comment-mail/template-preview',
        permission: PERMISSION_MANAGE,
        handler: (request, reply) => {
            const current = getRuntime();
            const body = asRecord(request.body);
            const key = asTemplateKey(body.key);
            if (!key) {
                reply.json({ data: { ok: false, error: `未知的模板场景：${asText(body.key)}` } });
                return;
            }
            const rendered = renderTemplatePreview(current?.templates ?? {}, key, {
                subject: optionalText(body.subject),
                html: optionalText(body.html)
            });
            reply.json({
                data: {
                    ok: true,
                    key,
                    subject: rendered.subject,
                    html: rendered.html,
                    text: rendered.text,
                    warnings: rendered.warnings
                }
            });
        }
    });
    ctx.routes.adminApi({
        method: 'POST',
        path: '/comment-mail/test',
        permission: PERMISSION_MANAGE,
        handler: async (request, reply) => {
            const current = getRuntime();
            if (!current) {
                reply.json({ data: { ok: false, error: '插件尚未完成启动' } });
                return;
            }
            const body = asRecord(request.body);
            const to = asText(body.to).trim();
            if (!isEmailAddress(to)) {
                reply.json({ data: { ok: false, error: '请填写合法的收件人邮箱地址' } });
                return;
            }
            // 带 template 即「按模板发预览」（用示例数据渲染），否则发配置自检邮件
            const key = asTemplateKey(body.template);
            const startedAt = Date.now();
            try {
                const message = key
                    ? mailForPreview(current, to, key, {
                        subject: optionalText(body.subject),
                        html: optionalText(body.html)
                    })
                    : buildTestMessage(ctx, current, to);
                await withTimeout(deliverTask(ctx, current.settings, current.credentials, message), TEST_TIMEOUT_MS, `测试发信超过 ${Math.round(TEST_TIMEOUT_MS / 1000)} 秒未完成`);
                ctx.logger.info('评论邮件测试发信成功', { to, template: key ?? 'config-check', elapsedMs: Date.now() - startedAt });
                reply.json({
                    data: { ok: true, elapsedMs: Date.now() - startedAt, ...(key ? { template: key } : {}) }
                });
            }
            catch (error) {
                const detail = current.log.redact(error);
                const retryable = error instanceof SmtpError ? error.retryable : false;
                ctx.logger.warn('评论邮件测试发信失败', { to, error: detail, retryable });
                reply.json({
                    data: {
                        ok: false,
                        error: detail,
                        retryable,
                        hint: retryable
                            ? '这看起来是网络/服务器临时问题，可以稍后重试。'
                            : '这看起来是配置问题（地址、端口、加密方式或凭据），请核对后重启服务再试。'
                    }
                });
            }
        }
    });
    ctx.routes.adminApi({
        method: 'POST',
        path: '/comment-mail/records/:id/retry',
        permission: PERMISSION_MANAGE,
        handler: (request, reply) => {
            const current = getRuntime();
            const id = asText(request.params.id);
            const ok = current ? current.queue.retry(id) : false;
            reply.json({ data: { ok } });
        }
    });
    ctx.routes.adminApi({
        method: 'POST',
        path: '/comment-mail/records/clear',
        permission: PERMISSION_MANAGE,
        handler: (_request, reply) => {
            const current = getRuntime();
            reply.json({ data: { cleared: current ? current.log.clear() : 0 } });
        }
    });
}
/** 测试发信用的邮件正文（走同一套投递链路，只是内容不引用任何评论）。 */
function buildTestMessage(ctx, current, to) {
    const site = ctx.site.title.trim() || '站点';
    const siteUrl = normalizeBaseUrl(ctx.site.url);
    const settings = current.settings;
    const lines = [
        `SMTP 服务器：${settings.smtpHost || '（未配置）'}:${settings.smtpPort}`,
        `加密方式：${settings.smtpSecure}`,
        `认证账号：${current.credentials.user || '（不认证）'}`,
        `发件地址：${settings.smtpFromAddress || '（未配置）'}`,
        `每分钟上限：${settings.rateLimitPerMinute} 封`,
        `站长收件人：${settings.adminRecipients.length > 0 ? settings.adminRecipients.join('、') : '（未配置）'}`,
        `后台评论审核页：${adminCommentsUrlOf(siteUrl)}`
    ];
    return {
        kind: 'admin-new-comment',
        to,
        subject: `【${site}】评论邮件通知测试`,
        text: [`这封邮件来自 ${site} 的「评论邮件通知」插件，说明 SMTP 配置可用。`, '', ...lines, '', '--', `本邮件由 ${site} 自动发送，请勿直接回复。`].join('\n'),
        html: `<p>这封邮件来自 ${escapeHtml(site)} 的「评论邮件通知」插件，说明 SMTP 配置可用。</p><ul>${lines
            .map((line) => `<li>${escapeHtml(line)}</li>`)
            .join('')}</ul><p style="color:#6b7280;font-size:12px;">本邮件由 ${escapeHtml(site)} 自动发送，请勿直接回复。</p>`,
        dedupeKey: `test:${to.toLowerCase()}:${current.startedAt}`,
        commentId: 0
    };
}
/* ------------------------------ 小工具 ------------------------------ */
function withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new SmtpError(message, { retryable: true, code: 'ETIMEDOUT' }));
        }, timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asText(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number')
        return String(value);
    return '';
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 按模板（用示例数据）渲染一封邮件；未提交的字段回落「当前生效值 → 内置默认」。 */
function renderTemplatePreview(overrides, key, submitted) {
    const merged = {
        ...overrides,
        [key]: {
            ...(submitted.subject !== undefined ? { subject: submitted.subject } : {}),
            ...(submitted.html !== undefined ? { html: submitted.html } : {})
        }
    };
    // 空串会被 renderMail 视为「未覆盖」，自动回落到内置默认模板
    return renderMail(sampleMailContext(key), merged);
}
/** 预览发信：把渲染结果包成一条邮件任务（不进入队列，直接走投递）。 */
function mailForPreview(current, to, key, submitted) {
    const rendered = renderTemplatePreview(current.templates, key, submitted);
    return {
        kind: key,
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        dedupeKey: `preview:${key}:${to.toLowerCase()}:${Date.now()}`,
        commentId: 0,
        ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {})
    };
}
function asTemplateKey(value) {
    const key = asText(value);
    return TEMPLATE_SCENARIOS.some((scenario) => scenario.key === key) ? key : undefined;
}
/** 取「提交上来的可选字符串」：非字符串返回 undefined（表示不覆盖）。 */
function optionalText(value) {
    return typeof value === 'string' ? value : undefined;
}
//# sourceMappingURL=index.js.map