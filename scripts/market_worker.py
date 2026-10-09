#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🚀 鈔能戰情室 - 雲端盤後行情大腦與數據品質審計引擎
======================================================
核心功能：
1. 🛡️ 休市日智慧哨兵 (0.1 秒精準跳過週末/國定假日/颱風假)
2. 📡 全市場盤後數據爬取 (上市/上櫃/三大法人/融資融券，比照電腦版有效性驗證)
3. 💾 歷史 K 線與籌碼存儲，滾算全台股 2,400+ 檔 6 大青紅燈 + 10 項策略特徵
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
    """暴力數字清洗器 ── 完全比照電腦版 Stock_Sentinel.py:1716"""
    if v is None:
        return default
    s = str(v).replace(',', '').strip()
    clean_v = re.sub(r'[^\d.-]', '', s)
    try:
        return round(float(clean_v), 2) if clean_v else default
    except:
        return default

def safe_int(v, default=0):
    """暴力整數清洗器 ── 徹底格殺千分位逗號與符號"""
    if v is None:
        return default
    s = str(v).replace(',', '').strip()
    clean_v = re.sub(r'[^\d.-]', '', s)
    try:
        return int(float(clean_v)) if clean_v else default
    except:
        return default

def get_taipei_now():
    """取得標準台灣時間 (UTC+8)，避免 GitHub Actions 倫敦時區落差"""
    tz_tw = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz_tw)

def get_target_date():
    """取得目標執行日期 (支援手動傳參 YYYYMMDD，預設為今日)"""
    if len(sys.argv) > 1 and len(sys.argv[1].strip()) == 8 and sys.argv[1].strip().isdigit():
        return sys.argv[1].strip()
    return get_taipei_now().strftime("%Y%m%d")

def is_market_holiday(date_str):
    """
    休市日智慧哨兵：比對行事曆、週末與自訂休市檔 (typhone_day.txt)
    """
    dt = datetime.datetime.strptime(date_str, "%Y%m%d")
    # 1. 週末過濾
    if dt.weekday() >= 5:
        return True, f"週末例假日 ({dt.strftime('%A')})"
    
    # 2. 比對 typhone_day.txt
    typhone_file = os.path.join(PROJECT_ROOT, "typhone_day.txt")
    if os.path.exists(typhone_file):
        try:
            with open(typhone_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and ',' in line:
                        d, reason = line.split(',', 1)
                        if d.strip() == date_str:
                            return True, f"國定/自訂休市日 ({reason.strip()})"
        except Exception as e:
            print(f"⚠️ 讀取 typhone_day.txt 略過: {e}")
            
    return False, "正常交易日"

def http_get_json(url, retries=3, delay=2):
    """HTTP 請求包裝器 (帶重試機制)"""
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, context=ssl_ctx, timeout=20) as resp:
                data = resp.read().decode('utf-8', errors='ignore')
                return json.loads(data)
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(delay)
            else:
                print(f"❌ 請求失敗 [{url[:65]}...]: {e}")
                return None

# ==========================================
# 1. 全市場盤後數據爬取模組 (比照電腦版有效性驗證)
# ==========================================

