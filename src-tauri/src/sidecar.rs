//! sidecar 进程管理（docs/03 §3 逐条实现；协议帧见 docs/02 §1）：
//!
//! - spawn：Windows `CREATE_NO_WINDOW` + stdin/stdout 管道；stderr 收集为日志；
//! - 启动命令：`WXCHART_SIDECAR_CMD`（按空白切分 argv）优先 → **release 找随包 sidecar
//!   exe**（`current_exe()` 同目录；NSIS 安装后为 `$INSTDIR\wxchart-data.exe`，查证见
//!   docs/03 §4）→ dev 默认 `python <manifest>/../sidecar/launcher.py`；
//! - release 注入 `WXCHART_SIDECAR_WORK_DIR`（每用户目录，见 `Inner::work_dir`），
//!   dev 保持 launcher 默认 `sidecar/.cache`；
//! - NDJSON 读线程：按 `id` 匹配挂起请求（oneshot）；无 `id` 的 `progress`
//!   帧立即转发为通道②事件 `data://progress`；
//! - 启动 5s 内 `ping` → 校验 `protocol_version == 1` → `ready`（不一致 `mismatch`）；
//! - 单请求串行（互斥锁包住 发送+等待，与 sidecar 串行语义一致）；
//!   超时：load 300s / export 900s / resolve_media 60s / 其它 10s → `SIDECAR_TIMEOUT`；
//! - 崩溃：自动重启 1 次（500ms 退避，emit `restarted`）→ 再失败 `failed`；
//! - 停止：发 `stop` → 等 EOF/2s → 仍活则 kill（防僵尸）。

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::error::AppError;
use crate::state::PathScope;

// ------------------------------------------------------------------ 常量

/// 冻结协议版本（docs/02 抬头；与 src/ipc/types.ts 的 PROTOCOL_VERSION 一致）
pub const PROTOCOL_VERSION: u32 = 1;

/// 通道②事件名（docs/02 §3）
pub const EVENT_PROGRESS: &str = "data://progress";
pub const EVENT_SIDECAR_STATUS: &str = "sidecar://status";

/// 启动握手：spawn 后 5s 内 ping 必须有应答（实测 Python 冷启 2.0–2.3s；docs/03 §3）
const STARTUP_PING_TIMEOUT: Duration = Duration::from_secs(5);
/// 其它调用（scan_accounts 等）默认超时 10s
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
/// load_source 超时 300s（docs/03 §3）。
/// 2026-11-07 实测：大账号 400+ 会话 / 3 万+ 条消息，60s 会在「读取会话全部」后
/// 仍被壳判超时（真实壳日志 detail=load_source 超时（60s））→ 放宽到 300s。
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(300);
/// resolve_media（图片懒解码）超时 60s（docs/02 §2 / docs/03 §3；前端每批 ≤32 条可见缩略图）
pub const RESOLVE_TIMEOUT: Duration = Duration::from_secs(60);
/// export 超时 900s（docs/03 §3）。
/// 2026-11-07 二轮：图片改懒解码后，export 写出前要为导出子集补齐未解码图片
/// （冷缓存全量 ≈6.9min）→ 300s 会顶穿，放宽到 900s，期间 sidecar 发 progress 通知。
pub const EXPORT_TIMEOUT: Duration = Duration::from_secs(900);
/// 崩溃重启退避 500ms（docs/03 §3）
const RESTART_BACKOFF: Duration = Duration::from_millis(500);
/// stop 后等 EOF 的上限 2s（docs/03 §3）
const STOP_WAIT: Duration = Duration::from_secs(2);
/// 等待进程（含重启窗口）出现的上限
const READY_WAIT: Duration = Duration::from_secs(5);
/// Windows 不为 sidecar 开新控制台窗口（docs/03 §3）
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 日志滚动上限 5MB × 3（docs/03 §3）
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

// ------------------------------------------------------------------ 数据形状

/// 通道② `sidecar://status` 载荷（docs/02 §3）
#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatus {
    pub state: String, // starting | ready | restarted | failed | mismatch
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
}

