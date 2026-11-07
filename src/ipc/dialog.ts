// 保存路径选择：Tauri 壳内走 dialog 插件（用户显式选择，docs/03 §5.3）；
// 普通浏览器（dev/测试）返回建议文件名 —— 路径确定性，便于断言。
import { save } from '@tauri-apps/plugin-dialog';

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
