//! 通道①：前端 → Tauri invoke 命令（docs/02 §2）。
//! 命令名与参数名必须与 `src/ipc/tauri.ts` 逐字一致：
//! `app_info` / `scan_accounts` / `load_data{kind,account,out_dir,options}` /
//! `export_messages{format,scope,out_path,options}` / `resolve_media{indexes}` /
//! `doctor{}` / `open_path{path}` / `reveal_path{path}`。
//! 全部返回 `Result<T, AppError>`，拒绝值即前端 ProtocolError `{code,message,detail?}`。

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Manager, State};

use crate::error::AppError;
use crate::sidecar::{
    SidecarManager, SidecarStatus, DEFAULT_TIMEOUT, DOCTOR_TIMEOUT, EXPORT_TIMEOUT,
    LOAD_TIMEOUT, PROTOCOL_VERSION, RESOLVE_TIMEOUT,
};

/// `app_info` resolves（docs/02 §2）
#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: u32,
    pub sidecar: SidecarStatus,
}

/// 启动握手：返回壳侧协议版本 + sidecar 当前状态（不阻塞等待 sidecar）。
#[tauri::command]
pub async fn app_info(manager: State<'_, SidecarManager>) -> Result<AppInfo, AppError> {
    Ok(AppInfo {
        name: manager.app_name(),
        version: manager.app_version(),
        protocol_version: PROTOCOL_VERSION,
        sidecar: manager.status(),
    })
}

/// 转发通道③ `scan_accounts` → `{accounts, root, tried}`（docs/02 §1.2 2026-11-09 #13）。
/// `settings.data_root` 由**壳注入**为显式 `root`（手动设置的数据目录优先于自动发现；
/// 空串不注入 → sidecar 走发现顺序）。
#[tauri::command]
pub async fn scan_accounts(
    app: tauri::AppHandle,
    manager: State<'_, SidecarManager>,
) -> Result<Value, AppError> {
    let mut params = json!({});
    let data_root = crate::settings::load_for_app(&app)?.data_root;
    if !data_root.is_empty() {
        params["root"] = json!(data_root);
    }
    manager.call("scan_accounts", params, DEFAULT_TIMEOUT).await
}

/// `load_data` → sidecar `load_source` 透传（kind/account/out_dir/options 平铺）。
/// 全量返回 `{source,chats,messages,stats}`；期间 sidecar 的 progress 通知由
/// 读线程转发为 `data://progress` 事件。成功后维护路径 scope 白名单。
#[tauri::command]
pub async fn load_data(
    kind: String,
    account: Option<String>,
    out_dir: Option<String>,
    options: Option<Value>,
    app: tauri::AppHandle,
    manager: State<'_, SidecarManager>,
) -> Result<Value, AppError> {
    let params = match kind.as_str() {
        "store" => {
            let mut p = json!({ "kind": "store" });
            if let Some(a) = account.filter(|s| !s.is_empty()) {
                p["account"] = json!(a);
            }
            // 显式数据目录注入（#13，与 scan_accounts 同口径——否则扫到加载 NO_ACCOUNT）
            let data_root = crate::settings::load_for_app(&app)?.data_root;
            if !data_root.is_empty() {
                p["root"] = json!(data_root);
            }
            if let Some(o) = options {
                p["options"] = o;
            }
            p
        }
        "export" => {
            let d = out_dir
                .clone()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::internal("load_data 缺少 out_dir（kind=export）"))?;
            json!({ "kind": "export", "out_dir": d })
        }
        other => {
            return Err(AppError::internal(format!(
                "kind 取值非法: {other:?}（应为 store|export）"
            )));
        }
    };

    let result = manager.call("load_source", params, LOAD_TIMEOUT).await?;

    // scope 白名单维护（docs/03 §5.2）：导出目录前缀 + 已解析附件精确路径
    if kind == "export" {
        if let Some(d) = out_dir.filter(|s| !s.is_empty()) {
            manager.add_export_root(&d);
            // 数据包内图片缩略图可显示（docs/02 §2 load_data 2026-11-09 增补）
            app.asset_protocol_scope()
                .allow_directory(&d, true)
                .map_err(|e| AppError::internal_detail("数据包 asset scope 放行失败", e.to_string()))?;
        }
    }
    manager.register_media_from(&result);
    Ok(result)
}

