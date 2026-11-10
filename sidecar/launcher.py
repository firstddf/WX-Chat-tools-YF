# -*- coding: utf-8 -*-
"""通道③ sidecar 启动器：stdin/stdout NDJSON 循环 + 方法分发（docs/02 §1、docs/03）。

- 一行一个 JSON（UTF-8）；stdout 只出协议帧，stderr 只出日志（`[level] ...`）；
- 方法：ping / scan_accounts / load_source / resolve_media / export / doctor / stop；
  `resolve_media` 为图片**懒解码**（docs/02 §1.2 2026-11-07 增补）：加载期图片只定位，
  显示/导出时按需解码；
- 数据层只读引用 ../wxchart-tool/src/wxchart（不改 Tk 仓库）；
- 环境变量钩子见 docs/03 §3（WXCHART_XWECHAT_ROOT / WXCHART_SIDECAR_WORK_DIR /
  WXCHART_SIDECAR_MAX_FRAME）。

手工调试：`python sidecar/launcher.py` 之后逐行输入 JSON 请求。
"""
from __future__ import annotations

import json
import os
import platform
import re
import sys
import threading
import traceback
from pathlib import Path
from typing import Any, TextIO

_HERE = Path(__file__).resolve().parent
_WXCHART_SRC = _HERE.parent.parent / "wxchart-tool" / "src"
if _WXCHART_SRC.is_dir() and str(_WXCHART_SRC) not in sys.path:
    sys.path.insert(0, str(_WXCHART_SRC))

import mapping  # noqa: E402  sidecar 同目录
from mapping import PROTOCOL_VERSION, SidecarError  # noqa: E402

from wxchart import __version__ as APP_VERSION  # noqa: E402
from wxchart import config, exporter, guidata, keys, model  # noqa: E402
# 模块级导入（不从 config 属性取）：测试会整体 patch `launcher.config`，
# 属性访问会拿到 Mock，Path(Mock) 直接炸
from wxchart.config import DEFAULT_XWECHAT_ROOT  # noqa: E402
from wxchart.model import MediaAsset  # noqa: E402  直接引类：定位 helper 不受 model 打桩影响
from wxchart.store import Store  # noqa: E402

# 单帧上限（docs/03 §2：防御性 64MB）；测试可调小验证 BAD_FRAME
MAX_FRAME = int(os.environ.get("WXCHART_SIDECAR_MAX_FRAME", str(64 * 1024 * 1024)))

# 附件解析范围（与 Tk gui.py `_load_gui_worker` 完全一致：只为预览解析这四类）
MEDIA_INCLUDE = {"image", "file", "video", "voice"}

__all__ = ["NdjsonWriter", "Sidecar", "run", "main"]


def _log(level: str, message: str) -> None:
    """结构化前缀日志 → stderr（stdout 只允许协议帧）。"""
    print(f"[{level}] {message}", file=sys.stderr, flush=True)


class NdjsonWriter:
    """协议帧写手：一行一个 JSON，UTF-8，立即 flush。"""

    def __init__(self, stream: TextIO) -> None:
        self.stream = stream

    def emit(self, obj: dict[str, Any]) -> None:
        # ensure_ascii=False：线上直接写中文（与 Tk 导出/前端展示一致）
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str)
        self.stream.write(line + "\n")
        self.stream.flush()


