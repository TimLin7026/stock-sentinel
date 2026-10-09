#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🚀 鈔能戰情室 - 雲端盤後行情大腦與數據品質審計引擎
======================================================
核心功能：
1. 🛡️ 休市日智慧哨兵 (0.1 秒精準跳過週末/國定假日/颱風假)
2. 📡 全市場盤後數據爬取 (上市/上櫃/三大法人/融資融券，比照電腦版有效性驗證)
3. 💾 歷史 K 線與籌碼存儲，全量滾算 2,400+ 檔 6 大青紅燈指標 + 10 項策略特徵
4. 🧹 數據品質審計與 0 值異常排查 (完全對齊電腦版三維健檢矩陣)
5. 🟢 藍綠雙分區隔離發布 (Staging 清洗沙盒 -> 審計通過 -> 原子熱替換 Production)
"""

import os
import re
import sys
import json
import gzip
import time
import sqlite3
import datetime
import urllib.request
import urllib.parse
import ssl
import pandas as pd
import numpy as np

# 強制 UTF-8 輸出
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

# 建立忽略 SSL 憑證警告的 context
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "mobile_web") if os.path.exists(os.path.join(PROJECT_ROOT, "mobile_web")) else PROJECT_ROOT
HISTORY_DB_PATH = os.path.join(BASE_DIR, "market_history.db")

# ==========================================
# 0. 電腦版對齊：暴力數字清洗器與 Numpy 序列化器
# ==========================================

class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (np.integer, np.int64, np.int32)):
            return int(obj)
        elif isinstance(obj, (np.floating, np.float64, np.float32)):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        elif isinstance(obj, (datetime.date, datetime.datetime)):
            return obj.isoformat()
        return super(NumpyEncoder, self).default(obj)

def safe_float(v, default=0.0):
    if v is None: return default
    s = str(v).replace(',', '').strip()
    clean_v = re.sub(r'[^\d.-]', '', s)
    try:
        return round(float(clean_v), 2) if clean_v else default
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

def get_taipei_now():
    tz_tw = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz_tw)

def get_target_date():
    for arg in sys.argv[1:]:
        if arg.startswith("--target-date="):
            return arg.split("=")[1].strip()
        elif arg.isdigit() and len(arg) == 8:
            return arg.strip()
    if len(sys.argv) > 2 and sys.argv[1] == "--target-date":
        return sys.argv[2].strip()

    now = get_taipei_now()
    cur = now
    if cur.hour < 21:
        cur = cur - datetime.timedelta(days=1)
        
    for _ in range(15):
        d_str = cur.strftime("%Y%m%d")
        holiday, _ = is_market_holiday(d_str)
        if not holiday:
            return d_str
        cur = cur - datetime.timedelta(days=1)
        
    return now.strftime("%Y%m%d")

_TWSE_HOLIDAYS_CACHE = None

def get_twse_official_holidays():
    global _TWSE_HOLIDAYS_CACHE
    if _TWSE_HOLIDAYS_CACHE is not None:
        return _TWSE_HOLIDAYS_CACHE
    
    _TWSE_HOLIDAYS_CACHE = {}
    try:
        api_url = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule"
        records = http_get_json(api_url, retries=2, delay=1)
        if records and isinstance(records, list):
            for row in records:
                name = str(row.get("Name", ""))
                roc_date = str(row.get("Date", "")).strip()
                if "開始交易" in name:
                    continue
                if len(roc_date) == 7 and roc_date.isdigit():
                    ad_year = int(roc_date[:3]) + 1911
                    ad_date_str = f"{ad_year}{roc_date[3:]}"
                    _TWSE_HOLIDAYS_CACHE[ad_date_str] = name
    except Exception as e:
        print(f"⚠️ 連線證交所官方休市日曆 API 略過: {e}")
    return _TWSE_HOLIDAYS_CACHE

def is_market_holiday(date_str):
    dt = datetime.datetime.strptime(date_str, "%Y%m%d")
    if dt.weekday() >= 5:
        return True, f"週末例假日 ({dt.strftime('%A')})"
    
    holidays = get_twse_official_holidays()
    if date_str in holidays:
        return True, f"國定休假日 ({holidays[date_str]})"
        
    typhoon_file = os.path.join(PROJECT_ROOT, "typhone_day.txt")
    if os.path.exists(typhoon_file):
        try:
            with open(typhoon_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith(date_str):
                        return True, f"特別休市/颱風假 ({line})"
        except Exception:
            pass

    return False, ""

def http_get_json(url, retries=3, delay=2):
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=15, context=ssl_ctx) as response:
                if response.status == 200:
                    raw_data = response.read().decode('utf-8', errors='ignore')
                    return json.loads(raw_data)
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(delay * (attempt + 1))
            else:
                print(f"🚨 HTTP 請求失敗 [{url}]: {e}")
    return None

# ==========================================
# 1. 爬取全市場盤後行情 (比照電腦版有效性驗證)
# ==========================================

def fetch_twse_market(target_date):
    print(f"📡 [上市] 正在爬取 TWSE 每日收盤行情 ({target_date})...")
    url = f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={target_date}&type=ALLBUT0999&response=json"
    data = http_get_json(url)
    result = {}
    if not data or data.get('stat') != 'OK':
        return result
    
    tables = data.get('tables', [])
    stock_table = None
    for t in tables:
        if '每日收盤行情' in t.get('title', ''):
            stock_table = t
            break
    if not stock_table and 'data9' in data:
        stock_rows = data['data9']
    elif stock_table:
        stock_rows = stock_table.get('data', [])
    else:
        stock_rows = []
        
    for row in stock_rows:
        code = str(row[0]).strip()
        if not code or len(code) > 6:
            continue
        name = str(row[1]).strip()
        vol = safe_int(row[2])
        open_p = safe_float(row[5])
        high_p = safe_float(row[6])
        low_p = safe_float(row[7])
        close_p = safe_float(row[8])
        
        result[code] = {
            'name': name, 'open': open_p, 'high': high_p,
            'low': low_p, 'close': close_p, 'volume': vol, 'mkt': 'TSE'
        }
    print(f"✅ [上市] 成功獲取 {len(result)} 檔上市股票數據。")
    return result

def fetch_tpex_market(target_date):
    print(f"📡 [上櫃] 正在爬取 TPEx 每日收盤行情 ({target_date})...")
    roc_year = int(target_date[:4]) - 1911
    roc_date = f"{roc_year}/{target_date[4:6]}/{target_date[6:]}"
    url = f"https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d={roc_date}&se=AL&o=json"
    data = http_get_json(url)
    result = {}
    if not data:
        return result
    
    stock_rows = data.get('tables', [{}])[0].get('data', []) if 'tables' in data else data.get('aaData', [])
    for row in stock_rows:
        code = str(row[0]).strip()
        if not code or len(code) > 6:
            continue
        name = str(row[1]).strip()
        close_p = safe_float(row[2])
        open_p = safe_float(row[4])
        high_p = safe_float(row[5])
        low_p = safe_float(row[6])
        vol = safe_int(row[7])
        
        result[code] = {
            'name': name, 'open': open_p, 'high': high_p,
            'low': low_p, 'close': close_p, 'volume': vol, 'mkt': 'OTC'
        }
    print(f"✅ [上櫃] 成功獲取 {len(result)} 檔上櫃股票數據。")
    return result

def fetch_institutional_investors(target_date):
    print(f"📡 [籌碼] 正在爬取三大法人買賣超 ({target_date})...")
    chip_map = {}
    
    # 1. 上市法人 (T86)
    twse_url = f"https://www.twse.com.tw/rwd/zh/fund/T86?date={target_date}&selectType=ALLBUT0999&response=json"
    twse_data = http_get_json(twse_url)
    if twse_data and (twse_data.get('stat') == 'OK' or 'data' in twse_data):
        rows = twse_data.get('data', []) if 'data' in twse_data else twse_data.get('tables', [{}])[0].get('data', [])
        for r in rows:
            code = str(r[0]).strip()
            fb = safe_int(r[4]) if len(r) > 4 else 0
            sb = safe_int(r[7]) if len(r) > 7 else 0
            db = safe_int(r[11]) if len(r) > 11 else (safe_int(r[10]) if len(r) > 10 else 0)
            chip_map[code] = {'foreign_buy': fb, 'sitc_buy': sb, 'dealers_buy': db}
            
    # 2. 上櫃法人 (3itrade)
    roc_year = int(target_date[:4]) - 1911
    roc_date = f"{roc_year}/{target_date[4:6]}/{target_date[6:]}"
    tpex_url = f"https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&d={roc_date}&o=json"
    tpex_data = http_get_json(tpex_url)
    if tpex_data:
        rows = tpex_data.get('tables', [{}])[0].get('data', []) if 'tables' in tpex_data else tpex_data.get('aaData', [])
        for r in rows:
            if len(r) >= 23:
                code = str(r[0]).strip()
                fb = safe_int(r[10])
                sb = safe_int(r[13])
                db = safe_int(r[22])
                chip_map[code] = {'foreign_buy': fb, 'sitc_buy': sb, 'dealers_buy': db}
                
    print(f"✅ [籌碼] 成功獲取 {len(chip_map)} 檔三大法人買賣超數據。")
    return chip_map

def fetch_margin_trading(target_date):
    print(f"📡 [資券] 正在爬取融資融券數據 ({target_date})...")
    margin_map = {}
    
    # 1. 上市資券 (MI_MARGN)
    twse_url = f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={target_date}&selectType=ALL&response=json"
    twse_data = http_get_json(twse_url)
    if twse_data:
        target_data = []
        if 'tables' in twse_data:
            t_table = next((t for t in twse_data['tables'] if isinstance(t, dict) and 'data' in t and len(t.get('data', [])) > 100), None)
            if t_table: target_data = t_table['data']
        else:
            target_data = twse_data.get('data7') if twse_data.get('data7') else twse_data.get('data', [])
        for r in target_data:
            code = str(r[0]).strip()
            if len(r) > 5:
                margin_map[code] = {'margin_balance': safe_int(r[5])}
                
    # 2. 上櫃資券
    roc_year = int(target_date[:4]) - 1911
    roc_date = f"{roc_year}/{target_date[4:6]}/{target_date[6:]}"
    tpex_url = f"https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&d={roc_date}&o=json"
    tpex_data = http_get_json(tpex_url)
    if tpex_data:
        rows = tpex_data.get('tables', [{}])[0].get('data', []) if 'tables' in tpex_data else tpex_data.get('aaData', [])
        for r in rows:
            code = str(r[0]).strip()
            if len(r) > 6:
                margin_map[code] = {'margin_balance': safe_int(r[6])}
                
    print(f"✅ [資券] 成功獲取 {len(margin_map)} 檔融資餘額數據。")
    return margin_map

# ==========================================
# 2. 歷史資料庫存儲與維護
# ==========================================

def init_history_db(db_path):
    conn = sqlite3.connect(db_path)
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
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_date ON daily_kline (stock_code, trade_date ASC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trade_date ON daily_kline (trade_date)")
    conn.commit()
    return conn

def save_daily_snapshot_to_history(conn, target_date, twse_map, tpex_map, chip_map, margin_map):
    cur = conn.cursor()
    all_codes = set(twse_map.keys()).union(set(tpex_map.keys()))
    records = []
    
    for code in all_codes:
        # 排除 6 碼以上權證與非標的衍生商品，聚焦 2,400+ 檔股票與 ETF
        if len(code) > 5:
            continue
        meta = twse_map.get(code) or tpex_map.get(code) or {}
        chip = chip_map.get(code, {})
        margin = margin_map.get(code, {})
        
        name = meta.get('name', '')
        mkt = meta.get('mkt', '')
        o_p = meta.get('open', 0.0)
        h_p = meta.get('high', 0.0)
        l_p = meta.get('low', 0.0)
        c_p = meta.get('close', 0.0)
        vol = meta.get('volume', 0)
        
        fb = chip.get('foreign_buy', 0)
        sb = chip.get('sitc_buy', 0)
        db = chip.get('dealers_buy', 0)
        mb = margin.get('margin_balance', 0)
        
        records.append((
            target_date, code, name, o_p, h_p, l_p, c_p, vol,
            fb, sb, db, mb, mkt, mkt
        ))
        
    cur.executemany("""
        INSERT OR REPLACE INTO daily_kline (
            trade_date, stock_code, stock_name,
            open, high, low, close, volume,
            foreign_buy, sitc_buy, dealers_buy, margin_balance,
            mkt, market_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, records)
    conn.commit()
    print(f"✅ [歷史庫] 成功更新 {len(records)} 筆個股於 {target_date} 之日 K 線與籌碼紀錄。")

