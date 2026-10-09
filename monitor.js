/**
 * 📡 鈔能戰情室 - 獨立數據大腦運維監控台 (monitor.js)
 * 專屬管理員白名單安全鎖定：tinghui7026@gmail.com
 */

const { createApp, ref, computed, onMounted } = Vue;

const ADMIN_EMAIL = 'tinghui7026@gmail.com';
const GOOGLE_CLIENT_ID = '790121467016-vpncpfbmsrnldq9fhpiig36cp8b36oub.apps.googleusercontent.com';
const GITHUB_REPO = 'TimLin7026/stock-sentinel';

createApp({
    setup() {
        // ─── 身分驗證與授權狀態 ───
        const isAuthorized = ref(false);
        const userEmail = ref(localStorage.getItem('sentinel_admin_email') || '');
        const authErrorMsg = ref('');
        const isLoggingIn = ref(false);

        // ─── 數據大腦健康報表 ───
        const isLoadingReport = ref(false);
        const healthData = ref({
            target_date: '',
            run_time: '',
            status: 'UNKNOWN',
            total_elapsed: 0,
            nodes: {},
            audit: {
                zero_volume_count: 0,
                zero_volume_samples: [],
                zero_chip_count: 0,
                zero_chip_samples: []
            },
            snapshot_size_kb: 0
        });

        // ─── 遠端控制與 GitHub API ───
        const customTargetDate = ref('');
        const isTriggering = ref(false);
        const showPatSetting = ref(false);
        const githubPat = ref(localStorage.getItem('sentinel_github_pat') || '');

        // ─── 0 值排查搜尋過濾 ───
        const searchQuery = ref('');

        const saveGithubPat = () => {
            if (githubPat.value) {
                localStorage.setItem('sentinel_github_pat', githubPat.value.trim());
                alert('✅ GitHub 遠端授權 Token 已成功儲存在本地！');
                showPatSetting.value = false;
            }
        };

        // ─── 1. 身分驗證檢查 (Google OAuth 2.0) ───
        const verifyAdminEmail = (email) => {
            if (email && email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
                isAuthorized.value = true;
                userEmail.value = email.trim();
                localStorage.setItem('sentinel_admin_email', email.trim());
                authErrorMsg.value = '';
                fetchHealthReport();
                return true;
            } else {
                isAuthorized.value = false;
                userEmail.value = '';
                localStorage.removeItem('sentinel_admin_email');
                authErrorMsg.value = `🚨 存取被拒：帳號 [${email || '未識別'}] 未獲授權。本後台僅限專屬管理員 (${ADMIN_EMAIL}) 存取。`;
                return false;
            }
        };

        const handleGoogleLogin = () => {
            isLoggingIn.value = true;
            authErrorMsg.value = '';

            try {
                if (!window.google || !window.google.accounts) {
                    authErrorMsg.value = '⚠️ Google 驗證模組載入中，請稍候 3 秒後重試。';
                    isLoggingIn.value = false;
                    return;
                }

                const client = google.accounts.oauth2.initTokenClient({
                    client_id: GOOGLE_CLIENT_ID,
                    scope: 'https://www.googleapis.com/auth/userinfo.email',
                    callback: async (response) => {
                        if (response.error) {
                            authErrorMsg.value = '❌ Google 登入失敗: ' + response.error;
                            isLoggingIn.value = false;
                            return;
                        }

                        // 透過 access_token 取得使用者真實 Email
                        try {
                            const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                                headers: { Authorization: `Bearer ${response.access_token}` }
                            });
                            if (res.ok) {
                                const info = await res.json();
                                verifyAdminEmail(info.email);
                            } else {
                                authErrorMsg.value = '❌ 無法取得 Google 帳號 Email 資訊。';
                            }
                        } catch (err) {
                            authErrorMsg.value = '❌ 驗證過程發生異常: ' + err.message;
                        } finally {
                            isLoggingIn.value = false;
                        }
                    }
                });

                client.requestAccessToken();
            } catch (err) {
                authErrorMsg.value = '❌ 初始化登入失敗: ' + err.message;
                isLoggingIn.value = false;
            }
        };

        const handleLogout = () => {
            isAuthorized.value = false;
            userEmail.value = '';
            localStorage.removeItem('sentinel_admin_email');
            alert('已成功登出管理員監控台。');
        };

        // ─── 2. 獲取數據大腦健康報表 (market_health.json) ───
        const fetchHealthReport = async () => {
            isLoadingReport.value = true;
            try {
                const url = `market_health.json?t=${Date.now()}`;
                const res = await fetch(url);
                if (res.ok) {
                    const data = await res.json();
                    healthData.value = data;
                } else {
                    console.warn("尚未生成 market_health.json");
                    healthData.value.status = "NO_DATA_YET";
                }
            } catch (err) {
                console.error("讀取健康報表失敗:", err);
            } finally {
                isLoadingReport.value = false;
            }
        };

        // ─── 3. 節點數據輔助函式 ───
        const getNodeCount = (key) => {
            if (healthData.value.nodes && healthData.value.nodes[key]) {
                return healthData.value.nodes[key].count || 0;
            }
            return 0;
        };

        const getNodeElapsed = (key) => {
            if (healthData.value.nodes && healthData.value.nodes[key]) {
                return healthData.value.nodes[key].elapsed || '0';
            }
            return '0';
        };

        const getNodeStatusText = (key) => {
            if (healthData.value.nodes && healthData.value.nodes[key]) {
                return healthData.value.nodes[key].status === 'OK' ? '🟢 正常' : '🔴 異常';
            }
            return '⚪ 未知';
        };

        const getNodeStatusClass = (key) => {
            if (healthData.value.nodes && healthData.value.nodes[key]) {
                return healthData.value.nodes[key].status === 'OK' 
                    ? 'bg-emerald-950 border-emerald-800 text-emerald-300' 
                    : 'bg-rose-950 border-rose-800 text-rose-300';
            }
            return 'bg-slate-800 border-slate-700 text-slate-400';
        };

        const getStatusBadgeText = (st) => {
            switch (st) {
                case 'READY': return '🟢 大腦就緒 (可同步)';
                case 'PROCESSING': return '⏳ 數據抓取中';
                case 'CLEANING': return '🧹 指標清洗審計中';
                case 'HOLIDAY': return '☕ 市場休市';
                case 'ERROR': return '🚨 數據異常告警';
                default: return '⚪ 待命/未知';
            }
        };

        const getStatusBadgeClass = (st) => {
            switch (st) {
                case 'READY': return 'bg-emerald-950 border-emerald-800 text-emerald-300';
                case 'PROCESSING': return 'bg-amber-950 border-amber-800 text-amber-300 animate-pulse';
                case 'CLEANING': return 'bg-sky-950 border-sky-800 text-sky-300 animate-pulse';
                case 'HOLIDAY': return 'bg-slate-800 border-slate-700 text-slate-300';
                case 'ERROR': return 'bg-rose-950 border-rose-800 text-rose-300';
                default: return 'bg-slate-900 border-slate-800 text-slate-400';
            }
        };

        // ─── 4. 0 值排查清單與搜尋 ───
        const zeroVolumeList = computed(() => {
            if (healthData.value.audit && Array.isArray(healthData.value.audit.zero_volume_samples)) {
                return healthData.value.audit.zero_volume_samples;
            }
            return [];
        });

        const filteredZeroList = computed(() => {
            const list = zeroVolumeList.value;
            const q = searchQuery.value.trim().toLowerCase();
            if (!q) return list;
            return list.filter(item => {
                const codeMatch = String(item.code || '').toLowerCase().includes(q);
                const nameMatch = String(item.name || '').toLowerCase().includes(q);
                return codeMatch || nameMatch;
            });
        });

        // ─── 5. 遠端觸發 GitHub Actions (workflow_dispatch) ───
        const triggerGitHubDispatch = async (targetDate = '') => {
            if (!githubPat.value) {
                showPatSetting.value = true;
                alert('⚠️ 尚未設定 GitHub 遠端授權 Token！\n請在下方輸入具備 workflow 權限的 GitHub PAT 密鑰後儲存。');
                return;
            }

            const promptMsg = targetDate 
                ? `確定要手動遠端觸發 GitHub 雲端大腦，補抓 [${targetDate}] 的盤後大數據嗎？`
                : `確定要立即遠端喚醒 GitHub 雲端大腦，強制重抓今日盤後數據嗎？`;

            if (!confirm(promptMsg)) return;

            isTriggering.value = true;
            try {
                const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/market_sync.yml/dispatches`;
                const payload = {
                    ref: 'main',
                    inputs: {
                        target_date: targetDate ? String(targetDate).trim() : ''
                    }
                };

                const res = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${githubPat.value.trim()}`,
                        'Accept': 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28'
                    },
                    body: JSON.stringify(payload)
                });

                if (res.status === 204 || res.ok) {
                    alert(`🚀 [喚醒成功！]\nGitHub Actions 雲端大腦已成功啟動！\n預計約 30~60 秒內完成爬取、指標計算與快照發布。稍後點擊「刷新狀態」即可檢視最新報表。`);
                    customTargetDate.value = '';
                } else {
                    const errJson = await res.json().catch(() => ({}));
                    alert(`❌ 觸發失敗 (HTTP ${res.status}):\n${errJson.message || '請確認 GitHub PAT 權限是否包含 workflow 權限。'}`);
                }
            } catch (err) {
                alert(`❌ 遠端連線異常: ${err.message}`);
            } finally {
                isTriggering.value = false;
            }
        };

        // ─── 初始化生命週期 ───
        onMounted(() => {
            const savedEmail = localStorage.getItem('sentinel_admin_email');
            if (savedEmail) {
                verifyAdminEmail(savedEmail);
            }
        });

        return {
            isAuthorized,
            userEmail,
            authErrorMsg,
            isLoggingIn,
            handleGoogleLogin,
            handleLogout,
            isLoadingReport,
            healthData,
            fetchHealthReport,
            getNodeCount,
            getNodeElapsed,
            getNodeStatusText,
            getNodeStatusClass,
            getStatusBadgeText,
            getStatusBadgeClass,
            zeroVolumeList,
            filteredZeroList,
            searchQuery,
            customTargetDate,
            isTriggering,
            showPatSetting,
            githubPat,
            saveGithubPat,
            triggerGitHubDispatch
        };
    }
}).mount('#app');
