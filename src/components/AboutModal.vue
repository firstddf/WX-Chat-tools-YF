<script setup lang="ts">
// 「关于」弹窗（docs/07 #18，2026-11-11 发布准备）：
// 版本 / 协议版本 / 数据层状态 / 构建信息 / 隐私说明 / 许可——**全部取现有 AppInfo 与
// 构建期常量 `__BUILD_INFO__`，不新增协议字段**（docs/02 未改）。不含检查更新（拍板）。
// Esc 与点遮罩关闭；监听挂/摘成对（A1 #10 卸载无泄漏口径）。
import { computed, inject, onMounted, onUnmounted } from 'vue';
import { STORE_KEY } from '../state/store';

const store = inject(STORE_KEY)!;
const emit = defineEmits<{ close: [] }>();

const info = computed(() => store.data.appInfo);
// 构建期常量：必须在 script 里取——模板里的裸标识符会编译成 _ctx.__BUILD_INFO__（运行时 undefined）
const build = __BUILD_INFO__;

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="modal-mask" data-testid="about_modal" @click.self="emit('close')">
    <div class="modal-card" role="dialog" aria-label="关于">
      <div class="modal-head">
        <span class="modal-title">关于 微信聊天记录工具</span>
        <button type="button" class="f-btn" data-testid="about_close" @click="emit('close')">
          关闭
        </button>
      </div>
      <div class="modal-body" data-testid="about_body">
        <div class="about-row">
          <span class="f-label">应用</span>
          <span data-testid="about_name">{{ info?.name ?? '微信聊天记录工具' }}</span>
        </div>
        <div class="about-row">
          <span class="f-label">版本</span>
          <span data-testid="about_version">{{ info?.version ?? '—' }}</span>
        </div>
        <div class="about-row">
          <span class="f-label">协议版本</span>
          <span data-testid="about_protocol">{{ info?.protocol_version ?? '—' }}</span>
        </div>
        <div class="about-row">
          <span class="f-label">数据层</span>
          <span data-testid="about_sidecar">{{ info?.sidecar.state ?? '—' }}</span>
        </div>
        <div class="about-row">
          <span class="f-label">构建</span>
          <span data-testid="about_build">{{ build.builtAt }} · {{ build.commit }}</span>
        </div>
        <div class="about-row">
          <span class="f-label">作者</span>
          <span data-testid="about_author">firstddf</span>
        </div>
        <div class="about-row">
          <span class="f-label">仓库</span>
          <span data-testid="about_repo">https://github.com/firstddf/WX-Chat-tools-YF</span>
        </div>

        <div class="about-note" data-testid="about_privacy">
          隐私：微信数据<b>只读</b>访问，程序从不写入；消息与附件只在本机读取与导出，
          <b>不联网、不上传</b>；解密所需密钥仅从微信进程内存读取，不落盘、不写入日志。
        </div>
        <div class="about-note" data-testid="about_license">
          许可：PolyForm Noncommercial License 1.0.0（仅限非商业用途，详见仓库 LICENSE）。
          Required Notice: Copyright 2026 firstddf (https://github.com/firstddf/WX-Chat-tools-YF)
        </div>
      </div>
    </div>
  </div>
</template>
