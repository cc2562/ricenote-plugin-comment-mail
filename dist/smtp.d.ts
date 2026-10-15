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
import type { SmtpConfig } from './types.js';
export interface SmtpSendInput {
    /** 信封发件人（纯地址，不带尖括号）。 */
    from: string;
    /** 信封收件人（逐封单发时通常只有一个）。 */
    to: string[];
    /** 完整 MIME 报文。 */
    data: string;
}
/** SMTP 交互失败。`retryable` 决定队列是否退避重试。 */
export declare class SmtpError extends Error {
    readonly retryable: boolean;
    readonly code: string;
    constructor(message: string, options: {
        retryable: boolean;
        code?: string;
    });
}
interface Reply {
    code: number;
    /** 去掉状态码前缀后的各行文本。 */
    lines: string[];
}
/** 把 SMTP 应答转成可读错误（脱敏由上层统一处理）。 */
export declare function classifyReply(stage: string, reply: Reply): SmtpError;
/** 投递一封邮件（内含一次完整会话）。失败时抛 `SmtpError`。 */
export declare function sendMail(config: SmtpConfig, input: SmtpSendInput): Promise<void>;
export {};