class Sidecar:
    """方法分发与内存数据状态；请求串行处理（docs/03 §3）。"""

    def __init__(self, writer: NdjsonWriter) -> None:
        self._writer = writer
        self._busy = threading.Lock()          # load/export/resolve_media 互斥
        self._items: list[Any] | None = None   # 已加载的 FilterMessage（导出用，D3）
        self._source: str = ""
        # 真实 MediaResolver（懒解码）：加载期只挂薄代理到 store，真实例留在这里，
        # 供 resolve_media / export 按需解码（store.close() 后仍可用——只依赖 work_dir 文件）
        self._media_resolver: Any | None = None
        # 打包上下文（export format=bundle，docs/02 §1.2 2026-11-09）：store 来源加载成功后
        # 持有 账号/KeySet/会话清单/工作目录——打包时重开解密库（缓存命中不解密，不需微信进程）
        self._store_ctx: dict[str, Any] | None = None

    # ------------------------------------------------------------ 分发

    def handle(self, method: str, params: dict[str, Any]) -> Any:
        if method == "ping":
            return mapping.ping_result()
        if method == "scan_accounts":
            return self._scan_accounts(params)    # 只读，不入 load/export 互斥
        if method == "load_source":
            return self._exclusive(self._load_source, params)
        if method == "resolve_media":
            # 参数/加载态校验在锁外；解码执行与 load_source/export 共用互斥锁（docs/02 §1.2）
            indexes = self._check_indexes(params)
            return self._exclusive(self._resolve_media, indexes)
        if method == "export":
            return self._exclusive(self._export, params)
        if method == "doctor":
            # 自检要解密全库（docs/07 #3）：与 load/export 共用互斥锁，冲突回 EXPORTING_BUSY
            return self._exclusive(self._doctor, params)
        if method == "stop":
            return {"ok": True}
        raise SidecarError("INTERNAL", f"未知方法: {method}")

    def _exclusive(self, fn: Any, *args: Any) -> Any:
        """互斥执行（docs/03 §3）：冲突回 EXPORTING_BUSY。"""
        if not self._busy.acquire(blocking=False):
            raise SidecarError("EXPORTING_BUSY", "正在加载或导出，请稍候")
        try:
            return fn(*args)
        finally:
            self._busy.release()

    # ------------------------------------------------------------ 方法

    def _scan_accounts(self, params: dict[str, Any]) -> dict[str, Any]:
        """账号扫描（docs/02 §1.2 2026-11-09 #13）：同一发现口径，附 root/tried 诊断。"""
        accounts, tried = _discover_accounts(params.get("root"))
        return {
            "accounts": [mapping.account_row(a) for a in accounts],
            "root": tried[-1] if accounts else "",
            "tried": tried,
        }

    def _load_source(self, params: dict[str, Any]) -> dict[str, Any]:
        kind = params.get("kind")
        if kind == "export":
            return self._load_export(params)
        if kind == "store":
            return self._load_store(params)
        raise SidecarError("INTERNAL", f"kind 取值非法: {kind!r}（应为 store|export）")

    def _load_export(self, params: dict[str, Any]) -> dict[str, Any]:
        out_dir = params.get("out_dir")
        if not isinstance(out_dir, str) or not out_dir:
            raise SidecarError("INTERNAL", "load_source 缺少 out_dir（kind=export）")
        if not guidata.export_dir_available(out_dir):
            raise SidecarError("SOURCE_UNAVAILABLE", f"导出目录没有可用数据: {out_dir}")
        items = guidata.load_from_export_dir(out_dir)
        self._items, self._source = items, "export"
        # export 来源没有 raw 消息 → 本次不挂 resolver（resolve_media 原样返回，docs/02 §1.2）
        self._media_resolver = None
        # 导出目录来源没有账号/KeySet → 不可再打包 bundle（docs/02 §1.2）
        self._store_ctx = None
        return mapping.load_result("export", items, exported_at=_read_exported_at(out_dir))

    def _load_store(self, params: dict[str, Any]) -> dict[str, Any]:
        # 与 scan_accounts 同一发现口径（docs/02 §1.2 root 注入，#13）——否则
        # 扫到账号但加载 NO_ACCOUNT
        accounts, _ = _discover_accounts(params.get("root"))
        account = _pick_account(accounts, params.get("account"))
        ks = keys.extract_keys(account.db_dir)          # KeyExtractError → KEY_NOT_FOUND
        work_dir = Path(os.environ.get("WXCHART_SIDECAR_WORK_DIR") or (_HERE / ".cache"))
        # docs/02 §1.2 options.resolve_media：true 时挂 MediaResolver——**图片只定位不解码**
        # （media[].decoded=false/path=""，热缓存已有产物回填 true），文件/视频/语音照常解析；
        # 解码挪到 resolve_media / export 按需（懒解码：加载期全量解码 4720 图 ≈6.9min
        # 顶穿 300s 超时，2026-11-07）。false/缺省保持 M-A1 行为：不挂 resolver，
        # media 只有消息原文里的名字。
        options = params.get("options")
        resolve_media = bool(isinstance(options, dict) and options.get("resolve_media"))
        resolver: Any | None = None
        store = Store(account, work_dir)
        try:
            status = store.prepare(ks)
            bad = [s for s in status if not s.ok]
            if status and len(bad) == len(status):       # 全部库解密失败
                raise SidecarError(
                    "DB_DECRYPT_FAIL",
                    f"{len(bad)} 个库全部解密失败",
                    detail=str(getattr(bad[0], "error", "") or ""),
                )
            store.__dict__["_self_username"] = config.resolve_self_username(account)
            if resolve_media:
                resolver = _attach_media_resolver(store, account, work_dir)
            contacts = model.load_contacts(store)
            chats = list(model.load_chats(store, contacts))
            total = len(chats)

            def on_progress(message: str, pct: float) -> None:
                # guidata 进度回调 → 协议 progress 通知（无 id，可穿插在响应间）
                self._writer.emit({
                    "method": "progress",
                    "params": {
                        "phase": "read_chats",
                        "done": int(round(pct * total / 100.0)),
                        "total": total,
                        "message": message,
                    },
                })

            items = guidata.load_from_store(store, chats, progress=on_progress)
        finally:
            store.close()
        # 与 _items 一起提交：load 失败时不换 resolver（旧数据仍配旧 resolver）
        self._items, self._source = items, "store"
        self._media_resolver = resolver
        # 打包上下文与数据一起提交（store 已在 finally 关闭；bundle 时重开）
        self._store_ctx = {
            "account": account, "keys": ks, "chats": chats, "work_dir": work_dir,
        }
        return mapping.load_result("store", items)

    def _export(self, params: dict[str, Any]) -> dict[str, Any]:
        fmt = params.get("format")
        if fmt == "bundle":
            return self._export_bundle(params)
        if fmt not in ("json", "csv"):
            raise SidecarError(
                "INTERNAL", f"format 取值非法: {fmt!r}（应为 json|csv|bundle）")
        out_path = params.get("out_path")
        if not isinstance(out_path, str) or not out_path:
            raise SidecarError("INTERNAL", "export 缺少 out_path")
        scope = params.get("scope")
        if not isinstance(scope, dict):
            raise SidecarError("INTERNAL", "export 缺少 scope")
        if self._items is None:
            # D3：导出用 sidecar 内存里的同一份数据；未加载 → SOURCE_UNAVAILABLE
            raise SidecarError("SOURCE_UNAVAILABLE", "尚未加载数据（先调 load_source）")
        subset = self._subset(scope)
        # 导出对齐 Tk：写出前把子集里仍未解码的图片补齐（guidata.to_records/write_json/
        # write_csv 读的是 item.media——回填就回填这里），期间发 progress 通知
        if self._media_resolver is not None:
            self._backfill_images(subset)
        try:
            if fmt == "json":
                path = guidata.write_json(out_path, subset)
            else:
                path = guidata.write_csv(out_path, subset)
        except OSError as exc:
            raise SidecarError(
                "EXPORT_FAILED", f"写文件失败: {out_path}", str(exc)
            ) from exc
        return mapping.export_result(path, len(subset))

    def _export_bundle(self, params: dict[str, Any]) -> dict[str, Any]:
        """本地数据包（docs/02 §1.2 format=bundle、docs/06 Phase 1）。

        全量复用 Tk ``exporter.export()``：HTML 站点 + 附件副本 + ``.wxchart-state.json``
        + 导出报告（三方格式一致，回读走既有 ``load_source kind=export``）。
        重开解密库（KeySet 持有、缓存命中不解密）并挂**真实** MediaResolver——
        与 Tk ``start_export`` 同款，附件在导出迭代中照常解码复制。
        """
        out_path = params.get("out_path")
        if not isinstance(out_path, str) or not out_path:
            raise SidecarError("INTERNAL", "export 缺少 out_path")
        if params.get("scope") is not None:
            raise SidecarError("INTERNAL", "format=bundle 不接受 scope（全量数据包）")
        if self._items is None:
            # D3：与 json/csv 同一未加载口径（docs/02 §1.2）
            raise SidecarError("SOURCE_UNAVAILABLE", "尚未加载数据（先调 load_source）")
        ctx = self._store_ctx
        if ctx is None:
            raise SidecarError(
                "INTERNAL", "数据包导出仅支持扫描加载的数据（导出目录来源请重新扫描）")

        def on_progress(message: str, pct: float) -> None:
            # exporter 进度（0-100）→ 协议 progress 通知（docs/02 §1.2 export_bundle）
            self._writer.emit({
                "method": "progress",
                "params": {
                    "phase": "export_bundle",
                    "done": int(round(pct)),
                    "total": 100,
                    "message": message,
                },
            })

        root = Path(out_path)
        store = Store(ctx["account"], ctx["work_dir"])
        try:
            try:
                store.prepare(ctx["keys"])     # 解密缓存命中即跳过（文件级，不需要微信进程）
                resolver = self._bundle_resolver(ctx)
                if resolver is not None:
                    # 同 Tk start_export（gui.py:463）：真实解析器，附件解码复制
                    store.__dict__["_media_resolver"] = resolver
                report = exporter.export(
                    ctx["account"], store, ctx["chats"], out_dir=root,
                    progress=on_progress,
                )
            except ValueError as exc:
                # 输出目录被其它账号占用等：Tk 抛 ValueError，文案本身可展示
                raise SidecarError("INTERNAL", str(exc)) from exc
            except OSError as exc:
                raise SidecarError(
                    "EXPORT_FAILED", f"写文件失败: {out_path}", str(exc)
                ) from exc
        finally:
            store.close()
        return mapping.bundle_result(root, report)

    def _bundle_resolver(self, ctx: dict[str, Any]) -> Any | None:
        """数据包导出的附件解析器：优先复用加载期真实例（图片密钥已备）；
        没有（resolve_media=false）则现场建一个——同 Tk start_export，附件解析与
        懒解码开关无关。创建/密钥失败只影响附件，不阻断导出。"""
        resolver = self._media_resolver
        if resolver is not None:
            return resolver
        try:
            from wxchart.media import MediaResolver

            resolver = MediaResolver(ctx["account"], ctx["work_dir"], set(MEDIA_INCLUDE))
        except Exception as exc:  # noqa: BLE001 - 附件解析失败只影响预览（同 Tk）
            _log("warn", f"数据包附件解析初始化失败（导出将不含附件）: {exc}")
            return None
        try:
            resolver.ensure_image_key(progress=lambda _message, _pct: None)
        except Exception as exc:  # noqa: BLE001
            _log("warn", f"图片密钥初始化失败（图片可能未解密）: {exc}")
        return resolver

    def _doctor(self, params: dict[str, Any]) -> dict[str, Any]:
        """数据层自检（docs/02 §1.2 2026-11-09 #3）：账号 → 密钥 → 逐库解密 → 消息数。

        复用 Tk ``cli.cmd_doctor`` 的数据部分（不 import argparse 命令行壳）；
        账号发现与 scan/load 同口径（``root`` 注入，#13）。**部分库解密失败不报错**
        ——``dbs[].ok=false`` 逐库呈现；消息数仅在库可读时给出（读不出省略该键）。
        独立开 store、查完即关：**不改动** sidecar 已加载的内存数据
        （``_items``/``_store_ctx`` 原样）。
        """
        accounts, _ = _discover_accounts(params.get("root"))
        account = _pick_account(accounts, None)        # 空 → NO_ACCOUNT
        ks = keys.extract_keys(account.db_dir)         # KeyExtractError → KEY_NOT_FOUND
        work_dir = Path(os.environ.get("WXCHART_SIDECAR_WORK_DIR") or (_HERE / ".cache"))
        store = Store(account, work_dir)
        try:
            status = store.prepare(ks)
            messages: int | None = None
            if any(s.ok for s in status):
                try:
                    store.__dict__["_self_username"] = config.resolve_self_username(account)
                    contacts = model.load_contacts(store)
                    chats = model.load_chats(store, contacts)
                    messages = sum(c.message_count for c in chats)
                except Exception as exc:  # noqa: BLE001 - 库可读性不足：省略 messages，不报错
                    _log("warn", f"doctor 消息数读取失败（省略 messages）: {exc}")
        finally:
            store.close()
        return mapping.doctor_result(account, ks, status, messages)

    def _subset(self, scope: dict[str, Any]) -> list[Any]:
        assert self._items is not None
        stype = scope.get("type")
        if stype == "indexes":
            indexes = scope.get("indexes")
            if not isinstance(indexes, list) or any(
                not isinstance(i, int) or isinstance(i, bool) for i in indexes
            ):
                raise SidecarError("INTERNAL", "scope.indexes 必须是整数数组")
            total = len(self._items)
            bad = [i for i in indexes if i < 0 or i >= total]
            if bad:
                raise SidecarError(
                    "INTERNAL", f"scope.indexes 越界: {bad[:5]}（共 {total} 条）"
                )
            return [self._items[i] for i in indexes]
        if stype == "filter":
            spec = scope.get("filter")
            if not isinstance(spec, dict):
                raise SidecarError("INTERNAL", "scope.filter 必须是对象")
            # FilterSpec 字段名映射（docs/02 §1.3：chat_id/type → guidata 参数名）
            return guidata.filter_messages(
                self._items,
                query=str(spec.get("query") or ""),
                chat=str(spec.get("chat_id") or ""),
                date_from=str(spec.get("date_from") or ""),
                date_to=str(spec.get("date_to") or ""),
                type_code=str(spec.get("type") or ""),
            )
        raise SidecarError("INTERNAL", f"scope.type 取值非法: {stype!r}")

    # --------------------------------------------- resolve_media（图片懒解码）

    def _check_indexes(self, params: dict[str, Any]) -> list[int]:
        """resolve_media 的 indexes 校验（文案风格同 scope.indexes，docs/02 §1.2）。"""
        indexes = params.get("indexes")
        if not isinstance(indexes, list) or any(
            not isinstance(i, int) or isinstance(i, bool) for i in indexes
        ):
            raise SidecarError("INTERNAL", "resolve_media.indexes 必须是整数数组")
        if self._items is None:
            # 未加载 → SOURCE_UNAVAILABLE（与 export 同一文案）
            raise SidecarError("SOURCE_UNAVAILABLE", "尚未加载数据（先调 load_source）")
        total = len(self._items)
        bad = [i for i in indexes if i < 0 or i >= total]
        if bad:
            raise SidecarError(
                "INTERNAL", f"resolve_media.indexes 越界: {bad[:5]}（共 {total} 条）"
            )
        return indexes

    def _resolve_media(self, indexes: list[int]) -> dict[str, Any]:
        """按需解码图片（懒解码）：只解请求的下标；media 形状同 load_result，不发 progress。"""
        assert self._items is not None
        resolver = self._media_resolver
        rows: list[dict[str, Any]] = []
        for i in indexes:
            item = self._items[i]
            if resolver is not None:
                # 有 resolver：对 raw 重跑真实 MediaResolver.resolve（单条失败保持原 media）
                self._resolve_item_media(item, resolver)
            # 无 resolver：原样返回当前 media（前端据此停止重试，docs/02 §1.2）
            rows.append({"index": i, "media": mapping.media_json(item)})
        return {"items": rows}

    @staticmethod
    def _resolve_item_media(item: Any, resolver: Any) -> bool:
        """对一条 FilterMessage 重跑 resolver.resolve，回写 raw.media_paths 与 item.media。

        FilterMessage / Message 都是可变 dataclass，原地更新即可；item.media 用
        ``guidata._media_from_message`` 重新生成（与 load_source 同一口径）。
        """
        raw = getattr(item, "raw", None)
        if raw is None:
            return False                       # export 来源无 raw：保持原 media
        try:
            assets = resolver.resolve(raw)
        except Exception:  # noqa: BLE001 - 单条失败保持原 media，不影响其余下标
            return False
        raw.media_paths = assets
        item.media = guidata._media_from_message(raw)
        return True

    def _backfill_images(self, items: list[Any]) -> None:
        """导出写出前补齐子集里未解码的图片（Tk 导出时图片 path 齐全），期间发 progress。"""
        resolver = self._media_resolver
        if resolver is None:
            return
        targets = [it for it in items
                   if any(m.kind == "image" and not m.decoded for m in it.media)]
        total = len(targets)
        for done, item in enumerate(targets, 1):
            self._resolve_item_media(item, resolver)
            if done % 50 == 0 or done == total:      # 每 ~50 条一条 progress
                self._writer.emit({
                    "method": "progress",
                    "params": {
                        "phase": "resolve_media",
                        "done": done,
                        "total": total,
                        "message": f"解码图片 {done}/{total}",
                    },
                })