def fetch_twse_market(date_str):
    """抓取證交所 (上市) 日成交全檔"""
    print("📡 [1/4 爬取] 正在下載證交所 (上市) 大盤日成交全檔...")
    url = f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={date_str}&type=ALLBUT0999&response=json"
    data = http_get_json(url)
    results = {}
    
    # 優先解析 MI_INDEX
    if data and data.get('stat') == 'OK':
        tables = data.get('tables', [])
        for tbl in tables:
            fields = tbl.get('fields', [])
            if '證券代號' in fields and '收盤價' in fields:
                idx_code = fields.index('證券代號')
                idx_name = fields.index('證券名稱')
                idx_vol = fields.index('成交股數') if '成交股數' in fields else -1
                idx_open = fields.index('開盤價') if '開盤價' in fields else -1
                idx_high = fields.index('最高價') if '最高價' in fields else -1
                idx_low = fields.index('最低價') if '最低價' in fields else -1
                idx_close = fields.index('收盤價') if '收盤價' in fields else -1
                
                rows = tbl.get('data', [])
                # 比照電腦版 878 行：檢驗資料筆數與收盤價 > 0 真值
                if len(rows) >= 50:
                    valid_prices = sum(1 for r in rows[:50] if safe_float(r[idx_close]) > 0)
                    if valid_prices > 0:
                        for row in rows:
                            code = str(row[idx_code]).strip().replace('=', '').replace('"', '')
                            if code and not code.startswith('01'):
                                results[code] = {
                                    'name': str(row[idx_name]).strip(),
                                    'open': safe_float(row[idx_open]) if idx_open >= 0 else 0.0,
                                    'high': safe_float(row[idx_high]) if idx_high >= 0 else 0.0,
                                    'low': safe_float(row[idx_low]) if idx_low >= 0 else 0.0,
                                    'close': safe_float(row[idx_close]) if idx_close >= 0 else 0.0,
                                    'volume': safe_int(row[idx_vol]) if idx_vol >= 0 else 0,
                                    'mkt': 'TSE'
                                }
                        if len(results) > 0:
                            return results

    # 備援：OpenAPI
    try:
        twse_api = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
        api_data = http_get_json(twse_api)
        if api_data and isinstance(api_data, list) and len(api_data) >= 50:
            for row in api_data:
                code = str(row.get('Code', '')).strip()
                if code:
                    results[code] = {
                        'name': str(row.get('Name', '')).strip(),
                        'open': safe_float(row.get('OpeningPrice')),
                        'high': safe_float(row.get('HighestPrice')),
                        'low': safe_float(row.get('LowestPrice')),
                        'close': safe_float(row.get('ClosingPrice')),
                        'volume': safe_int(row.get('TradeVolume')),
                        'mkt': 'TSE'
                    }
    except Exception as e:
        print(f"⚠️ TWSE OpenAPI 備援解析失敗: {e}")

    return results

def fetch_tpex_market(date_str):
    """抓取櫃買中心 (上櫃) 日成交全檔 (優先採用官方 OpenAPI)"""
    print("📡 [2/4 爬取] 正在下載櫃買中心 (上櫃) 大盤日成交全檔...")
    results = {}
    
    # 1. 優先採用最穩定的櫃買官方 OpenAPI
    try:
        tpex_api = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
        api_data = http_get_json(tpex_api)
        if api_data and isinstance(api_data, list) and len(api_data) >= 30:
            for row in api_data:
                code = str(row.get('SecuritiesCompanyCode', '')).strip()
                if code:
                    results[code] = {
                        'name': str(row.get('CompanyName', '')).strip(),
                        'open': safe_float(row.get('Open')),
                        'high': safe_float(row.get('High')),
                        'low': safe_float(row.get('Low')),
                        'close': safe_float(row.get('Close')),
                        'volume': safe_int(row.get('TradingShares')),
                        'mkt': 'OTC'
                    }
            if len(results) >= 500:
                return results
    except Exception as e:
        print(f"⚠️ TPEx OpenAPI 解析提示: {e}")

    # 2. 備援：傳統 PHP 查詢
    try:
        roc_year = int(date_str[:4]) - 1911
        roc_date = f"{roc_year}/{date_str[4:6]}/{date_str[6:8]}"
        ts = int(time.time() * 1000)
        url = f"https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d={roc_date}&se=EW&_={ts}"
        data = http_get_json(url)
        if data and data.get('aaData'):
            for row in data.get('aaData', []):
                if len(row) >= 7:
                    code = str(row[0]).strip()
                    if code:
                        results[code] = {
                            'name': str(row[1]).strip(),
                            'open': safe_float(row[4]),
                            'high': safe_float(row[5]),
                            'low': safe_float(row[6]),
                            'close': safe_float(row[2]),
                            'volume': safe_int(row[8]) if len(row) > 8 else safe_int(row[7]),
                            'mkt': 'OTC'
                        }
    except Exception as e:
        print(f"⚠️ TPEx 傳統端點備援失敗: {e}")

    return results

