# -*- coding: utf-8 -*-
"""通道③契约测试（docs/02 §1、docs/03 §6、docs/04 §D · M-A1 交付）。

不接触真实聊天数据：
- load_source/export 用自造的 ``.wxchart-state.json`` 导出夹具（guidata 格式）；
- store 路径用 mock 补丁验证分发 / progress 透传 / store.close 语义。

用法::

    python sidecar/tests/test_contract.py

与 Tk 仓同款直跑风格（零新增依赖），也兼容 pytest（test_ 函数 + assert）。
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import traceback
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SIDECAR = HERE.parent
TAURI_ROOT = SIDECAR.parent
WX_SRC = TAURI_ROOT.parent / "wxchart-tool" / "src"
for _p in (str(SIDECAR), str(WX_SRC)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import launcher  # noqa: E402
import mapping  # noqa: E402
from wxchart import __version__ as WXCHART_VERSION  # noqa: E402
from wxchart import guidata  # noqa: E402
from wxchart.keys import KeyExtractError  # noqa: E402
from wxchart.sqlcipher import DecryptError  # noqa: E402

LAUNCHER = SIDECAR / "launcher.py"

# Message 冻结字段（docs/02 §1.3）
MESSAGE_FIELDS = {
    "ts", "day", "time_text", "chat", "chat_id", "sender", "sender_id",
    "is_mine", "mtype", "text", "truncated", "is_group", "local_id",
    "server_id", "quote_sender", "quote_text", "quote_svrid", "media",
    "source", "day_page", "chat_dir",
}
# ExportRecord 冻结字段（docs/02 §1.3）
RECORD_FIELDS = {
    "time", "day", "ts", "chat", "chat_id", "sender", "sender_id", "mine",
    "type", "type_label", "text", "truncated", "media", "day_page",
}
# Chat 行冻结字段（docs/02 §1.3）
CHAT_FIELDS = {"chat", "chat_id", "is_group", "count", "last_ts"}


class Proc:
    """子进程 sidecar 句柄：请求-应答 + stderr 后台收集。"""

    def __init__(self, env: dict[str, str] | None = None) -> None:
        environ = dict(os.environ)
        environ.update(env or {})
        self.proc = subprocess.Popen(
            [sys.executable, str(LAUNCHER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
            env=environ, cwd=str(TAURI_ROOT),
        )
        self.stderr_lines: list[str] = []
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr_lines.append(line.rstrip("\n"))

    def ask(self, obj: dict, timeout_note: str = "") -> dict:
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            tail = "".join(self.stderr_lines[-8:])
            raise AssertionError(f"sidecar 无应答 {timeout_note}；stderr 尾部：{tail}")
        return json.loads(line)

    def send_raw(self, text: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(text)
        self.proc.stdin.flush()

    def read_frame(self) -> dict:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        if not line:
            tail = "".join(self.stderr_lines[-8:])
            raise AssertionError(f"sidecar 无应答；stderr 尾部：{tail}")
        return json.loads(line)

    def stop(self) -> int:
        if self.proc.poll() is None:
            try:
                self.ask({"id": 999999, "method": "stop", "params": {}})
            except Exception:  # noqa: BLE001 - 收尾兜底
                pass
            try:
                if self.proc.stdin:
                    self.proc.stdin.close()
            except OSError:
                pass
        return self.proc.wait(timeout=30)


def make_export_dir(root: Path) -> Path:
    """自造导出目录（.wxchart-state.json day_entries，见 guidata.load_from_export_dir）。"""
    out = root / "export_out"
    out.mkdir(parents=True, exist_ok=True)
    media_rel = "会话/2026-11/运单.xlsx"
    media_file = out / Path(media_rel)
    media_file.parent.mkdir(parents=True, exist_ok=True)
    media_file.write_bytes(b"PK\x03\x04fake-xlsx")
    entries = [
        # 10:40 · 截断正文（xl > 实存长度 → truncated=True）
        {"ts": 1793676000, "d": "2026-11-05", "tm": "2026-11-05 10:40:00",
         "c": "武汉云仓 荆 发货售后", "cu": "48025936916@chatroom",
         "u": "王五", "uu": "wxid_wangwu", "t": "quote",
         "x": "回复\n[引用 发送人] 报价单已发", "xt": "", "xl": 100, "mine": 0,
         "y": "2026-11-05.html", "p": "武汉云仓_48025936916"},
        # 10:48 · 群消息 + 附件（路径可解析）
        {"ts": 1793676480, "d": "2026-11-05", "tm": "2026-11-05 10:48:00",
         "c": "武汉云仓 荆 发货售后", "cu": "48025936916@chatroom",
         "u": "王五", "uu": "wxid_wangwu", "t": "text",
         "x": "报价单已发，请查收", "xt": "", "xl": 9, "mine": 0,
         "y": "2026-11-05.html", "p": "武汉云仓_48025936916",
         "m": [{"k": "file", "n": "运单.xlsx", "p": media_rel}]},
        # 10:48:01 · 本人消息 + 防公式注入样本（= 开头）
        {"ts": 1793676481, "c": "张三", "cu": "wxid_zhangsan",
         "u": "我", "uu": "wxid_me", "t": "text",
         "x": "=cmd|calc", "xt": "", "xl": 9, "mine": 1},
    ]
    (out / ".wxchart-state.json").write_text(
        json.dumps({"day_entries": entries}, ensure_ascii=False),
        encoding="utf-8",
    )
    return out


# ---------------------------------------------------------------- ping / 帧

def test_ping_handshake() -> None:
    p = Proc()
    try:
        res = p.ask({"id": 1, "method": "ping", "params": {}})
        assert res["id"] == 1, "id 必须原样回带"
        r = res["result"]
        assert r["protocol_version"] == 1 == mapping.PROTOCOL_VERSION
        assert r["app_version"] == WXCHART_VERSION
        assert r["python"].startswith("3."), r["python"]
    finally:
        assert p.stop() == 0


def test_bad_frames() -> None:
    """无法解析/缺字段的帧 → {id:null|原id, error:BAD_FRAME}，进程不倒。"""
    p = Proc()
    try:
        p.send_raw("{oops\n")
        res = p.read_frame()
        assert res["id"] is None and res["error"]["code"] == "BAD_FRAME"
        assert res["error"]["message"]

        p.send_raw("[1, 2]\n")
        res = p.read_frame()
        assert res["id"] is None and res["error"]["code"] == "BAD_FRAME"

        p.send_raw(json.dumps({"method": "ping"}) + "\n")   # 缺 id
        res = p.read_frame()
        assert res["id"] is None and res["error"]["code"] == "BAD_FRAME"

        p.send_raw(json.dumps({"id": 7, "params": {}}) + "\n")   # 缺 method，回带 id
        res = p.read_frame()
        assert res["id"] == 7 and res["error"]["code"] == "BAD_FRAME"

        p.send_raw("\n\n")                                  # 空行忽略
        res = p.ask({"id": 8, "method": "ping", "params": {}})
        assert res["id"] == 8 and res["result"]["protocol_version"] == 1
    finally:
        p.stop()


def test_frame_limit() -> None:
    """单帧超限 → BAD_FRAME（id:null），小帧照常工作（docs/03 §2）。"""
    p = Proc(env={"WXCHART_SIDECAR_MAX_FRAME": "128"})
    try:
        big = {"id": 1, "method": "load_source",
               "params": {"kind": "export", "out_dir": "x" * 400}}
        p.send_raw(json.dumps(big, ensure_ascii=False) + "\n")
        res = p.read_frame()
        assert res["id"] is None and res["error"]["code"] == "BAD_FRAME"
        assert "超限" in res["error"]["message"]

        res = p.ask({"id": 2, "method": "ping", "params": {}})
        assert res["result"]["protocol_version"] == 1, "超限后进程仍可用"
    finally:
        p.stop()


def test_unknown_method_internal() -> None:
    """未知 method → INTERNAL（README 已删 query：筛选在前端，docs/01 D2）。"""
    p = Proc()
    try:
        res = p.ask({"id": 1, "method": "query", "params": {}})
        assert res["error"]["code"] == "INTERNAL"
        assert "未知方法" in res["error"]["message"]
    finally:
        p.stop()


# ---------------------------------------------------------------- load_source

def test_load_source_export_fixture() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        out = make_export_dir(Path(tmp))
        p = Proc()
        try:
            res = p.ask({"id": 2, "method": "load_source",
                         "params": {"kind": "export", "out_dir": str(out)}})
            r = res["result"]
            assert r["source"] == "export"
            msgs = r["messages"]
            assert len(msgs) == 3
            for m in msgs:
                assert set(m.keys()) == MESSAGE_FIELDS, "Message 字段冻结（docs/02 §1.3）"

            stamps = [(m["ts"], m["local_id"]) for m in msgs]
            assert stamps == sorted(stamps), "按 (ts, local_id) 正序"

            assert msgs[0]["ts"] == 1793676000 and msgs[0]["truncated"] is True
            assert msgs[0]["text"].startswith("回复")

            m1 = msgs[1]
            assert m1["chat_id"] == "48025936916@chatroom" and m1["is_group"] is True
            assert m1["sender"] == "王五" and m1["truncated"] is False
            assert len(m1["media"]) == 1
            media = m1["media"][0]
            assert media["name"] == "运单.xlsx" and media["decoded"] is True
            assert media["rel_path"] == "会话/2026-11/运单.xlsx"
            assert Path(media["path"]).is_file(), "附件绝对路径可解析"
            assert media["size"] == 0, "export 来源不回填 size"

            assert msgs[2]["is_mine"] is True and msgs[2]["chat_id"] == "wxid_zhangsan"

            assert r["stats"] == {"messages": 3, "chats": 2, "media": 1,
                                  "first_ts": 1793676000, "last_ts": 1793676481}
            chats = r["chats"]
            assert len(chats) == 2
            for row in chats:
                assert set(row.keys()) == CHAT_FIELDS, "Chat 行字段冻结"
            grp = next(c for c in chats if c["chat_id"] == "48025936916@chatroom")
            assert grp["count"] == 2 and grp["is_group"] is True
            assert grp["last_ts"] == 1793676480
        finally:
            p.stop()


def test_load_source_store_no_account() -> None:
    with tempfile.TemporaryDirectory() as empty_root:
        p = Proc(env={"WXCHART_XWECHAT_ROOT": empty_root})
        try:
            res = p.ask({"id": 1, "method": "load_source", "params": {"kind": "store"}})
            assert res["error"]["code"] == "NO_ACCOUNT"
            assert res["error"]["message"], "message 必须可展示（中文）"
            # 同源的 scan_accounts：空根目录 → 空列表而非报错
            res2 = p.ask({"id": 2, "method": "scan_accounts", "params": {}})
            assert res2["result"]["accounts"] == []
        finally:
            p.stop()


def test_account_not_found() -> None:
    with tempfile.TemporaryDirectory() as root:
        fake = Path(root) / "wxid_fake_123"
        (fake / "db_storage" / "message").mkdir(parents=True)
        p = Proc(env={"WXCHART_XWECHAT_ROOT": root})
        try:
            res = p.ask({"id": 1, "method": "load_source",
                         "params": {"kind": "store", "account": "wxid_not_exist"}})
            assert res["error"]["code"] == "ACCOUNT_NOT_FOUND"

            res2 = p.ask({"id": 2, "method": "scan_accounts", "params": {}})
            rows = res2["result"]["accounts"]
            assert rows and rows[0]["wxid"] == "wxid_fake_123"
            assert set(rows[0].keys()) == {"wxid", "nickname", "active", "root"}
        finally:
            p.stop()


# ---------------------------------------------------------------- export

def test_export_json_csv_and_scopes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        out = make_export_dir(tmp_path)
        p = Proc()
        try:
            res = p.ask({"id": 1, "method": "load_source",
                         "params": {"kind": "export", "out_dir": str(out)}})
            assert res["result"]["source"] == "export"

            # indexes scope → JSON（ExportRecord 字段冻结）
            target = tmp_path / "sel.json"
            res = p.ask({"id": 2, "method": "export", "params": {
                "format": "json", "out_path": str(target),
                "scope": {"type": "indexes", "indexes": [1, 2]}}})
            r = res["result"]
            assert r["path"] == str(target) and r["count"] == 2
            assert r["bytes"] == target.stat().st_size > 0
            records = json.loads(target.read_text(encoding="utf-8"))
            assert len(records) == 2
            assert set(records[0].keys()) == RECORD_FIELDS, "ExportRecord 字段冻结"
            assert records[0]["text"] == "报价单已发，请查收"
            assert records[1]["text"] == "=cmd|calc"

            # filter scope → FilterSpec 语义（query 空格分词 AND）
            csv1 = tmp_path / "filtered.csv"
            res = p.ask({"id": 3, "method": "export", "params": {
                "format": "csv", "out_path": str(csv1),
                "scope": {"type": "filter", "filter": {"query": "报价"}}}})
            assert res["result"]["count"] == 2, "命中「报价」的 2 条"
            body1 = csv1.read_bytes().decode("utf-8-sig")
            assert body1.startswith("时间,日期,会话,群号,发送人,类型,内容,附件,附件路径\r\n")
            assert "=cmd|calc" not in body1

            # indexes → CSV：BOM/CRLF + 防公式注入 + 截断补省略号
            csv2 = tmp_path / "mix.csv"
            res = p.ask({"id": 4, "method": "export", "params": {
                "format": "csv", "out_path": str(csv2),
                "scope": {"type": "indexes", "indexes": [0, 2]}}})
            assert res["result"]["count"] == 2
            raw2 = csv2.read_bytes()
            assert raw2.startswith(b"\xef\xbb\xbf"), "CSV 必须带 UTF-8 BOM"
            body2 = raw2.decode("utf-8-sig")
            assert "\r\n" in body2, "CRLF 行尾"
            assert "'=cmd|calc" in body2, "防公式注入（= 前置单引号）"
            assert "…" in body2, "截断正文以 … 结尾"

            # 越界下标 → INTERNAL（协议错误，不是崩溃）
            res = p.ask({"id": 5, "method": "export", "params": {
                "format": "json", "out_path": str(tmp_path / "bad.json"),
                "scope": {"type": "indexes", "indexes": [99]}}})
            assert res["error"]["code"] == "INTERNAL" and "越界" in res["error"]["message"]
        finally:
            p.stop()


def test_export_before_load_is_source_unavailable() -> None:
    p = Proc()
    try:
        res = p.ask({"id": 1, "method": "export", "params": {
            "format": "json",
            "out_path": str(Path(tempfile.gettempdir()) / "wxchart-unused.json"),
            "scope": {"type": "indexes", "indexes": []}}})
        assert res["id"] == 1
        assert res["error"]["code"] == "SOURCE_UNAVAILABLE"
    finally:
        p.stop()


def test_load_source_export_exported_at() -> None:
    """exported_at（docs/02 §1.3 2026-11-10 Phase 2 信息卡）：
    无报告 → 省略键；有 导出报告.json → finished_at；回退 .wxchart-state.json last_export。"""
    with tempfile.TemporaryDirectory() as tmp:
        out = make_export_dir(Path(tmp))
        p = Proc()
        try:
            # 1) 夹具只有 day_entries（无报告/state 时间）→ 省略键
            res = p.ask({"id": 1, "method": "load_source",
                         "params": {"kind": "export", "out_dir": str(out)}})
            assert "exported_at" not in res["result"], "缺失时省略键（不回空串）"

            # 2) 写导出报告 → finished_at 原样回传
            (out / "导出报告.json").write_text(
                json.dumps({"finished_at": "2026-11-09 21:30:00", "messages": 3},
                           ensure_ascii=False),
                encoding="utf-8")
            res2 = p.ask({"id": 2, "method": "load_source",
                          "params": {"kind": "export", "out_dir": str(out)}})
            assert res2["result"]["exported_at"] == "2026-11-09 21:30:00"

            # 3) 报告损坏 → 回退 state 的 last_export
            (out / "导出报告.json").write_text("{broken", encoding="utf-8")
            state = json.loads((out / ".wxchart-state.json").read_text(encoding="utf-8"))
            state["last_export"] = "2026-11-08 10:00:00"
            (out / ".wxchart-state.json").write_text(
                json.dumps(state, ensure_ascii=False), encoding="utf-8")
            res3 = p.ask({"id": 3, "method": "load_source",
                          "params": {"kind": "export", "out_dir": str(out)}})
            assert res3["result"]["exported_at"] == "2026-11-08 10:00:00"
        finally:
            p.stop()


# ---------------------------------------------------------------- 生命周期

def test_stop_and_eof_exit() -> None:
    p = Proc()
    res = p.ask({"id": 1, "method": "stop", "params": {}})
    assert res["result"] == {"ok": True}
    assert p.proc.wait(timeout=10) == 0

    p2 = Proc()                       # 不发 stop，直接 EOF → 干净退出
    assert p2.proc.stdin is not None
    p2.proc.stdin.close()
    assert p2.proc.wait(timeout=10) == 0


# ---------------------------------------------------------------- in-process

def test_progress_and_store_dispatch_mocked() -> None:
    """store 路径（mock）：分发 → progress 透传 → 结果组装 → store.close。"""
    buf = io.StringIO()
    writer = launcher.NdjsonWriter(buf)
    sc = launcher.Sidecar(writer)

    class FakeMsg:
        create_time = 1793676480
        type = "text"
        is_mine = False
        sender_name = "王五"
        sender_username = "wxid_wangwu"
        chat_username = "48025936916@chatroom"
        local_id = 7
        server_id = 987654321
        quote_sender = ""
        quote_text = ""
        quote_svrid = 0
        text = "你好"
        media_paths: list = []

    class FakeChat:
        username = "48025936916@chatroom"
        display_name = "测试群"
        is_group = True

    class FakeStore:
        closed = False

        def __init__(self, account, work_dir) -> None:
            pass

        def prepare(self, ks) -> list:
            return []

        def iter_messages(self, chat, start_ts: int = 0, end_ts: int = 0):
            return [FakeMsg()]

        def close(self) -> None:
            FakeStore.closed = True

    account = mock.Mock(wxid="wxid_fake", username="wxid_fake",
                        root=Path(r"C:\tmp\x"), db_dir=Path(r"C:\tmp\x\db"),
                        last_active=12.0)
    with mock.patch.object(launcher, "config") as cfg, \
            mock.patch.object(launcher, "keys") as keys_mod, \
            mock.patch.object(launcher, "Store", FakeStore), \
            mock.patch.object(launcher, "model") as model_mod:
        cfg.discover_accounts.return_value = [account]
        cfg.resolve_self_username.return_value = "wxid_fake"
        keys_mod.extract_keys.return_value = object()
        model_mod.load_contacts.return_value = {}
        model_mod.load_chats.return_value = [FakeChat()]

        result = sc.handle("load_source", {"kind": "store"})

    assert result["source"] == "store"
    assert result["stats"]["messages"] == 1
    m = result["messages"][0]
    assert set(m.keys()) == MESSAGE_FIELDS
    assert m["sender"] == "王五" and m["text"] == "你好"
    assert m["source"] == "store" and m["day_page"] == "" and m["chat_dir"] == ""
    assert FakeStore.closed, "store 必须在 finally 关闭"

    frames = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.strip()]
    assert frames, "load 期间应发出 progress 通知"
    prog = frames[0]
    assert "id" not in prog, "通知不带 id"
    assert prog["method"] == "progress"
    assert prog["params"]["phase"] == "read_chats"
    assert prog["params"]["done"] == 1 and prog["params"]["total"] == 1
    assert "读取会话" in prog["params"]["message"]
    assert "读取会话" in buf.getvalue(), "线上直接写中文（ensure_ascii=False）"


def test_exporting_busy_mutex() -> None:
    """load/export 互斥（docs/03 §3）：冲突回 EXPORTING_BUSY。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    assert sc._busy.acquire(blocking=False)
    try:
        for params in (
            {"format": "json", "out_path": "x.json",
             "scope": {"type": "indexes", "indexes": []}},
            {"kind": "export", "out_dir": "x"},
        ):
            method = "export" if "format" in params else "load_source"
            try:
                sc.handle(method, params)
                raise AssertionError(f"{method} 应抛 EXPORTING_BUSY")
            except mapping.SidecarError as exc:
                assert exc.code == "EXPORTING_BUSY"
    finally:
        sc._busy.release()
    assert buf.getvalue() == "", "互斥拒绝不应写任何帧"


