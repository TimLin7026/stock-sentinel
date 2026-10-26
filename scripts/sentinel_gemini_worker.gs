/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 💎 台股戰情室 — 富貴 Gem 雲端智慧戰報背景處理器 (Google Apps Script Worker)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 📌 功能概述：
 * 1. 支援離線背景批次推導：手機端送出清單後可立即離線/鎖定螢幕。
 * 2. 多用戶資安隔離：100% 消耗使用者個人 Gemini API Key，數據直接寫入使用者個人 Google Drive。
 * 3. 智慧容錯與退避重試：遇 429/503 自動指數退避 (2s/5s/10s，最多 3 次)。
 * 4. 連續失敗熔斷機制：連續 2 檔失敗即刻終止，防止空轉超時。
 * 5. 保底存檔：推導成功的個股即刻寫入 Google Drive「gem_strategy_batch.json」，供手機端一鍵合流。
 * 
 * 🚀 部署教學：
 * 1. 在您的 Google Drive 中新增一個「Google Apps Script」專案。
 * 2. 將本檔案全部內容複製並貼覆至 Code.gs 中。
 * 3. 點擊右上角「部署」➔「新增部署作業」➔ 選擇「網頁應用程式」。
 *    - 執行身分：我 (您的 Google 帳號)
 *    - 誰可以存取：任何人 (Anyone) 或 只有我自己
 * 4. 點擊部署並完成 Google 權限授權，複製產生的「網頁應用程式網址 (Web App URL)」。
 * 5. 將該網址貼入戰情室「雲端同步 ➔ 個人戰報 GAS 網址」中即可開始使用！
 */

// ⚙️ 系統設定常數
const BATCH_FILE_NAME = "gem_strategy_batch.json";
const STATUS_FILE_NAME = "gem_batch_status.json";
const MAX_RETRY_COUNT = 3;             // 單檔遇忙碌最多重試 3 次
const MAX_CONSECUTIVE_FAILURES = 2;   // 連續失敗 2 次即熔斷退出
const ENABLE_AUTO_WAKEUP = false;      // 預設關閉自動排程補跑 (先採人工重啟觸發)

/**
 * HTTP GET 進入點：健康檢查與狀態查詢 (避免瀏覽器直接開啟時噴錯)
 */
function doGet(e) {
  try {
    const files = DriveApp.getFilesByName(STATUS_FILE_NAME);
    let statusInfo = { status: "ready", message: "💎 台股戰情室 Google Apps Script 戰報處理器正常運作中！" };
    if (files.hasNext()) {
      try {
        statusInfo.latestStatus = JSON.parse(files.next().getContentText());
      } catch (err) {}
    }
    return createJsonResponse({ ok: true, data: statusInfo }, 200);
  } catch (err) {
    return createJsonResponse({ ok: false, error: err.toString() }, 500);
  }
}

/**
 * HTTP POST 進入點：接收手機端派工請求
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ ok: false, error: "無效的 POST 請求內容" }, 400);
    }

    const payload = JSON.parse(e.postData.contents);
    const apiKey = (payload.apiKey || "").trim();
    const model = (payload.model || "gemini-3.8-flash").trim();
    const stocks = payload.stocks || [];

    if (!apiKey) {
      return createJsonResponse({ ok: false, error: "未提供有效的 Gemini API Key" }, 400);
    }

    if (!Array.isArray(stocks) || stocks.length === 0) {
      return createJsonResponse({ ok: false, error: "待推導股票清單為空" }, 400);
    }

    // 🛑 併發互斥防呆檢查：若有執行中的任務且距離最後更新小於 6 分鐘，拒絕新派工
    const currentLock = getBatchLockStatus();
    if (currentLock.isRunning) {
      Logger.log(`🛑 併發攔截：已有任務推導中 (${currentLock.completedCount}/${currentLock.totalRequested} 檔)，拒絕新派工！`);
      return createJsonResponse({
        ok: false,
        isBusy: true,
        error: `⚠️ 目前已有批次戰報正在雲端背景推導中 (${currentLock.completedCount}/${currentLock.totalRequested} 檔)，為防止額度衝突，請稍後完成後再上傳新清單！`,
        status: currentLock
      }, 429);
    }

    // 🚀 執行批次推導處理
    const result = processStockBatch(apiKey, model, stocks);

    return createJsonResponse({
      ok: true,
      message: "批次推導已完成處理",
      result: result
    }, 200);

  } catch (err) {
    Logger.log("doPost 嚴重例外: " + err.toString());
    return createJsonResponse({ ok: false, error: err.toString() }, 500);
  }
}

/**
 * 檢查當前是否有背景任務鎖定中 (6 分鐘逾時租約)
 */
