#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🌱 歷史 K 線種子注入腳本 (seed_history_db.py)
=============================================
功能：
1. 掃描本機 data/ 目錄下的 118+ 天全市場 6 大 JSON (twse/tpex price, inst, margin)
2. 批量解析 2,400+ 檔台股每日開高低收、成交量、三大法人買賣超與融資餘額
3. 高效灌入 scripts/market_history.db 的 daily_kline 資料表
4. 建立 (stock_code, trade_date) 複合索引並執行 VACUUM，為雲端大腦提供完整的歷史計算深度
"""

import os
import sys
import json
import glob
import re
import time
import sqlite3

# 強制 UTF-8 輸出
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_FOLDER = os.path.join(PROJECT_ROOT, "data")
DB_PATH = os.path.join(BASE_DIR, "market_history.db")

def safe_float(v, default=0.0):
    if v is None: return default
    s = str(v).replace(',', '').strip()
    clean_v = re.sub(r'[^\d.-]', '', s)
    try:
        return float(clean_v) if clean_v else default
    except:
        return default

def safe_int(v, default=0):
    if v is None: return default
    s = str(v).replace(',', '').strip()
    clean_v = re.sub(r'[^\d.-]', '', s)
    try:
        return int(float(clean_v)) if clean_v else default
    except:
        return default

def init_db(conn):
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS daily_kline (
            trade_date TEXT NOT NULL,
            stock_code TEXT NOT NULL,
            stock_name TEXT,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER,
            foreign_buy INTEGER DEFAULT 0,
            sitc_buy INTEGER DEFAULT 0,
            dealers_buy INTEGER DEFAULT 0,
            margin_balance INTEGER DEFAULT 0,
            mkt TEXT,
            market_type TEXT,
            PRIMARY KEY (stock_code, trade_date)
        )
    """)
    conn.commit()

def parse_market_day(d_fmt):
    """
    解析指定日期 (YYYY-MM-DD) 的 6 大 JSON 檔案
    回傳 dict: { stock_code: record_tuple }
    """
    d_clean = d_fmt.replace("-", "")
    files = {
        "twse_p": os.path.join(DATA_FOLDER, f"twse_price_{d_fmt}.json"),
        "twse_i": os.path.join(DATA_FOLDER, f"twse_inst_{d_fmt}.json"),
        "twse_m": os.path.join(DATA_FOLDER, f"twse_margin_{d_fmt}.json"),
        "tpex_p": os.path.join(DATA_FOLDER, f"tpex_price_{d_fmt}.json"),
        "tpex_i": os.path.join(DATA_FOLDER, f"tpex_inst_{d_fmt}.json"),
        "tpex_m": os.path.join(DATA_FOLDER, f"tpex_margin_{d_fmt}.json")
    }

    stock_map = {}

    # 1. 解析上市價量 (TWSE Price)
    if os.path.exists(files["twse_p"]):
        try:
            with open(files["twse_p"], "r", encoding="utf-8") as f:
                jr = json.load(f)
            stock_rows = []
            for t in jr.get("tables", []):
                if "每日收盤行情" in t.get("title", ""):
                    stock_rows = t.get("data", [])
                    break
            if not stock_rows and "data9" in jr:
                stock_rows = jr["data9"]

            for row in stock_rows:
                code = str(row[0]).strip()
                if not code or len(code) > 6:
                    continue
                name = str(row[1]).strip()
                vol = safe_int(row[2])
                o = safe_float(row[5])
                h = safe_float(row[6])
                l = safe_float(row[7])
                c = safe_float(row[8])
                stock_map[code] = {
                    "trade_date": d_clean, "stock_code": code, "stock_name": name,
                    "open": o, "high": h, "low": l, "close": c, "volume": vol,
                    "foreign_buy": 0, "sitc_buy": 0, "dealers_buy": 0,
                    "margin_balance": 0, "mkt": "TSE"
                }
        except Exception as e:
            print(f"⚠️ 解析 {files['twse_p']} 異常: {e}")

    # 2. 解析上櫃價量 (TPEx Price)
    if os.path.exists(files["tpex_p"]):
        try:
            with open(files["tpex_p"], "r", encoding="utf-8") as f:
                jr = json.load(f)
            stock_rows = jr.get("tables", [{}])[0].get("data", []) if "tables" in jr else jr.get("aaData", [])
            for row in stock_rows:
                code = str(row[0]).strip()
                if not code or len(code) > 6:
                    continue
                name = str(row[1]).strip()
                c = safe_float(row[2])
                o = safe_float(row[4])
                h = safe_float(row[5])
                l = safe_float(row[6])
                vol = safe_int(row[7])
                stock_map[code] = {
                    "trade_date": d_clean, "stock_code": code, "stock_name": name,
                    "open": o, "high": h, "low": l, "close": c, "volume": vol,
                    "foreign_buy": 0, "sitc_buy": 0, "dealers_buy": 0,
                    "margin_balance": 0, "mkt": "OTC"
                }
        except Exception as e:
            print(f"⚠️ 解析 {files['tpex_p']} 異常: {e}")

    # 3. 解析上市法人 (TWSE Inst)
    if os.path.exists(files["twse_i"]):
        try:
            with open(files["twse_i"], "r", encoding="utf-8") as f:
                jr = json.load(f)
            rows = jr.get("data", []) if "data" in jr else jr.get("tables", [{}])[0].get("data", [])
            for row in rows:
                code = str(row[0]).strip()
                if code in stock_map:
                    stock_map[code]["foreign_buy"] = safe_int(row[4]) if len(row) > 4 else 0
                    stock_map[code]["sitc_buy"] = safe_int(row[7]) if len(row) > 7 else 0
                    stock_map[code]["dealers_buy"] = safe_int(row[11]) if len(row) > 11 else (safe_int(row[10]) if len(row) > 10 else 0)
        except Exception as e:
            pass

    # 4. 解析上櫃法人 (TPEx Inst)
    if os.path.exists(files["tpex_i"]):
        try:
            with open(files["tpex_i"], "r", encoding="utf-8") as f:
                jr = json.load(f)
            rows = jr.get("tables", [{}])[0].get("data", []) if "tables" in jr else jr.get("aaData", [])
            for row in rows:
                code = str(row[0]).strip()
                if code in stock_map and len(row) >= 23:
                    stock_map[code]["foreign_buy"] = safe_int(row[10])
                    stock_map[code]["sitc_buy"] = safe_int(row[13])
                    stock_map[code]["dealers_buy"] = safe_int(row[22])
        except Exception as e:
            pass

    # 5. 解析上市融資 (TWSE Margin)
    if os.path.exists(files["twse_m"]):
        try:
            with open(files["twse_m"], "r", encoding="utf-8") as f:
                jr = json.load(f)
            target_data = []
            if "tables" in jr:
                t_table = next((t for t in jr["tables"] if isinstance(t, dict) and "data" in t and len(t.get("data", [])) > 100), None)
                if t_table: target_data = t_table["data"]
            else:
                target_data = jr.get("data7") if jr.get("data7") else jr.get("data", [])
            for row in target_data:
                code = str(row[0]).strip()
                if code in stock_map and len(row) > 5:
                    stock_map[code]["margin_balance"] = safe_int(row[5])
        except Exception as e:
            pass

    # 6. 解析上櫃融資 (TPEx Margin)
    if os.path.exists(files["tpex_m"]):
        try:
            with open(files["tpex_m"], "r", encoding="utf-8") as f:
                jr = json.load(f)
            rows = jr.get("tables", [{}])[0].get("data", []) if "tables" in jr else jr.get("aaData", [])
            for row in rows:
                code = str(row[0]).strip()
                if code in stock_map and len(row) > 6:
                    stock_map[code]["margin_balance"] = safe_int(row[6])
        except Exception as e:
            pass

    return stock_map

