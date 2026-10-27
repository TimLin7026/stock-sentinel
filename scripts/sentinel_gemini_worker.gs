/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 💎 台股戰情室 — 富貴 Gem 雲端智慧戰報兩層式工作佇列排程器
 * (Two-Tier Chained Queue Worker for Google Apps Script)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 📌 功能概述：
 * 1. 兩層式智慧工作佇列：使用者勾選任意數量股票 (如 10~25 檔)，自動切為每組 5 檔之清單 Session。
 * 2. 梯次自動接力推導：清單 1 跑完 (約 70 秒) 自動喚醒清單 2，依序接棒，徹底杜絕 Google 360 秒逾時魔咒！
 * 3. 雙重零碰撞保護：同一瞬間僅單一梯次讀寫 Drive，完全消除檔案併發互咬與進度跳動。
 * 4. 支援真正離線鎖屏：手機派工後 0.8 秒即可關機/鎖屏，雲端依序接力跑完全部。
 * 5. 全量保底與自癒：逐檔保底存檔，梯次完工全量同步，合流時一網打盡。
 * 
 * 🚀 部署教學：
 * 1. 在您的 Google Drive 中新增或開啟「Google Apps Script」專案。
 * 2. 將本檔案全部內容複製並覆蓋貼覆至 Code.gs 中。
 * 3. 點擊右上角「部署」➔「管理部署作業」➔ 鉛筆「編輯」➔ 選擇「新版本」➔ 點擊「部署」。
 */

// ⚙️ 系統設定常數
const BATCH_FILE_NAME = "gem_strategy_batch.json";
const STATUS_FILE_NAME = "gem_batch_status.json";
const QUEUE_FILE_NAME = "gem_batch_queue.json";
const CHUNK_SIZE = 5;                  // 每梯次 5 檔股票 (約 70 秒，離 360s 上限極遠)
const MAX_RETRY_COUNT = 3;             // 單檔遇忙碌最多重試 3 次
const MAX_CONSECUTIVE_FAILURES = 2;   // 連續失敗 2 次即熔斷退出
const MAX_SAFE_EXECUTION_SECONDS = 250; // Google 6 分鐘(360s)上限，提早於 250s 安全優雅收工防逾時

/**
 * HTTP GET 進入點：健康檢查、狀態查詢或梯次接力喚醒
 */
/**
 * HTTP GET 進入點：健康檢查、狀態查詢或梯次接力喚醒
 */