function getBatchLockStatus() {
  try {
    const files = DriveApp.getFilesByName(STATUS_FILE_NAME);
    if (files.hasNext()) {
      const content = files.next().getContentText();
      if (content) {
        const data = JSON.parse(content);
        if (data.status === "running") {
          const now = new Date().getTime();
          const last = Number(data.lastHeartbeat) || 0;
          if (now - last < 360000) { // 6 分鐘內判定為活躍執行中
            return { isRunning: true, ...data };
          }
        }
      }
    }
  } catch (e) {}
  return { isRunning: false };
}

/**
 * 批次處理核心邏輯：微重試 + 熔斷 + 保底即時存檔 + 逐檔即時心跳
 */
function processStockBatch(apiKey, model, stocks) {
  const completedReports = [];
  const failedList = [];
  let consecutiveFailures = 0;
  let isCircuitBroken = false;
  let breakReason = "";
  const startTimeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

  Logger.log(`🚀 開始執行批次推導，總檔數: ${stocks.length}，使用模型: ${model}`);

  // 🔒 1. 任務啟動：立即寫入執行中鎖定狀態
  saveStatusReportToCloudDrive({
    status: "running",
    startTime: startTimeStr,
    lastHeartbeat: new Date().getTime(),
    totalRequested: stocks.length,
    completedCount: 0,
    failedCount: 0,
    currentStock: stocks[0]?.name || stocks[0]?.code || "",
    currentCode: String(stocks[0]?.code || "").padStart(4, "0"),
    progressPercent: 0,
    completedList: [],
    failedList: [],
    isCircuitBroken: false,
    breakReason: ""
  });

  for (let i = 0; i < stocks.length; i++) {
    const item = stocks[i];
    const code = String(item.code || "").padStart(4, "0");
    const name = item.name || code;
    const reportText = item.reportText || "";
    const systemPrompt = item.systemPrompt || "";

    // 💓 2. 逐檔開始心跳回報：通知前端當前正在推導哪一檔股票
    saveStatusReportToCloudDrive({
      status: "running",
      startTime: startTimeStr,
      lastHeartbeat: new Date().getTime(),
      totalRequested: stocks.length,
      completedCount: completedReports.length,
      failedCount: failedList.length,
      currentStock: name,
      currentCode: code,
      progressPercent: Math.round((completedReports.length / stocks.length) * 100),
      completedList: completedReports.map(r => ({ code: r.code, name: r.name })),
      failedList: failedList,
      isCircuitBroken: false,
      breakReason: ""
    });

    if (!reportText) {
      failedList.push({ code, name, error: "缺少技術指標戰報文本" });
      continue;
    }

    Logger.log(`[${i + 1}/${stocks.length}] 正在推導: ${code} ${name}...`);

    let success = false;
    let lastErrorMsg = "";

    // 🔄 單檔重試循環 (指數退避)
    for (let attempt = 1; attempt <= MAX_RETRY_COUNT; attempt++) {
      try {
        const generatedText = callGeminiApi(apiKey, model, systemPrompt, reportText);
        if (generatedText) {
          const parsed = parseStrategyContent(generatedText, code);
          const nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

          const reportData = {
            recordTime: nowStr,
            code: code,
            name: name,
            raw: parsed.raw,
            summary: parsed.summary,
            buyLow: parsed.buyLow,
            buyHigh: parsed.buyHigh,
            defense: parsed.defense,
            targetLow: parsed.targetLow,
            targetHigh: parsed.targetHigh
          };

          completedReports.push(reportData);
          success = true;
          consecutiveFailures = 0; // 重置連續失敗計數

          // 💾 成功立即保底存檔 (避免後續發生意外時前面努力白費)
          appendReportToCloudDrive(reportData);
          Logger.log(`✅ [${code} ${name}] 戰報生成並成功保底存檔！`);
          break;
        }
      } catch (err) {
        lastErrorMsg = err.message || err.toString();
        Logger.log(`⚠️ [${code} ${name}] 第 ${attempt} 次呼叫失敗: ${lastErrorMsg}`);

        // 判斷是否為 429 或 503 忙碌，採用階梯式等待
        if (lastErrorMsg.includes("429") || lastErrorMsg.includes("503") || lastErrorMsg.includes("overloaded") || lastErrorMsg.includes("ResourceExhausted")) {
          const sleepSeconds = attempt === 1 ? 2 : (attempt === 2 ? 5 : 10);
          Logger.log(`⏳ 偵測到模型忙碌，退避等待 ${sleepSeconds} 秒後重試...`);
          Utilities.sleep(sleepSeconds * 1000);
        } else {
          // 其他不可逆錯誤 (例如 Key 錯誤或 Payload 格式問題)，直接中斷重試
          break;
        }
      }
    }

    // 處理單檔最終失敗
    if (!success) {
      consecutiveFailures++;
      failedList.push({ code, name, error: lastErrorMsg });
      Logger.log(`❌ [${code} ${name}] 推導最終失敗 (連續失敗次數: ${consecutiveFailures})`);

      // 🛡️ 連續失敗熔斷檢查
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        isCircuitBroken = true;
        breakReason = `連續 ${consecutiveFailures} 檔股票遭遇模型忙碌或連線中斷，觸發安全熔斷停止後續推導！`;
        Logger.log(`🛑 觸發安全熔斷: ${breakReason}`);
        break;
      }
    }

    // 溫和間隔防抖 (避免瞬間連續請求)
    Utilities.sleep(1000);
  }

  // 📝 產出批次狀態報告並儲存至 Drive (標記 completed 並釋放執行鎖)
  const statusReport = {
    status: "completed",
    batchTime: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    startTime: startTimeStr,
    lastHeartbeat: new Date().getTime(),
    totalRequested: stocks.length,
    completedCount: completedReports.length,
    failedCount: failedList.length,
    currentStock: "",
    currentCode: "",
    progressPercent: 100,
    completedCodes: completedReports.map(r => r.code),
    completedList: completedReports.map(r => ({ code: r.code, name: r.name })),
    failedList: failedList,
    isCircuitBroken: isCircuitBroken,
    breakReason: breakReason
  };

  // 💾 關鍵核心：將本次成功推導的全部戰報一次性全量寫入 Google Drive，避免快取覆蓋
  saveAllBatchReportsToCloudDrive(completedReports);

  saveStatusReportToCloudDrive(statusReport);

  return statusReport;
}