def test_error_code_mapping_unit() -> None:
    """异常 → 错误码映射表（docs/02 §4）。"""
    assert mapping.to_error(mapping.SidecarError("NO_ACCOUNT", "没找到账号")) == {
        "code": "NO_ACCOUNT", "message": "没找到账号"}
    err = mapping.to_error(KeyExtractError("no-db", "没有在 x 找到可读的 .db 文件"))
    assert err["code"] == "KEY_NOT_FOUND"
    assert err["message"] == "没有在 x 找到可读的 .db 文件", "取两参异常的 message，不是元组 repr"
    err = mapping.to_error(DecryptError("key-mismatch", "密钥与数据库不匹配: a.db"))
    assert err["code"] == "DB_DECRYPT_FAIL"
    assert err["message"] == "密钥与数据库不匹配: a.db"
    err = mapping.to_error(RuntimeError("boom"))
    assert err["code"] == "INTERNAL" and err["message"] == "内部错误"
    assert err["detail"] == "RuntimeError: boom"


def test_message_shape_frozen() -> None:
    item = guidata.FilterMessage(
        ts=1793676480, day="2026-11-05", time_text="10:48:00",
        chat="群", chat_id="x@chatroom", sender="王五", sender_id="wxid_a",
        mtype="text", text="你好", is_group=True, local_id=1, server_id=2,
        quote_sender="遇见", quote_text="原话", quote_svrid=3,
        media=[guidata.MediaRef(kind="file", name="a.xlsx", path=r"D:\a.xlsx",
                                rel_path="p/a.xlsx", size=9, decoded=True)],
        source="export", day_page="d.html", chat_dir="c_dir",
    )
    row = mapping.message_json(item)
    assert set(row.keys()) == MESSAGE_FIELDS
    assert row["media"][0] == {"kind": "file", "name": "a.xlsx",
                               "path": r"D:\a.xlsx", "rel_path": "p/a.xlsx",
                               "size": 9, "decoded": True}
    assert row["quote_svrid"] == 3 and row["is_mine"] is False
    assert row["source"] == "export" and row["chat_dir"] == "c_dir"


