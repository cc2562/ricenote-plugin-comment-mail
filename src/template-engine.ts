/**
 * 邮件模板引擎（零依赖、无业务知识）。
 *
 * 只做一件事：把 `{{变量}}` 替换成值。刻意**不支持**表达式、条件与循环 ——
 * 模板来自后台输入，任何"执行"能力都会变成注入面；纯文本替换既够用又可预测。
 *
 * 三条约定：
 * - **未知变量原样保留**（`{{foo}}` 留在结果里），并回报给调用方用于告警 ——
 *   静默替换成空串会让"模板写错"变成"邮件少一段"，很难发现；
 * - 转义是**调用方**的责任：引擎拿到什么就放什么（HTML 模式传转义后的值、纯文本模式传原文）；
 * - 模板里没有任何 `eval` / `new Function` / 正则回溯风险（占位符正则是有界的）。
 */

import { normalizeCrlf } from './mime.js';

/** 占位符：`{{name}}`，名字允许字母数字下划线，允许花括号内空格。 */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export interface RenderResult {
  output: string;
  /** 模板里出现过但没有提供值的变量名（已去重）。 */
  unknown: string[];
}

/** 渲染模板；未知变量原样保留。 */
export function renderTemplate(template: string, vars: Record<string, string>): RenderResult {
  const unknown = new Set<string>();
  const output = (template ?? '').replace(PLACEHOLDER, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      unknown.add(name);
      return match;
    }
    return value;
  });
  return { output, unknown: [...unknown] };
}

/** 列出模板里用到的变量名（去重、按出现顺序）。 */
export function placeholdersOf(template: string): string[] {
  const names: string[] = [];
  for (const match of (template ?? '').matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * HTML → 纯文本降级。
 *
 * 用于「只填 HTML 模板」的场景：邮件必须有 text/plain 版本，这里把它派生出来。
 * 保留链接地址（`文字 (地址)`）、列表项与段落换行，其余标签剥掉。
 */
export function htmlToText(html: string): string {
  let text = normalizeCrlf(html ?? '');

  text = text.replace(/<!DOCTYPE[^>]*>/gi, '');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 链接：保留可点击地址，纯文本里也能用
  text = text.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const url = decodeEntities(href).trim();
      const text = stripTags(label).trim();
      if (url.length === 0) return text;
      if (text.length === 0 || text === url) return url;
      return `${text} (${url})`;
    }
  );

  text = text.replace(/<img\b[^>]*>/gi, (tag: string) => {
    const src = /src=["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    return src.length > 0 ? `[图片] ${decodeEntities(src)}` : '[图片]';
  });

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<hr\b[^>]*>/gi, '\n----------\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|ul|ol|section|article)>/gi, '\n');

  text = stripTags(text);
  text = decodeEntities(text);

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 去掉标签（仅用于已经确定文本化的片段）。 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/** 解码常见实体（`&amp;` 放最后，避免二次解码）。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#0?39;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_match, code: string) => {
      const value = Number(code);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    })
    .replace(/&amp;/gi, '&');
}
