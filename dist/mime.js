/**
 * MIME 组装（零依赖）。
 *
 * 目标：产出一封**主流邮件客户端都能正确显示**的 `multipart/alternative` 邮件。
 * 三个必须自己处理的细节：
 * - 非 ASCII 的主题与显示名要走 RFC 2047 encoded-word，否则乱码；
 * - 正文用 base64 并 76 列折行，避免 8bit / 超长行被中继截断；
 * - 发送阶段要按 SMTP 规则对行首 `.` 做 dot-stuffing。
 */
/** 把任意文本的换行统一成 CRLF（SMTP 只认 CRLF）。 */
export function normalizeCrlf(data) {
    return data.replace(/\r\n|\r|\n/g, '\r\n');
}
/** SMTP `DATA` 阶段的 dot-stuffing：行首的 `.` 必须写成 `..`。 */
export function dotStuff(data) {
    return normalizeCrlf(data).replace(/^\./gm, '..');
}
/** UTF-8 → base64（每行 76 列，CRLF 分隔）。 */
export function base64Lines(input, lineLength = 76) {
    const encoded = Buffer.from(input, 'utf8').toString('base64');
    const lines = [];
    for (let index = 0; index < encoded.length; index += lineLength) {
        lines.push(encoded.slice(index, index + lineLength));
    }
    return lines.join('\r\n');
}
/**
 * 邮件头文本编码。
 *
 * 纯 ASCII 且不含控制字符时原样返回；否则切成若干 RFC 2047 encoded-word
 * （每个保证不超过 75 字符上限），用空格连接 —— 客户端会把空格视为可忽略的折叠点。
 */
export function encodeHeaderWord(raw) {
    const text = sanitizeHeaderText(raw);
    if (text.length === 0)
        return '';
    if (isPlainAscii(text))
        return text;
    const words = [];
    let chunk = '';
    for (const char of text) {
        const candidate = chunk + char;
        if (Buffer.byteLength(candidate, 'utf8') > 42 && chunk.length > 0) {
            words.push(chunk);
            chunk = char;
        }
        else {
            chunk = candidate;
        }
    }
    if (chunk.length > 0)
        words.push(chunk);
    return words
        .map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`)
        .join(' ');
}
/** 组装 `显示名 <地址>`；显示名为空时只输出地址。 */
export function formatAddress(input) {
    const address = sanitizeHeaderText(input.address);
    const name = sanitizeHeaderText(input.name ?? '');
    if (name.length === 0)
        return address;
    if (!isPlainAscii(name))
        return `${encodeHeaderWord(name)} <${address}>`;
    // 纯 ASCII 显示名含特殊字符时按 RFC 5322 需要加引号
    if (/[()<>@,;:\\".[\]]/.test(name)) {
        return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
    }
    return `${name} <${address}>`;
}
/** RFC 5322 日期（带数字时区，如 `Tue, 14 Oct 2026 21:48:22 +0800`）。 */
export function formatRfc5322Date(date) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (value) => String(value).padStart(2, '0');
    // getTimezoneOffset() 是「UTC - 本地」的分钟数，取反得到本地相对 UTC 的偏移
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absolute = Math.abs(offsetMinutes);
    return (`${days[date.getDay()]}, ${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
        `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`);
}
/** 生成 Message-ID（右侧用发件域；取不到域时退化为 localhost）。 */
export function createMessageId(fromAddress, random = randomToken) {
    const at = fromAddress.lastIndexOf('@');
    const domain = at >= 0 ? fromAddress.slice(at + 1) : 'localhost';
    return `<${random()}@${domain}>`;
}
/** 生成 MIME 分段边界（随机 token，避免与正文碰撞）。 */
export function createBoundary(random = randomToken) {
    return `rn-mail-${random()}`;
}
/**
 * 组装完整报文。
 *
 * 返回的字符串**未做** dot-stuffing —— 那是 `DATA` 阶段的职责，由 SMTP 客户端处理。
 */
export function buildMessage(input) {
    const date = input.date ?? new Date();
    const boundary = input.boundary ?? createBoundary();
    const messageId = input.messageId ?? createMessageId(input.from.address);
    const headers = [
        `From: ${formatAddress(input.from)}`,
        `To: ${formatAddress(input.to)}`,
        `Subject: ${encodeHeaderWord(input.subject)}`,
        `Date: ${formatRfc5322Date(date)}`,
        `Message-ID: ${messageId}`,
        'MIME-Version: 1.0'
    ];
    if (input.replyTo && input.replyTo.address.length > 0) {
        headers.push(`Reply-To: ${formatAddress(input.replyTo)}`);
    }
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const parts = [
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(input.text),
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(input.html),
        `--${boundary}--`
    ];
    return normalizeCrlf(`${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`);
}
/** 去掉 CR/LF 与控制字符：防止邮件头注入（Header Injection）。 */
export function sanitizeHeaderText(raw) {
    return (raw ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}
function isPlainAscii(text) {
    return /^[\x20-\x7e]*$/.test(text);
}
function randomToken() {
    // crypto.randomUUID 不可用时退化为时间戳 + 随机数（仅用于唯一性，不用于安全）
    const globalCrypto = globalThis.crypto;
    if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
        return globalCrypto.randomUUID();
    }
    return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
}
//# sourceMappingURL=mime.js.map