# ------------------------------------------------------------------ 工具

def _attach_media_resolver(store: Any, account: Any, work_dir: Path) -> Any | None:
    """按 Tk gui.py `_load_gui_worker` 的同一流程挂载 MediaResolver（懒解码版，docs/02 §1.2）。

    - 挂到 ``store.__dict__["_media_resolver"]`` 的是**薄代理** ``_LocateOnlyResolver``：
      ``model.iter_messages`` 逐条 resolve 时，图片**只定位不解码**、文件/视频/语音
      照常解析（解码挪到 resolve_media / export 按需——加载期全量解码 4720 图 ≈6.9min
      会顶穿壳 300s 超时）；
    - 返回**真实** MediaResolver，由 Sidecar 保存（``self._media_resolver``）：它只依赖
      work_dir / 微信目录里的文件，**store.close() 后仍可用**；
    - 图片密钥先离线推导（kvcomm code → md5(code+wxid)），失败时按 Tk 默认回退扫内存；
    - 解码产物只写 ``work_dir/decoded/<wxid>``（默认 sidecar/.cache），**绝不写微信目录**；
    - 创建失败只影响附件预览（与 Tk 的 try/except 一致），不阻断消息加载 → 返回 None。
    """
    try:
        from wxchart.media import MediaResolver

        resolver = MediaResolver(account, work_dir, set(MEDIA_INCLUDE))
    except Exception as exc:  # noqa: BLE001 - 附件解析失败只影响预览（同 Tk）
        _log("warn", f"附件解析初始化失败（仅影响图片/附件预览）: {exc}")
        return None
    store.__dict__["_media_resolver"] = _LocateOnlyResolver(resolver)
    try:
        # 与 Tk gui.py:657 一致：加载阶段先把图片密钥准备好，按需解码时不再阻塞。
        # progress 用空回调：密钥推导不单独占用 IPC progress（消息读取进度仍由
        # guidata.load_from_store 的 on_progress 发）。失败不阻断——按需解码时会重试。
        resolver.ensure_image_key(progress=lambda _message, _pct: None)
    except Exception as exc:  # noqa: BLE001
        _log("warn", f"图片密钥初始化失败（按需解码时重试）: {exc}")
    return resolver


