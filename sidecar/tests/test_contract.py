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
                   events=None):
    """mock 跑一次 load_source(kind=store)；FakeStore 复刻 model.iter_messages 的媒体钩子。

    返回 holder：``{"result", "store", "account", "resolver_at_iter"}``。
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
    with ExitStack() as stack:
        cfg = stack.enter_context(mock.patch.object(launcher, "config"))
        keys_mod = stack.enter_context(mock.patch.object(launcher, "keys"))
        stack.enter_context(mock.patch.object(launcher, "Store", FakeStore))
        model_mod = stack.enter_context(mock.patch.object(launcher, "model"))
        stack.enter_context(mock.patch.dict(os.environ, env))
        if resolver_cls is not None:
            stack.enter_context(mock.patch("wxchart.media.MediaResolver", resolver_cls))
        cfg.discover_accounts.return_value = [account]
        cfg.resolve_self_username.return_value = "wxid_fake"
        keys_mod.extract_keys.return_value = object()
        model_mod.load_contacts.return_value = {}
        model_mod.load_chats.return_value = [FakeChat()]
        params: dict = {"kind": "store"}
        if options is not None:
            params["options"] = options
        holder["result"] = sc.handle("load_source", params)
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