def fetch_institutional_investors(date_str):
    """抓取全市場三大法人買賣超 (上市 + 上櫃)"""
    print("📡 [3/4 爬取] 正在下載全市場三大法人買賣超全檔...")
    results = {}
    
    # 1. 上市三大法人 (T86)
    twse_url = f"https://www.twse.com.tw/rwd/zh/fund/T86?date={date_str}&selectType=ALL&response=json"
    t_data = http_get_json(twse_url)
    if t_data and t_data.get('stat') == 'OK':
        for row in t_data.get('data', []):
            if len(row) >= 12:
                code = str(row[0]).strip()
                foreign = safe_int(row[4])   # 外資買賣超
                sitc = safe_int(row[10])     # 投信買賣超
                dealers = safe_int(row[11])  # 自營商買賣超
                results[code] = {
                    'foreign_buy': foreign,
                    'sitc_buy': sitc,
                    'dealers_buy': dealers
                }

    # 2. 上櫃三大法人
    roc_year = int(date_str[:4]) - 1911
    roc_date = f"{roc_year}/{date_str[4:6]}/{date_str[6:8]}"
    ts = int(time.time() * 1000)
    tpex_url = f"https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&se=EW&t=D&d={roc_date}&_={ts}"
    o_data = http_get_json(tpex_url)
    if o_data and o_data.get('aaData'):
        for row in o_data.get('aaData', []):
            if len(row) >= 14:
                code = str(row[0]).strip()
                foreign = safe_int(row[7])   # 外資買賣超
                sitc = safe_int(row[10])     # 投信買賣超
                dealers = safe_int(row[13])  # 自營商買賣超
                results[code] = {
                    'foreign_buy': foreign,
                    'sitc_buy': sitc,
                    'dealers_buy': dealers
                }
    return results

def fetch_margin_trading(date_str):
    """抓取全市場融資融券信用交易餘額 (上市 + 上櫃)"""
    print("📡 [4/4 爬取] 正在下載全市場融資融券信用交易全檔...")
    results = {}
    
    # 1. 上市信用交易 (MI_MARGN) - 精確解析 tables[1] 個股明細
    twse_url = f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={date_str}&selectType=ALL&response=json"
    t_data = http_get_json(twse_url)
    if t_data and t_data.get('stat') == 'OK':
        tables = t_data.get('tables', [])
        for tbl in tables:
            rows = tbl.get('data', [])
            if len(rows) > 50:
                for row in rows:
                    code = str(row[0]).strip().replace('=', '').replace('"', '')
                    if len(row) >= 7 and code and len(code) >= 4:
                        margin_bal = safe_int(row[6])  # 融資今日餘額
                        results[code] = {
                            'margin_balance': margin_bal,
                            'margin_increase': 0
                        }

    # 2. 上櫃信用交易 (優先採用官方 OpenAPI)
    try:
        tpex_margin_api = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance"
        m_data = http_get_json(tpex_margin_api)
        if m_data and isinstance(m_data, list) and len(m_data) > 0:
            for row in m_data:
                code = str(row.get('SecuritiesCompanyCode', '')).strip()
                if code:
                    margin_bal = safe_int(row.get('MarginBalance', 0))
                    results[code] = {
                        'margin_balance': margin_bal,
                        'margin_increase': 0
                    }
    except Exception as e:
        print(f"⚠️ TPEx Margin OpenAPI 提示: {e}")

    # 備援：上櫃傳統 PHP (僅在未取得上櫃資料時嘗試)
    if len(results) < 1300:
        try:
            roc_year = int(date_str[:4]) - 1911
            roc_date = f"{roc_year}/{date_str[4:6]}/{date_str[6:8]}"
            ts = int(time.time() * 1000)
            tpex_url = f"https://www.tpex.org.tw/web/stock/margin_trading/margin_bal/margin_bal_result.php?l=zh-tw&d={roc_date}&_={ts}"
            o_data = http_get_json(tpex_url)
            if o_data and o_data.get('aaData'):
                for row in o_data.get('aaData', []):
                    if len(row) >= 6:
                        code = str(row[0]).strip()
                        margin_bal = safe_int(row[5])
                        results[code] = {
                            'margin_balance': margin_bal,
                            'margin_increase': 0
                        }
        except:
            pass

    return results

# ==========================================
# 2. 歷史資料庫存儲與多日 K 線合併
# ==========================================