impl SidecarStatus {
    fn new(state: &str, detail: Option<String>, protocol_version: Option<u32>) -> Self {
        Self {
            state: state.to_string(),
            detail,
            protocol_version,
        }
    }
}

// ------------------------------------------------------------------ 进程句柄

struct Proc {
    child: Child,
    stdin: StdMutex<ChildStdin>,
    /// 代数：用于忽略旧进程读线程的迟到 EOF
    generation: u64,
}

type PendingMap = HashMap<i64, oneshot::Sender<Result<Value, AppError>>>;

struct Inner {
    app: AppHandle,
    app_name: String,
    app_version: String,
    start_cmd: Vec<String>,
    /// release 的解码缓存目录（Some 时 spawn 注入 `WXCHART_SIDECAR_WORK_DIR`；
    /// dev 为 None → launcher 默认 `sidecar/.cache`，见 docs/03 §3/§4）
    work_dir: Option<PathBuf>,

    proc: StdMutex<Option<Proc>>,
    /// id → 应答通道（读线程投递）
    pending: StdMutex<PendingMap>,
    /// 单请求串行：发送 + 等待全程持锁
    request_lock: tokio::sync::Mutex<()>,
    next_id: AtomicU64,

    status: StdMutex<SidecarStatus>,
    scope: StdMutex<PathScope>,
    generation: AtomicU64,
    restarts: AtomicU8,
    stopping: AtomicBool,
    log: StdMutex<SidecarLog>,
}

impl Inner {
    fn status(&self) -> SidecarStatus {
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn set_status(&self, state: &str, detail: Option<String>, protocol_version: Option<u32>) {
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) =
            SidecarStatus::new(state, detail, protocol_version);
    }

    fn emit_status(&self) {
        let st = self.status();
        if let Err(e) = self.app.emit(EVENT_SIDECAR_STATUS, &st) {
            // 事件名/序列化异常只记日志（前端另有 app_info 轮询兜底）
            self.log("warn", &format!("emit {EVENT_SIDECAR_STATUS} 失败: {e}"));
        }
    }