# decoded 缓存文件名：32 位 md5（+ 可选变体后缀）+ 图片扩展名（解码产物，热缓存快路径）
_DECODED_NAME_RE = re.compile(r"^[0-9a-f]{32}(_t|_h|_full)?\.(jpg|png|gif|webp)$")
# 同一 md5 多个产物时的质量优先级：原图直解 > _full（HEVC 还原）> _h > _t（同 Tk 取向）
_DECODED_TAG_RANK = {"": 0, "_full": 1, "_h": 2, "_t": 3}


class _LocateOnlyResolver:
    """挂到 store 上的薄代理：图片**只定位不解码**，其余类型委托真实 MediaResolver。

    ``model.iter_messages`` 只调 ``resolve``；其余属性/方法经 ``__getattr__`` 全部转发。
    """

    def __init__(self, real: Any) -> None:
        self._real = real
        self._decoded_index: dict[str, Path] | None = None   # 热缓存索引（懒构建一次）

    def resolve(self, msg: Any) -> list[Any]:
        real = self._real
        mtype = getattr(msg, "type", "")
        if mtype not in getattr(real, "include", MEDIA_INCLUDE):
            return []
        if mtype == "image":
            if self._decoded_index is None:
                self._decoded_index = _build_decoded_index(Path(real.decoded_dir))
            return _locate_image(real, msg, self._decoded_index)
        return real.resolve(msg)               # 文件/视频/语音：照常解析

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)       # 其余（stats/decoded_dir/…）全部转发