function doGet(e) {
  try {
    // 🚀 支援 GET 接力請求模式 (相容 Google 302 重導向及前端輔助秒級喚醒)
    if (e && e.parameter && e.parameter.action === "process_next_chunk") {
      const batchId = (e.parameter.batchId || "").trim();
      const targetChunkIndex = Number(e.parameter.targetChunkIndex) || 0;
      Logger.log(`⚡ [doGet] 收到接力觸發請求：批次 ID [${batchId}]，目標梯次索引 [${targetChunkIndex}]`);

      const queue = readQueueFromCloudDrive();
      if (queue) {
        if (batchId && queue.batchId && queue.batchId !== batchId) {
          Logger.log(`⚠️ batchId 不符：請求 ${batchId} != 活躍佇列 ${queue.batchId}`);
          return createJsonResponse({ ok: false, error: `batchId 不符 (${batchId} != ${queue.batchId})` }, 404);
        }
        // 🛡️ 只有在確認佇列有效且準備啟動時，才清理 Trigger
        clearExistingTriggers();
        Logger.log(`🏃‍♂️ [doGet] 成功驗證佇列，啟動第 ${targetChunkIndex + 1} 梯次推導！`);
        processQueueChunk(queue, targetChunkIndex);
        return createJsonResponse({ ok: true, message: `第 ${targetChunkIndex + 1} 梯次已由 doGet 成功啟動處理` }, 200);
      } else {
        Logger.log("❌ 找不到有效活躍佇列，請確認 Google Drive 上的 gem_batch_queue.json！");
        return createJsonResponse({ ok: false, error: "活躍佇列不存在" }, 404);
      }
    }

    const file = getValidDriveFile(STATUS_FILE_NAME);
    let statusInfo = { status: "ready", message: "💎 台股戰情室 Google Apps Script 兩層式排程器正常運作中！" };
    if (file) {
      try {
        statusInfo.latestStatus = JSON.parse(file.getContentText());
      } catch (err) {}
    }
    return createJsonResponse({ ok: true, data: statusInfo }, 200);
  } catch (err) {
    return createJsonResponse({ ok: false, error: err.toString() }, 500);
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ ok: false, error: "無效的 POST 請求內容" }, 400);
    }

    const payload = JSON.parse(e.postData.contents);

    // 🚀 A. 梯次接力請求模式 (由前一梯次或排程發起)
    if (payload.action === "process_next_chunk") {
      Logger.log(`⚡ 收到接力觸發請求：批次 ID ${payload.batchId}，目標梯次索引 ${payload.targetChunkIndex}`);
      const queue = readQueueFromCloudDrive();
      if (queue && queue.batchId === payload.batchId) {
        processQueueChunk(queue, Number(payload.targetChunkIndex) || 0);
        return createJsonResponse({ ok: true, message: "接力梯次已啟動處理" }, 200);
      } else {
        return createJsonResponse({ ok: false, error: "佇列不存在或批次 ID 不符合" }, 404);
      }
    }

    // 🚀 B. 手機端新派工請求 (第一層：調度分發層 Dispatcher)
    const apiKey = (payload.apiKey || "").trim();
    const model = (payload.model || "gemini-3.8-flash").trim();
    const stocks = payload.stocks || [];
    const gasUrl = (payload.gasUrl || "").trim();

    if (!apiKey) {
      return createJsonResponse({ ok: false, error: "未提供有效的 Gemini API Key" }, 400);
    }

    if (!Array.isArray(stocks) || stocks.length === 0) {
      return createJsonResponse({ ok: false, error: "待推導股票清單為空" }, 400);
    }

    // 🛑 併發互斥防呆檢查：若有執行中的任務且心跳在 3 分鐘內，拒絕新派工
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

    // ✂️ 第一層核心：自動切組分組 (每 5 檔一個 Chunk)
    const chunks = [];
    for (let i = 0; i < stocks.length; i += CHUNK_SIZE) {
      chunks.push(stocks.slice(i, i + CHUNK_SIZE));
    }

    const batchId = "batch_" + new Date().getTime();
    const startTimeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

    const queueData = {
      batchId: batchId,
      startTime: startTimeStr,
      totalRequested: stocks.length,
      totalChunks: chunks.length,
      currentChunkIndex: 0,
      chunkSize: CHUNK_SIZE,
      apiKey: apiKey,
      model: model,
      gasUrl: gasUrl,
      chunks: chunks,
      completedReports: [],
      failedList: []
    };

    // 💾 持久化儲存佇列至 Drive
    saveQueueToCloudDrive(queueData);

    // 🔒 任務啟動：初始化狀態日誌
    saveStatusReportToCloudDrive({
      status: "running",
      batchId: batchId,
      startTime: startTimeStr,
      lastHeartbeat: new Date().getTime(),
      totalRequested: stocks.length,
      completedCount: 0,
      failedCount: 0,
      currentChunk: 1,
      totalChunks: chunks.length,
      currentStock: chunks[0][0]?.name || chunks[0][0]?.code || "",
      currentCode: String(chunks[0][0]?.code || "").padStart(4, "0"),
      progressPercent: 0,
      completedList: [],
      failedList: [],
      isCircuitBroken: false,
      breakReason: ""
    });

    Logger.log(`🚀 [第一層調度完成] 總計 ${stocks.length} 檔，自動切為 ${chunks.length} 梯次 (每梯次 ${CHUNK_SIZE} 檔)！立即啟動第 1 梯次...`);

    // 🏃‍♂️ 立即啟動第 1 梯次 (Chunk 0)
    processQueueChunk(queueData, 0);

    return createJsonResponse({
      ok: true,
      message: `批次排程已成功啟動！共 ${chunks.length} 梯次，正在背景依序接力推導中。`,
      batchId: batchId,
      totalChunks: chunks.length,
      totalRequested: stocks.length
    }, 200);

  } catch (err) {
    Logger.log("doPost 嚴重例外: " + err.toString());
    return createJsonResponse({ ok: false, error: err.toString() }, 500);
  }
}

