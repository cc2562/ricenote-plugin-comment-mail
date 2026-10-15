/**
 * 投递记录（进程内环形缓冲）。
 *
 * 平台没有可供插件使用的持久化队列，本插件也刻意不建表，因此记录只活在内存里：
 * 好处是零迁移、零残留；代价是重启即清空 —— 后台页会显著标注这一点。
 *
 * 记录里**绝不允许**出现 SMTP 密码：错误文本统一过一遍脱敏后再落缓冲。
 */
import type { DeliveryRecord, DeliveryStatus, MailTask } from './types.js';
export interface DeliveryLogOptions {
    /** 缓冲上限（超出后淘汰最旧记录）。 */
    limit?: number;
    /** 需要脱敏的敏感串（例如 SMTP 密码）。 */
    secrets?: string[];
    /** 错误文本最大长度。 */
    maxErrorLength?: number;
}
export declare class DeliveryLog {
    private items;
    private readonly limit;
    private readonly secrets;
    private readonly maxErrorLength;
    private sequence;
    constructor(options?: DeliveryLogOptions);
    /** 记入一条待投递任务。 */
    create(task: MailTask): DeliveryRecord;
    /** 更新一条记录；投递成功后释放任务体（不再需要重发）。 */
    patch(id: string, patch: Partial<DeliveryRecord>): DeliveryRecord | undefined;
    get(id: string): DeliveryRecord | undefined;
    /** 最新在前的快照（返回浅拷贝数组，调用方无法改动内部状态）。 */
    list(): DeliveryRecord[];
    clear(): number;
    stats(): Record<DeliveryStatus, number>;
    /** 错误脱敏 + 截断。 */
    redact(error: unknown): string;
}
