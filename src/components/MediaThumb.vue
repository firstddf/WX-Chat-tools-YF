<script setup lang="ts">
// 图片附件缩略图（M-A4）——移植 Tk gui_chatview `_draw_media` / `_load_photo` / `_open_media`：
// - 已解码（media.path 有值且 decoded=true）→ <img>，最长边 ≤220px 等比（Tk MAX_IMAGE）；
// - 未解析 / 本机缺失 / 解码或加载失败 → 「[图片] 名」占位（文案与 Tk 完全一致）；
// - 单击缩略图（或解码失败但仍有路径的占位）→ ipc.openPath(media.path) 打开原文件；
// - src 走 Tauri asset 协议：fileSrc 用 convertFileSrc 把绝对路径转成 WebView 可加载的 URL。
//   tauri.conf.json `app.security.assetProtocol` 只放行每用户解码缓存
//   （`$APPLOCALDATA/media/**`，dev/release 统一，见 sidecar.rs `media_work_dir`），
//   **不放行微信原始目录**；协议本身由 Cargo feature
//   `protocol-asset` 启用。浏览器 / MockIpc 没有 __TAURI_INTERNALS__，fileSrc 退回原 path。
// - 虚拟滚动会把 <img> 反复销毁重建：首次加载后异步生成 ≤220px 的 dataURL 按 path 缓存
//   （对应 Tk `_photo_cache` / PHOTO_CACHE_SIZE），滚回来直接命中缓存、不再解码原图；
//   缓存是纯优化项——任何失败都退回原图直载，不影响显示。
// - 懒解码（docs/02 §1.2 resolve_media）：加载期图片只定位不解码（decoded=false、path=""），
//   挂载/变化时把消息全量下标交给 store.queueResolveMedia 排队按需解码；
//   已判「解码失败」的（store.isDecodeFailed）不再排队——占位不重试、无请求死循环。
import { computed, inject, ref, watch } from 'vue';
import type { Media, Message } from '../ipc/types';
import { useIpc } from '../ipc/context';
import { fileSrc } from '../ipc/tauri';
import { STORE_KEY } from '../state/store';

const MAX_IMAGE = 220; // 同 Tk gui_chatview.MAX_IMAGE（缩略图最大边长）
const PHOTO_CACHE_SIZE = 400; // 同 Tk gui_chatview.PHOTO_CACHE_SIZE

/** path(+尺寸) → ≤220px 缩略图 dataURL（LRU：Map 插入序，命中时重新插入） */
const thumbCache = new Map<string, string>();
/** 已知坏图（加载失败）：滚动回来直接占位，不反复请求同一个坏文件 */
const brokenCache = new Set<string>();

const props = withDefaults(
  defineProps<{
    /** 所属消息（只用于 tooltip 上下文；渲染只需 media 自身字段） */
    msg?: Message;
    /** media[] 里的一项（docs/02 §1.3 字段冻结） */
    med: Media;
    /** 打开前的守卫：返回 true 表示这次单击不打开（刚拖选过文字，A1 #17） */
    guard?: () => boolean;
    /** 缩略图最大边长（px），默认 220 = Tk MAX_IMAGE */
    maxSize?: number;
    /** 消息在全量 messages 里的下标（懒解码 resolve_media 的入参；缺省=不排队解码） */
    index?: number;
  }>(),
  { maxSize: MAX_IMAGE },
);

const ipc = useIpc();

/**
 * store 可选注入：App 提供（懒解码排队），MediaThumb 单测不 provide → null，
 * 保持「不发任何请求」的现状。
 */
const store = inject(STORE_KEY, null);

function cacheKey(path: string, maxSize: number): string {
  return `${maxSize}|${path}`;
}

function cacheGet(key: string): string {
  const hit = thumbCache.get(key);
  if (hit === undefined) return '';
  thumbCache.delete(key);
  thumbCache.set(key, hit); // 命中即置新（LRU）
  return hit;
}

function cachePut(key: string, data: string): void {
  thumbCache.set(key, data);
  while (thumbCache.size > PHOTO_CACHE_SIZE) {
    const oldest = thumbCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    thumbCache.delete(oldest);
  }
}

/** 有本机可预览路径：path 只在「文件存在且 decoded」时才有值（guidata._media_from_message） */
const loadable = computed(() => Boolean(props.med.path) && Boolean(props.med.decoded));
const name = computed(() => props.med.name || '图片');
const alt = computed(() => props.med.name || '图片');
const title = computed(() => {
  const where = props.msg?.chat ? `${props.msg.chat} · ` : '';
  return `${where}${name.value}（点击打开）`;
});

const thumbSrc = ref('');
const broken = ref(false);
const imgSrc = computed(() => thumbSrc.value || fileSrc(props.med.path));

