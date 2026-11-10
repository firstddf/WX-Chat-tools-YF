# docs/04 §E-8 Tk 侧 dump：真 `MessageView._build_plan` 的 headless 事件序列（#11）。
# wxchart-tool 永远只读——本脚本仅 import，不改仓内任何文件。
# 用法：python scripts/tk-plan-dump.py --tool-src <wxchart-tool/src> --root <数据根> \
#         --account <wxid> --out <dump.json> [--seed 20261110] [--sample 20]
# 口径：
#   - 开库/加载链路与 sidecar launcher._load_store 完全一致（config.discover_accounts →
#     keys.extract_keys → Store.prepare → model.load_contacts → model.load_chats →
#     guidata.load_from_store）→ 消息下标与 app 侧 data-index 天然对齐；
#   - plan 用 Tk 自己的 MessageView._build_plan（分组/日期/时间条/消息真 Tk 序列）；
#   - 气泡正文与 gui_chatview._draw_message 同口径：有引用 → quote body，否则
#     _message_text；system 行同 _draw_system 的正文来源。
from __future__ import annotations

import argparse
import json
import random
import sys
import tempfile
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tool-src", required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--account", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=20261110)
    ap.add_argument("--sample", type=int, default=20)
    args = ap.parse_args()
    sys.path.insert(0, args.tool_src)

    from wxchart import config, guidata, keys, model
    from wxchart.store import Store
    from wxchart.gui_chatview import MessageView, _message_text, _quote_of

    accounts = config.discover_accounts(Path(args.root))
    if not accounts:
        sys.exit(f"NO_ACCOUNT: {args.root}")
    account = None
    for a in accounts:
        if args.account in (getattr(a, "wxid", "") or "", getattr(a, "username", "") or ""):
            account = a
            break
    if account is None:
        sys.exit(f"ACCOUNT_NOT_FOUND: {args.account}（可选："
                 + ", ".join(str(getattr(a, "wxid", "")) for a in accounts) + "）")

    ks = keys.extract_keys(account.db_dir)          # 微信需在跑（KEY_NOT_FOUND 同 app）
    work = Path(tempfile.mkdtemp(prefix="tk-plan-dump-"))  # Store 要 Path（work_dir / "decrypted"）
    store = Store(account, work)
    try:
        store.prepare(ks)
        store.__dict__["_self_username"] = config.resolve_self_username(account)
        contacts = model.load_contacts(store)
        chats = list(model.load_chats(store, contacts))
        items = guidata.load_from_store(store, chats)
    finally:
        store.close()

    import tkinter as tk

    root = tk.Tk()
    root.withdraw()
    try:
        view = MessageView(root)                    # group_by_chat=True（同筛选页）
        view.set_messages(items)
        view._build_plan()
        plan = list(view._plan)
    finally:
        root.destroy()

    events: list[list[object]] = []
    by_index: dict[str, dict[str, str]] = {}
    group = day = time = ""
    for kind, payload in plan:
        if kind == "group":
            group = str(payload.get("chat") or payload.get("chat_id") or "")
            events.append(["group", group])
        elif kind == "day":
            day = str(payload)
            events.append(["day", day])
        elif kind == "time":
            time = str(payload)
            events.append(["time", time])
        elif kind == "msg":
            index, item = payload
            quote = _quote_of(item)
            body = str(quote.get("body") or "") if quote is not None else _message_text(item)
            events.append(["msg", index])
            by_index[str(index)] = {"group": group, "day": day, "time": time, "body": body}

    rng = random.Random(args.seed)
    all_idx = sorted(int(k) for k in by_index)
    sample = rng.sample(all_idx, min(args.sample, len(all_idx)))
    out = {
        "total_msgs": len(by_index),
        "events": events,
        "by_index": by_index,
        "seed": args.seed,
        "sample": sample,
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"OK msgs={len(by_index)} events={len(events)} sample={len(sample)} -> {args.out}")


if __name__ == "__main__":
    main()
