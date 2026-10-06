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
        const stockSubTab = ref('starred'); // 預設特別關注分頁
        const starredSubFilter = ref('全部'); // 特別關注子過濾 (全部 / 買 / 賣)
        const stockSearchQuery = ref('');
        const expandedStockCodes = ref(new Set()); // 預設全部收褶 (簡易資訊)

        // ─── 常用證券商清單 ───
        const commonBrokers = ref(['玉山證券', '富邦', '元大', '永豐金', '國泰', '凱基']);

        // ─── 資料庫狀態與引擎 ───
        let SQL_ENGINE = null;
        let dbInstance = null;
        const isDbLoaded = ref(false);
        const dbInfoText = ref('未載入 (示範模式)');
        const dbFileInput = ref(null);

        // ─── Google 帳號與雲端狀態 ───
        const googleClientId = ref(localStorage.getItem('sentinel_google_client_id') || '425983751515-m8m2nks5g57q5176b6j6uouqquk4l3ek.apps.googleusercontent.com');
        let tokenClient = null;
        const googleAccessToken = ref(localStorage.getItem('sentinel_gdrive_token') || '');
        const googleUser = ref({
            isLoggedIn: !!localStorage.getItem('sentinel_gdrive_token'),
            email: localStorage.getItem('sentinel_gdrive_email') || '',
            lastSyncTime: localStorage.getItem('sentinel_last_sync_time') || '',
            driveFileId: localStorage.getItem('sentinel_drive_file_id') || '',
            driveFolderName: '鈔能戰情室_雲端同步中樞'
        });

        const syncStatus = ref({
            loading: false,
            message: ''
        });

        // ─── 預設通用策略特徵結構 (100% 對齊地端規範) ───
        const defaultFeatures = ref([
            { name: '均線趨勢', desc: '空頭排列 (MA20 > MA10 > MA5)', emoji: '🟢' },
            { name: '布林通道', desc: '布林空頭軌 (%B:0.16)', emoji: '🟢' },
            { name: '價量關係', desc: '價跌量增 (殺盤鬆動)', emoji: '🟢' },
            { name: '月線乖離', desc: '溫和整理 (-3.14%)', emoji: '⚪' },
            { name: '量能狀態', desc: '量能平穩 (1.4倍)', emoji: '⚪' },
            { name: '法人動態', desc: '外資:連賣4天 │ 投信:不參與 │ 自營:多空拉鋸', emoji: '🟢' },
            { name: '籌碼沉澱', desc: '融資堆積 (連增3天)', emoji: '🟢' },
            { name: '籌碼吸籌比(5日)', desc: '加速出貨 🚨 (-28.4%)', emoji: '🟢' },
            { name: '法人買超加速度', desc: '力道平穩', emoji: '⚪' },
            { name: 'K線型態', desc: '無明顯型態', emoji: '⚪' },
            { 
                name: 'RSI12搶反彈與預估', 
                desc: '區間觀望', 
                emoji: '⚪',
                subLines: [
                    '買點預測：目前股價強勢/橫盤，未滿足起跌條件',
                    '賣點預估：目前無反彈賣信號'
                ]
            }
        ]);

        // ─── 核心個股資料庫 ───
        const stockList = ref([
            {
                code: '2542',
                name: '興富發',
                price: 38.05,
                change: -0.35,
                changePercent: -0.91,
                shares: 60,
                broker: '玉山證券',
                costPrice: 39.30,
                profit: -75,
                profitRate: -3.20,
                focusStatus: '買',
                signal: '🟢 測底佈局',
                buyPriceTarget: '38.05',
                sellPriceTarget: '39.95',
                buyRange: '37.50 - 38.05',
                defensePrice: '37.00',
                targetRange: '39.95 - 41.50',
                indicatorTags: [
                    { text: 'MTM金', type: 'bull' },
                    { text: 'OSC縮', type: 'bull' },
                    { text: 'K超', type: 'bear' },
                    { text: 'DIF超', type: 'bear' },
                    { text: 'KD金', type: 'bull' },
                    { text: 'MACD金', type: 'bull' }
                ],
                strategyFeatures: [
                    { name: '均線趨勢', desc: '空頭排列 (MA20 > MA10 > MA5)', emoji: '🟢' },
                    { name: '布林通道', desc: '布林空頭軌 (%B:0.16)', emoji: '🟢' },
                    { name: '價量關係', desc: '價跌量增 (殺盤鬆動)', emoji: '🟢' },
                    { name: '月線乖離', desc: '溫和整理 (-3.14%)', emoji: '⚪' },
                    { name: '量能狀態', desc: '量能平穩 (1.4倍)', emoji: '⚪' },
                    { name: '法人動態', desc: '外資:連賣4天 │ 投信:不參與 │ 自營:多空拉鋸', emoji: '🟢' },
                    { name: '籌碼沉澱', desc: '融資堆積 (連增3天)', emoji: '🟢' },
                    { name: '籌碼吸籌比(5日)', desc: '加速出貨 🚨 (-28.4%)', emoji: '🟢' },
                    { name: '法人買超加速度', desc: '力道平穩', emoji: '⚪' },
                    { name: 'K線型態', desc: '空頭吞噬', emoji: '🟢' },
                    { 
                        name: 'RSI12搶反彈與預估', 
                        desc: '區間測底', 
                        emoji: '⚪',
                        subLines: [
                            '買點預測：目前股價強勢/橫盤，未滿足起跌條件',
                            '賣點預估：目前無反彈賣信號'
                        ]
                    }
                ],
                summaryText: '股價出現空頭吞噬與價跌量增，短線於布林下軌附近測底，建議於 37.50 至 38.05 元區間進行零股佈局，破 37.00 防守點停損。'
            },
            {
                code: '1215',
                name: '卜蜂',
                price: 104.0,
                change: -1.0,
                changePercent: -0.95,
                shares: 21,
                broker: '玉山證券',
                costPrice: 116.45,
                profit: -261,
                profitRate: -10.70,
                focusStatus: '買',
                signal: '🟢 6燈全綠',
                buyPriceTarget: '104.0',
                sellPriceTarget: '109.2',
                buyRange: '102.0 - 104.0',
                defensePrice: '100.0',
                targetRange: '109.2 - 115.0',
                indicatorTags: [
                    { text: 'MTM金', type: 'bull' },
                    { text: 'OSC縮', type: 'bull' },
                    { text: 'K超', type: 'bull' },
                    { text: 'DIF超', type: 'bull' },
                    { text: 'KD金', type: 'bull' },
                    { text: 'MACD金', type: 'bull' }
                ],
                strategyFeatures: [
                    { name: '均線趨勢', desc: '多頭回測月線 (MA5 > MA20)', emoji: '🔴' },
                    { name: '布林通道', desc: '回測中軌支撐 (%B:0.48)', emoji: '⚪' },
                    { name: '價量關係', desc: '量縮回檔 (洗盤有守)', emoji: '🔴' },
                    { name: '月線乖離', desc: '溫和整理 (-1.82%)', emoji: '⚪' },
                    { name: '量能狀態', desc: '量能平穩 (0.9倍)', emoji: '⚪' },
                    { name: '法人動態', desc: '外資:連買2天 │ 投信:持續買進', emoji: '🔴' },
                    { name: '籌碼沉澱', desc: '大戶持股連增，籌碼安定', emoji: '🔴' },
                    { name: '籌碼吸籌比(5日)', desc: '偏多吸籌 (+12.5%)', emoji: '🔴' },
                    { name: '法人買超加速度', desc: '加速買超 🚀', emoji: '🔴' },
                    { name: 'K線型態', desc: '早晨之星', emoji: '🔴' },
                    { 
                        name: 'RSI12搶反彈與預估', 
                        desc: '滿足買進條件', 
                        emoji: '🔴',
                        subLines: [
                            '買點預測：已達 102~104 支撐區，滿足佈局條件',
                            '賣點預估：上看 109.2 頸線反壓'
                        ]
                    }
                ],
                summaryText: '股價價跌量增且 6 燈全綠，短線於布林下軌附近測底，建議於 102.00 至 104.00 元區間進行零股分批承接。'
            },
            {
                code: '1229',
                name: '聯華',
                price: 39.65,
                change: 0.45,
                changePercent: 1.15,
                shares: 50,
                broker: '玉山證券',
                costPrice: 38.91,
                profit: 37,
                profitRate: 1.90,
                focusStatus: '賣',
                signal: '🔴 目標調節',
                buyPriceTarget: '39.65',
                sellPriceTarget: '41.63',
                buyRange: '38.50 - 39.00',
                defensePrice: '38.00',
                targetRange: '41.63 - 42.50',
                indicatorTags: [
                    { text: 'MTM金', type: 'bull' },
                    { text: 'OSC縮', type: 'bull' },
                    { text: 'K超', type: 'bull' },
                    { text: 'DIF超', type: 'bull' },
                    { text: 'KD金', type: 'bear' },
                    { text: 'MACD金', type: 'bear' }
                ],
                strategyFeatures: [
                    { name: '均線趨勢', desc: '觸及季線壓力 (MA60:41.2)', emoji: '⚪' },
                    { name: '布林通道', desc: '抵達布林上軌 (%B:0.89)', emoji: '🔴' },
                    { name: '價量關係', desc: '價漲量縮 (高檔背離)', emoji: '🟡' },
                    { name: '月線乖離', desc: '超買過熱 (+5.2%)', emoji: '🔴' },
                    { name: '量能狀態', desc: '放量推升 (1.8倍)', emoji: '🔴' },
                    { name: '法人動態', desc: '外資:賣超 │ 投信:不參與', emoji: '🟢' },
                    { name: '籌碼沉澱', desc: '融資連減，短線主力調節', emoji: '🔴' },
                    { name: '籌碼吸籌比(5日)', desc: '偏空出貨 (-8.3%)', emoji: '🟢' },
                    { name: '法人買超加速度', desc: '力道平穩', emoji: '⚪' },
                    { name: 'K線型態', desc: '流星線 (上影線)', emoji: '🟢' },
                    { 
                        name: 'RSI12搶反彈與預估', 
                        desc: '高檔超買', 
                        emoji: '🔴',
                        subLines: [
                            '買點預測：短線漲多不宜追高',
                            '賣點預估：41.63 觸發建議調節信號'
                        ]
                    }
                ],
                summaryText: '融資連減籌碼沉澱且 KD 低檔交叉，短線於布林下軌附近縮量築底，若觸及 41.63 建議賣出調節獲利。'
            },
            {
                code: '2330',
                name: '台積電',
                price: 980.0,
                change: 15.0,
                changePercent: 1.55,
                shares: 1000,
                broker: '玉山證券',
                costPrice: 850.0,
                profit: 130000,
                profitRate: 15.29,
                focusStatus: '買',
                signal: '🟢 多頭強勢',
                buyPriceTarget: '940.0',
                sellPriceTarget: '1050.0',
                buyRange: '920 - 940',
                defensePrice: '910',
                targetRange: '1020 - 1050',
                indicatorTags: [
                    { text: 'MTM金', type: 'bull' },
                    { text: 'OSC縮', type: 'bull' },
                    { text: 'K超', type: 'bull' },
                    { text: 'DIF超', type: 'bull' },
                    { text: 'KD金', type: 'bull' },
                    { text: 'MACD金', type: 'bull' }
                ],
                strategyFeatures: [
                    { name: '均線趨勢', desc: '均線多頭排列 (MA5 > MA10 > MA20 > MA60)', emoji: '🔴' },
                    { name: '布林通道', desc: '布林多頭攻擊軌 (%B:0.85)', emoji: '🔴' },
                    { name: '價量關係', desc: '價漲量增 (攻擊發起)', emoji: '🔴' },
                    { name: '月線乖離', desc: '溫和偏多 (+2.8%)', emoji: '⚪' },
                    { name: '量能狀態', desc: '溫和放量 (1.3倍)', emoji: '⚪' },
                    { name: '法人動態', desc: '外資:連買5天 │ 投信:連買3天 │ 三大法人合買', emoji: '🔴' },
                    { name: '籌碼沉澱', desc: '融資連減，籌碼持續沉澱', emoji: '🔴' },
                    { name: '籌碼吸籌比(5日)', desc: '強力吸籌 💎 (+35.2%)', emoji: '🔴' },
                    { name: '法人買超加速度', desc: '加速買超 🚀', emoji: '🔴' },
                    { name: 'K線型態', desc: '多頭紅三兵', emoji: '🔴' },
                    { 
                        name: 'RSI12搶反彈與預估', 
                        desc: '多頭續抱', 
                        emoji: '🔴',
                        subLines: [
                            '買點預測：回測 920-940 均線支撐',
                            '賣點預估：1050 整數關卡分批調節'
                        ]
                    }
                ],
                summaryText: '外資主力持續敲進，站穩千元大關前夕。回測 920-940 均線有強力支撐，建議沿 10 日線續抱。'
            }
        ]);

        // ─── FIFO 批次庫存明細 ───
        const fifoInventory = ref([
            { id: 1, code: '2542', name: '興富發', broker: '玉山證券', buyDate: '2026-08-20', buyPrice: 39.30, remainingShares: 60 },
            { id: 2, code: '1215', name: '卜蜂',   broker: '玉山證券', buyDate: '2026-07-15', buyPrice: 116.45, remainingShares: 21 },
            { id: 3, code: '1229', name: '聯華',   broker: '玉山證券', buyDate: '2026-09-01', buyPrice: 38.91, remainingShares: 50 },
            { id: 4, code: '2330', name: '台積電', broker: '玉山證券', buyDate: '2026-05-12', buyPrice: 850.0, remainingShares: 1000 }
        ]);

        // ─── 最近交易紀錄 ───
        const recentTradeLogs = ref([
            { id: 1, action: '買進', code: '2542', name: '興富發', broker: '玉山證券', price: 39.30, shares: 60, date: '2026-08-20', totalAmount: 2358 },
            { id: 2, action: '買進', code: '1215', name: '卜蜂',   broker: '玉山證券', price: 116.45, shares: 21, date: '2026-07-15', totalAmount: 2445 },
            { id: 3, action: '買進', code: '1229', name: '聯華',   broker: '玉山證券', price: 38.91, shares: 50, date: '2026-09-01', totalAmount: 1946 },
            { id: 4, action: '買進', code: '2330', name: '台積電', broker: '玉山證券', price: 850.0, shares: 1000, date: '2026-05-12', totalAmount: 850000 }
        ]);

        // ─── 計算屬性：分頁與篩選 ───
        const holdingStocks = computed(() => stockList.value.filter(s => s.shares > 0));
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

            if (!stockSearchQuery.value.trim()) return baseList;
            const q = stockSearchQuery.value.trim().toLowerCase();
            return baseList.filter(s => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
        });

        // ─── 計算屬性：資產總覽數據 ───
        const summary = computed(() => {
            let totalMarket = 0;
            let totalCost = 0;
            holdingStocks.value.forEach(s => {
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

        // ─── 核心：WebAssembly SQLite 資料庫解析模組 ───
        const parseStrategyContent = (rawText) => {
            if (!rawText) return defaultFeatures.value;
            const lines = rawText.split('\n');
            const features = [];
            let currentFeat = null;

            for (let line of lines) {
                line = line.trim();
                if (!line || line.startsWith('🎯') || line.startsWith('───')) continue;

                if (line.startsWith('-')) {
                    // 解析特徵指標主行 (例: - 🟢 均線趨勢：空頭排列 ...)
                    const match = line.match(/^-\s*([🔴🟢⚪🟡])?\s*([^：:]+)[：:](.*)$/);
                    if (match) {
                        currentFeat = {
                            emoji: match[1] || '⚪',
                            name: match[2].trim(),
                            desc: match[3].trim(),
                            subLines: []
                        };
                        features.push(currentFeat);
                    }
                } else if (line.startsWith('↳') && currentFeat) {
                    currentFeat.subLines.push(line.replace('↳', '').trim());
                }
            }
            return features.length > 0 ? features : defaultFeatures.value;
        };

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

                // 1. 讀取 stock_price (現價字典)
                const priceMap = {};
                try {
                    const priceRes = dbInstance.exec("SELECT stock_code, cache_data FROM stock_price");
                    if (priceRes.length > 0) {
                        const rows = priceRes[0].values;
                        rows.forEach(r => {
                            try {
                                const data = JSON.parse(r[1]);
                                priceMap[r[0]] = {
                                    price: typeof data.p === 'number' ? data.p : (data.收盤價 || 0),
                                    date: data.d || ''
                                };
                            } catch (e) {}
                        });
                    }
                } catch (e) {
                    console.warn("stock_price 讀取略過:", e);
                }

                // 2. 讀取 gem_strategy (策略指標字典)
                const strategyMap = {};
                try {
                    const stratRes = dbInstance.exec("SELECT 股票代號, 策略內容, 佈局下限, 佈局上限, 防守點, 目標下限, 目標上限, 戰情總結 FROM gem_strategy");
                    if (stratRes.length > 0) {
                        const rows = stratRes[0].values;
                        rows.forEach(r => {
                            strategyMap[r[0]] = {
                                content: r[1],
                                buyLow: r[2],
                                buyHigh: r[3],
                                defense: r[4],
                                targetLow: r[5],
                                targetHigh: r[6],
                                summary: r[7]
                            };
                        });
                    }
                } catch (e) {
                    console.warn("gem_strategy 讀取略過:", e);
                }

                // 3. 讀取 my_stock (持股與關注清單)
                const parsedStocks = [];
                try {
                    const stockRes = dbInstance.exec("SELECT 股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注 FROM my_stock");
                    if (stockRes.length > 0) {
                        const rows = stockRes[0].values;
                        rows.forEach(r => {
                            const code = String(r[0]);
                            const name = String(r[1] || code);
                            const shares = Number(r[2]) || 0;
                            const costPrice = Number(r[3]) || 0;
                            const broker = String(r[4] || '玉山證券');
                            const focusStatus = String(r[5] || '否');

                            const pInfo = priceMap[code] || {};
                            const curPrice = pInfo.price || costPrice || 0;
                            const profit = shares > 0 ? Math.round((curPrice - costPrice) * shares) : 0;
                            const profitRate = costPrice > 0 ? (((curPrice - costPrice) / costPrice) * 100).toFixed(2) : 0;

                            const sInfo = strategyMap[code] || {};
                            const stratFeatures = parseStrategyContent(sInfo.content);

                            parsedStocks.push({
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
                                signal: shares > 0 ? (profit >= 0 ? '🟢 多頭續抱' : '🔴 測底佈局') : '⚪ 觀察追蹤',
                                buyPriceTarget: sInfo.buyHigh ? String(sInfo.buyHigh) : (costPrice ? String(costPrice) : '---'),
                                sellPriceTarget: sInfo.targetLow ? String(sInfo.targetLow) : '---',
                                buyRange: sInfo.buyLow && sInfo.buyHigh ? `${sInfo.buyLow} - ${sInfo.buyHigh}` : '---',
                                defensePrice: sInfo.defense ? String(sInfo.defense) : '---',
                                targetRange: sInfo.targetLow && sInfo.targetHigh ? `${sInfo.targetLow} - ${sInfo.targetHigh}` : '---',
                                indicatorTags: [
                                    { text: 'MTM金', type: 'bull' },
                                    { text: 'OSC縮', type: 'bull' },
                                    { text: 'K超', type: 'bull' },
                                    { text: 'DIF超', type: 'bull' },
                                    { text: 'KD金', type: 'bull' },
                                    { text: 'MACD金', type: 'bull' }
                                ],
                                strategyFeatures: stratFeatures,
                                summaryText: sInfo.summary || '已由真實資料庫載入最新戰報。'
                            });
                        });
                    }
                } catch (e) {
                    console.warn("my_stock 讀取失敗:", e);
                }

                if (parsedStocks.length > 0) {
                    stockList.value = parsedStocks;
                }

                // 4. 讀取 trade_log (流水帳) 與計算 FIFO
                const parsedTrades = [];
                const fifoMap = {}; // code -> [ { buyDate, buyPrice, remainingShares, broker } ]

                try {
                    const tradeRes = dbInstance.exec("SELECT id, 股票代號, 股票名稱, 動作, 成交股數, 成交價, 證券商, 交易時間 FROM trade_log ORDER BY 交易時間 ASC, id ASC");
                    if (tradeRes.length > 0) {
                        const rows = tradeRes[0].values;
                        rows.forEach(r => {
                            const tid = r[0];
                            const code = String(r[1]);
                            const name = String(r[2] || code);
                            const action = String(r[3]);
                            const shares = Number(r[4]) || 0;
                            const price = Number(r[5]) || 0;
                            const broker = String(r[6] || '玉山證券');
                            const date = String(r[7] || '');

                            parsedTrades.unshift({
                                id: tid,
                                code,
                                name,
                                action,
                                shares,
                                price,
                                broker,
                                date,
                                totalAmount: Math.round(price * shares)
                            });

                            // FIFO 批次試算
                            if (!fifoMap[code]) fifoMap[code] = [];
                            if (action === '買進') {
                                fifoMap[code].push({
                                    id: tid,
                                    code,
                                    name,
                                    broker,
                                    buyDate: date,
                                    buyPrice: price,
                                    remainingShares: shares
                                });
                            } else if (action === '賣出') {
                                let needDeduct = shares;
                                while (needDeduct > 0 && fifoMap[code].length > 0) {
                                    const batch = fifoMap[code][0];
                                    if (batch.remainingShares <= needDeduct) {
                                        needDeduct -= batch.remainingShares;
                                        fifoMap[code].shift();
                                    } else {
                                        batch.remainingShares -= needDeduct;
                                        needDeduct = 0;
                                    }
                                }
                            }
                        });
                    }
                } catch (e) {
                    console.warn("trade_log 讀取失敗:", e);
                }

                if (parsedTrades.length > 0) {
                    recentTradeLogs.value = parsedTrades.slice(0, 15);
                }

                // 攤平 FIFO 庫存明細
                const flatFifo = [];
                Object.values(fifoMap).forEach(batches => {
                    batches.forEach(b => {
                        if (b.remainingShares > 0) flatFifo.push(b);
                    });
                });
                if (flatFifo.length > 0) {
                    fifoInventory.value = flatFifo;
                }

                // 儲存至 IndexedDB
                if (window.localforage) {
                    await localforage.setItem('sentinel_db_bytes', arrayBuffer);
                }

                // 重新繪製圖表
                renderAssetChart();
                return true;
            } catch (err) {
                console.error("載入 SQLite 資料庫失敗:", err);
                alert("❌ 解析 SQLite 資料庫失敗：" + err.message);
                return false;
            }
        };

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

                const chartData = holdingStocks.value.map(s => ({
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
                        bottom: '0%',
                        itemWidth: 10,
                        itemHeight: 10,
                        textStyle: { color: isDark ? '#94a3b8' : '#64748b', fontSize: 10 }
                    },
                    series: [
                        {
                            name: '持股配置',
                            type: 'pie',
                            radius: ['45%', '70%'],
                            center: ['50%', '42%'],
                            avoidLabelOverlap: false,
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

        // 當切換分頁時：自動收褶個股完整資訊，並重繪圖表
        watch(currentTab, (newTab) => {
            expandedStockCodes.value.clear();
            if (newTab === 'dashboard') {
                nextTick(() => {
                    setTimeout(renderAssetChart, 50);
                });
            }
        });

        watch(stockSubTab, () => {
            expandedStockCodes.value.clear();
        });

        // ─── 卡片展開 / 收合控制 ───
        const isExpanded = (code) => expandedStockCodes.value.has(code);
        const toggleStockExpand = (code) => {
            if (expandedStockCodes.value.has(code)) {
                expandedStockCodes.value.delete(code);
            } else {
                expandedStockCodes.value.add(code);
            }
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
            // 若有 DB 實例，同步寫入
            if (dbInstance) {
                try {
                    dbInstance.run("UPDATE my_stock SET 特別關注 = ? WHERE 股票代號 = ?", [stock.focusStatus, stock.code]);
                    saveDbToIndexedDb();
                } catch (e) {}
            }
        };

        const setFocusStatus = (stock, status) => {
            stock.focusStatus = status;
            if (dbInstance) {
                try {
                    dbInstance.run("UPDATE my_stock SET 特別關注 = ? WHERE 股票代號 = ?", [status, stock.code]);
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
                tradeForm.value.broker = '玉山證券';
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
            const newLog = {
                id: Date.now(),
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
            let target = stockList.value.find(s => s.code === tradeForm.value.code);
            if (!target) {
                target = {
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
                    summaryText: '手動錄入交易新增個股。'
                };
                stockList.value.push(target);
            }

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
                client_id: googleClientId.value,
                scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly',
                callback: async (resp) => {
                    if (resp.error) {
                        alert("❌ Google 授權失敗: " + resp.error);
                        return;
                    }
                    googleAccessToken.value = resp.access_token;
                    localStorage.setItem('sentinel_gdrive_token', resp.access_token);
                    googleUser.value.isLoggedIn = true;

                    // 嘗試抓取使用者 Profile
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
                    
                    // 1. 搜尋雲端 DB 檔案
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
                alert("⚠️ 目前為示範模式，將為您導出當前示範資料庫。");
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

            // 檢查 IndexedDB 是否有上次快取的資料庫
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
            commonBrokers,
            googleUser,
            googleClientId,
            syncStatus,
            isDbLoaded,
            dbInfoText,
            dbFileInput,
            stockList,
            defaultFeatures,
            holdingStocks,
            starredStocks,
            watchlistStocks,
            currentFilteredStocks,
            fifoInventory,
            recentTradeLogs,
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
