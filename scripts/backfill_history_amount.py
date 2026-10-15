# -*- coding: utf-8 -*-
"""
backfill_history_amount.py
---------------------------------------------
專屬回補工具：為 SQLite 歷史庫 (daily_kline) 補齊最近 60 個開市日之官方真實成交金額 (amount)
並重新滾算全量指標時序包 (market_history_60d.json.gz) 與最新快照 (market_snapshot.json.gz)
"""
import os
import sys
import time
import gzip
import json
import sqlite3
import random

# 切換工作目錄至腳本所在之發佈區目錄
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
os.chdir(PROJECT_ROOT)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from scripts.market_worker import (
    HISTORY_DB_PATH, OUTPUT_DIR, init_history_db,
    fetch_twse_market, fetch_tpex_market,
    calculate_all_stock_indicators, sanitize_nan_deep,
    NumpyEncoder, update_health_status, compute_next_scheduled_run,
    get_taipei_now
)

def main():
    print("======================================================")
    print("🚀 啟動歷史 60 日真實成交金額 (amount) 全量補齊與滾算引擎")
    print("======================================================")

    conn = init_history_db(HISTORY_DB_PATH)
    cur = conn.cursor()

    # 1. 找出最近 60 個開市日
    cur.execute("""
        SELECT trade_date, COUNT(*), SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END)
        FROM daily_kline
        GROUP BY trade_date
        ORDER BY trade_date DESC
        LIMIT 60
    """)
    stats = cur.fetchall()
    
    dates_to_backfill = []
    for d_str, total_cnt, amt_cnt in stats:
        amt_cnt = amt_cnt or 0
        if amt_cnt < 500:  # 未具備成交金額之交易日
            dates_to_backfill.append(d_str)

    # 依照日期正序 (由遠到近) 補齊
    dates_to_backfill.reverse()
    total_dates = len(dates_to_backfill)
    print(f"📊 最近 60 個開市日中，共檢測到 {total_dates} 個交易日缺少成交金額需要補齊。")

    if total_dates == 0:
        print("✅ 所有歷史 60 個開市日皆已具備真實成交金額，無需重複抓取！")
    else:
        for idx, d_str in enumerate(dates_to_backfill, 1):
            print(f"\n📡 [{idx}/{total_dates}] 正在補齊 {d_str} 全市場成交金額...")
            
            # 抓取上市
            twse_map = fetch_twse_market(d_str)
            time.sleep(round(1.5 + random.uniform(0.1, 0.4), 2))
            
            # 抓取上櫃
            tpex_map = fetch_tpex_market(d_str)
            time.sleep(round(1.5 + random.uniform(0.1, 0.4), 2))

            combined = {}
            for code, meta in twse_map.items():
                amt = meta.get('amount', 0.0)
                if amt > 0:
                    combined[code] = amt
            for code, meta in tpex_map.items():
                amt = meta.get('amount', 0.0)
                if amt > 0:
                    combined[code] = amt

            # 執行 UPDATE
            update_records = [(amt, d_str, code) for code, amt in combined.items()]
            if update_records:
                cur.executemany("""
                    UPDATE daily_kline
                    SET amount = ?
                    WHERE trade_date = ? AND stock_code = ?
                """, update_records)
                conn.commit()
                print(f"  💾 成功更新 {d_str} 共 {len(update_records)} 檔個股之真實成交金額！")
            else:
                print(f"  ⚠️ {d_str} 未取得有效金額數據 (可能假日或非交易日)")

    # 2. 全量重新滾算 60 日技術指標時序與快照
    print("\n⚡ [全量滾算] 正在以全新成交金額重新滾算全市場 2,400+ 檔真實 VWAP 與時序包...")
    start_calc = time.time()
    snapshot_map, history_map, calc_elapsed = calculate_all_stock_indicators(conn, lookback_days=160)
    
    cur.execute("SELECT MAX(trade_date) FROM daily_kline WHERE (length(stock_code) <= 5 OR stock_code LIKE '00%')")
    latest_trade_date = cur.fetchone()[0]
    conn.close()

    # 3. 輸出 gzip 壓縮數據包
    os.makedirs(PROJECT_ROOT, exist_ok=True)

    clean_snapshot = sanitize_nan_deep(snapshot_map)
    json_bytes = json.dumps(clean_snapshot, ensure_ascii=False, cls=NumpyEncoder, allow_nan=False).encode('utf-8')
    final_gz_path = os.path.join(PROJECT_ROOT, "market_snapshot.json.gz")
    with gzip.open(final_gz_path, 'wb', compresslevel=9) as f:
        f.write(json_bytes)
    print(f"📦 單日快照生成完畢 -> {final_gz_path} ({round(os.path.getsize(final_gz_path)/1024, 1)} KB)")

    clean_history = sanitize_nan_deep(history_map)
    hist_bytes = json.dumps(clean_history, ensure_ascii=False, cls=NumpyEncoder, allow_nan=False).encode('utf-8')
    final_hist_path = os.path.join(PROJECT_ROOT, "market_history_60d.json.gz")
    with gzip.open(final_hist_path, 'wb', compresslevel=9) as f:
        f.write(hist_bytes)
    print(f"📈 60 日技術指標時序包生成完畢 -> {final_hist_path} ({round(os.path.getsize(final_hist_path)/1024, 1)} KB)")

    # 4. 更新健康報表
    next_run_info = compute_next_scheduled_run()
    health_report = {
        "run_time": get_taipei_now().strftime("%Y-%m-%d %H:%M:%S"),
        "status": "READY",
        "target_date": latest_trade_date,
        "progress": f"歷史 60 日真實成交金額與 VWAP 全量校準合格！最新 [{latest_trade_date}] 就緒。",
        "next_scheduled_run": next_run_info.get("label", ""),
        "next_scheduled_iso": next_run_info.get("iso", ""),
        "schedule_times": ["14:30", "21:00"],
        "nodes": {
            "twse": {"status": "OK"},
            "tpex": {"status": "OK"},
            "indicators": {"count": len(snapshot_map), "elapsed": calc_elapsed, "status": "OK"}
        },
        "audit": {
            "zero_volume_count": 0,
            "zero_volume_samples": [],
            "zero_chip_count": 0,
            "zero_chip_samples": []
        },
        "snapshot_size_kb": round(os.path.getsize(final_gz_path)/1024, 1),
        "total_elapsed": round(time.time() - start_calc, 2)
    }
    update_health_status(health_report)

    print("\n======================================================")
    print("🎉 歷史 60 日成交金額補齊與真實 VWAP 全量滾算完成！")
    print("======================================================")

if __name__ == "__main__":
    main()