    /// stderr 结构化前缀行：落 logs/sidecar.log（5MB×3 滚动）+ 控制台
    fn log(&self, level: &str, msg: &str) {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let line = format!("[{secs}] [{level}] {msg}");
        // 不能用 println!：GUI 子系统 exe 没有可靠控制台句柄，dev 启动时 stdout 还是
        // 管道且读端可能已关闭——println! 写失败会 panic。2026-11-07 实测：这个 panic
        // 打死了 stdout/stderr 读线程与 handle_exit，日志文件也因锁毒化而静默，
        // 表现就是「sidecar 已死、壳永远以为它还 ready」。
        {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "[sidecar] {line}");
            let _ = out.flush();
        }
        // 锁毒化（上一轮 panic）也要继续写日志，否则排障信息全丢
        let mut guard = self.log.lock().unwrap_or_else(|p| p.into_inner());
        guard.write(&line);
    }

    /// 读线程按 id 投递应答；迟到/未知 id 只记日志
    fn complete(&self, id: i64, res: Result<Value, AppError>) {
        let tx = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        match tx {
            Some(tx) => {
                let _ = tx.send(res);
            }
            None => {
                self.log("warn", &format!("迟到或未知的应答 id={id}（请求可能已超时）"));
            }
        }
    }

    /// 解析一帧 stdout 协议消息（docs/02 §1.1）
    fn handle_frame(&self, line: &str) {
        let raw = line.trim_end();
        if raw.trim().is_empty() {
            return; // 空行忽略
        }
        let v: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(e) => {
                self.log("error", &format!("BAD_FRAME（应答侧解析失败）: {e}"));
                return;
            }
        };

        // 带 id 的应答帧
        if let Some(id) = v.get("id").and_then(|i| i.as_i64()) {
            if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                self.complete(id, Err(AppError::from_sidecar_error(err)));
            } else if let Some(result) = v.get("result") {
                self.complete(id, Ok(result.clone()));
            } else {
                self.complete(
                    id,
                    Err(AppError::new("BAD_FRAME", "应答帧缺少 result/error 字段")),
                );
            }
            return;
        }

        // 无 id：sidecar → 壳 通知（progress 立即转发为通道②事件）
        if v.get("method").and_then(|m| m.as_str()) == Some("progress") {
            if let Some(params) = v.get("params") {
                if let Err(e) = self.app.emit(EVENT_PROGRESS, params) {
                    self.log("warn", &format!("emit {EVENT_PROGRESS} 失败: {e}"));
                }
            }
            return;
        }

        // sidecar 无法推断 id 的 BAD_FRAME 应答（id:null）或未知帧 → 记日志
        if v.get("id").is_some() {
            if let Some(err) = v.get("error") {
                let e = AppError::from_sidecar_error(err);
                self.log("error", &format!("sidecar 无法配对的错误帧: {} {}", e.code, e.message));
                return;
            }
        }
        let snippet: String = raw.chars().take(200).collect();
        self.log("warn", &format!("忽略未知帧: {snippet}"));
    }

    /// 退出处理主体（`Arc<Self>` 接收者：重启线程需要持有自身）
    fn handle_exit(self: Arc<Self>, gen: u64) {
        let is_current = {
            let mut guard = self.proc.lock().unwrap_or_else(|p| p.into_inner());
            match guard.as_mut() {
                Some(p) if p.generation == gen => {
                    let _ = p.child.wait(); // 回收僵尸
                    *guard = None;
                    true
                }
                _ => false,
            }
        };
        if !is_current {
            return; // 旧代进程的迟到 EOF
        }
        if self.stopping.load(Ordering::SeqCst) {
            return; // 正常退出路径
        }

        self.log("warn", &format!("sidecar 进程退出（gen={gen}）"));

        // 失败所有挂起请求
        let drained: Vec<_> = {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            pending.drain().collect()
        };
        for (_, tx) in drained {
            let _ = tx.send(Err(AppError::internal("sidecar 进程意外退出")));
        }

        // 崩溃：自动重启 1 次（500ms 退避）→ 再失败 emit failed
        if self.restarts.load(Ordering::SeqCst) >= 1 {
            self.set_status("failed", Some("sidecar 进程再次退出（已自动重启过一次）".into()), None);
            self.emit_status();
            return;
        }
        self.restarts.fetch_add(1, Ordering::SeqCst);
        self.set_status(
            "starting",
            Some(format!("sidecar 崩溃，{RESTART_BACKOFF:?} 后自动重启（1/1）")),
            None,
        );
        self.emit_status();

        let inner = Arc::clone(&self);
        let spawn = thread::Builder::new()
            .name("sidecar-restart".into())
            .spawn(move || {
                thread::sleep(RESTART_BACKOFF);
                if inner.stopping.load(Ordering::SeqCst) {
                    return;
                }
                let gen = inner.generation.fetch_add(1, Ordering::SeqCst);
                match spawn_proc(&inner, gen) {
                    Ok(()) => spawn_handshake(SidecarManager(Arc::clone(&inner)), "restarted"),
                    Err(e) => {
                        inner.log("error", &format!("sidecar 重启失败: {e}"));
                        inner.set_status(
                            "failed",
                            Some(format!("sidecar 重启失败: {} {}", e.message, e.detail.unwrap_or_default())),
                            None,
                        );
                        inner.emit_status();
                    }
                }
            });
        if let Err(e) = spawn {
            self.set_status("failed", Some(format!("无法创建重启线程: {e}")), None);
            self.emit_status();
        }
    }
}

// ------------------------------------------------------------------ 日志文件

/// `logs/sidecar.log`，超 5MB 滚动为 .1/.2/.3（docs/03 §3）。
/// dev 落编译期源码树 `src-tauri/logs/`；**release 落 `$APPLOG`**
/// （Windows = `%LOCALAPPDATA%\com.wxchart.app\logs`）——编译期路径在干净机器上不存在、
/// 安装目录（Program Files）又不可写，否则 release 下日志会静默丢失。
struct SidecarLog {
    file: Option<File>,
    path: std::path::PathBuf,
}

