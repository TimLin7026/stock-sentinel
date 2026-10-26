#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
═══════════════════════════════════════════════════════════════════════════
🚀 台股戰情室 — 單一真理源自動加版號與發布助手 (publish_bump.py)
═══════════════════════════════════════════════════════════════════════════

📌 核心功能：
1. 單一真理源：一鍵自動計算並同步改寫 3 個核心檔案：
   • version_v2.txt（遠端版本偵測）
   • app.js（前端 appVersion 變數）
   • index.html（尾端 script 快取防護參數）
2. 實作前物理備份：自動將受影響檔案帶精確時間戳備份至 bak/ 目錄。
3. 三重檢驗閘門 (Triple-Check Gate)：寫入後重新讀取並嚴格比對，保證 100% 一致。
4. 選配一鍵 Git 推播：支援 --push 參數，自動 commit 並 push 至 GitHub。

💡 使用範例：
• 自動遞增版號並驗證：
    python publish_bump.py
• 試跑檢查（不實際寫入）：
    python publish_bump.py --dry-run
• 指定特定版號：
    python publish_bump.py v2.20261026.15
• 自動遞增並直接推播至 GitHub：
    python publish_bump.py --push "feat: update batch report ui"
"""

import os
import sys
import re
import shutil
import subprocess
from datetime import datetime

# 解決 Windows 控制台 cp950 無法輸出 Emoji 的問題
if sys.platform == "win32":
    import io
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass

# 目標目錄設定 (發佈區根目錄)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VERSION_FILE = os.path.join(BASE_DIR, "version_v2.txt")
APP_JS_FILE = os.path.join(BASE_DIR, "app.js")
INDEX_HTML_FILE = os.path.join(BASE_DIR, "index.html")
BAK_DIR = os.path.join(BASE_DIR, "bak")


def get_current_version():
    """讀取當前 version_v2.txt 中的版本號"""
    if os.path.exists(VERSION_FILE):
        with open(VERSION_FILE, "r", encoding="utf-8") as f:
            v = f.read().strip()
            if v:
                return v
    # 若 txt 不存在，嘗試從 app.js 讀取
    if os.path.exists(APP_JS_FILE):
        with open(APP_JS_FILE, "r", encoding="utf-8") as f:
            m = re.search(r"const\s+appVersion\s*=\s*ref\(['\"](v2\.[^'\"]+)['\"]\)", f.read())
            if m:
                return m.group(1)
    return "v2.20261026.01"


def calculate_next_version(current_ver):
    """根據當前日期與現有版本號，自動計算下一個流水號"""
    today_str = datetime.now().strftime("%Y%m%d")
    m = re.match(r"^v2\.(\d{8})\.(\d+)$", current_ver)
    if m:
        ver_date, ver_seq = m.group(1), int(m.group(2))
        if ver_date == today_str:
            new_seq = ver_seq + 1
            return f"v2.{today_str}.{new_seq:02d}"
        else:
            return f"v2.{today_str}.01"
    else:
        return f"v2.{today_str}.01"


def perform_physical_backup():
    """執行實作前物理備份至 bak/ 目錄"""
    os.makedirs(BAK_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backed_up = []
    for file_path, prefix, ext in [
        (VERSION_FILE, "version_v2", "txt"),
        (APP_JS_FILE, "app", "js"),
        (INDEX_HTML_FILE, "index", "html"),
    ]:
        if os.path.exists(file_path):
            dest_name = f"{prefix}_{ts}.{ext}"
            dest_path = os.path.join(BAK_DIR, dest_name)
            shutil.copy2(file_path, dest_path)
            backed_up.append(dest_name)
    print(f"💾 [物理備份完成] 已備份 {len(backed_up)} 個檔案至 bak/：")
    for b in backed_up:
        print(f"   • {b}")
    return ts


def bump_all_files(target_ver, dry_run=False):
    """同步改寫 3 個核心檔案並執行三重檢驗"""
    # 乾淨版號數字 (例如 2.20261026.12，去除開頭的 v)
    clean_v_num = target_ver.lstrip("v")

    print(f"\n🔄 準備將全站版本號推進至 ➔ [ {target_ver} ] (快取參數: v={clean_v_num})")

    if dry_run:
        print("⚠️ [Dry-Run 模式] 僅檢查與模擬，不實際寫入檔案。")

    # 1. 檢查檔案完整性
    for p, name in [(VERSION_FILE, "version_v2.txt"), (APP_JS_FILE, "app.js"), (INDEX_HTML_FILE, "index.html")]:
        if not os.path.exists(p):
            raise FileNotFoundError(f"❌ 找不到關鍵檔案: {name} (路徑: {p})")

    # 2. 備份
    if not dry_run:
        perform_physical_backup()

    # 3. 處理 version_v2.txt
    if not dry_run:
        with open(VERSION_FILE, "w", encoding="utf-8") as f:
            f.write(target_ver)
        print(f"✅ [1/3] 已更新 version_v2.txt ➔ {target_ver}")
    else:
        print(f"🔍 [模擬 1/3] 將寫入 version_v2.txt ➔ {target_ver}")

    # 4. 處理 app.js
    with open(APP_JS_FILE, "r", encoding="utf-8") as f:
        app_js_content = f.read()

    app_js_new, count_app = re.subn(
        r"(const\s+appVersion\s*=\s*ref\(['\"])(v2\.[^'\"]+)(['\"]\);)",
        rf"\g<1>{target_ver}\g<3>",
        app_js_content
    )
    if count_app == 0:
        raise ValueError("❌ 在 app.js 中找不到 const appVersion = ref('v2...') 變數，替換失敗！")

    if not dry_run:
        with open(APP_JS_FILE, "w", encoding="utf-8") as f:
            f.write(app_js_new)
        print(f"✅ [2/3] 已更新 app.js 中的 appVersion ➔ {target_ver}")
    else:
        print(f"🔍 [模擬 2/3] 將更新 app.js 中的 appVersion ➔ {target_ver} (匹配 {count_app} 處)")

    # 5. 處理 index.html
    with open(INDEX_HTML_FILE, "r", encoding="utf-8") as f:
        idx_content = f.read()

    idx_new, count_idx = re.subn(
        r'(<script\s+src=["\']app\.js\?v=)(2\.[^"\'\s>]+)(["\']></script>)',
        rf"\g<1>{clean_v_num}\g<3>",
        idx_content
    )
    if count_idx == 0:
        raise ValueError("❌ 在 index.html 中找不到 <script src=\"app.js?v=2...\"></script>，替換失敗！")

    if not dry_run:
        with open(INDEX_HTML_FILE, "w", encoding="utf-8") as f:
            f.write(idx_new)
        print(f"✅ [3/3] 已更新 index.html 中的快取參數 ➔ app.js?v={clean_v_num}")
    else:
        print(f"🔍 [模擬 3/3] 將更新 index.html 中的快取參數 ➔ app.js?v={clean_v_num} (匹配 {count_idx} 處)")

    # 6. 三重檢驗閘門 (Triple-Check Gate)
    if not dry_run:
        print("\n🛡️ 正在執行【三重檢驗閘門 (Triple-Check Gate)】...")
        with open(VERSION_FILE, "r", encoding="utf-8") as f:
            v_check = f.read().strip()
        with open(APP_JS_FILE, "r", encoding="utf-8") as f:
            m_app = re.search(r"const\s+appVersion\s*=\s*ref\(['\"](v2\.[^'\"]+)['\"]\);", f.read())
            app_check = m_app.group(1) if m_app else None
        with open(INDEX_HTML_FILE, "r", encoding="utf-8") as f:
            m_idx = re.search(r'<script\s+src=["\']app\.js\?v=(2\.[^"\'\s>]+)["\']></script>', f.read())
            idx_check = m_idx.group(1) if m_idx else None

        print(f"   • version_v2.txt 檢查值: {v_check}")
        print(f"   • app.js appVersion 檢查值: {app_check}")
        print(f"   • index.html 快取參數檢查值: {idx_check}")

        if v_check == target_ver and app_check == target_ver and idx_check == clean_v_num:
            print("🎉【三重檢驗 100% 通過！】三個檔案版號絕對精確對齊，無任何遺漏！\n")
            return True
        else:
            raise AssertionError(
                f"❌【校驗失敗！】版號不一致！\n"
                f"預期: {target_ver}\n"
                f"txt: {v_check}, app.js: {app_check}, index.html: {idx_check}"
            )
    return True


def run_git_push(commit_msg):
    """執行 Git 提交與推播"""
    print("🚀 正在執行 Git 提交與推播至 GitHub Pages...")
    try:
        subprocess.run(["git", "add", "version_v2.txt", "app.js", "index.html"], cwd=BASE_DIR, check=True)
        # 也把新增的腳本加入 git
        if os.path.exists(os.path.join(BASE_DIR, "publish_bump.py")):
            subprocess.run(["git", "add", "publish_bump.py"], cwd=BASE_DIR, check=True)
        if os.path.exists(os.path.join(BASE_DIR, "scripts", "sentinel_gemini_worker.gs")):
            subprocess.run(["git", "add", "scripts/sentinel_gemini_worker.gs"], cwd=BASE_DIR, check=True)
            
        full_msg = f"{commit_msg}"
        subprocess.run(["git", "commit", "-m", full_msg], cwd=BASE_DIR, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=BASE_DIR, check=True)
        print("✅ Git 提交與推播完成！GitHub Pages 將在 30~60 秒內完成全球 CDN 生效。")
    except subprocess.CalledProcessError as e:
        print(f"❌ Git 執行失敗: {e}")
        sys.exit(1)


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    push_mode = "--push" in args

    commit_msg = None
    target_ver = None

    # 解析參數
    idx = 0
    while idx < len(args):
        arg = args[idx]
        if arg == "--dry-run":
            dry_run = True
        elif arg == "--push":
            push_mode = True
            if idx + 1 < len(args) and not args[idx + 1].startswith("--"):
                commit_msg = args[idx + 1]
                idx += 1
        elif not arg.startswith("--"):
            target_ver = arg
        idx += 1

    current_ver = get_current_version()
    print(f"📌 當前版本號: [ {current_ver} ]")

    if not target_ver:
        target_ver = calculate_next_version(current_ver)

    if not re.match(r"^v2\.\d{8}\.\d{2,}$", target_ver):
        print(f"❌ 錯誤：版號格式不符合規範 (必須為 v2.YYYYMMDD.NN，例如 v2.20261026.13)！您輸入的是: {target_ver}")
        sys.exit(1)

    # 執行改版與三重檢驗
    success = bump_all_files(target_ver, dry_run=dry_run)

    if success and push_mode and not dry_run:
        if not commit_msg:
            commit_msg = f"bump: release version {target_ver}"
        else:
            commit_msg = f"{commit_msg} & bump to {target_ver}"
        run_git_push(commit_msg)


if __name__ == "__main__":
    main()
