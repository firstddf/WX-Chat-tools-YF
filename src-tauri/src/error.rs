//! 统一错误对象（docs/02 §4）：`{code, message, detail?}`。
//! invoke 的拒绝值即前端 ProtocolError —— Serialize 后的形状必须逐字一致。

use serde::Serialize;

/// 统一应用错误。`code` 取值集合与 `src/ipc/types.ts` 的 `ErrorCode` 一致：
/// NO_ACCOUNT / ACCOUNT_NOT_FOUND / KEY_NOT_FOUND / DB_DECRYPT_FAIL /
/// SOURCE_UNAVAILABLE / EXPORTING_BUSY / EXPORT_FAILED / PATH_NOT_ALLOWED /
/// SIDECAR_TIMEOUT / PROTOCOL_MISMATCH / BAD_FRAME / INTERNAL
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    /// 可直接展示的中文（沿用 Tk 版文案）
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(code: &str, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            detail: Some(detail.into()),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }

    pub fn internal_detail(message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::with_detail("INTERNAL", message, detail)
    }

    /// 调用超时 / sidecar 不可用（docs/02 §4：ping/调用超时）
    pub fn timeout(detail: impl Into<String>) -> Self {
        Self::with_detail("SIDECAR_TIMEOUT", "sidecar 调用超时", detail)
    }

    /// 路径不在导出目录/附件 scope（docs/02 §4：安全拒绝，不重试）
    pub fn path_not_allowed(detail: impl Into<String>) -> Self {
        Self::with_detail("PATH_NOT_ALLOWED", "路径不在允许范围内", detail)
    }

    /// sidecar 应答帧的 error 对象直接映射（code/message/detail 均来自协议层）
    pub fn from_sidecar_error(err: &serde_json::Value) -> Self {
        let code = err
            .get("code")
            .and_then(|c| c.as_str())
            .unwrap_or("INTERNAL")
            .to_string();
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("sidecar 调用失败")
            .to_string();
        let detail = err
            .get("detail")
            .and_then(|d| d.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        Self {
            code,
            message,
            detail,
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)?;
        if let Some(d) = &self.detail {
            write!(f, "（{d}）")?;
        }
        Ok(())
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::internal_detail("IO 错误", e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::internal_detail("JSON 序列化/解析失败", e.to_string())
    }
}