impl SidecarLog {
    fn open(app: &AppHandle) -> Self {
        use tauri::Manager;
        let dir = if cfg!(debug_assertions) {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("logs")
        } else {
            app.path()
                .app_log_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("wxchart-logs"))
        };
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("sidecar.log");
        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        Self { file, path }
    }

    fn write(&mut self, line: &str) {
        let over = self
            .file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map(|m| m.len() >= LOG_MAX_BYTES)
            .unwrap_or(false);
        if over {
            self.rotate();
        }
        if self.file.is_none() {
            self.file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .ok();
        }
        if let Some(f) = self.file.as_mut() {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
    }

    fn rotate(&mut self) {
        self.file = None;
        let p = &self.path;
        let _ = fs::remove_file(p.with_extension("log.3"));
        let _ = fs::rename(p.with_extension("log.2"), p.with_extension("log.3"));
        let _ = fs::rename(p.with_extension("log.1"), p.with_extension("log.2"));
        let _ = fs::rename(p, p.with_extension("log.1"));
    }
}

// ------------------------------------------------------------------ 管理器

/// 对外句柄（Clone 廉价）；Tauri manage 后由命令通过 `State<SidecarManager>` 取用。
#[derive(Clone)]
pub struct SidecarManager(Arc<Inner>);

impl SidecarManager {
    /// 壳启动时调用（setup）：解析启动命令 → spawn → 异步握手（5s ping）。
    pub fn start(app: AppHandle) -> Self {
        let pkg_name = app.package_info().name.clone();
        let pkg_version = app.package_info().version.to_string();
        let start_cmd = resolve_start_cmd();
        let work_dir = release_work_dir(&app);

        let inner = Arc::new(Inner {
            app: app.clone(),
            app_name: pkg_name,
            app_version: pkg_version,
            start_cmd,
            work_dir,
            proc: StdMutex::new(None),
            pending: StdMutex::new(HashMap::new()),
            request_lock: tokio::sync::Mutex::new(()),
            next_id: AtomicU64::new(1),
            status: StdMutex::new(SidecarStatus::new("starting", None, None)),
            scope: StdMutex::new(PathScope::default()),
            generation: AtomicU64::new(0),
            restarts: AtomicU8::new(0),
            stopping: AtomicBool::new(false),
            log: StdMutex::new(SidecarLog::open(&app)),
        });

        let mgr = Self(inner);
        mgr.0.emit_status(); // state=starting（docs/02 §5 时序）
        mgr.spawn_initial();
        mgr
    }

    fn spawn_initial(&self) {
        let inner = &self.0;
        // dev 默认命令：launcher 缺失时直接 failed，避免白烧一次重启额度
        if inner.start_cmd.len() >= 2 && inner.start_cmd[1].ends_with(".py") {
            let p = Path::new(&inner.start_cmd[1]);
            if !p.is_file() {
                inner.set_status("failed", Some(format!("sidecar 启动脚本不存在: {}", p.display())), None);
                inner.emit_status();
                return;
            }
        }
        let gen = inner.generation.fetch_add(1, Ordering::SeqCst);
        match spawn_proc(inner, gen) {
            Ok(()) => spawn_handshake(self.clone(), "ready"),
            Err(e) => {
                inner.log("error", &format!("sidecar 启动失败: {e}"));
                inner.set_status(
                    "failed",
                    Some(format!("sidecar 启动失败: {}", e.detail.clone().unwrap_or_else(|| e.message.clone()))),
                    None,
                );
                inner.emit_status();
            }
        }
    }

    pub fn status(&self) -> SidecarStatus {
        self.0.status()
    }

    pub fn app_name(&self) -> String {
        self.0.app_name.clone()
    }

    pub fn app_version(&self) -> String {
        self.0.app_version.clone()
    }

    /// 串行调用通道③（互斥锁包住 发送+等待；超时 → SIDECAR_TIMEOUT）
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, AppError> {
        let _serial = self.0.request_lock.lock().await;
        self.wait_ready().await?;

        let id = self.0.next_id.fetch_add(1, Ordering::SeqCst) as i64;
        let (tx, rx) = oneshot::channel();
        self.0
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);