def _build_decoded_index(decoded_dir: Path) -> dict[str, Path]:
    """热缓存快路径：decoded 目录**文件名**索引 {md5: path}（懒构建一次，不 stat、不改 stats）。"""
    idx: dict[str, Path] = {}
    try:
        entries = list(decoded_dir.iterdir())
    except OSError:
        return idx
    for p in entries:
        m = _DECODED_NAME_RE.match(p.name)
        if not m:
            continue
        md5, tag = p.name[:32], (m.group(1) or "")
        cur = idx.get(md5)
        if cur is None:
            idx[md5] = p
            continue
        cur_tag = (_DECODED_NAME_RE.match(cur.name).group(1) or "")
        if _DECODED_TAG_RANK[tag] < _DECODED_TAG_RANK[cur_tag]:
            idx[md5] = p
    return idx


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _locate_image(resolver: Any, msg: Any, decoded: dict[str, Path]) -> list[Any]:
    """图片**只定位不解码**（对照 media.MediaResolver._resolve_image 的定位段）。

    - md5 取 ``msg.image_md5``，缺省回退资源库（base=3，同 Tk）；无 md5 → []；
    - 热缓存（decoded 目录已有产物）→ 直接回填 decoded=True/path；
    - 否则定位 ``.dat``（原图 > _h > _t，同 Tk 优先级）→ decoded=False 待按需解码；
    - 不解码、**不碰 resolver.stats**。
    """
    md5 = getattr(msg, "image_md5", "") or resolver._resource_md5(msg, 3)
    if not md5:
        return []
    hit = decoded.get(md5)
    if hit is not None:
        return [MediaAsset(kind="image", src=str(hit), out_name=hit.name,
                           size=_file_size(hit), decoded=True)]
    paths = sorted(resolver._index_images().get(md5) or [],
                   key=lambda p: (p.stem.endswith("_t"), p.stem.endswith("_h")))
    if not paths:
        return [MediaAsset(kind="image", src="", out_name=f"{md5}.dat",
                           decoded=False, note="图片文件不在本机")]
    src = paths[0]
    return [MediaAsset(kind="image", src=str(src), out_name=src.name,
                       size=_file_size(src), decoded=False, note="图片待解码")]