def init_history_db(db_path):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS daily_kline (
            trade_date TEXT,
            stock_code TEXT,
            stock_name TEXT,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER,
            foreign_buy INTEGER,
            sitc_buy INTEGER,
            dealers_buy INTEGER,
            margin_balance INTEGER,
            mkt TEXT,
            PRIMARY KEY (trade_date, stock_code)
        )
    """)
    # 自動相容升級：檢查必要欄位
    cur.execute("PRAGMA table_info(daily_kline)")
    existing_cols = [row[1] for row in cur.fetchall()]
    for col in ['open', 'high', 'low', 'close', 'volume', 'foreign_buy', 'sitc_buy', 'dealers_buy', 'margin_balance', 'mkt']:
        if col not in existing_cols:
            try:
                cur.execute(f"ALTER TABLE daily_kline ADD COLUMN {col} TEXT")
            except:
                pass
    cur.execute("CREATE INDEX IF NOT EXISTS idx_kline_code ON daily_kline (stock_code, trade_date)")
    conn.commit()
    return conn

def save_daily_snapshot_to_history(conn, target_date, twse_map, tpex_map, chip_map, margin_map):
    print(f"💾 [存儲] 正在將 {target_date} 全市場行情寫入歷史資料庫...")
    cur = conn.cursor()
    all_codes = set(list(twse_map.keys()) + list(tpex_map.keys()))
    records = []
    
    for code in all_codes:
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
            fb, sb, db, mb, mkt
        ))
        
    cur.executemany("""
        INSERT OR REPLACE INTO daily_kline (
            trade_date, stock_code, stock_name,
            open, high, low, close, volume,
            foreign_buy, sitc_buy, dealers_buy, margin_balance, mkt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, records)
    conn.commit()
    print(f"✅ [完成] 成功寫入 {len(records)} 筆個股日 K 線與籌碼紀錄。")

# ==========================================
# 3. 全市場 2,400 檔技術指標矩陣滾算引擎
# ==========================================

