# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包描述 —— wxchart-data sidecar（docs/03 §4 · M-A4）。

设计要点（与 docs/03 §4 决策一一对应）：
- **onedir**（EXE exclude_binaries + COLLECT）：不走 onefile——每次启动解压临时目录
  慢 1–3s 且易触发杀软误报；整目录随 Tauri 安装包分发，壳用绝对路径 spawn。
- **数据层只读引用** `../../wxchart-tool/src/wxchart`（Tk 仓库一行不改、不复制）；
  路径按 SPECPATH 推导，spec 在任意 cwd 下可重复执行。
- **剔除 tkinter/matplotlib**（数据层无 GUI；`wxchart.gui_chatview` 的 PIL.ImageTk
  不可达，一并剔除），省 ~15MB。
- **collect-all**：pycryptodome 的可导入包名是 `Crypto`——按 docs/03 原文写
  `--collect-all pycryptodome` 是**空操作**（2026-11-07 实测：0 项 + 3 条
  "not a package" 警告），故这里收集 `Crypto`，并滤掉 SelfTest 测试向量。
- **不进包**：`sidecar/.cache`（解码缓存）与 `sidecar/tests`（契约测试）——
  datas 显式为空列表、excludes 显式含 `tests`，包里只有 launcher/mapping 及其可达依赖。

用法（幂等，可重复执行）：
    cd sidecar
    python -m PyInstaller --noconfirm wxchart_data.spec
或直接跑 scripts/build-sidecar.ps1（构建 + 重命名 + 落 src-tauri/binaries/）。
"""
import os

from PyInstaller.utils.hooks import collect_all

# spec 所在目录（= wxchart-tauri/sidecar）；与调用时的 cwd 无关
SPEC_DIR = SPECPATH

# 数据层源码（Tk 仓库，只读引用）：与 launcher.py 的 `_HERE.parent.parent` 同一口径
TOOL_SRC = os.path.normpath(os.path.join(SPEC_DIR, "..", "..", "wxchart-tool", "src"))
if not os.path.isdir(os.path.join(TOOL_SRC, "wxchart")):
    raise SystemExit(f"[wxchart_data.spec] 找不到数据层源码: {TOOL_SRC}")

# --- pycryptodome（可导入包名 Crypto）：全部子模块 + 数据 + 动态库，剔除 SelfTest ---
_crypto_datas, _crypto_binaries, _crypto_hiddenimports = collect_all(
    "Crypto",
    filter_submodules=lambda name: not name.startswith("Crypto.SelfTest"),
    exclude_datas=["Crypto/SelfTest/*", "Crypto/SelfTest/**"],
)

# --- zstandard（model.py 解 zstd 压缩消息；动态 .pyd 一并收集） ---
_zstd_datas, _zstd_binaries, _zstd_hiddenimports = collect_all("zstandard")

a = Analysis(
    [os.path.join(SPEC_DIR, "launcher.py")],
    pathex=[SPEC_DIR, TOOL_SRC],
    binaries=[],
    # datas 显式为空基底：不收集 sidecar/.cache、sidecar/tests 等任意目录
    datas=[*_crypto_datas, *_zstd_datas],
    hiddenimports=[
        "wxchart",
        "mapping",
        *_crypto_hiddenimports,
        *_zstd_hiddenimports,
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "tests",              # sidecar/tests 不进包
        "wxchart.gui",        # Tk GUI 不可达（launcher 只用数据层）
        "wxchart.gui_tabs",
        "wxchart.gui_chatview",
        "wxchart.cli",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="wxchart-data",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="wxchart-data",
)
