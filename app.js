// 📱 鈔能戰情室・手機網頁版前端核心邏輯 (app.js)

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
        const currentTab = ref('stocks'); // 預設開啟個股戰報
        const stockSubTab = ref('starred'); // 預設特別關注分頁
        const starredSubFilter = ref('全部'); // 特別關注子過濾 (全部 / 買 / 賣)
        const stockSearchQuery = ref('');
        const expandedStockCodes = ref(new Set(['2542'])); // 預設展開興富發

        // ─── 常用證券商清單 ───
        const commonBrokers = ref(['玉山證券', '富邦', '元大', '永豐金', '國泰', '凱基']);

        // ─── Google 帳號與雲端狀態 ───
        const googleUser = ref({
            isLoggedIn: true,
            email: 'user.sentinel@gmail.com',
            lastSyncTime: '2026-10-06 11:45:00',
            driveFolderName: '鈔能戰情室_雲端同步中樞'
        });

        // ─── 預設通用策略特徵結構 (100% 對齊地端 Stock_Sentinel.py 規範) ───
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

        // ─── 核心個股資料庫 (對齊地端卡片截圖欄位與真實風格) ───
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
                focusStatus: '買', // ▲ 關注買 (紅正三角)
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
                focusStatus: '買', // ▲ 關注買 (紅正三角)
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
                focusStatus: '賣', // ▼ 關注賣 (綠倒三角)
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

        // ─── 3 大分類分頁計算屬性 ───
        // 1. 💼 現役持股區：持有股數 > 0
        const holdingStocks = computed(() => stockList.value.filter(s => s.shares > 0));

        // 2. ⭐ 特別關注股：focusStatus 為 '買' 或 '賣'，並支援子過濾
        const starredStocks = computed(() => {
            return stockList.value.filter(s => {
                if (starredSubFilter.value === '買') return s.focusStatus === '買';
                if (starredSubFilter.value === '賣') return s.focusStatus === '賣';
                return s.focusStatus === '買' || s.focusStatus === '賣';
            });
        });

        // 3. 👀 自選觀察池：全部標的
        const watchlistStocks = computed(() => stockList.value);

        // 當前分頁與搜尋過濾後的股票
        const currentFilteredStocks = computed(() => {
            let baseList = [];
            if (stockSubTab.value === 'holding') baseList = holdingStocks.value;
            else if (stockSubTab.value === 'starred') baseList = starredStocks.value;
            else baseList = watchlistStocks.value;

            if (!stockSearchQuery.value.trim()) return baseList;
            const q = stockSearchQuery.value.trim().toLowerCase();
            return baseList.filter(s => s.code.includes(q) || s.name.toLowerCase().includes(q));
        });

        // ─── 資產總覽統計計算 ───
        const summary = computed(() => {
            let totalMarket = 0;
            let totalCost = 0;
            holdingStocks.value.forEach(s => {
                totalMarket += s.price * s.shares;
                totalCost += s.costPrice * s.shares;
            });
            const profit = totalMarket - totalCost;
            const rate = totalCost > 0 ? ((profit / totalCost) * 100).toFixed(2) : '0.00';
            return {
                totalMarketValue: totalMarket,
                totalCost: totalCost,
                unrealizedProfit: profit,
                unrealizedProfitRate: rate
            };
        });

        // ─── ECharts 資產配置圓餅圖 ───
        let chartInstance = null;
        const renderAssetChart = () => {
            nextTick(() => {
                const chartDom = document.getElementById('assetChart');
                if (!chartDom) return;
                
                const isDark = theme.value === 'dark';
                if (!chartInstance) {
                    chartInstance = echarts.init(chartDom, isDark ? 'dark' : null, { renderer: 'canvas' });
                }

                const chartData = holdingStocks.value.map(s => ({
                    name: `${s.name} (${s.code})`,
                    value: Math.round(s.price * s.shares)
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
            });
        };

        // 當切換到資產總覽分頁時重新繪製圖表
        watch(currentTab, (newTab) => {
            if (newTab === 'dashboard') {
                setTimeout(renderAssetChart, 100);
            }
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
        };

        const setFocusStatus = (stock, status) => {
            stock.focusStatus = status;
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

        const saveTradeRecord = () => {
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

            // 新增至交易紀錄清單頂部
            recentTradeLogs.value.unshift(newLog);

            // 更新個股持股
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
                    signal: '🟢 新增持股',
                    buyPriceTarget: String(tradeForm.value.price),
                    sellPriceTarget: String(tradeForm.value.price * 1.1),
                    buyRange: '',
                    defensePrice: '',
                    targetRange: '',
                    indicatorTags: [{ text: '自訂記帳', type: 'bull' }],
                    strategyFeatures: defaultFeatures.value,
                    summaryText: '手動記帳新增標的。'
                };
                stockList.value.push(target);
            }

            if (tradeForm.value.action === '買進') {
                const prevTotalCost = target.shares * target.costPrice;
                const newTotalCost = prevTotalCost + total;
                target.shares += tradeForm.value.shares;
                target.broker = brokerName;
                target.costPrice = Math.round((newTotalCost / target.shares) * 100) / 100;
                
                // 新增至 FIFO 庫存
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

            // 重新計算損益
            target.profit = Math.round((target.price - target.costPrice) * target.shares);
            target.profitRate = target.costPrice > 0 ? (((target.price - target.costPrice) / target.costPrice) * 100).toFixed(2) : 0;

            showTradeModal.value = false;
            alert(`✅ 交易記錄已成功錄入並同步！\n[${brokerName}] ${newLog.action} ${newLog.name} (${newLog.code}) ${formatNumber(newLog.shares)}股`);
        };

        // ─── Google 登入與同步互動 ───
        const handleGoogleLogin = () => {
            googleUser.value.isLoggedIn = true;
            googleUser.value.email = 'sentinel.pro@gmail.com';
            googleUser.value.lastSyncTime = new Date().toLocaleString();
            alert('🎉 Google 帳號已成功授權連結！');
        };

        const handleGoogleLogout = () => {
            if (confirm('確定要解除 Google 帳號連結嗎？')) {
                googleUser.value.isLoggedIn = false;
                googleUser.value.email = '';
            }
        };

        const triggerSync = (type) => {
            const nowStr = new Date().toLocaleString();
            googleUser.value.lastSyncTime = nowStr;
            if (type === 'sync') {
                alert(`☁️ 雙向智慧同步完成！\n已成功將本機資料庫與 Google Drive 主檔合流對齊 (${nowStr})`);
            } else if (type === 'download') {
                alert(`📥 已成功從 Google Drive 下載最新 sentinel_vault.db 覆蓋本地！ (${nowStr})`);
            }
        };

        onMounted(() => {
            renderAssetChart();
            window.addEventListener('resize', () => {
                if (chartInstance) chartInstance.resize();
            });
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
            triggerSync
        };
    }
}).mount('#app');
