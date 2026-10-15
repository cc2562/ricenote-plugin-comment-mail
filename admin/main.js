/**
 * 评论邮件通知插件的后台界面（零构建）。
 *
 * 约定（见官方 wiki「插件自带后台界面」）：
 * - 依赖全部来自 `/admin-sdk/v1/ricenote-admin.js`（与宿主共用同一份 Vue）；
 * - 组件（AdminPage/Card/Button/Badge/DataTable/Field/Input/Switch/Tabs/ConfirmDialog…）由宿主全局注册，
 *   模板里直接写标签即可，不 import；
 * - 走 `api.*` 请求：投递相关用本插件自己的管理 API（`/api/admin/comment-mail/*`），
 *   而**保存模板必须走宿主**的插件设置接口（`PUT /api/admin/plugins/:id/settings`，要求 `plugin.manage`）——
 *   设置是启动期快照，保存后需要重启进程才会生效。
 *
 * 页面语义：**自检优先** —— 第一屏回答「配置是否就绪、为什么发不出去」；
 * 其次是「模板是否要改」（可点选插入变量 + 实时预览 + 直接试发）；最后是投递记录。
 */

import {
  api,
  computed,
  defineAdminPage,
  formatDateTime,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  useSession,
  useSystemState,
  useToast,
  watch
} from '/admin-sdk/v1/ricenote-admin.js';

const PLUGIN_ID = 'ccrice.comment-mail';
const STATUS_PATH = '/comment-mail/status';
const TEMPLATES_PATH = '/comment-mail/templates';
const PREVIEW_PATH = '/comment-mail/template-preview';
const TEST_PATH = '/comment-mail/test';
const SETTINGS_PATH = `/plugins/${PLUGIN_ID}/settings`;
const CLEAR_PATH = '/comment-mail/records/clear';
const POLL_MS = 5000;
const PREVIEW_DEBOUNCE_MS = 400;

/** 通知类型 → 展示文案。 */
const KIND_LABEL = {
  'admin-new-comment': '新评论 → 站长',
  'reply-to-parent': '回复 → 被回复者',
  'comment-approved': '公开 → 评论者',
  'comment-rejected': '未通过 → 评论者'
};

/** 投递状态 → 徽标文案与色调（Badge variant 受控取值）。 */
const STATUS_META = {
  queued: { label: '排队中', variant: 'muted' },
  sending: { label: '发送中', variant: 'warning' },
  sent: { label: '已发送', variant: 'success' },
  failed: { label: '失败', variant: 'error' },
  dropped: { label: '已丢弃', variant: 'muted' }
};

/** 自检结论等级 → 徽标色调。 */
const LEVEL_META = {
  ok: { label: '正常', variant: 'success' },
  warn: { label: '注意', variant: 'warning' },
  error: { label: '异常', variant: 'error' }
};

const SECURE_LABEL = {
  ssl: '隐式 TLS',
  starttls: 'STARTTLS',
  none: '不加密'
};

const FILTER_LABEL = {
  all: '全部评论',
  'exclude-spam': '排除垃圾评论',
  'approved-only': '仅已公开的评论'
};

const COLUMNS = [
  { key: 'createdAt', label: '时间', width: '150px' },
  { key: 'kind', label: '类型', width: '170px', hideBelow: 'lg' },
  { key: 'to', label: '收件人' },
  { key: 'subject', label: '主题', hideBelow: 'md' },
  { key: 'status', label: '状态', width: '110px' },
  { key: 'actions', label: '操作', width: '100px', align: 'right' }
];

function messageOf(error, fallback) {
  return error && error.message ? error.message : fallback;
}

function sameText(left, right) {
  return String(left ?? '').trim() === String(right ?? '').trim();
}

