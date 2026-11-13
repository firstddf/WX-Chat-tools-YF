// 保存路径选择：Tauri 壳内走 dialog 插件（用户显式选择，docs/03 §5.3）；
// 普通浏览器（dev/测试）返回建议文件名 —— 路径确定性，便于断言。
import { open, save } from '@tauri-apps/plugin-dialog';

export async function pickSavePath(suggestion: string): Promise<string | null> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const ext = suggestion.split('.').pop() ?? 'json';
      const p = await save({
        defaultPath: suggestion,
        filters: [{ name: '导出文件', extensions: [ext] }],
      });
      return p ?? null;
    } catch {
      return null;
    }
  }
  return suggestion;
}

/** 目录选择（本地数据包导出 / 打开本地数据，docs/02 §2）；浏览器回固定路径便于断言。
 *  `defaultPath` = 最近使用的目录（docs/07 #2 记忆，打开时定位到上次位置）。 */
export async function pickDir(defaultPath?: string): Promise<string | null> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const p = await open({
        directory: true,
        title: '选择目录',
        ...(defaultPath ? { defaultPath } : {}),
      });
      return typeof p === 'string' ? p : null;
    } catch {
      return null;
    }
  }
  return 'C:/mock/local-data';
}

/** 打开文件选择（快递单号提取的输入 CSV，docs/07 #19）；浏览器回建议路径便于断言。 */
export async function pickOpenPath(suggestion: string): Promise<string | null> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const p = await open({
        title: '选择 CSV 文件',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
        defaultPath: suggestion,
      });
      return typeof p === 'string' ? p : null;
    } catch {
      return null;
    }
  }
  return suggestion;
}
