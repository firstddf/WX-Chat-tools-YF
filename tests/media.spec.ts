// 图片附件缩略图组件测试（M-A4）——Tk gui_chatview `_draw_media` / `_open_media` 的 web 口径：
// 有路径 → <img>（asset 协议 URL 的浏览器回退）；缺失/未解码/加载失败 → 「[图片] 名」占位；
// 单击 → openPath 打开原文件；拖选收尾的单击不打开（A1 #17 guard 语义）。
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import MediaThumb from '@/components/MediaThumb.vue';
import { IPC_KEY } from '@/ipc/context';
import { MockIpc } from '@/ipc/mock';
import { fileSrc } from '@/ipc/tauri';
import type { Media, Message } from '@/ipc/types';

function makeMessage(partial: Partial<Message> = {}): Message {
  return {
    ts: 1793676480, day: '2026-11-05', time_text: '10:48:00', chat: '测试群甲',
    chat_id: '111@chatroom', sender: '张三', sender_id: 'wxid_a', is_mine: false,
    mtype: 'image', text: '', truncated: false, is_group: true, local_id: 0,
    server_id: 0, quote_sender: '', quote_text: '', quote_svrid: 0, media: [],
    source: 'store', day_page: '', chat_dir: '',
    ...partial,
  };
}

function makeMedia(partial: Partial<Media> = {}): Media {
  return {
    kind: 'image', name: '照片.jpg', path: '', rel_path: '', size: 0, decoded: false,
    ...partial,
  };
}

function mountThumb(
  media: Partial<Media>,
  opts: { msg?: Partial<Message>; guard?: () => boolean } = {},
) {
  const ipc = new MockIpc({ messageCount: 0 });
  const openPath = vi.spyOn(ipc, 'openPath');
  const wrapper = mount(MediaThumb, {
    props: {
      med: makeMedia(media),
      msg: makeMessage(opts.msg ?? {}),
      ...(opts.guard ? { guard: opts.guard } : {}),
    },
    global: { provide: { [IPC_KEY as symbol]: ipc } },
  });
  return { wrapper, openPath };
}

describe('M-A4 图片缩略图：有路径 → <img>', () => {
  it('decoded=true 且有 path：渲染 img.thumb，浏览器环境回退原路径，≤220px 等比', () => {
    const { wrapper } = mountThumb({ path: 'D:/mock/照片.png', decoded: true, name: '照片.png' });
    const img = wrapper.find('[data-testid="media_thumb_img"]');
    expect(img.exists()).toBe(true);
    expect(img.classes()).toContain('thumb'); // dragselect 的 img.thumb 命中依赖这个 class
    expect(img.attributes('src')).toBe('D:/mock/照片.png');
    const style = img.attributes('style') ?? '';
    expect(style).toContain('max-width: 220px');
    expect(style).toContain('max-height: 220px');
    expect(style).toContain('object-fit: contain');
    expect(wrapper.find('[data-testid="media_missing"]').exists()).toBe(false);
  });

  it('fileSrc：非 Tauri（浏览器 / MockIpc / Vitest）退回原 path，空路径回空串', () => {
    expect(fileSrc('D:/mock/a.png')).toBe('D:/mock/a.png');
    expect(fileSrc('')).toBe('');
  });
});

describe('M-A4 图片占位：[图片] 名（文案与 Tk 一致）', () => {
  it('path 为空 → 占位、不渲染 img、不可点', () => {
    const { wrapper, openPath } = mountThumb({ path: '', decoded: false, name: '不存在.png' });
    expect(wrapper.find('[data-testid="media_thumb_img"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="media_thumb"]').exists()).toBe(false);
    const missing = wrapper.find('[data-testid="media_missing"]');
    expect(missing.exists()).toBe(true);
    expect(missing.text()).toBe('[图片] 不存在.png');
    void openPath;
  });

  it('decoded=false（路径未解码）→ 同样占位', () => {
    const { wrapper } = mountThumb({ path: 'D:/mock/未解码.dat', decoded: false, name: '未解码.dat' });
    expect(wrapper.find('[data-testid="media_thumb_img"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="media_missing"]').text()).toBe('[图片] 未解码.dat');
  });

  it('img 加载失败 → 降级为占位（仍保留可点击打开原文件）', async () => {
    const { wrapper, openPath } = mountThumb({
      path: 'D:/mock/坏图-1.png', decoded: true, name: '坏图-1.png',
    });
    await wrapper.find('[data-testid="media_thumb_img"]').trigger('error');
    await nextTick();
    expect(wrapper.find('[data-testid="media_thumb_img"]').exists()).toBe(false);
    const missing = wrapper.find('[data-testid="media_missing"]');
    expect(missing.exists()).toBe(true);
    expect(missing.text()).toBe('[图片] 坏图-1.png');

    // Tk 语义：解码失败但文件仍在 → 占位仍可点击打开原文件
    await wrapper.find('[data-testid="media_thumb"]').trigger('click');
    await flushPromises();
    expect(openPath).toHaveBeenCalledWith('D:/mock/坏图-1.png');
  });
});

describe('M-A4 单击打开原文件（openPath）', () => {
  it('点击缩略图 → ipc.openPath(media.path)', async () => {
    const { wrapper, openPath } = mountThumb({
      path: 'D:/mock/照片-2.png', decoded: true, name: '照片-2.png',
    });
    await wrapper.find('[data-testid="media_thumb"]').trigger('click');
    await flushPromises();
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath).toHaveBeenCalledWith('D:/mock/照片-2.png');
  });

  it('拖选收尾的单击（guard 返回 true）不打开（A1 #17 同 Tk DRAG_SLOP 语义）', async () => {
    const guard = vi.fn(() => true);
    const { wrapper, openPath } = mountThumb(
      { path: 'D:/mock/照片-3.png', decoded: true, name: '照片-3.png' },
      { guard },
    );
    await wrapper.find('[data-testid="media_thumb"]').trigger('click');
    await flushPromises();
    expect(guard).toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });
});