/// `export_messages` → sidecar `export`（作用于 sidecar 内存数据，D3）。
/// `out_path` 由前端先经 `plugin:dialog|save` 取得（docs/03 §5.3）；
/// `format:"bundle"`（本地数据包，docs/02 §1.2 2026-11-09）时 scope 省略（传 null）、
/// `out_path` 为目录——成功后数据包根进 PathScope **与 asset 协议 scope**
/// （包内图片缩略图可显示）。`options` 为 2026-11-10 #14 增补的选择性/增量参数，
/// **仅 bundle 转发**（json/csv 不带，docs/02 §1.2）；result 的 `new_messages`
/// 按 §2 冻结形状改键为 `newMessages`（mode 不变）。
#[tauri::command]
pub async fn export_messages(
    format: String,
    scope: Value,
    out_path: String,
    options: Option<Value>,
    app: tauri::AppHandle,
    manager: State<'_, SidecarManager>,
) -> Result<Value, AppError> {
    if format != "json" && format != "csv" && format != "bundle" {
        return Err(AppError::internal(format!(
            "format 取值非法: {format:?}（应为 json|csv|bundle）"
        )));
    }
    if out_path.trim().is_empty() {
        return Err(AppError::internal("export 缺少 out_path"));
    }
    if !Path::new(&out_path).is_absolute() {
        return Err(AppError::internal("export 的 out_path 必须是绝对路径"));
    }
    let is_bundle = format == "bundle";
    let out_parent = Path::new(&out_path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned());

    let mut params = json!({ "format": format, "scope": scope, "out_path": out_path });
    if is_bundle {
        if let Some(o) = options {
            params["options"] = o;
        }
    }
    let mut result = manager.call("export", params, EXPORT_TIMEOUT).await?;

    if is_bundle {
        // §2 冻结形状：sidecar 回 snake_case `new_messages` → 前端 camelCase `newMessages`
        if let Some(obj) = result.as_object_mut() {
            if let Some(v) = obj.remove("new_messages") {
                obj.insert("newMessages".to_string(), v);
            }
        }
        // 数据包根（不是父目录）：PathScope 前缀 + asset 协议放行（docs/02 §2）
        manager.add_export_root(&out_path);
        app.asset_protocol_scope()
            .allow_directory(&out_path, true)
            .map_err(|e| AppError::internal_detail("数据包 asset scope 放行失败", e.to_string()))?;
    } else if let Some(parent) = out_parent {
        // 最近导出目录 → scope 白名单（docs/03 §5.2）
        manager.add_export_root(&parent);
    }
    Ok(result)
}

/// `resolve_media`（docs/02 §2）：图片**懒解码**——前端把可见缩略图的下标批转发给
/// sidecar 按需解码（通道③，60s/批；期间 progress 通知同样由读线程转发为
/// `data://progress`）。空数组直接回 `{items:[]}` 不打 IPC；成功后把新解码出的
/// path 注册进 scope 白名单，否则前端点击打开会报 `PATH_NOT_ALLOWED`。
#[tauri::command]
pub async fn resolve_media(
    indexes: Vec<i64>,
    manager: State<'_, SidecarManager>,
) -> Result<Value, AppError> {
    if indexes.is_empty() {
        return Ok(json!({ "items": [] }));
    }
    let result = manager
        .call("resolve_media", json!({ "indexes": indexes }), RESOLVE_TIMEOUT)
        .await?;
    manager.register_media_from_items(&result);
    Ok(result)
}

/// `doctor` → 转发通道③ `doctor`（数据层自检，docs/02 §1.2/§2 2026-11-09 #3）。
/// `settings.data_root` 由壳注入为 `root`（与 `scan_accounts`/`load_data` 同口径，#13）；
/// 解密全库比默认 10s 长 → 自定 30s 超时（`DOCTOR_TIMEOUT`）。
#[tauri::command]
pub async fn doctor(
    app: tauri::AppHandle,
    manager: State<'_, SidecarManager>,
) -> Result<Value, AppError> {
    let mut params = json!({});
    let data_root = crate::settings::load_for_app(&app)?.data_root;
    if !data_root.is_empty() {
        params["root"] = json!(data_root);
    }
    manager.call("doctor", params, DOCTOR_TIMEOUT).await
}

/// 打开路径（opener 插件）；路径必须在导出目录/附件 scope 内，否则 `PATH_NOT_ALLOWED`。
#[tauri::command]
pub async fn open_path(path: String, manager: State<'_, SidecarManager>) -> Result<Value, AppError> {
    let p = manager.check_path(&path)?;
    tauri_plugin_opener::open_path(p.to_string_lossy().into_owned(), None::<String>)
        .map_err(|e| AppError::internal_detail("打开路径失败", e.to_string()))?;
    Ok(json!({ "ok": true }))
}

/// 在资源管理器中定位（选中）文件；scope 校验同 `open_path`。
#[tauri::command]
pub async fn reveal_path(
    path: String,
    manager: State<'_, SidecarManager>,
) -> Result<Value, AppError> {
    let p = manager.check_path(&path)?;
    tauri_plugin_opener::reveal_item_in_dir(&p)
        .map_err(|e| AppError::internal_detail("在资源管理器中定位失败", e.to_string()))?;
    Ok(json!({ "ok": true }))
}