def main():
    print("🌱 [種子注入] 正在啟動台股歷史日 K 線種子注入程序...")
    start_t = time.time()
    
    if not os.path.exists(DATA_FOLDER):
        print(f"❌ 找不到資料來源目錄: {DATA_FOLDER}")
        return

    # 搜尋所有 twse_price_*.json
    files = glob.glob(os.path.join(DATA_FOLDER, "twse_price_*.json"))
    dates = []
    for f in files:
        base = os.path.basename(f)
        m = re.search(r'twse_price_(\d{4}-\d{2}-\d{2})\.json', base)
        if m:
            dates.append(m.group(1))
    
    dates = sorted(list(set(dates)))
    print(f"📊 掃描到 {len(dates)} 個歷史交易日資料 (從 {dates[0]} 至 {dates[-1]})")

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    total_inserted = 0
    batch_records = []

    for idx, d_fmt in enumerate(dates):
        day_map = parse_market_day(d_fmt)
        for s in day_map.values():
            batch_records.append((
                s["trade_date"], s["stock_code"], s["stock_name"],
                s["open"], s["high"], s["low"], s["close"], s["volume"],
                s["foreign_buy"], s["sitc_buy"], s["dealers_buy"], s["margin_balance"],
                s["mkt"], s["mkt"]
            ))

        if len(batch_records) >= 50000:
            cur = conn.cursor()
            cur.executemany("""
                INSERT OR REPLACE INTO daily_kline (
                    trade_date, stock_code, stock_name,
                    open, high, low, close, volume,
                    foreign_buy, sitc_buy, dealers_buy, margin_balance,
                    mkt, market_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, batch_records)
            conn.commit()
            total_inserted += len(batch_records)
            batch_records = []
            print(f"  ⏳ 已處理 {idx+1}/{len(dates)} 日 ({d_fmt})... 累積寫入 {total_inserted} 筆")

    if batch_records:
        cur = conn.cursor()
        cur.executemany("""
            INSERT OR REPLACE INTO daily_kline (
                trade_date, stock_code, stock_name,
                open, high, low, close, volume,
                foreign_buy, sitc_buy, dealers_buy, margin_balance,
                mkt, market_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, batch_records)
        conn.commit()
        total_inserted += len(batch_records)

    print("⚡ [索引] 正在建立高速複合索引...")
    cur = conn.cursor()
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_date ON daily_kline (stock_code, trade_date ASC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trade_date ON daily_kline (trade_date)")
    conn.commit()

    print("🧹 [瘦身] 正在執行 VACUUM 最佳化磁碟空間...")
    cur.execute("VACUUM")
    conn.commit()

    # 統計結果
    cur.execute("SELECT COUNT(*), COUNT(DISTINCT stock_code), COUNT(DISTINCT trade_date), MIN(trade_date), MAX(trade_date) FROM daily_kline")
    cnt, stocks, trade_days, min_d, max_d = cur.fetchone()
    conn.close()

    db_size_mb = os.path.getsize(DB_PATH) / (1024 * 1024)
    cost = time.time() - start_t
    print(f"\n🎉 [成功] 歷史種子注入完成！耗時: {cost:.2f} 秒")
    print(f"📦 資料庫路徑: {DB_PATH} ({db_size_mb:.2f} MB)")
    print(f"📈 總紀錄筆數: {cnt:,} 筆")
    print(f"🏢 涵蓋股票數: {stocks:,} 檔")
    print(f"📅 歷史交易日: {trade_days} 天 (從 {min_d} 到 {max_d})")

if __name__ == "__main__":
    main()
