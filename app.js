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
        const appVersion = ref('v2.20261007.01');

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

        // ─── 雲地資料庫狀態統計 (100% 對齊電腦端看板) ───
        const localDbStats = ref({
            lastModified: '尚未載入',
            tradeLogCount: 0,
            myStockCount: 0,
            gemStrategyCount: 0
        });

        const cloudDbStats = ref({
            lastModified: '未連接雲端或尚未查詢',
            tradeLogCount: '---',
            myStockCount: '---',
            gemStrategyCount: '---',
            fileId: '',
            sizeKB: 0
        });

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

        // ─── 雲地同步異動感知與未對齊高亮狀態 ───
        const hasUnsyncedChanges = ref(false);

        const getLocalDbFingerprint = () => {
            if (!dbInstance) return '';
            try {
                let t = '', m = '', d = '';
                try {
                    const tr = dbInstance.exec("SELECT id, 股票代號, 動作, 成交股數, 成交價, 證券商, 交易時間 FROM trade_log ORDER BY id");
                    if (tr.length > 0) t = JSON.stringify(tr[0].values);
                } catch(e) {}
                try {
                    const mr = dbInstance.exec("SELECT 股票代號, 個股股數, 損平價, 證券商 FROM my_stock ORDER BY 股票代號, 證券商");
                    if (mr.length > 0) m = JSON.stringify(mr[0].values);
                } catch(e) {}
                try {
                    const dr = dbInstance.exec("SELECT unique_key FROM deleted_records ORDER BY unique_key");
                    if (dr.length > 0) d = JSON.stringify(dr[0].values);
                } catch(e) {}
                return `${t.length}_${m.length}_${d.length}_${t.slice(-40)}_${d.slice(-40)}`;
            } catch(e) {
                return '';
            }
        };

        const checkUnsyncedStatus = () => {
            if (!dbInstance) {
                hasUnsyncedChanges.value = false;
                return;
            }
            const curFp = getLocalDbFingerprint();
            const lastFp = localStorage.getItem('sentinel_last_sync_fingerprint');
            
            if (curFp && (!lastFp || curFp !== lastFp)) {
                hasUnsyncedChanges.value = true;
                return;
            }
            
            // 若雲端已有統計且筆數不同，也標記未同步
            if (cloudDbStats.value && cloudDbStats.value.tradeLogCount !== '---' && localDbStats.value && localDbStats.value.tradeLogCount !== '---') {
                if (Number(localDbStats.value.tradeLogCount) !== Number(cloudDbStats.value.tradeLogCount)) {
                    hasUnsyncedChanges.value = true;
                    return;
                }
            }
            hasUnsyncedChanges.value = false;
        };

        const handleHeaderSyncClick = async () => {
            if (syncStatus.value.loading) return;
            if (!googleUser.value.isLoggedIn || !googleAccessToken.value) {
                if (confirm("☁️ 尚未連線 Google 雲端帳號，是否立即進行 Google 授權登入？")) {
                    handleGoogleLogin();
                }
                return;
            }
            await executeTwoWaySync();
            checkUnsyncedStatus();
        };

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
                                summary: summaryText,
                                recordTime: r[8] || ''
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

                // 5. 推算全市場最新基準交易日 (取所有表的最大日期)
                let allDates = [];
                Object.values(priceMap).forEach(p => { if (p.date) allDates.push(String(p.date).replace(/\D/g, '')); });
                Object.values(heatmapMap).forEach(h => { if (h.dataDate) allDates.push(String(h.dataDate).replace(/\D/g, '')); });
                parsedTrades.forEach(t => { if (t.date) allDates.push(String(t.date).replace(/\D/g, '')); });
                allDates = allDates.filter(d => d.length >= 8).sort().reverse();
                const latestMarketTradingDay = allDates.length > 0 ? allDates[0].slice(0, 8) : '20260331';

                // 日期格式化輔助 (轉換為 YYYY/MM/DD)
                const formatDateClean = (dStr) => {
                    if (!dStr) return '';
                    const clean = String(dStr).trim().replace(/-/g, '/');
                    return clean.length >= 10 ? clean.slice(0, 10) : clean;
                };

                // 6. 讀取 my_stock (持股與自選觀察清單)
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

                            // 時效比對 (對齊電腦端：✅ 即時新鮮 / ⚠️ 過期或落後)
                            const pDigits = String(pInfo.date || '').replace(/\D/g, '').slice(0, 8);
                            const hmDigits = String(hmInfo.dataDate || '').replace(/\D/g, '').slice(0, 8);
                            const stratDigits = String(sInfo.recordTime || '').replace(/\D/g, '').slice(0, 8);

                            const isPriceFresh = Boolean(pDigits && pDigits === latestMarketTradingDay);
                            const isReportFresh = Boolean(stratDigits && stratDigits >= latestMarketTradingDay);
                            const isIndicatorFresh = Boolean(hmDigits && pDigits && hmDigits === pDigits);
                            const isStrategyFresh = Boolean(hmDigits && hmDigits === latestMarketTradingDay);

                            const priceDate = formatDateClean(pInfo.date) || '---';
                            const reportDate = formatDateClean(sInfo.recordTime) || '最新';
                            const strategyDate = formatDateClean(hmInfo.dataDate) || (formatDateClean(pInfo.date) || '最新交易日');

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
                                latestDate,
                                isPriceFresh,
                                isReportFresh,
                                isIndicatorFresh,
                                isStrategyFresh,
                                priceDate,
                                reportDate,
                                strategyDate
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
                updateLocalDbStats();
                checkUnsyncedStatus();
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

        // ─── 輔助：流水帳日期時間格式化 (顯示 日期+時間) ───
        const formatTradeDate = (dStr) => {
            if (!dStr) return '';
            const clean = String(dStr).trim().replace(/-/g, '/');
            // 若包含時分 (例如 2026/10/07 13:50:00 或 2026/10/07 13:50)，完整顯示到分 (長度16)
            if (clean.length >= 16) {
                return clean.slice(0, 16);
            }
            return clean;
        };

        // ─── 快速記帳 / 修改交易 Modal 彈窗控制 ───
        const showTradeModal = ref(false);
        const isEditingTrade = ref(false);
        const editingTradeId = ref(null);

        const getNowDateStr = () => {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
        };

        const getNowDateTimeStr = () => {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        };

        const tradeForm = ref({
            action: '買進',
            broker: '玉山證券',
            code: '',
            name: '',
            price: null,
            shares: null,
            date: getNowDateStr()
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

        const openTradeModal = (targetStock = null, editingLog = null) => {
            if (editingLog) {
                isEditingTrade.value = true;
                editingTradeId.value = editingLog.id;
                tradeForm.value.action = editingLog.action || '買進';
                tradeForm.value.broker = editingLog.broker || '玉山證券';
                tradeForm.value.code = editingLog.code;
                tradeForm.value.name = editingLog.name;
                tradeForm.value.price = editingLog.price;
                tradeForm.value.shares = editingLog.shares;
                tradeForm.value.date = editingLog.date ? editingLog.date.slice(0, 10).replace(/\//g, '-') : getNowDateStr();
            } else if (targetStock) {
                isEditingTrade.value = false;
                editingTradeId.value = null;
                tradeForm.value.action = '買進';
                tradeForm.value.broker = targetStock.broker || '玉山證券';
                tradeForm.value.code = targetStock.code;
                tradeForm.value.name = targetStock.name;
                tradeForm.value.price = targetStock.price;
                tradeForm.value.shares = null; // 🌟 預設保持空白
                tradeForm.value.date = getNowDateStr();
            } else {
                isEditingTrade.value = false;
                editingTradeId.value = null;
                tradeForm.value.action = '買進';
                tradeForm.value.broker = selectedBrokerFilter.value !== '全部' ? selectedBrokerFilter.value : '玉山證券';
                tradeForm.value.code = '';
                tradeForm.value.name = '';
                tradeForm.value.price = null;
                tradeForm.value.shares = null; // 🌟 預設保持空白
                tradeForm.value.date = getNowDateStr();
            }
            showTradeModal.value = true;
        };

        const saveTradeRecord = async () => {
            if (!tradeForm.value.code || !tradeForm.value.price || !tradeForm.value.shares) {
                alert('請完整填寫股票代號、價格與股數！');
                return;
            }

            const brokerName = tradeForm.value.broker || '玉山證券';
            const actionName = tradeForm.value.action || '買進';
            const codeVal = tradeForm.value.code.trim();
            const nameVal = tradeForm.value.name.trim() || codeVal;
            const priceVal = Number(tradeForm.value.price);
            const sharesVal = Number(tradeForm.value.shares);
            
            // 🌟 核心對齊：資料庫統一儲存標準「日期 + 時間 (YYYY-MM-DD HH:mm)」
            let dateVal = tradeForm.value.date ? String(tradeForm.value.date).trim().replace(/\//g, '-') : getNowDateStr();
            if (dateVal.length === 10) {
                const now = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                dateVal = `${dateVal} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
            }

            if (dbInstance) {
                try {
                    if (isEditingTrade.value && editingTradeId.value) {
                        // 1. 編輯修改現有記錄
                        dbInstance.run(
                            "UPDATE trade_log SET 股票代號 = ?, 股票名稱 = ?, 動作 = ?, 成交股數 = ?, 成交價 = ?, 證券商 = ?, 交易時間 = ? WHERE id = ?",
                            [codeVal, nameVal, actionName, sharesVal, priceVal, brokerName, dateVal, editingTradeId.value]
                        );
                    } else {
                        // 2. 新增記錄
                        dbInstance.run(
                            "INSERT INTO trade_log (股票代號, 股票名稱, 動作, 成交股數, 成交價, 證券商, 交易時間, 特別關注) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            [codeVal, nameVal, actionName, sharesVal, priceVal, brokerName, dateVal, '否']
                        );
                    }

                    // 重新滾算該股持股總數與成本
                    const holdRes = dbInstance.exec("SELECT 動作, 成交股數, 成交價 FROM trade_log WHERE 股票代號 = ? AND 證券商 = ? ORDER BY 交易時間 ASC, id ASC", [codeVal, brokerName]);
                    let curShares = 0;
                    let curCost = priceVal;
                    if (holdRes.length > 0) {
                        let totalCost = 0;
                        holdRes[0].values.forEach(r => {
                            const act = r[0];
                            const sh = Number(r[1]) || 0;
                            const pr = Number(r[2]) || 0;
                            if (act === '買進') {
                                totalCost += sh * pr;
                                curShares += sh;
                            } else if (act === '賣出') {
                                curShares = Math.max(0, curShares - sh);
                                if (curShares === 0) totalCost = 0;
                            }
                        });
                        curCost = curShares > 0 ? Number((totalCost / curShares).toFixed(2)) : priceVal;
                    }

                    dbInstance.run(
                        "INSERT OR REPLACE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注) VALUES (?, ?, ?, ?, ?, ?)",
                        [codeVal, nameVal, curShares, curCost, brokerName, '否']
                    );

                    await saveDbToIndexedDb();
                    // 重新全盤載入更新後的 DB
                    const u8 = dbInstance.export();
                    await loadDatabaseFromArrayBuffer(u8.buffer, '本機 SQLite (已更新)');
                    hasUnsyncedChanges.value = true;
                } catch (err) {
                    console.error("寫入 SQLite 錯誤:", err);
                    alert("寫入資料庫失敗: " + err.message);
                    return;
                }
            }

            showTradeModal.value = false;
            alert(`✅ 交易記錄已成功${isEditingTrade.value ? '修改' : '錄入'}並同步！\n[${brokerName}] ${actionName} ${nameVal} (${codeVal}) ${formatNumber(sharesVal)}股`);
        };

        const makeTradeUniqueKey = (code, broker, date, action, shares, price) => {
            const c = String(code || '').trim().padStart(4, '0');
            const b = String(broker || '').trim();
            const d = String(date || '').trim();
            const a = String(action || '').trim();
            const s = String(Number(shares) || 0);
            const p = String(Number(price) || 0);
            return `${c}|${b}|${d}|${a}|${s}|${p}`;
        };

        const makeStockUniqueKey = (code, broker) => {
            const c = String(code || '').trim().padStart(4, '0');
            const b = String(broker || '').trim();
            return `${c}|${b}`;
        };

        const makeStrategyUniqueKey = (code, recordTime) => {
            const c = String(code || '').trim().padStart(4, '0');
            const t = String(recordTime || '').trim();
            return `${c}|${t}`;
        };

        const deleteTradeRecord = async (targetId = null) => {
            const idToDelete = targetId || editingTradeId.value;
            if (!idToDelete) return;
            if (!confirm("⚠️ 確定要刪除這筆交易記錄嗎？\n刪除後系統將自動重新計算庫存與持股成本。")) return;

            if (dbInstance) {
                try {
                    // 0. 寫入刪除墓碑 (Tombstone)
                    try {
                        const logRows = dbInstance.exec("SELECT 股票代號, 證券商, 交易時間, 動作, 成交股數, 成交價 FROM trade_log WHERE id = ?", [idToDelete]);
                        if (logRows.length > 0 && logRows[0].values.length > 0) {
                            const [c, b, d, a, s, p] = logRows[0].values[0];
                            const uk = makeTradeUniqueKey(c, b, d, a, s, p);
                            const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
                            dbInstance.run("CREATE TABLE IF NOT EXISTS deleted_records (table_name TEXT, unique_key TEXT, deleted_at TEXT, PRIMARY KEY (table_name, unique_key))");
                            dbInstance.run("INSERT OR REPLACE INTO deleted_records (table_name, unique_key, deleted_at) VALUES ('trade_log', ?, ?)", [uk, nowStr]);
                        }
                    } catch (e_tomb) {
                        console.warn("寫入墓碑警告:", e_tomb);
                    }

                    dbInstance.run("DELETE FROM trade_log WHERE id = ?", [idToDelete]);
                    await saveDbToIndexedDb();
                    const u8 = dbInstance.export();
                    await loadDatabaseFromArrayBuffer(u8.buffer, '本機 SQLite (已更新)');
                    hasUnsyncedChanges.value = true;
                } catch (e) {
                    console.error("刪除交易記錄失敗:", e);
                    alert("刪除失敗: " + e.message);
                    return;
                }
            }

            showTradeModal.value = false;
            alert("🗑️ 交易記錄已成功刪除並重新計算庫存！");
        };

        const isFetchingCloudStats = ref(false);

        // ─── Google 登入、靜默重新授權與智慧心跳監控 ───
        const silentRefreshGoogleToken = (isSilent = true) => {
            if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) return;
            const savedEmail = localStorage.getItem('sentinel_gdrive_email') || googleUser.value.email || '';
            
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: googleClientId.value.trim(),
                scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid',
                callback: async (resp) => {
                    if (resp.error) {
                        console.warn("Google 靜默刷新 Token 失敗:", resp.error);
                        if (!isSilent) alert("❌ Google 授權失敗: " + resp.error);
                        return;
                    }
                    googleAccessToken.value = resp.access_token;
                    localStorage.setItem('sentinel_gdrive_token', resp.access_token);
                    googleUser.value.isLoggedIn = true;
                    console.log("🟢 Google Token 靜默刷新/重連成功！");

                    // 重新查詢雲端最新狀態
                    await fetchCloudDbStats();
                }
            });

            try {
                // prompt: '' 靜默無彈窗授權
                tokenClient.requestAccessToken({ prompt: '', hint: savedEmail });
            } catch (e) {
                console.warn("requestAccessToken 靜默呼叫失敗:", e);
            }
        };

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

                    alert('🎉 Google 帳號授權成功！已連線至 Google 雲端同步中樞。');
                    await fetchCloudDbStats();
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
                cloudDbStats.value = {
                    lastModified: '未連接雲端或尚未查詢',
                    tradeLogCount: '---',
                    myStockCount: '---',
                    gemStrategyCount: '---',
                    fileId: '',
                    sizeKB: 0
                };
            }
        };

        // 檢查 Token 是否過期並在需要時自動重連
        const checkGoogleTokenFreshness = async () => {
            const savedToken = localStorage.getItem('sentinel_gdrive_token');
            const savedEmail = localStorage.getItem('sentinel_gdrive_email');

            if (!googleAccessToken.value && savedToken && savedEmail) {
                googleAccessToken.value = savedToken;
                googleUser.value.email = savedEmail;
                googleUser.value.isLoggedIn = true;
            }

            if (!googleAccessToken.value) return;

            try {
                const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                    headers: { Authorization: `Bearer ${googleAccessToken.value}` }
                });
                if (res.status === 401) {
                    console.log("⚠️ Google Token 已過期，啟動後台自動無感重新連結...");
                    silentRefreshGoogleToken(true);
                } else if (res.ok) {
                    const uData = await res.json();
                    if (uData.email) {
                        googleUser.value.email = uData.email;
                        googleUser.value.isLoggedIn = true;
                        localStorage.setItem('sentinel_gdrive_email', uData.email);
                    }
                    // Token 仍有效，查詢雲端狀態
                    await fetchCloudDbStats();
                }
            } catch (e) {
                console.warn("檢查 Google Token 異常:", e);
            }
        };

        // 智慧心跳監控與喚醒監聽
        const initGoogleHeartbeat = () => {
            // 每 5 分鐘心跳檢查
            setInterval(checkGoogleTokenFreshness, 5 * 60 * 1000);

            // 頁面待機切回前台時自動檢查
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    console.log("📱 頁面切回前台，自動檢查 Google 連線狀態...");
                    checkGoogleTokenFreshness();
                }
            });
        };

        // ─── 雲地資料庫狀態更新函式 ───
        const updateLocalDbStats = (modTimeStr = null) => {
            if (!dbInstance) return;
            try {
                let tCount = 0, mCount = 0, gCount = 0;
                try {
                    const tRes = dbInstance.exec("SELECT COUNT(*) FROM trade_log");
                    if (tRes.length > 0) tCount = tRes[0].values[0][0];
                } catch (e) {}
                try {
                    const mRes = dbInstance.exec("SELECT COUNT(*) FROM my_stock");
                    if (mRes.length > 0) mCount = mRes[0].values[0][0];
                } catch (e) {}
                try {
                    const gRes = dbInstance.exec("SELECT COUNT(*) FROM gem_strategy");
                    if (gRes.length > 0) gCount = gRes[0].values[0][0];
                } catch (e) {}

                const now = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                const timeStr = modTimeStr || `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
                
                localDbStats.value = {
                    lastModified: timeStr,
                    tradeLogCount: tCount,
                    myStockCount: mCount,
                    gemStrategyCount: gCount
                };
            } catch (e) {
                console.warn("updateLocalDbStats 失敗:", e);
            }
        };

        // 查詢雲端資料庫狀態 (由 Google Drive 獲取最新 metadata 與 stats)
        const fetchCloudDbStats = async () => {
            const token = googleAccessToken.value || localStorage.getItem('sentinel_gdrive_token');
            if (!token) return;
            if (!googleAccessToken.value) googleAccessToken.value = token;

            isFetchingCloudStats.value = true;
            try {
                const searchUrl = `https://www.googleapis.com/drive/v3/files?spaces=drive&q=name='sentinel_vault.db' and trashed=false&fields=files(id,name,modifiedTime,size,description)&orderBy=modifiedTime desc`;
                const searchRes = await fetch(searchUrl, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (searchRes.status === 401) {
                    console.log("⚠️ 查詢雲端狀態 401，嘗試靜默授權...");
                    silentRefreshGoogleToken(true);
                    return;
                }
                const searchData = await searchRes.json();
                if (searchData.files && searchData.files.length > 0) {
                    const targetFile = searchData.files[0];
                    cloudDbStats.value.fileId = targetFile.id;
                    cloudDbStats.value.sizeKB = Math.round((targetFile.size || 0) / 1024);
                    
                    let timeStr = '---';
                    if (targetFile.modifiedTime) {
                        const d = new Date(targetFile.modifiedTime);
                        if (!isNaN(d.getTime())) {
                            const pad = n => String(n).padStart(2, '0');
                            timeStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
                        } else {
                            timeStr = targetFile.modifiedTime.slice(0, 19).replace('T', ' ');
                        }
                    }

                    let parsed = false;

                    if (targetFile.description) {
                        try {
                            const metaObj = JSON.parse(targetFile.description);
                            if (metaObj && metaObj.stats) {
                                cloudDbStats.value.tradeLogCount = metaObj.stats.trade_log_count ?? '---';
                                cloudDbStats.value.myStockCount = metaObj.stats.my_stock_count ?? '---';
                                cloudDbStats.value.gemStrategyCount = metaObj.stats.gem_strategy_count ?? '---';
                                if (metaObj.stats.last_modified) timeStr = metaObj.stats.last_modified;
                                parsed = true;
                            }
                        } catch (e) {}
                    }

                    if (!parsed) {
                        try {
                            const fRes = await fetch(`https://www.googleapis.com/drive/v3/files/${targetFile.id}?alt=media`, {
                                headers: { Authorization: `Bearer ${token}` }
                            });
                            const buf = await fRes.arrayBuffer();
                            if (!SQL_ENGINE) {
                                SQL_ENGINE = await initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` });
                            }
                            const tempDb = new SQL_ENGINE.Database(new Uint8Array(buf));
                            try { cloudDbStats.value.tradeLogCount = tempDb.exec("SELECT COUNT(*) FROM trade_log")[0]?.values[0][0] || 0; } catch (e) {}
                            try { cloudDbStats.value.myStockCount = tempDb.exec("SELECT COUNT(*) FROM my_stock")[0]?.values[0][0] || 0; } catch (e) {}
                            try { cloudDbStats.value.gemStrategyCount = tempDb.exec("SELECT COUNT(*) FROM gem_strategy")[0]?.values[0][0] || 0; } catch (e) {}
                            tempDb.close();
                        } catch (e) {
                            console.warn("解析雲端 DB buffer 筆數失敗:", e);
                        }
                    }
                    cloudDbStats.value.lastModified = timeStr;
                } else {
                    cloudDbStats.value = {
                        lastModified: '雲端尚無資料庫主檔',
                        tradeLogCount: 0,
                        myStockCount: 0,
                        gemStrategyCount: 0,
                        fileId: '',
                        sizeKB: 0
                    };
                }
            } catch (e) {
                console.warn("fetchCloudDbStats 失敗:", e);
            } finally {
                isFetchingCloudStats.value = false;
                checkUnsyncedStatus();
            }
        };

        // 上傳 buffer 到 Google Drive
        const uploadBufferToGoogleDrive = async (u8Buffer) => {
            if (!googleAccessToken.value) {
                handleGoogleLogin();
                return false;
            }
            const blob = new Blob([u8Buffer], { type: 'application/x-sqlite3' });
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const nowStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

            // 即時由最新資料庫中統計真實筆數
            let tCount = 0, mCount = 0, gCount = 0;
            if (dbInstance) {
                try { tCount = dbInstance.exec("SELECT COUNT(*) FROM trade_log")[0]?.values[0][0] || 0; } catch (e) {}
                try { mCount = dbInstance.exec("SELECT COUNT(*) FROM my_stock")[0]?.values[0][0] || 0; } catch (e) {}
                try { gCount = dbInstance.exec("SELECT COUNT(*) FROM gem_strategy")[0]?.values[0][0] || 0; } catch (e) {}
            } else {
                tCount = localDbStats.value.tradeLogCount;
                mCount = localDbStats.value.myStockCount;
                gCount = localDbStats.value.gemStrategyCount;
            }

            localDbStats.value = {
                lastModified: nowStr,
                tradeLogCount: tCount,
                myStockCount: mCount,
                gemStrategyCount: gCount
            };

            const metaObj = {
                device: 'PWA-Mobile',
                last_sync_time: nowStr,
                stats: {
                    trade_log_count: tCount,
                    my_stock_count: mCount,
                    gem_strategy_count: gCount,
                    last_modified: nowStr
                }
            };

            const metadata = {
                name: 'sentinel_vault.db',
                mimeType: 'application/x-sqlite3',
                description: JSON.stringify(metaObj)
            };

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', blob);

            let uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
            let method = 'POST';

            if (cloudDbStats.value.fileId) {
                uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${cloudDbStats.value.fileId}?uploadType=multipart`;
                method = 'PATCH';
            }

            const upRes = await fetch(uploadUrl, {
                method: method,
                headers: { Authorization: `Bearer ${googleAccessToken.value}` },
                body: form
            });

            if (upRes.ok) {
                const upData = await upRes.json();
                cloudDbStats.value.fileId = upData.id;
                cloudDbStats.value.lastModified = nowStr;
                cloudDbStats.value.tradeLogCount = tCount;
                cloudDbStats.value.myStockCount = mCount;
                cloudDbStats.value.gemStrategyCount = gCount;
                localStorage.setItem('sentinel_drive_file_id', upData.id);
                googleUser.value.lastSyncTime = nowStr;
                localStorage.setItem('sentinel_last_sync_time', nowStr);

                const newFp = getLocalDbFingerprint();
                localStorage.setItem('sentinel_last_sync_fingerprint', newFp);
                hasUnsyncedChanges.value = false;
                return true;
            } else {
                throw new Error(`Google Drive API 上傳失敗 (HTTP ${upRes.status})`);
            }
        };

        // 🤝 1. 執行【智慧雙向同步】(推薦：兩端紀錄 100% 完整保留)
        const executeTwoWaySync = async () => {
            if (!googleAccessToken.value) {
                handleGoogleLogin();
                return;
            }

            syncStatus.value.loading = true;
            syncStatus.value.message = '正在取得雲端最新 sentinel_vault.db...';

            try {
                const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='sentinel_vault.db' and trashed=false&fields=files(id,name,modifiedTime,size,description)`;
                const searchRes = await fetch(searchUrl, {
                    headers: { Authorization: `Bearer ${googleAccessToken.value}` }
                });
                const searchData = await searchRes.json();

                if (!searchData.files || searchData.files.length === 0) {
                    if (!dbInstance) {
                        alert("⚠️ 本地尚未載入資料庫，無法建立雲端檔案。");
                        return;
                    }
                    syncStatus.value.message = '雲端尚無檔案，正在上傳本機資料庫作為主檔...';
                    await uploadBufferToGoogleDrive(dbInstance.export());
                    alert("✨ 雲端主檔建立成功！兩端資料已同步。");
                    return;
                }

                const targetFile = searchData.files[0];
                cloudDbStats.value.fileId = targetFile.id;
                syncStatus.value.message = '正在下載雲端資料庫進行智慧合流...';

                const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${targetFile.id}?alt=media`, {
                    headers: { Authorization: `Bearer ${googleAccessToken.value}` }
                });
                const cloudBuf = await fileRes.arrayBuffer();

                if (!SQL_ENGINE) {
                    SQL_ENGINE = await initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` });
                }

                const cloudDb = new SQL_ENGINE.Database(new Uint8Array(cloudBuf));

                if (!dbInstance) {
                    await loadDatabaseFromArrayBuffer(cloudBuf, 'Google Drive 雲端');
                    updateLocalDbStats();
                    alert("✨ 成功下載並載入雲端資料庫！");
                    return;
                }

                // ─── 智慧合流：雙向去重聯集 (含墓碑過濾) ───
                syncStatus.value.message = '正在進行雙向無損聯集合併 (含墓碑過濾)...';

                // 0. 智慧合流 deleted_records 墓碑名冊
                try {
                    dbInstance.run("CREATE TABLE IF NOT EXISTS deleted_records (table_name TEXT, unique_key TEXT, deleted_at TEXT, PRIMARY KEY (table_name, unique_key))");
                    cloudDb.run("CREATE TABLE IF NOT EXISTS deleted_records (table_name TEXT, unique_key TEXT, deleted_at TEXT, PRIMARY KEY (table_name, unique_key))");
                    const cTombs = cloudDb.exec("SELECT table_name, unique_key, deleted_at FROM deleted_records");
                    if (cTombs.length > 0) {
                        cTombs[0].values.forEach(t => {
                            dbInstance.run("INSERT OR IGNORE INTO deleted_records (table_name, unique_key, deleted_at) VALUES (?, ?, ?)", t);
                        });
                    }
                } catch (e) {
                    console.warn("合流 deleted_records 警告:", e);
                }

                // 取得三大核心表之所有墓碑名冊
                const deletedTradeKeys = new Set();
                const deletedStockKeys = new Set();
                const deletedStrategyKeys = new Set();
                try {
                    const dResT = dbInstance.exec("SELECT unique_key FROM deleted_records WHERE table_name = 'trade_log'");
                    if (dResT.length > 0) dResT[0].values.forEach(r => deletedTradeKeys.add(r[0]));
                    const dResS = dbInstance.exec("SELECT unique_key FROM deleted_records WHERE table_name = 'my_stock'");
                    if (dResS.length > 0) dResS[0].values.forEach(r => deletedStockKeys.add(r[0]));
                    const dResG = dbInstance.exec("SELECT unique_key FROM deleted_records WHERE table_name = 'gem_strategy'");
                    if (dResG.length > 0) dResG[0].values.forEach(r => deletedStrategyKeys.add(r[0]));
                } catch (e) {}

                // 1. 清算本地 trade_log 墓碑資料
                try {
                    const localLogs = dbInstance.exec("SELECT id, 股票代號, 證券商, 交易時間, 動作, 成交股數, 成交價 FROM trade_log");
                    if (localLogs.length > 0) {
                        localLogs[0].values.forEach(r => {
                            const [r_id, r_code, r_broker, r_date, r_action, r_shares, r_price] = r;
                            const uk = makeTradeUniqueKey(r_code, r_broker, r_date, r_action, r_shares, r_price);
                            if (deletedTradeKeys.has(uk)) {
                                dbInstance.run("DELETE FROM trade_log WHERE id = ?", [r_id]);
                            }
                        });
                    }
                } catch (e) {}

                // 2. 合流 trade_log (排除墓碑)
                try {
                    const cTrades = cloudDb.exec("SELECT 股票代號, 股票名稱, 動作, 成交股數, 成交價, 證券商, 交易時間, 特別關注 FROM trade_log");
                    if (cTrades.length > 0) {
                        cTrades[0].values.forEach(r => {
                            const [code, name, action, shares, price, broker, date, focus] = r;
                            const uk = makeTradeUniqueKey(code, broker, date, action, shares, price);
                            if (!deletedTradeKeys.has(uk)) {
                                const chk = dbInstance.exec(
                                    "SELECT id FROM trade_log WHERE 股票代號 = ? AND 證券商 = ? AND 交易時間 = ? AND 動作 = ? AND 成交股數 = ? AND 成交價 = ?",
                                    [code, broker, date, action, shares, price]
                                );
                                if (!chk.length || !chk[0].values.length) {
                                    dbInstance.run(
                                        "INSERT INTO trade_log (股票代號, 股票名稱, 動作, 成交股數, 成交價, 證券商, 交易時間, 特別關注) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                        [code, name, action, shares, price, broker, date, focus || '否']
                                    );
                                }
                            }
                        });
                    }
                } catch (e) {
                    console.warn("合流 trade_log 警告:", e);
                }

                // 3. 智慧合流 gem_strategy (含墓碑清算與過濾)
                try {
                    // 3.1 清算本地 gem_strategy 墓碑
                    const localStrat = dbInstance.exec("SELECT rowid, 股票代號, 記錄時間 FROM gem_strategy");
                    if (localStrat.length > 0) {
                        localStrat[0].values.forEach(r => {
                            const [r_id, r_code, r_time] = r;
                            const uk = makeStrategyUniqueKey(r_code, r_time);
                            if (deletedStrategyKeys.has(uk)) {
                                dbInstance.run("DELETE FROM gem_strategy WHERE rowid = ?", [r_id]);
                            }
                        });
                    }

                    // 3.2 增量合流雲端 gem_strategy (排除墓碑)
                    const cStrat = cloudDb.exec("SELECT 股票代號, 策略內容, 佈局下限, 佈局上限, 防守點, 目標下限, 目標上限, 戰情總結, 記錄時間 FROM gem_strategy");
                    if (cStrat.length > 0) {
                        cStrat[0].values.forEach(r => {
                            const [code, content, bLow, bHigh, defP, tLow, tHigh, sumText, rTime] = r;
                            const uk = makeStrategyUniqueKey(code, rTime);
                            if (!deletedStrategyKeys.has(uk)) {
                                const chk = dbInstance.exec("SELECT rowid FROM gem_strategy WHERE 股票代號 = ? AND 記錄時間 = ?", [code, rTime]);
                                if (!chk.length || !chk[0].values.length) {
                                    dbInstance.run(
                                        "INSERT INTO gem_strategy (股票代號, 策略內容, 佈局下限, 佈局上限, 防守點, 目標下限, 目標上限, 戰情總結, 記錄時間) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                        [code, content, bLow, bHigh, defP, tLow, tHigh, sumText, rTime]
                                    );
                                }
                            }
                        });
                    }
                } catch (e) {
                    console.warn("合流 gem_strategy 警告:", e);
                }

                // 4. 智慧合流 my_stock (自選名冊，含墓碑清算與過濾)
                try {
                    // 4.1 清算本地已刪除且無庫存的自選股
                    const localStocks = dbInstance.exec("SELECT 股票代號, 證券商, 個股股數 FROM my_stock");
                    if (localStocks.length > 0) {
                        localStocks[0].values.forEach(r => {
                            const [r_code, r_broker, r_shares] = r;
                            const uk = makeStockUniqueKey(r_code, r_broker);
                            if (deletedStockKeys.has(uk) && Number(r_shares || 0) <= 0) {
                                dbInstance.run("DELETE FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?", [r_code, r_broker]);
                            }
                        });
                    }

                    // 4.2 增量合流雲端 my_stock (排除墓碑)
                    const cStocks = cloudDb.exec("SELECT 股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注 FROM my_stock");
                    if (cStocks.length > 0) {
                        cStocks[0].values.forEach(r => {
                            const [code, name, shares, price, broker, focus] = r;
                            const uk = makeStockUniqueKey(code, broker);
                            if (!deletedStockKeys.has(uk)) {
                                const chk = dbInstance.exec("SELECT 股票代號 FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?", [code, broker]);
                                if (!chk.length || !chk[0].values.length) {
                                    dbInstance.run(
                                        "INSERT OR IGNORE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注) VALUES (?, ?, ?, ?, ?, ?)",
                                        [code, name, shares, price, broker, focus || '否']
                                    );
                                }
                            }
                        });
                    }
                } catch (e) {
                    console.warn("合流 my_stock 警告:", e);
                }

                cloudDb.close();

                // 5. 重新以本機合併後的 trade_log 滾算 my_stock (排除墓碑中已刪除之自選觀察股)
                const allHoldRes = dbInstance.exec("SELECT DISTINCT 股票代號, 證券商, 股票名稱 FROM trade_log");
                if (allHoldRes.length > 0) {
                    allHoldRes[0].values.forEach(r => {
                        const [code, broker, name] = r;
                        const tRows = dbInstance.exec("SELECT 動作, 成交股數, 成交價 FROM trade_log WHERE 股票代號 = ? AND 證券商 = ? ORDER BY 交易時間 ASC, id ASC", [code, broker]);
                        let curShares = 0;
                        let curCost = 0;
                        let totalCost = 0;
                        if (tRows.length > 0) {
                            tRows[0].values.forEach(tr => {
                                const [act, sh, pr] = tr;
                                if (act === '買進') {
                                    totalCost += sh * pr;
                                    curShares += sh;
                                } else if (act === '賣出') {
                                    curShares = Math.max(0, curShares - sh);
                                    if (curShares === 0) totalCost = 0;
                                }
                            });
                            curCost = curShares > 0 ? Number((totalCost / curShares).toFixed(2)) : 0;
                        }
                        
                        const stockUk = makeStockUniqueKey(code, broker);
                        if (curShares === 0 && deletedStockKeys.has(stockUk)) {
                            dbInstance.run("DELETE FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?", [code, broker]);
                        } else {
                            dbInstance.run(
                                "INSERT OR REPLACE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT 特別關注 FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?), '否'))",
                                [code, name, curShares, curCost, broker, code, broker]
                            );
                        }
                    });
                }

                await saveDbToIndexedDb();
                const mergedBuf = dbInstance.export();
                await loadDatabaseFromArrayBuffer(mergedBuf.buffer, '智慧雙向合流');

                syncStatus.value.message = '正在將雙向合流後的黃金版本上傳回 Google Drive...';
                await uploadBufferToGoogleDrive(mergedBuf);

                updateLocalDbStats();
                await fetchCloudDbStats();

                const newFp = getLocalDbFingerprint();
                localStorage.setItem('sentinel_last_sync_fingerprint', newFp);
                hasUnsyncedChanges.value = false;

                alert("🤝 智慧雙向同步成功！\n兩端交易紀錄與策略資料庫已 100% 完整無損合流對齊。");
            } catch (err) {
                console.error("雙向同步失敗:", err);
                alert("❌ 雙向同步失敗：" + err.message);
            } finally {
                syncStatus.value.loading = false;
            }
        };

        // 📤 2. 單向上傳備份至雲端
        const executeSingleUpload = async () => {
            if (!dbInstance) {
                alert("⚠️ 本機尚未載入資料庫，無法上傳。");
                return;
            }
            if (!confirm("⚠️ 確定要執行【單向上傳備份】嗎？\n這將會以手機本機的資料庫直接覆蓋雲端上的 sentinel_vault.db！")) return;

            syncStatus.value.loading = true;
            syncStatus.value.message = '正在上傳本機資料庫至 Google Drive...';

            try {
                const u8 = dbInstance.export();
                await uploadBufferToGoogleDrive(u8);
                await fetchCloudDbStats();
                alert("📤 單向上傳備份成功！雲端資料庫已覆蓋更新。");
            } catch (err) {
                console.error("單向上傳失敗:", err);
                alert("❌ 上傳失敗：" + err.message);
            } finally {
                syncStatus.value.loading = false;
            }
        };

        // 📥 3. 單向從雲端下載覆蓋本地
        const executeSingleDownload = async () => {
            if (!googleAccessToken.value) {
                handleGoogleLogin();
                return;
            }
            if (!confirm("⚠️ 確定要執行【單向下載覆蓋】嗎？\n這將會從雲端下載 sentinel_vault.db 並直接覆蓋手機本機的所有記錄！")) return;

            syncStatus.value.loading = true;
            syncStatus.value.message = '正在從 Google Drive 下載主檔覆蓋本地...';

            try {
                const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='sentinel_vault.db' and trashed=false&fields=files(id,name,modifiedTime,size,description)`;
                const searchRes = await fetch(searchUrl, {
                    headers: { Authorization: `Bearer ${googleAccessToken.value}` }
                });
                const searchData = await searchRes.json();

                if (searchData.files && searchData.files.length > 0) {
                    const targetFile = searchData.files[0];
                    const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${targetFile.id}?alt=media`, {
                        headers: { Authorization: `Bearer ${googleAccessToken.value}` }
                    });
                    const buffer = await fileRes.arrayBuffer();

                    await loadDatabaseFromArrayBuffer(buffer, 'Google Drive 雲端 (單向覆蓋)');
                    updateLocalDbStats();
                    await fetchCloudDbStats();
                    alert(`📥 單向下載還原成功！\n已成功載入雲端最新主檔 (${(buffer.byteLength / 1024).toFixed(0)} KB)。`);
                } else {
                    alert("ℹ️ 在您的 Google Drive 中尚未找到 sentinel_vault.db。");
                }
            } catch (err) {
                console.error("單向下載失敗:", err);
                alert("❌ 下載還原失敗：" + err.message);
            } finally {
                syncStatus.value.loading = false;
            }
        };

        const triggerSync = async (type, isSilent = false) => {
            if (type === 'download') {
                await executeSingleDownload();
            } else if (type === 'upload') {
                await executeSingleUpload();
            } else {
                await executeTwoWaySync();
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
                    updateLocalDbStats();
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

        // 監聽頁籤切換：切到雲端設定時自動刷新本機與雲端狀態
        watch(currentTab, (newTab) => {
            if (newTab === 'settings') {
                updateLocalDbStats();
                fetchCloudDbStats();
            }
        });

        // ─── 生命週期掛載與 IndexedDB / Google 心跳初始化 ───
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
                        updateLocalDbStats();
                    }
                } catch (e) {
                    console.warn("讀取離線快取失敗:", e);
                }
            }

            // 啟動 Google 智慧心跳監控與背景自動檢測
            initGoogleHeartbeat();
            await checkGoogleTokenFreshness();
            await fetchCloudDbStats();
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
            isEditingTrade,
            deleteTradeRecord,
            formatTradeDate,
            localDbStats,
            cloudDbStats,
            isFetchingCloudStats,
            executeTwoWaySync,
            executeSingleUpload,
            executeSingleDownload,
            fetchCloudDbStats,
            handleGoogleLogin,
            handleGoogleLogout,
            hasUnsyncedChanges,
            handleHeaderSyncClick,
            triggerSync,
            triggerFileInput,
            handleDbFileSelected,
            exportDatabaseFile
        };
    }
}).mount('#app');