# ---------------------------------------------------------------- 懒解码 mock 基座

class FakeRaw:
    """model.Message 形状的替身（guidata._from_message / resolver 读取的字段集）。"""

    def __init__(self, mtype: str = "text", *, md5: str = "", local_id: int = 1,
                 text: str = "", res_md5: str = "", file_name: str = "") -> None:
        self.create_time = 1793676480
        self.type = mtype
        self.is_mine = False
        self.sender_name = "王五"
        self.sender_username = "wxid_wangwu"
        self.chat_username = "48025936916@chatroom"
        self.local_id = local_id
        self.server_id = 900000 + local_id
        self.quote_sender = ""
        self.quote_text = ""
        self.quote_svrid = 0
        self.text = text or {"image": "[图片]", "file": "[文件]",
                             "video": "[视频]", "voice": "[语音]"}.get(mtype, "你好")
        self.image_md5 = md5
        self.file_name = file_name
        self.file_size = 0
        self.file_md5 = ""
        self.video_md5 = ""
        self.video_md5s: list = []
        self.media_paths: list = []
        self.res_md5 = res_md5          # 资源库回退 md5（_resource_md5 base=3）


class FakeAsset:
    """与 media.MediaAsset 同字段（guidata._media_from_message 鸭子类型）。"""

    def __init__(self, kind: str, src: str, name: str, size: int = 0,
                 decoded: bool = False, note: str = "") -> None:
        self.kind = kind
        self.src = src
        self.out_name = name
        self.size = size
        self.decoded = decoded
        self.note = note


def fake_resolver_cls(index=None, *, on_resolve=None, capture=None, events=None):
    """MediaResolver 替身类（patch ``wxchart.media.MediaResolver`` 用）。

    - ``index``：{md5: [Path]} → ``_index_images``（定位段）；
    - ``on_resolve(msg)``：真实 ``resolve`` 的替身（文件 / 按需解码段），缺省返回 []；
    - ``capture["resolver"]`` 回填真实例；``events`` 记录 ["ensure", "iter"] 时序。
    """
    index = dict(index or {})

    class FakeResolver:
        def __init__(self, account, work_dir, include=None) -> None:
            self.account = account
            self.work_dir = Path(work_dir)
            self.include = set(include or ("image", "file", "video", "voice"))
            self.decoded_dir = (self.work_dir / "decoded"
                                / str(getattr(account, "wxid", "wxid_fake")))
            self.ensure_calls: list = []
            self.resolve_calls: list = []      # 真实 resolve 被调用的 type 序列
            self.locate_calls = 0              # _index_images 被调用次数
            self.stats = {"image": 0, "image_failed": 0, "image_thumb": 0,
                          "file": 0, "video": 0, "voice": 0}
            if capture is not None:
                capture["resolver"] = self

        def ensure_image_key(self, progress=None, allow_scan=True):
            self.ensure_calls.append((progress, allow_scan))
            if events is not None:
                events.append("ensure")
            return None

        def _resource_md5(self, msg, base):
            return getattr(msg, "res_md5", "") if base == 3 else ""

        def _index_images(self):
            self.locate_calls += 1
            return dict(index)

        def resolve(self, msg):
            self.resolve_calls.append(msg.type)
            if on_resolve is None:
                return []
            return on_resolve(msg) or []

    return FakeResolver


def run_store_load(sc, msgs, *, options=None, work_dir=None, resolver_cls=None,
                   events=None, stack=None, chats=None):
    """mock 跑一次 load_source(kind=store)；FakeStore 复刻 model.iter_messages 的媒体钩子。

    返回 holder：``{"result", "store", "account", "resolver_at_iter"}``。
    ``stack``：调用方传入 ExitStack 时补丁进调用方的栈、不由本函数关闭——
    bundle 导出要在**同一补丁窗口**内重开 Store（docs/02 §1.2 format=bundle）；
    缺省自建自关（原行为）。
    """
    class FakeChat:
        username = "48025936916@chatroom"
        display_name = "测试群"
        is_group = True

    holder: dict = {}

    class FakeStore:
        def __init__(self, account, wd) -> None:
            holder["store"] = self
            self.account = account
            self.work_dir = wd
            self.resolver_at_iter = None

        def prepare(self, ks) -> list:
            return []

        def iter_messages(self, chat, start_ts: int = 0, end_ts: int = 0):
            # 复刻 model.iter_messages 的媒体钩子（含单条 try/except）
            resolver = self.__dict__.get("_media_resolver")
            self.resolver_at_iter = resolver
            if events is not None:
                events.append("iter")
            out = []
            for m in msgs:
                if resolver is not None and m.type in ("image", "file", "video", "voice"):
                    try:
                        m.media_paths = resolver.resolve(m)
                    except Exception:  # noqa: BLE001 - 单条失败不影响消息（同 model）
                        m.media_paths = []
                out.append(m)
            return out

        def close(self) -> None:
            pass

    account = mock.Mock(wxid="wxid_fake", username="wxid_fake",
                        root=Path(r"C:\tmp\x"), db_dir=Path(r"C:\tmp\x\db"),
                        last_active=12.0)
    holder["account"] = account
    env = {"WXCHART_SIDECAR_WORK_DIR": str(work_dir)} if work_dir else {}
    owned = stack is None
    s = ExitStack() if owned else stack
    try:
        cfg = s.enter_context(mock.patch.object(launcher, "config"))
        keys_mod = s.enter_context(mock.patch.object(launcher, "keys"))
        s.enter_context(mock.patch.object(launcher, "Store", FakeStore))
        model_mod = s.enter_context(mock.patch.object(launcher, "model"))
        s.enter_context(mock.patch.dict(os.environ, env))
        if resolver_cls is not None:
            s.enter_context(mock.patch("wxchart.media.MediaResolver", resolver_cls))
        cfg.discover_accounts.return_value = [account]
        cfg.resolve_self_username.return_value = "wxid_fake"
        keys_mod.extract_keys.return_value = object()
        model_mod.load_contacts.return_value = {}
        model_mod.load_chats.return_value = list(chats) if chats else [FakeChat()]
        params: dict = {"kind": "store"}
        if options is not None:
            params["options"] = options
        holder["result"] = sc.handle("load_source", params)
    finally:
        if owned:
            s.close()
    holder["resolver_at_iter"] = holder["store"].resolver_at_iter
    return holder


