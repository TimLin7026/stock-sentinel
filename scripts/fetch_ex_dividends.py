# -*- coding: utf-8 -*-
"""
💎 台股戰情室 — 全市場除權息公共資料管線 (TWSE + TPEX + 殖利率)
產出檔案：market_ex_dividends.json (第 7 大公共靜態 JSON)
"""

import urllib.request
import ssl
import json
import datetime
import os
import re

def clean_num(val):
    if val is None:
        return 0.0
    s = str(val).replace(',', '').strip()
    try:
        return float(s)
    except:
        return 0.0

def roc_to_ad(roc_date_str):
    """
    轉換民國日期為西元 YYYY-MM-DD
    支援格式：115年11月13日 或 1151113
    """
    if not roc_date_str:
        return ""
    s = str(roc_date_str).strip()
    
    # 匹配 115年11月13日
    m1 = re.search(r'(\d+)年(\d+)月(\d+)日', s)
    if m1:
        roc_year = int(m1.group(1))
        month = int(m1.group(2))
        day = int(m1.group(3))
        ad_year = roc_year + 1911
        return f"{ad_year:04d}-{month:02d}-{day:02d}"
    
    # 匹配 1151113 (7碼) 或 991113 (6碼)
    digits = re.sub(r'\D', '', s)
    if len(digits) == 7:
        roc_year = int(digits[:3])
        month = int(digits[3:5])
        day = int(digits[5:7])
        return f"{roc_year + 1911:04d}-{month:02d}-{day:02d}"
    elif len(digits) == 6:
        roc_year = int(digits[:2])
        month = int(digits[2:4])
        day = int(digits[4:6])
        return f"{roc_year + 1911:04d}-{month:02d}-{day:02d}"
        
    return s

def fetch_data():
    ctx = ssl._create_unverified_context()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    today_date = datetime.date.today()
    
    # 1. 抓取全市場殖利率表 (TWSE BWIBBU_ALL)
    yield_map = {}
    try:
        url_yield = "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL"
        req = urllib.request.Request(url_yield, headers=headers)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if isinstance(data, list):
                for item in data:
                    c = item.get("Code", "").strip()
                    y = item.get("DividendYield", "").strip()
                    if c and y:
                        yield_map[c] = y
        print(f"[OK] Yield map fetched: {len(yield_map)} items")
    except Exception as e:
        print(f"[WARN] Yield fetch failed: {e}")

    items = []
    seen_codes = set()

    # 2. 抓取證交所 (TWSE) 上市除權息預告表
    try:
        url_twse = "https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json"
        req = urllib.request.Request(url_twse, headers=headers)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            twse_json = json.loads(resp.read().decode('utf-8'))
            rows = twse_json.get("data", [])
            for r in rows:
                if len(r) < 8:
                    continue
                # r[0]: 日期 (115年11月06日), r[1]: 代號, r[2]: 名稱, r[3]: 類別, r[7]: 現金股利
                raw_date = r[0]
                code = str(r[1]).strip()
                name = str(r[2]).strip()
                ex_type = str(r[3]).strip()
                cash_div = clean_num(r[7])
                ad_date = roc_to_ad(raw_date)
                
                # 計算距離今天天數
                days_left = 0
                try:
                    d_obj = datetime.datetime.strptime(ad_date, "%Y-%m-%d").date()
                    days_left = (d_obj - today_date).days
                except:
                    pass
                
                div_yield = yield_map.get(code, "")
                if div_yield:
                    div_yield_str = f"{clean_num(div_yield):.2f}%"
                else:
                    div_yield_str = ""

                item = {
                    "code": code,
                    "name": name,
                    "market": "上市",
                    "exDate": ad_date,
                    "daysLeft": days_left,
                    "exType": ex_type,
                    "cashDividend": cash_div,
                    "dividendYield": div_yield_str
                }
                # 🎯 配合 Gem 戰報收斂至「過去 10 天內剛除息 ～ 未來 14 天內即將除息」
                if -10 <= days_left <= 14:
                    items.append(item)
                    seen_codes.add(code)
        print(f"[OK] TWSE fetched: {len(items)} items")
    except Exception as e:
        print(f"[WARN] TWSE fetch failed: {e}")

    # 3. 抓取櫃買中心 (TPEX) 上櫃除權息預告表
    try:
        url_tpex = "https://www.tpex.org.tw/www/zh-tw/bulletin/prePost"
        req = urllib.request.Request(url_tpex, headers=headers)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            tpex_json = json.loads(resp.read().decode('utf-8'))
            tables = tpex_json.get("tables", [])
            if tables and len(tables) > 0:
                rows = tables[0].get("data", [])
                for r in rows:
                    if len(r) < 8:
                        continue
                    # r[0]: 日期 (民國), r[1]: 代號, r[2]: 名稱, r[3]: 類別, r[7]: 現金股利
                    raw_date = r[0]
                    code = str(r[1]).strip()
                    name = str(r[2]).strip()
                    ex_type = str(r[3]).strip()
                    cash_div = clean_num(r[7])
                    ad_date = roc_to_ad(raw_date)
                    
                    days_left = 0
                    try:
                        d_obj = datetime.datetime.strptime(ad_date, "%Y-%m-%d").date()
                        days_left = (d_obj - today_date).days
                    except:
                        pass
                    
                    div_yield = yield_map.get(code, "")
                    if div_yield:
                        div_yield_str = f"{clean_num(div_yield):.2f}%"
                    else:
                        div_yield_str = ""

                    item = {
                        "code": code,
                        "name": name,
                        "market": "上櫃",
                        "exDate": ad_date,
                        "daysLeft": days_left,
                        "exType": ex_type,
                        "cashDividend": cash_div,
                        "dividendYield": div_yield_str
                    }
                    # 🎯 配合 Gem 戰報收斂至「過去 10 天內剛除息 ～ 未來 14 天內即將除息」
                    if -10 <= days_left <= 14:
                        items.append(item)
        print(f"[OK] TPEX fetched, total: {len(items)} items")
    except Exception as e:
        print(f"[WARN] TPEX fetch failed: {e}")

    # 依除息日期排序（最近除息排前面）
    items.sort(key=lambda x: x.get("exDate", "9999-99-99"))

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    result = {
        "updatedAt": now_str,
        "count": len(items),
        "items": items
    }
    
    return result

def main():
    # 設定標準輸出為 utf-8
    import sys
    if sys.stdout.encoding.lower() != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except:
            pass
    print("=== Start fetch_ex_dividends ===")
    data = fetch_data()
    
    # 決定輸出路徑：專案根目錄的 market_ex_dividends.json
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, ".."))
    out_path = os.path.join(project_root, "market_ex_dividends.json")
    
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        
    print(f"[SUCCESS] Ex-dividends saved to {out_path}, count: {data['count']}")

if __name__ == "__main__":
    main()
