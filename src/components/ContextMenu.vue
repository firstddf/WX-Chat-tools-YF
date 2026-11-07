<script setup lang="ts">
// 右键菜单（docs/04 A1 #15/#18）——Tk gui_chatview._build_context_menu 的 web 版：
// 四项文案与可用状态由父组件按位置算好传进来（见 state/dragselect.buildMenuItems），
// 本组件只负责渲染、点击执行与点外部关闭。菜单挂在 .vlist 内但 position: fixed，
// 不会被可滚动容器裁掉。
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { MenuItem, MenuKey } from '../state/dragselect';

const props = defineProps<{
  open: boolean;
  x: number;
  y: number;
  items: readonly MenuItem[];
}>();

const emit = defineEmits<{ select: [key: MenuKey]; close: [] }>();

const root = ref<HTMLElement | null>(null);

/** 点外部（含左键/右键）关闭；点在菜单内不关，交给菜单项 click */
function onDocMouseDown(event: MouseEvent): void {
  if (!props.open) return;
  if (root.value && event.target instanceof Node && root.value.contains(event.target)) return;
  emit('close');
}

onMounted(() => window.addEventListener('mousedown', onDocMouseDown, true));
onBeforeUnmount(() => window.removeEventListener('mousedown', onDocMouseDown, true));
</script>

<template>
  <div
    v-if="open"
    ref="root"
    class="ctx-menu"
    data-testid="ctx_menu"
    role="menu"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @mousedown.prevent.stop
    @contextmenu.prevent.stop
  >
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      class="ctx-item"
      :class="{ disabled: item.disabled }"
      :data-key="item.key"
      data-testid="ctx_item"
      role="menuitem"
      :disabled="item.disabled"
      :aria-disabled="item.disabled"
      @click.stop="!item.disabled && emit('select', item.key)"
    >
      {{ item.label }}
    </button>
  </div>
</template>