/**
 * 第二層：梯次工作執行器 (只跑單一 Chunk，耗時約 70 秒，絕不逾時)
 */
function processQueueChunk(queue, chunkIndex) {
  if (!queue || !queue.chunks || chunkIndex >= queue.chunks.length) {
    Logger.log("⚠️ 梯次索引超出範圍或佇列無效，結束處理。");
    return;
  }

  const chunkStocks = queue.chunks[chunkIndex] || [];
  const chunkStartTs = new Date().getTime();
  const apiKey = queue.apiKey;
  const model = queue.model;
  let consecutiveFailures = 0;
  let isCircuitBroken = false;
  let breakReason = "";

  Logger.log(`🏁 開始執行第 ${chunkIndex + 1}/${queue.totalChunks} 梯次，本梯檔數: ${chunkStocks.length} 檔`);

  for (let i = 0; i < chunkStocks.length; i++) {
    // 🛡️ 單梯次內部安全煞車檢查 (防單檔異常卡死)
    const elapsedSeconds = (new Date().getTime() - chunkStartTs) / 1000;
    if (elapsedSeconds >= MAX_SAFE_EXECUTION_SECONDS) {
      isCircuitBroken = true;
      breakReason = `因時間安全防護，第 ${chunkIndex + 1} 梯次於 ${elapsedSeconds.toFixed(0)} 秒安全收工！`;
      Logger.log(`🛑 梯次安全煞車: ${breakReason}`);
      break;
    }

    const item = chunkStocks[i];
    const code = String(item.code || "").padStart(4, "0");
    const name = item.name || code;
    const reportText = item.reportText || "";
    const systemPrompt = item.systemPrompt || "";

    // 💓 逐檔即時心跳回報：通知前端當前第幾梯次、推導哪一檔
    saveStatusReportToCloudDrive({
      status: "running",
      batchId: queue.batchId,
      startTime: queue.startTime,
      lastHeartbeat: new Date().getTime(),
      totalRequested: queue.totalRequested,
      completedCount: queue.completedReports.length,
      failedCount: queue.failedList.length,
      currentChunk: chunkIndex + 1,
      totalChunks: queue.totalChunks,
      currentStock: name,
      currentCode: code,
      progressPercent: Math.round((queue.completedReports.length / queue.totalRequested) * 100),
      completedList: queue.completedReports.map(r => ({ code: r.code, name: r.name })),
      failedList: queue.failedList,
      isCircuitBroken: false,
      breakReason: ""
    });

    if (!reportText) {
      queue.failedList.push({ code, name, error: "缺少技術指標戰報文本" });
      continue;
    }

    Logger.log(`[梯次 ${chunkIndex + 1}][${i + 1}/${chunkStocks.length}] 正在推導: ${code} ${name}...`);

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

          queue.completedReports.push(reportData);
          success = true;
          consecutiveFailures = 0;

          // 💾 成功立即保底存檔至 Google Drive
          appendReportToCloudDrive(reportData);
          Logger.log(`✅ [${code} ${name}] 戰報生成並成功保底存檔！`);
          break;
        }
      } catch (err) {
        lastErrorMsg = err.message || err.toString();
        Logger.log(`⚠️ [${code} ${name}] 第 ${attempt} 次呼叫失敗: ${lastErrorMsg}`);

        if (lastErrorMsg.includes("429") || lastErrorMsg.includes("503") || lastErrorMsg.includes("overloaded") || lastErrorMsg.includes("ResourceExhausted")) {
          const sleepSeconds = attempt === 1 ? 2 : (attempt === 2 ? 5 : 10);
          Logger.log(`⏳ 偵測到模型忙碌，退避等待 ${sleepSeconds} 秒後重試...`);
          Utilities.sleep(sleepSeconds * 1000);
        } else {
          break;
        }
      }
    }

    if (!success) {
      consecutiveFailures++;
      queue.failedList.push({ code, name, error: lastErrorMsg });
      Logger.log(`❌ [${code} ${name}] 推導最終失敗 (連續失敗次數: ${consecutiveFailures})`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        isCircuitBroken = true;
        breakReason = `連續 ${consecutiveFailures} 檔股票遭遇模型忙碌或連線中斷，觸發安全熔斷停止後續推導！`;
        Logger.log(`🛑 觸發安全熔斷: ${breakReason}`);
        break;
      }
    }

    Utilities.sleep(800);
  }

  // 💾 梯次完工：全量同步存檔
  saveAllBatchReportsToCloudDrive(queue.completedReports);

  // 🔄 判斷是否需要接力啟動下一梯次
  const nextChunkIndex = chunkIndex + 1;
  const hasMoreChunks = nextChunkIndex < queue.totalChunks && !isCircuitBroken;

  if (hasMoreChunks) {
    queue.currentChunkIndex = nextChunkIndex;
    saveQueueToCloudDrive(queue);

    Logger.log(`🎉 第 ${chunkIndex + 1}/${queue.totalChunks} 梯次已順利完工！準備接力啟動第 ${nextChunkIndex + 1} 梯次...`);

    // 💓 梯次交界期刷新心跳：更新 lastHeartbeat，杜絕前端 3 分鐘逾時誤判
    saveStatusReportToCloudDrive({
      status: "running",
      batchId: queue.batchId,
      startTime: queue.startTime,
      lastHeartbeat: new Date().getTime(),
      totalRequested: queue.totalRequested,
      completedCount: queue.completedReports.length,
      failedCount: queue.failedList.length,
      currentChunk: nextChunkIndex + 1,
      totalChunks: queue.totalChunks,
      currentStock: `第 ${chunkIndex + 1} 梯次完工，接力啟動第 ${nextChunkIndex + 1} 梯次...`,
      currentCode: "",
      progressPercent: Math.round((queue.completedReports.length / queue.totalRequested) * 100),
      completedList: queue.completedReports.map(r => ({ code: r.code, name: r.name })),
      failedList: queue.failedList,
      isCircuitBroken: false,
      breakReason: ""
    });

    // 🚀 核心接力機制 1：建立符合 Google 規範的排程計時器 (60秒後保底接力)
    scheduleNextChunkTrigger();

    // 🚀 核心接力機制 2：雙保險秒級自我喚醒 (改採 GET 繞過 302 重導向丟失 POST body 限制)
    if (queue.gasUrl && queue.gasUrl.startsWith("https://script.google.com/")) {
      try {
        const sep = queue.gasUrl.includes("?") ? "&" : "?";
        const relayUrl = `${queue.gasUrl}${sep}action=process_next_chunk&batchId=${encodeURIComponent(queue.batchId)}&targetChunkIndex=${nextChunkIndex}`;
        UrlFetchApp.fetch(relayUrl, {
          method: "get",
          muteHttpExceptions: true,
          followRedirects: true
        });
        Logger.log(`⚡ 自我喚醒 Webhook (GET) 已發送：接力第 ${nextChunkIndex + 1} 梯次`);
      } catch (eWebhook) {
        Logger.log("自我喚醒 Webhook 例外 (由背景計時器接管): " + eWebhook.toString());
      }
    }

  } else {
    // 🏆 所有梯次全數完工 (或熔斷終止)
    Logger.log(`🏆 [全部完工] 總計完成 ${queue.completedReports.length}/${queue.totalRequested} 檔戰報！`);

    const finalReport = {
      status: "completed",
      batchId: queue.batchId,
      batchTime: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
      startTime: queue.startTime,
      lastHeartbeat: new Date().getTime(),
      totalRequested: queue.totalRequested,
      completedCount: queue.completedReports.length,
      failedCount: queue.failedList.length,
      currentChunk: queue.totalChunks,
      totalChunks: queue.totalChunks,
      currentStock: "",
      currentCode: "",
      progressPercent: 100,
      completedCodes: queue.completedReports.map(r => r.code),
      completedList: queue.completedReports.map(r => ({ code: r.code, name: r.name })),
      failedList: queue.failedList,
      isCircuitBroken: isCircuitBroken,
      breakReason: breakReason
    };

    saveStatusReportToCloudDrive(finalReport);
    deleteQueueFromCloudDrive();
    clearExistingTriggers();
  }
}