        let frame = serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))?;
        let write_res: std::io::Result<()> = {
            let guard = self.0.proc.lock().unwrap_or_else(|p| p.into_inner());
            match guard.as_ref() {
                Some(p) => {
                    let mut stdin = p.stdin.lock().unwrap_or_else(|e| e.into_inner());
                    stdin.write_all(format!("{frame}\n").as_bytes())?;
                    stdin.flush()
                }
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "sidecar 进程不存在",
                )),
            }
        };
        if let Err(e) = write_res {
            self.0
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            return Err(AppError::internal_detail("sidecar 请求写入失败", e.to_string()));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_closed)) => {
                // 应答通道关闭：进程退出时 on_stdout_exit 已投递错误，此处兜底
                Err(AppError::internal("sidecar 应答通道已关闭（进程退出）"))
            }
            Err(_elapsed) => {
                self.0
                    .pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err(AppError::timeout(format!(
                    "{method} 超时（{}s）",
                    timeout.as_secs()
                )))
            }
        }
    }

    /// 请求前的进程就绪检查：failed/mismatch 快速失败；重启窗口内最多等 READY_WAIT。
    async fn wait_ready(&self) -> Result<(), AppError> {
        let deadline = Instant::now() + READY_WAIT;
        loop {
            if self.0.stopping.load(Ordering::SeqCst) {
                return Err(AppError::internal("应用正在退出"));
            }
            let st = self.0.status();
            match st.state.as_str() {
                "mismatch" => {
                    let pv = st
                        .protocol_version
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "未知".into());
                    return Err(AppError::with_detail(
                        "PROTOCOL_MISMATCH",
                        format!("版本不匹配，重新安装（sidecar 协议 {pv} ≠ 壳协议 {PROTOCOL_VERSION}）"),
                        st.detail.unwrap_or_default(),
                    ));
                }
                "failed" => {
                    return Err(AppError::with_detail(
                        "SIDECAR_TIMEOUT",
                        st.detail.clone().unwrap_or_else(|| "sidecar 不可用".into()),
                        "sidecar 状态为 failed",
                    ));
                }
                _ => {}
            }
            let has_proc = self.0.proc.lock().unwrap_or_else(|p| p.into_inner()).is_some();
            if has_proc {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(AppError::timeout("等待 sidecar 进程就绪超时（5s）"));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 路径 scope 校验（docs/03 §5.2）
    pub fn check_path(&self, raw: &str) -> Result<std::path::PathBuf, AppError> {
        self.0.scope.lock().unwrap_or_else(|p| p.into_inner()).check(raw)
    }

    /// 最近导出目录 / 数据源导出目录 → scope 前缀白名单
    pub fn add_export_root(&self, dir: &str) {
        self.0
            .scope
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .add_export_root(dir);
    }

    /// 已加载数据的媒体附件路径 → scope 精确白名单（`{messages:[…]}` 形状，load_source 结果）
    pub fn register_media_from(&self, load_result: &Value) {
        let Some(messages) = load_result.get("messages").and_then(|m| m.as_array()) else {
            return;
        };
        self.register_media_array(messages);
    }

    /// `resolve_media` 结果（`{items:[{index, media:[…]}]}` 形状，docs/02 §2）→ scope 精确白名单。
    /// 懒解码新产出的 path 必须在此注册，否则前端解码后点击打开报 `PATH_NOT_ALLOWED`。
    pub fn register_media_from_items(&self, result: &Value) {
        let Some(items) = result.get("items").and_then(|i| i.as_array()) else {
            return;
        };
        self.register_media_array(items);
    }

    /// 遍历「带 `media:[{path}]` 字段的对象数组」，把非空 path 注册进 scope（两条入口共用）
    fn register_media_array(&self, list: &[Value]) {
        let mut scope = self.0.scope.lock().unwrap_or_else(|p| p.into_inner());
        for entry in list {
            let Some(media) = entry.get("media").and_then(|m| m.as_array()) else {
                continue;
            };
            for item in media {
                if let Some(p) = item.get("path").and_then(|p| p.as_str()) {
                    if !p.is_empty() {
                        scope.add_media_file(p);
                    }
                }
            }
        }
    }

    /// 壳退出（docs/03 §3）：发 stop → 等 EOF/2s → 仍活则 kill。
    /// 在 `RunEvent::Exit` 的同步上下文里执行，不依赖异步运行时。
    pub fn shutdown_blocking(&self) {
        self.0.stopping.store(true, Ordering::SeqCst);
        let proc = {
            let mut guard = self.0.proc.lock().unwrap_or_else(|p| p.into_inner());
            guard.take()
        };
        let Some(mut p) = proc else { return; };

        let id = self.0.next_id.fetch_add(1, Ordering::SeqCst);
        let frame = format!("{{\"id\":{id},\"method\":\"stop\",\"params\":{{}}}}\n");
        {
            let mut stdin = p.stdin.lock().unwrap_or_else(|e| e.into_inner());
            if stdin.write_all(frame.as_bytes()).is_ok() {
                let _ = stdin.flush();
            }
        }
        self.0.log("info", "已发送 stop，等待 sidecar 退出");

        let deadline = Instant::now() + STOP_WAIT;
        loop {
            match p.child.try_wait() {
                Ok(Some(status)) => {
                    self.0.log("info", &format!("sidecar 已退出: {status}"));
                    break;
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        self.0.log("warn", "sidecar 2s 内未退出 → kill");
                        let _ = p.child.kill();
                        let _ = p.child.wait();
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    self.0.log("error", &format!("等待 sidecar 退出失败: {e}"));
                    let _ = p.child.kill();
                    break;
                }
            }
        }
    }
}

// ------------------------------------------------------------------ 启动 / 读线程

/// 启动命令（docs/03 §3/§4），按优先级：
/// 1. `WXCHART_SIDECAR_CMD`（按空白切分 argv）——开发/排障覆盖，保留；
/// 2. **release**：随包 sidecar exe（`current_exe()` 同目录）；
/// 3. dev 默认：`python <workspace>/wxchart-tauri/sidecar/launcher.py`。
///
/// 第 2 步的落盘位置是查证过的（非猜测）：
/// - tauri-bundler 2.10.4 `nsis/mod.rs::generate_binaries_data`：externalBin 源文件名里的
///   `-<target_triple>` 会被去掉，再由 `installer.nsi` `File /oname=` 装进 `$INSTDIR`
///   → 安装后是 **`$INSTDIR\wxchart-data.exe`（无三元组后缀）**，与主 exe 同目录；
/// - tauri-build 2.7.4 `copy_binaries`：构建期按同样规则把源文件拷到 `target/<profile>/`；
/// - tauri-utils `platform.rs::resource_dir`：Windows 下 resource_dir = exe 所在目录。
///
/// dev 构建（tauri dev / cargo run）里 `target/debug/` 同样有拷来的 `wxchart-data.exe`，
/// 但第 3 步优先 python launcher——改 sidecar 不用重打 PyInstaller（docs/03 §3 约定）。
fn resolve_start_cmd() -> Vec<String> {
    if let Ok(v) = std::env::var("WXCHART_SIDECAR_CMD") {
        let parts: Vec<String> = v.split_whitespace().map(str::to_string).collect();
        if !parts.is_empty() {
            return parts;
        }
    }
    if !cfg!(debug_assertions) {
        if let Some(bundled) = find_bundled_sidecar() {
            return vec![bundled.to_string_lossy().into_owned()];
        }
    }
    // dev 默认 / release 兜底（干净机器上该路径不存在 → spawn 失败并置 failed，日志可见）
    let launcher = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("launcher.py");
    vec![
        "python".to_string(),
        launcher.to_string_lossy().into_owned(),
    ]
}

/// 随包 sidecar exe：`current_exe()` 同目录（安装版 $INSTDIR、或 target/<profile>/）。
/// onedir 的 exe 依赖同级 `_internal/`，两个都在才算可启动；候选含三元组后缀原名
/// （手工把 `src-tauri/binaries/` 拷到 exe 旁的情形）。找不到返回 None。
fn find_bundled_sidecar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let suffix = std::env::consts::EXE_SUFFIX; // Windows: ".exe"
    let arch = std::env::consts::ARCH;         // "x86_64"
    let candidates = [
        // NSIS 安装版 / tauri-build 拷贝：三元组后缀已被剥掉
        dir.join(format!("wxchart-data{suffix}")),
        // externalBin 源文件原名（三元组在）
        dir.join(format!("wxchart-data-{arch}-pc-windows-msvc{suffix}")),
        dir.join("binaries").join(format!("wxchart-data{suffix}")),
        dir.join("binaries")
            .join(format!("wxchart-data-{arch}-pc-windows-msvc{suffix}")),
    ];
    candidates
        .into_iter()
        .find(|p| p.is_file() && p.with_file_name("_internal").is_dir())
}

