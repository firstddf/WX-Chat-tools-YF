// TauriIpc —— 生产实现：invoke 命令（通道①）+ 事件订阅（通道②）。
// 命令名/参数/错误形状必须与 src-tauri 壳（S5）及 docs/02 §2/§4 一致：
// Rust 侧命令返回 Result<T, AppError>，AppError 序列化为 {code, message, detail?}。
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  EVENT_PROGRESS, EVENT_SIDECAR_STATUS, PROTOCOL_VERSION,
} from './types';
import type {
  AppInfo, AppSettings, DoctorResult, ExportParams, ExportResult, ExtractTrackingParams,
  ExtractTrackingResult, Ipc, LoadParams, LoadResult, ProgressParams, ProtocolError,
  ResolveMediaResult, ScanAccountsResult, SidecarStatus,
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

  async scanAccounts(): Promise<ScanAccountsResult> {
    try {
      // root 由壳从 settings.data_root 注入（#13），前端不传参
      return await invoke<ScanAccountsResult>('scan_accounts');
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
        // 选择性/增量参数（#14，docs/02 §1.2）：仅 bundle 传，壳只在 bundle 时转发
        options: params.format === 'bundle' ? (params.options ?? null) : null,
      });
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  async doctor(): Promise<DoctorResult> {
    try {
      // root 由壳从 settings.data_root 注入（#13 同口径），前端不传参
      return await invoke<DoctorResult>('doctor');
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  async extractTracking(params: ExtractTrackingParams): Promise<ExtractTrackingResult> {
    try {
      // 键 camelCase（docs/02 §2 注）；apiKey 仅联网且用户填写时非空
      return await invoke<ExtractTrackingResult>('extract_tracking', {
        mode: params.mode,
        inPath: params.in_path,
        oldPath: params.old_path ?? null,
        outPath: params.out_path ?? null,
        network: params.network ?? false,
        apiKey: params.api_key ?? null,
        audit: params.audit ?? true,
        resume: params.resume ?? true,
        force: params.force ?? false,
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

  async getSettings(): Promise<AppSettings> {
    try {
      return await invoke<AppSettings>('get_settings');
    } catch (e) {
      throw asProtocolError(e);
    }
  }

  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    try {
      return await invoke<AppSettings>('set_settings', { patch });
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