/**
 * Google Apps Script 背景排程計時器喚醒進入點 (全新獨立 6 分鐘實例)
 */
function runNextChunkJob() {
  Logger.log("⏰ 背景單次排程器喚醒：接力啟動下一梯次！");
  clearExistingTriggers();

  const queue = readQueueFromCloudDrive();
  if (!queue || !queue.chunks) {
    Logger.log("⚠️ 無待處理佇列，結束任務。");
    return;
  }

  const currentIdx = queue.currentChunkIndex || 0;
  if (currentIdx < queue.totalChunks) {
    processQueueChunk(queue, currentIdx);
  }
}

/**
 * 建立 Google 規範的接力排程計時器 (60秒後喚醒，隔離保護不 Crash)
 */
function scheduleNextChunkTrigger() {
  try {
    clearExistingTriggers();
    // ⚠️ Google Apps Script 官方規定：after(milliseconds) 最小為 60,000 毫秒 (1 分鐘)
    ScriptApp.newTrigger("runNextChunkJob")
             .timeBased()
             .after(60 * 1000)
             .create();
    Logger.log("⏰ 已建立 Google Apps Script 背景單次計時器，約 1 分鐘後保底接力下一梯次！");
  } catch (errTrigger) {
    Logger.log("⚠️ 建立排程觸發器例外 (由自我 Webhook 或前端助攻接力): " + errTrigger.toString());
  }
}

