//! 路径 scope 白名单（docs/03 §5.2、docs/02 §2 `open_path`/`reveal_path`）。
//!
//! M-A2 基础校验：**绝对路径 → 存在性 → 附件/导出前缀**。
//! 白名单来源（运行期维护）：
//! - 已加载数据的媒体附件路径（`load_source` 结果 `messages[].media[].path`，精确文件）；
//! - 最近导出目录（`export_messages` 成功后的 out_path 父目录）与
//!   `load_data(kind=export)` 的 out_dir（前缀）。
//!
//! 不在白名单内一律 `PATH_NOT_ALLOWED`（安全拒绝，不重试）。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;

#[derive(Default)]
pub struct PathScope {
    /// 已解析附件（canonicalize 后的精确文件路径）
    media_files: HashSet<PathBuf>,
    /// 导出目录（canonicalize 后的目录前缀）
    export_roots: HashSet<PathBuf>,
}

impl PathScope {
    pub fn add_media_file(&mut self, raw: &str) {
        if let Some(c) = canonicalize_if_absolute(raw) {
            self.media_files.insert(c);
        }
    }

    pub fn add_export_root(&mut self, raw: &str) {
        if let Some(c) = canonicalize_if_absolute(raw) {
            self.export_roots.insert(c);
        }
    }

    /// 校验并返回 canonicalize 后的路径；任一检查不通过 → `PATH_NOT_ALLOWED`。
    pub fn check(&self, raw: &str) -> Result<PathBuf, AppError> {
        if raw.trim().is_empty() {
            return Err(AppError::path_not_allowed("路径为空"));
        }
        let p = Path::new(raw);
        if !p.is_absolute() {
            return Err(AppError::path_not_allowed(format!("不是绝对路径: {raw}")));
        }
        let canon = fs::canonicalize(p).map_err(|e| {
            AppError::path_not_allowed(format!("路径不存在或无法访问: {raw}（{e}）"))
        })?;
        if self.media_files.contains(&canon) {
            return Ok(canon);
        }
        for root in &self.export_roots {
            // Path::starts_with 按组件比较，避免 "C:\out" 误放行 "C:\out-evil"
            if canon.starts_with(root) {
                return Ok(canon);
            }
        }
        Err(AppError::path_not_allowed(format!(
            "不在导出目录/附件 scope 内: {raw}"
        )))
    }
}

fn canonicalize_if_absolute(raw: &str) -> Option<PathBuf> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return None;
    }
    fs::canonicalize(p).ok()
}