/// release 的 sidecar 解码缓存目录：`$APPLOCALDATA/media`
/// （Windows = `%LOCALAPPDATA%\com.wxchart.app\media`，与 tauri.conf.json assetProtocol.scope
/// 的 `$APPLOCALDATA/media/**` 指向同一路径；tauri path mod.rs 的 `$APPLOCALDATA` 解析）。
/// 安装目录可能只读/被清理，不能沿用 launcher 的 `_HERE/.cache`；
/// dev 返回 None → launcher 默认 `sidecar/.cache`（既有行为不变）。
fn release_work_dir(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    use tauri::Manager;
    let dir = app.path().app_local_data_dir().ok()?.join("media");
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

/// spawn sidecar（管道、不开新控制台窗口）并拉起 stdout/stderr 读线程。
fn spawn_proc(inner: &Arc<Inner>, gen: u64) -> Result<(), AppError> {
    let cmd = &inner.start_cmd;
    if cmd.is_empty() {
        return Err(AppError::internal("sidecar 启动命令为空"));
    }
    let mut command = Command::new(&cmd[0]);
    command
        .args(&cmd[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // release：把解码缓存指到每用户目录（`$APPLOCALDATA/media`）；用户显式设置优先
    if let Some(dir) = &inner.work_dir {
        if std::env::var_os("WXCHART_SIDECAR_WORK_DIR").is_none() {
            command.env("WXCHART_SIDECAR_WORK_DIR", dir);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| {
        AppError::internal_detail(format!("启动 sidecar 失败: {}", cmd[0]), e.to_string())
    })?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::internal("sidecar stdin 不可用"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::internal("sidecar stdout 不可用"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::internal("sidecar stderr 不可用"))?;

    {
        let mut guard = inner.proc.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(Proc {
            child,
            stdin: StdMutex::new(stdin),
            generation: gen,
        });
    }
    let work_dir_note = inner
        .work_dir
        .as_ref()
        .map(|d| format!(" work_dir={}", d.display()))
        .unwrap_or_default();
    inner.log(
        "info",
        &format!(
            "sidecar 已启动 pid={pid} gen={gen} cmd={}{work_dir_note}",
            cmd.join(" ")
        ),
    );

    if let Err(e) = start_reader(inner, gen, stdout) {
        // 读线程起不来 = 进程不可观测，回收后报错
        let dead = inner.proc.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(mut p) = dead {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
        return Err(AppError::internal_detail("无法创建 stdout 读线程", e.to_string()));
    }
    let _ = start_stderr_reader(inner, gen, stderr);
    let _ = start_watchdog(inner, gen);
    Ok(())
}

fn start_reader(
    inner: &Arc<Inner>,
    gen: u64,
    stdout: ChildStdout,
) -> std::io::Result<thread::JoinHandle<()>> {
    let inner = Arc::clone(inner);
    thread::Builder::new()
        .name(format!("sidecar-out-{gen}"))
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buf: Vec<u8> = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf);
                        inner.handle_frame(&line);
                    }
                    Err(e) => {
                        inner.log("error", &format!("stdout 读取失败: {e}"));
                        break;
                    }
                }
            }
            inner.handle_exit(gen);
        })
}

