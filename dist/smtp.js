/**
 * 零依赖 SMTP 客户端。
 *
 * 为什么要自己实现：ricenote 内核**不提供邮件能力**，也不保证第三方依赖可用
 * （插件没有包管理器，除宿主提供的三个包之外都要打进产物）。SMTP 投递所需的能力
 * 其实很小：连接（隐式 TLS / STARTTLS / 明文）、认证（PLAIN / LOGIN）、
 * `MAIL FROM` → `RCPT TO` → `DATA` → `QUIT`，因此这里用 `node:net` / `node:tls` 直接实现。
 *
 * 两条硬约定：
 * - **错误必须分类**：4xx 与网络类错误可重试，5xx（含认证失败）不可重试 —— 这决定队列是否退避重发；
 * - 任何异常路径都要销毁 socket，绝不让连接悬挂。
 */
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { dotStuff } from './mime.js';
/** SMTP 交互失败。`retryable` 决定队列是否退避重试。 */
export class SmtpError extends Error {
    retryable;
    code;
    constructor(message, options) {
        super(message);
        this.name = 'SmtpError';
        this.retryable = options.retryable;
        this.code = options.code ?? '';
    }
}
/** 把 SMTP 应答转成可读错误（脱敏由上层统一处理）。 */
export function classifyReply(stage, reply) {
    const detail = reply.lines[0] ?? '';
    const retryable = reply.code >= 400 && reply.code < 500;
    return new SmtpError(`${stage} 失败：${reply.code} ${detail}`.trim(), {
        retryable,
        code: String(reply.code)
    });
}
/**
 * 一条连接上的会话：负责按行读取应答、处理多行应答与超时。
 *
 * SMTP 的多行应答形如 `250-XXX` 续行、最后一行 `250 XXX` 结束，
 * 因此不能「读一行当一条应答」，必须按状态码后的分隔符判断结束。
 */
