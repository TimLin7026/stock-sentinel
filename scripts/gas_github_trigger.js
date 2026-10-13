/**
 * ============================================================================
 * 🚀 鈔能戰情室・Google Apps Script (GAS) 外部精準定時觸發器
 * ============================================================================
 * 作用：
 *   透過 Google 雲端伺服器的精準定時器，在每個台股開市日（週一至週五）的：
 *     1. 下午 14:30 ~ 14:40（盤後第一時間收盤價與成交量同步）
 *     2. 晚上 21:00 ~ 21:10（晚間全量三大法人與融資融券校準）
 *   主動發送最高優先權的 `workflow_dispatch` API 喚醒 GitHub Actions，
 *   徹底解決 GitHub 內建 `schedule` 排程在整點尖峰時段排隊延遲 1~3 小時的問題！
 *
 * ============================================================================
 * 📋 3 分鐘首次設定步驟：
 * ============================================================================
 * Step 1：取得 GitHub Personal Access Token (PAT)
 *   1. 前往 GitHub 個人設定：https://github.com/settings/tokens?type=beta (或 Classic Token: https://github.com/settings/tokens)
 *   2. 若使用 Classic Token (推薦，最簡單)：
 *      - 點擊「Generate new token (classic)」
 *      - Note 填寫：`GAS-Stock-Sentinel-Trigger`
 *      - Expiration 選擇：`No expiration` (永不過期)
 *      - 勾選權限：`repo` 與 `workflow`
 *      - 點擊底部「Generate token」，複製產生的 `ghp_xxxxxxxxxxxx` 金鑰。
 *
 * Step 2：建立 Google Apps Script 專案
 *   1. 前往：https://script.google.com/
 *   2. 點擊左上角「＋ 新專案」，將專案命名為「台股戰情室_雲端大腦定時器」。
 *   3. 將本檔案全部程式碼複製並貼上（覆蓋原本的 `myFunction`）。
 *   4. 將下方第 41 行的 `GITHUB_PAT` 替換為您剛才複製的 `ghp_xxxx` 金鑰，按 `Ctrl + S` 儲存。
 *
 * Step 3：一鍵測試與自動安裝每日排程
 *   1. 在上方工具列的函式下拉選單，選擇 `testTriggerNow` 並點擊「▷ 執行」：
 *      - 首次執行會跳出 Google 權限審核，請點擊「審查權限」➔ 選擇您的帳號 ➔「進階」➔「前往 台股戰情室_雲端大腦定時器 (不安全)」➔「允許」。
 *      - 看到下方執行記錄顯示「✅ 成功喚醒 GitHub Actions Workflow (HTTP 204)」即代表連線成功！
 *   2. 接著在上方工具列的函式下拉選單，改選 `setupDailyTriggers` 並點擊「▷ 執行」：
 *      - 系統會自動幫您建立每天 14:30 與 21:00 的兩組台灣時區定時器，設定完成！
 * ============================================================================
 */

// 🔑 請在此填入您的 GitHub Personal Access Token (需具備 repo 與 workflow 權限)
const GITHUB_PAT = '請在此貼上您的_ghp_開頭金鑰';

// 📦 GitHub 儲存庫與 Workflow 設定
const GITHUB_OWNER = 'TimLin7026';
const GITHUB_REPO = 'stock-sentinel';
const WORKFLOW_FILE = 'market_sync.yml';
const TARGET_BRANCH = 'main';

/**
 * 下午場排程入口 (由 Google 定時器於每日 14:30 自動呼叫)
 */
function triggerAfternoonMarketSync() {
  if (!isWeekdayInTaipei_()) {
    Logger.log('😴 今日為週末休市日，跳過 14:30 下午場觸發。');
    return;
  }
  Logger.log('🚀 啟動 14:30 下午場盤後第一時間同步...');
  triggerGitHubWorkflow_('', '0');
}

/**
 * 晚間場排程入口 (由 Google 定時器於每日 21:00 自動呼叫)
 */
function triggerEveningMarketSync() {
  if (!isWeekdayInTaipei_()) {
    Logger.log('😴 今日為週末休市日，跳過 21:00 晚間場觸發。');
    return;
  }
  Logger.log('🌙 啟動 21:00 晚間場全量籌碼與資券校準...');
  triggerGitHubWorkflow_('', '0');
}

/**
 * 🧪 手動立即測試觸發 (初次設定時，選此函式按「執行」即可立即喚醒 GitHub Workflow)
 */
function testTriggerNow() {
  Logger.log('🧪 執行手動立即測試觸發...');
  triggerGitHubWorkflow_('', '0');
}

/**
 * ⏰ 一鍵安裝每日 14:30 與 21:00 自動定時器 (只需執行一次即可)
 */
function setupDailyTriggers() {
  // 1. 先清除舊的同名觸發器，避免重複建立
  const existingTriggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existingTriggers.length; i++) {
    const fnName = existingTriggers[i].getHandlerFunction();
    if (fnName === 'triggerAfternoonMarketSync' || fnName === 'triggerEveningMarketSync') {
      ScriptApp.deleteTrigger(existingTriggers[i]);
    }
  }

  // 2. 建立每日 14:30 (台灣時間) 下午場定時器
  ScriptApp.newTrigger('triggerAfternoonMarketSync')
    .timeBased()
    .everyDays(1)
    .atHour(14)
    .nearMinute(30)
    .inTimezone('Asia/Taipei')
    .create();

  // 3. 建立每日 21:00 (台灣時間) 晚間場定時器
  ScriptApp.newTrigger('triggerEveningMarketSync')
    .timeBased()
    .everyDays(1)
    .atHour(21)
    .nearMinute(0)
    .inTimezone('Asia/Taipei')
    .create();

  Logger.log('✅ 已成功安裝每日 14:30 與 21:00 兩組精準定時器 (Asia/Taipei)！');
}

/**
 * 內部核心：判斷台灣時間是否為週一至週五
 */
function isWeekdayInTaipei_() {
  const now = new Date();
  // 取得台灣時區星期幾 (1=週一 ... 5=週五, 6=週六, 7=週日)
  const isoDay = Number(Utilities.formatDate(now, 'Asia/Taipei', 'u'));
  return isoDay >= 1 && isoDay <= 5;
}

/**
 * 內部核心：發送 POST 請求至 GitHub Actions workflow_dispatch API
 */
function triggerGitHubWorkflow_(targetDate, scanDays) {
  if (!GITHUB_PAT || GITHUB_PAT.indexOf('請在此貼上') !== -1) {
    throw new Error('❌ 請先在第 41 行設定您的 GITHUB_PAT 金鑰！');
  }

  const url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/actions/workflows/' + WORKFLOW_FILE + '/dispatches';
  const payload = {
    ref: TARGET_BRANCH,
    inputs: {
      target_date: String(targetDate || ''),
      scan_days: String(scanDays || '0')
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + GITHUB_PAT.trim(),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Google-Apps-Script-StockSentinel-Trigger'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const statusCode = response.getResponseCode();
  const body = response.getContentText();

  if (statusCode === 204) {
    const twTime = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    Logger.log('✅ [' + twTime + '] 成功喚醒 GitHub Actions Workflow (HTTP 204)！GitHub 將在 5 秒內立即啟動虛擬機。');
  } else {
    Logger.log('❌ 喚醒失敗 (HTTP ' + statusCode + ')：' + body);
    throw new Error('GitHub API 回傳錯誤 HTTP ' + statusCode + ': ' + body);
  }
}