fn start_stderr_reader(
    inner: &Arc<Inner>,
    _gen: u64,
    stderr: ChildStderr,
) -> std::io::Result<thread::JoinHandle<()>> {
    let inner = Arc::clone(inner);
    thread::Builder::new()
        .name(format!("sidecar-err-{_gen}"))
        .spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buf: Vec<u8> = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf);
                        inner.log("stderr", line.trim_end());
                    }
                    Err(e) => {
                        inner.log("error", &format!("stderr 读取失败: {e}"));
                        break;
                    }
                }
            }
        })
}

/// 进程存活看门狗（2026-11-07 现场问题）：
/// 症状——python 被外部终止后 stdout EOF 有时不送达（管道写端可能被别的子进程继承：
/// WebView2 浏览器进程与我们共用句柄表），壳会一直以为 sidecar 活着，之后每次调用都
/// 撞 `等待 sidecar 进程就绪超时（5s）`，且日志里没有"进程退出"记录。
/// 这里每秒 try_wait 一次兜住漏掉的 EOF，交给 `handle_exit` 统一做「失败挂起请求 →
/// 自动重启一次 / 置 failed」。
fn start_watchdog(inner: &Arc<Inner>, gen: u64) -> std::io::Result<thread::JoinHandle<()>> {
    let inner = Arc::clone(inner);
    thread::Builder::new()
        .name(format!("sidecar-watch-{gen}"))
        .spawn(move || loop {
            thread::sleep(Duration::from_secs(1));
            let exited = {
                let mut guard = inner.proc.lock().unwrap_or_else(|p| p.into_inner());
                match guard.as_mut() {
                    Some(p) if p.generation == gen => match p.child.try_wait() {
                        Ok(Some(st)) => Some(st.to_string()),
                        _ => None,
                    },
                    _ => return, // 已换代 / 进程已被其他路径收走：本代看门狗退场
                }
            };
            if let Some(status) = exited {
                inner.log(
                    "warn",
                    &format!("看门狗发现 sidecar 已退出（gen={gen}，{status}）"),
                );
                Arc::clone(&inner).handle_exit(gen);
                return;
            }
        })
}

