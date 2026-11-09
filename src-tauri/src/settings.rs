//! 应用设置（docs/07 #4 · docs/02 §2 2026-11-09 冻结）。
//!
//! - 存 `%APPDATA%\com.wxchart.app\settings.json`（`app_config_dir()`，Windows 下
//!   dev 与 release 同目录）；**白名单字段** `last_account` / `last_export_dir`；
//! - 原子写：tmp + rename（Windows rename 不覆盖 → 先删目标再换，窗口毫秒级，
//!   读侧损坏容忍兜底）；**损坏容忍**：解析失败回默认值，不抛错、不阻断启动；
//! - `settings://changed` 跨窗口事件裁剪为「预留不实现」（单窗口，docs/02 §3）。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use crate::error::AppError;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub last_account: String,
    pub last_export_dir: String,
    /// 微信数据目录（docs/07 #13 增补）：空串 = 自动发现（scan_accounts 发现顺序见 docs/02 §1.2）
    pub data_root: String,
}

impl Settings {
    /// 读设置：文件不存在/损坏一律回默认（docs/02 §2 损坏容忍）。
    pub fn load(path: &Path) -> Settings {
        match fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Settings::default(),
        }
    }

    /// 白名单合并（命令层与单测共用；校验在写盘前完成，失败不落盘）。
    /// **白名单 = docs/02 §2 的 `last_account` / `last_export_dir` / `data_root`**：
    /// 名单外键（含 `lastAccount` 这类拼写变体）→ `INTERNAL`，防静默丢失。
    pub fn apply_patch(&mut self, patch: &Value) -> Result<(), AppError> {
        let obj = patch
            .as_object()
            .ok_or_else(|| AppError::internal("set_settings 缺少 patch 对象"))?;
        for (key, val) in obj {
            let text = val
                .as_str()
                .ok_or_else(|| AppError::internal(format!("set_settings 字段必须是字符串: {key}")))?;
            match key.as_str() {
                "last_account" => self.last_account = text.to_string(),
                "last_export_dir" => self.last_export_dir = text.to_string(),
                "data_root" => self.data_root = text.to_string(),
                other => {
                    return Err(AppError::internal(format!(
                        "set_settings 字段不在白名单: {other}"
                    )))
                }
            }
        }
        Ok(())
    }

    /// 原子写（docs/07 #4）：tmp + rename；Windows 上 rename 不覆盖已存在文件，
    /// 先删目标再换——间隙毫秒级，且读侧损坏容忍兜底。
    pub fn save(&self, path: &Path) -> Result<(), AppError> {
        let text = serde_json::to_string_pretty(self)?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, text)?;
        let _ = fs::remove_file(path); // 不存在忽略
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// 设置文件路径：`<app_config_dir>/settings.json`（不存在则建目录）。
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::internal_detail("获取应用配置目录失败", e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// 读当前设置（命令与其它壳逻辑共用，如 `scan_accounts` 注入 `data_root`）。
pub fn load_for_app(app: &tauri::AppHandle) -> Result<Settings, AppError> {
    Ok(Settings::load(&settings_path(app)?))
}

/// docs/02 §2 `get_settings`：返回全量设置（缺省空串）。
#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Settings, AppError> {
    load_for_app(&app)
}

/// docs/02 §2 `set_settings`：白名单合并写入，返回合并后全量设置。
#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, patch: Value) -> Result<Settings, AppError> {
    let path = settings_path(&app)?;
    let mut settings = Settings::load(&path);
    settings.apply_patch(&patch)?; // 校验失败不落盘
    settings.save(&path)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_file(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wxchart-settings-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn missing_file_returns_defaults() {
        let p = tmp_file("missing");
        assert_eq!(Settings::load(&p), Settings::default());
        assert_eq!(Settings::default().last_account, "");
    }

    #[test]
    fn corrupt_file_returns_defaults() {
        let p = tmp_file("corrupt");
        fs::write(&p, "{oops not json").unwrap();
        assert_eq!(Settings::load(&p), Settings::default(), "损坏容忍：回默认不抛错");
    }

    #[test]
    fn save_roundtrip_and_overwrite() {
        let p = tmp_file("roundtrip");
        let mut s = Settings::default();
        s.apply_patch(&json!({"last_account": "wxid_a"})).unwrap();
        s.save(&p).unwrap();
        // 第二次保存覆盖已存在文件（Windows rename 不覆盖 → save 内先删）
        s.apply_patch(&json!({"last_export_dir": "D:\\out"})).unwrap();
        s.save(&p).unwrap();
        let back = Settings::load(&p);
        assert_eq!(back.last_account, "wxid_a");
        assert_eq!(back.last_export_dir, "D:\\out");
        assert!(!p.with_extension("json.tmp").exists(), "tmp 不应残留");
    }

    #[test]
    fn whitelist_rejects_unknown_key_and_type() {
        let mut s = Settings::default();
        // 未知键（含拼写变体 lastAccount）→ 拒绝且不写入
        let err = s.apply_patch(&json!({"lastAccount": "x"})).unwrap_err();
        assert!(err.message.contains("白名单"), "{}", err.message);
        assert_eq!(s.last_account, "");
        // 非字符串值 → 拒绝
        let err = s.apply_patch(&json!({"last_account": 123})).unwrap_err();
        assert!(err.message.contains("字符串"), "{}", err.message);
        // patch 非对象 → 拒绝
        let err = s.apply_patch(&json!("nope")).unwrap_err();
        assert!(err.message.contains("patch"), "{}", err.message);
    }

    #[test]
    fn partial_patch_merges() {
        let mut s = Settings::default();
        s.apply_patch(&json!({"last_account": "wxid_a"})).unwrap();
        s.apply_patch(&json!({"last_export_dir": "D:\\x"})).unwrap();
        s.apply_patch(&json!({"data_root": "D:\\微信数据\\xwechat_files"})).unwrap();
        assert_eq!(s.last_account, "wxid_a");
        assert_eq!(s.last_export_dir, "D:\\x");
        assert_eq!(s.data_root, "D:\\微信数据\\xwechat_files");
        // 空 patch 合并为无操作
        s.apply_patch(&json!({})).unwrap();
        assert_eq!(s.last_account, "wxid_a");
    }
}