def _discover_accounts(explicit: str | None) -> tuple[list[Any], list[str]]:
    """账号目录发现（docs/02 §1.2 2026-11-09 #13，scan 与 load 共用同一口径）。

    优先级：``WXCHART_XWECHAT_ROOT`` env（**操作者覆盖，最高**——测试/真机脚本靠它
    隔离数据）→ 显式 ``root``（用户设置 data_root，只试它不回落）→ 常见位置
    （``%APPDATA%\\Tencent\\xwechat_files``、``Documents\\WeChat Files``）→ 数据层默认
    路径；**首个命中即停**。返回 ``(accounts, tried)``——``tried`` 为已尝试位置，
    空结果时由前端展示可操作引导（A2 #30 不白屏口径）。
    """
    if os.environ.get("WXCHART_XWECHAT_ROOT"):
        roots = [Path(os.environ["WXCHART_XWECHAT_ROOT"])]
    elif isinstance(explicit, str) and explicit:
        roots = [Path(explicit)]
    else:
        roots = []
        appdata = os.environ.get("APPDATA")
        userprofile = os.environ.get("USERPROFILE")
        if appdata:
            roots.append(Path(appdata) / "Tencent" / "xwechat_files")
        if userprofile:
            roots.append(Path(userprofile) / "Documents" / "WeChat Files")
        roots.append(Path(DEFAULT_XWECHAT_ROOT))
    tried: list[str] = []
    accounts: list[Any] = []
    for r in roots:
        tried.append(str(r))
        accounts = config.discover_accounts(r)
        if accounts:
            return accounts, tried
    return [], tried