const imgStyle = computed(() => ({
  maxWidth: `${props.maxSize}px`,
  maxHeight: `${props.maxSize}px`,
  objectFit: 'contain' as const,
}));

watch(
  () => [props.med.path, props.med.decoded, props.maxSize] as const,
  ([path, , maxSize]) => {
    const key = path ? cacheKey(path, maxSize) : '';
    thumbSrc.value = key ? cacheGet(key) : '';
    // 已知坏图直接从占位开始（不重复加载），命中缓存则直接显示缩略图
    broken.value = Boolean(key) && brokenCache.has(key);
  },
  { immediate: true },
);

/**
 * 懒解码触发（docs/02 §1.2 `resolve_media`）：图片还没解码、且拿得到消息全量下标时，
 * 把下标交给 store 的解码队列（微任务合批 / ≤32 分批 / 同下标去重 / 代际守卫都在 store 里）。
 * - 无 store（单测不 provide）→ 不发请求，保持现状；
 * - key 已判「解码失败」→ 直接跳过：占位不再重试，也不存在请求死循环；
 * - 同消息多图共用同一 index，去重由 store 负责。
 */
function queueDecode(): void {
  if (!store) return;
  const med = props.med;
  if (med.kind !== 'image' || med.decoded) return;
  const index = props.index;
  if (index == null || index < 0) return;
  const msg = props.msg;
  if (msg) {
    const mi = msg.media.indexOf(med); // v-for 里的元素就是 msg.media 里的对象
    if (mi >= 0 && store.isDecodeFailed(msg, index, mi)) return;
  }
  store.queueResolveMedia(index);
}

watch(
  () => [props.med.kind, props.med.decoded, props.index ?? -1] as const,
  () => queueDecode(),
  { immediate: true },
);

/** 首次加载后生成小图缓存（失败静默：只影响缓存命中率） */
async function rememberThumb(el: HTMLImageElement): Promise<void> {
  const path = props.med.path;
  if (!path || typeof createImageBitmap !== 'function') return;
  const key = cacheKey(path, props.maxSize);
  if (thumbCache.has(key)) return;
  try {
    // asset 协议响应带 Access-Control-Allow-Origin（tauri protocol/asset.rs），可 CORS 读取；
    // 失败（普通浏览器 mock / CORS 策略变化）只放弃缓存，<img> 本身已经正常显示。
    const res = await fetch(el.currentSrc || fileSrc(path), {
      mode: 'cors',
      credentials: 'omit',
    });
    if (!res.ok) return;
    const bitmap = await createImageBitmap(await res.blob());
    try {
      const scale = Math.min(1, props.maxSize / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/webp', 0.85);
      if (data.startsWith('data:image/')) cachePut(key, data);
    } finally {
      bitmap.close();
    }
  } catch {
    /* 缓存是优化项：忽略 */
  }
}

function onLoad(event: Event): void {
  broken.value = false;
  void rememberThumb(event.target as HTMLImageElement);
}

function onError(): void {
  broken.value = true;
  const path = props.med.path;
  if (path) brokenCache.add(cacheKey(path, props.maxSize));
}

/** 单击打开原文件（同 Tk _open_media；打开失败静默，壳会给出 PATH_NOT_ALLOWED 等提示） */
async function openOriginal(): Promise<void> {
  if (!props.med.path) return;
  if (props.guard?.()) return; // 刚拖选过文字：这次单击是拖选收尾，不打开（A1 #17）
  try {
    await ipc.openPath(props.med.path);
  } catch {
    /* 静默（同 MessageList.openMedia） */
  }
}
</script>

<template>
  <!-- 可预览：点击缩略图打开原文件；加载失败降级为占位（仍有路径 → 仍可点开） -->
  <button
    v-if="loadable"
    type="button"
    class="media-thumb"
    data-testid="media_thumb"
    :title="title"
    @click.stop="openOriginal"
  >
    <img
      v-if="!broken"
      class="thumb"
      data-testid="media_thumb_img"
      :src="imgSrc"
      :alt="alt"
      :style="imgStyle"
      @load="onLoad"
      @error="onError"
    />
    <span v-else class="missing" data-testid="media_missing">[图片] {{ name }}</span>
  </button>
  <!-- 未解析 / 本机缺失：Tk 同款占位文案，不可点 -->
  <span v-else class="missing" data-testid="media_missing">[图片] {{ name }}</span>
</template>

<style scoped>
/* 缩略图：等比缩放不拉伸（尺寸上限由内联 style 控制，便于断言 maxSize） */
.media-thumb {
  display: inline-flex;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  max-width: 100%;
  font: inherit;
}

.media-thumb .thumb {
  display: block;
  border-radius: 6px;
}

/* 有路径但解码/加载失败：占位仍可点击打开原文件（同 Tk _draw_media 的 LINK_COLOR 分支） */
.media-thumb .missing {
  cursor: pointer;
}
</style>