/**
 * 呼叫 Google 官方 Gemini REST API
 */
function callGeminiApi(apiKey, model, systemPrompt, userContent) {
  const cleanModel = encodeURIComponent(model);
  const cleanKey = encodeURIComponent(apiKey);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${cleanKey}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: userContent }]
      }
    ]
  };

  if (systemPrompt) {
    payload.systemInstruction = {
      parts: [{ text: systemPrompt }]
    };
  }

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (responseCode !== 200) {
    let errMsg = `HTTP ${responseCode}`;
    try {
      const errObj = JSON.parse(responseText);
      if (errObj.error && errObj.error.message) {
        errMsg += `: ${errObj.error.message}`;
      }
    } catch (e) {}
    throw new Error(errMsg);
  }

  const data = JSON.parse(responseText);
  if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
    return data.candidates[0].content.parts[0].text;
  }

  throw new Error("Gemini 回傳結構無有效文本");
}

/**
 * 解析戰報文本 (100% 對齊戰情室「匯入戰報」與「單檔生成」之標準 parseReportText 規格)
 */
function parseStrategyContent(rawText, fallbackCode) {
  if (!rawText || typeof rawText !== "string") {
    return {
      raw: "",
      code: fallbackCode || "",
      summary: "",
      buyLow: null,
      buyHigh: null,
      defense: null,
      targetLow: null,
      targetHigh: null
    };
  }

  const t = rawText.trim();
  const codeMatch = t.match(/代碼[：:]\s*([0-9A-Za-z]+)/);
  const sumMatch = t.match(/戰情總結[：:]\s*(.*?)(?=\n|$)/);
  const buyLowMatch = t.match(/佈局區間下限[：:]\s*([0-9.,]+)/);
  const buyHighMatch = t.match(/佈局區間上限[：:]\s*([0-9.,]+)/);
  const defMatch = t.match(/防守停損點[：:]\s*([0-9.,]+)/);
  const targetLowMatch = t.match(/目標調節下限[：:]\s*([0-9.,]+)/);
  const targetHighMatch = t.match(/目標調節上限[：:]\s*([0-9.,]+)/);

  const cleanNum = (m) => {
    if (!m || !m[1]) return null;
    const v = parseFloat(m[1].replace(/,/g, ""));
    return isNaN(v) ? null : v;
  };

  return {
    raw: t,
    code: codeMatch ? codeMatch[1].trim() : (fallbackCode || ""),
    summary: sumMatch ? sumMatch[1].trim() : "",
    buyLow: cleanNum(buyLowMatch),
    buyHigh: cleanNum(buyHighMatch),
    defense: cleanNum(defMatch),
    targetLow: cleanNum(targetLowMatch),
    targetHigh: cleanNum(targetHighMatch)
  };
}