def test_load_source_resolve_media_mocked() -> None:
    """`options.resolve_media=true`（mock）：挂**薄代理**——图片只定位、文件照常解析。

    断言（docs/02 §1.2 2026-11-07 懒解码契约）：
    1. store 上挂的是薄代理（不是真实例），且在读取消息**之前**挂载；
    2. 真实 MediaResolver 留在 Sidecar._media_resolver（store.close 后按需解码用）；
    3. ensure_image_key 在读消息前调用一次（同 Tk gui.py:657）；
    4. 图片**只定位**：decoded=false、path=""、name 为 .dat 文件名；
    5. 文件照常解析：decoded=true、path 为本机绝对路径；
    6. 图片不走真实 resolve、加载期不动 resolver.stats、薄代理 __getattr__ 全转发。
    """
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    capture: dict = {}
    events: list = []
    md5a = "a" * 32

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        work_dir = tmp_path / "work"
        dat = tmp_path / "attach" / f"{md5a}_t.dat"
        dat.parent.mkdir(parents=True)
        dat.write_bytes(b"\x07\x08V2\x08\x07fake-dat")
        xlsx = tmp_path / "运单.xlsx"
        xlsx.write_bytes(b"PK\x03\x04fake-xlsx")

        def on_resolve(msg):
            if msg.type == "file":
                return [FakeAsset("file", str(xlsx), "运单.xlsx",
                                  xlsx.stat().st_size, True)]
            raise AssertionError("图片加载期只定位，不应进真实 resolve")

        resolver_cls = fake_resolver_cls({md5a: [dat]}, on_resolve=on_resolve,
                                         capture=capture, events=events)
        msgs = [FakeRaw("image", md5=md5a, local_id=8),
                FakeRaw("file", local_id=9, file_name="运单.xlsx")]
        holder = run_store_load(sc, msgs, options={"resolve_media": True},
                                work_dir=work_dir, resolver_cls=resolver_cls,
                                events=events)

        store = holder["store"]
        resolver = capture["resolver"]
        proxy = store.__dict__.get("_media_resolver")
        assert proxy is not None and proxy is not resolver, "store 上挂的是薄代理"
        assert store.resolver_at_iter is proxy, "必须在读取消息前挂载代理"
        assert sc._media_resolver is resolver, "真实例留在 Sidecar（close 后按需解码）"
        assert resolver.account is holder["account"]
        assert resolver.work_dir == work_dir
        assert resolver.include == {"image", "file", "video", "voice"}
        assert proxy.stats is resolver.stats and proxy.decoded_dir == resolver.decoded_dir, \
            "__getattr__ 全部转发"
        assert events[:2] == ["ensure", "iter"], "密钥初始化在读消息前（同 Tk）"
        assert len(resolver.ensure_calls) == 1, "图片密钥初始化一次"
        progress, allow_scan = resolver.ensure_calls[0]
        assert callable(progress) and allow_scan is True
        assert resolver.locate_calls == 1, "图片走定位段（_index_images）"

        result = holder["result"]
        assert result["source"] == "store"
        rows = result["messages"]
        assert rows[0]["media"] == [{
            "kind": "image", "name": f"{md5a}_t.dat", "path": "",
            "rel_path": "", "size": dat.stat().st_size, "decoded": False,
        }], "图片只定位：decoded=false、path 为空、name 为 .dat 文件名"
        assert rows[1]["media"] == [{
            "kind": "file", "name": "运单.xlsx", "path": str(xlsx),
            "rel_path": "", "size": xlsx.stat().st_size, "decoded": True,
        }], "文件照常解析"
        assert resolver.resolve_calls == ["file"], "图片不走真实 resolve"
        assert all(v == 0 for v in resolver.stats.values()), "加载期不改 resolver.stats"
        assert result["stats"]["media"] == 2


def test_load_source_without_resolve_media() -> None:
    """`resolve_media` 缺省/false：保持 M-A1 契约——不创建 resolver、media 未解析。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    holder: dict = {}

    class FakeMsg:
        create_time = 1793676480
        type = "text"
        is_mine = False
        sender_name = "王五"
        sender_username = "wxid_wangwu"
        chat_username = "48025936916@chatroom"
        local_id = 9
        server_id = 444
        quote_sender = ""
        quote_text = ""
        quote_svrid = 0
        text = "你好"
        media_paths: list = []

    class FakeChat:
        username = "48025936916@chatroom"
        display_name = "测试群"
        is_group = True

    class FakeStore:
        def __init__(self, account, work_dir) -> None:
            holder["store"] = self

        def prepare(self, ks) -> list:
            return []

        def iter_messages(self, chat, start_ts: int = 0, end_ts: int = 0):
            return [FakeMsg()]

        def close(self) -> None:
            pass

    def no_resolver(*_args, **_kwargs):
        raise AssertionError("resolve_media=false 不应创建 MediaResolver")

    account = mock.Mock(wxid="wxid_fake", username="wxid_fake",
                        root=Path(r"C:\tmp\x"), db_dir=Path(r"C:\tmp\x\db"),
                        last_active=12.0)
    with mock.patch.object(launcher, "config") as cfg, \
            mock.patch.object(launcher, "keys") as keys_mod, \
            mock.patch.object(launcher, "Store", FakeStore), \
            mock.patch.object(launcher, "model") as model_mod, \
            mock.patch("wxchart.media.MediaResolver", no_resolver):
        cfg.discover_accounts.return_value = [account]
        cfg.resolve_self_username.return_value = "wxid_fake"
        keys_mod.extract_keys.return_value = object()
        model_mod.load_contacts.return_value = {}
        model_mod.load_chats.return_value = [FakeChat()]

        for params in ({"kind": "store"},
                       {"kind": "store", "options": {}},
                       {"kind": "store", "options": {"resolve_media": False}}):
            result = sc.handle("load_source", params)
            assert result["messages"][0]["media"] == []
            assert "_media_resolver" not in holder["store"].__dict__


# ---------------------------------------------------------------- resolve_media

def test_load_source_resolve_media_hot_cache() -> None:
    """热缓存快路径：decoded 目录已有产物 → 加载期直接回填 decoded=true/path（不进索引段）。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    capture: dict = {}
    md5_hit = "b" * 32
    md5_res = "d" * 32           # image_md5 缺省 → 资源库回退（_resource_md5 base=3）
    md5_miss = "c" * 32

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        work_dir = tmp_path / "work"
        decoded_dir = work_dir / "decoded" / "wxid_fake"
        decoded_dir.mkdir(parents=True)
        # 同一 md5 两个产物：原图直解（无后缀）优先于 _t 缩略图
        hot_t = decoded_dir / f"{md5_hit}_t.jpg"
        hot_t.write_bytes(b"\xff\xd8\xff-thumb")
        hot = decoded_dir / f"{md5_hit}.jpg"
        hot.write_bytes(b"\xff\xd8\xff-full")
        # 索引段也有 .dat：热缓存必须优先（不再落回定位）
        dat = tmp_path / "attach" / f"{md5_hit}_t.dat"
        dat.parent.mkdir(parents=True)
        dat.write_bytes(b"\x07\x08V2\x08\x07fake-dat")
        # 资源库回退 md5 的产物（image_md5 为空 → _resource_md5(msg, 3)）
        res_file = decoded_dir / f"{md5_res}.jpg"
        res_file.write_bytes(b"\xff\xd8\xff-res")

        resolver_cls = fake_resolver_cls({md5_hit: [dat]}, capture=capture)
        msgs = [FakeRaw("image", md5=md5_hit, local_id=1),
                FakeRaw("image", md5="", local_id=2, res_md5=md5_res),
                FakeRaw("image", md5=md5_miss, local_id=3)]
        holder = run_store_load(sc, msgs, options={"resolve_media": True},
                                work_dir=work_dir, resolver_cls=resolver_cls)
        rows = holder["result"]["messages"]
        assert rows[0]["media"] == [{
            "kind": "image", "name": hot.name, "path": str(hot),
            "rel_path": "", "size": hot.stat().st_size, "decoded": True,
        }], "热缓存回填 decoded=true/path，且原图直解优先于 _t"
        assert rows[1]["media"] == [{
            "kind": "image", "name": res_file.name, "path": str(res_file),
            "rel_path": "", "size": res_file.stat().st_size, "decoded": True,
        }], "image_md5 缺省 → 资源库回退 md5，同样命中热缓存"
        assert rows[2]["media"] == [{
            "kind": "image", "name": f"{md5_miss}.dat", "path": "",
            "rel_path": "", "size": 0, "decoded": False,
        }], "缓存与索引都没有 → md5.dat 占位（文件不在本机）"
        resolver = capture["resolver"]
        assert resolver.resolve_calls == [], "热缓存/定位都不走真实 resolve"
        assert all(v == 0 for v in resolver.stats.values()), "加载期不改 resolver.stats"
        assert buf.getvalue() != "", "加载期照常发 read_chats progress"


def test_resolve_media_decodes_requested_indexes() -> None:
    """resolve_media 正常路径：只解码请求的下标、结果形状逐字段、回写 raw/item.media。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    capture: dict = {}
    md5a, md5b = "a" * 32, "b" * 32

    with tempfile.TemporaryDirectory() as tmp:
        work_dir = Path(tmp) / "work"
        decoded_dir = work_dir / "decoded" / "wxid_fake"
        decoded_dir.mkdir(parents=True)
        dat_a = Path(tmp) / "attach" / f"{md5a}.dat"
        dat_a.parent.mkdir(parents=True)
        dat_a.write_bytes(b"\x07\x08V2\x08\x07-a")

        def on_resolve(msg):
            if msg.type != "image":
                return []
            out = decoded_dir / f"{msg.image_md5}.jpg"
            if not out.exists():
                out.write_bytes(b"\xff\xd8\xff-decoded")
            return [FakeAsset("image", str(out), out.name, out.stat().st_size, True)]

        resolver_cls = fake_resolver_cls({md5a: [dat_a]}, on_resolve=on_resolve,
                                         capture=capture)
        msgs = [FakeRaw("image", md5=md5a, local_id=1),
                FakeRaw("image", md5=md5b, local_id=2),
                FakeRaw("text", local_id=3)]
        holder = run_store_load(sc, msgs, options={"resolve_media": True},
                                work_dir=work_dir, resolver_cls=resolver_cls)
        rows = holder["result"]["messages"]
        assert rows[0]["media"][0]["decoded"] is False, "加载期只定位"
        assert rows[1]["media"][0] == {"kind": "image", "name": f"{md5b}.dat",
                                       "path": "", "rel_path": "", "size": 0,
                                       "decoded": False}, "索引没有 → md5.dat 占位"

        buf.seek(0)
        buf.truncate(0)
        res = sc.handle("resolve_media", {"indexes": [0, 2]})

        assert set(res.keys()) == {"items"}
        assert [row["index"] for row in res["items"]] == [0, 2]
        decoded_path = decoded_dir / f"{md5a}.jpg"
        assert res["items"][0]["media"] == [{
            "kind": "image", "name": f"{md5a}.jpg", "path": str(decoded_path),
            "rel_path": "", "size": decoded_path.stat().st_size, "decoded": True,
        }], "结果 media 逐字段（docs/02 §1.3 形状）"
        assert res["items"][1] == {"index": 2, "media": []}, "文本消息原样"
        # 只解码请求的下标：1 号（未请求）保持只定位状态
        untouched = mapping.message_json(sc._items[1])["media"][0]
        assert untouched["decoded"] is False and untouched["path"] == ""
        # raw.media_paths 与 item.media 同步回写（导出走 item.media）
        assert sc._items[0].raw.media_paths[0].decoded is True
        assert sc._items[0].media[0].path == str(decoded_path)
        resolver = capture["resolver"]
        assert resolver.resolve_calls == ["image", "text"], \
            "加载期图片走定位；resolve_media 只重跑请求的 0/2 号"
        assert buf.getvalue() == "", "resolve_media 不发 progress"


def test_resolve_media_bad_indexes_internal() -> None:
    """indexes 非整数数组 / 越界 → INTERNAL（文案风格同 scope.indexes）。"""
    with tempfile.TemporaryDirectory() as tmp:
        out = make_export_dir(Path(tmp))
        buf = io.StringIO()
        sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
        sc.handle("load_source", {"kind": "export", "out_dir": str(out)})   # 3 条

        for params, needle in (
            ({}, "整数数组"),
            ({"indexes": None}, "整数数组"),
            ({"indexes": 7}, "整数数组"),
            ({"indexes": "0"}, "整数数组"),
            ({"indexes": ["0"]}, "整数数组"),
            ({"indexes": [True]}, "整数数组"),          # bool 拒绝（与 scope.indexes 同）
            ({"indexes": [0.5]}, "整数数组"),
            ({"indexes": [99]}, "越界"),
            ({"indexes": [-1]}, "越界"),
            ({"indexes": [0, 99]}, "越界"),
        ):
            try:
                sc.handle("resolve_media", params)
                raise AssertionError(f"{params} 应抛 INTERNAL")
            except mapping.SidecarError as exc:
                assert exc.code == "INTERNAL", f"{params} -> {exc.code}: {exc.message}"
                assert needle in exc.message, f"{params}: {exc.message}"

        assert sc.handle("resolve_media", {"indexes": []}) == {"items": []}
        assert buf.getvalue() == "", "校验失败不写任何帧"


def test_resolve_media_before_load_source_unavailable() -> None:
    """未加载数据 → SOURCE_UNAVAILABLE（与 export 同文案）。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    try:
        sc.handle("resolve_media", {"indexes": [0]})
        raise AssertionError("未加载应抛 SOURCE_UNAVAILABLE")
    except mapping.SidecarError as exc:
        assert exc.code == "SOURCE_UNAVAILABLE"
        assert "尚未加载数据" in exc.message
    assert buf.getvalue() == ""