def _pick_account(accounts: list[Any], prefer: Any) -> Any:
    """显式账号选择：错误在分发层直接给出 NO_ACCOUNT / ACCOUNT_NOT_FOUND。"""
    if not accounts:
        raise SidecarError("NO_ACCOUNT", "没有发现微信账号目录（请先登录微信）")
    if prefer and prefer not in ("auto", ""):
        for a in accounts:
            if prefer in (a.wxid, a.username):
                return a
        raise SidecarError("ACCOUNT_NOT_FOUND", f"账号不存在: {prefer}")
    return accounts[0]


def _read_exported_at(out_dir: str) -> str:
    """导出完成时间（docs/02 §1.3 `exported_at`，Phase 2 信息卡）。

    读 ``<out_dir>/导出报告.json`` 的 ``finished_at`` → 回退 ``.wxchart-state.json``
    的 ``last_export``（exporter 两处同源写入）→ 均缺失/损坏回空串（省略键）。
    """
    root = Path(out_dir)
    for name, key in (("导出报告.json", "finished_at"), (".wxchart-state.json", "last_export")):
        try:
            data = json.loads((root / name).read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            continue
        val = data.get(key) if isinstance(data, dict) else None
        if isinstance(val, str) and val:
            return val
    return ""


def _error_frame(rid: Any, code: str, message: str, detail: str = "") -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if detail:
        err["detail"] = detail
    return {"id": rid, "error": err}


# ------------------------------------------------------------------ 主循环

def run(stdin: TextIO, writer: NdjsonWriter, sc: Sidecar) -> int:
    """NDJSON 主循环：逐行解析 → 分发 → 应答；stop 后正常返回，EOF 即退出。"""
    for line in stdin:
        raw = line.rstrip("\r\n")
        if not raw.strip():
            continue                                   # 空行忽略（docs/02 §1.1）
        if len(raw.encode("utf-8", errors="replace")) > MAX_FRAME:
            writer.emit(_error_frame(None, "BAD_FRAME", f"单帧超限（>{MAX_FRAME} 字节）"))
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as exc:
            writer.emit(_error_frame(None, "BAD_FRAME", f"JSON 解析失败: {exc}"))
            continue
        if not isinstance(req, dict):
            writer.emit(_error_frame(None, "BAD_FRAME", "请求必须是 JSON 对象"))
            continue
        if "id" not in req or not isinstance(req["id"], int) or isinstance(req["id"], bool):
            writer.emit(_error_frame(None, "BAD_FRAME", "请求缺少整数 id"))
            continue
        rid = req["id"]
        method = req.get("method")
        if not isinstance(method, str) or not method:
            writer.emit(_error_frame(rid, "BAD_FRAME", "请求缺少 method"))
            continue
        params = req.get("params")
        if params is None:
            params = {}
        if not isinstance(params, dict):
            writer.emit(_error_frame(rid, "INTERNAL", "params 必须是对象"))
            continue
        try:
            result = sc.handle(method, params)
        except Exception as exc:                        # noqa: BLE001 - 分发层统一兜底
            err = mapping.to_error(exc)
            writer.emit({"id": rid, "error": err})
            _log("error", f"{method} -> {err['code']}: {err['message']}")
            if not isinstance(exc, SidecarError):
                _log("debug", traceback.format_exc())
            continue
        writer.emit({"id": rid, "result": result})
        if method == "stop":
            _log("info", "收到 stop，退出")
            return 0
    return 0                                            # stdin EOF


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # Windows 控制台默认 GBK
        except (AttributeError, ValueError, OSError):
            pass
    writer = NdjsonWriter(sys.stdout)
    sc = Sidecar(writer)
    _log("info",
         f"wxchart sidecar 启动 protocol={PROTOCOL_VERSION} "
         f"app={APP_VERSION} python={platform.python_version()} max_frame={MAX_FRAME}")
    try:
        return run(sys.stdin, writer, sc)
    except KeyboardInterrupt:
        _log("info", "中断退出")
        return 0


if __name__ == "__main__":
    sys.exit(main())