/**
 * 將產出的戰報安全追加至 Google Drive 的 gem_strategy_batch.json
 */
function appendReportToCloudDrive(reportData) {
  const files = DriveApp.getFilesByName(BATCH_FILE_NAME);
  let batchList = [];

  if (files.hasNext()) {
    const file = files.next();
    try {
      const content = file.getContentText();
      if (content) {
        batchList = JSON.parse(content);
      }
    } catch (e) {}
    
    // 移除同股票舊戰報，落實只保留一份最新
    batchList = batchList.filter(r => String(r.code) !== String(reportData.code));
    batchList.push(reportData);
    file.setContent(JSON.stringify(batchList, null, 2));
  } else {
    batchList.push(reportData);
    DriveApp.createFile(BATCH_FILE_NAME, JSON.stringify(batchList, null, 2), MimeType.PLAIN_TEXT);
  }
}

/**
 * 將本次所有推導成功的戰報全量一次性存檔至 Google Drive (避免 Drive 快取延遲導致覆蓋)
 */
function saveAllBatchReportsToCloudDrive(completedReports) {
  if (!completedReports || completedReports.length === 0) return;
  
  const files = DriveApp.getFilesByName(BATCH_FILE_NAME);
  let batchList = [];

  // 如果原本就有檔案，讀取現有內容並合併（以最新 completedReports 為主）
  if (files.hasNext()) {
    const file = files.next();
    try {
      const content = file.getContentText();
      if (content) {
        batchList = JSON.parse(content);
      }
    } catch (e) {}

    // 先剔除 completedReports 裡面已包含的股票代碼，避免重複
    const newCodes = new Set(completedReports.map(r => String(r.code)));
    batchList = batchList.filter(r => !newCodes.has(String(r.code)));
    
    // 合併新戰報
    batchList = batchList.concat(completedReports);
    file.setContent(JSON.stringify(batchList, null, 2));
    Logger.log(`💾 全量存檔完成：共計 ${batchList.length} 檔 (本次新增 ${completedReports.length} 檔) 寫入 ${BATCH_FILE_NAME}`);
  } else {
    // 檔案不存在則直接新建
    DriveApp.createFile(BATCH_FILE_NAME, JSON.stringify(completedReports, null, 2), MimeType.PLAIN_TEXT);
    Logger.log(`💾 全量存檔完成：新建立檔案，共計 ${completedReports.length} 檔寫入 ${BATCH_FILE_NAME}`);
  }
}

/**
 * 儲存執行狀態日誌至 Google Drive 的 gem_batch_status.json
 */
function saveStatusReportToCloudDrive(statusReport) {
  const files = DriveApp.getFilesByName(STATUS_FILE_NAME);
  const jsonStr = JSON.stringify(statusReport, null, 2);

  if (files.hasNext()) {
    const file = files.next();
    file.setContent(jsonStr);
  } else {
    DriveApp.createFile(STATUS_FILE_NAME, jsonStr, MimeType.PLAIN_TEXT);
  }
}

/**
 * 輔助工具：建立 JSON HTTP 回應
 */
function createJsonResponse(data, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * 測試進入點：用於 GAS 編輯器中手動測試連線與授權
 */
function testDrivePermission() {
  Logger.log("檢查 Google Drive 讀寫權限...");
  saveStatusReportToCloudDrive({
    test: "success",
    time: new Date().toISOString()
  });
  Logger.log("✅ Google Drive 存取測試成功！");
}
