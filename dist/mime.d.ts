/**
 * MIME 组装（零依赖）。
 *
 * 目标：产出一封**主流邮件客户端都能正确显示**的 `multipart/alternative` 邮件。
 * 三个必须自己处理的细节：
 * - 非 ASCII 的主题与显示名要走 RFC 2047 encoded-word，否则乱码；
 * - 正文用 base64 并 76 列折行，避免 8bit / 超长行被中继截断；
 * - 发送阶段要按 SMTP 规则对行首 `.` 做 dot-stuffing。
 */
export interface MailAddress {
    address: string;
    name?: string;
}
export interface BuildMessageInput {
    from: MailAddress;
    to: MailAddress;
    subject: string;
    text: string;
    html: string;
    replyTo?: MailAddress;
    date?: Date;
    messageId?: string;
    boundary?: string;
}
/** 把任意文本的换行统一成 CRLF（SMTP 只认 CRLF）。 */
export declare function normalizeCrlf(data: string): string;
/** SMTP `DATA` 阶段的 dot-stuffing：行首的 `.` 必须写成 `..`。 */
export declare function dotStuff(data: string): string;
/** UTF-8 → base64（每行 76 列，CRLF 分隔）。 */
export declare function base64Lines(input: string, lineLength?: number): string;
/**
 * 邮件头文本编码。
 *
 * 纯 ASCII 且不含控制字符时原样返回；否则切成若干 RFC 2047 encoded-word
 * （每个保证不超过 75 字符上限），用空格连接 —— 客户端会把空格视为可忽略的折叠点。
 */
export declare function encodeHeaderWord(raw: string): string;
/** 组装 `显示名 <地址>`；显示名为空时只输出地址。 */
export declare function formatAddress(input: MailAddress): string;
/** RFC 5322 日期（带数字时区，如 `Tue, 14 Oct 2026 21:48:22 +0800`）。 */
export declare function formatRfc5322Date(date: Date): string;
/** 生成 Message-ID（右侧用发件域；取不到域时退化为 localhost）。 */
export declare function createMessageId(fromAddress: string, random?: () => string): string;
/** 生成 MIME 分段边界（随机 token，避免与正文碰撞）。 */
export declare function createBoundary(random?: () => string): string;
/**
 * 组装完整报文。
 *
 * 返回的字符串**未做** dot-stuffing —— 那是 `DATA` 阶段的职责，由 SMTP 客户端处理。
 */
export declare function buildMessage(input: BuildMessageInput): string;
/** 去掉 CR/LF 与控制字符：防止邮件头注入（Header Injection）。 */
export declare function sanitizeHeaderText(raw: string): string;
