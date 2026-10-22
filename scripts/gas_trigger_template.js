/**
 * 🚀 鈔能戰情室 - GitHub Actions 秒級精準排程觸發器 (Google Apps Script)
 * 觸發時段：週一至週五 14:40 (收盤即時)、16:30 (全量法人)、20:30 (融資籌碼)
 */

// ⚙️ 請確認您的 GitHub 個人存取權杖 (PAT) 與倉庫資訊
const GITHUB_CONFIG = {
  OWNER: 'TimLin7026',
  REPO: 'stock-sentinel',
  WORKFLOW_ID: 'market_sync.yml',
  REF: 'main',
  // 建議將 PAT 存入 GAS 的 [專案設定 ➔ 指令碼屬性 GITHUB_PAT]，亦可直接填在此處引號內：
  TOKEN: PropertiesService.getScriptProperties().getProperty('GITHUB_PAT') || '您的_GITHUB_PERSONAL_ACCESS_TOKEN'
};

/**
 * ⚡ 核心觸發函式：呼叫 GitHub REST API 秒級發動 workflow_dispatch
 */
function triggerMarketSync(targetDate = '', scanDays = '0') {
  const url = `https://api.github.com/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/actions/workflows/${GITHUB_CONFIG.WORKFLOW_ID}/dispatches`;
  
  const payload = {
    ref: GITHUB_CONFIG.REF,
    inputs: {
      target_date: targetDate,
      scan_days: scanDays
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': `Bearer ${GITHUB_CONFIG.TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Google-Apps-Script-Sentinel-Bot'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    if (code === 204) {
      Logger.log(`🟢 [成功喚醒] GitHub Actions (${GITHUB_CONFIG.WORKFLOW_ID}) 已於 ${new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'})} 秒級啟動！`);
    } else {
      Logger.log(`🚨 [觸發失敗] HTTP ${code}: ${response.getContentText()}`);
    }
  } catch (err) {
    Logger.log(`❌ [連線異常] ${err.message}`);
  }
}

/**
 * 🌟【一鍵全自動設定排程】（請點選此函式並按下「執行」）
 * 自動清除舊排程，並為您建立：週一至週五 14:40、16:30、20:30 三個精準定時器！
 */
function setupTriggers() {
  // 1. 先清除現有的所有定時器，避免重複堆疊
  const allTriggers = ScriptApp.getProjectTriggers();
  allTriggers.forEach(t => {
    if (t.getHandlerFunction() === 'triggerMarketSync') {
      ScriptApp.deleteTrigger(t);
    }
  });
  Logger.log('🧹 已清空舊有的 triggerMarketSync 觸發器');

  // 2. 建立三個時段的每日定時器
  const scheduleTimes = [
    { hour: 14, minute: 40, label: '盤後收盤即時' },
    { hour: 16, minute: 30, label: '全量法人結算' },
    { hour: 20, minute: 30, label: '融資籌碼校準' }
  ];

  scheduleTimes.forEach(slot => {
    ScriptApp.newTrigger('triggerMarketSync')
      .timeBased()
      .atHour(slot.hour)
      .nearMinute(slot.minute)
      .everyDays(1)
      .inTimezone('Asia/Taipei')
      .create();
    Logger.log(`✅ 已建立 [${slot.label}] 觸發器：每日 ${slot.hour}:${slot.minute}`);
  });

  Logger.log('🎉 全部三組定時觸發器已全自動配置完成！');
}
