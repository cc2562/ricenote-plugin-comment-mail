/**
 * 内存异步投递队列。
 *
 * 存在的理由：事件总线在 `emit` 时会 **await 全部订阅者**，而一次 SMTP 会话要几秒。
 * 若在事件处理器里直接发信，评论提交接口就会被发信拖慢（甚至被邮件服务器拖超时）。
 * 因此处理器只做「去重 + 入队」，投递交给这里的常驻 worker：
 *
 * - 单并发（对同一个小型 SMTP 服务器最友好），失败按退避重试；
 * - 滑动窗口限速（默认 30 封/分钟），避免触发服务商限流；
 * - 队列有上限，超限丢弃并告警，避免内存无界增长；
 * - `drain()` 在插件停用时有限时间内尽量发完（期间忽略限速与退避等待）。
 */
import type { DeliveryLog } from './records.js';
import type { MailTask } from './types.js';
export interface MailQueueLogger {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
}
/** 真正把一封邮件投出去的函数（由 index.ts 注入：组装 MIME + SMTP 发送）。 */
export type TaskDeliverer = (task: MailTask) => Promise<void>;
export interface MailQueueOptions {
    deliver: TaskDeliverer;
    log: DeliveryLog;
    logger: MailQueueLogger;
    /** 每分钟最多投递几封。 */
    rateLimitPerMinute: number;
    /** 最多尝试几次（含首次）。 */
    maxAttempts?: number;
    /** 队列上限。 */
    maxQueueSize?: number;
    /** 重试退避（毫秒），索引即「第几次失败之后」。 */
    backoffMs?: readonly number[];
}
export interface EnqueueResult {
    accepted: boolean;
    reason?: 'duplicate' | 'queue-full';
    recordId?: string;
}
export declare class MailQueue {
    private readonly items;
    private readonly sentAt;
    private readonly dedupe;
    private readonly dedupeOrder;
    private readonly deliver;
    private readonly log;
    private readonly logger;
    private readonly rateLimitPerMinute;
    private readonly maxAttempts;
    private readonly maxQueueSize;
    private readonly backoffMs;
    private running;
    private stopped;
    private draining;
    private timer?;
    constructor(options: MailQueueOptions);
    /**
     * 入队。**不做任何 I/O**，因此可以在事件处理器里同步调用。
     * 同一 `dedupeKey` 只会被接受一次（进程生命周期内）。
     */
    enqueue(task: MailTask): EnqueueResult;
    /** 手动重发一条仍在内存里的记录（失败或已丢弃）。 */
    retry(recordId: string): boolean;
    stats(): {
        pending: number;
        inFlight: boolean;
        rateWindowUsed: number;
    };
    /** 停用时的优雅收尾：忽略限速与退避，尽量把队列发完。 */
    drain(timeoutMs: number): Promise<{
        pending: number;
    }>;
    stop(): void;
    private rememberKey;
    /**
     * 安排一次唤醒。
     *
     * 两个刻意的选择：
     * - **没有待办就不排定时器**：否则 worker 会以 40 次/秒的节奏空转；
     * - 定时器**不加 unref**：还有邮件没发出去时，进程不应该「若无其事地退出」。
     *   `stop()` 会清掉定时器，因此不会影响正常关停。
     */
    private wake;
    /** 下一次被唤醒前应该等多久。 */
    private nextDelay;
    private run;
    private takeReady;
    private attempt;
    private backoffFor;
    private pruneRateWindow;
    /** 距离「可以再发一封」还有多久；0 表示现在就可以发。 */
    private rateLimitWait;
}
