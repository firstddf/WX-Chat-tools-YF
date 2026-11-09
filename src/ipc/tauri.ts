// TauriIpc —— 生产实现：invoke 命令（通道①）+ 事件订阅（通道②）。
// 命令名/参数/错误形状必须与 src-tauri 壳（S5）及 docs/02 §2/§4 一致：
// Rust 侧命令返回 Result<T, AppError>，AppError 序列化为 {code, message, detail?}。
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  EVENT_PROGRESS, EVENT_SIDECAR_STATUS, PROTOCOL_VERSION,
} from './types';
import type {
  Account, AppInfo, ExportParams, ExportResult, Ipc, LoadParams, LoadResult,
  ProgressParams, ProtocolError, ResolveMediaResult, SidecarStatus,
} from './types';

/** Tauri invoke 的拒绝值要么已是 ProtocolError 形状，要么包成 INTERNAL */
function asProtocolError(e: unknown): ProtocolError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    return e as ProtocolError;
  }
  return { code: 'INTERNAL', message: '内部错误', detail: String(e) };
}

export class TauriIpc implements Ipc {
  async appInfo(): Promise<AppInfo> {
    try {
      return await invoke<AppInfo>('app_info');
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  async scanAccounts(): Promise<{ accounts: Account[] }> {
    try {
      return await invoke<{ accounts: Account[] }>('scan_accounts');
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  async loadData(params: LoadParams): Promise<LoadResult> {
    try {
      return await invoke<LoadResult>('load_data', {
        kind: params.kind,
        account: params.kind === 'store' ? (params.account ?? null) : null,
        // Tauri 把 Rust snake_case 形参映射为 camelCase 键（docs/02 §2 2026-11-09 实测注）
        outDir: params.kind === 'export' ? params.out_dir : null,
        options: params.kind === 'store' ? (params.options ?? null) : null,
      });
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  async resolveMedia(indexes: number[]): Promise<ResolveMediaResult> {
    try {
      // 参数名与壳命令逐字一致（docs/02 §2：args {indexes:number[]}，60s 超时）
      return await invoke<ResolveMediaResult>('resolve_media', { indexes });
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  async exportMessages(params: ExportParams): Promise<ExportResult> {
    try {
      return await invoke<ExportResult>('export_messages', {
        format: params.format,
        // bundle 不带 scope → null（壳 Value 收下，sidecar 校验非 null 即拒，docs/02 §1.2）
        scope: params.scope ?? null,
        outPath: params.out_path, // camelCase 键（docs/02 §2 2026-11-09 实测注）
      });
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  async openPath(path: string): Promise<{ ok: boolean }> {
    try {
      return await invoke<{ ok: boolean }>('open_path', { path });
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  async revealPath(path: string): Promise<{ ok: boolean }> {
    try {
      return await invoke<{ ok: boolean }>('reveal_path', { path });
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  onProgress(cb: (p: ProgressParams) => void): () => void {
    const un = listen<ProgressParams>(EVENT_PROGRESS, (e) => cb(e.payload));
    let alive = true;
    let off: (() => void) | null = null;
    void un.then((f) => {
      if (alive) off = f;
      else f();
    });
    return () => {
      alive = false;
      off?.();
    };
  }

  onSidecarStatus(cb: (s: SidecarStatus) => void): () => void {
    const un = listen<SidecarStatus>(EVENT_SIDECAR_STATUS, (e) => cb(e.payload));
    let alive = true;
    let off: (() => void) | null = null;
    void un.then((f) => {
      if (alive) off = f;
      else f();
    });
    return () => {
      alive = false;
      off?.();
    };
  }
}

/** 协议握手自检（壳与 sidecar 主版本一致性，app_info 之外的辅助） */
export function isCompatible(info: AppInfo): boolean {
  return info.protocol_version === PROTOCOL_VERSION;
}

/**
 * 本地文件绝对路径 → WebView 可加载的 URL（`media.path` 预览用，docs/02 §1.3）。
 *
 * 真实壳走 Tauri 2 的 asset 协议（`tauri.conf.json > app.security.assetProtocol`，
 * scope 只放行 sidecar 解码缓存目录；协议本身由 Cargo feature `protocol-asset` 启用）。
 * 普通浏览器 / MockIpc / Vitest 没有 `__TAURI_INTERNALS__`，`convertFileSrc` 不可用，
 * 直接退回原路径——mock 数据与组件测试照常得到可断言的 src，也不会抛异常。
 */
export function fileSrc(path: string): string {
  if (!path) return '';
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}
