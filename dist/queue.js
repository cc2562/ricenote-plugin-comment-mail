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
import { SmtpError } from './smtp.js';
const DEDUPE_LIMIT = 5000;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_BACKOFF = [1000, 5000, 30_000];
export class MailQueue {
    items = [];
    sentAt = [];
    dedupe = new Set();
    dedupeOrder = [];
    deliver;
    log;
    logger;
    rateLimitPerMinute;
    maxAttempts;
    maxQueueSize;
    backoffMs;
    running = false;
    stopped = false;
    draining = false;
    timer;
    constructor(options) {
        this.deliver = options.deliver;
        this.log = options.log;
        this.logger = options.logger;
        this.rateLimitPerMinute = Math.max(1, options.rateLimitPerMinute);
        this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
        this.maxQueueSize = Math.max(1, options.maxQueueSize ?? 200);
        this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF;
    }
    /**
     * 入队。**不做任何 I/O**，因此可以在事件处理器里同步调用。
     * 同一 `dedupeKey` 只会被接受一次（进程生命周期内）。
     */
    enqueue(task) {
        if (this.stopped)
            return { accepted: false, reason: 'queue-full' };
        if (this.dedupe.has(task.dedupeKey)) {
            this.logger.debug('评论邮件已去重，跳过重复任务', { dedupeKey: task.dedupeKey });
            return { accepted: false, reason: 'duplicate' };
        }
        this.rememberKey(task.dedupeKey);
        if (this.items.length >= this.maxQueueSize) {
            const record = this.log.create(task);
            this.log.patch(record.id, { status: 'dropped', error: '队列已满，任务被丢弃（发信速度跟不上评论速度）' });
            this.logger.warn('评论邮件队列已满，任务被丢弃', { queue: this.items.length, kind: task.kind });
            return { accepted: false, reason: 'queue-full', recordId: record.id };
        }
        const record = this.log.create(task);
        this.items.push({ task, recordId: record.id, attempts: 0, notBefore: Date.now() });
        this.wake();
        return { accepted: true, recordId: record.id };
    }
    /** 手动重发一条仍在内存里的记录（失败或已丢弃）。 */
    retry(recordId) {
        const record = this.log.get(recordId);
        if (!record || !record.task)
            return false;
        if (record.status === 'sent' || record.status === 'sending' || record.status === 'queued')
            return false;
        const task = record.task;
        this.log.patch(recordId, { status: 'queued', attempts: 0, nextAttemptAt: undefined, error: undefined });
        this.items.push({ task, recordId, attempts: 0, notBefore: Date.now() });
        this.wake();
        return true;
    }
    stats() {
        this.pruneRateWindow();
        return {
            pending: this.items.length,
            inFlight: this.running,
            rateWindowUsed: this.sentAt.length
        };
    }
    /** 停用时的优雅收尾：忽略限速与退避，尽量把队列发完。 */
    async drain(timeoutMs) {
        this.draining = true;
        // 已有定时器可能排在很远的退避时刻：直接换成「马上唤醒」，否则排空会白等
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.wake();
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!this.running && this.items.length === 0)
                return { pending: 0 };
            await sleep(50);
        }
        return { pending: this.items.length };
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    /* ------------------------------ 内部实现 ------------------------------ */
    rememberKey(key) {
        this.dedupe.add(key);
        this.dedupeOrder.push(key);
        while (this.dedupeOrder.length > DEDUPE_LIMIT) {
            const oldest = this.dedupeOrder.shift();
            if (oldest !== undefined)
                this.dedupe.delete(oldest);
        }
    }
    /**
     * 安排一次唤醒。
     *
     * 两个刻意的选择：
     * - **没有待办就不排定时器**：否则 worker 会以 40 次/秒的节奏空转；
     * - 定时器**不加 unref**：还有邮件没发出去时，进程不应该「若无其事地退出」。
     *   `stop()` 会清掉定时器，因此不会影响正常关停。
     */
    wake() {
        if (this.stopped || this.timer)
            return;
        if (this.items.length === 0)
            return;
        const delay = this.nextDelay();
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.run();
        }, delay);
    }
    /** 下一次被唤醒前应该等多久。 */
    nextDelay() {
        if (this.draining)
            return 25;
        const wait = this.rateLimitWait();
        if (wait > 0)
            return Math.min(wait, RATE_WINDOW_MS);
        const soonest = Math.min(...this.items.map((item) => item.notBefore));
        return Math.max(25, Math.min(soonest - Date.now(), 30_000));
    }
    async run() {
        if (this.running || this.stopped)
            return;
        this.running = true;
        try {
            for (;;) {
                if (this.stopped)
                    break;
                if (!this.draining) {
                    const wait = this.rateLimitWait();
                    if (wait > 0)
                        break;
                }
                const item = this.takeReady();
                if (!item)
                    break;
                await this.attempt(item);
            }
        }
        catch (error) {
            // worker 自身出问题也不能让进程崩：记录后退出本次循环
            this.logger.error('评论邮件队列异常', { error: error instanceof Error ? error.message : String(error) });
        }
        finally {
            this.running = false;
            if (!this.stopped)
                this.wake();
        }
    }
    takeReady() {
        const now = Date.now();
        let best = -1;
        for (let index = 0; index < this.items.length; index += 1) {
            const item = this.items[index];
            if (!this.draining && item.notBefore > now)
                continue;
            if (best < 0 || item.notBefore < this.items[best].notBefore)
                best = index;
        }
        if (best < 0)
            return undefined;
        return this.items.splice(best, 1)[0];
    }
    async attempt(item) {
        const attempts = item.attempts + 1;
        this.log.patch(item.recordId, { status: 'sending', attempts });
        this.logger.debug('开始投递评论邮件', { to: item.task.to, kind: item.task.kind, attempts });
        try {
            await this.deliver(item.task);
            this.sentAt.push(Date.now());
            this.log.patch(item.recordId, { status: 'sent', attempts, error: undefined, nextAttemptAt: undefined });
            this.logger.info('评论邮件已投递', { to: item.task.to, kind: item.task.kind });
        }
        catch (error) {
            const message = this.log.redact(error);
            const retryable = error instanceof SmtpError ? error.retryable : true;
            if (retryable && attempts < this.maxAttempts) {
                const delay = this.backoffFor(attempts);
                const notBefore = Date.now() + delay;
                this.items.push({ ...item, attempts, notBefore });
                this.log.patch(item.recordId, {
                    status: 'queued',
                    attempts,
                    error: message,
                    nextAttemptAt: new Date(notBefore).toISOString()
                });
                this.logger.warn('评论邮件投递失败，稍后重试', {
                    to: item.task.to,
                    attempts,
                    retryInMs: delay,
                    error: message
                });
                return;
            }
            this.log.patch(item.recordId, { status: 'failed', attempts, error: message, nextAttemptAt: undefined });
            this.logger.error('评论邮件投递失败（不再重试）', {
                to: item.task.to,
                attempts,
                retryable,
                error: message
            });
        }
    }
    backoffFor(attempts) {
        const index = Math.min(attempts - 1, this.backoffMs.length - 1);
        const base = this.backoffMs[index] ?? 1000;
        // 抖动 ±20%：同时失败的任务不会在同一秒一起重试
        const jitter = base * 0.2 * (Math.random() * 2 - 1);
        return Math.max(200, Math.round(base + jitter));
    }
    pruneRateWindow() {
        const threshold = Date.now() - RATE_WINDOW_MS;
        while (this.sentAt.length > 0 && this.sentAt[0] < threshold)
            this.sentAt.shift();
    }
    /** 距离「可以再发一封」还有多久；0 表示现在就可以发。 */
    rateLimitWait() {
        this.pruneRateWindow();
        if (this.sentAt.length < this.rateLimitPerMinute)
            return 0;
        const oldest = this.sentAt[0];
        return Math.max(0, oldest + RATE_WINDOW_MS - Date.now());
    }
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
//# sourceMappingURL=queue.js.map