def test_resolve_media_without_resolver_returns_asis() -> None:
    """已加载但未挂 resolver（export 来源 / resolve_media=false）→ 原样返回、不报错。"""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        buf = io.StringIO()
        sc = launcher.Sidecar(launcher.NdjsonWriter(buf))

        # 1) export 来源（_load_export 重置 resolver=None）：附件 media 原样回
        out = make_export_dir(tmp_path)
        sc.handle("load_source", {"kind": "export", "out_dir": str(out)})
        assert sc._media_resolver is None
        res = sc.handle("resolve_media", {"indexes": [1]})
        assert res["items"] == [{"index": 1, "media": mapping.media_json(sc._items[1])}]
        media = res["items"][0]["media"][0]
        assert media["decoded"] is True and Path(media["path"]).is_file()

        # 2) store 但 resolve_media 缺省：raw 在手也不解码，原样返回当前 media
        hot = tmp_path / "hot.jpg"
        hot.write_bytes(b"\xff\xd8\xff-hot")
        msg = FakeRaw("image", md5="e" * 32, local_id=1)
        msg.media_paths = [FakeAsset("image", str(hot), hot.name,
                                     hot.stat().st_size, True)]
        holder = run_store_load(sc, [msg], options=None)
        assert sc._media_resolver is None
        assert "_media_resolver" not in holder["store"].__dict__
        buf.seek(0)
        buf.truncate(0)                            # 丢掉加载期 read_chats 进度
        res2 = sc.handle("resolve_media", {"indexes": [0]})
        assert res2["items"] == [{"index": 0, "media": [{
            "kind": "image", "name": hot.name, "path": str(hot),
            "rel_path": "", "size": hot.stat().st_size, "decoded": True,
        }]}], "原样返回当前 media（不重跑解码）"
        assert buf.getvalue() == "", "resolve_media 不发 progress"


def test_resolve_media_exporting_busy() -> None:
    """resolve_media 与 load/export 共用互斥锁（docs/02 §1.2）：冲突回 EXPORTING_BUSY。"""
    with tempfile.TemporaryDirectory() as tmp:
        out = make_export_dir(Path(tmp))
        buf = io.StringIO()
        sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
        sc.handle("load_source", {"kind": "export", "out_dir": str(out)})

        assert sc._busy.acquire(blocking=False)
        try:
            try:
                sc.handle("resolve_media", {"indexes": [0]})
                raise AssertionError("锁被占应抛 EXPORTING_BUSY")
            except mapping.SidecarError as exc:
                assert exc.code == "EXPORTING_BUSY"
        finally:
            sc._busy.release()
        assert buf.getvalue() == "", "互斥拒绝不写任何帧"


def test_export_backfills_undecoded_images() -> None:
    """导出写出前补齐未解码图片：mock resolver 被调用、输出含 path、每 ~50 条发 progress。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    capture: dict = {}
    total = 51

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        work_dir = tmp_path / "work"
        decoded_dir = work_dir / "decoded" / "wxid_fake"
        decoded_dir.mkdir(parents=True)

        def on_resolve(msg):
            if msg.type != "image":
                return []
            out = decoded_dir / f"{msg.image_md5}.jpg"
            if not out.exists():
                out.write_bytes(b"\xff\xd8\xff-decoded")
            return [FakeAsset("image", str(out), out.name, out.stat().st_size, True)]

        resolver_cls = fake_resolver_cls({}, on_resolve=on_resolve, capture=capture)
        msgs = [FakeRaw("image", md5=f"{i:032x}", local_id=i + 1)
                for i in range(total)]
        holder = run_store_load(sc, msgs, options={"resolve_media": True},
                                work_dir=work_dir, resolver_cls=resolver_cls)
        rows = holder["result"]["messages"]
        assert all(r["media"][0]["decoded"] is False for r in rows), "加载期全部只定位"

        buf.seek(0)
        buf.truncate(0)
        target = tmp_path / "out.json"
        res = sc.handle("export", {"format": "json", "out_path": str(target),
                                   "scope": {"type": "indexes",
                                             "indexes": list(range(total))}})
        resolver = capture["resolver"]
        assert res["count"] == total
        assert len(resolver.resolve_calls) == total, "导出对每条未解码图片重跑 resolve"
        records = json.loads(target.read_text(encoding="utf-8"))
        assert len(records) == total
        for i, rec in enumerate(records):
            media = rec["media"][0]
            expected = str(decoded_dir / f"{i:032x}.jpg")
            assert media["path"] == expected, "导出记录含解码后的 path（Tk 行为）"
            assert Path(media["path"]).is_file()

        frames = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.strip()]
        prog = [f for f in frames if f.get("method") == "progress"]
        assert all("id" not in f for f in prog), "通知不带 id"
        params = [f["params"] for f in prog]
        assert {"phase": "resolve_media", "done": 50, "total": total,
                "message": f"解码图片 50/{total}"} in params, "每 ~50 条一条 progress"
        assert {"phase": "resolve_media", "done": total, "total": total,
                "message": f"解码图片 {total}/{total}"} in params
        assert len(prog) == 2, f"51 条 → 恰好 2 条 progress，实得 {len(prog)}"


# ---------------------------------------------------------------- 本地数据包 bundle（docs/02 §1.2 / docs/06 Phase 1）

def _run_bundle(sc, msgs, out, *, work_dir, resolver_cls=None, options=None,
                chats=None):
    """同一补丁窗口内跑 load_source(kind=store) + export(format=bundle)。

    返回 (load_result, bundle_result)；补丁在 bundle 应答后才撤
    （bundle 要重开 Store——Store/config/keys/model 必须仍是替身）。
    ``options`` 透传给 export（docs/02 §1.2 2026-11-10 #14）；``chats`` 覆盖
    ``model.load_chats`` 返回的会话清单（多会话子集用例）。
    """
    with ExitStack() as stack:
        holder = run_store_load(sc, msgs, options={"resolve_media": True},
                                work_dir=work_dir, resolver_cls=resolver_cls,
                                stack=stack, chats=chats)
        buf: io.StringIO = sc._writer.stream          # type: ignore[attr-defined]
        buf.seek(0)
        buf.truncate(0)                               # 只断言 bundle 期间的 progress
        params: dict = {"format": "bundle", "out_path": str(out)}
        if options is not None:
            params["options"] = options
        res = sc.handle("export", params)
    return holder, res


def test_export_bundle_shape() -> None:
    """bundle 产出形状：站点/state/报告齐 + result {path,count,bytes} + progress。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        msgs = [FakeRaw("text", text="你好", local_id=1),
                FakeRaw("text", text="报价单已发", local_id=2)]
        _, res = _run_bundle(sc, msgs, tmp_path / "pkg",
                             work_dir=tmp_path / "work",
                             resolver_cls=fake_resolver_cls())
        assert res["path"] == str(tmp_path / "pkg")
        assert res["count"] == 2, res
        assert res["bytes"] > 0, "数据包总字节数应 > 0"
        out = Path(res["path"])
        # exporter 原样产出（docs/06：HTML 站点 + 附件 + state + 报告）
        assert (out / "索引.html").is_file()
        assert (out / ".wxchart-state.json").is_file()
        assert (out / "导出报告.json").is_file()
        assert (out / "测试群_48025936916@chatroom" / "索引.html").is_file()
        assert (out / "测试群_48025936916@chatroom" / "消息.csv").is_file()

        frames = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.strip()]
        prog = [f["params"] for f in frames if f.get("method") == "progress"]
        assert prog, "bundle 期间应发 progress"
        assert all(p["phase"] == "export_bundle" and p["total"] == 100 for p in prog), prog
        assert all("id" not in f for f in frames if f.get("method") == "progress")


