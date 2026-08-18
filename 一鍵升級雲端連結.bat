@echo off
title 鈔能戰情室 - 升級雲端網址
echo ======================================================
echo 鈔能戰情室 - 升級雲端網址
echo ======================================================
echo.
echo 正在將本地資料庫的更新位址變更至 GitHub Pages...
echo.

python -c "import sqlite3, os; db='sentinel_vault.db'; conn=sqlite3.connect(db) if os.path.exists(db) else None; (conn.cursor().execute('CREATE TABLE IF NOT EXISTS update_config (key TEXT PRIMARY KEY, value TEXT)'), conn.cursor().execute('INSERT OR REPLACE INTO update_config (key, value) VALUES (\'version_url\', \'https://timlin7026.github.io/stock-sentinel/version_v2.txt\')'), conn.cursor().execute('INSERT OR REPLACE INTO update_config (key, value) VALUES (\'script_url\', \'https://timlin7026.github.io/stock-sentinel/鈔能雷達v2.zip\')'), conn.commit(), conn.close(), print('【成功】本地資料庫 sentinel_vault.db 已完成網址對齊！')) if conn else print('【錯誤】本目錄下找不到 sentinel_vault.db！\n請確認是否已將此 .bat 腳本放置在看盤程式（包含 sentinel_vault.db 的資料夾）下執行。')"

echo.
echo ======================================================
echo.
pause