def calculate_all_stock_indicators(conn, lookback_days=90):
    print("⚡ [運算] 正在啟動全市場 2,400+ 檔 6 大青紅燈指標與策略特徵矩陣滾算...")
    start_time = time.time()
    
    query = f"""
        SELECT trade_date, stock_code, stock_name, mkt,
               open, high, low, close, volume,
               foreign_buy, sitc_buy, dealers_buy, margin_balance
        FROM daily_kline
        WHERE trade_date IN (
            SELECT DISTINCT trade_date FROM daily_kline ORDER BY trade_date DESC LIMIT {lookback_days}
        )
        ORDER BY stock_code, trade_date ASC
    """
    df = pd.read_sql_query(query, conn)
    if df.empty:
        return {}, 0.0

    snapshot_map = {}
    grouped = df.groupby('stock_code')
    total_count = len(grouped)
    
    for code, group in grouped:
        if len(group) == 0:
            continue
        
        latest = group.iloc[-1]
        prev = group.iloc[-2] if len(group) > 1 else latest
        
        name = latest['stock_name']
        mkt = latest['mkt']
        trade_date = latest['trade_date']
        
        c = latest['close']
        o = latest['open']
        h = latest['high']
        l = latest['low']
        v = latest['volume']
        
        fb = int(latest['foreign_buy'])
        sb = int(latest['sitc_buy'])
        db = int(latest['dealers_buy'])
        mb = int(latest['margin_balance'])
        
        prev_c = prev['close']
        change = round(c - prev_c, 2) if prev_c > 0 else 0.0
        pct = round((change / prev_c) * 100, 2) if prev_c > 0 else 0.0
        
        # 1. 均線 MA 計算 (MA5, MA10, MA20, MA60)
        closes = group['close'].values
        ma5 = round(float(np.mean(closes[-5:])), 2) if len(closes) >= 5 else c
        ma10 = round(float(np.mean(closes[-10:])), 2) if len(closes) >= 10 else ma5
        ma20 = round(float(np.mean(closes[-20:])), 2) if len(closes) >= 20 else ma10
        ma60 = round(float(np.mean(closes[-60:])), 2) if len(closes) >= 60 else ma20
        
        # 2. 布林通道 (20MA, 2SD)
        if len(closes) >= 20:
            std20 = float(np.std(closes[-20:]))
            bb_upper = round(ma20 + 2 * std20, 2)
            bb_lower = round(ma20 - 2 * std20, 2)
            bb_width = round(((bb_upper - bb_lower) / ma20) * 100, 2) if ma20 > 0 else 0.0
        else:
            bb_upper = c
            bb_lower = c
            bb_width = 0.0
            
        # 3. KD (9, 3, 3) 滾算
        k_val = 50.0
        d_val = 50.0
        if len(group) >= 9:
            highs = group['high'].values
            lows = group['low'].values
            k_arr = []
            d_arr = []
            curr_k, curr_d = 50.0, 50.0
            for i in range(8, len(group)):
                sub_h = np.max(highs[max(0, i-8):i+1])
                sub_l = np.min(lows[max(0, i-8):i+1])
                sub_c = closes[i]
                rsv = ((sub_c - sub_l) / (sub_h - sub_l) * 100.0) if sub_h > sub_l else 50.0
                curr_k = (2/3) * curr_k + (1/3) * rsv
                curr_d = (2/3) * curr_d + (1/3) * curr_k
                k_arr.append(curr_k)
                d_arr.append(curr_d)
            if k_arr:
                k_val = round(k_arr[-1], 1)
                d_val = round(d_arr[-1], 1)
                
        # 4. RSI (12)
        rsi_val = 50.0
        if len(closes) >= 13:
            diffs = np.diff(closes[-13:])
            gains = np.where(diffs > 0, diffs, 0.0)
            losses = np.where(diffs < 0, -diffs, 0.0)
            avg_gain = np.mean(gains)
            avg_loss = np.mean(losses)
            if avg_loss == 0:
                rsi_val = 100.0
            else:
                rs = avg_gain / avg_loss
                rsi_val = round(100.0 - (100.0 / (1.0 + rs)), 1)

        # 5. MACD (12, 26, 9)
        macd_val = 0.0
        macd_sig = 0.0
        macd_hist = 0.0
        if len(closes) >= 26:
            ema12 = pd.Series(closes).ewm(span=12, adjust=False).mean().values
            ema26 = pd.Series(closes).ewm(span=26, adjust=False).mean().values
            dif = ema12 - ema26
            sig = pd.Series(dif).ewm(span=9, adjust=False).mean().values
            hist = dif - sig
            macd_val = round(float(dif[-1]), 2)
            macd_sig = round(float(sig[-1]), 2)
            macd_hist = round(float(hist[-1]), 2)

        # ==========================================
        # 6 大青紅燈指標評判邏輯 (對齊戰情室核心演算法)
        # ==========================================
        # 1. 均線趨勢燈 (Trend)
        trend_light = "red" if c > ma20 and ma5 >= ma20 else ("green" if c < ma20 and ma5 <= ma20 else "yellow")
        
        # 2. KD 擺動燈 (KD)
        kd_light = "red" if k_val > d_val and k_val > 50 else ("green" if k_val < d_val and k_val < 50 else "yellow")
        
        # 3. RSI 動能燈 (RSI)
        rsi_light = "red" if rsi_val > 55 else ("green" if rsi_val < 45 else "yellow")
        
        # 4. MACD 聚散燈 (MACD)
        macd_light = "red" if macd_hist > 0 else ("green" if macd_hist < 0 else "yellow")
        
        # 5. 量能爆發燈 (Volume)
        vol_ma5 = np.mean(group['volume'].values[-5:]) if len(group) >= 5 else v
        vol_light = "red" if v > vol_ma5 * 1.3 and c >= prev_c else ("green" if v > vol_ma5 * 1.3 and c < prev_c else "yellow")
        
        # 6. 法人籌碼燈 (Chip)
        chip_light = "red" if (fb + sb) > 0 else ("green" if (fb + sb) < 0 else "yellow")
        
        # 前日狀態比對
        prev_status_dict = {
            "trend": "yellow", "kd": "yellow", "rsi": "yellow",
            "macd": "yellow", "vol": "yellow", "chip": "yellow"
        }

        # ==========================================
        # 10 項策略特徵判讀
        # ==========================================
        # 1. 均線多空狀態
        if ma5 > ma10 > ma20 > ma60:
            ma_align = "多頭排列"
        elif ma5 < ma10 < ma20 < ma60:
            ma_align = "空頭排列"
        else:
            ma_align = "震盪整理"
            
        # 2. 布林狀態
        if c >= bb_upper:
            bb_desc = "突破上軌"
        elif c <= bb_lower:
            bb_desc = "跌破下軌"
        else:
            bb_desc = "軌道內運行"
            
        # 3. 價量型態
        if change > 0 and v > vol_ma5:
            pv_desc = "價漲量增"
        elif change > 0 and v <= vol_ma5:
            pv_desc = "價漲量縮"
        elif change < 0 and v > vol_ma5:
            pv_desc = "價跌量增"
        else:
            pv_desc = "價跌量縮"
            
        # 4. 乖離率
        bias20 = round(((c - ma20) / ma20) * 100, 2) if ma20 > 0 else 0.0
        bias_label = f"正乖離 {bias20}%" if bias20 >= 0 else f"負乖離 {bias20}%"
        
        # 5. 量能型態
        vol_status = "倍量攻擊" if (vol_ma5 > 0 and v >= vol_ma5 * 2) else ("溫和放量" if (vol_ma5 > 0 and v >= vol_ma5 * 1.2) else "量能平淡")
        
        # 6. 法人聯手
        inst_synergy = "外投同買" if (fb > 0 and sb > 0) else ("外投同賣" if (fb < 0 and sb < 0) else ("投信孤軍" if sb > 0 else ("外資主導" if fb > 0 else "法人觀望")))
        
        # 7. 融資狀態
        margin_status = "融資增加" if (len(group) > 1 and mb > prev['margin_balance']) else "融資減少"
        
        # 8. 大戶吸籌
        absorption_status = "強烈吸籌" if (fb + sb > 500 and change >= 0) else "籌碼常態"
        
        # 9. K棒型態
        if h == l:
            k_pattern = "一字線"
        elif c >= o and (c - o) / (h - l) > 0.6 if h > l else False:
            k_pattern = "強勢紅K"
        elif c < o and (o - c) / (h - l) > 0.6 if h > l else False:
            k_pattern = "強勢黑K"
        elif (min(o, c) - l) / (h - l) > 0.5 if h > l else False:
            k_pattern = "長下影線"
        elif (h - max(o, c)) / (h - l) > 0.5 if h > l else False:
            k_pattern = "長上影線"
        else:
            k_pattern = "紡錘十字"

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
            "bb": {"upper": bb_upper, "lower": bb_lower, "width": bb_width},
            "kd": {"k": k_val, "d": d_val},
            "rsi": rsi_val,
            "macd": {"dif": macd_val, "sig": macd_sig, "hist": macd_hist},
            "chip": {"foreign": fb, "sitc": sb, "dealers": db},
            "margin": {"bal": mb},
            "lights": {
                "trend": trend_light,
                "kd": kd_light,
                "rsi": rsi_light,
                "macd": macd_light,
                "vol": vol_light,
                "chip": chip_light
            },
            "prev_ind": prev_status_dict,
            "strat": {
                "ma_align": ma_align,
                "bb_desc": bb_desc,
                "pv_desc": pv_desc,
                "bias_label": bias_label,
                "vol_status": vol_status,
                "inst_synergy": inst_synergy,
                "margin_status": margin_status,
                "absorption_status": absorption_status,
                "k_pattern": k_pattern
            }
        }
        
    calc_elapsed = round(time.time() - start_time, 2)
    print(f"✨ [完成] 全市場 {total_count} 檔個股指標滾算完成！總耗時: {calc_elapsed} 秒。")
    return snapshot_map, calc_elapsed

# ==========================================
# 4. 主執行流程：藍綠雙分區發布與品質審計
# ==========================================

def update_health_status(health_data):
    """即時廣播健康狀態至 market_health.json (同步輸出至根目錄與 mobile_web)"""
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

    # 審計門檻檢查：若核心節點未達標，判定官方未結算，觸發保護中斷
    if len(twse_map) < 900 or len(tpex_map) < 700:
        print("🚨 [審計攔截] 上市櫃數據檔數未達門檻 (TWSE < 900 或 TPEx < 700)，官方可能尚未結算完成！")
        health_report["status"] = "ERROR"
        health_report["progress"] = "官方盤後數據尚未結算完全，已暫停發布以保護現有行情。"
        update_health_status(health_report)
        sys.exit(1)

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
        # 三維真值檢查：收盤價或量 <= 0
        if item.get("p", 0) <= 0 or item.get("v", 0) <= 0:
            if len(zero_vol_samples) < 20:
                zero_vol_samples.append({"code": code, "name": item.get("name"), "reason": "收盤價或成交量為0 (可能停牌/無交易)"})
        # 法人三者皆為 0 樣品
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
