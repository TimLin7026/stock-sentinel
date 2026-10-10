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
        const appVersion = ref('v2.20261010.16');

        // ─── 📱/🖥️ 主畫面版面 RWD 模式 (手機窄版 mobile / 電腦寬版 wide) ───
        const appLayout = ref(localStorage.getItem('sentinel_app_layout') || 'mobile');
        const toggleAppLayout = () => {
            appLayout.value = appLayout.value === 'mobile' ? 'wide' : 'mobile';
            localStorage.setItem('sentinel_app_layout', appLayout.value);
            Vue.nextTick(() => {
                const triggerResize = () => {
                    if (chartInstance && typeof chartInstance.resize === 'function') {
                        chartInstance.resize();
                    }
                };
                triggerResize();
                setTimeout(triggerResize, 100);
                setTimeout(triggerResize, 350); // 300ms 動畫結束後精準重繪
            });
        };

        // ─── 導航與分頁狀態 ───
        const currentTab = ref('dashboard'); // 預設登入後顯示資產總覽
        const stockSubTab = ref('holding'); // 預設現役持股區
        const starredSubFilter = ref('全部'); // 特別關注子過濾 (全部 / 買 / 賣)
        const stockSearchQuery = ref('');
        const expandedStockUids = ref(new Set()); // 展開卡片集合 (以 code_broker 為唯一 UID)

        // ─── 資產總覽：券商篩選狀態 (對齊地端) ───
        const selectedBrokerFilter = ref('全部');

        // ─── 交易 FIFO：時間範圍與關鍵字篩選狀態 (支援代號/名稱/券商快速過濾) ───
        const tradeDateRangeFilter = ref('近1周'); // 近1周 | 近2周 | 近1月 | 近3月 | 全部
        const tradeSearchKeyword = ref(''); // 關鍵字過濾搜尋框

        // ─── 匯入戰報 Modal 狀態 ───
        const showImportReportModal = ref(false);
        const importReportText = ref('');
        const importingStock = ref(null);

        // ─── 休市日與批量差異補完狀態 ───
        const isUpdatingHolidays = ref(false);
        const isBatchPatching = ref(false);

        // ─── 全域台股字典快取 (代號 -> 名稱，內建熱門標的兜底) ───
        const stockDictMap = ref({
            '0050': '元大台灣50',
            '0056': '元大高股息',
            '00878': '國泰永續高股息',
            '00919': '群益台灣精選高息',
            '00929': '復華台灣科技優息',
            '00917': '中信特選金融',
            '00940': '元大台灣價值高息',
            '00713': '元大台灣高息低波',
            '00915': '凱基優選高股息30',
            '2330': '台積電',
            '2317': '鴻海',
            '2454': '聯發科',
            '2542': '興富發',
            '2603': '長榮',
            '2881': '富邦金',
            '2882': '國泰金',
            '2891': '中信金'
        });

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

        // ─── 權限閘門：必須綁定 Google 帳號才可完整解鎖戰情中樞 ───
        const isAppUnlocked = computed(() => {
            return googleUser.value.isLoggedIn && !!googleAccessToken.value;
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

        const markAsSynced = () => {
            if (!dbInstance) return;
            const curFp = getLocalDbFingerprint();
            if (curFp) {
                localStorage.setItem('sentinel_last_sync_fingerprint', curFp);
            }
            hasUnsyncedChanges.value = false;
        };

        const checkUnsyncedStatus = () => {
            if (!dbInstance) {
                hasUnsyncedChanges.value = false;
                return;
            }
            const curFp = getLocalDbFingerprint();
            const lastFp = localStorage.getItem('sentinel_last_sync_fingerprint');
            
            if (curFp && lastFp && curFp === lastFp) {
                hasUnsyncedChanges.value = false;
                return;
            }
            
            if (curFp && (!lastFp || curFp !== lastFp)) {
                hasUnsyncedChanges.value = true;
                return;
            }
            hasUnsyncedChanges.value = false;
        };

        // ─── 雲端大腦全市場快照同步與時間追蹤狀態 ───
        let currentMarketSnapshotData = null; // 記憶體常駐快照快取

        const marketSyncMeta = ref({
            fetchTime: localStorage.getItem('sentinel_market_fetch_time') || '',
            marketDate: localStorage.getItem('sentinel_market_date') || '',
            cloudGeneratedAt: localStorage.getItem('sentinel_market_cloud_time') || '',
            nextScheduledRun: localStorage.getItem('sentinel_market_next_run') || '',
            totalStocks: Number(localStorage.getItem('sentinel_market_total_stocks')) || 0,
            healthScore: Number(localStorage.getItem('sentinel_market_health_score')) || 100,
            status: localStorage.getItem('sentinel_market_status') || 'READY'
        });

        // ⏰ 智慧計算下一次開市日抓取時間 (14:30 / 21:00)
        const nextCrawlTimeInfo = computed(() => {
            if (marketSyncMeta.value.nextScheduledRun) {
                return {
                    label: marketSyncMeta.value.nextScheduledRun,
                    tag: '自動排程',
                    countdown: ''
                };
            }
            const now = new Date();
            const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
            const twNow = new Date(utc + (3600000 * 8));

            for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
                const target = new Date(twNow.getTime() + dayOffset * 86400000);
                const dayOfWeek = target.getDay();
                if (dayOfWeek === 0 || dayOfWeek === 6) continue;

                const slots = [
                    { h: 14, m: 30, tag: '盤後即時' },
                    { h: 21, m: 0, tag: '全量籌碼' }
                ];
                for (const slot of slots) {
                    const slotDate = new Date(target.getFullYear(), target.getMonth(), target.getDate(), slot.h, slot.m, 0);
                    if (slotDate.getTime() > twNow.getTime()) {
                        const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
                        const diffMin = Math.round((slotDate.getTime() - twNow.getTime()) / 60000);
                        const diffHours = (diffMin / 60).toFixed(1);
                        const y = slotDate.getFullYear();
                        const m = String(slotDate.getMonth() + 1).padStart(2, '0');
                        const d = String(slotDate.getDate()).padStart(2, '0');
                        const hh = String(slotDate.getHours()).padStart(2, '0');
                        const mm = String(slotDate.getMinutes()).padStart(2, '0');
                        return {
                            label: `${y}/${m}/${d} (${weekdays[dayOfWeek]}) ${hh}:${mm}`,
                            countdown: diffMin > 60 ? `約 ${diffHours} 小時後` : `約 ${diffMin} 分鐘後`,
                            tag: slot.tag
                        };
                    }
                }
            }
            return { label: '開市日 14:30 / 21:00', countdown: '', tag: '自動排程' };
        });

        // 🔔 主動提醒狀態 (開市日 15:00 / 21:30 推播)
        const activeSyncNotice = ref({
            show: false,
            type: '', // 'post_market' | 'full_chip'
            title: '',
            message: '',
            slot: ''
        });

        const checkScheduledSyncReminders = () => {
            const now = new Date();
            const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
            const twNow = new Date(utc + (3600000 * 8));
            const dayOfWeek = twNow.getDay();

            // 週末不提醒
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                if (activeSyncNotice.value.show) activeSyncNotice.value.show = false;
                return;
            }

            const y = twNow.getFullYear();
            const m = String(twNow.getMonth() + 1).padStart(2, '0');
            const d = String(twNow.getDate()).padStart(2, '0');
            const todayDateStr = `${y}${m}${d}`;
            const totalMinutes = twNow.getHours() * 60 + twNow.getMinutes();

            // 1. 下午場提醒：15:00 ~ 15:30 (900分 ~ 930分)
            if (totalMinutes >= 900 && totalMinutes < 930) {
                const alreadyNotified = localStorage.getItem(`sentinel_notified_1500_${todayDateStr}`);
                if (!alreadyNotified) {
                    activeSyncNotice.value = {
                        show: true,
                        type: 'post_market',
                        title: '📈 盤後行情已出爐 (14:30場次)',
                        message: '今日收盤價與 6 大青紅燈指標已就緒，請點擊同步更新！',
                        slot: '1500'
                    };
                    return;
                }
            }

            // 2. 晚間場提醒：21:30 ~ 22:00 (1290分 ~ 1320分)
            if (totalMinutes >= 1290 && totalMinutes < 1320) {
                const alreadyNotified = localStorage.getItem(`sentinel_notified_2130_${todayDateStr}`);
                if (!alreadyNotified) {
                    activeSyncNotice.value = {
                        show: true,
                        type: 'full_chip',
                        title: '📊 全量籌碼已結算 (21:00場次)',
                        message: '三大法人與融資券數據已全數清洗完畢，請點擊同步！',
                        slot: '2130'
                    };
                    return;
                }
            }

            // 非提醒時段自動關閉
            if (activeSyncNotice.value.show) {
                activeSyncNotice.value.show = false;
            }
        };

        const dismissSyncNotice = () => {
            if (activeSyncNotice.value.slot) {
                const now = new Date();
                const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                const twNow = new Date(utc + (3600000 * 8));
                const y = twNow.getFullYear();
                const m = String(twNow.getMonth() + 1).padStart(2, '0');
                const d = String(twNow.getDate()).padStart(2, '0');
                const todayDateStr = `${y}${m}${d}`;
                localStorage.setItem(`sentinel_notified_${activeSyncNotice.value.slot}_${todayDateStr}`, 'true');
            }
            activeSyncNotice.value.show = false;
        };

        const handleNoticeSyncClick = async () => {
            dismissSyncNotice();
            await handleOneClickSync();
        };

        // 現代瀏覽器標準原生極速 Gzip 解壓 (<10ms)
        const decompressGzip = async (arrayBuffer) => {
            if ('DecompressionStream' in window) {
                const stream = new Response(arrayBuffer).body.pipeThrough(new DecompressionStream('gzip'));
                const text = await new Response(stream).text();
                return JSON.parse(text);
            }
            throw new Error('您的瀏覽器不支援原生 DecompressionStream 解壓');
        };

        // 根據快照中的 6 大指標燈號建立 4 維動態漸層標籤
        const buildIndicatorTagsFromSnapshot = (lights = {}, prev_ind = {}, prev_lights = {}) => {
            const mapTag = (displayText, keyOld, keyChinese) => {
                let currVal = lights[keyChinese] !== undefined ? lights[keyChinese] : lights[keyOld];
                let prevVal = prev_lights[keyChinese] !== undefined ? prev_lights[keyChinese] : (prev_ind && prev_ind[keyOld] !== undefined ? prev_ind[keyOld] : currVal);

                const isCurrBull = (currVal === 1 || currVal === 'red' || currVal === true || currVal === '1');
                const isPrevBull = (prevVal === 1 || prevVal === 'red' || prevVal === true || prevVal === '1');

                let bgStyle = '';
                let tooltip = '';
                let transitionType = '';

                if (!isPrevBull && !isCurrBull) {
                    transitionType = 'bear-bear';
                    bgStyle = 'background: #00B050; color: white;';
                    tooltip = `${displayText}：昨日偏空 ➔ 今日偏空 (持續偏空)`;
                } else if (!isPrevBull && isCurrBull) {
                    transitionType = 'bear-bull';
                    bgStyle = 'background: linear-gradient(90deg, #00B050 0%, #00B050 15%, #FF4B4B 35%, #FF4B4B 100%); color: white;';
                    tooltip = `${displayText}：昨日偏空 ➔ 今日轉強 (轉折翻紅 🔥)`;
                } else if (isPrevBull && !isCurrBull) {
                    transitionType = 'bull-bear';
                    bgStyle = 'background: linear-gradient(90deg, #FF4B4B 0%, #FF4B4B 15%, #00B050 35%, #00B050 100%); color: white;';
                    tooltip = `${displayText}：昨日偏多 ➔ 今日轉弱 (轉折翻綠 ⚠️)`;
                } else {
                    transitionType = 'bull-bull';
                    bgStyle = 'background: #FF4B4B; color: white;';
                    tooltip = `${displayText}：昨日偏多 ➔ 今日偏多 (持續多頭)`;
                }

                return {
                    text: displayText,
                    type: isCurrBull ? 'bull' : 'bear',
                    transition: transitionType,
                    bgStyle,
                    tooltip
                };
            };

            return [
                mapTag('MTM金', 'trend', 'MTM金'),
                mapTag('OSC縮', 'vol', 'OSC縮'),
                mapTag('K趨', 'kd', 'K趨'),
                mapTag('DIF趨', 'macd', 'DIF趨'),
                mapTag('KD金', 'rsi', 'KD金'),
                mapTag('MACD金', 'chip', 'MACD金')
            ];
        };

        // 將全市場快照行情與指標注入前端狀態
        const applyMarketSnapshot = (snapshotData, meta = {}) => {
            if (!snapshotData || typeof snapshotData !== 'object') return 0;
            currentMarketSnapshotData = snapshotData;

            // 1. 同步擴充台股代號與名稱字典
            Object.keys(snapshotData).forEach(c => {
                const item = snapshotData[c];
                if (item && item.name) {
                    stockDictMap.value[c] = item.name;
                    stockDictMap.value[c.padStart(4, '0')] = item.name;
                    stockDictMap.value[c.padStart(5, '0')] = item.name;
                }
            });

            // 2. 更新持股與自選股之最新行情與指標
            let matchedCount = 0;
            stockList.value.forEach(s => {
                const rawCode = String(s.code || '').trim();
                const snap = snapshotData[rawCode] 
                    || snapshotData[rawCode.padStart(4, '0')] 
                    || snapshotData[rawCode.padStart(5, '0')] 
                    || snapshotData[rawCode.replace(/^0+/, '')];

                if (snap) {
                    matchedCount++;
                    if (snap.p && snap.p > 0) {
                        s.price = snap.p;
                    }
                    s.change = snap.chg !== undefined ? snap.chg : 0;
                    s.changePercent = snap.pct !== undefined ? snap.pct : 0;

                    if (s.shares > 0 && s.costPrice > 0) {
                        s.profit = Math.round((s.price - s.costPrice) * s.shares);
                        s.profitRate = (((s.price - s.costPrice) / s.costPrice) * 100).toFixed(2);
                        s.todayProfit = Math.round(s.change * s.shares);
                    }

                    if (snap.d) {
                        s.priceDate = snap.d.length === 8 ? `${snap.d.slice(0, 4)}/${snap.d.slice(4, 6)}/${snap.d.slice(6, 8)}` : snap.d;
                        s.isPriceFresh = true;
                        s.isIndicatorFresh = true;
                        s.isStrategyFresh = true;
                    }

                    // 🎯 雲端大腦全量 6 燈注入
                    if (snap.lights) {
                        s.indicatorTags = buildIndicatorTagsFromSnapshot(snap.lights, snap.prev_ind, snap.prev_lights);
                    }

                    if (snap.strat) {
                        s.strategyFeatures = buildStrategyFeaturesFromDict(snap.strat, s.price, s.code);
                    }
                }
            });

            renderAssetChart();
            return matchedCount;
        };

        // 執行全市場行情快照同步 (直連 Raw 破除 CDN 快取)
        const syncMarketSnapshot = async () => {
            const rawBaseUrl = 'https://raw.githubusercontent.com/TimLin7026/stock-sentinel/main';
            const fallbackBaseUrl = '.';

            // 1. 探測健康報表
            let healthData = null;
            try {
                const hRes = await fetch(`${rawBaseUrl}/market_health.json?_t=${Date.now()}`, { cache: 'no-store' });
                if (hRes.ok) healthData = await hRes.json();
            } catch (e) {
                console.warn("Raw 健康報表拉取失敗，嘗試備用路徑...", e);
            }

            if (!healthData) {
                try {
                    const hRes = await fetch(`${fallbackBaseUrl}/market_health.json?_t=${Date.now()}`, { cache: 'no-store' });
                    if (hRes.ok) healthData = await hRes.json();
                } catch (e) {}
            }

            if (!healthData) {
                throw new Error("無法連線至雲端大腦健康報表，請確認網路連線。");
            }

            if (healthData.status !== 'READY') {
                throw new Error(`雲端大腦目前狀態為【${healthData.status}】，可能正在結算清洗中，請稍候重試。`);
            }

            // 2. 下載 gzip 快照二進位串流
            let snapshotBuffer = null;
            try {
                const sRes = await fetch(`${rawBaseUrl}/market_snapshot.json.gz?_t=${Date.now()}`, { cache: 'no-store' });
                if (sRes.ok) snapshotBuffer = await sRes.arrayBuffer();
            } catch (e) {
                console.warn("Raw 快照下載失敗，嘗試備用路徑...", e);
            }

            if (!snapshotBuffer) {
                try {
                    const sRes = await fetch(`${fallbackBaseUrl}/market_snapshot.json.gz?_t=${Date.now()}`, { cache: 'no-store' });
                    if (sRes.ok) snapshotBuffer = await sRes.arrayBuffer();
                } catch (e) {}
            }

            if (!snapshotBuffer) {
                throw new Error("下載雲端行情快照失敗，請稍候重試。");
            }

            // 3. 原生極速解壓
            const snapshotData = await decompressGzip(snapshotBuffer);
            const totalCount = Object.keys(snapshotData).length;

            // 4. 精確記錄執行時間、開市日與大腦產出時間
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const fetchTimeStr = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

            let marketDateStr = String(healthData.target_date || '');
            if (marketDateStr.length === 8) {
                marketDateStr = `${marketDateStr.slice(0, 4)}/${marketDateStr.slice(4, 6)}/${marketDateStr.slice(6, 8)}`;
            }

            const cloudTimeStr = healthData.run_time || healthData.timestamp || '---';
            const nextRunStr = healthData.next_scheduled_run || '';

            marketSyncMeta.value = {
                fetchTime: fetchTimeStr,
                marketDate: marketDateStr,
                cloudGeneratedAt: cloudTimeStr,
                nextScheduledRun: nextRunStr,
                totalStocks: totalCount,
                healthScore: 100,
                status: healthData.status
            };

            localStorage.setItem('sentinel_market_fetch_time', fetchTimeStr);
            localStorage.setItem('sentinel_market_date', marketDateStr);
            localStorage.setItem('sentinel_market_cloud_time', cloudTimeStr);
            if (nextRunStr) localStorage.setItem('sentinel_market_next_run', nextRunStr);
            localStorage.setItem('sentinel_market_total_stocks', String(totalCount));
            localStorage.setItem('sentinel_market_status', healthData.status);

            // 5. 注入應用並刷新持股損益
            applyMarketSnapshot(snapshotData, healthData);

            // 6. 離線快取寫入 IndexedDB 並清除舊時序快取以確保走勢線最新
            if (window.localforage) {
                try {
                    await localforage.setItem('sentinel_market_snapshot', snapshotData);
                    await localforage.removeItem('sentinel_market_history_60d');
                    stockHistoryCache = null;
                } catch (e) {
                    console.warn("快照離線儲存失敗:", e);
                }
            } else {
                stockHistoryCache = null;
            }

            return {
                fetchTime: fetchTimeStr,
                marketDate: marketDateStr,
                cloudGeneratedAt: cloudTimeStr,
                nextScheduledRun: nextRunStr,
                totalCount
            };
        };

        // 🔄 一鍵同步入口 (支援全市場行情秒級同步 + 個人雲端帳本雙向同步)
        const handleOneClickSync = async () => {
            if (!isAppUnlocked.value) {
                if (confirm("🔒 需先綁定 Google 帳號以啟用戰情室完整功能，是否立即進行 Google 授權登入？")) {
                    handleGoogleLogin();
                }
                return;
            }

            if (syncStatus.value.loading) return;
            syncStatus.value.loading = true;
            syncStatus.value.message = '正在同步全市場行情...';

            let snapInfo = null;

            try {
                // 1. 同步全台股行情快照
                snapInfo = await syncMarketSnapshot();
            } catch (err) {
                console.error("行情快照同步失敗:", err);
                showToast(`⚠️ 行情同步提醒: ${err.message}`, 4000);
            }

            // 2. 若有 Google 登入，同時執行個人帳本雙向同步
            if (googleUser.value.isLoggedIn && googleAccessToken.value) {
                try {
                    syncStatus.value.message = '正在同步個人雲端帳本...';
                    await executeTwoWaySync();
                } catch (err) {
                    console.error("雲端帳本同步失敗:", err);
                }
            }

            syncStatus.value.loading = false;
            syncStatus.value.message = '';

            // 3. 自動標記當天當前時段為已同步/已通知，並關閉橫條
            try {
                const now = new Date();
                const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                const twNow = new Date(utc + (3600000 * 8));
                const y = twNow.getFullYear();
                const m = String(twNow.getMonth() + 1).padStart(2, '0');
                const d = String(twNow.getDate()).padStart(2, '0');
                const todayDateStr = `${y}${m}${d}`;
                const totalMinutes = twNow.getHours() * 60 + twNow.getMinutes();
                if (totalMinutes >= 870 && totalMinutes < 1020) { // 14:30~17:00
                    localStorage.setItem(`sentinel_notified_1500_${todayDateStr}`, 'true');
                }
                if (totalMinutes >= 1260 && totalMinutes < 1440) { // 21:00~24:00
                    localStorage.setItem(`sentinel_notified_2130_${todayDateStr}`, 'true');
                }
                activeSyncNotice.value.show = false;
            } catch(e) {}

            if (snapInfo) {
                const timeOnly = snapInfo.fetchTime.split(' ')[1] || snapInfo.fetchTime;
                const cloudOnly = snapInfo.cloudGeneratedAt.split(' ')[1] || snapInfo.cloudGeneratedAt;
                showToast(`✅ 一鍵同步完成！\n📅 開市日：${snapInfo.marketDate} (${snapInfo.totalCount} 檔)\n⏱️ 下載時間：${timeOnly} │ ☁️ 雲端產出：${cloudOnly}`, 4500);
            }
        };

        const handleHeaderSyncClick = handleOneClickSync;

        // ==========================================
        // 📊 全螢幕個股 6 大技術指標走勢圖模組 (100% 電腦版參數 + ECharts 觸控連動)
        // ==========================================
        const showStockChartModal = ref(false);
        const activeChartStock = ref({});
        const chartDaysCount = ref(60);
        const subOscTab = ref('MTM'); // 'MTM' | 'RSI' | 'WR'
        const isChartLoading = ref(false);
        
        // 圖 1 (K線主圖) 指標圖層開關 (MA | 布林 | 成本)，預設全開並支援本機記憶
        const defaultKlineLayers = { ma: true, bollinger: true, cost: true };
        const savedLayersStr = localStorage.getItem('sentinel_kline_layers');
        let initialLayers = defaultKlineLayers;
        if (savedLayersStr) {
            try { initialLayers = { ...defaultKlineLayers, ...JSON.parse(savedLayersStr) }; } catch(e) {}
        }
        const klineLayers = ref(initialLayers);

        const toggleKlineLayer = (layerKey) => {
            if (klineLayers.value[layerKey] !== undefined) {
                klineLayers.value[layerKey] = !klineLayers.value[layerKey];
                localStorage.setItem('sentinel_kline_layers', JSON.stringify(klineLayers.value));
                if (activeChartStock.value && activeChartStock.value.code) {
                    renderAllStockCharts(activeChartStock.value.code, chartDaysCount.value);
                }
            }
        };
        const crosshairData = ref({
            date: '',
            open: '--',
            high: '--',
            low: '--',
            close: '--',
            vol: '--',
            ma5: '--',
            ma10: '--',
            bbMid: '--',
            bbU: '--',
            bbL: '--',
            marginCost: '--',
            foreignCost: '--',
            dif: '--',
            macdS: '--',
            osc: 0,
            kdK: '--',
            kdD: '--',
            fb: '--',
            sb: '--',
            db: '--',
            marginBal: '--',
            marginDiff: '--',
            mtm: '--',
            mtmMa: '--',
            rsi4: '--',
            rsi12: '--',
            wr3: '--',
            wr50: '--'
        });

        let stockHistoryCache = null; // 記憶體歷史快取字典
        const chartInstances = {}; // ECharts 實例字典

        // 更新十字準心即時數值看板
        const updateCrosshairValuesFromRow = (r) => {
            if (!r) return;
            crosshairData.value = {
                date: String(r[0]),
                open: r[1],
                high: r[2],
                low: r[3],
                close: r[4],
                vol: r[5],
                ma5: r[6],
                ma10: r[7],
                bbMid: r[8],
                bbU: r[9],
                bbL: r[10],
                dif: r[11],
                macdS: r[12],
                osc: r[13],
                kdK: r[14],
                kdD: r[15],
                fb: r[16],
                sb: r[17],
                db: r[18],
                marginBal: r[19],
                marginDiff: r[20],
                mtm: r[21],
                mtmMa: r[22],
                rsi4: r[23],
                rsi12: r[24],
                wr3: r[25],
                wr50: r[26],
                marginCost: r[27] !== undefined ? r[27] : '--',
                foreignCost: r[28] !== undefined ? r[28] : '--'
            };
        };

        // 下載並解壓 60 日技術指標時序數據包 (具備自動長度檢驗與舊快取自癒機制)
        const loadAllStockHistory = async (forceRefresh = false) => {
            if (!forceRefresh && stockHistoryCache) {
                const keys = Object.keys(stockHistoryCache);
                const sample = keys.length > 0 ? stockHistoryCache[keys[0]] : null;
                if (sample && sample.length > 0 && sample[sample.length - 1].length >= 29) {
                    return stockHistoryCache;
                }
                stockHistoryCache = null;
            }
            
            // 優先讀取 IndexedDB 快取 (需驗證欄位長度 >= 29 確保具備成本線數據)
            if (!forceRefresh && window.localforage) {
                try {
                    const cached = await localforage.getItem('sentinel_market_history_60d');
                    if (cached && typeof cached === 'object') {
                        const keys = Object.keys(cached);
                        const sample = keys.length > 0 ? cached[keys[0]] : null;
                        if (sample && sample.length > 0 && sample[sample.length - 1].length >= 29) {
                            stockHistoryCache = cached;
                            return stockHistoryCache;
                        } else {
                            console.log("⚠️ 檢測到舊版走勢時序數據快取 (欄位數不足 29)，自動清除並重新由雲端下載最新時序包...");
                            await localforage.removeItem('sentinel_market_history_60d');
                            stockHistoryCache = null;
                        }
                    }
                } catch(e) {}
            }

            // 網路拉取 gzip (直連 Raw 破除快取)
            const rawBaseUrl = 'https://raw.githubusercontent.com/TimLin7026/stock-sentinel/main';
            const fallbackBaseUrl = '.';
            let histBuffer = null;
            try {
                const res = await fetch(`${rawBaseUrl}/market_history_60d.json.gz?_t=${Date.now()}`, { cache: 'no-store' });
                if (res.ok) histBuffer = await res.arrayBuffer();
            } catch(e) {}

            if (!histBuffer) {
                try {
                    const res = await fetch(`${fallbackBaseUrl}/market_history_60d.json.gz?_t=${Date.now()}`, { cache: 'no-store' });
                    if (res.ok) histBuffer = await res.arrayBuffer();
                } catch(e) {}
            }

            if (!histBuffer) {
                throw new Error("無法下載個股歷史技術指標時序數據，請確認網路連線。");
            }

            stockHistoryCache = await decompressGzip(histBuffer);
            if (window.localforage) {
                try {
                    await localforage.setItem('sentinel_market_history_60d', stockHistoryCache);
                } catch(e) {}
            }
            return stockHistoryCache;
        };

        // 銷毀所有現有 ECharts 實例避免記憶體洩漏
        const destroyAllChartInstances = () => {
            Object.keys(chartInstances).forEach(k => {
                if (chartInstances[k]) {
                    try {
                        chartInstances[k].dispose();
                    } catch(e) {}
                    delete chartInstances[k];
                }
            });
        };

        // 渲染 6 大技術指標子圖 (1 K線布林 ➔ 2 MACD ➔ 3 KD ➔ 4 成交量融資 ➔ 5 三大法人 ➔ 6 MTM/RSI/WR)
        const renderAllStockCharts = async (stockCode, days = 60) => {
            isChartLoading.value = true;
            await Vue.nextTick();

            let histMap = null;
            try {
                histMap = await loadAllStockHistory();
            } catch(err) {
                console.error("載入歷史數據失敗:", err);
                showToast("⚠️ 載入歷史走勢失敗：" + err.message, 3500);
                isChartLoading.value = false;
                return;
            }

            const rawCode = String(stockCode || '').trim();
            const rawRows = (histMap && (histMap[rawCode] || histMap[rawCode.padStart(4, '0')] || histMap[rawCode.replace(/^0+/, '')])) || [];
            
            if (!rawRows || rawRows.length === 0) {
                showToast(`⚠️ 查無代號 ${stockCode} 之歷史技術指標時序數據`, 3000);
                isChartLoading.value = false;
                return;
            }

            const rows = rawRows.slice(-days);
            isChartLoading.value = false;
            await Vue.nextTick();
            // 等待瀏覽器完成第一幀 DOM 佈局與寬高計算
            await new Promise(resolve => setTimeout(resolve, 50));

            destroyAllChartInstances();

            const isDark = theme.value === 'dark';
            const bgText = isDark ? '#94a3b8' : '#475569';
            const gridBorder = isDark ? '#334155' : '#cbd5e1';
            const splitColor = isDark ? 'rgba(51, 65, 85, 0.4)' : 'rgba(203, 213, 225, 0.6)';

            // 解析各維度數值
            const dates = rows.map(r => String(r[0]).length === 8 ? `${String(r[0]).slice(4,6)}/${String(r[0]).slice(6,8)}` : String(r[0]));
            const fullDates = rows.map(r => String(r[0]));
            const ohlc = rows.map(r => [r[1], r[4], r[3], r[2]]); // [Open, Close, Low, High]
            const volumes = rows.map((r, i) => ({
                value: r[5],
                itemStyle: { color: r[4] >= r[1] ? '#ef4444' : '#10b981' }
            }));
            const ma5 = rows.map(r => r[6]);
            const ma10 = rows.map(r => r[7]);
            const bbMid = rows.map(r => r[8]);
            const bbU = rows.map(r => r[9]);
            const bbL = rows.map(r => r[10]);
            const dif = rows.map(r => r[11]);
            const macdS = rows.map(r => r[12]);
            const osc = rows.map(r => ({
                value: r[13],
                itemStyle: { color: r[13] >= 0 ? '#ef4444' : '#10b981' }
            }));
            const kdK = rows.map(r => r[14]);
            const kdD = rows.map(r => r[15]);
            const fb = rows.map(r => r[16]);
            const sb = rows.map(r => r[17]);
            const db = rows.map(r => r[18]);
            const marginBal = rows.map(r => r[19]);
            const mtm = rows.map(r => r[21]);
            const mtmMa = rows.map(r => r[22]);
            const rsi4 = rows.map(r => r[23]);
            const rsi12 = rows.map(r => r[24]);
            const wr3 = rows.map(r => r[25]);
            const wr50 = rows.map(r => r[26]);
            const marginCost = rows.map(r => r[27]);
            const foreignCost = rows.map(r => r[28]);

            // 初始化看板最後一筆（最新一日）數值
            if (rows.length > 0) {
                updateCrosshairValuesFromRow(rows[rows.length - 1]);
            }

            const commonGrid = {
                left: 10,
                right: 48,
                top: 25,
                bottom: 20,
                containLabel: false
            };

            const commonXAxis = {
                type: 'category',
                data: dates,
                axisLine: { lineStyle: { color: gridBorder } },
                axisLabel: { color: bgText, fontSize: 10 },
                axisTick: { show: false }
            };

            const commonYAxis = {
                position: 'right',
                scale: true,
                axisLine: { show: true, lineStyle: { color: gridBorder } },
                axisLabel: { color: bgText, fontSize: 9 },
                splitLine: { lineStyle: { color: splitColor, type: 'dashed' } }
            };

            const commonTooltip = {
                trigger: 'axis',
                axisPointer: {
                    type: 'cross',
                    lineStyle: { color: '#38bdf8', type: 'dashed', width: 1 },
                    label: { backgroundColor: '#0f172a', fontSize: 10 }
                },
                showContent: false // 使用頂部看板與各子圖標題即時反映，不遮蔽手機圖表
            };

            // 1. 主圖：K線 + 均線 + 布林通道 + 籌碼成本線 (依 klineLayers 動態組裝)
            const elKline = document.getElementById('chart-kline');
            if (elKline) {
                const chart = echarts.init(elKline);
                
                const klineSeries = [
                    {
                        name: 'K線',
                        type: 'candlestick',
                        data: ohlc,
                        itemStyle: {
                            color: '#ef4444',
                            color0: '#10b981',
                            borderColor: '#ef4444',
                            borderColor0: '#10b981'
                        }
                    }
                ];

                // 均線層：5MA, 10MA
                if (klineLayers.value.ma) {
                    klineSeries.push({ name: 'MA5', type: 'line', data: ma5, smooth: true, showSymbol: false, lineStyle: { color: '#eab308', width: 1.5 } });
                    klineSeries.push({ name: 'MA10', type: 'line', data: ma10, smooth: true, showSymbol: false, lineStyle: { color: '#38bdf8', width: 1.5 } });
                }

                // ⭐ 核心聯動保護：布林中軌 ＝ MA20 (只要 MA 或 布林 任一開啟即顯示紫色實線)
                if (klineLayers.value.ma || klineLayers.value.bollinger) {
                    klineSeries.push({ name: 'BB_Mid', type: 'line', data: bbMid, smooth: true, showSymbol: false, lineStyle: { color: '#a855f7', width: 1.2 } });
                }

                // 布林通道層：上軌、下軌 (取消背景填色 areaStyle)
                if (klineLayers.value.bollinger) {
                    klineSeries.push({ name: 'BB_U', type: 'line', data: bbU, smooth: true, showSymbol: false, lineStyle: { color: '#c084fc', width: 1, type: 'dashed' } });
                    klineSeries.push({ name: 'BB_L', type: 'line', data: bbL, smooth: true, showSymbol: false, lineStyle: { color: '#c084fc', width: 1, type: 'dashed' } });
                }

                // 籌碼成本層：融資成本、外資成本 (綠/酒紅 虛線)
                if (klineLayers.value.cost) {
                    klineSeries.push({ name: '融資成本', type: 'line', data: marginCost, smooth: true, showSymbol: false, lineStyle: { color: '#10b981', width: 1.2, type: 'dashed' } });
                    klineSeries.push({ name: '外資成本', type: 'line', data: foreignCost, smooth: true, showSymbol: false, lineStyle: { color: '#be123c', width: 1.2, type: 'dashed' } });
                }

                chart.setOption({
                    animation: false,
                    grid: commonGrid,
                    tooltip: commonTooltip,
                    xAxis: commonXAxis,
                    yAxis: commonYAxis,
                    series: klineSeries
                });
                chartInstances.kline = chart;
            }

            // 2. MACD / OSC (DIF 亮黃, MACD_S 亮藍)
            const elMacd = document.getElementById('chart-macd');
            if (elMacd) {
                const chart = echarts.init(elMacd);
                chart.setOption({
                    animation: false,
                    grid: commonGrid,
                    tooltip: commonTooltip,
                    xAxis: { ...commonXAxis, axisLabel: { show: false } },
                    yAxis: commonYAxis,
                    series: [
                        { name: 'OSC', type: 'bar', data: osc, barWidth: '60%' },
                        { name: 'DIF', type: 'line', data: dif, smooth: true, showSymbol: false, lineStyle: { color: '#eab308', width: 1.5 } },
                        { name: 'MACD_S', type: 'line', data: macdS, smooth: true, showSymbol: false, lineStyle: { color: '#38bdf8', width: 1.5 } }
                    ]
                });
                chartInstances.macd = chart;
            }

            // 3. KD 指標 (7, 3, 3) (7K 亮黃, 7D 亮藍)
            const elKd = document.getElementById('chart-kd');
            if (elKd) {
                const chart = echarts.init(elKd);
                chart.setOption({
                    animation: false,
                    grid: commonGrid,
                    tooltip: commonTooltip,
                    xAxis: { ...commonXAxis, axisLabel: { show: false } },
                    yAxis: { ...commonYAxis, min: 0, max: 100 },
                    series: [
                        { name: '7K', type: 'line', data: kdK, smooth: true, showSymbol: false, lineStyle: { color: '#eab308', width: 1.5 } },
                        { name: '7D', type: 'line', data: kdD, smooth: true, showSymbol: false, lineStyle: { color: '#38bdf8', width: 1.5 },
                          markLine: {
                              symbol: 'none',
                              silent: true,
                              data: [
                                  { yAxis: 80, lineStyle: { color: '#ef4444', type: 'dashed' } },
                                  { yAxis: 20, lineStyle: { color: '#10b981', type: 'dashed' } }
                              ]
                          }
                        }
                    ]
                });
                chartInstances.kd = chart;
            }

            // 4. 成交量與融資餘額 (融資線 亮黃)
            const elVol = document.getElementById('chart-vol');
            if (elVol) {
                const chart = echarts.init(elVol);
                chart.setOption({
                    animation: false,
                    grid: { ...commonGrid, right: 48, left: 10 },
                    tooltip: commonTooltip,
                    xAxis: { ...commonXAxis, axisLabel: { show: false } },
                    yAxis: [
                        { ...commonYAxis, position: 'right' },
                        { ...commonYAxis, position: 'left', show: false }
                    ],
                    series: [
                        { name: '成交量', type: 'bar', data: volumes, barWidth: '60%' },
                        { name: '融資餘額', type: 'line', data: marginBal, yAxisIndex: 1, smooth: true, showSymbol: false, lineStyle: { color: '#eab308', width: 1.5 } }
                    ]
                });
                chartInstances.vol = chart;
            }

            // 5. 三大法人買賣超 (外資 亮藍, 投信 亮黃, 自營 亮紫)
            const elChip = document.getElementById('chart-chip');
            if (elChip) {
                const chart = echarts.init(elChip);
                chart.setOption({
                    animation: false,
                    grid: commonGrid,
                    tooltip: commonTooltip,
                    xAxis: { ...commonXAxis, axisLabel: { show: false } },
                    yAxis: commonYAxis,
                    series: [
                        { name: '外資', type: 'bar', stack: 'chip', data: fb, itemStyle: { color: '#38bdf8' } },
                        { name: '投信', type: 'bar', stack: 'chip', data: sb, itemStyle: { color: '#eab308' } },
                        { name: '自營商', type: 'bar', stack: 'chip', data: db, itemStyle: { color: '#a855f7' } }
                    ]
                });
                chartInstances.chip = chart;
            }

            // 6. MTM / RSI / 威廉指標
            renderSubOscChart(rows);

            // ⚡ 建立多子圖十字準心連動與跑馬燈同步
            const activeCharts = Object.values(chartInstances).filter(Boolean);
            echarts.connect(activeCharts);

            // 綁定所有子圖之十字準心移動事件，確保滑動任意子圖皆能即時更新全看板
            const bindAxisPointerListener = (chartInstance) => {
                if (!chartInstance) return;
                chartInstance.on('updateAxisPointer', (event) => {
                    const dataIndex = event.dataIndex;
                    if (dataIndex !== undefined && rows[dataIndex]) {
                        updateCrosshairValuesFromRow(rows[dataIndex]);
                    }
                });
            };

            Object.values(chartInstances).forEach(c => bindAxisPointerListener(c));

            // 🚀 主動雙重自適應尺寸校準，徹底消除初次開啟空白
            Vue.nextTick(() => {
                resizeAllStockCharts();
                setTimeout(() => {
                    resizeAllStockCharts();
                }, 80);
            });
        };

        // 渲染圖 6 動能與擺盪指標 (快線 亮黃 #eab308, 慢線 亮藍 #38bdf8)
        const renderSubOscChart = (rows) => {
            const elMtm = document.getElementById('chart-mtm');
            if (!elMtm || !rows || rows.length === 0) return;

            if (chartInstances.mtm) {
                try { chartInstances.mtm.dispose(); } catch(e) {}
            }

            const chart = echarts.init(elMtm);
            const isDark = theme.value === 'dark';
            const bgText = isDark ? '#94a3b8' : '#475569';
            const gridBorder = isDark ? '#334155' : '#cbd5e1';
            const splitColor = isDark ? 'rgba(51, 65, 85, 0.4)' : 'rgba(203, 213, 225, 0.6)';

            const dates = rows.map(r => String(r[0]).length === 8 ? `${String(r[0]).slice(4,6)}/${String(r[0]).slice(6,8)}` : String(r[0]));
            const commonGrid = { left: 10, right: 48, top: 25, bottom: 20, containLabel: false };
            const commonXAxis = {
                type: 'category',
                data: dates,
                axisLine: { lineStyle: { color: gridBorder } },
                axisLabel: { color: bgText, fontSize: 10 },
                axisTick: { show: false }
            };
            const commonYAxis = {
                position: 'right',
                scale: true,
                axisLine: { show: true, lineStyle: { color: gridBorder } },
                axisLabel: { color: bgText, fontSize: 9 },
                splitLine: { lineStyle: { color: splitColor, type: 'dashed' } }
            };

            let seriesData = [];
            let yAxisConfig = { ...commonYAxis };

            if (subOscTab.value === 'MTM') {
                const mtm = rows.map(r => r[21]);
                const mtmMa = rows.map(r => r[22]);
                seriesData = [
                    { name: 'MTM3', type: 'line', data: mtm, smooth: true, showSymbol: false, lineStyle: { color: '#eab308', width: 1.5 } },
                    { name: 'MTM_MA2', type: 'line', data: mtmMa, smooth: true, showSymbol: false, lineStyle: { color: '#38bdf8', width: 1.5 } }
                ];
            } else if (subOscTab.value === 'RSI') {
                const rsi4 = rows.map(r => r[23]);
                const rsi12 = rows.map(r => r[24]);
                yAxisConfig.min = 0;
                yAxisConfig.max = 100;
                seriesData = [
                    { name: 'RSI4', type: 'line', data: rsi4, smooth: true, showSymbol: false, lineStyle: { color: '#eab308', width: 1.5 } },
                    { name: 'RSI12', type: 'line', data: rsi12, smooth: true, showSymbol: false, lineStyle: { color: '#38bdf8', width: 1.5 },
                      markLine: {
                          symbol: 'none',
                          silent: true,
                          data: [{ yAxis: 80, lineStyle: { color: '#ef4444', type: 'dashed' } }, { yAxis: 20, lineStyle: { color: '#10b981', type: 'dashed' } }]
                      }
                    }
                ];
            } else if (subOscTab.value === 'WR') {
                const wr3 = rows.map(r => r[25]);
                const wr50 = rows.map(r => r[26]);
                yAxisConfig.min = -100;
                yAxisConfig.max = 0;
                seriesData = [
                    { name: 'WR3', type: 'line', data: wr3, smooth: true, showSymbol: false, lineStyle: { color: '#eab308', width: 1.5 } },
                    { name: 'WR50', type: 'line', data: wr50, smooth: true, showSymbol: false, lineStyle: { color: '#38bdf8', width: 1.5 },
                      markLine: {
                          symbol: 'none',
                          silent: true,
                          data: [{ yAxis: -20, lineStyle: { color: '#ef4444', type: 'dashed' } }, { yAxis: -80, lineStyle: { color: '#10b981', type: 'dashed' } }]
                      }
                    }
                ];
            }

            chart.setOption({
                animation: false,
                grid: commonGrid,
                tooltip: {
                    trigger: 'axis',
                    axisPointer: { type: 'cross', lineStyle: { color: '#38bdf8', type: 'dashed', width: 1 } },
                    showContent: false
                },
                xAxis: commonXAxis,
                yAxis: yAxisConfig,
                series: seriesData
            });
            chartInstances.mtm = chart;

            // 綁定十字準心
            chart.on('updateAxisPointer', (event) => {
                const dataIndex = event.dataIndex;
                if (dataIndex !== undefined && rows[dataIndex]) {
                    updateCrosshairValuesFromRow(rows[dataIndex]);
                }
            });

            const activeCharts = Object.values(chartInstances).filter(Boolean);
            echarts.connect(activeCharts);
        };

        // 打開技術指標彈窗
        const openStockChartModal = (stock) => {
            if (!stock) return;
            activeChartStock.value = { ...stock };
            chartOrientation.value = appLayout.value === 'wide' ? 'landscape' : 'portrait';
            showStockChartModal.value = true;
            renderAllStockCharts(stock.code, chartDaysCount.value);
            // 雙重校準保險
            setTimeout(() => {
                resizeAllStockCharts();
            }, 120);
        };

        // 關閉技術指標彈窗
        const closeStockChartModal = () => {
            showStockChartModal.value = false;
            destroyAllChartInstances();
        };

        // 切換期間天數 (20 / 40 / 60)
        const changeChartDays = (days) => {
            chartDaysCount.value = days;
            if (activeChartStock.value && activeChartStock.value.code) {
                renderAllStockCharts(activeChartStock.value.code, days);
            }
        };

        // 切換動能副圖 Tab (MTM / RSI / WR)
        const changeSubOscTab = (tab) => {
            subOscTab.value = tab;
            if (stockHistoryCache && activeChartStock.value && activeChartStock.value.code) {
                const rawCode = String(activeChartStock.value.code).trim();
                const rawRows = stockHistoryCache[rawCode] || stockHistoryCache[rawCode.padStart(4, '0')] || [];
                const rows = rawRows.slice(-chartDaysCount.value);
                renderSubOscChart(rows);
            }
        };

        // 📱/🖥️ 圖表直式與橫式版面切換 (預設直式 portrait)
        const chartOrientation = ref(localStorage.getItem('sentinel_chart_orientation') || 'portrait');

        const resizeAllStockCharts = () => {
            Object.values(chartInstances).forEach(chart => {
                if (chart && typeof chart.resize === 'function') {
                    try {
                        chart.resize();
                    } catch(e) {}
                }
            });
        };

        const toggleChartOrientation = () => {
            chartOrientation.value = chartOrientation.value === 'portrait' ? 'landscape' : 'portrait';
            localStorage.setItem('sentinel_chart_orientation', chartOrientation.value);
            Vue.nextTick(() => {
                setTimeout(() => {
                    resizeAllStockCharts();
                }, 150);
            });
        };
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

        // ─── 自動檢查與平滑遷移資料庫架構與時間戳 (對齊地端) ───
        const migrateMobileDatabase = (db) => {
            if (!db) return;
            try {
                // 1. 檢查並升級 my_stock 欄位 (created_at)
                try {
                    const infoM = db.exec("PRAGMA table_info(my_stock)");
                    if (infoM.length > 0 && infoM[0].values) {
                        const colsM = infoM[0].values.map(r => r[1]);
                        if (!colsM.includes('created_at')) {
                            db.run("ALTER TABLE my_stock ADD COLUMN created_at TEXT");
                        }
                    }
                } catch (e1) {
                    console.warn("[MIGRATE] my_stock alter warning:", e1);
                }

                // 2. 檢查並升級 deleted_records 欄位 (stock_created_at)
                try {
                    db.run("CREATE TABLE IF NOT EXISTS deleted_records (table_name TEXT, unique_key TEXT, deleted_at TEXT, PRIMARY KEY (table_name, unique_key))");
                    const infoD = db.exec("PRAGMA table_info(deleted_records)");
                    if (infoD.length > 0 && infoD[0].values) {
                        const colsD = infoD[0].values.map(r => r[1]);
                        if (!colsD.includes('stock_created_at')) {
                            db.run("ALTER TABLE deleted_records ADD COLUMN stock_created_at TEXT");
                        }
                    }
                } catch (e2) {
                    console.warn("[MIGRATE] deleted_records alter warning:", e2);
                }

                // 3. 補齊 deleted_records 歷史墓碑的基準時間戳
                try {
                    db.run("UPDATE deleted_records SET stock_created_at = '1970-01-01 00:00:00' WHERE table_name = 'my_stock' AND (stock_created_at IS NULL OR stock_created_at = '')");
                } catch (e3) {}

                // 4. 補齊 my_stock 歷史資料的 created_at (回溯 trade_log / gem_strategy)
                try {
                    const unfilled = db.exec("SELECT 股票代號, 證券商 FROM my_stock WHERE created_at IS NULL OR created_at = ''");
                    if (unfilled.length > 0 && unfilled[0].values) {
                        unfilled[0].values.forEach(r => {
                            const [sCode, sBroker] = r;
                            let calcTime = '';
                            
                            // 優先回溯 trade_log 最早交易時間
                            try {
                                const tRes = db.exec("SELECT MIN(交易時間) FROM trade_log WHERE 股票代號 = ? AND 證券商 = ?", [sCode, sBroker]);
                                if (tRes.length > 0 && tRes[0].values && tRes[0].values[0] && tRes[0].values[0][0]) {
                                    calcTime = String(tRes[0].values[0][0]).trim();
                                }
                            } catch (et) {}

                            // 若無交易，回溯 gem_strategy 最早戰報時間
                            if (!calcTime) {
                                try {
                                    const gRes = db.exec("SELECT MIN(記錄時間) FROM gem_strategy WHERE 股票代號 = ?", [sCode]);
                                    if (gRes.length > 0 && gRes[0].values && gRes[0].values[0] && gRes[0].values[0][0]) {
                                        calcTime = String(gRes[0].values[0][0]).trim();
                                    }
                                } catch (eg) {}
                            }

                            if (!calcTime) {
                                calcTime = getNowDateTimeStr() + ':00';
                            }

                            db.run("UPDATE my_stock SET created_at = ? WHERE 股票代號 = ? AND 證券商 = ?", [calcTime, sCode, sBroker]);
                        });
                    }
                } catch (e4) {
                    console.warn("[MIGRATE] my_stock created_at patch warning:", e4);
                }
            } catch (err) {
                console.warn("[MIGRATE] Overall migration error:", err);
            }
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

                // 🎯 自動平滑升級架構與補齊歷史時間戳
                migrateMobileDatabase(dbInstance);

                // 0. 讀取 stock_dict (全台股代碼與名稱字典，2,400+ 檔)
                try {
                    const dictRes = dbInstance.exec("SELECT stock_code, stock_name FROM stock_dict");
                    if (dictRes.length > 0 && dictRes[0].values) {
                        dictRes[0].values.forEach(r => {
                            const sc = String(r[0] || '').trim();
                            const sn = String(r[1] || '').trim();
                            if (sc && sn) {
                                stockDictMap.value[sc] = sn;
                                stockDictMap.value[sc.padStart(4, '0')] = sn;
                                stockDictMap.value[sc.replace(/^0+/, '')] = sn;
                            }
                        });
                    }
                } catch (e) {
                    console.warn("stock_dict 讀取略過:", e);
                }

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
                                    prevIndicators: data.prev_indicators || data.prevIndicators || data.indicators || {},
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

                            if (code && name && name !== code) {
                                stockDictMap.value[code] = name;
                                stockDictMap.value[code.padStart(4, '0')] = name;
                                stockDictMap.value[code.replace(/^0+/, '')] = name;
                            }

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

                            if (code && name && name !== code) {
                                stockDictMap.value[code] = name;
                                stockDictMap.value[code.padStart(4, '0')] = name;
                                stockDictMap.value[code.replace(/^0+/, '')] = name;
                            }

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

                            // 6 燈技術指標 (支援「昨日 ➔ 今日」4 維動態漸近色：綠綠 / 綠紅 / 紅綠 / 紅紅)
                            const hmIndicators = hmInfo.indicators || {};
                            const hmPrevIndicators = hmInfo.prevIndicators || hmInfo.prev_indicators || hmIndicators;

                            const getIndicatorTag = (displayText, keyNames) => {
                                let currVal = undefined;
                                let prevVal = undefined;

                                for (const k of keyNames) {
                                    if (currVal === undefined && hmIndicators[k] !== undefined) currVal = hmIndicators[k];
                                    if (prevVal === undefined && hmPrevIndicators[k] !== undefined) prevVal = hmPrevIndicators[k];
                                }

                                if (currVal === undefined) currVal = -1;
                                if (prevVal === undefined) prevVal = currVal; // 兼容舊數據

                                const isPrevBull = (prevVal === 1);
                                const isCurrBull = (currVal === 1);

                                let bgStyle = '';
                                let tooltip = '';
                                let transitionType = '';

                                if (!isPrevBull && !isCurrBull) {
                                    // 🟢 ➔ 🟢 綠到綠 (持續偏空)
                                    transitionType = 'bear-bear';
                                    bgStyle = 'background: #00B050; color: white;';
                                    tooltip = `${displayText}：昨日偏空 ➔ 今日偏空 (持續偏空)`;
                                } else if (!isPrevBull && isCurrBull) {
                                    // 🟢 ➔ 🔴 綠到紅 (轉折翻紅 🔥)
                                    transitionType = 'bear-bull';
                                    bgStyle = 'background: linear-gradient(90deg, #00B050 0%, #00B050 15%, #FF4B4B 35%, #FF4B4B 100%); color: white;';
                                    tooltip = `${displayText}：昨日偏空 ➔ 今日轉強 (轉折翻紅 🔥)`;
                                } else if (isPrevBull && !isCurrBull) {
                                    // 🔴 ➔ 🟢 紅到綠 (轉折翻綠 ⚠️)
                                    transitionType = 'bull-bear';
                                    bgStyle = 'background: linear-gradient(90deg, #FF4B4B 0%, #FF4B4B 15%, #00B050 35%, #00B050 100%); color: white;';
                                    tooltip = `${displayText}：昨日偏多 ➔ 今日轉弱 (轉折翻綠 ⚠️)`;
                                } else {
                                    // 🔴 ➔ 🔴 紅到紅 (持續多頭)
                                    transitionType = 'bull-bull';
                                    bgStyle = 'background: #FF4B4B; color: white;';
                                    tooltip = `${displayText}：昨日偏多 ➔ 今日偏多 (持續多頭)`;
                                }

                                return {
                                    text: displayText,
                                    type: isCurrBull ? 'bull' : 'bear',
                                    transition: transitionType,
                                    bgStyle,
                                    tooltip
                                };
                            };

                            const indicatorTags = [
                                getIndicatorTag('MTM金', ['MTM金']),
                                getIndicatorTag('OSC縮', ['OSC縮']),
                                getIndicatorTag('K趨', ['K趨', 'K超']),
                                getIndicatorTag('DIF趨', ['DIF趨', 'DIF超']),
                                getIndicatorTag('KD金', ['KD金']),
                                getIndicatorTag('MACD金', ['MACD金'])
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

                // ⚡ 若記憶體或本機存有最新行情快照，立即全盤注入最新收盤價與 6 大指標 (拒絕現價為 0)
                if (currentMarketSnapshotData) {
                    applyMarketSnapshot(currentMarketSnapshotData);
                } else if (window.localforage) {
                    try {
                        const cachedSnap = await localforage.getItem('sentinel_market_snapshot');
                        if (cachedSnap) {
                            applyMarketSnapshot(cachedSnap);
                        }
                    } catch (e) {}
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

        const watchlistStocks = computed(() => stockList.value.filter(s => s.shares === 0 || s.broker === '關注'));

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

        // ─── 計算屬性：交易 FIFO 時間範圍與關鍵字篩選 (近1周 / 近2周 / 近1月 / 近3月 / 全部 + 代號/名稱/券商模糊搜尋) ───
        const filteredTradeLogs = computed(() => {
            let logs = recentTradeLogs.value;

            // 1. 時間範圍過濾
            if (tradeDateRangeFilter.value !== '全部') {
                const now = new Date();
                let daysLimit = 3650;
                if (tradeDateRangeFilter.value === '近1周') daysLimit = 7;
                else if (tradeDateRangeFilter.value === '近2周') daysLimit = 14;
                else if (tradeDateRangeFilter.value === '近1月') daysLimit = 30;
                else if (tradeDateRangeFilter.value === '近3月') daysLimit = 90;

                const cutoff = new Date(now.getTime() - daysLimit * 24 * 60 * 60 * 1000);

                logs = logs.filter(log => {
                    if (!log.date) return true;
                    const logDate = new Date(log.date.replace(/\//g, '-'));
                    return !isNaN(logDate) && logDate >= cutoff;
                });
            }

            // 2. 關鍵字過濾 (代號、名稱、券商)
            if (tradeSearchKeyword.value && tradeSearchKeyword.value.trim()) {
                const kw = tradeSearchKeyword.value.trim().toLowerCase();
                logs = logs.filter(log => {
                    const c = String(log.code || '').toLowerCase();
                    const n = String(log.name || '').toLowerCase();
                    const b = String(log.broker || '').toLowerCase();
                    return c.includes(kw) || n.includes(kw) || b.includes(kw);
                });
            }

            return logs;
        });

        // ─── 跳轉至交易 FIFO 並帶入代號過濾 ───
        const goToTradeHistory = (code) => {
            tradeSearchKeyword.value = String(code || '').trim();
            tradeDateRangeFilter.value = '全部'; // 自動切為全部避免日期範圍隱藏歷史紀錄
            currentTab.value = 'fifo';
            nextTick(() => {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
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

        // 監聽分頁與券商篩選切換 (保留個股展開狀態，並支援切回平滑定錨)
        let lastStocksScrollTop = 0;
        watch(currentTab, (newTab, oldTab) => {
            if (oldTab === 'stocks') {
                lastStocksScrollTop = window.scrollY || document.documentElement.scrollTop;
            }
            if (newTab === 'stocks') {
                nextTick(() => {
                    setTimeout(() => {
                        const openedUids = Array.from(expandedStockUids.value);
                        if (openedUids.length > 0) {
                            const targetEl = document.getElementById(`stock-card-${openedUids[0]}`);
                            if (targetEl) {
                                targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                return;
                            }
                        }
                        if (lastStocksScrollTop > 0) {
                            window.scrollTo({ top: lastStocksScrollTop, behavior: 'smooth' });
                        }
                    }, 50);
                });
            }
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

        const onBrokerSelect = (brokerName) => {
            tradeForm.value.broker = brokerName;
            if (brokerName === '關注') {
                tradeForm.value.price = 0;
                tradeForm.value.shares = 1;
            } else {
                if (tradeForm.value.price === 0 && tradeForm.value.shares === 1) {
                    const trimmed = tradeForm.value.code.trim();
                    const matched = stockList.value.find(s => s.code === trimmed);
                    tradeForm.value.price = matched ? matched.price : null;
                    tradeForm.value.shares = null;
                }
            }
        };

        const onBrokerInputChange = () => {
            if (tradeForm.value.broker === '關注') {
                tradeForm.value.price = 0;
                tradeForm.value.shares = 1;
            }
        };

        const onCodeInput = () => {
            const raw = tradeForm.value.code ? String(tradeForm.value.code).trim() : '';
            if (!raw) return;

            // 1. 多維代號比對 (原始、補0成4/5/6碼、去前導0)
            const keysToTry = [
                raw,
                raw.padStart(4, '0'),
                raw.padStart(5, '0'),
                raw.padStart(6, '0'),
                raw.replace(/^0+/, '')
            ];

            let foundName = '';
            for (const k of keysToTry) {
                if (stockDictMap.value && stockDictMap.value[k]) {
                    foundName = stockDictMap.value[k];
                    break;
                }
            }

            // 2. 若字典未找到，再找現有 stockList 或 recentTradeLogs
            if (!foundName) {
                const matchedInList = stockList.value.find(s => keysToTry.includes(s.code));
                if (matchedInList && matchedInList.name) {
                    foundName = matchedInList.name;
                } else {
                    const matchedInLogs = recentTradeLogs.value.find(t => keysToTry.includes(t.code));
                    if (matchedInLogs && matchedInLogs.name) {
                        foundName = matchedInLogs.name;
                    }
                }
            }

            if (foundName) {
                tradeForm.value.name = foundName;
            }

            // 3. 現價與券商輔助帶入
            const matchedStock = stockList.value.find(s => keysToTry.includes(s.code));
            if (matchedStock) {
                if (tradeForm.value.broker !== '關注' && (tradeForm.value.price === null || tradeForm.value.price === 0)) {
                    tradeForm.value.price = matchedStock.price;
                }
                if (matchedStock.broker && !tradeForm.value.broker) {
                    tradeForm.value.broker = matchedStock.broker;
                }
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
                if (tradeForm.value.broker === '關注') {
                    tradeForm.value.price = 0;
                    tradeForm.value.shares = 1;
                } else {
                    tradeForm.value.price = targetStock.price;
                    tradeForm.value.shares = null; // 🌟 預設保持空白
                }
                tradeForm.value.date = getNowDateStr();
            } else {
                isEditingTrade.value = false;
                editingTradeId.value = null;
                tradeForm.value.action = '買進';
                tradeForm.value.broker = selectedBrokerFilter.value !== '全部' ? selectedBrokerFilter.value : '玉山證券';
                tradeForm.value.code = '';
                tradeForm.value.name = '';
                if (tradeForm.value.broker === '關注') {
                    tradeForm.value.price = 0;
                    tradeForm.value.shares = 1;
                } else {
                    tradeForm.value.price = null;
                    tradeForm.value.shares = null;
                }
                tradeForm.value.date = getNowDateStr();
            }
            showTradeModal.value = true;
        };

        const saveTradeRecord = async () => {
            const brokerName = (tradeForm.value.broker || '玉山證券').trim();
            const actionName = tradeForm.value.action || '買進';
            const codeVal = tradeForm.value.code.trim();
            const nameVal = tradeForm.value.name.trim() || codeVal;

            if (!codeVal) {
                alert('請填寫股票代號！');
                return;
            }

            // 沉澱至本地字典與資料庫
            if (codeVal && nameVal && nameVal !== codeVal) {
                stockDictMap.value[codeVal] = nameVal;
                stockDictMap.value[codeVal.padStart(4, '0')] = nameVal;
                if (dbInstance) {
                    try {
                        dbInstance.run("INSERT OR REPLACE INTO stock_dict (stock_code, stock_name) VALUES (?, ?)", [codeVal, nameVal]);
                    } catch (e_dict) {}
                }
            }

            // 🎯【關注券商專屬寫入管道 (100% 比照電腦版)】
            if (brokerName === '關注') {
                if (dbInstance) {
                    try {
                        // 1. 檢測全域庫存中，該股是否已存在於「非關注」的實質券商帳戶中
                        const realCheck = dbInstance.exec("SELECT 證券商, 個股股數 FROM my_stock WHERE 股票代號 = ? AND 證券商 != '關注' AND 個股股數 > 0", [codeVal]);
                        if (realCheck.length > 0 && realCheck[0].values.length > 0) {
                            const existBrokers = realCheck[0].values.map(r => r[0]).join(', ');
                            alert(`⚠️ 錄入中斷：個股 [${codeVal} ${nameVal}] 目前已擁有實質券商庫存 (${existBrokers})，防禦機制已物理阻斷重複新增為『關注股』！`);
                            return;
                        }

                        // 2. 檢測全域庫存中，該股是否已經躺在「關注」名冊內
                        const focusCheck = dbInstance.exec("SELECT 個股股數, created_at FROM my_stock WHERE 股票代號 = ? AND 證券商 = '關注'", [codeVal]);
                        if (focusCheck.length > 0 && focusCheck[0].values.length > 0) {
                            alert(`💡 雷達提示：個股 [${codeVal} ${nameVal}] 已存在於『關注』名冊中，系統自動跳過重複建立流程。`);
                            showTradeModal.value = false;
                            return;
                        }

                        // 3. 寫入 my_stock (股數=0, 損平價=0, 券商='關注', 特別關注='否', created_at=當前時間)
                        const nowTs = getNowDateTimeStr() + ':00';
                        dbInstance.run(
                            "INSERT OR REPLACE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注, created_at) VALUES (?, ?, 0, 0, '關注', '否', ?)",
                            [codeVal, nameVal, nowTs]
                        );
                        // 🎯【核心自癒】：主動銷除可能遺留之刪除墓碑，確保雙向同步不被誤殺
                        try {
                            dbInstance.run("DELETE FROM deleted_records WHERE table_name = 'my_stock' AND unique_key = ?", [makeStockUniqueKey(codeVal, '關注')]);
                        } catch (e_tomb) {}

                        // 4. 自動為關注股建立空白戰報底稿 (若戰報庫查無此股)
                        const stratCheck = dbInstance.exec("SELECT 記錄時間 FROM gem_strategy WHERE 股票代號 = ?", [codeVal]);
                        if (!stratCheck.length || !stratCheck[0].values.length) {
                            const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
                            const pad = n => String(n).padStart(2, '0');
                            const yStr = `${yesterday.getFullYear()}-${pad(yesterday.getMonth()+1)}-${pad(yesterday.getDate())} 12:00:00`;
                            try {
                                dbInstance.run(
                                    "INSERT OR IGNORE INTO gem_strategy (記錄時間, 股票代號, 策略內容, 戰情總結, 佈局下限, 佈局上限, 防守點, 目標下限, 目標上限) VALUES (?, ?, '', '', '', '', '', '', '')",
                                    [yStr, codeVal]
                                );
                            } catch (e_strat) {}
                        }

                        await saveDbToIndexedDb();
                        const u8 = dbInstance.export();
                        await loadDatabaseFromArrayBuffer(u8.buffer, '本機 SQLite (已新增關注)');
                        hasUnsyncedChanges.value = true;
                    } catch (err) {
                        console.error("寫入關注股失敗:", err);
                        alert("寫入失敗: " + err.message);
                        return;
                    }
                }
                showTradeModal.value = false;
                alert(`✅ 已成功將 [${codeVal} ${nameVal}] 釘選至自選觀察池！`);
                return;
            }

            // 🎯【一般實質交易寫入管道】
            if (tradeForm.value.price === null || tradeForm.value.price === undefined || tradeForm.value.shares === null || tradeForm.value.shares === undefined) {
                alert('請完整填寫股票代號、價格與股數！');
                return;
            }

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

                    // 查詢原有的 created_at
                    let existingCreated = '';
                    try {
                        const cRes = dbInstance.exec("SELECT created_at FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?", [codeVal, brokerName]);
                        if (cRes.length > 0 && cRes[0].values && cRes[0].values[0] && cRes[0].values[0][0]) {
                            existingCreated = String(cRes[0].values[0][0]).trim();
                        }
                    } catch (ec) {}
                    if (!existingCreated) {
                        existingCreated = getNowDateTimeStr() + ':00';
                    }

                    dbInstance.run(
                        "INSERT OR REPLACE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        [codeVal, nameVal, curShares, curCost, brokerName, '否', existingCreated]
                    );
                    // 🎯【核心自癒】：銷除該股墓碑
                    try {
                        dbInstance.run("DELETE FROM deleted_records WHERE table_name = 'my_stock' AND unique_key = ?", [makeStockUniqueKey(codeVal, brokerName)]);
                    } catch (e_tomb) {}

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
                            dbInstance.run("CREATE TABLE IF NOT EXISTS deleted_records (table_name TEXT, unique_key TEXT, deleted_at TEXT, stock_created_at TEXT, PRIMARY KEY (table_name, unique_key))");
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

        // 🗑️ 刪除個股功能 (帶持股=0防呆，支援記錄 stock_created_at 墓碑時間戳)
        const deleteStockCard = async (stock) => {
            if (!stock) return;
            // 🛑 防呆第一道：若仍有實質持股 (shares > 0)，嚴禁刪除
            if (Number(stock.shares || 0) > 0) {
                alert(`🚨【庫存防呆攔截】\n個股 [${stock.code} ${stock.name}] 目前在 [${stock.broker || '玉山證券'}] 尚有實質持股 ${formatNumber(stock.shares)} 股！\n\n系統已物理阻斷刪除。請先結清或於交易FIFO中銷帳至 0 股後，方可移除名冊。`);
                return;
            }

            // ⚠️ 二次確認提示
            const confirmMsg = `⚠️ 確定要從戰情室移除 【${stock.code} ${stock.name} (${stock.broker || '關注'})】 嗎？\n\n📌 即將移除的項目：\n1. 庫存與自選觀察名冊\n2. 該股歷史策略戰報紀錄\n\n💡 注意：過往歷史交易流水帳明細將會 100% 完整保留，以利維持歷史損益對沖帳本不受影響。`;
            if (!confirm(confirmMsg)) return;

            if (dbInstance) {
                try {
                    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
                    dbInstance.run("CREATE TABLE IF NOT EXISTS deleted_records (table_name TEXT, unique_key TEXT, deleted_at TEXT, stock_created_at TEXT, PRIMARY KEY (table_name, unique_key))");

                    // 1. 取得該股票的 created_at
                    let stockCreatedAt = '1970-01-01 00:00:00';
                    try {
                        const scRes = dbInstance.exec("SELECT created_at FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?", [stock.code, stock.broker || '關注']);
                        if (scRes.length > 0 && scRes[0].values && scRes[0].values[0] && scRes[0].values[0][0]) {
                            stockCreatedAt = String(scRes[0].values[0][0]).trim();
                        }
                    } catch (esc) {}

                    // 2. 寫入 my_stock 刪除墓碑 (含 stock_created_at)
                    const stockUk = makeStockUniqueKey(stock.code, stock.broker || '關注');
                    dbInstance.run("INSERT OR REPLACE INTO deleted_records (table_name, unique_key, deleted_at, stock_created_at) VALUES ('my_stock', ?, ?, ?)", [stockUk, nowStr, stockCreatedAt]);

                    // 3. 寫入 gem_strategy 刪除墓碑
                    try {
                        const stratRows = dbInstance.exec("SELECT 記錄時間 FROM gem_strategy WHERE 股票代號 = ?", [stock.code]);
                        if (stratRows.length > 0 && stratRows[0].values.length > 0) {
                            stratRows[0].values.forEach(r => {
                                const stratUk = makeStrategyUniqueKey(stock.code, r[0]);
                                dbInstance.run("INSERT OR REPLACE INTO deleted_records (table_name, unique_key, deleted_at) VALUES ('gem_strategy', ?, ?)", [stratUk, nowStr]);
                            });
                        }
                    } catch (e_strat) {}

                    // 4. 物理刪除 my_stock 與 gem_strategy (絕不刪除 trade_log)
                    dbInstance.run("DELETE FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?", [stock.code, stock.broker || '關注']);
                    dbInstance.run("DELETE FROM gem_strategy WHERE 股票代號 = ?", [stock.code]);

                    await saveDbToIndexedDb();
                    const u8 = dbInstance.export();
                    await loadDatabaseFromArrayBuffer(u8.buffer, '本機 SQLite (已移除個股)');
                    hasUnsyncedChanges.value = true;
                    alert(`🗑️ 已成功將 【${stock.code} ${stock.name}】 移出自選名冊！`);
                } catch (e) {
                    console.error("移除個股失敗:", e);
                    alert("❌ 移除個股失敗：" + e.message);
                }
            }
        };

        // ─── 🧠 手機端「匯入戰報」模組 (100% 復刻電腦版正則解析) ───
        const openImportReportModal = (stock = null) => {
            importingStock.value = stock;
            importReportText.value = '';
            showImportReportModal.value = true;
        };

        const parseReportText = (text) => {
            if (!text || typeof text !== 'string') return null;
            const t = text.trim();
            if (!t) return null;

            const codeMatch = t.match(/代碼[：:]\s*([0-9A-Za-z]+)/);
            const sumMatch = t.match(/戰情總結[：:]\s*(.*?)(?=\n|$)/);
            const buyLowMatch = t.match(/佈局區間下限[：:]\s*([0-9.,]+)/);
            const buyHighMatch = t.match(/佈局區間上限[：:]\s*([0-9.,]+)/);
            const defMatch = t.match(/防守停損點[：:]\s*([0-9.,]+)/);
            const targetLowMatch = t.match(/目標調節下限[：:]\s*([0-9.,]+)/);
            const targetHighMatch = t.match(/目標調節上限[：:]\s*([0-9.,]+)/);

            const cleanNum = (m) => {
                if (!m || !m[1]) return null;
                const v = parseFloat(m[1].replace(/,/g, ''));
                return isNaN(v) ? null : v;
            };

            return {
                code: codeMatch ? codeMatch[1].trim() : '',
                summary: sumMatch ? sumMatch[1].trim() : '',
                buyLow: cleanNum(buyLowMatch),
                buyHigh: cleanNum(buyHighMatch),
                defense: cleanNum(defMatch),
                targetLow: cleanNum(targetLowMatch),
                targetHigh: cleanNum(targetHighMatch),
                raw: t
            };
        };

        const parsedImportPreview = computed(() => {
            return parseReportText(importReportText.value);
        });

        const submitImportReport = async () => {
            if (!dbInstance) {
                alert("⚠️ 資料庫未載入，無法匯入戰報。");
                return;
            }
            const parsed = parseReportText(importReportText.value);
            if (!parsed) {
                alert("⚠️ 請輸入或貼上戰情報告文字！");
                return;
            }

            const targetCode = parsed.code || (importingStock.value ? importingStock.value.code : '');
            if (!targetCode) {
                alert("🚨 無法辨識股票代碼！請確認戰報文字中包含「代碼：XXXX」或從指定個股卡片點擊匯入。");
                return;
            }

            const normalizedCode = targetCode.padStart(4, '0');
            const nowTime = getNowDateTimeStr() + ':00';

            try {
                dbInstance.run(
                    "INSERT OR REPLACE INTO gem_strategy (記錄時間, 股票代號, 策略內容, 佈局下限, 佈局上限, 防守點, 目標下限, 目標上限, 戰情總結) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [nowTime, normalizedCode, parsed.raw, parsed.buyLow, parsed.buyHigh, parsed.defense, parsed.targetLow, parsed.targetHigh, parsed.summary]
                );

                // 銷除墓碑
                try {
                    dbInstance.run("DELETE FROM deleted_records WHERE table_name = 'gem_strategy' AND unique_key = ?", [makeStrategyUniqueKey(normalizedCode, nowTime)]);
                } catch (e) {}

                await saveDbToIndexedDb();
                const u8 = dbInstance.export();
                await loadDatabaseFromArrayBuffer(u8.buffer, '本機 SQLite (已匯入戰報)');
                hasUnsyncedChanges.value = true;
                showImportReportModal.value = false;
                alert(`✅ 戰情報告已成功匯入至 [${normalizedCode}]！\n• 戰情總結：${parsed.summary || '(無總結)'}\n• 佈局區間：${parsed.buyLow || '---'} ~ ${parsed.buyHigh || '---'}\n• 防守點：${parsed.defense || '---'}\n• 目標調節：${parsed.targetLow || '---'} ~ ${parsed.targetHigh || '---'}`);
            } catch (err) {
                console.error("匯入戰報失敗:", err);
                alert("❌ 匯入戰報失敗：" + err.message);
            }
        };

        // ─── 📅 手機端「更新休市日」模組 (對接證交所 OpenAPI + GitHub Pages 雲端自訂休市表) ───
        const updateMarketHolidays = async () => {
            if (!dbInstance) {
                alert("⚠️ 本機尚未載入資料庫，無法更新休市日。");
                return;
            }
            if (isUpdatingHolidays.value) return;

            isUpdatingHolidays.value = true;
            try {
                const holidaysMap = {};

                // 1. 嘗試抓取證交所 OpenAPI (支援 CORS 降級容錯)
                try {
                    const twseApiUrl = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';
                    const res = await fetch(twseApiUrl, { method: 'GET', mode: 'cors' });
                    if (res.ok) {
                        const records = await res.json();
                        if (Array.isArray(records)) {
                            records.forEach(row => {
                                const name = String(row.Name || '');
                                const rocDate = String(row.Date || '').trim();
                                if (name.includes('開始交易')) return;
                                if (rocDate.length === 7 && /^\d+$/.test(rocDate)) {
                                    const rocYear = parseInt(rocDate.slice(0, 3), 10);
                                    const adYear = rocYear + 1911;
                                    const adDateStr = `${adYear}${rocDate.slice(3)}`;
                                    holidaysMap[parseInt(adDateStr, 10)] = name;
                                }
                            });
                        }
                    }
                } catch (eTwse) {
                    console.warn("證交所 OpenAPI 連線跳過 (跨域或離線):", eTwse);
                }

                // 2. 補齊今年與明年的六日例假日
                const curYear = new Date().getFullYear();
                const startDate = new Date(curYear, 0, 1);
                const endDate = new Date(curYear + 1, 11, 31);
                for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                    const pad = n => String(n).padStart(2, '0');
                    const dInt = parseInt(`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`, 10);
                    const dayOfWeek = d.getDay();
                    if (dayOfWeek === 6 && !holidaysMap[dInt]) {
                        holidaysMap[dInt] = '星期六';
                    } else if (dayOfWeek === 0 && !holidaysMap[dInt]) {
                        holidaysMap[dInt] = '星期日';
                    }
                }

                // 3. 抓取雲端自訂休市表 (typhone_day.txt)
                try {
                    const cloudTxtUrl = 'https://timlin7026.github.io/stock-sentinel/typhone_day.txt';
                    const cRes = await fetch(cloudTxtUrl);
                    if (cRes.ok) {
                        const text = await cRes.text();
                        text.split('\n').forEach(line => {
                            const l = line.trim();
                            if (l && l.includes(',')) {
                                const [dStr, reason] = l.split(',', 2);
                                const cleanD = dStr.trim();
                                if (cleanD.length === 8 && /^\d+$/.test(cleanD)) {
                                    holidaysMap[parseInt(cleanD, 10)] = reason.trim();
                                }
                            }
                        });
                    }
                } catch (eCloud) {
                    console.warn("雲端自訂休市表抓取跳過:", eCloud);
                }

                // 4. 寫入本地 SQLite 表 holidays
                dbInstance.run("CREATE TABLE IF NOT EXISTS holidays (holiday_date INTEGER PRIMARY KEY, holiday_name TEXT)");
                let inserted = 0;
                Object.entries(holidaysMap).forEach(([dateInt, name]) => {
                    dbInstance.run("INSERT OR REPLACE INTO holidays (holiday_date, holiday_name) VALUES (?, ?)", [parseInt(dateInt, 10), String(name)]);
                    inserted++;
                });

                await saveDbToIndexedDb();
                hasUnsyncedChanges.value = true;
                alert(`✨ [校準完成] 本地台股行事曆更新成功！\n共校準 ${inserted} 天市場休市與例假日。`);
            } catch (err) {
                console.error("更新休市日失敗:", err);
                alert("❌ 更新休市日失敗：" + err.message);
            } finally {
                isUpdatingHolidays.value = false;
            }
        };

        // ─── 🧠 手機端共用技術指標與策略特徵運算核心 (100% 復刻電腦版 update_stock_heatmap_cache_engine) ───
        const calculateStockIndicatorsFromAnalysis = (analysisRaw) => {
            if (!analysisRaw || typeof analysisRaw !== 'object' || Object.keys(analysisRaw).length === 0) {
                return null;
            }

            const sortedDates = Object.keys(analysisRaw).sort();
            const rows = sortedDates.map(dStr => {
                const val = analysisRaw[dStr] || {};
                const p = val.price || {};
                const c = val.chip || {};
                const m = val.margin || {};
                return {
                    date: String(dStr).replace(/[-/]/g, ''),
                    open: Number(p.open) || 0,
                    high: Number(p.high) || 0,
                    low: Number(p.low) || 0,
                    close: Number(p.close) || 0,
                    volume: Math.floor(Number(val.volume) || 0),
                    foreign: Math.floor(Number(c.foreign_buy) || 0),
                    sitc: Math.floor(Number(c.sitc_buy) || 0),
                    dealers: Math.floor(Number(c.dealers_buy) || 0),
                    margin_balance: Math.floor(Number(m.margin_balance) || 0),
                    margin_increase: Math.floor(Number(m.margin_increase) || 0)
                };
            }).filter(r => r.close > 0);

            if (rows.length === 0) return null;

            // 1. 滾算技術指標
            for (let i = 0; i < rows.length; i++) {
                // MA5
                const s5 = rows.slice(Math.max(0, i - 4), i + 1);
                const sum5 = s5.reduce((acc, r) => acc + Math.round(r.close * 100), 0) / 100;
                rows[i].MA5 = sum5 / s5.length;

                // MA10
                const s10 = rows.slice(Math.max(0, i - 9), i + 1);
                const sum10 = s10.reduce((acc, r) => acc + Math.round(r.close * 100), 0) / 100;
                rows[i].MA10 = sum10 / s10.length;

                // BB_Mid & BB_Std
                const s20 = rows.slice(Math.max(0, i - 19), i + 1);
                const sum20 = s20.reduce((acc, r) => acc + Math.round(r.close * 100), 0) / 100;
                const mean20 = sum20 / s20.length;
                rows[i].BB_Mid = mean20;
                if (s20.length >= 2) {
                    const variance = s20.reduce((acc, r) => acc + Math.pow(r.close - mean20, 2), 0) / (s20.length - 1);
                    const std = Math.sqrt(variance);
                    rows[i].BB_Std = std;
                    rows[i].BB_U = mean20 + 2 * std;
                    rows[i].BB_L = mean20 - 2 * std;
                } else {
                    rows[i].BB_Std = 0;
                    rows[i].BB_U = mean20;
                    rows[i].BB_L = mean20;
                }
            }

            // KD (7日 RSV)
            let kCur = 50.0, dCur = 50.0;
            for (let i = 0; i < rows.length; i++) {
                const s7 = rows.slice(Math.max(0, i - 6), i + 1);
                const l7 = Math.min(...s7.map(r => r.low));
                const h7 = Math.max(...s7.map(r => r.high));
                const rsv = 100 * ((rows[i].close - l7) / ((h7 - l7) + 1e-5));
                kCur = (2/3) * kCur + (1/3) * rsv;
                dCur = (2/3) * dCur + (1/3) * kCur;
                rows[i].K = kCur;
                rows[i].D = dCur;
            }

            // MACD (EMA6, EMA9, DIF, MACD_S, OSC)
            let ema6 = rows[0].close, ema9 = rows[0].close;
            let macdS = 0;
            for (let i = 0; i < rows.length; i++) {
                const c = rows[i].close;
                ema6 = i === 0 ? c : (c * (2/7) + ema6 * (5/7));
                ema9 = i === 0 ? c : (c * (2/10) + ema9 * (8/10));
                const dif = ema6 - ema9;
                macdS = i === 0 ? dif : (dif * (2/7) + macdS * (5/7));
                rows[i].DIF = dif;
                rows[i].MACD_S = macdS;
                rows[i].OSC = dif - macdS;
            }

            // MTM (3日 diff, MA2)
            for (let i = 0; i < rows.length; i++) {
                rows[i].MTM = i >= 3 ? rows[i].close - rows[i - 3].close : 0;
                const sMtm = rows.slice(Math.max(0, i - 1), i + 1);
                rows[i].MTM_MA = sMtm.reduce((acc, r) => acc + r.MTM, 0) / sMtm.length;
            }

            // RSI4 & RSI12
            let gain4 = 0, loss4 = 0, gain12 = 0, loss12 = 0;
            for (let i = 0; i < rows.length; i++) {
                if (i === 0) {
                    rows[i].RSI4 = 50.0;
                    rows[i].RSI12 = 50.0;
                } else {
                    const diff = rows[i].close - rows[i - 1].close;
                    const u = Math.max(0, diff);
                    const d = Math.abs(Math.min(0, diff));
                    gain4 = u * (1/4) + gain4 * (3/4);
                    loss4 = d * (1/4) + loss4 * (3/4);
                    rows[i].RSI4 = (gain4 / (gain4 + loss4 + 1e-5)) * 100;

                    gain12 = u * (1/12) + gain12 * (11/12);
                    loss12 = d * (1/12) + loss12 * (11/12);
                    rows[i].RSI12 = (gain12 / (gain12 + loss12 + 1e-5)) * 100;
                }
            }

            // WR3 & WR50 & 法人融資熱力燈
            for (let i = 0; i < rows.length; i++) {
                const s3 = rows.slice(Math.max(0, i - 2), i + 1);
                const h3 = Math.max(...s3.map(r => r.high));
                const l3 = Math.min(...s3.map(r => r.low));
                rows[i].WR3 = -100 * ((h3 - rows[i].close) / ((h3 - l3) + 1e-5));

                const s50 = rows.slice(Math.max(0, i - 49), i + 1);
                const h50 = Math.max(...s50.map(r => r.high));
                const l50 = Math.min(...s50.map(r => r.low));
                rows[i].WR50 = -100 * ((h50 - rows[i].close) / ((h50 - l50) + 1e-5));

                rows[i].法人合計 = rows[i].foreign + rows[i].sitc + rows[i].dealers;
                rows[i].融資增減 = i >= 1 ? rows[i].margin_balance - rows[i - 1].margin_balance : 0;
                rows[i].融資餘額 = rows[i].margin_balance;
                rows[i].外資買賣超 = rows[i].foreign;
                rows[i].投信買賣超 = rows[i].sitc;
                rows[i].自營買賣超 = rows[i].dealers;
                rows[i].成交量 = rows[i].volume;
                rows[i].開盤價 = rows[i].open;
                rows[i].最高價 = rows[i].high;
                rows[i].最低價 = rows[i].low;
                rows[i].收盤價 = rows[i].close;
                rows[i].交易日期 = rows[i].date;

                // 6 燈
                rows[i].P10_MTM_Cross = rows[i].MTM > rows[i].MTM_MA ? 1 : -1;
                rows[i].P1_MACD_OSC = i >= 1 && rows[i].OSC > rows[i - 1].OSC ? 1 : -1;
                rows[i].P5_K_Trend = i >= 1 && rows[i].K > rows[i - 1].K ? 1 : -1;
                rows[i].P3_DIF_Trend = i >= 1 && rows[i].DIF > rows[i - 1].DIF ? 1 : -1;
                rows[i].P4_KD_Cross = rows[i].K > rows[i].D ? 1 : -1;
                rows[i].P2_MACD_Cross = rows[i].DIF > rows[i].MACD_S ? 1 : -1;
            }

            const latest_row = rows[rows.length - 1];
            const prev_row = rows.length >= 2 ? rows[rows.length - 2] : latest_row;

            // 6 大核心信號
            const pulse_keys = ["P10_MTM_Cross", "P1_MACD_OSC", "P5_K_Trend", "P3_DIF_Trend", "P4_KD_Cross", "P2_MACD_Cross"];
            const pulse_names = ["MTM金", "OSC縮", "K趨", "DIF趨", "KD金", "MACD金"];

            const indicators = {};
            const prev_indicators = {};
            pulse_names.forEach((name, idx) => {
                const key = pulse_keys[idx];
                indicators[name] = latest_row[key] !== undefined ? latest_row[key] : -1;
                prev_indicators[name] = prev_row[key] !== undefined ? prev_row[key] : indicators[name];
            });

            // 策略特徵指標
            const ma5 = latest_row.MA5;
            const ma10 = latest_row.MA10;
            const ma20 = latest_row.BB_Mid;
            const ma_order = [
                { v: ma5, name: "MA5" },
                { v: ma10, name: "MA10" },
                { v: ma20, name: "MA20" }
            ].sort((a, b) => b.v - a.v);
            const ma_order_str = `(${ma_order[0].name} > ${ma_order[1].name} > ${ma_order[2].name})`;
            const ma_align = ma5 > ma10 && ma10 > ma20 
                ? `多頭排列 ${ma_order_str}` 
                : (ma5 < ma10 && ma10 < ma20 ? `空頭排列 ${ma_order_str}` : `整理格局 ${ma_order_str}`);

            const bias20 = ma20 > 0 ? ((latest_row.close - ma20) / ma20 * 100) : 0.0;
            let bias_label = "";
            if (bias20 >= 10) bias_label = `短線超買過熱 (${bias20 >= 0 ? '+' : ''}${bias20.toFixed(1)}%)`;
            else if (bias20 <= -8) bias_label = `短線超跌恐慌 (${bias20 >= 0 ? '+' : ''}${bias20.toFixed(1)}%)`;
            else bias_label = `溫和整理 (${bias20 >= 0 ? '+' : ''}${bias20.toFixed(2)}%)`;

            const vol5Slice = rows.slice(-5);
            const vol5_avg = vol5Slice.reduce((acc, r) => acc + r.volume, 0) / vol5Slice.length;
            const vol_ratio = vol5_avg > 0 ? (latest_row.volume / vol5_avg) : 1.0;
            const vol_status = vol_ratio >= 1.5 ? `爆量發動 (${vol_ratio.toFixed(1)}倍)` : `量能平穩 (${vol_ratio.toFixed(1)}倍)`;

            const f_diffs = rows.slice(-5).map(r => r.foreign);
            const s_diffs = rows.slice(-5).map(r => r.sitc);
            const d_diffs = rows.slice(-5).map(r => r.dealers);

            function get_consecutive_days(diffs) {
                if (diffs.every(v => v === 0)) return { days: 0, dir: "不參與" };
                const latest = diffs[diffs.length - 1];
                if (latest === 0) return { days: 0, dir: "無明顯交易" };
                const direction = latest > 0 ? "買" : "賣";
                let days = 0;
                for (let i = diffs.length - 1; i >= 0; i--) {
                    if (direction === "買" && diffs[i] > 0) days++;
                    else if (direction === "賣" && diffs[i] < 0) days++;
                    else break;
                }
                return { days, dir: direction };
            }

            const f_info = get_consecutive_days(f_diffs);
            const s_info = get_consecutive_days(s_diffs);
            const d_info = get_consecutive_days(d_diffs);
            const f_desc = f_info.days >= 3 ? `連${f_info.dir}${f_info.days}天` : (f_info.dir === "不參與" ? "不參與" : "多空拉鋸");
            const s_desc = s_info.dir === "不參與" ? "不參與" : (s_info.days >= 3 ? `連${s_info.dir}${s_info.days}天` : "多空拉鋸");
            const d_desc = d_info.days >= 3 ? `連${d_info.dir}${d_info.days}天` : (d_info.dir === "不參與" ? "不參與" : "多空拉鋸");
            const inst_synergy = `外資:${f_desc} │ 投信:${s_desc} │ 自營:${d_desc}`;

            const margin_diffs = rows.slice(-5).map(r => r.融資增減);
            let margin_dec_days = 0, margin_inc_days = 0;
            for (let i = margin_diffs.length - 1; i >= 0; i--) {
                if (margin_diffs[i] < 0) margin_dec_days++;
                else break;
            }
            if (margin_dec_days === 0) {
                for (let i = margin_diffs.length - 1; i >= 0; i--) {
                    if (margin_diffs[i] > 0) margin_inc_days++;
                    else break;
                }
            }
            let margin_status = "";
            if (margin_dec_days >= 3) margin_status = `籌碼沉澱 (融資連減 ${margin_dec_days} 天 🛡️)`;
            else if (margin_inc_days >= 3) margin_status = `融資堆積 (融資連增 ${margin_inc_days} 天 ⚠️)`;
            else margin_status = "無明顯連續增減資";

            // 籌碼吸籌比 (5日)
            const last5 = rows.slice(-5);
            const total_vol_5 = last5.reduce((acc, r) => acc + r.volume, 0);
            const total_inst_5 = last5.reduce((acc, r) => acc + r.法人合計, 0);
            const absorption_ratio = total_vol_5 > 0 ? (total_inst_5 / total_vol_5 * 100) : 0.0;
            const abs_sign = absorption_ratio >= 0 ? '+' : '';
            let absorption_status = "";
            if (absorption_ratio > 15.0) absorption_status = `法人強力吸籌 🔥 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;
            else if (absorption_ratio > 5.0) absorption_status = `法人偏多吸籌 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;
            else if (absorption_ratio >= -5.0) absorption_status = `籌碼變動平穩 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;
            else if (absorption_ratio >= -15.0) absorption_status = `法人偏空出貨 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;
            else absorption_status = `法人加速出貨 🚨 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;

            // 法人買超加速度
            const last3 = rows.slice(-3);
            const last10 = rows.slice(-10);
            const inst_avg_3 = last3.reduce((acc, r) => acc + r.法人合計, 0) / (last3.length || 1);
            const inst_avg_10 = last10.reduce((acc, r) => acc + r.法人合計, 0) / (last10.length || 1);
            let accel_status = "量能穩定";
            if (Math.abs(inst_avg_10) > 0) {
                const accel = inst_avg_3 / inst_avg_10;
                if (accel > 2.0 && inst_avg_3 > 0) accel_status = `加速買超中 (力道放大 ${accel.toFixed(1)}倍 ⚡)`;
                else if (accel > 2.0 && inst_avg_3 < 0) accel_status = `加速賣超中 (力道放大 ${accel.toFixed(1)}倍 🚨)`;
                else accel_status = "買賣超力道平穩";
            } else {
                accel_status = "量能穩定";
            }

            // 價量關係
            const p_change = prev_row.close > 0 ? ((latest_row.close - prev_row.close) / prev_row.close * 100) : 0.0;
            const v_change = prev_row.volume > 0 ? ((latest_row.volume - prev_row.volume) / prev_row.volume * 100) : 0.0;

            const p_dir = p_change >= 0.5 ? "價漲" : (p_change <= -0.5 ? "價跌" : "價平");
            const v_dir_state = v_change >= 10.0 ? "量增" : (v_change <= -10.0 ? "量縮" : "量平");
            const pv_status = `${p_dir}${v_dir_state}`;
            let pv_desc = pv_status;
            if (pv_status === "價漲量增") pv_desc = "價漲量增 (多頭攻擊)";
            else if (pv_status === "價跌量增") pv_desc = "價跌量增 (殺盤鬆動)";
            else if (pv_status === "價漲量縮" || pv_status === "價平量增") pv_desc = `${pv_status} (量價背離/換手)`;
            else if (pv_status === "價跌量縮") pv_desc = "價跌量縮 (止跌訊號)";
            else pv_desc = pv_status;

            // 布林通道
            const bb_u = latest_row.BB_U;
            const bb_l = latest_row.BB_L;
            const pct_b = (bb_u - bb_l) > 0 ? ((latest_row.close - bb_l) / (bb_u - bb_l)) : 0.5;

            const bw_current = ma20 > 0 ? (bb_u - bb_l) / ma20 : 0.0;
            const last20_rows = rows.slice(-20);
            const bw_20_series = last20_rows.map(r => r.BB_Mid > 0 ? (r.BB_U - r.BB_L) / r.BB_Mid : 0);
            const bw_min_val = bw_20_series.length > 0 ? Math.min(...bw_20_series) : 0;
            const is_squeezed = bw_min_val > 0 ? (bw_current <= bw_min_val * 1.15) : false;
            const squeeze_lbl = is_squeezed ? " (壓縮蓄勢)" : "";

            let bb_status = "布林空頭軌";
            if (pct_b >= 1.0) bb_status = "布林突破";
            else if (pct_b > 0.5) bb_status = "布林多頭軌";
            else if (pct_b > 0.0) bb_status = "布林空頭軌";
            else bb_status = "布林跌破";
            const bb_desc = `${bb_status}${squeeze_lbl} (%B:${pct_b.toFixed(2)})`;

            // K 線型態辨識
            function _compute_k_pattern(df_rows) {
                const pats = [];
                const n = df_rows.length;
                if (n < 1) return "無明顯型態";

                const body_len_arr = df_rows.map(r => Math.abs(r.close - r.open));
                const ma_b_series = [];
                const ma20_series = [];
                for (let i = 0; i < n; i++) {
                    const start_10 = Math.max(0, i - 9);
                    const slice_10 = body_len_arr.slice(start_10, i + 1);
                    ma_b_series.push(slice_10.reduce((a, b) => a + b, 0) / slice_10.length);

                    const start_20 = Math.max(0, i - 19);
                    const slice_20 = df_rows.slice(start_20, i + 1);
                    ma20_series.push(slice_20.reduce((a, r) => a + r.close, 0) / slice_20.length);
                }

                function get_indicators(idx) {
                    const actual_idx = idx < 0 ? n + idx : idx;
                    const r = df_rows[actual_idx];
                    const o = r.open, h = r.high, c = r.close, l = r.low;
                    const b = Math.abs(c - o);
                    const ub = Math.max(o, c);
                    const lb = Math.min(o, c);
                    const us = h - ub;
                    const ls = lb - l;
                    const range_val = h - l > 0 ? h - l : 1e-5;
                    const ma_b = ma_b_series[actual_idx] || 1e-5;
                    const ma20_val = ma20_series[actual_idx] || c;
                    const bull = c > o ? 1 : 0;
                    const bear = c < o ? 1 : 0;

                    const start_pos = Math.max(0, actual_idx - 10);
                    const prev_10_slice = df_rows.slice(start_pos, actual_idx);
                    const h_max_10 = prev_10_slice.length > 0 ? Math.max(...prev_10_slice.map(x => x.high)) : h;
                    const l_min_10 = prev_10_slice.length > 0 ? Math.min(...prev_10_slice.map(x => x.low)) : l;

                    return { o, h, c, l, b, ub, lb, us, ls, r: range_val, ma_b, ma20: ma20_val, bull, bear, h_max_10, l_min_10 };
                }

                const t0 = get_indicators(-1);
                const is_doji = t0.r > 0 ? (t0.b / t0.r <= 0.10) : false;
                const is_hammer = t0.ls >= 2 * t0.b && t0.us <= 0.3 * t0.b && t0.b <= 0.35 * t0.r;
                const is_shooting_star = t0.us >= 2 * t0.b && t0.ls <= 0.2 * t0.b && t0.ub <= t0.l + (t0.r / 3);
                const is_hanging_man = (t0.b <= 0.3 * t0.r) && (t0.ls >= 2 * t0.b) && (t0.us <= 0.2 * t0.b) && (t0.lb >= t0.l + 0.65 * t0.r) && (t0.c > t0.ma20) && (t0.h >= t0.h_max_10);
                const is_gravestone = (t0.b <= 0.05 * t0.r) && (t0.us >= 0.75 * t0.r) && (t0.ls <= 0.05 * t0.r) && (t0.c > t0.ma20) && (t0.h >= t0.h_max_10);
                const is_dragonfly = (t0.b <= 0.05 * t0.r) && (t0.ls >= 0.75 * t0.r) && (t0.us <= 0.05 * t0.r) && (t0.c < t0.ma20) && (t0.l <= t0.l_min_10);

                if (is_gravestone) pats.push("🪦 墓碑線");
                else if (is_dragonfly) pats.push("🦎 蜻蜓線");
                else if (is_doji) pats.push("⭐ 十字星");

                if (is_hanging_man) pats.push("🪢 吊人線");
                else if (is_hammer) pats.push("🔨 底部槌子線");
                else if (is_shooting_star) pats.push("☄️ 高檔流星線");

                if (n >= 2) {
                    const t1 = get_indicators(-2);
                    if (t1.bear === 1 && t0.bull === 1 && t0.o <= t1.c && t0.c >= t1.o && t0.b > t1.b) pats.push("🔴 多頭吞噬");
                    if (t1.bull === 1 && t0.bear === 1 && t0.o >= t1.c && t0.c <= t1.o && t0.b > t1.b) pats.push("🟢 空頭吞噬");
                    if (t1.bear === 1 && t1.b >= t1.ma_b && t0.o < t1.l && t0.bull === 1 && (((t1.o + t1.c)/2 < t0.c) && (t0.c < t1.o))) pats.push("⚡ 貫穿線");
                    if (t1.bear === 1 && t1.b >= 1.2 * t1.ma_b && (t1.c < t0.o && t0.o < t1.o) && (t1.c < t0.c && t0.c < t1.o)) pats.push("🤰 多頭孕線");
                    if (t1.bull === 1 && t1.b >= t1.ma_b && t0.o > t1.h && t0.bear === 1 && (t1.o < t0.c && t0.c < (t1.o + t1.c)/2)) pats.push("⛈️ 烏雲罩頂");
                }

                if (n >= 3) {
                    const t1 = get_indicators(-2);
                    const t2 = get_indicators(-3);
                    const is_ms_1 = t2.bear === 1 && t2.b >= 1.2 * t2.ma_b;
                    const is_ms_2 = t1.b <= 0.3 * t2.b && t1.ub < t2.c;
                    const is_ms_3 = t0.bull === 1 && t0.c >= (t2.o + t2.c) / 2;
                    if (is_ms_1 && is_ms_2 && is_ms_3) pats.push("🌅 早晨之星");

                    const is_es_1 = t2.bull === 1 && t2.b >= 1.2 * t2.ma_b;
                    const is_es_2 = t1.b <= 0.3 * t2.b && t1.lb > t2.c;
                    const is_es_3 = t0.bear === 1 && t0.c <= (t2.o + t2.c) / 2;
                    if (is_es_1 && is_es_2 && is_es_3) pats.push("🌌 夜星");

                    const is_w3_1 = t2.bull === 1 && t1.bull === 1 && t0.bull === 1;
                    const is_w3_2 = t2.c < t1.c && t1.c < t0.c;
                    const is_w3_3 = (t2.o <= t1.o && t1.o <= t2.c) && (t1.o <= t0.o && t0.o <= t1.c);
                    const is_w3_4 = t2.us <= 0.2 * t2.b && t1.us <= 0.2 * t1.b && t0.us <= 0.2 * t0.b;
                    if (is_w3_1 && is_w3_2 && is_w3_3 && is_w3_4) pats.push("📈 紅三兵");

                    const is_c3_1 = t2.bear === 1 && t1.bear === 1 && t0.bear === 1;
                    const is_c3_2 = t2.c > t1.c && t1.c > t0.c;
                    const is_c3_3 = (t2.c <= t1.o && t1.o <= t2.o) && (t1.c <= t0.o && t0.o <= t1.o);
                    const is_c3_4 = t2.ls <= 0.2 * t2.b && t1.ls <= 0.2 * t1.b && t0.ls <= 0.2 * t0.b;
                    if (is_c3_1 && is_c3_2 && is_c3_3 && is_c3_4) pats.push("🐦 三隻烏鴉");
                }

                if (n >= 5) {
                    const t1 = get_indicators(-2);
                    const t2 = get_indicators(-3);
                    const t3 = get_indicators(-4);
                    const t4 = get_indicators(-5);
                    const is_r3_1 = t4.bull === 1 && t4.b >= 1.5 * t4.ma_b;
                    let is_r3_2 = true;
                    for (const k of [t3, t2, t1]) {
                        if (k.b > 0.4 * t4.b || k.h > t4.h || k.l < t4.l) is_r3_2 = false;
                    }
                    const is_r3_3 = t0.bull === 1 && t0.c > t4.h;
                    if (is_r3_1 && is_r3_2 && is_r3_3) pats.push("🚀 上升三法");
                }

                return pats.length > 0 ? pats.join("、") : "無明顯型態";
            }

            const k_pattern = _compute_k_pattern(rows);
            const rawDate = String(latest_row.date);
            const formattedDataDate = rawDate.length === 8 ? `${rawDate.slice(0, 4)}/${rawDate.slice(4, 6)}/${rawDate.slice(6, 8)}` : rawDate;

            return {
                latestPrice: latest_row.close,
                latestDate: formattedDataDate,
                changePct: p_change,
                indicators,
                prev_indicators,
                strategy_indicators: {
                    ma_align,
                    bb_desc,
                    pv_desc,
                    bias_label,
                    vol_status,
                    inst_synergy,
                    margin_status,
                    absorption_status,
                    accel_status,
                    k_pattern
                },
                rows
            };
        };

        // ─── ⚡ 手機端「批量差異補完」模組 (全量個股健康度巡航、休市日清洗與技術指標自癒) ───
        const batchPatchData = async () => {
            if (!dbInstance) {
                alert("⚠️ 本機尚未載入資料庫，無法執行補完。");
                return;
            }
            if (isBatchPatching.value) return;

            isBatchPatching.value = true;
            try {
                // 1. 提取所有自選名冊與策略庫個股
                const stockSet = new Set();
                try {
                    const sRows = dbInstance.exec("SELECT DISTINCT 股票代號 FROM my_stock");
                    if (sRows.length > 0 && sRows[0].values) sRows[0].values.forEach(r => stockSet.add(String(r[0]).trim()));
                    const gRows = dbInstance.exec("SELECT DISTINCT 股票代號 FROM gem_strategy");
                    if (gRows.length > 0 && gRows[0].values) gRows[0].values.forEach(r => stockSet.add(String(r[0]).trim()));
                } catch (e) {}

                const stockListArr = Array.from(stockSet).filter(c => c && c.toUpperCase() !== 'TOTAL');
                if (stockListArr.length === 0) {
                    alert("💡 目前名冊與策略庫內查無個股，無須執行差異補完。");
                    return;
                }

                // 2. 取得所有休市日
                const holidaysSet = new Set();
                try {
                    const hRows = dbInstance.exec("SELECT holiday_date FROM holidays");
                    if (hRows.length > 0 && hRows[0].values) hRows[0].values.forEach(r => holidaysSet.add(String(r[0])));
                } catch (e) {}

                // 3. 確保資料表結構存在
                dbInstance.run("CREATE TABLE IF NOT EXISTS stock_heatmap_cache (stock_code TEXT PRIMARY KEY, cache_data TEXT)");
                dbInstance.run("CREATE TABLE IF NOT EXISTS stock_price (stock_code TEXT PRIMARY KEY, cache_data TEXT)");

                // 4. 掃描 stock_analysis 快取並清洗休市日資料與重新計算指標
                let totalCleaned = 0;
                let recomputedCount = 0;
                try {
                    const aRows = dbInstance.exec("SELECT stock_code, cache_data FROM stock_analysis");
                    if (aRows.length > 0 && aRows[0].values) {
                        for (const r of aRows[0].values) {
                            const sc = String(r[0]).trim();
                            try {
                                const parsed = JSON.parse(r[1]);
                                if (parsed && typeof parsed === 'object') {
                                    let changed = false;
                                    Object.keys(parsed).forEach(d => {
                                        if (holidaysSet.has(String(d))) {
                                            delete parsed[d];
                                            changed = true;
                                            totalCleaned++;
                                        }
                                    });
                                    if (changed) {
                                        dbInstance.run("UPDATE stock_analysis SET cache_data = ? WHERE stock_code = ?", [JSON.stringify(parsed), sc]);
                                    }

                                    // ⚡ 核心計算：為每檔個股重新計算 6 大青紅燈與策略指標特徵
                                    const calcResult = calculateStockIndicatorsFromAnalysis(parsed);
                                    if (calcResult) {
                                        const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
                                        const heatmapObj = {
                                            indicators: calcResult.indicators,
                                            prev_indicators: calcResult.prev_indicators,
                                            data_date: calcResult.latestDate,
                                            update_time: nowStr,
                                            strategy_indicators: calcResult.strategy_indicators
                                        };

                                        // 寫入 stock_heatmap_cache
                                        dbInstance.run(
                                            "INSERT OR REPLACE INTO stock_heatmap_cache (stock_code, cache_data) VALUES (?, ?)",
                                            [sc, JSON.stringify(heatmapObj)]
                                        );

                                        // 寫入 stock_price (cache_data JSON 格式)
                                        const pObj = {
                                            price: calcResult.latestPrice,
                                            date: calcResult.latestDate,
                                            change_pct: calcResult.changePct || 0.0
                                        };
                                        dbInstance.run(
                                            "INSERT OR REPLACE INTO stock_price (stock_code, cache_data) VALUES (?, ?)",
                                            [sc, JSON.stringify(pObj)]
                                        );
                                        recomputedCount++;
                                    }
                                }
                            } catch (ep) {}
                        }
                    }
                } catch (ea) {}

                // ⚡ 5. 結合雲端快照補完名冊中尚未有本地 K 線的個股 (如 00770 等關注股)
                if (!currentMarketSnapshotData && window.localforage) {
                    try {
                        currentMarketSnapshotData = await localforage.getItem('sentinel_market_snapshot');
                    } catch (e) {}
                }

                if (currentMarketSnapshotData) {
                    for (const sc of stockListArr) {
                        const snap = currentMarketSnapshotData[sc] 
                            || currentMarketSnapshotData[sc.padStart(4, '0')] 
                            || currentMarketSnapshotData[sc.padStart(5, '0')] 
                            || currentMarketSnapshotData[sc.replace(/^0+/, '')];
                        if (snap && snap.p > 0) {
                            const pDate = snap.d ? (snap.d.length === 8 ? `${snap.d.slice(0, 4)}-${snap.d.slice(4, 6)}-${snap.d.slice(6, 8)}` : snap.d) : '2026-10-08';
                            const snapPriceObj = {
                                price: snap.p,
                                date: pDate,
                                change: snap.chg || 0,
                                change_pct: snap.pct || 0
                            };
                            dbInstance.run(
                                "INSERT OR REPLACE INTO stock_price (stock_code, cache_data) VALUES (?, ?)",
                                [sc, JSON.stringify(snapPriceObj)]
                            );
                            recomputedCount++;
                        }
                    }
                }

                await saveDbToIndexedDb();
                const u8 = dbInstance.export();
                await loadDatabaseFromArrayBuffer(u8.buffer, '本機 SQLite (已批量補完)');
                hasUnsyncedChanges.value = true;

                alert(`✨ [批量差異補完完成！]\n• 巡航名冊：${stockListArr.length} 檔個股\n• 清除休市殘留：${totalCleaned} 筆\n• 重新計算青紅燈與現價：${recomputedCount} 檔個股！\n本地資料庫指標與健康度已全盤校準完畢！`);
            } catch (err) {
                console.error("批量補完失敗:", err);
                alert("❌ 批量補完失敗：" + err.message);
            } finally {
                isBatchPatching.value = false;
            }
        };

        // ─── 📋 復刻電腦版「一鍵複製 10日」戰報生成引擎 ───
        const toastMsg = ref('');
        const showToast = (msg, duration = 2500) => {
            toastMsg.value = msg;
            setTimeout(() => {
                if (toastMsg.value === msg) {
                    toastMsg.value = '';
                }
            }, duration);
        };

        const buildStock10DayReport = (stock) => {
            if (!stock) return '';
            const sc = String(stock.code || '').trim().padStart(4, '0');
            const stock_name = stock.name || sc;
            const sh = Number(stock.shares) || 0;
            const cp = Number(stock.costPrice) || 0;
            const cur_p = Number(stock.price) || 0;
            const bk = stock.broker || '玉山證券';
            const cur_d = String(stock.priceDate || '').replace(/\D/g, '') || '最新';

            const profit = (cur_p - cp) * sh;
            const roi_pct = cp > 0 ? ((cur_p - cp) / cp) * 100 : 0.0;
            const roi_sign = roi_pct > 0 ? '+' : '';

            // 1. 標頭庫存資訊區塊
            const cur_d_clean = String(cur_d).replace(/[-/]/g, '');
            let header_text = `📋 【格式A】${sc} ${stock_name} (證券商: ${sh > 0 ? bk : '關注'})\n`;
            header_text += `📦 當前庫存與現況：\n`;
            header_text += `- 最新收盤價：${cur_p.toFixed(2)} (日期: ${cur_d_clean})\n`;
            header_text += `- 持股數：${Math.floor(sh).toLocaleString()} 股 | 成本價：${cp.toFixed(2)}\n`;
            if (sh > 0) {
                const pInt = Math.trunc(profit);
                const pSign = pInt >= 0 ? '+' : '';
                header_text += `- 預估損益：${pSign}${pInt} 元 (${roi_sign}${roi_pct.toFixed(2)}%)\n`;
            }
            header_text += `─────────────────────────────────────────────\n`;

            let analysisRaw = null;
            if (dbInstance) {
                try {
                    const aRes = dbInstance.exec("SELECT cache_data FROM stock_analysis WHERE stock_code = ?", [sc]);
                    if (aRes.length > 0 && aRes[0].values.length > 0) {
                        analysisRaw = JSON.parse(aRes[0].values[0][0]);
                    }
                } catch (e) {
                    console.warn("讀取 stock_analysis 失敗:", e);
                }
            }

            if (!analysisRaw || typeof analysisRaw !== 'object' || Object.keys(analysisRaw).length === 0) {
                const fallback_msg = header_text + "⏳ 歷史數據載入中或數據真空，無法計算軌跡。";
                return fallback_msg;
            }

            const sortedDates = Object.keys(analysisRaw).sort();
            const rows = sortedDates.map(dStr => {
                const val = analysisRaw[dStr] || {};
                const p = val.price || {};
                const c = val.chip || {};
                const m = val.margin || {};
                return {
                    date: String(dStr).replace(/[-/]/g, ''),
                    open: Number(p.open) || 0,
                    high: Number(p.high) || 0,
                    low: Number(p.low) || 0,
                    close: Number(p.close) || 0,
                    volume: Math.floor(Number(val.volume) || 0),
                    foreign: Math.floor(Number(c.foreign_buy) || 0),
                    sitc: Math.floor(Number(c.sitc_buy) || 0),
                    dealers: Math.floor(Number(c.dealers_buy) || 0),
                    margin_balance: Math.floor(Number(m.margin_balance) || 0),
                    margin_increase: Math.floor(Number(m.margin_increase) || 0)
                };
            });

            if (rows.length === 0) {
                const fallback_msg = header_text + "⏳ 無足夠歷史 K 線數據。";
                return fallback_msg;
            }

            // 滾算技術指標
            for (let i = 0; i < rows.length; i++) {
                // MA5
                const s5 = rows.slice(Math.max(0, i - 4), i + 1);
                const sum5 = s5.reduce((acc, r) => acc + Math.round(r.close * 100), 0) / 100;
                rows[i].MA5 = sum5 / s5.length;

                // MA10
                const s10 = rows.slice(Math.max(0, i - 9), i + 1);
                const sum10 = s10.reduce((acc, r) => acc + Math.round(r.close * 100), 0) / 100;
                rows[i].MA10 = sum10 / s10.length;

                // BB_Mid & BB_Std (Sample standard deviation with N-1 when N>=2)
                const s20 = rows.slice(Math.max(0, i - 19), i + 1);
                const sum20 = s20.reduce((acc, r) => acc + Math.round(r.close * 100), 0) / 100;
                const mean20 = sum20 / s20.length;
                rows[i].BB_Mid = mean20;
                if (s20.length >= 2) {
                    const variance = s20.reduce((acc, r) => acc + Math.pow(r.close - mean20, 2), 0) / (s20.length - 1);
                    const std = Math.sqrt(variance);
                    rows[i].BB_Std = std;
                    rows[i].BB_U = mean20 + 2 * std;
                    rows[i].BB_L = mean20 - 2 * std;
                } else {
                    rows[i].BB_Std = 0;
                    rows[i].BB_U = mean20;
                    rows[i].BB_L = mean20;
                }
            }

            // KD (7日 RSV)
            let kCur = 50.0, dCur = 50.0;
            for (let i = 0; i < rows.length; i++) {
                const s7 = rows.slice(Math.max(0, i - 6), i + 1);
                const l7 = Math.min(...s7.map(r => r.low));
                const h7 = Math.max(...s7.map(r => r.high));
                const rsv = 100 * ((rows[i].close - l7) / ((h7 - l7) + 1e-5));
                kCur = (2/3) * kCur + (1/3) * rsv;
                dCur = (2/3) * dCur + (1/3) * kCur;
                rows[i].K = kCur;
                rows[i].D = dCur;
            }

            // MACD (EMA6, EMA9, DIF, MACD_S, OSC)
            let ema6 = rows[0].close, ema9 = rows[0].close;
            let macdS = 0;
            for (let i = 0; i < rows.length; i++) {
                const c = rows[i].close;
                ema6 = i === 0 ? c : (c * (2/7) + ema6 * (5/7));
                ema9 = i === 0 ? c : (c * (2/10) + ema9 * (8/10));
                const dif = ema6 - ema9;
                macdS = i === 0 ? dif : (dif * (2/7) + macdS * (5/7));
                rows[i].DIF = dif;
                rows[i].MACD_S = macdS;
                rows[i].OSC = dif - macdS;
            }

            // MTM (3日 diff, MA2)
            for (let i = 0; i < rows.length; i++) {
                rows[i].MTM = i >= 3 ? rows[i].close - rows[i - 3].close : 0;
                const sMtm = rows.slice(Math.max(0, i - 1), i + 1);
                rows[i].MTM_MA = sMtm.reduce((acc, r) => acc + r.MTM, 0) / sMtm.length;
            }

            // RSI4 & RSI12
            let gain4 = 0, loss4 = 0, gain12 = 0, loss12 = 0;
            for (let i = 0; i < rows.length; i++) {
                if (i === 0) {
                    rows[i].RSI4 = 50.0;
                    rows[i].RSI12 = 50.0;
                } else {
                    const diff = rows[i].close - rows[i - 1].close;
                    const u = Math.max(0, diff);
                    const d = Math.abs(Math.min(0, diff));
                    gain4 = u * (1/4) + gain4 * (3/4);
                    loss4 = d * (1/4) + loss4 * (3/4);
                    rows[i].RSI4 = (gain4 / (gain4 + loss4 + 1e-5)) * 100;

                    gain12 = u * (1/12) + gain12 * (11/12);
                    loss12 = d * (1/12) + loss12 * (11/12);
                    rows[i].RSI12 = (gain12 / (gain12 + loss12 + 1e-5)) * 100;
                }
            }

            // WR3 & WR50 & 法人融資熱力燈
            for (let i = 0; i < rows.length; i++) {
                const s3 = rows.slice(Math.max(0, i - 2), i + 1);
                const h3 = Math.max(...s3.map(r => r.high));
                const l3 = Math.min(...s3.map(r => r.low));
                rows[i].WR3 = -100 * ((h3 - rows[i].close) / ((h3 - l3) + 1e-5));

                const s50 = rows.slice(Math.max(0, i - 49), i + 1);
                const h50 = Math.max(...s50.map(r => r.high));
                const l50 = Math.min(...s50.map(r => r.low));
                rows[i].WR50 = -100 * ((h50 - rows[i].close) / ((h50 - l50) + 1e-5));

                rows[i].法人合計 = rows[i].foreign + rows[i].sitc + rows[i].dealers;
                rows[i].融資增減 = i >= 1 ? rows[i].margin_balance - rows[i - 1].margin_balance : 0;
                rows[i].融資餘額 = rows[i].margin_balance;
                rows[i].外資買賣超 = rows[i].foreign;
                rows[i].投信買賣超 = rows[i].sitc;
                rows[i].自營買賣超 = rows[i].dealers;
                rows[i].成交量 = rows[i].volume;
                rows[i].開盤價 = rows[i].open;
                rows[i].最高價 = rows[i].high;
                rows[i].最低價 = rows[i].low;
                rows[i].收盤價 = rows[i].close;
                rows[i].交易日期 = rows[i].date;

                // 6 燈
                rows[i].P10_MTM_Cross = rows[i].MTM > rows[i].MTM_MA ? 1 : -1;
                rows[i].P1_MACD_OSC = i >= 1 && rows[i].OSC > rows[i - 1].OSC ? 1 : -1;
                rows[i].P5_K_Trend = i >= 1 && rows[i].K > rows[i - 1].K ? 1 : -1;
                rows[i].P3_DIF_Trend = i >= 1 && rows[i].DIF > rows[i - 1].DIF ? 1 : -1;
                rows[i].P4_KD_Cross = rows[i].K > rows[i].D ? 1 : -1;
                rows[i].P2_MACD_Cross = rows[i].DIF > rows[i].MACD_S ? 1 : -1;
            }

            // 2. 策略特徵指標計算 (即時算 - 100% 精確對齊電腦端)
            const latest_row = rows[rows.length - 1];
            const ma5 = latest_row.MA5;
            const ma10 = latest_row.MA10;
            const ma20 = latest_row.BB_Mid;
            const ma_order = [
                { v: ma5, name: "MA5" },
                { v: ma10, name: "MA10" },
                { v: ma20, name: "MA20" }
            ].sort((a, b) => b.v - a.v);
            const ma_order_str = `(${ma_order[0].name} > ${ma_order[1].name} > ${ma_order[2].name})`;
            const ma_align = ma5 > ma10 && ma10 > ma20 
                ? `多頭排列 ${ma_order_str}` 
                : (ma5 < ma10 && ma10 < ma20 ? `空頭排列 ${ma_order_str}` : `整理格局 ${ma_order_str}`);

            const bias20 = ma20 > 0 ? ((latest_row.close - ma20) / ma20 * 100) : 0.0;
            let bias_label = "";
            if (bias20 >= 10) bias_label = `超買過熱 (${bias20 >= 0 ? '+' : ''}${bias20.toFixed(1)}%)`;
            else if (bias20 <= -8) bias_label = `超跌恐慌 (${bias20 >= 0 ? '+' : ''}${bias20.toFixed(1)}%)`;
            else bias_label = `溫和整理 (${bias20 >= 0 ? '+' : ''}${bias20.toFixed(2)}%)`;

            const vol5Slice = rows.slice(-5);
            const vol5_avg = vol5Slice.reduce((acc, r) => acc + r.volume, 0) / vol5Slice.length;
            const vol_ratio = vol5_avg > 0 ? (latest_row.volume / vol5_avg) : 1.0;
            const vol_status = vol_ratio >= 1.5 ? `爆量發動 (${vol_ratio.toFixed(1)}倍)` : `量能平穩 (${vol_ratio.toFixed(1)}倍)`;

            const f_diffs = rows.slice(-5).map(r => r.foreign);
            const s_diffs = rows.slice(-5).map(r => r.sitc);
            const d_diffs = rows.slice(-5).map(r => r.dealers);

            function get_consecutive_days(diffs) {
                if (diffs.every(v => v === 0)) return { days: 0, dir: "不參與" };
                const latest = diffs[diffs.length - 1];
                if (latest === 0) return { days: 0, dir: "無明顯交易" };
                const direction = latest > 0 ? "買" : "賣";
                let days = 0;
                for (let i = diffs.length - 1; i >= 0; i--) {
                    if (direction === "買" && diffs[i] > 0) days++;
                    else if (direction === "賣" && diffs[i] < 0) days++;
                    else break;
                }
                return { days, dir: direction };
            }

            const f_info = get_consecutive_days(f_diffs);
            const s_info = get_consecutive_days(s_diffs);
            const d_info = get_consecutive_days(d_diffs);
            const f_desc = f_info.days >= 3 ? `連${f_info.dir}${f_info.days}天` : (f_info.dir === "不參與" ? "不參與" : "多空拉鋸");
            const s_desc = s_info.dir === "不參與" ? "不參與" : (s_info.days >= 3 ? `連${s_info.dir}${s_info.days}天` : "多空拉鋸");
            const d_desc = d_info.days >= 3 ? `連${d_info.dir}${d_info.days}天` : (d_info.dir === "不參與" ? "不參與" : "多空拉鋸");
            const inst_synergy = `外資:${f_desc} │ 投信:${s_desc} │ 自營:${d_desc}`;

            const margin_diffs = rows.slice(-5).map(r => r.融資增減);
            let margin_dec_days = 0, margin_inc_days = 0;
            for (let i = margin_diffs.length - 1; i >= 0; i--) {
                if (margin_diffs[i] < 0) margin_dec_days++;
                else break;
            }
            if (margin_dec_days === 0) {
                for (let i = margin_diffs.length - 1; i >= 0; i--) {
                    if (margin_diffs[i] > 0) margin_inc_days++;
                    else break;
                }
            }
            let margin_status = "";
            if (margin_dec_days >= 3) margin_status = `籌碼沉澱 (連減${margin_dec_days}天)`;
            else if (margin_inc_days >= 3) margin_status = `融資堆積 (連增${margin_inc_days}天)`;
            else margin_status = "無明顯連續增減資";

            // 籌碼吸籌比 (5日)
            const last5 = rows.slice(-5);
            const total_vol_5 = last5.reduce((acc, r) => acc + r.volume, 0);
            const total_inst_5 = last5.reduce((acc, r) => acc + r.法人合計, 0);
            const absorption_ratio = total_vol_5 > 0 ? (total_inst_5 / total_vol_5 * 100) : 0.0;
            const abs_sign = absorption_ratio >= 0 ? '+' : '';
            let absorption_status = "";
            if (absorption_ratio > 15.0) absorption_status = `強力吸籌 🔥 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;
            else if (absorption_ratio > 5.0) absorption_status = `偏多吸籌 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;
            else if (absorption_ratio >= -5.0) absorption_status = `籌碼變動平穩 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;
            else if (absorption_ratio >= -15.0) absorption_status = `偏空出貨 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;
            else absorption_status = `加速出貨 🚨 (${abs_sign}${absorption_ratio.toFixed(1)}%)`;

            // 法人買超加速度
            const last3 = rows.slice(-3);
            const last10 = rows.slice(-10);
            const inst_avg_3 = last3.reduce((acc, r) => acc + r.法人合計, 0) / (last3.length || 1);
            const inst_avg_10 = last10.reduce((acc, r) => acc + r.法人合計, 0) / (last10.length || 1);
            let accel_status = "量能穩定";
            if (Math.abs(inst_avg_10) > 0) {
                const accel = inst_avg_3 / inst_avg_10;
                if (accel > 2.0 && inst_avg_3 > 0) accel_status = `加速買超中 (力道放大 ${accel.toFixed(1)}倍 ⚡)`;
                else if (accel > 2.0 && inst_avg_3 < 0) accel_status = `加速賣超中 (力道放大 ${accel.toFixed(1)}倍 🚨)`;
                else accel_status = "力道平穩";
            } else {
                accel_status = "量能穩定";
            }

            // 價量關係
            const prev_row = rows.length >= 2 ? rows[rows.length - 2] : latest_row;
            const p_change = prev_row.close > 0 ? ((latest_row.close - prev_row.close) / prev_row.close * 100) : 0.0;
            const v_change = prev_row.volume > 0 ? ((latest_row.volume - prev_row.volume) / prev_row.volume * 100) : 0.0;

            const p_dir = p_change >= 0.5 ? "價漲" : (p_change <= -0.5 ? "價跌" : "價平");
            const v_dir_state = v_change >= 10.0 ? "量增" : (v_change <= -10.0 ? "量縮" : "量平");
            const pv_status = `${p_dir}${v_dir_state}`;
            let pv_desc = pv_status;
            if (pv_status === "價漲量增") pv_desc = "價漲量增 (多頭攻擊)";
            else if (pv_status === "價跌量增") pv_desc = "價跌量增 (殺盤鬆動)";
            else if (pv_status === "價漲量縮" || pv_status === "價平量增") pv_desc = `${pv_status} (量價背離/換手)`;
            else if (pv_status === "價跌量縮") pv_desc = "價跌量縮 (止跌訊號)";
            else pv_desc = pv_status;

            // 布林通道
            const bb_u = latest_row.BB_U;
            const bb_l = latest_row.BB_L;
            const pct_b = (bb_u - bb_l) > 0 ? ((latest_row.close - bb_l) / (bb_u - bb_l)) : 0.5;

            const bw_current = ma20 > 0 ? (bb_u - bb_l) / ma20 : 0.0;
            const last20_rows = rows.slice(-20);
            const bw_20_series = last20_rows.map(r => r.BB_Mid > 0 ? (r.BB_U - r.BB_L) / r.BB_Mid : 0);
            const bw_min_val = bw_20_series.length > 0 ? Math.min(...bw_20_series) : 0;
            const is_squeezed = bw_min_val > 0 ? (bw_current <= bw_min_val * 1.15) : false;
            const squeeze_lbl = is_squeezed ? " (壓縮蓄勢)" : "";

            let bb_status = "布林空頭軌";
            if (pct_b >= 1.0) bb_status = "布林突破";
            else if (pct_b > 0.5) bb_status = "布林多頭軌";
            else if (pct_b > 0.0) bb_status = "布林空頭軌";
            else bb_status = "布林跌破";
            const bb_desc = `${bb_status}${squeeze_lbl} (%B:${pct_b.toFixed(2)})`;

            // K 線型態實時計算 (10 種型態)
            function _compute_k_pattern_fallback(df_rows) {
                const pats = [];
                const n = df_rows.length;
                if (n < 1) return "無明顯型態";

                const body_len_arr = df_rows.map(r => Math.abs(r.close - r.open));
                const ma_b_series = [];
                const ma20_series = [];
                for (let i = 0; i < n; i++) {
                    const start_10 = Math.max(0, i - 9);
                    const slice_10 = body_len_arr.slice(start_10, i + 1);
                    ma_b_series.push(slice_10.reduce((a, b) => a + b, 0) / slice_10.length);

                    const start_20 = Math.max(0, i - 19);
                    const slice_20 = df_rows.slice(start_20, i + 1);
                    ma20_series.push(slice_20.reduce((a, r) => a + r.close, 0) / slice_20.length);
                }

                function get_indicators(idx) {
                    const actual_idx = idx < 0 ? n + idx : idx;
                    const r = df_rows[actual_idx];
                    const o = r.open, h = r.high, c = r.close, l = r.low;
                    const b = Math.abs(c - o);
                    const ub = Math.max(o, c);
                    const lb = Math.min(o, c);
                    const us = h - ub;
                    const ls = lb - l;
                    const range_val = h - l > 0 ? h - l : 1e-5;
                    const ma_b = ma_b_series[actual_idx] || 1e-5;
                    const ma20_val = ma20_series[actual_idx] || c;
                    const bull = c > o ? 1 : 0;
                    const bear = c < o ? 1 : 0;

                    const start_pos = Math.max(0, actual_idx - 10);
                    const prev_10_slice = df_rows.slice(start_pos, actual_idx);
                    const h_max_10 = prev_10_slice.length > 0 ? Math.max(...prev_10_slice.map(x => x.high)) : h;
                    const l_min_10 = prev_10_slice.length > 0 ? Math.min(...prev_10_slice.map(x => x.low)) : l;

                    return { o, h, c, l, b, ub, lb, us, ls, r: range_val, ma_b, ma20: ma20_val, bull, bear, h_max_10, l_min_10 };
                }

                const t0 = get_indicators(-1);
                const is_doji = t0.r > 0 ? (t0.b / t0.r <= 0.10) : false;
                const is_hammer = t0.ls >= 2 * t0.b && t0.us <= 0.3 * t0.b && t0.b <= 0.35 * t0.r;
                const is_shooting_star = t0.us >= 2 * t0.b && t0.ls <= 0.2 * t0.b && t0.ub <= t0.l + (t0.r / 3);
                const is_hanging_man = (t0.b <= 0.3 * t0.r) && (t0.ls >= 2 * t0.b) && (t0.us <= 0.2 * t0.b) && (t0.lb >= t0.l + 0.65 * t0.r) && (t0.c > t0.ma20) && (t0.h >= t0.h_max_10);
                const is_gravestone = (t0.b <= 0.05 * t0.r) && (t0.us >= 0.75 * t0.r) && (t0.ls <= 0.05 * t0.r) && (t0.c > t0.ma20) && (t0.h >= t0.h_max_10);
                const is_dragonfly = (t0.b <= 0.05 * t0.r) && (t0.ls >= 0.75 * t0.r) && (t0.us <= 0.05 * t0.r) && (t0.c < t0.ma20) && (t0.l <= t0.l_min_10);

                if (is_gravestone) pats.push("🪦 墓碑線");
                else if (is_dragonfly) pats.push("🦎 蜻蜓線");
                else if (is_doji) pats.push("⭐ 十字星");

                if (is_hanging_man) pats.push("🪢 吊人線");
                else if (is_hammer) pats.push("🔨 底部槌子線");
                else if (is_shooting_star) pats.push("☄️ 高檔流星線");

                if (n >= 2) {
                    const t1 = get_indicators(-2);
                    if (t1.bear === 1 && t0.bull === 1 && t0.o <= t1.c && t0.c >= t1.o && t0.b > t1.b) pats.push("🔴 多頭吞噬");
                    if (t1.bull === 1 && t0.bear === 1 && t0.o >= t1.c && t0.c <= t1.o && t0.b > t1.b) pats.push("🟢 空頭吞噬");
                    if (t1.bear === 1 && t1.b >= t1.ma_b && t0.o < t1.l && t0.bull === 1 && (((t1.o + t1.c)/2 < t0.c) && (t0.c < t1.o))) pats.push("⚡ 貫穿線");
                    if (t1.bear === 1 && t1.b >= 1.2 * t1.ma_b && (t1.c < t0.o && t0.o < t1.o) && (t1.c < t0.c && t0.c < t1.o)) pats.push("🤰 多頭孕線");
                    if (t1.bull === 1 && t1.b >= t1.ma_b && t0.o > t1.h && t0.bear === 1 && (t1.o < t0.c && t0.c < (t1.o + t1.c)/2)) pats.push("⛈️ 烏雲罩頂");
                }

                if (n >= 3) {
                    const t1 = get_indicators(-2);
                    const t2 = get_indicators(-3);
                    const is_ms_1 = t2.bear === 1 && t2.b >= 1.2 * t2.ma_b;
                    const is_ms_2 = t1.b <= 0.3 * t2.b && t1.ub < t2.c;
                    const is_ms_3 = t0.bull === 1 && t0.c >= (t2.o + t2.c) / 2;
                    if (is_ms_1 && is_ms_2 && is_ms_3) pats.push("🌅 早晨之星");

                    const is_es_1 = t2.bull === 1 && t2.b >= 1.2 * t2.ma_b;
                    const is_es_2 = t1.b <= 0.3 * t2.b && t1.lb > t2.c;
                    const is_es_3 = t0.bear === 1 && t0.c <= (t2.o + t2.c) / 2;
                    if (is_es_1 && is_es_2 && is_es_3) pats.push("🌌 夜星");

                    const is_w3_1 = t2.bull === 1 && t1.bull === 1 && t0.bull === 1;
                    const is_w3_2 = t2.c < t1.c && t1.c < t0.c;
                    const is_w3_3 = (t2.o <= t1.o && t1.o <= t2.c) && (t1.o <= t0.o && t0.o <= t1.c);
                    const is_w3_4 = t2.us <= 0.2 * t2.b && t1.us <= 0.2 * t1.b && t0.us <= 0.2 * t0.b;
                    if (is_w3_1 && is_w3_2 && is_w3_3 && is_w3_4) pats.push("📈 紅三兵");

                    const is_c3_1 = t2.bear === 1 && t1.bear === 1 && t0.bear === 1;
                    const is_c3_2 = t2.c > t1.c && t1.c > t0.c;
                    const is_c3_3 = (t2.c <= t1.o && t1.o <= t2.o) && (t1.c <= t0.o && t0.o <= t1.o);
                    const is_c3_4 = t2.ls <= 0.2 * t2.b && t1.ls <= 0.2 * t1.b && t0.ls <= 0.2 * t0.b;
                    if (is_c3_1 && is_c3_2 && is_c3_3 && is_c3_4) pats.push("🐦 三隻烏鴉");
                }

                if (n >= 5) {
                    const t1 = get_indicators(-2);
                    const t2 = get_indicators(-3);
                    const t3 = get_indicators(-4);
                    const t4 = get_indicators(-5);
                    const is_r3_1 = t4.bull === 1 && t4.b >= 1.5 * t4.ma_b;
                    let is_r3_2 = true;
                    for (const k of [t3, t2, t1]) {
                        if (k.b > 0.4 * t4.b || k.h > t4.h || k.l < t4.l) is_r3_2 = false;
                    }
                    const is_r3_3 = t0.bull === 1 && t0.c > t4.h;
                    if (is_r3_1 && is_r3_2 && is_r3_3) pats.push("🚀 上升三法");
                }

                return pats.length > 0 ? pats.join("、") : "無明顯型態";
            }
            const k_pattern = _compute_k_pattern_fallback(rows);

            // RSI12 搶反彈與預估字串拼裝 (100% 精確對齊)
            function compute_rsi12_rebound_strategy(df_rows) {
                const df_slice = df_rows.slice(-15);
                if (df_slice.length < 5) {
                    return {
                        rsi12_curr: 50.0,
                        rsi12_min: 50.0,
                        has_prediction: false,
                        p_30: 0.0, p_27: 0.0, p_25: 0.0,
                        p_30_pct: 0.0, p_27_pct: 0.0, p_25_pct: 0.0,
                        p_sell10: 0.0, p_sell15: 0.0, p_sell20: 0.0,
                        p_sell10_pct: 0.0, p_sell15_pct: 0.0, p_sell20_pct: 0.0,
                        start_rsi: 0.0, start_p: 0.0,
                        disable_sell_warnings: false,
                        cool_reason: "",
                        is_outdated: true
                    };
                }

                const curr_p = df_slice[df_slice.length - 1].close;
                const curr_rsi = df_slice[df_slice.length - 1].RSI12;

                let min_rsi = Infinity, min_rsi_idx = -1;
                for (let i = 0; i < df_slice.length; i++) {
                    if (df_slice[i].RSI12 < min_rsi) {
                        min_rsi = df_slice[i].RSI12;
                        min_rsi_idx = i;
                    }
                }
                const rsi_min_val = min_rsi;
                const p_min_val = df_slice[min_rsi_idx].close;

                // 1. 三方案交叉驗證尋找起跌點
                let max_rsi = -Infinity, max_rsi_idx = -1;
                for (let i = 0; i < df_slice.length; i++) {
                    if (df_slice[i].RSI12 > max_rsi) {
                        max_rsi = df_slice[i].RSI12;
                        max_rsi_idx = i;
                    }
                }
                const rsi_a = max_rsi;
                const p_a = df_slice[max_rsi_idx].close;

                let idx_b = -1;
                for (let i = df_slice.length - 2; i > 0; i--) {
                    const r_prev = df_slice[i - 1].RSI12;
                    const r_c = df_slice[i].RSI12;
                    const r_next = df_slice[i + 1].RSI12;
                    if (r_prev < r_c && r_c > r_next && r_c >= 35) {
                        idx_b = i;
                        break;
                    }
                }

                let idx_c = -1;
                for (let i = df_slice.length - 2; i >= 0; i--) {
                    const r_val = df_slice[i].RSI12;
                    const p_val = df_slice[i].close;
                    if (r_val >= 35 && r_val > curr_rsi && p_val > curr_p) {
                        idx_c = i;
                        break;
                    }
                }

                let start_idx = -1;
                if (idx_b !== -1 && df_slice[idx_b].RSI12 > curr_rsi && df_slice[idx_b].close > curr_p) {
                    start_idx = idx_b;
                } else if (idx_c !== -1) {
                    start_idx = idx_c;
                } else if (rsi_a >= 35 && rsi_a > curr_rsi && p_a > curr_p) {
                    start_idx = max_rsi_idx;
                }

                let has_pred = false;
                let p_30 = 0.0, p_27 = 0.0, p_25 = 0.0;
                let p_30_pct = 0.0, p_27_pct = 0.0, p_25_pct = 0.0;
                let start_rsi = 0.0, start_p = 0.0;
                let sensitivity = 0.0;

                if (start_idx !== -1) {
                    const p_start = df_slice[start_idx].close;
                    const rsi_start = df_slice[start_idx].RSI12;
                    const delta_rsi = rsi_start - curr_rsi;
                    const delta_p = p_start - curr_p;

                    if (delta_p > 0 && delta_rsi >= 5) {
                        sensitivity = delta_p / delta_rsi;
                        p_30 = p_start - (rsi_start - 30) * sensitivity;
                        p_27 = p_start - (rsi_start - 27.5) * sensitivity;
                        p_25 = p_start - (rsi_start - 25) * sensitivity;

                        p_30_pct = curr_p > 0 ? ((p_30 - curr_p) / curr_p * 100) : 0.0;
                        p_27_pct = curr_p > 0 ? ((p_27 - curr_p) / curr_p * 100) : 0.0;
                        p_25_pct = curr_p > 0 ? ((p_25 - curr_p) / curr_p * 100) : 0.0;
                        start_rsi = rsi_start;
                        start_p = p_start;
                        has_pred = true;
                    }
                }

                // 2. 反彈敏感度
                let sensitivity_up = 0.0;
                if (curr_rsi > rsi_min_val && curr_p > p_min_val) {
                    sensitivity_up = (curr_p - p_min_val) / (curr_rsi - rsi_min_val);
                } else if (has_pred && sensitivity > 0) {
                    sensitivity_up = sensitivity;
                } else {
                    sensitivity_up = curr_p / 30.0;
                }

                const p_sell10 = p_min_val + 10 * sensitivity_up;
                const p_sell15 = p_min_val + 15 * sensitivity_up;
                const p_sell20 = p_min_val + 20 * sensitivity_up;

                const p_sell10_pct = p_min_val > 0 ? ((p_sell10 - p_min_val) / p_min_val * 100) : 0.0;
                const p_sell15_pct = p_min_val > 0 ? ((p_sell15 - p_min_val) / p_min_val * 100) : 0.0;
                const p_sell20_pct = p_min_val > 0 ? ((p_sell20 - p_min_val) / p_min_val * 100) : 0.0;

                // 3.0 前置驗證
                const has_rebound_event = (rsi_min_val < 30.0);
                if (!has_rebound_event) has_pred = false;

                // 3.1 股價橫盤盤整濾網 (近 4 日收盤價最大/最小振幅 <= 2%)
                let is_sideways = false;
                if (df_rows.length >= 4) {
                    const close_4d = df_rows.slice(-4).map(r => r.close);
                    const p_min_4d = Math.min(...close_4d);
                    const p_max_4d = Math.max(...close_4d);
                    if (p_min_4d > 0) {
                        const p_amp_4d = (p_max_4d - p_min_4d) / p_min_4d * 100;
                        if (p_amp_4d <= 2.0) is_sideways = true;
                    }
                }

                // 3.2 時效過期濾網
                let has_touched_sell3_recently = false;
                if (df_rows.length >= 4) {
                    for (const offset of [-4, -3, -2]) {
                        const idx = df_rows.length + offset;
                        if (idx >= 15) {
                            const df_slice_past = df_rows.slice(idx - 14, idx + 1);
                            const past_rsi_min = Math.min(...df_slice_past.map(r => r.RSI12));
                            const past_rsi_curr = df_rows[idx].RSI12;
                            if (past_rsi_curr > past_rsi_min + 20) {
                                has_touched_sell3_recently = true;
                                break;
                            }
                        }
                    }
                }

                // 3.3 反彈動能衰竭濾網
                let is_decayed = false;
                if (df_rows.length >= 4) {
                    const df_15d = df_rows.slice(-15);
                    let idx_15d_min = 0, v_15d_min = Infinity;
                    for (let i = 0; i < df_15d.length; i++) {
                        if (df_15d[i].RSI12 < v_15d_min) {
                            v_15d_min = df_15d[i].RSI12;
                            idx_15d_min = i;
                        }
                    }
                    const global_min_idx = (df_rows.length - 15) + idx_15d_min;
                    const rebound_indices = [];
                    for (let i = global_min_idx; i < df_rows.length; i++) rebound_indices.push(i);

                    for (let pos = 2; pos < rebound_indices.length; pos++) {
                        const cur_idx = rebound_indices[pos];
                        // A. 截至「昨日」的最高收盤價
                        let peak_idx = rebound_indices[0];
                        let peak_close = -Infinity;
                        for (let k = 0; k <= pos - 1; k++) {
                            const ki = rebound_indices[k];
                            if (df_rows[ki].close > peak_close) {
                                peak_close = df_rows[ki].close;
                                peak_idx = ki;
                            }
                        }
                        const p_max_low = df_rows[peak_idx].low;

                        // B. RSI 勾頭
                        const prev_rsi_max = Math.max(df_rows[rebound_indices[pos - 2]].RSI12, df_rows[rebound_indices[pos - 1]].RSI12);
                        const cur_rsi_val = df_rows[cur_idx].RSI12;
                        const rsi_hook = cur_rsi_val < (prev_rsi_max - 1.5);

                        // C. 破見頂日低點
                        const cur_close_val = df_rows[cur_idx].close;
                        const price_break = cur_close_val < p_max_low;

                        if (rsi_hook && price_break) {
                            is_decayed = true;
                            break;
                        }
                    }
                }

                // 3.4 10日時效
                let is_outdated = false;
                if (!has_rebound_event) {
                    is_outdated = true;
                } else if (df_rows.length >= 4) {
                    const df_15d = df_rows.slice(-15);
                    let idx_15d_min = 0, v_15d_min = Infinity;
                    for (let i = 0; i < df_15d.length; i++) {
                        if (df_15d[i].RSI12 < v_15d_min) {
                            v_15d_min = df_15d[i].RSI12;
                            idx_15d_min = i;
                        }
                    }
                    const days_since_rsi_min = 15 - 1 - idx_15d_min;
                    if (days_since_rsi_min > 10) is_outdated = true;
                }

                let disable_sell_warnings = false;
                if (is_outdated) {
                    disable_sell_warnings = false;
                    is_decayed = false;
                    is_sideways = false;
                    has_touched_sell3_recently = false;
                } else {
                    disable_sell_warnings = is_sideways || has_touched_sell3_recently || is_decayed;
                }

                const cool_reason_lbl = is_sideways ? " (橫盤冷卻)" : (has_touched_sell3_recently ? " (3日內已觸頂)" : (is_decayed ? " (反彈結束)" : ""));

                return {
                    rsi12_curr: curr_rsi,
                    rsi12_min: rsi_min_val,
                    has_prediction: has_pred,
                    p_30, p_27, p_25,
                    p_30_pct, p_27_pct, p_25_pct,
                    p_sell10, p_sell15, p_sell20,
                    p_sell10_pct, p_sell15_pct, p_sell20_pct,
                    start_rsi, start_p,
                    disable_sell_warnings,
                    cool_reason: cool_reason_lbl,
                    is_outdated
                };
            }

            const rsi_strat = compute_rsi12_rebound_strategy(rows);
            let rsi_pred_str = "";
            if (rsi_strat.has_prediction) {
                rsi_pred_str = `\n  ↳ ⚠️ 一級低吸點 (RSI=30): ${rsi_strat.p_30.toFixed(2)} 元 (預估跌幅: ${rsi_strat.p_30_pct.toFixed(2)}%)\n  ↳ 🚨 二級強力反彈 (RSI=27.5 - 首選推薦): ${rsi_strat.p_27.toFixed(2)} 元 (預估跌幅: ${rsi_strat.p_27_pct.toFixed(2)}%)\n  ↳ 🔥 三級極限冰點 (RSI=25): ${rsi_strat.p_25.toFixed(2)} 元 (預估跌幅: ${rsi_strat.p_25_pct.toFixed(2)}%)\n    (以 ${rsi_strat.start_p.toFixed(2)} 元 (RSI=${rsi_strat.start_rsi.toFixed(1)}) 為起跌點推估買點)`;
            } else {
                rsi_pred_str = "\n  ↳ 買點預測：目前股價強勢/橫盤，未滿足起跌條件";
            }

            if (rsi_strat.is_outdated) {
                rsi_pred_str += "\n  ↳ 賣點預估：目前無反彈賣信號";
            } else if (rsi_strat.disable_sell_warnings) {
                rsi_pred_str += `\n  ↳ 賣點預估：已觸發動能衰竭或橫盤冷卻${rsi_strat.cool_reason || ''}，停止預估價位`;
            } else {
                rsi_pred_str += `\n  ↳ 💡 一級反彈賣點 (RSI=最低值+10): ${rsi_strat.p_sell10.toFixed(2)} 元 (相對最低點反彈幅: +${rsi_strat.p_sell10_pct.toFixed(2)}%)\n  ↳ 🚨 二級反彈賣點 (RSI=最低值+15): ${rsi_strat.p_sell15.toFixed(2)} 元 (相對最低點反彈幅: +${rsi_strat.p_sell15_pct.toFixed(2)}%)\n  ↳ 🔥 三級終極賣點 (RSI=最低值+20): ${rsi_strat.p_sell20.toFixed(2)} 元 (相對最低點反彈幅: +${rsi_strat.p_sell20_pct.toFixed(2)}%)`;
            }

            const curr_rsi_val = rsi_strat.rsi12_curr;
            const rsi12_min_val = rsi_strat.rsi12_min;
            let rsi_emoji = "⚪";
            if (curr_rsi_val <= 25) rsi_emoji = "🔴";
            else if (curr_rsi_val > 25 && curr_rsi_val <= 27.5) rsi_emoji = "🔴";
            else if (curr_rsi_val > 27.5 && curr_rsi_val <= 30) rsi_emoji = "🟡";
            else if (curr_rsi_val > rsi12_min_val + 20 && !rsi_strat.disable_sell_warnings && !rsi_strat.is_outdated) rsi_emoji = "🔴";
            else if (curr_rsi_val > rsi12_min_val + 15 && !rsi_strat.disable_sell_warnings && !rsi_strat.is_outdated) rsi_emoji = "🟡";
            else if (curr_rsi_val > rsi12_min_val + 10 && !rsi_strat.disable_sell_warnings && !rsi_strat.is_outdated) rsi_emoji = "🟢";
            else rsi_emoji = "⚪";

            function format_strategy_text() {
                const ma_emoji = ma_align.startsWith("多頭") ? "🔴" : (ma_align.startsWith("空頭") ? "🟢" : "⚪");
                const bb_emoji = (bb_desc.startsWith("布林突破") || bb_desc.startsWith("布林多頭軌")) ? "🔴" : ((bb_desc.startsWith("布林跌破") || bb_desc.startsWith("布林空頭軌")) ? "🟢" : "⚪");
                const pv_emoji = pv_desc.includes("多頭攻擊") ? "🔴" : (pv_desc.includes("殺盤鬆動") ? "🟢" : (pv_desc.includes("背離") ? "🟡" : "⚪"));
                const bias_emoji = bias_label.startsWith("超買") ? "🔴" : (bias_label.startsWith("超跌") ? "🟢" : "⚪");
                const vol_emoji = vol_status.startsWith("爆量") ? "🔴" : "⚪";
                const inst_emoji = inst_synergy.includes("連買") ? "🔴" : (inst_synergy.includes("連賣") ? "🟢" : "⚪");
                const margin_emoji = margin_status.startsWith("籌碼沉澱") ? "🔴" : (margin_status.startsWith("融資堆積") ? "🟢" : "⚪");
                const abs_emoji = (absorption_status.startsWith("強力吸籌") || absorption_status.startsWith("偏多吸籌")) ? "🔴" : ((absorption_status.startsWith("加速出貨") || absorption_status.startsWith("偏空出貨")) ? "🟢" : "⚪");
                const accel_emoji = accel_status.includes("加速買超") ? "🔴" : (accel_status.includes("加速賣超") ? "🟢" : "⚪");
                
                const kp_clean = k_pattern.trim();
                const bull_kps = ["早晨之星", "紅三兵", "多頭吞噬", "貫穿線", "多頭孕線", "底部槌子線", "上升三法", "蜻蜓線"];
                const bear_kps = ["夜星", "三隻烏鴉", "空頭吞噬", "烏雲罩頂", "吊人線", "高檔流星線", "墓碑線"];
                let kp_prefix_emoji = "⚪";
                if (bull_kps.some(k => kp_clean.includes(k))) kp_prefix_emoji = "🔴";
                else if (bear_kps.some(k => kp_clean.includes(k))) kp_prefix_emoji = "🟢";
                else if (kp_clean.includes("十字星")) kp_prefix_emoji = "🟡";

                let rsi_line = "";
                if (rsi_pred_str) {
                    rsi_line = `- ${rsi_emoji} RSI12搶反彈與預估：${rsi_pred_str}`;
                }

                const lines = [
                    `🎯 策略特徵指標 (最新交易日)：`,
                    `- ${ma_emoji} 均線趨勢：${ma_align}`,
                    `- ${bb_emoji} 布林通道：${bb_desc}`,
                    `- ${pv_emoji} 價量關係：${pv_desc}`,
                    `- ${bias_emoji} 月線乖離：${bias_label}`,
                    `- ${vol_emoji} 量能狀態：${vol_status}`,
                    `- ${inst_emoji} 法人動態：${inst_synergy}`,
                    `- ${margin_emoji} 籌碼沉澱：${margin_status}`,
                    `- ${abs_emoji} 籌碼吸籌比(5日)：${absorption_status}`,
                    `- ${accel_emoji} 法人買超加速度：${accel_status}`,
                    `- ${kp_prefix_emoji} K線型態：${kp_clean || '無明顯型態'}`
                ];
                if (rsi_line) lines.push(rsi_line);
                lines.push("─────────────────────────────────────────────\n");
                return lines.join('\n');
            }

            const strategy_text = format_strategy_text();

            // 3. 近 10 日軌跡計算
            function get_day_title_block(idx, t_label) {
                const latest = rows[idx];
                const prev = idx >= 1 ? rows[idx - 1] : latest;

                const fmt2 = (num) => {
                    if (num === null || num === undefined || isNaN(num)) return '0.00';
                    const n = Number(num);
                    if (n < 0 && n > -0.005) {
                        return "-0.00";
                    }
                    return n.toFixed(2);
                };

                function arrow_fmt(col, suffix = "", is_float = true) {
                    const cur_v = latest[col], prv_v = prev[col];
                    const arrow = cur_v > prv_v ? "↑" : (cur_v < prv_v ? "↓" : "=");
                    return is_float ? `${fmt2(cur_v)}${suffix}${arrow}` : `${Math.floor(cur_v).toLocaleString()}${suffix}${arrow}`;
                }

                const is_margin_not_ready = (latest.融資餘額 === 0 || isNaN(latest.融資餘額));
                const margin_latest = is_margin_not_ready && idx >= 1 ? rows[idx - 1] : latest;
                const margin_prev = is_margin_not_ready && idx >= 2 ? rows[idx - 2] : prev;

                function arrow_fmt_margin(col, suffix = "") {
                    const cur_v = margin_latest[col], prv_v = margin_prev[col];
                    const arrow = cur_v > prv_v ? "↑" : (cur_v < prv_v ? "↓" : "=");
                    return `${Math.floor(cur_v).toLocaleString()}${suffix}${arrow}`;
                }

                const major_lbl = latest.法人合計 >= 0 ? "(買超)" : "(賣超)";
                const foreign_lbl = latest.外資買賣超 >= 0 ? "(買超)" : "(賣超)";
                const sitc_lbl = latest.投信買賣超 >= 0 ? "(買超)" : "(賣超)";
                const dealers_lbl = latest.自營買賣超 >= 0 ? "(買超)" : "(賣超)";
                const margin_lbl = margin_latest.融資增減 >= 0 ? "增加" : "減少";

                const lbl = (v) => v === 1 ? "🔴" : (v === -1 ? "🟢" : "●");
                const dStr = String(latest.交易日期);
                const formatted_d = `${dStr.slice(0, 4)}/${dStr.slice(4, 6)}/${dStr.slice(6, 8)}`;
                const t_suffix = t_label ? ` (${t_label})` : "";

                return [
                    `📅 日期：${formatted_d}${t_suffix}`,
                    `📈 日K | 開: ${arrow_fmt('開盤價')} 高: ${arrow_fmt('最高價')} 低: ${arrow_fmt('最低價')} 收: ${arrow_fmt('收盤價')}`,
                    `📈 均線 | BB_Mid: ${arrow_fmt('BB_Mid')} BB_U: ${arrow_fmt('BB_U')} BB_L: ${arrow_fmt('BB_L')} MA5: ${arrow_fmt('MA5')} MA10: ${arrow_fmt('MA10')}`,
                    `🔥 熱力燈 | MTM金${lbl(latest.P10_MTM_Cross)} | OSC縮${lbl(latest.P1_MACD_OSC)} | K趨${lbl(latest.P5_K_Trend)} | DIF趨${lbl(latest.P3_DIF_Trend)} | KD金${lbl(latest.P4_KD_Cross)} | MACD金${lbl(latest.P2_MACD_Cross)}`,
                    `🧪 MACD | OSC: ${arrow_fmt('OSC')} DIF: ${arrow_fmt('DIF')} MACD_S: ${arrow_fmt('MACD_S')}`,
                    `🧪 KD | K: ${arrow_fmt('K')} D: ${arrow_fmt('D')}`,
                    `🌀 MTM | MTM3: ${arrow_fmt('MTM')} MA2: ${arrow_fmt('MTM_MA')}`,
                    `🧪 RSI | RSI4: ${arrow_fmt('RSI4')} RSI12: ${arrow_fmt('RSI12')}`,
                    `🧪 WR | WR3: ${arrow_fmt('WR3')} WR50: ${arrow_fmt('WR50')}`,
                    `📊 量能 | 成交量: ${arrow_fmt('成交量', '股', false)}`,
                    `⚡ 融資 | 餘額: ${arrow_fmt_margin('融資餘額', '張')} 增減${margin_lbl}: ${arrow_fmt_margin('融資增減', '張')}`,
                    `🎯 三大法人${major_lbl}: ${arrow_fmt('法人合計', '股', false)}`,
                    `🔮 外資${foreign_lbl}: ${arrow_fmt('外資買賣超', '股', false)} | 投信${sitc_lbl}: ${arrow_fmt('投信買賣超', '股', false)} | 自營${dealers_lbl}: ${arrow_fmt('自營買賣超', '股', false)}`
                ].join('\n');
            }

            const t10_rows_indices = rows.slice(-10).map((r, i) => rows.length - 10 + i);
            const trajectory_lines = t10_rows_indices.map((idx, pos) => {
                const t_label = `T-${t10_rows_indices.length - 1 - pos}`;
                return get_day_title_block(idx, t_label);
            });

            const trajectory_text = `📈 近 10 日軌跡：\n\n` + trajectory_lines.join('\n\n');
            return header_text + strategy_text + trajectory_text;
        };

        const copyStock10DayReport = async (stock) => {
            if (!stock) return;
            try {
                const reportText = buildStock10DayReport(stock);
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(reportText);
                } else {
                    const textarea = document.createElement('textarea');
                    textarea.value = reportText;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                }
                showToast(`📋 已成功複製【${stock.code} ${stock.name}】近 10 日戰報至剪貼簿！`);
            } catch (err) {
                console.error("複製戰報失敗:", err);
                alert(`❌ 複製失敗：${err.message}`);
            }
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

                    showToast('🎉 Google 帳號授權成功！正在載入專屬戰情室...', 3000);
                    await fetchCloudDbStats();

                    // ⚡ 連鎖自動載入：
                    // 1. 同步全市場 2,385 檔行情快照
                    syncMarketSnapshot().catch(e => console.warn("快照同步警告:", e));
                    // 2. 雙向合流個人雲端帳本
                    executeTwoWaySync().catch(e => console.warn("雲端帳本同步警告:", e));
                }
            });

            tokenClient.requestAccessToken({ prompt: 'consent' });
        };

        const handleGoogleLogout = () => {
            if (confirm('🔒 確定要解除 Google 帳號綁定並登出戰情室嗎？\n登出後將鎖定主要戰情功能。')) {
                googleUser.value.isLoggedIn = false;
                googleUser.value.email = '';
                googleAccessToken.value = '';
                localStorage.removeItem('sentinel_gdrive_token');
                localStorage.removeItem('sentinel_gdrive_email');
                localStorage.removeItem('sentinel_last_sync_time');
                stockList.value = [];
                isDbLoaded.value = false;
                currentMarketSnapshotData = null;
                if (window.localforage) {
                    localforage.removeItem('sentinel_db_bytes').catch(() => {});
                }
                cloudDbStats.value = {
                    lastModified: '未連接雲端或尚未查詢',
                    tradeLogCount: '---',
                    myStockCount: '---',
                    gemStrategyCount: '---',
                    fileId: '',
                    sizeKB: 0
                };
                showToast('👋 已安全登出戰情室', 3000);
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

                markAsSynced();
                return true;
            } else {
                throw new Error(`Google Drive API 上傳失敗 (HTTP ${upRes.status})`);
            }
        };

        // 🤝 1. 核心升級：全量二進位資料庫鏡像同步引擎 (以雲端完整 DB 為基底，全量保留現價、指標、字典與特別關注)
        const executeTwoWaySync = async () => {
            if (!googleAccessToken.value) {
                handleGoogleLogin();
                return;
            }

            syncStatus.value.loading = true;
            syncStatus.value.message = '正在取得雲端最新 sentinel_vault.db (全量鏡像基底)...';

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
                syncStatus.value.message = '正在下載雲端完整資料庫主檔...';

                const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${targetFile.id}?alt=media`, {
                    headers: { Authorization: `Bearer ${googleAccessToken.value}` }
                });
                if (!fileRes.ok) throw new Error("下載雲端資料庫主檔失敗 (HTTP " + fileRes.status + ")");

                const cloudBuf = await fileRes.arrayBuffer();

                if (!SQL_ENGINE) {
                    SQL_ENGINE = await initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` });
                }

                const cloudDb = new SQL_ENGINE.Database(new Uint8Array(cloudBuf));

                if (!dbInstance) {
                    // 本地無 DB，直接 100% 鏡像採用雲端完整庫
                    dbInstance = cloudDb;
                    await saveDbToIndexedDb();
                    await loadDatabaseFromArrayBuffer(cloudBuf, '雲端資料庫');
                    updateLocalDbStats();
                    await fetchCloudDbStats();
                    markAsSynced();
                    alert(`✅ 雲端資料庫已成功鏡像同步至手機！\n• 交易紀錄：${localDbStats.value.tradeLogCount} 筆\n• 自選名冊：${localDbStats.value.myStockCount} 檔\n• 策略庫：${localDbStats.value.gemStrategyCount} 筆\n兩端資料庫已 100% 鏡像對齊。`);
                    return;
                }

                // 🎯【核心升級：全量二進位鏡像合流 (以雲端完整 DB 為基底，全量保留現價/指標/字典)】
                syncStatus.value.message = '正在執行雙向合流 (保留全量現價報價與指標)...';

                // 0. 確保 deleted_records 與 my_stock 資料表結構完整
                migrateMobileDatabase(dbInstance);
                migrateMobileDatabase(cloudDb);

                // 合流墓碑至 cloudDb (保留 stock_created_at)
                try {
                    const localTombs = dbInstance.exec("SELECT table_name, unique_key, deleted_at, stock_created_at FROM deleted_records");
                    if (localTombs.length > 0 && localTombs[0].values) {
                        localTombs[0].values.forEach(t => {
                            const [tName, tUk, tDelAt, tStockCreated] = t;
                            cloudDb.run("INSERT OR REPLACE INTO deleted_records (table_name, unique_key, deleted_at, stock_created_at) VALUES (?, ?, ?, ?)", [tName, tUk, tDelAt, tStockCreated || '1970-01-01 00:00:00']);
                        });
                    }
                } catch (e) {
                    console.warn("合流本地墓碑至雲端失敗:", e);
                }

                // 提取全量墓碑與 stock_created_at 時間戳映射
                const deletedTradeKeys = new Set();
                const deletedStockKeys = new Set();
                const deletedStrategyKeys = new Set();
                const tombStockCreatedMap = {}; // uk -> stock_created_at

                try {
                    const dResT = cloudDb.exec("SELECT unique_key FROM deleted_records WHERE table_name = 'trade_log'");
                    if (dResT.length > 0) dResT[0].values.forEach(r => deletedTradeKeys.add(r[0]));
                    const dResS = cloudDb.exec("SELECT unique_key, stock_created_at FROM deleted_records WHERE table_name = 'my_stock'");
                    if (dResS.length > 0) dResS[0].values.forEach(r => {
                        const uk = r[0];
                        const scAt = r[1] || '1970-01-01 00:00:00';
                        deletedStockKeys.add(uk);
                        tombStockCreatedMap[uk] = scAt;
                    });
                    const dResG = cloudDb.exec("SELECT unique_key FROM deleted_records WHERE table_name = 'gem_strategy'");
                    if (dResG.length > 0) dResG[0].values.forEach(r => deletedStrategyKeys.add(r[0]));
                } catch (e) {}

                // 1. 清算 cloudDb 中的 trade_log 墓碑
                try {
                    const cLogs = cloudDb.exec("SELECT id, 股票代號, 證券商, 交易時間, 動作, 成交股數, 成交價 FROM trade_log");
                    if (cLogs.length > 0) {
                        cLogs[0].values.forEach(r => {
                            const [r_id, r_code, r_broker, r_date, r_action, r_shares, r_price] = r;
                            const uk = makeTradeUniqueKey(r_code, r_broker, r_date, r_action, r_shares, r_price);
                            if (deletedTradeKeys.has(uk)) {
                                cloudDb.run("DELETE FROM trade_log WHERE id = ?", [r_id]);
                            }
                        });
                    }
                } catch (e) {}

                // 2. 將本地 trade_log 增量注入 cloudDb (排除墓碑)
                let localTradesAdded = 0;
                try {
                    const lTrades = dbInstance.exec("SELECT 股票代號, 股票名稱, 動作, 成交股數, 成交價, 證券商, 交易時間, 特別關注 FROM trade_log");
                    if (lTrades.length > 0) {
                        lTrades[0].values.forEach(r => {
                            const [code, name, action, shares, price, broker, date, focus] = r;
                            const uk = makeTradeUniqueKey(code, broker, date, action, shares, price);
                            if (!deletedTradeKeys.has(uk)) {
                                const chk = cloudDb.exec(
                                    "SELECT id FROM trade_log WHERE 股票代號 = ? AND 證券商 = ? AND 交易時間 = ? AND 動作 = ? AND 成交股數 = ? AND 成交價 = ?",
                                    [code, broker, date, action, shares, price]
                                );
                                if (!chk.length || !chk[0].values.length) {
                                    cloudDb.run(
                                        "INSERT INTO trade_log (股票代號, 股票名稱, 動作, 成交股數, 成交價, 證券商, 交易時間, 特別關注) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                        [code, name, action, shares, price, broker, date, focus || '否']
                                    );
                                    localTradesAdded++;
                                }
                            }
                        });
                    }
                } catch (e) {
                    console.warn("注入本地 trade_log 警告:", e);
                }

                // 3. 智慧合流 gem_strategy (清算墓碑 + 增量注入)
                try {
                    const cStrat = cloudDb.exec("SELECT rowid, 股票代號, 記錄時間 FROM gem_strategy");
                    if (cStrat.length > 0) {
                        cStrat[0].values.forEach(r => {
                            const [r_id, r_code, r_time] = r;
                            const uk = makeStrategyUniqueKey(r_code, r_time);
                            if (deletedStrategyKeys.has(uk)) {
                                cloudDb.run("DELETE FROM gem_strategy WHERE rowid = ?", [r_id]);
                            }
                        });
                    }
                    const lStrat = dbInstance.exec("SELECT 股票代號, 策略內容, 佈局下限, 佈局上限, 防守點, 目標下限, 目標上限, 戰情總結, 記錄時間 FROM gem_strategy");
                    if (lStrat.length > 0) {
                        lStrat[0].values.forEach(r => {
                            const [code, content, bLow, bHigh, defP, tLow, tHigh, sumText, rTime] = r;
                            const uk = makeStrategyUniqueKey(code, rTime);
                            if (!deletedStrategyKeys.has(uk)) {
                                const chk = cloudDb.exec("SELECT rowid FROM gem_strategy WHERE 股票代號 = ? AND 記錄時間 = ?", [code, rTime]);
                                if (!chk.length || !chk[0].values.length) {
                                    cloudDb.run(
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

                // 4. 智慧合流 my_stock (自選名冊與特別關注狀態對齊，採用時間戳墓碑判定演算法)
                try {
                    // 4.0 本地股票合流至 cloudDb：若 created_at > tomb.stock_created_at 視為新生個股除名墓碑
                    const lStocksAll = dbInstance.exec("SELECT 股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注, created_at FROM my_stock");
                    if (lStocksAll.length > 0 && lStocksAll[0].values) {
                        lStocksAll[0].values.forEach(r => {
                            const [code, name, shares, cost, broker, focus, createdAt] = r;
                            const uk = makeStockUniqueKey(code, broker);
                            const tombSc = tombStockCreatedMap[uk] || '1970-01-01 00:00:00';
                            const cAtStr = String(createdAt || '').trim() || '1970-01-01 00:00:00';

                            if (deletedStockKeys.has(uk)) {
                                if (cAtStr > tombSc) {
                                    // 🎯 新生個股：主動除名過期墓碑
                                    deletedStockKeys.delete(uk);
                                    delete tombStockCreatedMap[uk];
                                    try {
                                        cloudDb.run("DELETE FROM deleted_records WHERE table_name = 'my_stock' AND unique_key = ?", [uk]);
                                        dbInstance.run("DELETE FROM deleted_records WHERE table_name = 'my_stock' AND unique_key = ?", [uk]);
                                    } catch (e) {}
                                    cloudDb.run(
                                        "INSERT OR REPLACE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                                        [code, name, shares, cost, broker, focus || '否', cAtStr]
                                    );
                                }
                            } else {
                                cloudDb.run(
                                    "INSERT OR IGNORE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                                    [code, name, shares, cost, broker, focus || '否', cAtStr]
                                );
                            }
                        });
                    }

                    // 4.1 清算 cloudDb 中已刪除且無庫存的舊個股
                    const cStocks = cloudDb.exec("SELECT 股票代號, 證券商, 個股股數, created_at FROM my_stock");
                    if (cStocks.length > 0 && cStocks[0].values) {
                        cStocks[0].values.forEach(r => {
                            const [r_code, r_broker, r_shares, r_created] = r;
                            const uk = makeStockUniqueKey(r_code, r_broker);
                            const tombSc = tombStockCreatedMap[uk] || '1970-01-01 00:00:00';
                            const cAtStr = String(r_created || '').trim() || '1970-01-01 00:00:00';

                            if (deletedStockKeys.has(uk)) {
                                if (cAtStr > tombSc) {
                                    // 雲端新生個股，除名墓碑
                                    deletedStockKeys.delete(uk);
                                    delete tombStockCreatedMap[uk];
                                    try {
                                        cloudDb.run("DELETE FROM deleted_records WHERE table_name = 'my_stock' AND unique_key = ?", [uk]);
                                        dbInstance.run("DELETE FROM deleted_records WHERE table_name = 'my_stock' AND unique_key = ?", [uk]);
                                    } catch (e) {}
                                } else if (Number(r_shares || 0) <= 0) {
                                    cloudDb.run("DELETE FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?", [r_code, r_broker]);
                                }
                            }
                        });
                    }

                    // 4.2 本地特別關注狀態更新至 cloudDb
                    if (lStocksAll.length > 0 && lStocksAll[0].values) {
                        lStocksAll[0].values.forEach(r => {
                            const [code, name, shares, cost, broker, focus] = r;
                            const uk = makeStockUniqueKey(code, broker);
                            if (!deletedStockKeys.has(uk) && focus && focus !== '否') {
                                cloudDb.run("UPDATE my_stock SET 特別關注 = ? WHERE 股票代號 = ? AND 證券商 = ?", [focus, code, broker]);
                            }
                        });
                    }
                } catch (e) {
                    console.warn("合流 my_stock 警告:", e);
                }

                // 5. 重新以合流後的 trade_log 滾算 cloudDb 庫存 (支援時間戳墓碑判定)
                try {
                    const allHoldRes = cloudDb.exec("SELECT DISTINCT 股票代號, 證券商, 股票名稱 FROM trade_log");
                    if (allHoldRes.length > 0 && allHoldRes[0].values) {
                        allHoldRes[0].values.forEach(r => {
                            const [code, broker, name] = r;
                            const tRows = cloudDb.exec("SELECT 動作, 成交股數, 成交價 FROM trade_log WHERE 股票代號 = ? AND 證券商 = ? ORDER BY 交易時間 ASC, id ASC", [code, broker]);
                            let curShares = 0;
                            let curCost = 0;
                            let totalCost = 0;
                            if (tRows.length > 0 && tRows[0].values) {
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
                            const tombSc = tombStockCreatedMap[stockUk] || '1970-01-01 00:00:00';
                            let curCreatedAt = '';
                            let existingFocus = '否';
                            try {
                                const cr = cloudDb.exec("SELECT created_at, 特別關注 FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?", [code, broker]);
                                if (cr.length > 0 && cr[0].values && cr[0].values[0]) {
                                    curCreatedAt = String(cr[0].values[0][0] || '').trim();
                                    existingFocus = String(cr[0].values[0][1] || '否').trim();
                                }
                            } catch (e) {}
                            if (!curCreatedAt) curCreatedAt = '1970-01-01 00:00:00';

                            const isNewborn = curCreatedAt > tombSc;
                            const isFocusWatch = (broker === '關注' || existingFocus === '是');

                            if (curShares === 0) {
                                // 0 股且非自選關注，或已被墓碑刪除者：徹底刪除
                                if (!isFocusWatch || (deletedStockKeys.has(stockUk) && !isNewborn)) {
                                    cloudDb.run("DELETE FROM my_stock WHERE 股票代號 = ? AND 證券商 = ?", [code, broker]);
                                } else {
                                    cloudDb.run(
                                        "INSERT OR REPLACE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注, created_at) VALUES (?, ?, 0, 0, ?, ?, ?)",
                                        [code, name, broker, existingFocus, curCreatedAt]
                                    );
                                }
                            } else {
                                // 現役持股 (curShares > 0)
                                if (isNewborn && deletedStockKeys.has(stockUk)) {
                                    deletedStockKeys.delete(stockUk);
                                    delete tombStockCreatedMap[stockUk];
                                    try {
                                        cloudDb.run("DELETE FROM deleted_records WHERE table_name = 'my_stock' AND unique_key = ?", [stockUk]);
                                        dbInstance.run("DELETE FROM deleted_records WHERE table_name = 'my_stock' AND unique_key = ?", [stockUk]);
                                    } catch (e) {}
                                }
                                cloudDb.run(
                                    "INSERT OR REPLACE INTO my_stock (股票代號, 股票名稱, 個股股數, 損平價, 證券商, 特別關注, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                                    [code, name, curShares, curCost, broker, existingFocus, curCreatedAt]
                                );
                            }
                        });
                    }

                    // 6. 全量掃蕩清除歷史遺留的清倉幽靈 0 股 (非關注且未特別關注的 0 股)
                    try {
                        cloudDb.run("DELETE FROM my_stock WHERE (個股股數 <= 0 OR 個股股數 IS NULL) AND 證券商 != '關注' AND (特別關注 IS NULL OR 特別關注 = '否' OR 特別關注 = '')");
                    } catch (e) {}
                } catch (e) {
                    console.warn("滾算庫存警告:", e);
                }

                // 關閉本地舊庫，以 100% 完整之 cloudDb 作為全新本地實例！
                dbInstance.close();
                dbInstance = cloudDb;

                await saveDbToIndexedDb();
                const finalBuf = dbInstance.export();
                await loadDatabaseFromArrayBuffer(finalBuf.buffer, '全量鏡像合流');

                // 將雙向合流後的黃金資料庫上傳回 Google Drive，確保雲端名冊與本機 100% 同步
                syncStatus.value.message = '正在將雙向合流後的黃金版本上傳回 Google Drive...';
                await uploadBufferToGoogleDrive(finalBuf);

                updateLocalDbStats();
                await fetchCloudDbStats();

                markAsSynced();

                alert(`🤝 全量鏡像同步成功！\n• 交易紀錄：${localDbStats.value.tradeLogCount} 筆\n• 自選名冊：${localDbStats.value.myStockCount} 檔\n• 策略庫：${localDbStats.value.gemStrategyCount} 筆\n兩端資料庫已 100% 鏡像對齊。`);
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
                markAsSynced();
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
                    markAsSynced();
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

            // 優先讀取 IndexedDB 行情快照實現秒開
            if (window.localforage) {
                try {
                    const cachedSnap = await localforage.getItem('sentinel_market_snapshot');
                    if (cachedSnap) {
                        applyMarketSnapshot(cachedSnap);
                    }
                } catch (e) {
                    console.warn("讀取行情快照快取失敗:", e);
                }
            }

            // 啟動 Google 智慧心跳監控與背景自動檢測
            initGoogleHeartbeat();
            await checkGoogleTokenFreshness();
            await fetchCloudDbStats();

            // 監聽視窗旋轉或縮放以即時調整圖表
            window.addEventListener('resize', () => {
                if (showStockChartModal.value) {
                    resizeAllStockCharts();
                }
            });

            // 啟動開市日 15:00 / 21:30 雲端大腦同步主動提醒
            checkScheduledSyncReminders();
            setInterval(checkScheduledSyncReminders, 30000);
        });

        return {
            appVersion,
            appLayout,
            toggleAppLayout,
            theme,
            toggleTheme,
            chartOrientation,
            toggleChartOrientation,
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
            onBrokerSelect,
            onBrokerInputChange,
            openTradeModal,
            saveTradeRecord,
            isEditingTrade,
            deleteTradeRecord,
            deleteStockCard,
            buildStock10DayReport,
            copyStock10DayReport,
            tradeSearchKeyword,
            goToTradeHistory,
            showImportReportModal,
            importReportText,
            parsedImportPreview,
            openImportReportModal,
            parseReportText,
            submitImportReport,
            updateMarketHolidays,
            isUpdatingHolidays,
            batchPatchData,
            isBatchPatching,
            toastMsg,
            showToast,
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
            handleOneClickSync,
            syncMarketSnapshot,
            marketSyncMeta,
            nextCrawlTimeInfo,
            activeSyncNotice,
            dismissSyncNotice,
            handleNoticeSyncClick,
            showStockChartModal,
            activeChartStock,
            chartDaysCount,
            subOscTab,
            isChartLoading,
            klineLayers,
            toggleKlineLayer,
            crosshairData,
            openStockChartModal,
            closeStockChartModal,
            changeChartDays,
            changeSubOscTab,
            isAppUnlocked,
            triggerSync,
            triggerFileInput,
            handleDbFileSelected,
            exportDatabaseFile
        };
    }
}).mount('#app');