/**
 * 清理專案內舊的接力排程觸發器 (避免累積)
 */
function clearExistingTriggers() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === "runNextChunkJob") {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
  } catch (e) {}
}

/**
 * 檢查當前是否有背景任務鎖定中 (3 分鐘逾時租約)
 */

/**
 * 檢查當前是否有背景任務鎖定中 (4 分鐘逾時租約)
 */
function getBatchLockStatus() {
  try {
    const file = getValidDriveFile(STATUS_FILE_NAME);
    if (file) {
      const content = file.getContentText();
      if (content) {
        const data = JSON.parse(content);
        if (data.status === "running") {
          const now = new Date().getTime();
          const last = Number(data.lastHeartbeat) || 0;
          if (now - last < 240000) { // 4 分鐘內判定為活躍執行中
            return { isRunning: true, ...data };
          }
        }
      }
    }
  } catch (e) {}
  return { isRunning: false };
}

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
 * 解析戰報文本 (100% 對齊戰情室「匯入戰報」與「單檔生成」之標準規格)
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
 * 取得指定名稱之最新有效檔案 (嚴格過濾垃圾桶，徹底免疫殭屍檔干擾)
 */
function getValidDriveFile(fileName) {
  try {
    const files = DriveApp.getFilesByName(fileName);
    let latestFile = null;
    let latestTs = 0;
    const trashedOrOld = [];

    while (files.hasNext()) {
      const f = files.next();
      if (f.isTrashed()) continue; // 🛡️ 關鍵防護：徹底排除垃圾桶 (Trash) 裡的舊檔案
      const ts = f.getLastUpdated().getTime();
      if (ts > latestTs) {
        if (latestFile) trashedOrOld.push(latestFile);
        latestTs = ts;
        latestFile = f;
      } else {
        trashedOrOld.push(f);
      }
    }

    for (let i = 0; i < trashedOrOld.length; i++) {
      try { trashedOrOld[i].setTrashed(true); } catch (e) {}
    }

    return latestFile;
  } catch (err) {
    Logger.log("取得 Drive 檔案 [" + fileName + "] 失敗: " + err.toString());
    return null;
  }
}

