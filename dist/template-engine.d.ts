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
export interface RenderResult {
    output: string;
    /** 模板里出现过但没有提供值的变量名（已去重）。 */
    unknown: string[];
}
/** 渲染模板；未知变量原样保留。 */
export declare function renderTemplate(template: string, vars: Record<string, string>): RenderResult;
/** 列出模板里用到的变量名（去重、按出现顺序）。 */
export declare function placeholdersOf(template: string): string[];
/**
 * HTML → 纯文本降级。
 *
 * 用于「只填 HTML 模板」的场景：邮件必须有 text/plain 版本，这里把它派生出来。
 * 保留链接地址（`文字 (地址)`）、列表项与段落换行，其余标签剥掉。
 */
export declare function htmlToText(html: string): string;