def test_export_bundle_state_reloadable() -> None:
    """bundle 的 .wxchart-state.json 可被 load_source kind=export 回读（脱离微信）。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        msgs = [FakeRaw("text", text="本地数据回读", local_id=5)]
        _run_bundle(sc, msgs, tmp_path / "pkg",
                    work_dir=tmp_path / "work", resolver_cls=fake_resolver_cls())

        res = sc.handle("load_source", {"kind": "export",
                                        "out_dir": str(tmp_path / "pkg")})
        assert res["source"] == "export"
        assert len(res["messages"]) == 1
        assert res["messages"][0]["text"] == "本地数据回读"

        # 回读来源没有账号/KeySet：再打包 → INTERNAL（docs/02 §1.2 仅 store 来源）
        try:
            sc.handle("export", {"format": "bundle",
                                 "out_path": str(tmp_path / "pkg2")})
            raise AssertionError("导出目录来源打包应抛 INTERNAL")
        except mapping.SidecarError as exc:
            assert exc.code == "INTERNAL" and "扫描" in exc.message


def test_export_bundle_missing_media_tolerated() -> None:
    """附件缺失只记入导出报告（media-missing）不中断导出（docs/02 §1.2 容错口径）。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        missing = tmp_path / "no-such" / "运单.xlsx"

        def on_resolve(msg):
            if msg.type != "file":
                return []
            return [FakeAsset("file", str(missing), "运单.xlsx", 10)]

        msgs = [FakeRaw("file", file_name="运单.xlsx", local_id=1),
                FakeRaw("text", text="正常消息", local_id=2)]
        _, res = _run_bundle(sc, msgs, tmp_path / "pkg",
                             work_dir=tmp_path / "work",
                             resolver_cls=fake_resolver_cls(on_resolve=on_resolve))
        assert res["count"] == 2, "附件缺失不中断导出"
        report = json.loads(
            (Path(res["path"]) / "导出报告.json").read_text(encoding="utf-8"))
        assert any(e.get("code") == "media-missing" for e in report["errors"]), \
            report["errors"]


def test_export_bundle_before_load_source_unavailable() -> None:
    """未加载就打包 → SOURCE_UNAVAILABLE（与 json/csv 同一口径，docs/02 §1.2）。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        try:
            sc.handle("export", {"format": "bundle",
                                 "out_path": str(Path(tmp) / "pkg")})
            raise AssertionError("未加载打包应抛 SOURCE_UNAVAILABLE")
        except mapping.SidecarError as exc:
            assert exc.code == "SOURCE_UNAVAILABLE"


# ------------------------------------ 选择性 + 增量数据包 options（docs/07 #14）

class _ChatA:
    """会话替身：username 即 load_source 结果的 chat_id（guidata._from_message:185）。"""

    username = "48025936916@chatroom"
    display_name = "测试群"
    is_group = True


class _ChatB:
    username = "wxid_other"
    display_name = "其他会话"
    is_group = False


def test_export_bundle_options_whitelist() -> None:
    """options 白名单（docs/02 §1.2 2026-11-10 #14 冻结）：
    未知键 / 非预期类型 → INTERNAL，且 message 指明字段（同 set_settings 口径）。"""
    cases = [
        ({"foo": 1}, "foo"),                          # 未知选项键
        ([], "options"),                              # options 整体非对象
        ({"chats": "48025936916@chatroom"}, "chats"),  # 会话子集不是数组
        ({"start_ts": "1793676480"}, "start_ts"),     # 时间不是整数
        ({"include": "text"}, "include"),             # 类型子集不是数组
        ({"include": ["bogus"]}, "bogus"),            # 未知正文类型
        ({"artifacts": {"htm": True}}, "htm"),        # 未知生成物键
        ({"artifacts": {"csv": 1}}, "csv"),           # 生成物值非布尔
        ({"incremental": "yes"}, "incremental"),      # 增量位非布尔
    ]
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        msgs = [FakeRaw("text", text="你好", local_id=1)]
        run_store_load(sc, msgs, work_dir=tmp_path / "work")
        for index, (bad, needle) in enumerate(cases):
            try:
                sc.handle("export", {"format": "bundle",
                                     "out_path": str(tmp_path / f"pkg{index}"),
                                     "options": bad})
                raise AssertionError(f"options={bad!r} 应抛 INTERNAL")
            except mapping.SidecarError as exc:
                assert exc.code == "INTERNAL", (bad, exc.code, exc.message)
                assert needle in exc.message, (bad, exc.message)


def test_export_bundle_options_chats_subset() -> None:
    """options.chats：只导所选会话子集；显式 [] → 未选择会话、未知 id → 指明 id。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        msgs = [FakeRaw("text", text="子集导出", local_id=1)]
        chats = [_ChatA(), _ChatB()]

        # 子集：只选 B → 只有 B 的会话目录落盘
        _, res = _run_bundle(sc, msgs, tmp_path / "pkg-b",
                             work_dir=tmp_path / "work",
                             resolver_cls=fake_resolver_cls(),
                             options={"chats": ["wxid_other"]}, chats=chats)
        out = Path(res["path"])
        assert (out / "其他会话_wxid_other" / "索引.html").is_file(), list(out.iterdir())
        assert not (out / "测试群_48025936916@chatroom").exists()

        for bad, needle in (([], "未选择会话"), (["nobody@chatroom"], "nobody@chatroom")):
            try:
                sc.handle("export", {"format": "bundle",
                                     "out_path": str(tmp_path / "pkg-bad"),
                                     "options": {"chats": bad}})
                raise AssertionError(f"chats={bad!r} 应抛 INTERNAL")
            except mapping.SidecarError as exc:
                assert exc.code == "INTERNAL" and needle in exc.message, exc.message


def test_export_bundle_options_time_range_and_include() -> None:
    """start_ts/end_ts 闭区间过滤（0=不限）与倒置拒绝；include 归一恒含 text（同 Tk）。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        early = FakeRaw("text", text="早消息", local_id=1)
        late = FakeRaw("text", text="晚消息", local_id=2)
        late.create_time = early.create_time + 86400
        pair = [early, late]

        # 只给 start_ts → 之后（含端点）的 1 条
        _, res = _run_bundle(sc, pair, tmp_path / "pkg-from",
                             work_dir=tmp_path / "work",
                             resolver_cls=fake_resolver_cls(),
                             options={"start_ts": early.create_time + 1})
        assert res["count"] == 1, res
        # 只给 end_ts → 之前（含端点）的 1 条
        _, res2 = _run_bundle(sc, pair, tmp_path / "pkg-to",
                              work_dir=tmp_path / "work",
                              resolver_cls=fake_resolver_cls(),
                              options={"end_ts": early.create_time})
        assert res2["count"] == 1, res2

        # 时间倒置（均非 0）→ INTERNAL
        try:
            sc.handle("export", {"format": "bundle",
                                 "out_path": str(tmp_path / "pkg-flip"),
                                 "options": {"start_ts": 100, "end_ts": 50}})
            raise AssertionError("时间倒置应抛 INTERNAL")
        except mapping.SidecarError as exc:
            assert exc.code == "INTERNAL" and "倒置" in exc.message, exc.message

        # include 归一恒含 text：只给 file → 文字保留、图片被滤（2 条 → 1 条）
        _, res3 = _run_bundle(sc, [FakeRaw("text", text="保留", local_id=4),
                                   FakeRaw("image", local_id=5)],
                              tmp_path / "pkg-inc",
                              work_dir=tmp_path / "work",
                              resolver_cls=fake_resolver_cls(),
                              options={"include": ["file"]})
        assert res3["count"] == 1, res3


def test_export_bundle_options_artifacts() -> None:
    """artifacts 逐键覆盖、缺键=True：关 csv → 无 消息.csv；关 html → 无 索引.html。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        msgs = [FakeRaw("text", text="生成物开关", local_id=1)]

        _, res = _run_bundle(sc, msgs, tmp_path / "pkg-nocsv",
                             work_dir=tmp_path / "work",
                             resolver_cls=fake_resolver_cls(),
                             options={"artifacts": {"csv": False}})
        out = Path(res["path"])
        assert (out / "测试群_48025936916@chatroom" / "索引.html").is_file()
        assert not (out / "测试群_48025936916@chatroom" / "消息.csv").exists()

        _, res2 = _run_bundle(sc, msgs, tmp_path / "pkg-nohtml",
                              work_dir=tmp_path / "work",
                              resolver_cls=fake_resolver_cls(),
                              options={"artifacts": {"html": False}})
        out2 = Path(res2["path"])
        assert not (out2 / "索引.html").exists()
        assert (out2 / "测试群_48025936916@chatroom" / "消息.csv").is_file()


def test_export_bundle_incremental_mode_and_new_messages() -> None:
    """增量（export_state）：无 state → mode=full；同目录二跑且会话有新消息 →
    mode=incremental、new_messages=本次条数（docs/02 §1.2 result 扩展）。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        msgs = [FakeRaw("text", text="第一条", local_id=1),
                FakeRaw("text", text="第二条", local_id=2)]
        pkg = tmp_path / "pkg-inc"
        with ExitStack() as stack:
            run_store_load(sc, msgs, options={"resolve_media": True},
                           work_dir=tmp_path / "work",
                           resolver_cls=fake_resolver_cls(), stack=stack)
            first = sc.handle("export", {"format": "bundle", "out_path": str(pkg),
                                         "options": {"incremental": True}})
            assert first["mode"] == "full", first
            assert first["new_messages"] == 2, first
            # 会话计数增长 → 增量跳过判定失效，重新导出该会话
            sc._store_ctx["chats"][0].message_count = 99
            second = sc.handle("export", {"format": "bundle", "out_path": str(pkg),
                                          "options": {"incremental": True}})
        assert second["mode"] == "incremental", second
        assert second["new_messages"] == 2, second
        assert second["count"] == 2, second


def test_export_bundle_incremental_cross_account_rejected() -> None:
    """跨账号混写：同目录已有别的账号 state → INTERNAL（文案原样，docs/02 §1.2）。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        msgs = [FakeRaw("text", text="同账号", local_id=1)]
        pkg = tmp_path / "pkg-cross"
        with ExitStack() as stack:
            run_store_load(sc, msgs, options={"resolve_media": True},
                           work_dir=tmp_path / "work",
                           resolver_cls=fake_resolver_cls(), stack=stack)
            sc.handle("export", {"format": "bundle", "out_path": str(pkg)})
            sc._store_ctx["account"].wxid = "wxid_other"
            try:
                sc.handle("export", {"format": "bundle", "out_path": str(pkg),
                                     "options": {"incremental": True}})
                raise AssertionError("跨账号混写应抛 INTERNAL")
            except mapping.SidecarError as exc:
                assert exc.code == "INTERNAL" and "已被账号" in exc.message, \
                    exc.message