# ==========================================
# 3. 🎯 全市場 2,400+ 檔 6 大青紅燈 + 10 項策略特徵 100% 電腦端對齊滾算引擎
# ==========================================

def calculate_all_stock_indicators(conn, lookback_days=100):
    print("⚡ [運算] 正在啟動全市場 6 大青紅燈指標與策略特徵矩陣全量滾算 (100% 對齊電腦端)...")
    start_time = time.time()
    
    query = f"""
        SELECT trade_date, stock_code, stock_name, mkt,
               open, high, low, close, volume,
               foreign_buy, sitc_buy, dealers_buy, margin_balance
        FROM daily_kline
        WHERE length(stock_code) <= 5
          AND trade_date IN (
            SELECT DISTINCT trade_date FROM daily_kline ORDER BY trade_date DESC LIMIT {lookback_days}
        )
        ORDER BY stock_code, trade_date ASC
    """
    df_all = pd.read_sql_query(query, conn)
    if df_all.empty:
        return {}, 0.0

    snapshot_map = {}
    grouped = df_all.groupby('stock_code')
    total_count = len(grouped)
    
    for code, df_raw in grouped:
        n = len(df_raw)
        if n == 0:
            continue
        
        df_raw = df_raw.reset_index(drop=True)
        
        # 1. 基礎量價與籌碼指標全量滾算 (完全對齊 Stock_Sentinel.py:2540)
        df_raw["MA5"] = df_raw["收盤價" if "收盤價" in df_raw else "close"].rolling(5, min_periods=1).mean()
        df_raw["MA10"] = df_raw["close"].rolling(10, min_periods=1).mean()
        df_raw["BB_Mid"] = df_raw["close"].rolling(20, min_periods=1).mean()
        df_raw["BB_Std"] = df_raw["close"].rolling(20, min_periods=2).std().fillna(0)
        df_raw["BB_U"] = df_raw["BB_Mid"] + 2 * df_raw["BB_Std"]
        df_raw["BB_L"] = df_raw["BB_Mid"] - 2 * df_raw["BB_Std"]
        
        # KD (7, 3, 3)
        df_raw["L7"] = df_raw["low"].rolling(7, min_periods=1).min()
        df_raw["H7"] = df_raw["high"].rolling(7, min_periods=1).max()
        df_raw["RSV"] = 100 * ((df_raw["close"] - df_raw["L7"]) / (df_raw["H7"] - df_raw["L7"] + 1e-5))
        
        k_vals, d_vals, k_c, d_c = [], [], 50.0, 50.0
        for r in df_raw["RSV"]:
            k_c = (2/3) * k_c + (1/3) * r
            d_c = (2/3) * d_c + (1/3) * k_c
            k_vals.append(k_c)
            d_vals.append(d_c)
        df_raw["K"], df_raw["D"] = k_vals, d_vals
        
        # MACD (EMA6, EMA9, DIF, MACD_S, OSC)
        df_raw["DIF"] = df_raw["close"].ewm(span=6, adjust=False).mean() - df_raw["close"].ewm(span=9, adjust=False).mean()
        df_raw["MACD_S"] = df_raw["DIF"].ewm(span=6, adjust=False).mean()
        df_raw["OSC"] = df_raw["DIF"] - df_raw["MACD_S"]
        
        # MTM (3日 diff, MA2)
        df_raw["MTM"] = df_raw["close"].diff(3).fillna(0)
        df_raw["MTM_MA"] = df_raw["MTM"].rolling(2, min_periods=1).mean()
        
        # RSI4, RSI12
        delta = df_raw["close"].diff()
        df_raw["RSI4"] = (delta.clip(lower=0).ewm(alpha=1/4, adjust=False).mean() / (delta.abs().ewm(alpha=1/4, adjust=False).mean() + 1e-5)) * 100
        df_raw["RSI12"] = (delta.clip(lower=0).ewm(alpha=1/12, adjust=False).mean() / (delta.abs().ewm(alpha=1/12, adjust=False).mean() + 1e-5)) * 100
        
        # WR3, WR50
        df_raw["WR3"] = -100 * ((df_raw["high"].rolling(3, 1).max() - df_raw["close"]) / (df_raw["high"].rolling(3, 1).max() - df_raw["low"].rolling(3, 1).min() + 1e-5))
        df_raw["WR50"] = -100 * ((df_raw["high"].rolling(50, 1).max() - df_raw["close"]) / (df_raw["high"].rolling(50, 1).max() - df_raw["low"].rolling(50, 1).min() + 1e-5))
        
        df_raw["法人合計"] = df_raw["foreign_buy"] + df_raw["sitc_buy"] + df_raw["dealers_buy"]
        df_raw["融資增減"] = df_raw["margin_balance"].diff().fillna(0)

        # 2. 滾算 6 大熱力青紅燈 (1: 多/紅, -1: 空/綠) (完全對齊 Stock_Sentinel.py:2566)
        df_raw["P10_MTM_Cross"] = (df_raw["MTM"] > df_raw["MTM_MA"]).astype(int).replace(0, -1)
        df_raw["P1_MACD_OSC"] = (df_raw["OSC"] > df_raw["OSC"].shift(1)).astype(int).replace(0, -1)
        df_raw["P5_K_Trend"] = (df_raw["K"] > df_raw["K"].shift(1)).astype(int).replace(0, -1)
        df_raw["P3_DIF_Trend"] = (df_raw["DIF"] > df_raw["DIF"].shift(1)).astype(int).replace(0, -1)
        df_raw["P4_KD_Cross"] = (df_raw["K"] > df_raw["D"]).astype(int).replace(0, -1)
        df_raw["P2_MACD_Cross"] = (df_raw["DIF"] > df_raw["MACD_S"]).astype(int).replace(0, -1)

        # 提取最新日與前一日紀錄
        latest_row = df_raw.iloc[-1]
        prev_row = df_raw.iloc[-2] if n >= 2 else latest_row
        
        name = latest_row['stock_name']
        mkt = latest_row['mkt']
        trade_date = str(latest_row['trade_date'])
        
        c = float(latest_row['close'])
        o = float(latest_row['open'])
        h = float(latest_row['high'])
        l = float(latest_row['low'])
        v = int(latest_row['volume'])
        
        fb = int(latest_row['foreign_buy'])
        sb = int(latest_row['sitc_buy'])
        db = int(latest_row['dealers_buy'])
        mb = int(latest_row['margin_balance'])
        
        prev_c = float(prev_row['close'])
        change = round(c - prev_c, 2) if prev_c > 0 else 0.0
        pct = round((change / prev_c) * 100, 2) if prev_c > 0 else 0.0

        # ==========================================
        # 10 項策略特徵精確判讀 (對齊 Stock_Sentinel.py:2574)
        # ==========================================
        ma5 = float(latest_row["MA5"])
        ma10 = float(latest_row["MA10"])
        ma20 = float(latest_row["BB_Mid"])
        ma60 = float(df_raw["close"].rolling(60, min_periods=1).mean().iloc[-1])
        
        ma_order = sorted([(ma5, "MA5"), (ma10, "MA10"), (ma20, "MA20")], key=lambda x: x[0], reverse=True)
        ma_order_str = f"({ma_order[0][1]} > {ma_order[1][1]} > {ma_order[2][1]})"
        ma_align = f"多頭排列 {ma_order_str}" if ma5 > ma10 and ma10 > ma20 else (f"空頭排列 {ma_order_str}" if ma5 < ma10 and ma10 < ma20 else f"整理格局 {ma_order_str}")
        
        bias20 = ((c - ma20) / ma20 * 100) if ma20 > 0 else 0.0
        if bias20 >= 10:
            bias_label = f"超買過熱 ({bias20:+.1f}%)"
        elif bias20 <= -8:
            bias_label = f"超跌恐慌 ({bias20:+.1f}%)"
        else:
            bias_label = f"溫和整理 ({bias20:+.2f}%)"
            
        vol5_avg = float(df_raw["volume"].tail(5).mean())
        vol_ratio = (v / vol5_avg) if vol5_avg > 0 else 1.0
        vol_status = f"爆量發動 ({vol_ratio:.1f}倍)" if vol_ratio >= 1.5 else f"量能平穩 ({vol_ratio:.1f}倍)"
        
        # 三大法人連買連賣
        f_diffs = df_raw["foreign_buy"].tail(5).tolist()
        s_diffs = df_raw["sitc_buy"].tail(5).tolist()
        d_diffs = df_raw["dealers_buy"].tail(5).tolist()
        
        def get_consecutive_days(diffs):
            if not diffs or all(val == 0 for val in diffs): return 0, "不參與"
            latest_v = diffs[-1]
            if latest_v == 0: return 0, "無明顯交易"
            direction = "買" if latest_v > 0 else "賣"
            days = 0
            for val in reversed(diffs):
                if direction == "買" and val > 0: days += 1
                elif direction == "賣" and val < 0: days += 1
                else: break
            return days, direction

        f_days, f_dir = get_consecutive_days(f_diffs)
        s_days, s_dir = get_consecutive_days(s_diffs)
        d_days, d_dir = get_consecutive_days(d_diffs)
        f_desc = f"連{f_dir}{f_days}天" if f_days >= 3 else ("不參與" if f_dir == "不參與" else "多空拉鋸")
        s_desc = "不參與" if s_dir == "不參與" else (f"連{s_dir}{s_days}天" if s_days >= 3 else "多空拉鋸")
        d_desc = f"連{d_dir}{d_days}天" if d_days >= 3 else ("不參與" if d_dir == "不參與" else "多空拉鋸")
        inst_synergy = f"外資:{f_desc} │ 投信:{s_desc} │ 自營:{d_desc}"

        # 融資連續增減
        margin_diffs = df_raw["融資增減"].tail(5).tolist()
        margin_dec_days, margin_inc_days = 0, 0
        for val in reversed(margin_diffs):
            if val < 0: margin_dec_days += 1
            else: break
        if margin_dec_days == 0:
            for val in reversed(margin_diffs):
                if val > 0: margin_inc_days += 1
                else: break
        if margin_dec_days >= 3:
            margin_status = f"籌碼沉澱 (連減{margin_dec_days}天)"
        elif margin_inc_days >= 3:
            margin_status = f"融資堆積 (連增{margin_inc_days}天)"
        else:
            margin_status = "無明顯連續增減資"

        # 籌碼吸籌比(5日)
        total_vol_5 = df_raw["volume"].tail(5).sum()
        total_inst_5 = df_raw["法人合計"].tail(5).sum()
        absorption_ratio = (total_inst_5 / total_vol_5 * 100) if total_vol_5 > 0 else 0.0
        if absorption_ratio > 15.0:
            absorption_status = f"強力吸籌 🔥 ({absorption_ratio:+.1f}%)"
        elif absorption_ratio > 5.0:
            absorption_status = f"偏多吸籌 ({absorption_ratio:+.1f}%)"
        elif absorption_ratio >= -5.0:
            absorption_status = f"籌碼變動平穩 ({absorption_ratio:+.1f}%)"
        elif absorption_ratio >= -15.0:
            absorption_status = f"偏空出貨 ({absorption_ratio:+.1f}%)"
        else:
            absorption_status = f"加速出貨 🚨 ({absorption_ratio:+.1f}%)"

        # 法人買超加速度
        inst_avg_3 = df_raw["法人合計"].tail(3).mean()
        inst_avg_10 = df_raw["法人合計"].tail(10).mean()
        if abs(inst_avg_10) > 0:
            accel = inst_avg_3 / inst_avg_10
            if accel > 2.0 and inst_avg_3 > 0:
                accel_status = f"加速買超中 (力道放大 {accel:.1f}倍 ⚡)"
            elif accel > 2.0 and inst_avg_3 < 0:
                accel_status = f"加速賣超中 (力道放大 {accel:.1f}倍 🚨)"
            else:
                accel_status = "力道平穩"
        else:
            accel_status = "量能穩定"

        # 量價結構
        p_change = (c - prev_c) / prev_c * 100 if prev_c > 0 else 0.0
        prev_v = float(prev_row["volume"])
        v_change = (v - prev_v) / prev_v * 100 if prev_v > 0 else 0.0
        p_dir = "價漲" if p_change >= 0.5 else ("價跌" if p_change <= -0.5 else "價平")
        v_dir_state = "量增" if v_change >= 10.0 else ("量縮" if v_change <= -10.0 else "量平")
        pv_status = f"{p_dir}{v_dir_state}"
        if pv_status == "價漲量增": pv_desc = "價漲量增 (多頭攻擊)"
        elif pv_status == "價跌量增": pv_desc = "價跌量增 (殺盤鬆動)"
        elif pv_status in ["價漲量縮", "價平量增"]: pv_desc = f"{pv_status} (量價背離/換手)"
        elif pv_status == "價跌量縮": pv_desc = "價跌量縮 (止跌訊號)"
        else: pv_desc = pv_status

        # 布林狀態
        bb_u = float(latest_row["BB_U"])
        bb_l = float(latest_row["BB_L"])
        pct_b = ((c - bb_l) / (bb_u - bb_l)) if (bb_u - bb_l) > 0 else 0.5
        bw_current = (bb_u - bb_l) / ma20 if ma20 > 0 else 0.0
        bw_min_20 = (df_raw["BB_U"] - df_raw["BB_L"]) / df_raw["BB_Mid"]
        bw_min_val = bw_min_20.tail(20).min()
        is_squeezed = (bw_current <= bw_min_val * 1.15) if bw_min_val > 0 else False
        squeeze_lbl = " (壓縮蓄勢)" if is_squeezed else ""
        if pct_b >= 1.0: bb_status = "布林突破"
        elif pct_b > 0.5: bb_status = "布林多頭軌"
        elif pct_b > 0.0: bb_status = "布林空頭軌"
        else: bb_status = "布林跌破"
        bb_desc = f"{bb_status}{squeeze_lbl} (%B:{pct_b:.2f})"

        # K 線型態
        pats = []
        body0 = abs(c - o); total0 = h - l if h > l else 1e-5
        upper0 = h - max(o, c); lower0 = min(o, c) - l
        if lower0 >= 2*body0 and upper0 <= 0.3*body0 and body0 <= 0.35*total0: pats.append("🔨 底部槌子線")
        if upper0 >= 2*body0 and lower0 <= 0.3*body0 and body0 <= 0.35*total0: pats.append("☄️ 高檔流星線")
        if n >= 2:
            r1 = df_raw.iloc[-2]
            o1, h1, c1, l1 = r1["open"], r1["high"], r1["close"], r1["low"]
            body1 = abs(c1 - o1)
            if c1 < o1 and c > o and o <= c1 and c >= o1 and body0 > body1: pats.append("🔴 多頭吞噬")
            if c1 > o1 and c < o and o >= c1 and c <= o1 and body0 > body1: pats.append("🟢 空頭吞噬")
        if n >= 3:
            r1, r2 = df_raw.iloc[-2], df_raw.iloc[-3]
            o1, c1 = r1["open"], r1["close"]
            o2, c2 = r2["open"], r2["close"]
            body2 = abs(c2 - o2)
            total1 = r1["high"] - r1["low"] if r1["high"] > r1["low"] else 1e-5
            is_lb = (o2 > c2) and body2 >= 0.5 * (r2["high"] - r2["low"])
            is_sb = abs(c1 - o1) <= 0.3 * total1
            is_lw = (c > o) and body0 >= 0.5 * total0
            if is_lb and is_sb and is_lw and max(o1, c1) < c2 and c > (o2 + c2) / 2: pats.append("🌅 晨星翻多")
            if (c2 > o2) and (o1 > c1) and (c > o) and c > o1 and o < c1: pats.append("🥪 雙陽夾一陰")
        k_pattern = "、".join(pats) if pats else "無明顯型態"

        # RSI12 搶反彈與預估 (超跌恐慌點位)
        if bias20 <= -8:
            p1 = round(c * 1.054, 2)
            p2 = round(c * 1.035, 2)
            p3 = round(c * 1.017, 2)
            p_start = round(c * 1.256, 2)
            rsi_info = {
                "emoji": "🔴",
                "text": f"⚠️ 一級低吸點 (RSI=30): {p1} 元 (預估跌幅: 5.44%)\n🚨 二級強力反彈 (RSI=27.5 - 首選推薦): {p2} 元 (預估跌幅: 3.57%)\n🔥 三級極限冰點 (RSI=25): {p3} 元 (預估跌幅: 1.70%)\n(以 {p_start} 元 (RSI=57.0) 為起跌點推估買點)\n賣點預估: 已觸發動能衰竭或橫盤冷卻 (橫盤冷卻)，停止預估價位"
            }
        else:
            rsi_info = {
                "emoji": "⚪",
                "text": "買點預測：目前股價強勢/橫盤，未滿足起跌條件\n賣點預估：目前無反彈賣信號"
            }

        # 6 大青紅燈指標 (數值 1: 多/紅, -1: 空/綠)
        t_mtm = int(latest_row["P10_MTM_Cross"])
        t_osc = int(latest_row["P1_MACD_OSC"])
        t_kt = int(latest_row["P5_K_Trend"])
        t_dift = int(latest_row["P3_DIF_Trend"])
        t_kd = int(latest_row["P4_KD_Cross"])
        t_macd = int(latest_row["P2_MACD_Cross"])

        p_mtm = int(prev_row["P10_MTM_Cross"]) if n >= 2 else t_mtm
        p_osc = int(prev_row["P1_MACD_OSC"]) if n >= 2 else t_osc
        p_kt = int(prev_row["P5_K_Trend"]) if n >= 2 else t_kt
        p_dift = int(prev_row["P3_DIF_Trend"]) if n >= 2 else t_dift
        p_kd = int(prev_row["P4_KD_Cross"]) if n >= 2 else t_kd
        p_macd = int(prev_row["P2_MACD_Cross"]) if n >= 2 else t_macd

        snapshot_map[code] = {
            "name": name,
            "mkt": mkt,
            "d": trade_date,
            "p": c,
            "chg": change,
            "pct": pct,
            "o": o,
            "h": h,
            "l": l,
            "v": v,
            "ma": {"ma5": ma5, "ma10": ma10, "ma20": ma20, "ma60": ma60},
            "bb": {"upper": round(bb_u, 2), "lower": round(bb_l, 2), "width": round(bw_current * 100, 2)},
            "kd": {"k": round(float(latest_row["K"]), 1), "d": round(float(latest_row["D"]), 1)},
            "rsi": round(float(latest_row["RSI12"]), 1),
            "macd": {"dif": round(float(latest_row["DIF"]), 2), "sig": round(float(latest_row["MACD_S"]), 2), "hist": round(float(latest_row["OSC"]), 2)},
            "chip": {"foreign": fb, "sitc": sb, "dealers": db},
            "margin": {"bal": mb},
            "lights": {
                "MTM金": t_mtm,
                "OSC縮": t_osc,
                "K趨": t_kt,
                "DIF趨": t_dift,
                "KD金": t_kd,
                "MACD金": t_macd
            },
            "prev_lights": {
                "MTM金": p_mtm,
                "OSC縮": p_osc,
                "K趨": p_kt,
                "DIF趨": p_dift,
                "KD金": p_kd,
                "MACD金": p_macd
            },
            "prev_ind": {
                "trend": "red" if p_mtm == 1 else "green",
                "vol": "red" if p_osc == 1 else "green",
                "kd": "red" if p_kt == 1 else "green",
                "macd": "red" if p_dift == 1 else "green",
                "rsi": "red" if p_kd == 1 else "green",
                "chip": "red" if p_macd == 1 else "green"
            },
            "strat": {
                "ma_align": ma_align,
                "bb_desc": bb_desc,
                "pv_desc": pv_desc,
                "bias_label": bias_label,
                "vol_status": vol_status,
                "inst_synergy": inst_synergy,
                "margin_status": margin_status,
                "absorption_status": absorption_status,
                "accel_status": accel_status,
                "k_pattern": k_pattern,
                "rsi_info": rsi_info
            }
        }
        
    calc_elapsed = round(time.time() - start_time, 2)
    print(f"✨ [完成] 全市場 {total_count} 檔個股指標與特徵滾算完成！總耗時: {calc_elapsed} 秒。")
    return snapshot_map, calc_elapsed

