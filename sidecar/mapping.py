# -*- coding: utf-8 -*-
"""通道③ 的协议组装与异常→错误码映射（docs/02 §1/§4）。

职责边界：
- 本模块只做「对象 → 协议 JSON」与「异常 → {code, message, detail?}」；
- NDJSON framing 与方法分发在 launcher.py；
- 数据层只读引用 ../wxchart-tool/src/wxchart（不改 Tk 仓库，见 docs/03 §1）。
"""
from __future__ import annotations

import platform
import sys
from pathlib import Path
from typing import Any

# 只读引用 Tk 仓数据层（与 launcher 同一引导，保证本模块可独立 import）
_HERE = Path(__file__).resolve().parent
_WXCHART_SRC = _HERE.parent.parent / "wxchart-tool" / "src"
if _WXCHART_SRC.is_dir() and str(_WXCHART_SRC) not in sys.path:
    sys.path.insert(0, str(_WXCHART_SRC))

from wxchart import __version__ as APP_VERSION  # noqa: E402
from wxchart import guidata  # noqa: E402
from wxchart.keys import KeyExtractError  # noqa: E402
from wxchart.sqlcipher import DecryptError  # noqa: E402

PROTOCOL_VERSION = 1

__all__ = [
    "PROTOCOL_VERSION",
    "SidecarError",
    "ping_result",
    "account_row",
    "message_json",
    "media_json",
    "load_result",
    "export_result",
    "bundle_result",
    "doctor_result",
    "to_error",
]


class SidecarError(Exception):
    """带协议错误码的异常；message 为可直接展示的中文（docs/02 §4）。"""

    def __init__(self, code: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def ping_result() -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "app_version": APP_VERSION,
        "python": platform.python_version(),
    }


def account_row(account: Any) -> dict[str, Any]:
    # nickname 暂回显 wxid（docs/02：M-A4 doctor 接 contact 显示名）
    return {
        "wxid": str(account.wxid),
        "nickname": str(account.wxid),
        "active": int(account.last_active or 0),
        "root": str(account.root),
    }


def media_json(item: Any) -> list[dict[str, Any]]:
    """FilterMessage.media → 协议 media 形状（docs/02 §1.3；load_source / resolve_media /
    导出回填共用同一序列化）。"""
    return [
        {
            "kind": m.kind,
            "name": m.name,
            "path": m.path,
            "rel_path": m.rel_path,
            "size": int(m.size or 0),
            "decoded": bool(m.decoded),
        }
        for m in item.media
    ]


def message_json(item: Any) -> dict[str, Any]:
    """FilterMessage → docs/02 §1.3 的 Message 形状（字段冻结）。"""
    return {
        "ts": int(item.ts or 0),
        "day": item.day,
        "time_text": item.time_text,
        "chat": item.chat,
        "chat_id": item.chat_id,
        "sender": item.sender,
        "sender_id": item.sender_id,
        "is_mine": bool(item.is_mine),
        "mtype": item.mtype,
        "text": item.text,
        "truncated": bool(item.truncated),
        "is_group": bool(item.is_group),
        "local_id": int(item.local_id or 0),
        "server_id": int(item.server_id or 0),
        "quote_sender": item.quote_sender,
        "quote_text": item.quote_text,
        "quote_svrid": int(item.quote_svrid or 0),
        "media": media_json(item),
        "source": item.source,
        "day_page": item.day_page,
        "chat_dir": item.chat_dir,
    }


def load_result(source: str, items: list[Any]) -> dict[str, Any]:
    """load_source 的 result（docs/02 §1.3「load_source 的 result」）。"""
    chats = guidata.chat_options(items)
    timestamps = [int(m.ts or 0) for m in items]
    nonzero = [t for t in timestamps if t]
    return {
        "source": source,
        "chats": chats,
        "messages": [message_json(m) for m in items],
        "stats": {
            "messages": len(items),
            "chats": len(chats),
            "media": sum(len(m.media) for m in items),
            "first_ts": min(nonzero) if nonzero else 0,
            "last_ts": max(nonzero) if nonzero else 0,
        },
    }


def export_result(path: Path | str, count: int) -> dict[str, Any]:
    target = Path(path)
    return {"path": str(target), "count": int(count), "bytes": target.stat().st_size}


def bundle_result(path: Path | str, report: Any) -> dict[str, Any]:
    """本地数据包（export format=bundle）的 result（docs/02 §1.2 2026-11-09 增补）。

    path=数据包根目录；count=导出报告 messages；bytes=目录总字节数（遍历求和，
    只 stat 文件——数据包可达数 GB，但文件数在数千量级，耗时可忽略）。
    """
    root = Path(path)
    total = 0
    for p in root.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:                      # 竞态删除/权限：不阻塞应答
            continue
    return {
        "path": str(root),
        "count": int(getattr(report, "messages", 0) or 0),
        "bytes": total,
    }


def doctor_result(account: Any, ks: Any, status: list[Any],
                  messages: int | None) -> dict[str, Any]:
    """doctor 自检的 result（docs/02 §1.2 2026-11-09 #3 冻结形状）。

    - ``key_sources``：KeySet 概览（mode/pid/命中数/缺密钥库），**不含任何密钥值**
      （docs/03 §5）；``missing`` 截前 8 条（同 Tk cmd_doctor 展示口径）；
    - ``dbs``：逐库解密结果（部分失败不报错，``ok=false`` 由前端逐条呈现）；
    - ``messages``：库可读时的消息总数（``load_chats`` 计数求和，Tk 同口径）；
      读不出时为 None → 序列化时省略该键。
    """
    total = len(ks.keys) + len(ks.missing)
    out: dict[str, Any] = {
        "version": APP_VERSION,
        "account": {"wxid": str(account.wxid), "root": str(account.root)},
        "key_sources": {
            "mode": str(ks.mode),
            "pid": int(ks.pid),
            "hit": len(ks.keys),
            "total": total,
            "missing": [str(m) for m in ks.missing[:8]],
        },
        "dbs": [{"name": str(s.rel), "ok": bool(s.ok)} for s in status],
    }
    if messages is not None:
        out["messages"] = int(messages)
    return out


def _exc_text(exc: BaseException, fallback: str) -> str:
    """取异常的展示文案：Tk 的异常多为 (reason, 中文message) 两参，取 message。"""
    args = getattr(exc, "args", ())
    if len(args) >= 2 and isinstance(args[1], str) and args[1]:
        return args[1]
    if args and isinstance(args[0], str) and args[0]:
        return args[0]
    return fallback


def to_error(exc: BaseException) -> dict[str, Any]:
    """异常 → docs/02 §4 的错误对象 {code, message, detail?}。"""
    if isinstance(exc, SidecarError):
        err: dict[str, Any] = {"code": exc.code, "message": exc.message}
        if exc.detail:
            err["detail"] = exc.detail
        return err
    if isinstance(exc, KeyExtractError):
        # 沿用 Tk 异常文案（前端提示策略见 docs/02 §4 KEY_NOT_FOUND 行）
        return {"code": "KEY_NOT_FOUND", "message": _exc_text(exc, "没找到密钥")}
    if isinstance(exc, DecryptError):
        return {"code": "DB_DECRYPT_FAIL", "message": _exc_text(exc, "数据库解密失败")}
    return {
        "code": "INTERNAL",
        "message": "内部错误",
        "detail": f"{type(exc).__name__}: {exc}",
    }