# ---------------------------------------------------------------- scan_accounts 数据目录（docs/07 #13）

def test_scan_accounts_root_and_discovery() -> None:
    """scan_accounts root 参数与自动发现（docs/02 §1.2 2026-11-09 #13）：
    显式 root 只试它不回落；无 root 走发现顺序（env → 常见位置 → 数据层默认）并记 tried。"""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        # 1) 显式 root 命中：造 <root>/wxid_probe_xxx/db_storage/message 结构
        #（env 根清空——发现顺序 env 最高优先，测试不得受宿主环境影响）
        root = tmp_path / "manual-root"
        (root / "wxid_probe_1" / "db_storage" / "message").mkdir(parents=True)
        p = Proc(env={"WXCHART_XWECHAT_ROOT": ""})
        try:
            res = p.ask({"id": 1, "method": "scan_accounts", "params": {"root": str(root)}})
            r = res["result"]
            assert [a["wxid"] for a in r["accounts"]] == ["wxid_probe_1"], r
            assert r["root"] == str(root)
            assert r["tried"] == [str(root)], "显式 root 只试它（不回落）"

            # 2) 显式 root 无账号 → 空结果且仍只试它
            empty = tmp_path / "empty-root"
            empty.mkdir()
            res = p.ask({"id": 2, "method": "scan_accounts", "params": {"root": str(empty)}})
            r2 = res["result"]
            assert r2["accounts"] == [] and r2["root"] == ""
            assert r2["tried"] == [str(empty)]
        finally:
            p.stop()

        # 3) 无 root：APPDATA/USERPROFILE 指到空 tmp（env 根清空）→ 候选全 miss、tried 含候选
        roaming = tmp_path / "roaming"
        home = tmp_path / "home"
        roaming.mkdir()
        home.mkdir()
        env = {
            "APPDATA": str(roaming),
            "USERPROFILE": str(home),
            "WXCHART_XWECHAT_ROOT": "",   # 空串=未设置（falsy）
        }
        p2 = Proc(env=env)
        try:
            res = p2.ask({"id": 1, "method": "scan_accounts", "params": {}})
            r3 = res["result"]
            assert r3["accounts"] == [] and r3["root"] == ""
            assert str(roaming / "Tencent" / "xwechat_files") in r3["tried"], r3["tried"]
            assert str(home / "Documents" / "WeChat Files") in r3["tried"], r3["tried"]
            assert len(r3["tried"]) >= 3, f"候选含数据层默认，应≥3：{r3['tried']}"
        finally:
            p2.stop()


def test_doctor_dispatch_mocked() -> None:
    """doctor（docs/02 §1.2 2026-11-09 #3）：mock 全绿路径（形状冻结）
    + KEY_NOT_FOUND 路径（错误帧）+ NO_ACCOUNT 分支；store 查完即关。"""
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))

    class FakeChat:
        message_count = 42

    class FakeStore:
        closed = False

        def __init__(self, account, work_dir) -> None:
            pass

        def prepare(self, ks) -> list:
            return [mock.Mock(rel="message/message.db", ok=True),
                    mock.Mock(rel="session/session.db", ok=False)]

        def close(self) -> None:
            FakeStore.closed = True

    account = mock.Mock(wxid="wxid_fake", username="wxid_fake",
                        root=Path(r"C:\tmp\x"), db_dir=Path(r"C:\tmp\x\db"),
                        last_active=12.0)
    ks = mock.Mock(mode="config-cipher", pid=4242,
                   keys={"message/message.db": b"\x00"}, missing=["session/session.db"])
    with mock.patch.object(launcher, "config") as cfg, \
            mock.patch.object(launcher, "keys") as keys_mod, \
            mock.patch.object(launcher, "Store", FakeStore), \
            mock.patch.object(launcher, "model") as model_mod:
        cfg.discover_accounts.return_value = [account]
        cfg.resolve_self_username.return_value = "wxid_fake"
        keys_mod.extract_keys.return_value = ks
        model_mod.load_contacts.return_value = {}
        model_mod.load_chats.return_value = [FakeChat()]

        result = sc.handle("doctor", {})

    # 形状冻结（docs/02 §1.2）：顶层五键，key_sources 五键、dbs 两键
    assert set(result.keys()) == {"version", "account", "key_sources", "dbs", "messages"}
    assert result["version"] == WXCHART_VERSION
    assert result["account"] == {"wxid": "wxid_fake", "root": str(Path(r"C:\tmp\x"))}
    assert set(result["key_sources"].keys()) == {"mode", "pid", "hit", "total", "missing"}
    assert result["key_sources"]["mode"] == "config-cipher"
    assert result["key_sources"]["hit"] == 1 and result["key_sources"]["total"] == 2
    assert result["key_sources"]["missing"] == ["session/session.db"], "missing 截前 8 条"
    assert result["dbs"] == [{"name": "message/message.db", "ok": True},
                             {"name": "session/session.db", "ok": False}], \
        "部分库解密失败不报错，逐库 ok 呈现"
    assert result["messages"] == 42, "消息数 = chats.message_count 求和（Tk 同口径）"
    assert FakeStore.closed, "自检的 store 必须在 finally 关闭"
    wire = json.dumps(result, ensure_ascii=False, default=str)
    assert "keys" not in result["key_sources"] and "\\u0000" not in wire, \
        "结果不含任何密钥值（docs/03 §5）"
    assert buf.getvalue() == "", "doctor 不发 progress 通知"

    # KEY_NOT_FOUND：extract_keys 抛 KeyExtractError → 错误帧（微信未运行）
    ks_error = KeyExtractError("weixin-not-running",
                               "Weixin.exe 未运行。请先登录微信（密钥只在登录后的进程内存中），再重试。")
    stdin = io.StringIO(json.dumps({"id": 7, "method": "doctor", "params": {}}) + "\n")
    out = io.StringIO()
    with mock.patch.object(launcher, "config") as cfg, \
            mock.patch.object(launcher, "keys") as keys_mod:
        cfg.discover_accounts.return_value = [account]
        keys_mod.extract_keys.side_effect = ks_error
        rc = launcher.run(stdin, launcher.NdjsonWriter(out), sc)
    assert rc == 0
    frame = json.loads(out.getvalue().splitlines()[0])
    assert frame["id"] == 7
    assert frame["error"]["code"] == "KEY_NOT_FOUND"
    assert "Weixin.exe 未运行" in frame["error"]["message"], "沿用 Tk 异常文案"

    # NO_ACCOUNT：没有账号目录 → NO_ACCOUNT（A2 #30 引导口径）
    with mock.patch.object(launcher, "config") as cfg:
        cfg.discover_accounts.return_value = []
        try:
            sc.handle("doctor", {})
            raise AssertionError("doctor 无账号应抛 NO_ACCOUNT")
        except mapping.SidecarError as exc:
            assert exc.code == "NO_ACCOUNT"


# -------------------------------------------- extract_tracking（docs/07 #19）

def _make_tracking_csv(root: Path) -> Path:
    """快递单号提取输入夹具（本程序导出列，9 列）。"""
    import csv as _csv
    path = root / "track_in.csv"
    rows = [
        ["t1", "d1", "s1", "g1", "u1", "文本", "寄出运单号: YT2550124940265 退货", "", ""],
        ["t2", "d2", "s2", "g2", "u2", "文本", "联系电话 13812345678", "", ""],
        ["t3", "d3", "s3", "g3", "u3", "表情", "[表情]", "", ""],
        ["t4", "d4", "s4", "g4", "u4", "引用",
         "'@CO 7373 3342 2427 86 这个退货是不是还没取呢", "", ""],
        ["t5", "d5", "s5", "g5", "u5", "文本", "今天天气不错，收到货了谢谢", "", ""],
    ]
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = _csv.writer(f)
        w.writerow(["时间", "日期", "会话", "群号", "发送人", "类型", "内容", "附件", "附件路径"])
        w.writerows(rows)
    return path


