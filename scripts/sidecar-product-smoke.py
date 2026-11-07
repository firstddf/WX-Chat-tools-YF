# -*- coding: utf-8 -*-
"""M-A4 产物独立冒烟：直接跑打包出的 wxchart-data exe（不经过壳、不依赖源码树）。

断言：
  1) ping          -> stdout 一行 JSON，result.protocol_version == 1
  2) scan_accounts -> result.accounts 为真实账号（微信在跑，本机 4 个）
  3) [--load]      -> load_source(kind=store) 真解密真解析出消息（验证冻结包内
                      pycryptodome/zstd/sqlcipher 可用；图片只定位不解码）
  4) [--export]    -> export(csv, indexes 子集) 落盘真实文件（隐含 --load）：
                      含图片下标 → 导出前补齐未解码图片（懒解码的导出对齐路径），
                      断言文件非空、行数正确、媒体列出现 decoded 解码路径
  5) stop          -> 正常退出（exit 0）

注意：load_source/export 会穿插无 id 的 progress 通知帧，call() 必须按 id 配对读帧。
用法: python scripts/sidecar-product-smoke.py <exe路径> [--load] [--export]
     （可先设 WXCHART_SIDECAR_WORK_DIR 指定解码缓存，验证环境变量钩子）
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path
import json
import subprocess
import sys
from pathlib import Path

# 控制台默认 GBK 会撞上消息里的 emoji/中文（首轮实测 UnicodeEncodeError 打断了 stop）
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # noqa: BLE001 - 非 TTY/旧环境忽略
        pass


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python scripts/sidecar-product-smoke.py <exe> [--load]")
        return 2
    exe = Path(sys.argv[1]).resolve()
    if not exe.is_file():
        print(f"FAIL exe not found: {exe}")
        return 2
    # cwd 故意选在 exe 之外（证明无工作目录/源码树相对路径依赖）；环境不带任何 WXCHART_* 钩子
    # （需要验证 WXCHART_SIDECAR_WORK_DIR 时由外层 shell 注入）
    proc = subprocess.Popen(
        [str(exe)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(exe.parent),
        encoding="utf-8",
        errors="replace",
    )

    def call(rid: int, method: str, params: dict | None = None) -> dict:
        req = json.dumps({"id": rid, "method": method, "params": params or {}})
        proc.stdin.write(req + "\n")
        proc.stdin.flush()
        while True:
            line = proc.stdout.readline()
            if not line:
                raise AssertionError(f"{method}: stdout EOF（无应答）")
            frame = json.loads(line)
            if frame.get("id") == rid:
                return frame
            # 无 id 的通知帧（progress 等）穿插在应答之间：记录后继续等
            safe = json.dumps(frame, ensure_ascii=False)
            print(f"  [notify] {safe[:160]}")

    failed = []
    try:
        ping = call(1, "ping")
        pv = (ping.get("result") or {}).get("protocol_version")
        print(f"ping -> {json.dumps(ping, ensure_ascii=False)}")
        if pv != 1:
            failed.append(f"ping protocol_version={pv!r} != 1")

        acc = call(2, "scan_accounts")
        accounts = (acc.get("result") or {}).get("accounts") or []
        ids = [a.get("wxid") or a.get("username") for a in accounts]
        print(f"scan_accounts -> {len(accounts)} accounts: {ids}")
        if len(accounts) != 4:
            failed.append(f"scan_accounts count={len(accounts)} != 4")

        msgs: list = []
        if "--load" in sys.argv and accounts:
            wxid = accounts[0].get("wxid") or accounts[0].get("username")
            load = call(
                3,
                "load_source",
                {
                    "kind": "store",
                    "account": wxid,
                    "options": {"resolve_media": True},
                },
            )
            if "error" in load:
                failed.append(f"load_source error: {load['error']}")
                print(f"load_source -> ERROR {json.dumps(load['error'], ensure_ascii=False)}")
            else:
                res = load.get("result") or {}
                msgs = res.get("messages") or []
                chats = res.get("chats") or []
                print(
                    f"load_source -> account={wxid} messages={len(msgs)} "
                    f"chats={len(chats)} (resolve_media=true, images locate-only)"
                )
                if not msgs:
                    failed.append("load_source messages=0（解密/解析失败？）")

        if "--export" in sys.argv:
            # 导出子集：优先含图片的下标（验证「导出前补齐未解码图片」的懒解码对齐路径），
            # 再补几条文本消息；范围小 → 冷缓存解码量可控（每批个位数图片）
            img_idx = [i for i, m in enumerate(msgs) if m.get("mtype") == "image"][:8]
            text_idx = [i for i, m in enumerate(msgs) if m.get("mtype") != "image"][:8]
            indexes = sorted(set(img_idx + text_idx))
            if not indexes:
                failed.append("--export: 无可导出的消息（需配合 --load）")
            else:
                out = Path(tempfile.mkdtemp(prefix="wxchart-smoke-")) / "export.csv"
                exp = call(
                    5,
                    "export",
                    {
                        "format": "csv",
                        "scope": {"type": "indexes", "indexes": indexes},
                        "out_path": str(out),
                    },
                )
                if "error" in exp:
                    failed.append(f"export error: {exp['error']}")
                    print(f"export -> ERROR {json.dumps(exp['error'], ensure_ascii=False)}")
                else:
                    eres = exp.get("result") or {}
                    ok_file = out.is_file() and out.stat().st_size > 0
                    text = out.read_text(encoding="utf-8-sig", errors="replace") if ok_file else ""
                    lines = [ln for ln in text.splitlines() if ln.strip()]
                    # 懒解码导出补齐的证据：CSV 里出现解码产物路径（decoded 目录/图片扩展名）
                    has_decoded = "decoded" in text or any(
                        ext in text for ext in (".jpg", ".png", ".webp", ".gif")
                    )
                    print(
                        f"export -> path={eres.get('path')} count={eres.get('count')} "
                        f"bytes={eres.get('bytes')} lines={len(lines)} "
                        f"images_in_subset={len(img_idx)} decoded_path_in_csv={has_decoded}"
                    )
                    if not ok_file:
                        failed.append("export 文件未落盘或为空")
                    if eres.get("count") != len(indexes):
                        failed.append(f"export count={eres.get('count')} != {len(indexes)}")
                    if len(lines) < 2:
                        failed.append(f"export CSV 行数 {len(lines)} < 2（表头+数据）")
                    if img_idx and not has_decoded:
                        failed.append("导出未见图片解码路径（懒解码的导出补齐未生效？）")

        stop = call(4, "stop")
        print(f"stop -> {json.dumps(stop, ensure_ascii=False)}")
    except Exception as exc:  # noqa: BLE001 - 冒烟脚本统一兜底
        failed.append(f"exception: {type(exc).__name__}: {exc}")
    finally:
        try:
            proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            failed.append("stop 后 5s 未退出（已 kill）")

    err = proc.stderr.read() or ""
    print("--- stderr ---")
    print(err.strip() or "(empty)")
    print(f"exit code: {proc.returncode}")
    if failed:
        print("SMOKE FAIL:")
        for f in failed:
            print(f"  - {f}")
        return 1
    print("SMOKE PASS (ping protocol_version=1, scan_accounts=4, stop clean)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