export default defineAdminPage({
  title: '评论邮件',

  setup() {
    const session = useSession();
    const toast = useToast();
    const system = useSystemState();
    const canManage = computed(() => session.can('comment-mail.manage'));
    const canWriteSettings = computed(() => session.can('plugin.manage'));

    /* ---------- 状态与记录 ---------- */
    const loading = ref(true);
    const ready = ref(false);
    const readiness = ref([]);
    const settings = ref({});
    const queue = ref({});
    const records = ref([]);
    const startedAt = ref('');
    const onlyFailed = ref(false);
    const busyRecord = ref('');
    const clearing = ref(false);
    const confirmClear = ref(false);

    /* ---------- 测试发信 ---------- */
    const testTo = ref('');
    const testing = ref(false);
    const testResult = ref(null);

    /* ---------- 模板 ---------- */
    const templateData = ref(null);
    const activeKey = ref('admin-new-comment');
    const drafts = reactive({});
    /** 最近一次成功提交的内容（用于区分「未保存」与「已保存待重启」）。 */
    const savedDrafts = reactive({});
    const preview = ref(null);
    const previewLoading = ref(false);
    const previewError = ref('');
    const showTextPreview = ref(false);
    const savingTemplate = ref(false);
    const sendingPreview = ref(false);
    const htmlArea = ref(null);
    const pendingRestart = ref(false);

    let statusTimer;
    let previewTimer;

    /* ---------- 派生 ---------- */
    const failedCount = computed(() => (queue.value.failed ?? 0) + (queue.value.dropped ?? 0));
    const visibleRecords = computed(() =>
      onlyFailed.value ? records.value.filter((item) => item.status === 'failed' || item.status === 'dropped') : records.value
    );
    const troubles = computed(() => readiness.value.filter((item) => item.level !== 'ok'));
    const headline = computed(() => {
      if (!ready.value) return '正在读取插件状态…';
      if (troubles.value.some((item) => item.level === 'error')) return '发信配置尚不完整，邮件发不出去';
      if (troubles.value.length > 0) return '发信配置可用，但有几处需要留意';
      return '发信配置就绪';
    });

    const scenarios = computed(() => (templateData.value ? templateData.value.scenarios : []));
    const variables = computed(() => (templateData.value ? templateData.value.variables : []));
    const templateTabs = computed(() => scenarios.value.map((item) => ({ key: item.key, label: item.label })));
    const activeScenario = computed(
      () => scenarios.value.find((item) => item.key === activeKey.value) ?? { key: activeKey.value, label: '', hint: '' }
    );
    const activeDraft = computed(() => drafts[activeKey.value] ?? { subject: '', html: '' });
    const activeState = computed(() => templateState(activeKey.value));
    const dirtyKeys = computed(() => scenarios.value.filter((item) => isDirty(item.key)).map((item) => item.key));
    const previewHtml = computed(() => (preview.value ? preview.value.html : ''));
    const previewWarnings = computed(() => (preview.value && preview.value.warnings) || []);

    /* ---------- 状态与记录：取数 ---------- */
    function kindLabel(kind) {
      return KIND_LABEL[kind] ?? kind ?? '—';
    }

    function statusMeta(status) {
      return STATUS_META[status] ?? { label: status ?? '—', variant: 'muted' };
    }

    function levelMeta(level) {
      return LEVEL_META[level] ?? { label: level, variant: 'muted' };
    }

    function canRetry(record) {
      return record.status === 'failed' || record.status === 'dropped';
    }

    async function load({ silent = false } = {}) {
      if (!silent) loading.value = true;
      try {
        const data = await api.get(STATUS_PATH);
        ready.value = Boolean(data && data.ready);
        readiness.value = (data && data.readiness) || [];
        settings.value = (data && data.settings) || {};
        queue.value = (data && data.queue) || {};
        records.value = (data && data.records) || [];
        startedAt.value = (data && data.startedAt) || '';
      } catch (error) {
        ready.value = false;
        toast.error(messageOf(error, '读取评论邮件状态失败'));
      } finally {
        loading.value = false;
      }
    }

    async function retry(record) {
      busyRecord.value = record.id;
      try {
        const result = await api.post(`/comment-mail/records/${encodeURIComponent(record.id)}/retry`);
        if (result && result.ok) toast.success('已重新入队');
        else toast.warning('该记录已不可重发（可能已发送或不在内存中）');
        await load({ silent: true });
      } catch (error) {
        toast.error(messageOf(error, '重发失败'));
      } finally {
        busyRecord.value = '';
      }
    }

    async function clearRecords() {
      clearing.value = true;
      try {
        const result = await api.post(CLEAR_PATH);
        toast.success(`已清空 ${(result && result.cleared) || 0} 条记录`);
        confirmClear.value = false;
        await load({ silent: true });
      } catch (error) {
        toast.error(messageOf(error, '清空记录失败'));
      } finally {
        clearing.value = false;
      }
    }

    /* ---------- 测试发信 ---------- */
    async function sendTest() {
      const to = testTo.value.trim();
      if (!to) {
        toast.warning('请先填写测试收件邮箱');
        return;
      }
      testing.value = true;
      testResult.value = null;
      try {
        const result = await api.post(TEST_PATH, { to });
        testResult.value = { ...result, to };
        if (result && result.ok) toast.success(`测试邮件已发出（${result.elapsedMs ?? 0} ms）`);
        else toast.error('测试发信失败，详见下方错误信息');
        await load({ silent: true });
      } catch (error) {
        testResult.value = { ok: false, to, error: messageOf(error, '测试发信请求失败'), retryable: false };
        toast.error(messageOf(error, '测试发信请求失败'));
      } finally {
        testing.value = false;
      }
    }

    /* ---------- 模板：加载与编辑 ---------- */
    async function loadTemplates() {
      try {
        const data = await api.get(TEMPLATES_PATH);
        templateData.value = data;

        for (const scenario of data.scenarios) {
          const effective = (data.effective && data.effective[scenario.key]) || data.defaults[scenario.key];
          const subject = (effective && effective.subject) || '';
          const html = (effective && effective.html) || '';
          // 已保存过的场景保留草稿，避免刷新把正在编辑的内容冲掉
          if (!drafts[scenario.key]) drafts[scenario.key] = { subject, html };
          if (!savedDrafts[scenario.key]) savedDrafts[scenario.key] = { subject, html };
        }

        if (!data.scenarios.some((item) => item.key === activeKey.value) && data.scenarios[0]) {
          activeKey.value = data.scenarios[0].key;
        }
        schedulePreview(true);
      } catch (error) {
        templateData.value = null;
        toast.error(messageOf(error, '读取邮件模板失败'));
      }
    }

    /** 某个场景在设置里的两个键（由服务端下发，避免前端硬编码）。 */
    function settingKeysOf(key) {
      const map = (templateData.value && templateData.value.settingKeys) || {};
      return map[key] ?? null;
    }

    function defaultsOf(key) {
      const map = (templateData.value && templateData.value.defaults) || {};
      return map[key] ?? { subject: '', html: '' };
    }

    function effectiveOf(key) {
      const map = (templateData.value && templateData.value.effective) || {};
      return map[key] ?? defaultsOf(key);
    }

    function isDirty(key) {
      const draft = drafts[key];
      const effective = effectiveOf(key);
      if (!draft) return false;
      return !sameText(draft.subject, effective.subject) || !sameText(draft.html, effective.html);
    }

    /** 场景的三种状态：当前生效 / 已保存待重启 / 未保存修改。 */
    function templateState(key) {
      if (!templateData.value) return { label: '读取中', variant: 'muted' };
      const draft = drafts[key] ?? { subject: '', html: '' };
      const effective = effectiveOf(key);
      const saved = savedDrafts[key] ?? effective;

      if (sameText(draft.subject, effective.subject) && sameText(draft.html, effective.html)) {
        const overridden = Array.isArray(templateData.value.customized) && templateData.value.customized.includes(key);
        return overridden
          ? { label: '自定义（当前生效）', variant: 'success' }
          : { label: '使用内置默认', variant: 'muted' };
      }
      if (sameText(draft.subject, saved.subject) && sameText(draft.html, saved.html)) {
        return { label: '已保存，待重启生效', variant: 'warning' };
      }
      return { label: '有未保存的修改', variant: 'warning' };
    }

    /** 把变量插到光标处（拿不到光标就追加到末尾）。 */
    function insertVariable(name) {
      const key = activeKey.value;
      const draft = drafts[key];
      if (!draft) return;

      const token = `{{${name}}}`;
      const area = htmlArea.value;
      if (!area || typeof area.selectionStart !== 'number') {
        draft.html = `${draft.html}${token}`;
        return;
      }

      const start = area.selectionStart;
      const end = area.selectionEnd ?? start;
      draft.html = `${draft.html.slice(0, start)}${token}${draft.html.slice(end)}`;
      void nextTick(() => {
        area.focus();
        const position = start + token.length;
        area.setSelectionRange(position, position);
      });
    }

    function useDefault() {
      const key = activeKey.value;
      drafts[key] = { subject: '', html: '' };
      toast.info('已清空该场景的模板，保存后即恢复内置默认');
    }

    function restoreDefaultText() {
      const key = activeKey.value;
      const fallback = defaultsOf(key);
      drafts[key] = { subject: fallback.subject, html: fallback.html };
    }

    /* ---------- 模板：预览 ---------- */
    function schedulePreview(immediate = false) {
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => void runPreview(), immediate ? 0 : PREVIEW_DEBOUNCE_MS);
    }

    async function runPreview() {
      const key = activeKey.value;
      const draft = drafts[key];
      if (!draft) return;

      previewLoading.value = true;
      previewError.value = '';
      try {
        const data = await api.post(PREVIEW_PATH, { key, subject: draft.subject, html: draft.html });
        if (!data || data.ok === false) {
          previewError.value = (data && data.error) || '预览失败';
          preview.value = null;
        } else {
          preview.value = { ...data, key };
        }
      } catch (error) {
        previewError.value = messageOf(error, '预览失败');
        preview.value = null;
      } finally {
        previewLoading.value = false;
      }
    }

    /* ---------- 模板：保存与试发 ---------- */
    async function saveTemplates(keys) {
      const targets = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
      if (targets.length === 0) {
        toast.info('没有需要保存的修改');
        return;
      }

      const values = {};
      for (const key of targets) {
        const names = settingKeysOf(key);
        const draft = drafts[key];
        const fallback = defaultsOf(key);
        if (!names || !draft) continue;
        // 与内置默认一致的内容按「未自定义」保存（存空串），这样以后升级默认模板能跟着变
        values[names.subject] = sameText(draft.subject, fallback.subject) ? '' : draft.subject;
        values[names.html] = sameText(draft.html, fallback.html) ? '' : draft.html;
      }

      if (Object.keys(values).length === 0) {
        toast.warning('模板数据尚未加载完成');
        return;
      }

      savingTemplate.value = true;
      try {
        await api.put(SETTINGS_PATH, { values });
        for (const key of targets) {
          savedDrafts[key] = { subject: drafts[key].subject, html: drafts[key].html };
        }
        pendingRestart.value = true;
        if (typeof system.markPending === 'function') system.markPending('评论邮件模板已保存');
        else if (typeof system.refresh === 'function') void system.refresh();
        toast.success('模板已保存，重启服务后生效');
      } catch (error) {
        const message = messageOf(error, '保存模板失败');
        toast.error(
          error && error.status === 403
            ? '保存模板需要 plugin.manage 权限（或到「扩展中心 → 插件 → 设置」里修改）'
            : message
        );
      } finally {
        savingTemplate.value = false;
      }
    }

    async function sendPreviewMail() {
      const to = (testTo.value || '').trim();
      if (!to) {
        toast.warning('请先在上方「测试发信」里填写收件邮箱');
        return;
      }
      const key = activeKey.value;
      const draft = drafts[key];
      if (!draft) return;

      sendingPreview.value = true;
      try {
        const result = await api.post(TEST_PATH, { to, template: key, subject: draft.subject, html: draft.html });
        if (result && result.ok) toast.success(`已按当前模板发到 ${to}`);
        else toast.error((result && result.error) || '发送预览失败');
      } catch (error) {
        toast.error(messageOf(error, '发送预览失败'));
      } finally {
        sendingPreview.value = false;
      }
    }

    /* ---------- 生命周期 ---------- */
    watch(activeKey, () => schedulePreview(true));
    watch(
      () => [activeDraft.value.subject, activeDraft.value.html],
      () => schedulePreview()
    );

    onMounted(async () => {
      await Promise.all([load(), loadTemplates()]);
      // 平台没有服务端推送，用轮询保持队列与记录新鲜；卸载时必须清理，否则页面切换后仍在打接口
      statusTimer = window.setInterval(() => void load({ silent: true }), POLL_MS);
    });

    onBeforeUnmount(() => {
      if (statusTimer !== undefined) window.clearInterval(statusTimer);
      window.clearTimeout(previewTimer);
      statusTimer = undefined;
    });

    return {
      activeDraft,
      activeKey,
      activeScenario,
      activeState,
      canManage,
      canRetry,
      canWriteSettings,
      clearRecords,
      clearing,
      columns: COLUMNS,
      confirmClear,
      dirtyKeys,
      failedCount,
      filterLabel: FILTER_LABEL,
      formatDateTime,
      headline,
      htmlArea,
      insertVariable,
      isDirty,
      kindLabel,
      levelMeta,
      load,
      loadTemplates,
      loading,
      onlyFailed,
      pendingRestart,
      preview,
      previewError,
      previewHtml,
      previewLoading,
      previewWarnings,
      queue,
      readiness,
      ready,
      records,
      restoreDefaultText,
      retry,
      runPreview,
      saveTemplates,
      secureLabel: SECURE_LABEL,
      sendPreviewMail,
      sendingPreview,
      sendTest,
      savingTemplate,
      settings,
      showTextPreview,
      startedAt,
      statusMeta,
      templateTabs,
      templateData,
      testResult,
      testTo,
      testing,
      troubles,
      useDefault,
      variables,
      visibleRecords,
      busyRecord
    };
  },

  template: `
<AdminPage title="评论邮件" :description="headline">
  <template #actions>
    <div class="flex items-center gap-2">
      <Badge :variant="troubles.length === 0 ? 'success' : (troubles.some((item) => item.level === 'error') ? 'error' : 'warning')">
        {{ troubles.length === 0 ? '配置就绪' : troubles.length + ' 项待处理' }}
      </Badge>
      <Button variant="outline" :loading="loading" @click="load()">
        <Icon name="refresh" class="h-4 w-4" />
        刷新
      </Button>
    </div>
  </template>

  <p v-if="!canManage" class="text-xs text-warning">
    当前账号没有「comment-mail.manage」权限，本页仅供查看。
  </p>
  <p v-if="pendingRestart" class="cm-banner">
    模板已保存：<strong>重启服务</strong>后才会生效（当前仍在用旧模板，模板区右上角的徽标已标明状态）。
  </p>

  <!-- 1. 配置自检：发不出去时，原因必须一眼可见 -->
  <Card class="p-5">
    <h2 class="text-sm font-semibold text-foreground">配置自检</h2>
    <p class="mt-1 text-xs text-muted-foreground">
      逐项核对发信链路。密码只从服务端环境变量读取，不保存在插件设置里，因此这里只显示「是否已配置」。
    </p>

    <ul class="cm-list mt-3">
      <li v-for="(item, index) in readiness" :key="index" class="cm-list__row">
        <Badge :variant="levelMeta(item.level).variant">{{ levelMeta(item.level).label }}</Badge>
        <div class="min-w-0 flex-1">
          <p class="text-xs font-medium text-foreground">{{ item.label }}</p>
          <p v-if="item.detail" class="mt-0.5 break-all text-[11px] text-muted-foreground">{{ item.detail }}</p>
        </div>
      </li>
    </ul>

    <p v-if="readiness.length === 0" class="mt-3 text-xs text-muted-foreground">正在读取…</p>
  </Card>

  <!-- 2. 测试发信：唯一的「现在就能验证」手段 -->
  <Card class="p-5">
    <h2 class="text-sm font-semibold text-foreground">测试发信</h2>
    <p class="mt-1 text-xs text-muted-foreground">
      走与通知邮件完全相同的 SMTP 链路，用来确认地址、端口、加密方式与凭据是否可用；
      下面的「邮件模板」区也可以把某一套模板直接发到这里填的邮箱。
    </p>

    <div class="mt-3 flex flex-wrap items-end gap-3">
      <Field label="收件邮箱" class="min-w-0 flex-1">
        <Input v-model="testTo" placeholder="you@example.com" @enter="sendTest" />
      </Field>
      <Button :loading="testing" :disabled="!canManage" @click="sendTest">
        <Icon name="mail" class="h-3.5 w-3.5" />
        发送配置自检邮件
      </Button>
    </div>

    <div v-if="testResult" class="cm-result" :class="testResult.ok ? 'cm-result--ok' : 'cm-result--error'">
      <p class="text-xs font-medium">
        {{ testResult.ok ? '邮件已投递到 ' + testResult.to : '发送失败（' + testResult.to + '）' }}
      </p>
      <p v-if="testResult.error" class="cm-result__detail">{{ testResult.error }}</p>
      <p v-if="testResult.hint" class="mt-1 text-[11px] text-muted-foreground">{{ testResult.hint }}</p>
    </div>
  </Card>

  <!-- 3. 邮件模板：点选变量 + 实时预览 + 按模板试发 -->
  <Card class="p-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-sm font-semibold text-foreground">邮件模板</h2>
        <p class="mt-1 text-xs text-muted-foreground">
          留空即用内置默认；变量点一下插入到光标处，右侧实时预览。保存后需<strong>重启服务</strong>才生效。
          只填 HTML 即可：纯文本版本会自动从 HTML 派生（保留链接与换行）。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Badge :variant="activeState.variant">{{ activeState.label }}</Badge>
        <Button
          v-if="dirtyKeys.length > 1"
          variant="outline"
          size="sm"
          :loading="savingTemplate"
          :disabled="!canWriteSettings"
          @click="saveTemplates(dirtyKeys)"
        >
          保存全部修改（{{ dirtyKeys.length }}）
        </Button>
      </div>
    </div>

    <p v-if="!canWriteSettings" class="mt-2 text-xs text-warning">
      保存模板需要「plugin.manage」权限；也可以到「扩展中心 → 插件 → 评论邮件通知 → 设置」里编辑（那边的字段同样可用）。
    </p>

    <div v-if="templateData" class="mt-3">
      <Tabs v-model="activeKey" :items="templateTabs" />

      <p class="mt-2 text-[11px] text-muted-foreground">{{ activeScenario.hint }}</p>

      <div class="cm-tpl mt-3">
        <div class="cm-tpl__editor">
          <Field label="邮件主题">
            <Input v-model="activeDraft.subject" :maxlength="templateData.limits.subject" />
          </Field>

          <div class="cm-tpl__label">
            <span>HTML 正文</span>
            <span class="text-[11px] text-muted-foreground">上限 {{ templateData.limits.html }} 字符</span>
          </div>
          <textarea
            ref="htmlArea"
            v-model="activeDraft.html"
            class="cm-editor"
            spellcheck="false"
            :maxlength="templateData.limits.html"
            placeholder="留空 = 使用内置默认模板"
          ></textarea>

          <div class="cm-chips">
            <button
              v-for="variable in variables"
              :key="variable.name"
              type="button"
              class="cm-chip"
              :title="variable.hint || variable.label"
              @click="insertVariable(variable.name)"
            >
              {{ variable.name }}
            </button>
          </div>
          <p class="mt-1 text-[11px] text-muted-foreground">
            点击变量插入到光标处；正文变量在 HTML 里会保留换行（换成 &lt;br&gt;），请放在正文位置。
          </p>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <Button :loading="savingTemplate" :disabled="!canWriteSettings" @click="saveTemplates(activeKey)">
              <Icon name="save" class="h-3.5 w-3.5" />
              保存模板
            </Button>
            <Button variant="outline" :loading="sendingPreview" :disabled="!canManage" @click="sendPreviewMail">
              <Icon name="mail" class="h-3.5 w-3.5" />
              发到测试邮箱
            </Button>
            <Button variant="ghost" :disabled="!canWriteSettings" @click="useDefault">使用默认（清空）</Button>
            <Button variant="ghost" @click="restoreDefaultText">载入默认内容</Button>
          </div>
        </div>

        <div class="cm-tpl__preview">
          <div class="cm-tpl__label">
            <span>预览（示例数据）</span>
            <span class="flex items-center gap-2">
              <span class="text-[11px] text-muted-foreground">主题：{{ preview ? preview.subject : '—' }}</span>
              <Button variant="ghost" size="sm" :loading="previewLoading" @click="runPreview">刷新</Button>
              <Button variant="ghost" size="sm" @click="showTextPreview = !showTextPreview">
                {{ showTextPreview ? '看 HTML' : '看纯文本' }}
              </Button>
            </span>
          </div>

          <p v-if="previewError" class="cm-result cm-result--error">
            <span class="cm-result__detail">{{ previewError }}</span>
          </p>

          <div v-if="previewWarnings.length > 0" class="cm-result cm-result--error">
            <p class="text-xs font-medium">模板里有未识别的变量（会原样出现在邮件里）</p>
            <p v-for="(warning, index) in previewWarnings" :key="index" class="cm-result__detail">{{ warning }}</p>
            <p class="mt-1 text-[11px] text-muted-foreground">
              可用的变量都在下面的芯片里，点一下即可插入。
            </p>
          </div>

          <pre v-if="showTextPreview" class="cm-preview-text">{{ preview ? preview.text : '' }}</pre>
          <iframe
            v-else
            class="cm-preview-frame"
            sandbox=""
            title="邮件预览"
            :srcdoc="previewHtml"
          ></iframe>
        </div>
      </div>
    </div>

    <p v-else class="mt-3 text-xs text-muted-foreground">正在读取模板…</p>
  </Card>

  <!-- 4. 生效参数：只读，来自启动期快照 -->
  <Card class="p-5">
    <h2 class="text-sm font-semibold text-foreground">当前生效参数</h2>
    <p class="mt-1 text-xs text-muted-foreground">
      插件设置是启动期快照：改完设置必须重启服务才生效（可在「系统」页重启）。
    </p>

    <dl class="cm-dl mt-3">
      <div><dt>SMTP 服务器</dt><dd>{{ settings.host || '未配置' }}{{ settings.host ? ':' + settings.port : '' }}</dd></div>
      <div><dt>加密方式</dt><dd>{{ secureLabel[settings.secure] || settings.secure || '—' }}</dd></div>
      <div>
        <dt>认证账号</dt>
        <dd>{{ settings.authUser || '不认证' }}{{ settings.authUserFromEnv ? '（环境变量）' : '' }}{{ settings.authWithoutPassword ? ' · 缺少密码环境变量' : '' }}</dd>
      </div>
      <div><dt>发件人</dt><dd>{{ settings.fromName || '（站点标题）' }} &lt;{{ settings.fromAddress || '未配置' }}&gt;</dd></div>
      <div><dt>兜底 Reply-To</dt><dd>{{ settings.replyTo || '未设置' }}</dd></div>
      <div><dt>每分钟上限</dt><dd>{{ settings.rateLimitPerMinute }} 封</dd></div>
      <div><dt>新评论通知</dt><dd>{{ settings.notifyAdminOnNew ? '开启' : '关闭' }}（{{ filterLabel[settings.newCommentFilter] || settings.newCommentFilter }}）</dd></div>
      <div><dt>站长收件人</dt><dd>{{ (settings.adminRecipients && settings.adminRecipients.length) ? settings.adminRecipients.join('、') : '未配置' }}</dd></div>
      <div><dt>回复通知</dt><dd>{{ settings.notifyParentOnReply ? '开启' : '关闭' }}</dd></div>
      <div><dt>审核结果通知</dt><dd>{{ settings.notifyCommenterOnApproved ? '公开时通知' : '不通知' }}{{ settings.notifyCommenterOnRejected ? ' · 未通过也通知' : '' }}</dd></div>
      <div><dt>插件启动于</dt><dd>{{ startedAt ? formatDateTime(startedAt) : '—' }}</dd></div>
    </dl>
  </Card>

  <!-- 5. 队列与统计 -->
  <Card class="p-5">
    <h2 class="text-sm font-semibold text-foreground">队列与统计</h2>
    <p class="mt-1 text-xs text-muted-foreground">
      发信在后台串行进行，不阻塞评论提交与审核；失败会按退避自动重试，超过次数后停止。
    </p>

    <dl class="cm-dl cm-dl--stats mt-3">
      <div><dt>待发</dt><dd>{{ queue.pending ?? 0 }}</dd></div>
      <div><dt>发送中</dt><dd>{{ queue.inFlight ? '是' : '否' }}</dd></div>
      <div><dt>已发送</dt><dd>{{ queue.sent ?? 0 }}</dd></div>
      <div><dt>失败</dt><dd>{{ queue.failed ?? 0 }}</dd></div>
      <div><dt>已丢弃</dt><dd>{{ queue.dropped ?? 0 }}</dd></div>
      <div><dt>近一分钟已发</dt><dd>{{ queue.rateWindowUsed ?? 0 }}</dd></div>
    </dl>
  </Card>

  <!-- 6. 投递记录 -->
  <Card class="p-5">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 class="text-sm font-semibold text-foreground">投递记录</h2>
        <p class="mt-1 text-xs text-muted-foreground">
          只保留在内存中（最多 200 条），进程重启即清空；失败原因已脱敏处理。
        </p>
      </div>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch v-model="onlyFailed" />
          只看失败与丢弃
        </label>
        <Button variant="outline" size="sm" :disabled="!canManage || records.length === 0" @click="confirmClear = true">
          <Icon name="trash" class="h-3.5 w-3.5" />
          清空记录
        </Button>
      </div>
    </div>

    <DataTable
      class="mt-3"
      :columns="columns"
      :rows="visibleRecords"
      row-key="id"
      :loading="loading"
      empty-title="还没有投递记录"
      empty-description="收到评论并通过审核后，通知邮件会出现在这里。"
    >
      <template #cell-createdAt="{ row }">
        <span class="text-[11px] text-muted-foreground">{{ formatDateTime(row.createdAt) }}</span>
      </template>
      <template #cell-kind="{ row }">
        <span class="text-xs text-foreground">{{ kindLabel(row.kind) }}</span>
      </template>
      <template #cell-to="{ row }">
        <span class="break-all text-xs text-foreground">{{ row.to }}</span>
      </template>
      <template #cell-subject="{ row }">
        <span class="text-xs text-muted-foreground">{{ row.subject }}</span>
        <p v-if="row.error" class="cm-error">{{ row.error }}</p>
      </template>
      <template #cell-status="{ row }">
        <Badge :variant="statusMeta(row.status).variant">{{ statusMeta(row.status).label }}</Badge>
        <span v-if="row.attempts > 1" class="ml-1 text-[11px] text-muted-foreground">×{{ row.attempts }}</span>
      </template>
      <template #cell-actions="{ row }">
        <Button
          v-if="canRetry(row)"
          variant="outline"
          size="sm"
          :loading="busyRecord === row.id"
          :disabled="!canManage"
          @click="retry(row)"
        >
          重发
        </Button>
        <span v-else class="text-[11px] text-muted-foreground">—</span>
      </template>
    </DataTable>
  </Card>

  <!-- 7. 明确的边界 -->
  <Card class="p-5">
    <h2 class="text-sm font-semibold text-foreground">已知限制</h2>
    <ul class="cm-notes mt-2">
      <li>不发送退订链接：通知邮件页脚固定注明「请勿直接回复」，同一评论对同一收件人只发一次。</li>
      <li>投递记录只在内存中，进程重启后清空；本插件不建数据表。</li>
      <li>模板存在插件设置里，改完必须重启服务才生效。</li>
      <li>没有定时任务：失败重试靠进程内的退避重试与这里的手动「重发」。</li>
      <li>评论被判为垃圾或删除时，默认不向评论者发信（可在设置里开启）。</li>
      <li>「未通过审核」在平台侧没有事件，因此删除评论不会触发任何邮件。</li>
    </ul>
  </Card>

  <ConfirmDialog
    :open="confirmClear"
    title="清空投递记录？"
    message="只会清空内存中的展示记录，不影响已发出的邮件，也不会重发任何邮件。"
    tone="destructive"
    confirm-label="清空"
    :loading="clearing"
    @update:open="(value) => { if (!value) confirmClear = false; }"
    @confirm="clearRecords"
  />
</AdminPage>
`
});
