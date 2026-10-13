/**
 * ============================================================================
 * 🚀 鈔能戰情室・Google Apps Script (GAS) 外部精準定時觸發器 (含金鑰到期自動寄信提醒)
 * ============================================================================
 * 作用：
 *   1. 透過 Google 雲端伺服器的精準定時器，在每個台股開市日（週一至週五）的：
 *      - 下午 14:30 ~ 14:40（盤後第一時間收盤價與成交量同步）
 *      - 晚上 21:00 ~ 21:10（晚間全量三大法人與融資融券校準）
 *      主動發送最高優先權的 `workflow_dispatch` API 喚醒 GitHub Actions (0 秒排隊延遲)。
 *   2. 每次呼叫 GitHub API 時，自動從回應標頭 (`github-authentication-token-expiration`)
 *      偵測您的 GitHub 金鑰到期日：
 *      - 當剩餘天數 <= 7 天（或金鑰已過期 HTTP 401）時，自動寄發 Gmail 提醒信給您！
 *
 * ============================================================================
 * 📋 設定步驟：
 * ============================================================================
 * 1. 將下方 `GITHUB_PAT` 替換為您的 `ghp_xxxx` 金鑰，按 `Ctrl + S` 儲存。
 * 2. 在上方下拉選單選擇 `testTriggerNow` 點擊「▷ 執行」測試連線與權限授權。
 * 3. 在上方下拉選單選擇 `setupDailyTriggers` 點擊「▷ 執行」掛載每日 14:30 / 21:00 定時器。
 * ============================================================================
 */

// 🔑 請在此填入您的 GitHub Personal Access Token (需具備 repo 與 workflow 權限)
const GITHUB_PAT = '請在此貼上您的_ghp_開頭金鑰';

// 📧 金鑰到期提前幾天寄信通知 (預設提前 7 天，每天最多寄 1 封提醒信)
const EXPIRY_WARN_DAYS = 7;

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
 * 🧪 手動立即測試觸發 (同時顯示金鑰剩餘有效天數)
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
  const isoDay = Number(Utilities.formatDate(now, 'Asia/Taipei', 'u'));
  return isoDay >= 1 && isoDay <= 5;
}

/**
 * 內部核心：發送 POST 請求至 GitHub Actions workflow_dispatch API，並自動檢查金鑰到期日
 */
