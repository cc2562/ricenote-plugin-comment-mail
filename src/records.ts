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

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_ERROR = 400;

export class DeliveryLog {
  private items: DeliveryRecord[] = [];
  private readonly limit: number;
  private readonly secrets: string[];
  private readonly maxErrorLength: number;
  private sequence = 0;

  constructor(options: DeliveryLogOptions = {}) {
    this.limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    this.secrets = (options.secrets ?? []).filter((secret) => secret.length >= 4);
    this.maxErrorLength = options.maxErrorLength ?? DEFAULT_MAX_ERROR;
  }

  /** 记入一条待投递任务。 */
  create(task: MailTask): DeliveryRecord {
    const now = new Date().toISOString();
    this.sequence += 1;
    const record: DeliveryRecord = {
      id: `${Date.now().toString(36)}-${this.sequence.toString(36)}`,
      createdAt: now,
      updatedAt: now,
      kind: task.kind,
      commentId: task.commentId,
      to: task.to,
      subject: task.subject,
      status: 'queued',
      attempts: 0,
      task
    };
    this.items.push(record);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
    return record;
  }

  /** 更新一条记录；投递成功后释放任务体（不再需要重发）。 */
  patch(id: string, patch: Partial<DeliveryRecord>): DeliveryRecord | undefined {
    const record = this.items.find((item) => item.id === id);
    if (!record) return undefined;

    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    if (patch.error !== undefined) record.error = this.redact(patch.error);
    if (record.status === 'sent') delete record.task;
    return record;
  }

  get(id: string): DeliveryRecord | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** 最新在前的快照（返回浅拷贝数组，调用方无法改动内部状态）。 */
  list(): DeliveryRecord[] {
    return [...this.items].reverse().map((item) => ({ ...item }));
  }

  clear(): number {
    const removed = this.items.length;
    this.items = [];
    return removed;
  }

  stats(): Record<DeliveryStatus, number> {
    const result: Record<DeliveryStatus, number> = {
      queued: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      dropped: 0
    };
    for (const item of this.items) result[item.status] += 1;
    return result;
  }

  /** 错误脱敏 + 截断。 */
  redact(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    let text = raw;
    for (const secret of this.secrets) {
      text = text.split(secret).join('***');
    }
    // 顺手挡掉常见的 base64 凭据形态（AUTH LOGIN 的应答若被服务器回显）
    text = text.replace(/[A-Za-z0-9+/]{24,}={0,2}/g, (match) => (match.length >= 32 ? '***' : match));
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return text.length > this.maxErrorLength ? `${text.slice(0, this.maxErrorLength)}…` : text;
  }
}
