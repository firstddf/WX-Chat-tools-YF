// Ipc 装配：壳内（Tauri）→ TauriIpc；普通浏览器（vite dev / 测试）→ MockIpc。
// 测试直接 new MockIpc() 并注入，不走这里（docs/02 §6）。
import { inject, type InjectionKey } from 'vue';
import { MockIpc } from './mock';
import { TauriIpc } from './tauri';
import type { Ipc } from './types';

export const IPC_KEY: InjectionKey<Ipc> = Symbol('wxchart-ipc');

export function createIpc(): Ipc {
  const hasTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  return hasTauri ? new TauriIpc() : new MockIpc();
}

export function useIpc(): Ipc {
  const ipc = inject(IPC_KEY);
  if (!ipc) throw new Error('Ipc 未提供：app.provide(IPC_KEY, createIpc())');
  return ipc;
}