/**
 * 保底存檔至 gem_strategy_batch.json
 */
function appendReportToCloudDrive(reportData) {
  const file = getValidDriveFile(BATCH_FILE_NAME);
  let batchList = [];

  if (file) {
    try {
      const content = file.getContentText();
      if (content) batchList = JSON.parse(content);
    } catch (e) {}
    
    batchList = batchList.filter(r => String(r.code) !== String(reportData.code));
    batchList.push(reportData);
    file.setContent(JSON.stringify(batchList, null, 2));
  } else {
    batchList.push(reportData);
    DriveApp.createFile(BATCH_FILE_NAME, JSON.stringify(batchList, null, 2), MimeType.PLAIN_TEXT);
  }
}

/**
 * 全量一次性存檔至 gem_strategy_batch.json
 */
function saveAllBatchReportsToCloudDrive(completedReports) {
  if (!completedReports || completedReports.length === 0) return;
  
  const file = getValidDriveFile(BATCH_FILE_NAME);
  let batchList = [];

  if (file) {
    try {
      const content = file.getContentText();
      if (content) batchList = JSON.parse(content);
    } catch (e) {}

    const newCodes = new Set(completedReports.map(r => String(r.code)));
    batchList = batchList.filter(r => !newCodes.has(String(r.code)));
    batchList = batchList.concat(completedReports);
    file.setContent(JSON.stringify(batchList, null, 2));
    Logger.log("💾 全量存檔完成：共計 " + batchList.length + " 檔寫入 " + BATCH_FILE_NAME);
  } else {
    DriveApp.createFile(BATCH_FILE_NAME, JSON.stringify(completedReports, null, 2), MimeType.PLAIN_TEXT);
    Logger.log("💾 全量存檔完成：新建立檔案，共計 " + completedReports.length + " 檔寫入 " + BATCH_FILE_NAME);
  }
}

/**
 * 佇列持久化管理函式
 */
function readQueueFromCloudDrive() {
  try {
    const file = getValidDriveFile(QUEUE_FILE_NAME);
    if (file) {
      const content = file.getContentText();
      if (content) return JSON.parse(content);
    }
  } catch (e) {
    Logger.log("讀取佇列失敗: " + e.toString());
  }
  return null;
}

function saveQueueToCloudDrive(queueData) {
  const jsonStr = JSON.stringify(queueData, null, 2);
  const file = getValidDriveFile(QUEUE_FILE_NAME);
  if (file) {
    file.setContent(jsonStr);
  } else {
    DriveApp.createFile(QUEUE_FILE_NAME, jsonStr, MimeType.PLAIN_TEXT);
  }
}

function deleteQueueFromCloudDrive() {
  try {
    const files = DriveApp.getFilesByName(QUEUE_FILE_NAME);
    while (files.hasNext()) {
      const f = files.next();
      if (!f.isTrashed()) {
        f.setTrashed(true);
      }
    }
  } catch (e) {}
}

/**
 * 儲存執行狀態日誌至 gem_batch_status.json
 */
function saveStatusReportToCloudDrive(statusReport) {
  const jsonStr = JSON.stringify(statusReport, null, 2);
  const file = getValidDriveFile(STATUS_FILE_NAME);

  if (file) {
    file.setContent(jsonStr);
  } else {
    DriveApp.createFile(STATUS_FILE_NAME, jsonStr, MimeType.PLAIN_TEXT);
  }
}

function createJsonResponse(data, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * 測試進入點：用於 GAS 編輯器中手動測試連線與授權
 */
function testDrivePermission() {
  Logger.log("檢查 Google Drive 與排程器權限...");
  saveStatusReportToCloudDrive({
    test: "success",
    time: new Date().toISOString()
  });
  clearExistingTriggers();
  Logger.log("✅ Google Drive 存取與排程器測試成功！");
}