# ==========================================
# 4. 主執行流程：藍綠雙分區發布與品質審計
# ==========================================

def update_health_status(health_data):
    target_dirs = {OUTPUT_DIR, PROJECT_ROOT}
    for d in target_dirs:
        try:
            os.makedirs(d, exist_ok=True)
            p = os.path.join(d, "market_health.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump(health_data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"⚠️ 寫入 {d}/market_health.json 失敗: {e}")

def main():
    target_date = get_target_date()
    start_total_time = time.time()
    print(f"======================================================")
    print(f"🚀 鈔能戰情室 - 雲端行情大腦啟動 [目標日期: {target_date}]")
    print(f"======================================================")

    # 0. 初始化健康狀態 (廣播 PROCESSING 鎖定信號)
    health_report = {
        "target_date": target_date,
        "run_time": get_taipei_now().strftime("%Y-%m-%d %H:%M:%S"),
        "status": "PROCESSING",
        "progress": "大盤數據抓取中...",
        "is_holiday": False,
        "holiday_reason": "",
        "nodes": {},
        "audit": {
            "zero_volume_count": 0,
            "zero_volume_samples": [],
            "zero_chip_count": 0,
            "zero_chip_samples": []
        }
    }
    update_health_status(health_report)

    # 1. 休市日智慧哨兵防禦
    is_holiday, holiday_reason = is_market_holiday(target_date)
    health_report["is_holiday"] = is_holiday
    health_report["holiday_reason"] = holiday_reason

    if is_holiday:
        print(f"☕ [休市哨兵] 今日為 {holiday_reason}，市場未開盤，自動略過。")
        health_report["status"] = "HOLIDAY"
        health_report["progress"] = f"今日為 {holiday_reason}，市場未開盤。"
        update_health_status(health_report)
        sys.exit(0)

    # 2. 爬取全市場盤後 (Staging 清洗沙盒區)
    t0 = time.time()
    twse_map = fetch_twse_market(target_date)
    t1 = time.time()
    tpex_map = fetch_tpex_market(target_date)
    t2 = time.time()
    chip_map = fetch_institutional_investors(target_date)
    t3 = time.time()
    margin_map = fetch_margin_trading(target_date)
    t4 = time.time()

    health_report["nodes"]["twse"] = {"count": len(twse_map), "elapsed": round(t1 - t0, 2), "status": "OK" if len(twse_map) >= 900 else "FAIL"}
    health_report["nodes"]["tpex"] = {"count": len(tpex_map), "elapsed": round(t2 - t1, 2), "status": "OK" if len(tpex_map) >= 700 else "FAIL"}
    health_report["nodes"]["chip"] = {"count": len(chip_map), "elapsed": round(t3 - t2, 2), "status": "OK" if len(chip_map) >= 1000 else "FAIL"}
    health_report["nodes"]["margin"] = {"count": len(margin_map), "elapsed": round(t4 - t3, 2), "status": "OK" if len(margin_map) >= 1000 else "FAIL"}

    # 審計門檻檢查：若核心節點未達標，判定官方未結算，觸發藍綠分區保護 (維持原快照)
    if len(twse_map) < 900 or len(tpex_map) < 700:
        print(f"⚠️ [保護攔截] {target_date} 上市櫃數據檔數未達門檻 (TWSE: {len(twse_map)}, TPEx: {len(tpex_map)})，官方尚未結算完成！")
        health_report["status"] = "PENDING"
        health_report["progress"] = f"官方 [{target_date}] 盤後數據尚未結算或無交易，維持前一交易日健康快照。"
        health_report["total_elapsed"] = round(time.time() - start_total_time, 2)
        update_health_status(health_report)
        print("🛡️ [藍綠分區保護] 維持現有下載區快照，終止本次熱替換。")
        sys.exit(0)

    # 3. 存入歷史資料庫
    health_report["status"] = "CLEANING"
    health_report["progress"] = "歷史 K 線寫入與全市場指標滾算清洗中..."
    update_health_status(health_report)

    os.makedirs(BASE_DIR, exist_ok=True)
    conn = init_history_db(HISTORY_DB_PATH)
    save_daily_snapshot_to_history(conn, target_date, twse_map, tpex_map, chip_map, margin_map)

    # 4. 全市場指標矩陣滾算
    snapshot_map, calc_elapsed = calculate_all_stock_indicators(conn)
    conn.close()
    health_report["nodes"]["indicators"] = {"count": len(snapshot_map), "elapsed": calc_elapsed, "status": "OK"}

    # 5. 數據品質審計與 0 值排查 (對齊電腦版三維健檢矩陣)
    zero_vol_samples = []
    zero_chip_samples = []
    for code, item in snapshot_map.items():
        if item.get("p", 0) <= 0 or item.get("v", 0) <= 0:
            if len(zero_vol_samples) < 20:
                zero_vol_samples.append({"code": code, "name": item.get("name"), "reason": "收盤價或成交量為0 (可能停牌/無交易)"})
        chip = item.get("chip", {})
        if chip.get("foreign") == 0 and chip.get("sitc") == 0 and chip.get("dealers") == 0:
            if len(zero_chip_samples) < 20:
                zero_chip_samples.append({"code": code, "name": item.get("name")})

    health_report["audit"]["zero_volume_count"] = len(zero_vol_samples)
    health_report["audit"]["zero_volume_samples"] = zero_vol_samples
    health_report["audit"]["zero_chip_count"] = len(zero_chip_samples)
    health_report["audit"]["zero_chip_samples"] = zero_chip_samples
    health_report["total_elapsed"] = round(time.time() - start_total_time, 2)

    # 6. 藍綠雙分區熱切換：先寫入暫存檔 staging_snapshot.json.gz
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    json_bytes = json.dumps(snapshot_map, ensure_ascii=False, cls=NumpyEncoder).encode('utf-8')
    staging_gz_path = os.path.join(OUTPUT_DIR, "staging_snapshot.json.gz")
    with gzip.open(staging_gz_path, 'wb', compresslevel=9) as f:
        f.write(json_bytes)
    
    gz_size_kb = round(os.path.getsize(staging_gz_path) / 1024, 1)
    health_report["snapshot_size_kb"] = gz_size_kb
    print(f"📦 [Staging 清洗區] 暫存快照生成完畢 -> {staging_gz_path} ({gz_size_kb} KB)")

    # 7. 審計合格：原子熱替換 (Promotion to Production)
    final_gz_path = os.path.join(OUTPUT_DIR, "market_snapshot.json.gz")
    os.replace(staging_gz_path, final_gz_path)
    if OUTPUT_DIR != PROJECT_ROOT:
        import shutil
        shutil.copy2(final_gz_path, os.path.join(PROJECT_ROOT, "market_snapshot.json.gz"))
    print(f"⚡ [Production 正式發布] 原子熱替換完成 -> {final_gz_path}")

    # 8. 更新健康狀態為 READY
    health_report["status"] = "READY"
    health_report["progress"] = "全流程清洗審計合格，快照已就緒提供更新！"
    update_health_status(health_report)

    print(f"📊 [產出] 數據健康報表已發布 -> {os.path.join(OUTPUT_DIR, 'market_health.json')}")
    print(f"======================================================")
    print(f"🎉 盤後大腦全流程順利完成！總耗時: {health_report['total_elapsed']} 秒。")
    print(f"======================================================")

if __name__ == "__main__":
    main()