function triggerGitHubWorkflow_(targetDate, scanDays) {
  if (!GITHUB_PAT || GITHUB_PAT.indexOf('請在此貼上') !== -1) {
    throw new Error('❌ 請先在上方 GITHUB_PAT 填入您的 ghp_ 金鑰！');
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
  const headers = response.getAllHeaders() || {};

  // 🔑 自動檢查 GitHub Token 到期日並於需要時寄信通知
  checkTokenExpirationAndNotify_(headers, statusCode);

  if (statusCode === 204) {
    const twTime = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    Logger.log('✅ [' + twTime + '] 成功喚醒 GitHub Actions Workflow (HTTP 204)！GitHub 將在 5 秒內立即啟動虛擬機。');
  } else {
    Logger.log('❌ 喚醒失敗 (HTTP ' + statusCode + ')：' + body);
    throw new Error('GitHub API 回傳錯誤 HTTP ' + statusCode + ': ' + body);
  }
}

/**
 * 🔑 自動解析 GitHub 回傳標頭 `github-authentication-token-expiration`
 *    當金鑰剩餘天數 <= EXPIRY_WARN_DAYS (7天) 或 HTTP 401 失效時，自動發送 Gmail 提醒信
 */
function checkTokenExpirationAndNotify_(headers, statusCode) {
  try {
    const todayStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    const props = PropertiesService.getScriptProperties();

    // 情況 A：HTTP 401 代表金鑰已經過期或被撤銷
    if (statusCode === 401) {
      Logger.log('🚨 嚴重警告：GitHub 金鑰已過期或失效 (HTTP 401)！');
      const lastExpiredMailDate = props.getProperty('LAST_EXPIRED_MAIL_DATE');
      if (lastExpiredMailDate !== todayStr) {
        sendTokenWarningEmail_(
          '🚨【緊急】鈔能戰情室 GitHub 金鑰已過期失效，請立即更新！',
          '您的 GitHub Personal Access Token (Stock Sentinel Monitor) 已過期或失效 (HTTP 401)，目前無法自動觸發台股雲端行情大腦同步。\n\n' +
          '👉 請立即前往更換金鑰：\nhttps://github.com/settings/tokens\n' +
          '（建議將 Expiration 設為 No expiration 永不過期）\n\n' +
          '👉 更新後請貼回 Google Apps Script 的 GITHUB_PAT 變數中：\nhttps://script.google.com/'
        );
        props.setProperty('LAST_EXPIRED_MAIL_DATE', todayStr);
      }
      return;
    }

    // 情況 B：從 Header 讀取到期時間 (不分大小寫查找 github-authentication-token-expiration)
    var expHeader = null;
    for (var k in headers) {
      if (String(k).toLowerCase() === 'github-authentication-token-expiration') {
        expHeader = headers[k];
        break;
      }
    }

    if (!expHeader) {
      Logger.log('🔑 金鑰狀態：永不過期 (No expiration) 或未設定到期日。');
      return;
    }

    // GitHub 格式通常為 "2027-01-07 00:00:00 UTC" 或 "2027-01-07 08:00:00 +0800"
    const normalizedExpStr = String(expHeader).replace(' UTC', 'Z').replace(' ', 'T');
    var expDate = new Date(normalizedExpStr);
    if (isNaN(expDate.getTime())) {
      expDate = new Date(String(expHeader));
    }
    if (isNaN(expDate.getTime())) {
      Logger.log('🔑 金鑰到期標頭原始值：' + expHeader);
      return;
    }

    const nowMs = new Date().getTime();
    const diffDays = Math.ceil((expDate.getTime() - nowMs) / (1000 * 60 * 60 * 24));
    const expDateFormatted = Utilities.formatDate(expDate, 'Asia/Taipei', 'yyyy-MM-dd');

    Logger.log('🔑 金鑰有效期限至：' + expDateFormatted + '（剩餘約 ' + diffDays + ' 天）');

    // 若剩餘天數 <= EXPIRY_WARN_DAYS (7天)，寄發提前提醒信 (每天最多寄 1 次)
    if (diffDays <= EXPIRY_WARN_DAYS) {
      const lastWarnMailDate = props.getProperty('LAST_WARN_MAIL_DATE');
      if (lastWarnMailDate !== todayStr) {
        sendTokenWarningEmail_(
          '⚠️【提醒】鈔能戰情室 GitHub 金鑰將於 ' + diffDays + ' 天後 (' + expDateFormatted + ') 到期！',
          '您好！系統自動偵測到您的 GitHub Personal Access Token 即將到期：\n\n' +
          '• 到期日期：' + expDateFormatted + '\n' +
          '• 剩餘天數：約 ' + diffDays + ' 天\n\n' +
          '為了避免雲端行情大腦排程中斷，請於到期前撥空更新金鑰：\n' +
          '1. 前往 GitHub Token 頁面點擊 Regenerate token：\n   https://github.com/settings/tokens\n' +
          '   （💡 建議將 Expiration 改選為 No expiration 永不過期，即可一勞永逸！）\n' +
          '2. 將新產生的 ghp_ 金鑰貼回 Google Apps Script 的 GITHUB_PAT 並按 Ctrl+S 儲存：\n   https://script.google.com/'
        );
        props.setProperty('LAST_WARN_MAIL_DATE', todayStr);
      }
    }
  } catch (e) {
    Logger.log('⚠️ 檢查金鑰到期日時發生非致命例外：' + e.message);
  }
}

/**
 * 寄送金鑰到期提醒 Email 給當前 Google 帳號信箱
 */
function sendTokenWarningEmail_(subject, bodyText) {
  try {
    const userEmail = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail();
    if (!userEmail) {
      Logger.log('⚠️ 無法取得當前使用者信箱，略過寄信。');
      return;
    }
    MailApp.sendEmail({
      to: userEmail,
      subject: subject,
      body: bodyText
    });
    Logger.log('📧 已自動寄發金鑰到期提醒信至：' + userEmail);
  } catch (e) {
    Logger.log('⚠️ 寄發提醒信失敗 (可能尚未授權寄信權限)：' + e.message);
  }
}