class Conversation {
    socket;
    timeoutMs;
    buffer = '';
    queue = [];
    waiters = [];
    currentLines = [];
    failure;
    onData;
    onError;
    onClose;
    detached = false;
    constructor(socket, timeoutMs) {
        this.socket = socket;
        this.timeoutMs = timeoutMs;
        this.onData = (chunk) => {
            this.consume(chunk);
        };
        this.onError = (error) => {
            // 会话已摘除监听（升级 TLS / 主动销毁）后不再上报，但**监听必须留着**：
            // socket 上的 'error' 事件一旦无人接管就会变成未处理异常，足以把整个进程带崩。
            if (this.detached)
                return;
            this.fail(new SmtpError(`连接出错：${error.message}`, { retryable: true, code: 'ENETWORK' }));
        };
        this.onClose = () => {
            if (this.detached)
                return;
            if (this.queue.length === 0 && this.waiters.length === 0)
                return;
            this.fail(new SmtpError('服务器提前关闭了连接', { retryable: true, code: 'ECLOSED' }));
        };
        socket.setEncoding('utf8');
        socket.on('data', this.onData);
        socket.on('error', this.onError);
        socket.on('close', this.onClose);
    }
    /**
     * 摘掉数据监听：升级为 TLS 时必须先停掉明文读取，否则会把密文当明文解析。
     *
     * 只摘 `data`：`error` / `close` 监听保留到进程生命周期结束（见上面的注释）。
     */
    detach() {
        if (this.detached)
            return;
        this.detached = true;
        this.socket.off('data', this.onData);
    }
    /** 读取一条完整应答。 */
    async readReply() {
        if (this.failure)
            throw this.failure;
        const ready = this.queue.shift();
        if (ready)
            return ready;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.fail(new SmtpError(`等待服务器应答超时（${this.timeoutMs}ms）`, { retryable: true, code: 'ETIMEDOUT' }));
            }, this.timeoutMs);
            this.waiters.push({ resolve, reject, timer });
        });
    }
    /** 发送一行命令（自动补 CRLF）并读取应答。 */
    async command(line) {
        this.writeRaw(`${line}\r\n`);
        return await this.readReply();
    }
    writeRaw(data) {
        if (this.failure)
            throw this.failure;
        this.socket.write(data);
    }
    destroy() {
        this.detach();
        this.sweepWaiters(new SmtpError('连接已关闭', { retryable: true, code: 'ECLOSED' }));
        this.socket.destroy();
    }
    /** 升级为 TLS，返回新会话（旧会话同时被摘除监听）。 */
    async upgradeToTls(host) {
        const plain = this.socket;
        this.detach();
        const secured = tls.connect({
            socket: plain,
            ...(net.isIP(host) === 0 ? { servername: host } : {}),
            minVersion: 'TLSv1.2'
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                secured.destroy();
                reject(new SmtpError('TLS 握手超时', { retryable: true, code: 'ETIMEDOUT' }));
            }, this.timeoutMs);
            secured.once('secureConnect', () => {
                clearTimeout(timer);
                resolve();
            });
            secured.once('error', (error) => {
                clearTimeout(timer);
                secured.destroy();
                reject(new SmtpError(`TLS 握手失败：${error.message}`, { retryable: true, code: 'ETLS' }));
            });
        });
        return new Conversation(secured, this.timeoutMs);
    }
    consume(chunk) {
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
            const rawLine = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            this.acceptLine(rawLine.replace(/\r$/, ''));
            newline = this.buffer.indexOf('\n');
        }
    }
    acceptLine(line) {
        if (line.length === 0)
            return;
        this.currentLines.push(line);
        // 结束行：`250 text`（第四位是空格）；续行为 `250-text`
        if (!/^\d{3} /.test(line))
            return;
        const reply = {
            code: Number(line.slice(0, 3)),
            lines: this.currentLines.map((item) => item.replace(/^\d{3}[ -]?/, '').trim()).filter((item) => item.length > 0)
        };
        this.currentLines = [];
        const waiter = this.waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(reply);
            return;
        }
        this.queue.push(reply);
    }
    fail(error) {
        if (this.failure)
            return;
        this.failure = error;
        this.detach();
        this.sweepWaiters(error);
        this.socket.destroy();
    }
    sweepWaiters(error) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
    }
}
/** 投递一封邮件（内含一次完整会话）。失败时抛 `SmtpError`。 */
export async function sendMail(config, input) {
    if (config.host.length === 0) {
        throw new SmtpError('未配置 SMTP 服务器地址', { retryable: false, code: 'CONFIG' });
    }
    if (input.to.length === 0) {
        throw new SmtpError('缺少收件人', { retryable: false, code: 'CONFIG' });
    }
    const socket = await openSocket(config);
    let conversation = new Conversation(socket, config.timeoutMs);
    try {
        const greeting = await conversation.readReply();
        if (greeting.code !== 220)
            throw classifyReply('连接', greeting);
        let capabilities = await ehlo(conversation);
        if (config.secure === 'starttls') {
            if (!capabilities.has('STARTTLS')) {
                throw new SmtpError('服务器未通告 STARTTLS，无法升级加密连接', {
                    retryable: false,
                    code: 'CONFIG'
                });
            }
            const upgrade = await conversation.command('STARTTLS');
            if (upgrade.code !== 220)
                throw classifyReply('STARTTLS', upgrade);
            conversation = await conversation.upgradeToTls(config.host);
            capabilities = await ehlo(conversation);
        }
        if (config.user.length > 0) {
            await authenticate(conversation, capabilities, config);
        }
        const mailFrom = await conversation.command(`MAIL FROM:<${input.from}>`);
        if (!isPositive(mailFrom.code))
            throw classifyReply('MAIL FROM', mailFrom);
        for (const recipient of input.to) {
            const rcpt = await conversation.command(`RCPT TO:<${recipient}>`);
            if (!isPositive(rcpt.code))
                throw classifyReply(`RCPT TO <${recipient}>`, rcpt);
        }
        const data = await conversation.command('DATA');
        if (data.code !== 354)
            throw classifyReply('DATA', data);
        conversation.writeRaw(`${dotStuff(input.data)}\r\n.\r\n`);
        const stored = await conversation.readReply();
        if (!isPositive(stored.code))
            throw classifyReply('投递', stored);
        try {
            await conversation.command('QUIT');
        }
        catch {
            // QUIT 失败无关紧要：邮件已被服务器接收
        }
    }
    finally {
        conversation.destroy();
    }
}
function isPositive(code) {
    return code >= 200 && code < 300;
}
/** EHLO 并解析能力列表（键为大写能力名）。 */
async function ehlo(conversation) {
    const reply = await conversation.command(`EHLO ${clientName()}`);
    if (!isPositive(reply.code))
        throw classifyReply('EHLO', reply);
    const capabilities = new Map();
    for (const line of reply.lines) {
        const tokens = line.split(/\s+/).filter((token) => token.length > 0);
        const name = tokens.shift();
        if (!name)
            continue;
        // 两种历史写法：`250-AUTH PLAIN LOGIN` 与 `250-AUTH=PLAIN LOGIN`
        const explicit = /^AUTH=(.+)$/i.exec(name);
        if (explicit) {
            capabilities.set('AUTH', [explicit[1], ...tokens]);
            continue;
        }
        capabilities.set(name.toUpperCase(), tokens);
    }
    if (capabilities.size === 0) {
        // 极少数老服务器只认 HELO：退回即可继续（只影响认证能力探测）
        const fallback = await conversation.command(`HELO ${clientName()}`);
        if (!isPositive(fallback.code))
            throw classifyReply('HELO', fallback);
    }
    return capabilities;
}
/** 按服务器通告选择 AUTH PLAIN（优先）或 AUTH LOGIN。 */
async function authenticate(conversation, capabilities, config) {
    if (config.password.length === 0) {
        throw new SmtpError('已配置认证账号但缺少密码（环境变量未设置）', { retryable: false, code: 'CONFIG' });
    }
    const mechanisms = (capabilities.get('AUTH') ?? []).map((item) => item.toUpperCase());
    if (mechanisms.length === 0) {
        throw new SmtpError('服务器未通告 AUTH 能力，无法认证（如需匿名投递请清空认证账号）', {
            retryable: false,
            code: 'CONFIG'
        });
    }
    if (mechanisms.includes('PLAIN')) {
        const payload = Buffer.from(`\u0000${config.user}\u0000${config.password}`, 'utf8').toString('base64');
        const reply = await conversation.command(`AUTH PLAIN ${payload}`);
        if (!isPositive(reply.code))
            throw classifyReply('AUTH PLAIN', reply);
        return;
    }
    if (mechanisms.includes('LOGIN')) {
        const start = await conversation.command('AUTH LOGIN');
        if (start.code !== 334)
            throw classifyReply('AUTH LOGIN', start);
        const user = await conversation.command(Buffer.from(config.user, 'utf8').toString('base64'));
        if (user.code !== 334)
            throw classifyReply('AUTH LOGIN（账号）', user);
        const password = await conversation.command(Buffer.from(config.password, 'utf8').toString('base64'));
        if (!isPositive(password.code))
            throw classifyReply('AUTH LOGIN（密码）', password);
        return;
    }
    throw new SmtpError(`服务器不支持 AUTH PLAIN / AUTH LOGIN（通告：${mechanisms.join(' ') || '无'}）`, {
        retryable: false,
        code: 'CONFIG'
    });
}
/** 建立连接（隐式 TLS 或明文；STARTTLS 在协商阶段升级）。 */
async function openSocket(config) {
    if (config.secure === 'ssl') {
        const socket = tls.connect({
            host: config.host,
            port: config.port,
            ...(net.isIP(config.host) === 0 ? { servername: config.host } : {}),
            minVersion: 'TLSv1.2'
        });
        await waitForConnect(socket, config, 'secureConnect');
        return socket;
    }
    const socket = net.connect({ host: config.host, port: config.port });
    await waitForConnect(socket, config, 'connect');
    return socket;
}
function waitForConnect(socket, config, event) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new SmtpError(`连接 ${config.host}:${config.port} 超时`, { retryable: true, code: 'ETIMEDOUT' }));
        }, config.timeoutMs);
        const onOk = () => {
            clearTimeout(timer);
            socket.off(event, onOk);
            // 注意：'error' 监听**不去掉**，它是这条连接上最后一道「不让异常逃逸」的保险
            resolve();
        };
        const onError = (error) => {
            clearTimeout(timer);
            socket.off(event, onOk);
            socket.destroy();
            // 连接已经 resolve 之后再出错时，这里的 reject 是空操作（Promise 已 settle）
            const code = error.code ?? 'ENETWORK';
            reject(new SmtpError(`连接 ${config.host}:${config.port} 失败：${error.message}`, { retryable: true, code }));
        };
        socket.once(event, onOk);
        socket.once('error', onError);
    });
}
/** EHLO 用的客户端名（合法域名或 IP 字面量）。 */
function clientName() {
    const host = os.hostname().replace(/[^A-Za-z0-9.-]/g, '');
    return host.length > 0 ? host : 'localhost';
}
//# sourceMappingURL=smtp.js.map