/// 启动握手：spawn 后 5s 内 ping → 校验 protocol_version==1 → emit ready/restarted；
/// ping 失败/超时 → emit failed；版本不一致 → emit mismatch（docs/03 §3、docs/02 §4）。
fn spawn_handshake(mgr: SidecarManager, final_state: &'static str) {
    tauri::async_runtime::spawn(async move {
        let res = mgr.call("ping", json!({}), STARTUP_PING_TIMEOUT).await;
        let inner = &mgr.0;
        match res {
            Ok(v) => {
                let pv = v.get("protocol_version").and_then(|x| x.as_u64()).map(|x| x as u32);
                if pv == Some(PROTOCOL_VERSION) {
                    inner.set_status(final_state, None, Some(PROTOCOL_VERSION));
                    inner.log(
                        "info",
                        &format!("握手成功: state={final_state} protocol_version={PROTOCOL_VERSION}"),
                    );
                } else {
                    let got = pv
                        .map(|x| x.to_string())
                        .unwrap_or_else(|| "缺失".to_string());
                    inner.set_status(
                        "mismatch",
                        Some(format!(
                            "协议主版本不一致: sidecar={got} 壳={PROTOCOL_VERSION}"
                        )),
                        pv,
                    );
                    inner.log(
                        "error",
                        &format!("握手版本不一致: sidecar={got} 壳={PROTOCOL_VERSION}"),
                    );
                }
            }
            Err(e) => {
                inner.log("error", &format!("握手 ping 失败: {e}"));
                inner.set_status(
                    "failed",
                    Some(format!(
                        "sidecar 启动 ping 失败: {}{}",
                        e.message,
                        e.detail.map(|d| format!("（{d}）")).unwrap_or_default()
                    )),
                    None,
                );
            }
        }
        inner.emit_status();
    });
}