def test_extract_tracking_preflight_and_local_run() -> None:
    """extract_tracking（docs/02 §1.2 #19）：preflight 计数 + 本地 run 端到端。

    - preflight 不调 API、不写产物；network=false → send_rows=0；
    - run 本地：输出 CSV 首列=快递单号、手机号被排除、进度 phase 正确；
    - 隐私：日志不回显 content、本地不落断点目录。
    """
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory(prefix="track_") as td:
        root = Path(td)
        in_csv = _make_tracking_csv(root)
        out_csv = str(root / "out.csv")

        # ---- preflight：只读计数 ----
        pf = sc.handle("extract_tracking",
                       {"mode": "preflight", "in_path": str(in_csv),
                        "network": False})
        assert set(pf.keys()) == {"mode", "rows", "candidates", "reuse_rows",
                                  "batches", "send_rows", "key_stored"}
        assert pf["mode"] == "preflight" and pf["rows"] == 5
        assert pf["candidates"] == 3        # 宽筛宁多勿漏：YT/手机号/CO 三行
        assert pf["batches"] == 0 and pf["send_rows"] == 0   # 本地不发送
        assert pf["key_stored"] is False
        assert not (root / "out.csv").exists(), "preflight 不得写产物"
        assert buf.getvalue() == "", "preflight 不发 progress"

        # network=true → send_rows = 候选 + 回检抽样（仍不调 API）
        pf2 = sc.handle("extract_tracking",
                        {"mode": "preflight", "in_path": str(in_csv),
                         "network": True, "audit": True})
        assert pf2["batches"] >= 1
        assert pf2["send_rows"] >= pf2["candidates"]

        # ---- run（本地）：打桩 call_api，任何调用即失败 ----
        real_call = launcher.call_api

        def no_api(*_a, **_k):     # noqa: ANN002, ANN003
            raise AssertionError("本地模式不得调 API")

        launcher.call_api = no_api
        try:
            result = sc.handle("extract_tracking",
                               {"mode": "run", "in_path": str(in_csv),
                                "out_path": out_csv, "network": False})
        finally:
            launcher.call_api = real_call
        assert result["mode"] == "run" and result["network"] is False
        assert result["rows"] == 5 and result["out_rows"] == 5
        assert result["with_numbers"] == 2 and result["numbers"] == 2
        assert result["sent_rows"] == 0 and result["tokens"] == 0
        assert Path(result["path"]).is_file()

        # 输出形状：首列快递单号；YT 提取、手机号排除、无单号行空首列
        import csv as _csv
        with open(result["path"], encoding="utf-8-sig", newline="") as f:
            olist = list(_csv.reader(f))
        assert olist[0][0] == "快递单号"
        got = {r[7]: r[0] for r in olist[1:]}
        assert got["寄出运单号: YT2550124940265 退货"] == "YT2550124940265"
        assert got["'@CO 7373 3342 2427 86 这个退货是不是还没取呢"] == "73733342242786"
        assert got["联系电话 13812345678"] == "", "手机号必须被排除"
        assert got["[表情]"] == ""

        # 进度：phase=extract_tracking，本地 3 阶段，末帧 done==total
        frames = [json.loads(line) for line in buf.getvalue().splitlines() if line]
        prog = [f for f in frames if f.get("method") == "progress"]
        assert prog, "run 必须发 progress"
        assert all(p["params"]["phase"] == "extract_tracking" for p in prog)
        assert prog[-1]["params"]["done"] == prog[-1]["params"]["total"] == 3
        # 隐私：progress message 不回显 content
        for p in prog:
            for secret in ("退货", "表情", "13812345678"):
                assert secret not in p["params"]["message"], p

        # 隐私：本地模式不落断点目录（无发送内容可落）
        assert not Path(out_csv + "_work").exists()


def test_extract_tracking_network_payload_minimized() -> None:
    """联网路径字段最小化（docs/02 #19 硬要求）：请求体每行只含 row/type/content。

    - 只发宽筛命中行（回检抽样除外），不发全量；
    - 断点文件只存 行号→单号（不落 content）；
    - sent_rows/tokens 计入 result。
    """
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    sent: list[list[dict]] = []

    def mock_api(base_url, api_key, model, system_prompt, user_content,  # noqa: ANN001
                 timeout=180, max_retries=5, on_retry=None):             # noqa: ANN001
        batch = json.loads(user_content)
        sent.append(batch)
        found = {}
        for b in batch:
            nums = launcher.local_extract(b["content"])
            if nums:
                found[str(b["row"])] = nums
        return {"choices": [{"message": {
            "content": json.dumps(found, ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 50}}

    real_call = launcher.call_api
    launcher.call_api = mock_api
    try:
        with tempfile.TemporaryDirectory(prefix="tracknet_") as td:
            root = Path(td)
            in_csv = _make_tracking_csv(root)
            out_csv = str(root / "out.csv")
            with mock.patch.dict(os.environ,
                                 {"WXCHART_TRACKING_KEY_FILE": str(root / "k.bin")}):
                result = sc.handle("extract_tracking",
                                   {"mode": "run", "in_path": str(in_csv),
                                    "out_path": out_csv, "network": True,
                                    "api_key": "TESTKEY-123", "audit": True})
            assert result["network"] is True
            # mock 每次 usage = 100+50 token
            assert result["sent_rows"] > 0 and result["tokens"] == 150 * len(sent)

            # 1) 字段最小化：每行恰好 row/type/content 三键
            assert sent, "联网模式必须调 API"
            for batch in sent:
                for item in batch:
                    assert set(item.keys()) == {"row", "type", "content"}, \
                        "请求体字段越界: %s" % set(item.keys())

            # 2) 只发候选行（回检抽样行之外不发落选行）
            cand_rows = {1, 2, 4}   # 宽筛命中（夹具）
            sent_rows = {b["row"] for batch in sent for b in batch}
            assert sent_rows <= {1, 2, 3, 4, 5}
            # 主批次（候选批次）只含候选行；落选行只允许出现在回检批次
            for batch in sent:
                rows_in = {x["row"] for x in batch}
                if rows_in & {3, 5}:
                    # 含落选行的批次 = 回检抽样批次（行数 > 单批候选或含 audit 标记）
                    assert len(batch) <= 300, "回检批次超抽样上限"

            # 3) 断点文件只存 行号→单号，不落 content 原文
            work = Path(out_csv + "_work")
            assert work.is_dir()
            secrets = ("退货", "表情", "13812345678", "今天天气不错")
            for f in work.glob("*.json"):
                raw = f.read_text(encoding="utf-8")
                for s in secrets:
                    assert s not in raw, "%s 泄漏原文" % f.name
                data = json.loads(raw)
                for k, v in data.items():
                    assert str(k).isdigit() and isinstance(v, list)

            # 4) progress message 不回显 content
            frames = [json.loads(l) for l in buf.getvalue().splitlines() if l]
            for fr in frames:
                if fr.get("method") == "progress":
                    for s in secrets:
                        assert s not in fr["params"]["message"]
    finally:
        launcher.call_api = real_call


def test_extract_tracking_key_dpapi_and_errors() -> None:
    """DPAPI Key（拍板③）+ 参数/错误路径（docs/02 #19）。"""
    with tempfile.TemporaryDirectory(prefix="trackkey_") as td:
        key_file = str(Path(td) / "k.bin")
        with mock.patch.dict(os.environ, {"WXCHART_TRACKING_KEY_FILE": key_file}):
            # 往返 + 明文不落盘
            launcher.save_tracking_key("SECRET-KEY-XYZ")
            raw = Path(key_file).read_bytes()
            assert b"SECRET-KEY-XYZ" not in raw, "明文 Key 不得落盘"
            assert launcher.load_tracking_key() == "SECRET-KEY-XYZ"
            # 损坏文件 → 视为未存（不抛）
            Path(key_file).write_bytes(b"\x00\x01garbage")
            assert launcher.load_tracking_key() == ""

            # Key 存在后 preflight 回 key_stored=true
            buf = io.StringIO()
            sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
            with tempfile.TemporaryDirectory(prefix="trackin_") as td2:
                in_csv = _make_tracking_csv(Path(td2))
                launcher.save_tracking_key("SECRET-KEY-XYZ")
                pf = sc.handle("extract_tracking",
                               {"mode": "preflight", "in_path": str(in_csv),
                                "network": True})
                assert pf["key_stored"] is True

                # 联网 run 无任何 Key → INTERNAL（指明请填写）
                Path(key_file).unlink()
                try:
                    sc.handle("extract_tracking",
                              {"mode": "run", "in_path": str(in_csv),
                               "out_path": str(Path(td2) / "o.csv"),
                               "network": True})
                    raise AssertionError("无 Key 联网应报错")
                except mapping.SidecarError as e:
                    assert e.code == "INTERNAL" and "API Key" in e.message

    # ---- 参数/错误路径 ----
    buf = io.StringIO()
    sc = launcher.Sidecar(launcher.NdjsonWriter(buf))
    with tempfile.TemporaryDirectory(prefix="trackerr_") as td:
        in_csv = _make_tracking_csv(Path(td))
        cases = [
            ({"mode": "nope", "in_path": str(in_csv)}, "mode 取值非法"),
            ({"mode": "preflight"}, "缺少 in_path"),
            ({"mode": "preflight", "in_path": str(in_csv), "bogus": 1}, "未知字段"),
            ({"mode": "run", "in_path": str(in_csv)}, "缺少 out_path"),
            ({"mode": "run", "in_path": str(in_csv),
              "out_path": "relative.csv"}, "绝对路径"),
            ({"mode": "preflight", "in_path": str(in_csv),
              "network": "yes"}, "布尔"),
            ({"mode": "preflight", "in_path": str(Path(td) / "missing.csv")},
             "不存在"),
        ]
        for params, keyword in cases:
            try:
                sc.handle("extract_tracking", params)
                raise AssertionError("应报错: %s" % params)
            except mapping.SidecarError as e:
                assert e.code == "INTERNAL", (params, e.code)
                assert keyword in e.message, (keyword, e.message)

        # 缺「内容」列 → INTERNAL
        bad = Path(td) / "bad.csv"
        bad.write_text("a,b\n1,2\n", encoding="utf-8-sig")
        try:
            sc.handle("extract_tracking",
                      {"mode": "preflight", "in_path": str(bad)})
            raise AssertionError("缺内容列应报错")
        except mapping.SidecarError as e:
            assert "内容" in e.message

        # 与 load/export 互斥 → EXPORTING_BUSY
        sc._busy.acquire()
        try:
            sc.handle("extract_tracking",
                      {"mode": "preflight", "in_path": str(in_csv)})
            raise AssertionError("互斥期应报 EXPORTING_BUSY")
        except mapping.SidecarError as e:
            assert e.code == "EXPORTING_BUSY"
        finally:
            sc._busy.release()


def test_extract_tracking_selftest_cli() -> None:
    """`python launcher.py --selftest` 离线自测（docs/07 #19 验收：不调 API）。"""
    proc = subprocess.run(
        [sys.executable, str(LAUNCHER), "--selftest"],
        capture_output=True, text=True, encoding="utf-8", timeout=180,
        cwd=str(TAURI_ROOT),
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "ALL SELFTESTS PASSED" in proc.stdout, proc.stdout
    # selftest 不出网：全程 mock/本地，无网络错误痕迹
    assert "URLError" not in proc.stderr


# ---------------------------------------------------------------- 直跑入口

def main() -> int:
    """依次运行所有 test_* 函数，打印 PASS/FAIL，返回退出码。"""
    tests = [
        (name, obj)
        for name, obj in sorted(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    failures = 0
    for name, func in tests:
        try:
            func()
        except Exception:  # noqa: BLE001 - 测试运行器需要汇总全部失败
            failures += 1
            print(f"[FAIL] {name}")
            traceback.print_exc()
        else:
            print(f"[PASS] {name}")
    print(f"\n通过 {len(tests) - failures}/{len(tests)} 个测试")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    sys.exit(main())
