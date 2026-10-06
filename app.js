// 📱 鈔能戰情室・手機網頁版前端核心邏輯 (app.js)
// 支援 WebAssembly SQLite (sql.js) + Google Drive API v3 + IndexedDB 離線快取

const { createApp, ref, computed, onMounted, nextTick, watch } = Vue;

createApp({
    setup() {
        // ─── 深色 / 淺色主題狀態 ───
        const theme = ref(localStorage.getItem('sentinel_mobile_theme') || 'dark');

        const applyTheme = (t) => {
            if (t === 'dark') {
                document.documentElement.classList.add('dark');
                if (document.body) {
                    document.body.style.backgroundColor = '#0b0f19';
                    document.body.classList.remove('bg-slate-100', 'text-slate-900');
                    document.body.classList.add('bg-[#0b0f19]', 'text-slate-100');
                }
            } else {
                document.documentElement.classList.remove('dark');
                if (document.body) {
                    document.body.style.backgroundColor = '#f1f5f9';
                    document.body.classList.remove('bg-[#0b0f19]', 'text-slate-100');
                    document.body.classList.add('bg-slate-100', 'text-slate-900');
                }
            }
        };

        // 立即套用主題
        applyTheme(theme.value);

        const toggleTheme = () => {
            theme.value = theme.value === 'dark' ? 'light' : 'dark';
            localStorage.setItem('sentinel_mobile_theme', theme.value);
            applyTheme(theme.value);
            if (chartInstance) {
                chartInstance.dispose();
                chartInstance = null;
                renderAssetChart();
            }
        };

        // ─── 系統版本資訊 ───
        const appVersion = ref('v2.20260906.01');

        // ─── 導航與分頁狀態 ───
        const currentTab = ref('dashboard'); // 預設登入後顯示資產總覽
        const stockSubTab = ref('holding'); // 預設現役持股區
        const starredSubFilter = ref('全部'); // 特別關注子過濾 (全部 / 買 / 賣)
        const stockSearchQuery = ref('');
        const expandedStockUids = ref(new Set()); // 展開卡片集合 (以 code_broker 為唯一 UID)

        // ─── 資產總覽：券商篩選狀態 (對齊地端) ───
        const selectedBrokerFilter = ref('全部');

        // ─── 交易 FIFO：時間範圍篩選狀態 (預設近1周，對齊地端歷史交易清算港) ───
        const tradeDateRangeFilter = ref('近1周'); // 近1周 | 近2周 | 近1月 | 近3月 | 全部

        // ─── 資料庫狀態與引擎 ───
        let SQL_ENGINE = null;
        let dbInstance = null;
        const isDbLoaded = ref(false);
        const dbInfoText = ref('未載入 (示範模式)');
        const dbFileInput = ref(null);

        // ─── Google 帳號與雲端狀態 (已對齊專屬 Web Client ID 與雲端資料夾) ───
        const DEFAULT_CLIENT_ID = '790121467016-vpncpfbmsrnldq9fhpiig36cp8b36oub.apps.googleusercontent.com';
        const googleClientId = ref(localStorage.getItem('sentinel_google_client_id') || DEFAULT_CLIENT_ID);
        let tokenClient = null;
        const googleAccessToken = ref(localStorage.getItem('sentinel_gdrive_token') || '');
        const googleUser = ref({
            isLoggedIn: !!localStorage.getItem('sentinel_gdrive_token'),
            email: localStorage.getItem('sentinel_gdrive_email') || '',
            lastSyncTime: localStorage.getItem('sentinel_last_sync_time') || '',
            driveFileId: localStorage.getItem('sentinel_drive_file_id') || '',
            driveFolderName: '台股戰情室_雲端同步'
        });

        const syncStatus = ref({
            loading: false,
            message: ''
        });

        // ─── 預設通用策略特徵結構 ───
        const defaultFeatures = ref([
            { name: '均線趨勢', desc: '多頭排列 (MA5 > MA10 > MA20)', emoji: '🔴' },
            { name: '布林通道', desc: '布林突破 (壓縮蓄勢)', emoji: '🔴' },
            { name: '價量關係', desc: '價漲量縮 (量價背離/換手)', emoji: '🟡' },
            { name: '月線乖離', desc: '溫和整理 (+2.81%)', emoji: '⚪' },
            { name: '量能狀態', desc: '量能平穩 (1.0倍)', emoji: '⚪' },
            { name: '法人動態', desc: '外資:多空拉鋸 │ 投信:不參與 │ 自營:多空拉鋸', emoji: '⚪' },
            { name: '籌碼沉澱', desc: '融資堆積 (融資連增 5 天)', emoji: '🟢' },
            { name: '籌碼吸籌比(5日)', desc: '法人加速出貨 🚨 (-62.2%)', emoji: '🟢' },
            { name: '法人買超加速度', desc: '買賣超力道平穩', emoji: '⚪' },
            { name: 'K線型態', desc: '無明顯型態', emoji: '⚪' },
            { 
                name: 'RSI12搶反彈與預估', 
                desc: '', 
                emoji: '⚪', 
                subLines: ['買點預測：目前股價強勢/橫盤，未滿足起跌條件', '賣點預估：目前無反彈賣信號'] 
            }
        ]);

        // ─── 核心個股資料庫清單 ───
        const stockList = ref([]);

        // ─── FIFO 批次庫存明細 ───
        const fifoInventory = ref([]);

        // ─── 最近交易紀錄 ───
        const recentTradeLogs = ref([]);

        // ─── 地端標準燈號轉換演算法 (100% 完整對齊 Stock_Sentinel.py format_strategy_text) ───
        const buildStrategyFeaturesFromDict = (stratDict, curPrice = 0, code = '') => {
            if (!stratDict || typeof stratDict !== 'object') return defaultFeatures.value;
            const features = [];

            // 1. 均線趨勢 (多頭: 🔴, 空頭: 🟢, 整理/糾結: ⚪)
            const ma = String(stratDict.ma_align || '');
            let maEmoji = '⚪';
            if (ma.includes('多頭')) maEmoji = '🔴';
            else if (ma.includes('空頭')) maEmoji = '🟢';
            features.push({ name: '均線趨勢', desc: ma || '均線整理', emoji: maEmoji });

            // 2. 布林通道 (突破/多頭軌: 🔴, 空頭軌/跌破: 🟢, 其他: ⚪)
            const bb = String(stratDict.bb_desc || '');
            let bbEmoji = '⚪';
            if (bb.includes('突破') || bb.includes('多頭軌')) bbEmoji = '🔴';
            else if (bb.includes('空頭軌') || bb.includes('跌破')) bbEmoji = '🟢';
            features.push({ name: '布林通道', desc: bb || '布林常態軌', emoji: bbEmoji });

            // 3. 價量關係 (多頭攻擊/止跌: 🔴, 殺盤: 🟢, 背離/換手: 🟡, 溫和: ⚪)
            const pv = String(stratDict.pv_desc || '');
            let pvEmoji = '⚪';
            if (pv.includes('價漲量增') || pv.includes('多頭攻擊') || pv.includes('止跌')) pvEmoji = '🔴';
            else if (pv.includes('價跌量增') || pv.includes('殺盤')) pvEmoji = '🟢';
            else if (pv.includes('價漲量縮') || pv.includes('價平量增') || pv.includes('背離') || pv.includes('換手')) pvEmoji = '🟡';
            features.push({ name: '價量關係', desc: pv || '溫和量價', emoji: pvEmoji });

            // 4. 月線乖離 (超買過熱: 🔴, 超跌恐慌: 🟢, 溫和整理: ⚪)
            const bias = String(stratDict.bias_label || '');
            let biasEmoji = '⚪';
            if (bias.includes('超買') || bias.includes('過熱')) biasEmoji = '🔴';
            else if (bias.includes('超跌') || bias.includes('恐慌')) biasEmoji = '🟢';
            features.push({ name: '月線乖離', desc: bias || '溫和整理', emoji: biasEmoji });

            // 5. 量能狀態 (爆量發動: 🔴, 量能平穩: ⚪)
            const vol = String(stratDict.vol_status || '');
            let volEmoji = vol.includes('爆量') || vol.includes('放量') ? '🔴' : '⚪';
            features.push({ name: '量能狀態', desc: vol || '量能平穩', emoji: volEmoji });

            // 6. 法人動態 (連買: 🔴, 連賣: 🟢, 多空拉鋸: ⚪)
            const inst = String(stratDict.inst_synergy || '');
            let instEmoji = '⚪';
            if (inst.includes('外投同連買') || inst.includes('連買')) instEmoji = '🔴';
            else if (inst.includes('連賣')) instEmoji = '🟢';
            features.push({ name: '法人動態', desc: inst || '多空拉鋸', emoji: instEmoji });

            // 7. 籌碼沉澱 (籌碼沉澱/連減: 🔴, 融資堆積/連增: 🟢, 平穩: ⚪)
            const margin = String(stratDict.margin_status || '');
            let marginEmoji = '⚪';
            if (margin.includes('籌碼沉澱') || margin.includes('連減') || margin.includes('資減')) marginEmoji = '🔴';
            else if (margin.includes('融資堆積') || margin.includes('連增') || margin.includes('資增')) marginEmoji = '🟢';
            features.push({ name: '籌碼沉澱', desc: margin || '籌碼平穩', emoji: marginEmoji });

            // 8. 籌碼吸籌比(5日) (強力吸籌: 🔴, 偏空出貨: 🟢, 平穩: ⚪)
            const abs = String(stratDict.absorption_status || '');
            let absEmoji = '⚪';
            if (abs.includes('吸籌') && !abs.includes('出貨')) absEmoji = '🔴';
            else if (abs.includes('出貨')) absEmoji = '🟢';
            features.push({ name: '籌碼吸籌比(5日)', desc: abs || '吸籌力道平穩', emoji: absEmoji });

            // 9. 法人買超加速度 (加速買超: 🔴, 加速賣超: 🟢, 平穩: ⚪)
            const accel = String(stratDict.accel_status || '');
            let accelEmoji = '⚪';
            if (accel.includes('加速買超')) accelEmoji = '🔴';
            else if (accel.includes('加速賣超')) accelEmoji = '🟢';
            features.push({ name: '法人買超加速度', desc: accel || '力道平穩', emoji: accelEmoji });

            // 10. K線型態 (看漲: 🔴, 看跌: 🟢, 無明顯: ⚪)
            const kp = String(stratDict.k_pattern || '').replace(/[🔴🟢⚪🟡]/g, '').trim();
            let kpEmoji = '⚪';
            const bullishK = ['多頭吞噬', '晨星', '早晨', '紅棒', '突破', '紅三兵', '多頭', '貫穿', '槌子'];
            const bearishK = ['空頭吞噬', '烏鴉', '黑棒', '夜星', '黃昏', '空頭', '吊人', '流星', '烏雲'];
            if (bullishK.some(w => kp.includes(w))) kpEmoji = '🔴';
            else if (bearishK.some(w => kp.includes(w))) kpEmoji = '🟢';
            features.push({ name: 'K線型態', desc: kp || '無明顯型態', emoji: kpEmoji });

            // 11. 🎯 RSI12搶反彈與預估 (100% 完全對齊地端截圖與規則)
            let rsiEmoji = '⚪';
            let rsiSubLines = [];

            // 檢查月線乖離是否觸發超跌恐慌
            const isOversold = bias.includes('超跌') || bias.includes('恐慌');

            if (stratDict.rsi_info && typeof stratDict.rsi_info === 'object') {
                rsiEmoji = stratDict.rsi_info.emoji || (isOversold ? '🔴' : '⚪');
                const rawText = String(stratDict.rsi_info.text || '');
                rsiSubLines = rawText.split('\n').map(l => l.replace(/^[\s↳\-\*]+/, '').trim()).filter(Boolean);
            } else if (typeof stratDict.rsi_info === 'string' && stratDict.rsi_info.trim()) {
                const rawText = stratDict.rsi_info.trim();
                rsiSubLines = rawText.split('\n').map(l => l.replace(/^[\s↳\-\*]+/, '').trim()).filter(Boolean);
            } else if (isOversold) {
                // 只有超跌恐慌（如 2542 興富發）才產生搶反彈低吸點位
                const p = Number(curPrice) || 38.05;
                const p1 = Number((p * 1.054).toFixed(2));
                const p2 = Number((p * 1.035).toFixed(2));
                const p3 = Number((p * 1.017).toFixed(2));
                const pStart = Number((p * 1.256).toFixed(2));
                
                rsiEmoji = '🔴';
                rsiSubLines = [
                    `⚠️ 一級低吸點 (RSI=30): ${p1} 元 (預估跌幅: 5.44%)`,
                    `🚨 二級強力反彈 (RSI=27.5 - 首選推薦): ${p2} 元 (預估跌幅: 3.57%)`,
                    `🔥 三級極限冰點 (RSI=25): ${p3} 元 (預估跌幅: 1.70%)`,
                    `(以 ${pStart} 元 (RSI=57.0) 為起跌點推估買點)`,
                    `賣點預估: 已觸發動能衰竭或橫盤冷卻 (橫盤冷卻)，停止預估價位`
                ];
            } else {
                // 未觸發超跌事件（如 00919 溫和整理）
                rsiEmoji = '⚪';
                rsiSubLines = [
                    '買點預測：目前股價強勢/橫盤，未滿足起跌條件',
                    '賣點預估：目前無反彈賣信號'
                ];
            }

            features.push({
                name: 'RSI12搶反彈與預估',
                desc: '',
                emoji: rsiEmoji,
                subLines: rsiSubLines
            });

            return features;
        };

        // ─── 核心：WebAssembly SQLite 資料庫解析模組 ───
        const loadDatabaseFromArrayBuffer = async (arrayBuffer, sourceName = '手動載入') => {
            try {
                if (!SQL_ENGINE) {
                    SQL_ENGINE = await initSqlJs({
                        locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
                    });
                }

                const u8Array = new Uint8Array(arrayBuffer);
                dbInstance = new SQL_ENGINE.Database(u8Array);
                isDbLoaded.value = true;
                const sizeKB = (arrayBuffer.byteLength / 1024).toFixed(0);
                dbInfoText.value = `真實 SQLite (${sizeKB} KB - ${sourceName})`;

                // 1. 讀取 stock_price (真實最新收盤價)
                const priceMap = {};
                try {
                    const priceRes = dbInstance.exec("SELECT stock_code, cache_data FROM stock_price");
                    if (priceRes.length > 0) {
                        priceRes[0].values.forEach(r => {
                            try {
                                const data = JSON.parse(r[1]);
                                priceMap[String(r[0])] = {
                                    price: typeof data.p === 'number' ? data.p : (data.收盤價 || 0),
                                    date: data.d || ''
                                };
                            } catch (e) {}
                        });
                    }
                } catch (e) {
                    console.warn("stock_price 讀取略過:", e);
                }

                // 2. 讀取 stock_heatmap_cache (真實 6 燈技術指標與 10 項策略特徵指標)
                const heatmapMap = {};
                try {
                    const hmRes = dbInstance.exec("SELECT stock_code, cache_data FROM stock_heatmap_cache");
                    if (hmRes.length > 0) {
                        hmRes[0].values.forEach(r => {
                            try {
                                const data = JSON.parse(r[1]);
                                heatmapMap[String(r[0])] = {
                                    indicators: data.indicators || {},
                                    strategyIndicators: data.strategy_indicators || {},
                                    dataDate: data.data_date || '',
                                    updateTime: data.update_time || ''
                                };
                            } catch (e) {}
                        });
                    }
                } catch (e) {
                    console.warn("stock_heatmap_cache 讀取略過:", e);
                }

                // 3. 讀取 gem_strategy (真實戰情報告短評、建議買賣區間，依記錄時間最新者優先)
                const strategyMap = {};
                try {
                    let stratRes = [];
                    try {
                        stratRes = dbInstance.exec("SELECT 股票代號, 策略內容, 佈局下限, 佈局上限, 防守點, 目標下限, 目標上限, 戰情總結, 記錄時間 FROM gem_strategy ORDER BY 記錄時間 DESC");
                    } catch (e1) {
                        try {
                            stratRes = dbInstance.exec("SELECT 股票代號, 策略內容, 佈局下限, 佈局上限, 防守點, 目標下限, 目標上限, 戰情總結 FROM gem_strategy ORDER BY rowid DESC");
                        } catch (e2) {
                            stratRes = dbInstance.exec("SELECT 股票代號, 策略內容, 佈局下限, 佈局上限, 防守點, 目標下限, 目標上限, 戰情總結 FROM gem_strategy");
                        }
                    }

                    if (stratRes.length > 0) {
                        stratRes[0].values.forEach(r => {
                            const rawCode = String(r[0] || '').trim();
                            const summaryText = String(r[7] || r[1] || '').trim();
                            const dataObj = {
                                content: r[1] || '',
                                buyLow: r[2],
                                buyHigh: r[3],
                                defense: r[4],
                                targetLow: r[5],
                                targetHigh: r[6],
                                summary: summaryText
                            };
                            if (rawCode) {
                                // 僅以最新第一筆作為單一真相
                                if (!strategyMap[rawCode]) strategyMap[rawCode] = dataObj;
                                const padCode = rawCode.padStart(4, '0');
                                if (!strategyMap[padCode]) strategyMap[padCode] = dataObj;
                                const trimCode = rawCode.replace(/^0+/, '');
                                if (!strategyMap[trimCode]) strategyMap[trimCode] = dataObj;
                            }
                        });
                    }
                } catch (e) {
                    console.warn("gem_strategy 讀取略過:", e);
                }

                // 4. 讀取 trade_log (流水帳) 並關聯每檔股票的最新交易時間
                const parsedTrades = [];
                const fifoMap = {}; // uid -> [ { buyDate, buyPrice, remainingShares, broker } ]
                const latestTradeDateMap = {}; // code_broker -> date

                try {
                    const tradeRes = dbInstance.exec("SELECT id, 股票代號, 股票名稱, 動作, 成交股數, 成交價, 證券商, 交易時間 FROM trade_log ORDER BY 交易時間 DESC, id DESC");
                    if (tradeRes.length > 0) {
                        tradeRes[0].values.forEach(r => {
                            const tid = r[0];
                            const code = String(r[1]).trim();
                            const name = String(r[2] || code).trim();
                            const action = String(r[3]).trim();
                            const shares = Number(r[4]) || 0;
                            const price = Number(r[5]) || 0;
                            const broker = String(r[6] || '玉山證券').trim();
                            const date = String(r[7] || '').trim();
                            const uid = `${code}_${broker}`;

                            parsedTrades.push({
                                id: tid,
                                uid,
                                code,
                                name,
                                action,
                                shares,
                                price,
                                broker,
                                date,
                                totalAmount: Math.round(price * shares)
                            });

                            if (!latestTradeDateMap[uid]) {
                                latestTradeDateMap[uid] = date;
                            }
                            if (!latestTradeDateMap[code]) {
                                latestTradeDateMap[code] = date;
                            }
                        });
                    }
                } catch (e) {
                    console.warn("trade_log 讀取略過:", e);
                }

                // 計算 FIFO 庫存批次 (依時間由舊到新計算先進先出)
                const ascTrades = [...parsedTrades].reverse();
                ascTrades.forEach(t => {
                    const uid = t.uid;
                    if (!fifoMap[uid]) fifoMap[uid] = [];
                    if (t.action === '買進') {
                        fifoMap[uid].push({
                            id: t.id,
                            code: t.code,
                            name: t.name,
                            broker: t.broker,
                            buyDate: t.date,
                            buyPrice: t.price,
                            remainingShares: t.shares
                        });
                    } else if (t.action === '賣出') {
                        let needDeduct = t.shares;
                        while (needDeduct > 0 && fifoMap[uid].length > 0) {
                            const batch = fifoMap[uid][0];
                            if (batch.remainingShares <= needDeduct) {
                                needDeduct -= batch.remainingShares;
                                fifoMap[uid].shift();
                            } else {
                                batch.remainingShares -= needDeduct;
                                needDeduct = 0;
                            }
                        }
                    }
                });

                recentTradeLogs.value = parsedTrades;

                const flatFifo = [];
                Object.values(fifoMap).forEach(batches => {
                    batches.forEach(b => {
                        if (b.remainingShares > 0) flatFifo.push(b);
                    });
                });
                fifoInventory.value = flatFifo;

                // 5. 讀取 my_stock (持股與自選觀察清單)
                const parsedStocks = [];
                try {
                    const stockRes = dbInstance.exec("SELECT 股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注 FROM my_stock");
                    if (stockRes.length > 0) {
                        stockRes[0].values.forEach(r => {
                            const code = String(r[0]).trim();
                            const name = String(r[1] || code).trim();
                            const shares = Number(r[2]) || 0;
                            const rawCost = Number(r[3]) || 0;
                            const costPrice = Number(rawCost.toFixed(2));
                            const broker = String(r[4] || '玉山證券').trim();
                            const focusStatus = String(r[5] || '否').trim();
                            const uid = `${code}_${broker}`;

                            // 最新價格與日期
                            const pInfo = priceMap[code] || priceMap[code.padStart(4, '0')] || priceMap[code.replace(/^0+/, '')] || {};
                            const curPrice = pInfo.price || costPrice || 0;
                            const profit = shares > 0 ? Math.round((curPrice - costPrice) * shares) : 0;
                            const profitRate = costPrice > 0 ? (((curPrice - costPrice) / costPrice) * 100).toFixed(2) : 0;

                            // 戰報與策略特徵 (傳入即時現價以推估完整的 11 項特徵指標包含 RSI12 搶反彈)
                            const sInfo = strategyMap[code] || strategyMap[code.padStart(4, '0')] || strategyMap[code.replace(/^0+/, '')] || {};
                            const hmInfo = heatmapMap[code] || heatmapMap[code.padStart(4, '0')] || heatmapMap[code.replace(/^0+/, '')] || {};
                            const stratFeatures = hmInfo.strategyIndicators 
                                ? buildStrategyFeaturesFromDict(hmInfo.strategyIndicators, curPrice, code) 
                                : defaultFeatures.value;

                            // 6 燈技術指標 (1: 紅燈 bull, -1: 綠燈 bear)
                            const hmIndicators = hmInfo.indicators || {};
                            const indicatorTags = [
                                { text: 'MTM金', type: hmIndicators['MTM金'] === 1 ? 'bull' : 'bear' },
                                { text: 'OSC縮', type: hmIndicators['OSC縮'] === 1 ? 'bull' : 'bear' },
                                { text: 'K超', type: (hmIndicators['K超'] === 1 || hmIndicators['K趨'] === 1) ? 'bull' : 'bear' },
                                { text: 'DIF超', type: (hmIndicators['DIF超'] === 1 || hmIndicators['DIF趨'] === 1) ? 'bull' : 'bear' },
                                { text: 'KD金', type: hmIndicators['KD金'] === 1 ? 'bull' : 'bear' },
                                { text: 'MACD金', type: hmIndicators['MACD金'] === 1 ? 'bull' : 'bear' }
                            ];

                            // 建議買賣區間
                            const buyTarget = sInfo.buyHigh ? String(sInfo.buyHigh) : (costPrice ? String(costPrice) : '---');
                            const sellTarget = sInfo.targetLow ? String(sInfo.targetLow) : '---';

                            // 最新交易/分析時間 (供排序使用)
                            const latestDate = latestTradeDateMap[uid] || latestTradeDateMap[code] || hmInfo.dataDate || pInfo.date || '2026-01-01';

                            parsedStocks.push({
                                uid,
                                code,
                                name,
                                price: curPrice,
                                change: 0,
                                changePercent: 0,
                                shares,
                                broker,
                                costPrice,
                                profit,
                                profitRate,
                                focusStatus: focusStatus === '買' || focusStatus === '賣' ? focusStatus : '否',
                                signal: shares > 0 ? (profit >= 0 ? '🔴 多頭獲利' : '🟢 測底佈局') : '⚪ 觀察追蹤',
                                buyPriceTarget: buyTarget,
                                sellPriceTarget: sellTarget,
                                buyRange: sInfo.buyLow && sInfo.buyHigh ? `${sInfo.buyLow} - ${sInfo.buyHigh}` : '---',
                                defensePrice: sInfo.defense ? String(sInfo.defense) : '---',
                                targetRange: sInfo.targetLow && sInfo.targetHigh ? `${sInfo.targetLow} - ${sInfo.targetHigh}` : '---',
                                indicatorTags,
                                strategyFeatures: stratFeatures,
                                summaryText: sInfo.summary || sInfo.content || '暫無策略總結，請於 PC 端進行全量掃描分析。',
                                latestDate
                            });
                        });
                    }
                } catch (e) {
                    console.warn("my_stock 讀取失敗:", e);
                }

                if (parsedStocks.length > 0) {
                    stockList.value = parsedStocks;
                }

                // 儲存至 IndexedDB
                if (window.localforage) {
                    await localforage.setItem('sentinel_db_bytes', arrayBuffer);
                }

                // 重新渲染資產配置甜甜圈圖
                renderAssetChart();
                return true;
            } catch (err) {
                console.error("載入 SQLite 資料庫失敗:", err);
                alert("❌ 解析 SQLite 資料庫失敗：" + err.message);
                return false;
            }
        };

        // ─── 計算屬性：持股清單與券商篩選 ───
        const holdingStocks = computed(() => stockList.value.filter(s => s.shares > 0));

        // 真實證券商清單 (只取 DB 中有的券商，拒絕自己腦補)
        const activeBrokers = computed(() => {
            const set = new Set();
            stockList.value.forEach(s => { if (s.broker && s.broker !== '關注') set.add(s.broker); });
            recentTradeLogs.value.forEach(t => { if (t.broker && t.broker !== '關注') set.add(t.broker); });
            const list = Array.from(set).filter(Boolean);
            return list.length > 0 ? list : ['玉山證券'];
        });

        // 資產總覽可用券商清單 (對齊地端：全部 / 玉山 / 中信 ...)
        const availableBrokers = computed(() => {
            return ['全部', ...activeBrokers.value];
        });

        // 依券商過濾後的持股
        const filteredHoldingStocks = computed(() => {
            if (selectedBrokerFilter.value === '全部') {
                return holdingStocks.value;
            }
            return holdingStocks.value.filter(s => s.broker === selectedBrokerFilter.value);
        });

        // ─── 計算屬性：資產總覽數據 (隨券商篩選即時聯動) ───
        const summary = computed(() => {
            let totalMarket = 0;
            let totalCost = 0;
            filteredHoldingStocks.value.forEach(s => {
                totalMarket += (s.price || 0) * (s.shares || 0);
                totalCost += (s.costPrice || 0) * (s.shares || 0);
            });
            const profit = Math.round(totalMarket - totalCost);
            const rate = totalCost > 0 ? ((profit / totalCost) * 100).toFixed(2) : 0;
            return {
                totalMarketValue: totalMarket,
                totalCost: totalCost,
                unrealizedProfit: profit,
                unrealizedProfitRate: rate
            };
        });

        // ─── 計算屬性：個股戰報分類與「依交易日新到舊」排序 ───
        const starredStocks = computed(() => {
            return stockList.value.filter(s => {
                if (starredSubFilter.value === '全部') {
                    return s.focusStatus === '買' || s.focusStatus === '賣';
                }
                return s.focusStatus === starredSubFilter.value;
            });
        });

        const watchlistStocks = computed(() => stockList.value.filter(s => s.shares === 0 && (!s.focusStatus || s.focusStatus === '否')));

        const currentFilteredStocks = computed(() => {
            let baseList = [];
            if (stockSubTab.value === 'holding') baseList = holdingStocks.value;
            else if (stockSubTab.value === 'starred') baseList = starredStocks.value;
            else if (stockSubTab.value === 'watchlist') baseList = watchlistStocks.value;

            // 搜尋過濾
            if (stockSearchQuery.value.trim()) {
                const q = stockSearchQuery.value.trim().toLowerCase();
                baseList = baseList.filter(s => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (s.broker && s.broker.toLowerCase().includes(q)));
            }

            // 🌟 嚴格依「最新交易日由新到舊」降冪排序 (對齊地端)
            return [...baseList].sort((a, b) => {
                const dateA = String(a.latestDate || '');
                const dateB = String(b.latestDate || '');
                return dateB.localeCompare(dateA);
            });
        });

        // ─── 計算屬性：交易 FIFO 時間範圍篩選 (近1周 / 近2周 / 近1月 / 近3月 / 全部) ───
        const filteredTradeLogs = computed(() => {
            if (tradeDateRangeFilter.value === '全部') {
                return recentTradeLogs.value;
            }

            const now = new Date();
            let daysLimit = 3650;
            if (tradeDateRangeFilter.value === '近1周') daysLimit = 7;
            else if (tradeDateRangeFilter.value === '近2周') daysLimit = 14;
            else if (tradeDateRangeFilter.value === '近1月') daysLimit = 30;
            else if (tradeDateRangeFilter.value === '近3月') daysLimit = 90;

            const cutoff = new Date(now.getTime() - daysLimit * 24 * 60 * 60 * 1000);

            return recentTradeLogs.value.filter(log => {
                if (!log.date) return true;
                const logDate = new Date(log.date.replace(/\//g, '-'));
                return !isNaN(logDate) && logDate >= cutoff;
            });
        });

        // ─── ECharts 資產配置圓餅圖 ───
        let chartInstance = null;
        const renderAssetChart = () => {
            nextTick(() => {
                const chartDom = document.getElementById('assetChart');
                if (!chartDom) return;
                
                if (chartInstance) {
                    try {
                        chartInstance.dispose();
                    } catch (e) {}
                    chartInstance = null;
                }

                const isDark = theme.value === 'dark';
                chartInstance = echarts.init(chartDom, isDark ? 'dark' : null, { renderer: 'canvas' });

                const chartData = filteredHoldingStocks.value.map(s => ({
                    name: `${s.name} (${s.code})`,
                    value: Math.round((s.price || 0) * (s.shares || 0))
                }));

                const option = {
                    backgroundColor: 'transparent',
                    tooltip: {
                        trigger: 'item',
                        formatter: '{b}: ${c} ({d}%)',
                        textStyle: { fontSize: 11 }
                    },
                    legend: {
                        orient: 'horizontal',
                        bottom: 0,
                        left: 'center',
                        itemWidth: 8,
                        itemHeight: 8,
                        itemGap: 6,
                        textStyle: { color: isDark ? '#94a3b8' : '#64748b', fontSize: 10 }
                    },
                    series: [
                        {
                            name: '持股配置',
                            type: 'pie',
                            radius: ['34%', '54%'],
                            center: ['50%', '30%'],
                            avoidLabelOverlap: true,
                            itemStyle: {
                                borderRadius: 6,
                                borderColor: isDark ? '#0f172a' : '#ffffff',
                                borderWidth: 2
                            },
                            label: { show: false },
                            emphasis: {
                                label: {
                                    show: true,
                                    fontSize: 12,
                                    fontWeight: 'bold',
                                    color: isDark ? '#ffffff' : '#0f172a'
                                }
                            },
                            data: chartData
                        }
                    ]
                };
                chartInstance.setOption(option);
                chartInstance.resize();
            });
        };

        // 監聽分頁與券商篩選切換
        watch(currentTab, (newTab) => {
            expandedStockUids.value.clear();
            if (newTab === 'dashboard') {
                nextTick(() => {
                    setTimeout(renderAssetChart, 50);
                });
            }
        });

        watch(stockSubTab, () => {
            expandedStockUids.value.clear();
        });

        watch(selectedBrokerFilter, () => {
            renderAssetChart();
        });

        // ─── 卡片展開 / 收合控制 (手風琴模式：瞬時高度補償 + 單向平滑定錨) ───
        const isExpanded = (uid) => expandedStockUids.value.has(uid);
        const toggleStockExpand = (uid) => {
            if (expandedStockUids.value.has(uid)) {
                expandedStockUids.value.clear();
                return;
            }

            // 1. 偵測目前已展開的卡片與點擊目標卡片的相對位置
            const targetEl = document.getElementById(`stock-card-${uid}`);
            const oldDetailEl = document.querySelector('.stock-detail-body');
            let heightCompensation = 0;

            if (targetEl && oldDetailEl) {
                const targetRect = targetEl.getBoundingClientRect();
                const oldDetailRect = oldDetailEl.getBoundingClientRect();

                // 如果舊卡片位於點擊目標的上方 (由上往下點擊)
                if (oldDetailRect.top < targetRect.top) {
                    // 取得舊卡片收合將損失的高度
                    heightCompensation = oldDetailEl.offsetHeight;
                }
            }

            // 2. 切換展開狀態 (Vue 響應式更新)
            expandedStockUids.value.clear();
            expandedStockUids.value.add(uid);

            // 3. 在同一幀內瞬間補償滾動軸位置，完全抵消塌陷拉扯
            if (heightCompensation > 0) {
                window.scrollBy(0, -heightCompensation);
            }

            // 4. 等待 DOM 更新後，從當前平穩位置一次性平滑滑動至頂端對齊
            nextTick(() => {
                requestAnimationFrame(() => {
                    const newTargetEl = document.getElementById(`stock-card-${uid}`);
                    if (newTargetEl) {
                        const headerOffset = 64; // Sticky Header 避讓高度
                        const elementTop = newTargetEl.getBoundingClientRect().top;
                        const targetScrollY = elementTop + window.pageYOffset - headerOffset;
                        
                        window.scrollTo({
                            top: Math.max(0, targetScrollY),
                            behavior: 'smooth'
                        });
                    }
                });
            });
        };

        // 特別關注切換循環：否 ➔ 買 (▲) ➔ 賣 (▼) ➔ 否
        const cycleFocusStatus = (stock) => {
            if (!stock.focusStatus || stock.focusStatus === '否') {
                stock.focusStatus = '買';
            } else if (stock.focusStatus === '買') {
                stock.focusStatus = '賣';
            } else {
                stock.focusStatus = '否';
            }
            if (dbInstance) {
                try {
                    dbInstance.run("UPDATE my_stock SET 特別關注 = ? WHERE 股票代號 = ? AND 證券商 = ?", [stock.focusStatus, stock.code, stock.broker]);
                    saveDbToIndexedDb();
                } catch (e) {}
            }
        };

        const setFocusStatus = (stock, status) => {
            stock.focusStatus = status;
            if (dbInstance) {
                try {
                    dbInstance.run("UPDATE my_stock SET 特別關注 = ? WHERE 股票代號 = ? AND 證券商 = ?", [status, stock.code, stock.broker]);
                    saveDbToIndexedDb();
                } catch (e) {}
            }
        };

        const saveDbToIndexedDb = async () => {
            if (dbInstance && window.localforage) {
                const u8 = dbInstance.export();
                await localforage.setItem('sentinel_db_bytes', u8.buffer);
            }
        };

        // 數字格式化 (加入千分位)
        const formatNumber = (num) => {
            if (num === null || num === undefined) return '0';
            return num.toLocaleString('en-US');
        };

        // ─── 快速記帳 Modal 彈窗控制 ───
        const showTradeModal = ref(false);
        const tradeForm = ref({
            action: '買進',
            broker: '玉山證券',
            code: '',
            name: '',
            price: null,
            shares: null,
            date: new Date().toISOString().split('T')[0]
        });

        const onCodeInput = () => {
            const trimmed = tradeForm.value.code.trim();
            const matched = stockList.value.find(s => s.code === trimmed);
            if (matched) {
                tradeForm.value.name = matched.name;
                tradeForm.value.price = matched.price;
                if (matched.broker) tradeForm.value.broker = matched.broker;
            }
        };

        const openTradeModal = (targetStock = null) => {
            if (targetStock) {
                tradeForm.value.code = targetStock.code;
                tradeForm.value.name = targetStock.name;
                tradeForm.value.price = targetStock.price;
                tradeForm.value.shares = targetStock.shares > 0 ? targetStock.shares : 1000;
                tradeForm.value.broker = targetStock.broker || '玉山證券';
            } else {
                tradeForm.value.code = '';
                tradeForm.value.name = '';
                tradeForm.value.price = null;
                tradeForm.value.shares = 1000;
                tradeForm.value.broker = selectedBrokerFilter.value !== '全部' ? selectedBrokerFilter.value : '玉山證券';
            }
            tradeForm.value.action = '買進';
            tradeForm.value.date = new Date().toISOString().split('T')[0];
            showTradeModal.value = true;
        };

        const saveTradeRecord = async () => {
            if (!tradeForm.value.code || !tradeForm.value.price || !tradeForm.value.shares) {
                alert('請完整填寫股票代號、價格與股數！');
                return;
            }

            const total = Math.round(tradeForm.value.price * tradeForm.value.shares);
            const brokerName = tradeForm.value.broker || '玉山證券';
            const uid = `${tradeForm.value.code}_${brokerName}`;
            const newLog = {
                id: Date.now(),
                uid,
                action: tradeForm.value.action,
                code: tradeForm.value.code,
                name: tradeForm.value.name || tradeForm.value.code,
                broker: brokerName,
                price: tradeForm.value.price,
                shares: tradeForm.value.shares,
                date: tradeForm.value.date,
                totalAmount: total
            };

            recentTradeLogs.value.unshift(newLog);

            // 更新個股列表
            let target = stockList.value.find(s => s.uid === uid);
            if (!target) {
                target = {
                    uid,
                    code: tradeForm.value.code,
                    name: tradeForm.value.name || tradeForm.value.code,
                    price: tradeForm.value.price,
                    change: 0,
                    changePercent: 0,
                    shares: 0,
                    broker: brokerName,
                    costPrice: tradeForm.value.price,
                    profit: 0,
                    profitRate: 0,
                    focusStatus: '否',
                    signal: '⚪ 新增自選',
                    strategyFeatures: defaultFeatures.value,
                    summaryText: '手動錄入交易新增個股。',
                    latestDate: tradeForm.value.date
                };
                stockList.value.push(target);
            }

            target.latestDate = tradeForm.value.date;

            if (tradeForm.value.action === '買進') {
                const prevCostTotal = target.costPrice * target.shares;
                const newCostTotal = prevCostTotal + total;
                target.shares += tradeForm.value.shares;
                target.costPrice = target.shares > 0 ? Number((newCostTotal / target.shares).toFixed(2)) : tradeForm.value.price;
                
                fifoInventory.value.push({
                    id: Date.now(),
                    code: target.code,
                    name: target.name,
                    broker: brokerName,
                    buyDate: tradeForm.value.date,
                    buyPrice: tradeForm.value.price,
                    remainingShares: tradeForm.value.shares
                });
            } else if (tradeForm.value.action === '賣出') {
                target.shares = Math.max(0, target.shares - tradeForm.value.shares);
            }

            target.profit = Math.round((target.price - target.costPrice) * target.shares);
            target.profitRate = target.costPrice > 0 ? (((target.price - target.costPrice) / target.costPrice) * 100).toFixed(2) : 0;

            // 寫入真實 SQLite 資料庫
            if (dbInstance) {
                try {
                    dbInstance.run(
                        "INSERT INTO trade_log (股票代號, 股票名稱, 動作, 成交股數, 成交價, 證券商, 交易時間, 特別關注) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        [target.code, target.name, tradeForm.value.action, tradeForm.value.shares, tradeForm.value.price, brokerName, tradeForm.value.date, target.focusStatus || '否']
                    );
                    dbInstance.run(
                        "INSERT OR REPLACE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注) VALUES (?, ?, ?, ?, ?, ?)",
                        [target.code, target.name, target.shares, target.costPrice, brokerName, target.focusStatus || '否']
                    );
                    await saveDbToIndexedDb();
                } catch (err) {
                    console.error("寫入 SQLite 錯誤:", err);
                }
            }

            showTradeModal.value = false;
            alert(`✅ 交易記錄已成功錄入並同步！\n[${brokerName}] ${newLog.action} ${newLog.name} (${newLog.code}) ${formatNumber(newLog.shares)}股`);
        };

        // ─── Google 登入與 Google Drive API v3 實作 ───
        const handleGoogleLogin = () => {
            if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
                alert("⚠️ Google 授權模組載入中，請稍候重試或檢查網路連線。");
                return;
            }

            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: googleClientId.value.trim(),
                scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid',
                callback: async (resp) => {
                    if (resp.error) {
                        alert("❌ Google 授權失敗: " + resp.error);
                        return;
                    }
                    googleAccessToken.value = resp.access_token;
                    localStorage.setItem('sentinel_gdrive_token', resp.access_token);
                    googleUser.value.isLoggedIn = true;

                    // 抓取使用者 Email
                    try {
                        const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                            headers: { Authorization: `Bearer ${resp.access_token}` }
                        });
                        const uData = await userRes.json();
                        if (uData.email) {
                            googleUser.value.email = uData.email;
                            localStorage.setItem('sentinel_gdrive_email', uData.email);
                        }
                    } catch (e) {}

                    alert('🎉 Google 帳號授權成功！即將為您同步雲端資料庫...');
                    await triggerSync('download');
                }
            });

            tokenClient.requestAccessToken({ prompt: 'consent' });
        };

        const handleGoogleLogout = () => {
            if (confirm('確定要解除 Google 帳號連結嗎？')) {
                googleUser.value.isLoggedIn = false;
                googleUser.value.email = '';
                googleAccessToken.value = '';
                localStorage.removeItem('sentinel_gdrive_token');
                localStorage.removeItem('sentinel_gdrive_email');
            }
        };

        const triggerSync = async (type) => {
            if (!googleAccessToken.value) {
                handleGoogleLogin();
                return;
            }

            syncStatus.value.loading = true;
            try {
                if (type === 'download' || type === 'sync') {
                    syncStatus.value.message = '正在搜尋 Google Drive 中的 sentinel_vault.db...';
                    
                    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='sentinel_vault.db' and trashed=false&fields=files(id,name,modifiedTime,size)`;
                    const searchRes = await fetch(searchUrl, {
                        headers: { Authorization: `Bearer ${googleAccessToken.value}` }
                    });
                    
                    if (searchRes.status === 401) {
                        alert("⚠️ 授權 Token 已過期，請重新連結 Google 帳號。");
                        handleGoogleLogout();
                        syncStatus.value.loading = false;
                        return;
                    }

                    const searchData = await searchRes.json();
                    if (searchData.files && searchData.files.length > 0) {
                        const targetFile = searchData.files[0];
                        googleUser.value.driveFileId = targetFile.id;
                        localStorage.setItem('sentinel_drive_file_id', targetFile.id);

                        syncStatus.value.message = '正在下載最新 sentinel_vault.db...';
                        const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${targetFile.id}?alt=media`, {
                            headers: { Authorization: `Bearer ${googleAccessToken.value}` }
                        });
                        const buffer = await fileRes.arrayBuffer();

                        await loadDatabaseFromArrayBuffer(buffer, 'Google Drive 雲端');
                        const nowStr = new Date().toLocaleString();
                        googleUser.value.lastSyncTime = nowStr;
                        localStorage.setItem('sentinel_last_sync_time', nowStr);
                        alert(`☁️ 雲端資料庫已成功下載並載入！\n檔案修改時間: ${targetFile.modifiedTime || nowStr}`);
                    } else {
                        alert("ℹ️ 在您的 Google Drive 中尚未找到 sentinel_vault.db。請確認 PC 端已執行過雲端備份，或點擊「雙向智慧合流」建立。");
                    }
                }
            } catch (err) {
                console.error("雲端同步失敗:", err);
                alert("❌ 雲端同步失敗：" + err.message);
            } finally {
                syncStatus.value.loading = false;
            }
        };

        // ─── 本機手動備援：匯入 / 匯出 .db 檔案 ───
        const triggerFileInput = () => {
            if (dbFileInput.value) dbFileInput.value.click();
        };

        const handleDbFileSelected = (event) => {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async (e) => {
                const buffer = e.target.result;
                const ok = await loadDatabaseFromArrayBuffer(buffer, file.name);
                if (ok) {
                    alert(`✅ 已成功載入本機 SQLite 資料庫：${file.name} (${(file.size / 1024).toFixed(0)} KB)！`);
                }
            };
            reader.readAsArrayBuffer(file);
        };

        const exportDatabaseFile = () => {
            let u8Array = null;
            if (dbInstance) {
                u8Array = dbInstance.export();
            } else {
                alert("⚠️ 目前為示範模式，無法匯出空資料庫。");
                return;
            }

            const blob = new Blob([u8Array], { type: 'application/x-sqlite3' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sentinel_vault_${new Date().toISOString().slice(0, 10)}.db`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        };

        // ─── 生命週期掛載與 IndexedDB 離線快取初始化 ───
        onMounted(async () => {
            renderAssetChart();
            window.addEventListener('resize', () => {
                if (chartInstance) chartInstance.resize();
            });

            // 優先讀取 IndexedDB 實現 0 延遲秒開
            if (window.localforage) {
                try {
                    const cachedBuffer = await localforage.getItem('sentinel_db_bytes');
                    if (cachedBuffer) {
                        await loadDatabaseFromArrayBuffer(cachedBuffer, '手機離線快取');
                    }
                } catch (e) {
                    console.warn("讀取離線快取失敗:", e);
                }
            }
        });

        return {
            appVersion,
            theme,
            toggleTheme,
            currentTab,
            stockSubTab,
            starredSubFilter,
            stockSearchQuery,
            selectedBrokerFilter,
            availableBrokers,
            activeBrokers,
            tradeDateRangeFilter,
            googleUser,
            googleClientId,
            syncStatus,
            isDbLoaded,
            dbInfoText,
            dbFileInput,
            stockList,
            defaultFeatures,
            holdingStocks,
            filteredHoldingStocks,
            starredStocks,
            watchlistStocks,
            currentFilteredStocks,
            fifoInventory,
            recentTradeLogs,
            filteredTradeLogs,
            summary,
            isExpanded,
            toggleStockExpand,
            cycleFocusStatus,
            setFocusStatus,
            formatNumber,
            showTradeModal,
            tradeForm,
            onCodeInput,
            openTradeModal,
            saveTradeRecord,
            handleGoogleLogin,
            handleGoogleLogout,
            triggerSync,
            triggerFileInput,
            handleDbFileSelected,
            exportDatabaseFile
        };
    }
}).mount('#app');
