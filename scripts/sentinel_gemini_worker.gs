/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 💎 台股戰情室 — 富貴 Gem 雲端智慧戰報實體清單循環推導機
 * (Transactional Manifest Loop Worker for Google Apps Script)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 📌 核心架構：
 * 1. 實體清單檔案定錨：所有待辦股票持久化存入 Drive 的「gem_batch_manifest.json」。
 * 2. 上傳即清空重置：每次新派工，徹底清空舊清單與除錯日誌「gem_batch_debug.txt」。
 * 3. 逐筆推導、逐筆註記：讀取 pending 股票呼叫 Gemini，產出戰報存入 json 後立即標記 done。
 * 4. 循環推進直到全數完工：持續 loop 直到清單中所有股票都註記 done，才標記 completed。
 * 5. 支援手機鎖屏離線：派工後 0.8 秒即可關閉網頁鎖屏，GAS 在雲端獨立滿血跑完。
 * 6. 徹底摒除跨請求排程：無 Trigger、無自閉 Webhook，純粹高穩定單一執行循環。
 */

// ⚙️ 系統設定常數
const BATCH_FILE_NAME = "gem_strategy_batch.json";
const STATUS_FILE_NAME = "gem_batch_status.json";
const MANIFEST_FILE_NAME = "gem_batch_manifest.json";
const DEBUG_LOG_FILE_NAME = "gem_batch_debug.txt";

const MAX_RETRY_COUNT = 3;             // 單檔遇忙碌最多重試 3 次
const MAX_CONSECUTIVE_FAILURES = 3;   // 連續失敗 3 次即熔斷退出
const MAX_SAFE_EXECUTION_SECONDS = 310; // Google 6 分鐘(360s)上限，提早於 310s 安全優雅收工防逾時

/**
 * 📝 Google Drive 即時黑盒子追蹤日誌 (寫入 gem_batch_debug.txt)
 */
function logToDrive(msg, isOverwrite) {
  try {
    const timeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss.SSS");
    const line = "[" + timeStr + "] " + msg + "\n";
    const file = getValidDriveFile(DEBUG_LOG_FILE_NAME);
    if (file) {
      if (isOverwrite) {
        file.setContent(line);
      } else {
        file.setContent(file.getContentText() + line);
      }
    } else {
      DriveApp.createFile(DEBUG_LOG_FILE_NAME, line, MimeType.PLAIN_TEXT);
    }
  } catch (e) {}
}

/**
 * HTTP GET 進入點：健康檢查與狀態查詢 (支援斷點續跑未完成股票)
 */
function doGet(e) {
  try {
    // 支援斷點續跑未完成的清單股票
    if (e && e.parameter && e.parameter.action === "resume_manifest") {
      logToDrive("⚡ [doGet] 收到斷點續跑請求，準備讀取現存未執行清單...");
      const manifest = readManifestFromCloudDrive();
      if (manifest && manifest.stocks && manifest.stocks.some(s => s.status === "pending")) {
        const apiKey = (e.parameter.apiKey || manifest.apiKey || "").trim();
        const model = (e.parameter.model || manifest.model || "gemini-3.8-flash").trim();
        if (apiKey) {
          processManifestLoop(apiKey, model);
          return createJsonResponse({ ok: true, message: "未執行清單已接續啟動推導" }, 200);
        }
      }
      return createJsonResponse({ ok: false, message: "無待推導之未執行股票清單" }, 200);
    }

    const file = getValidDriveFile(STATUS_FILE_NAME);
    let statusInfo = { status: "ready", message: "💎 台股戰情室 Google Apps Script 實體清單循環機正常運作中！" };
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

    // 🛑 併發互斥防呆檢查：若有執行中的任務且心跳在 4 分鐘內，拒絕新派工
    const currentLock = getBatchLockStatus();
    if (currentLock.isRunning) {
      logToDrive("🛑 併發攔截：已有任務推導中 (" + currentLock.completedCount + "/" + currentLock.totalRequested + " 檔)，拒絕重複派工！");
      return createJsonResponse({
        ok: false,
        isBusy: true,
        error: "⚠️ 目前已有批次戰報正在雲端背景推導中 (" + currentLock.completedCount + "/" + currentLock.totalRequested + " 檔)，請稍後完成後再派工！",
        status: currentLock
      }, 429);
    }

    // 🧹 核心設計 1：每次收到新派工，徹底清空除錯日誌，從乾淨第 1 行開始！
    logToDrive("🚀 [新派工抵達] 收到全新派工，總計 " + stocks.length + " 檔！徹底清空舊日誌與舊清單...", true);

    const batchId = "batch_" + new Date().getTime();
    const startTimeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

    // 📋 核心設計 2：每次上傳清空並寫入全新的實體清單檔案 (gem_batch_manifest.json)
    const manifestData = {
      batchId: batchId,
      createdAt: startTimeStr,
      apiKey: apiKey,
      model: model,
      totalCount: stocks.length,
      stocks: stocks.map(s => ({
        code: String(s.code || "").padStart(4, "0"),
        name: s.name || s.code,
        status: "pending", // 初始狀態皆為 pending
        doneTime: null,
        error: null,
        reportText: s.reportText || "",
        systemPrompt: s.systemPrompt || ""
      }))
    };

    saveManifestToCloudDrive(manifestData);
    logToDrive("💾 [實體清單建立] " + MANIFEST_FILE_NAME + " 建立完成，共計 " + stocks.length + " 檔待執行！");

    // 🔒 任務啟動：初始化狀態日誌
    saveStatusReportToCloudDrive({
      status: "running",
      batchId: batchId,
      startTime: startTimeStr,
      lastHeartbeat: new Date().getTime(),
      totalRequested: stocks.length,
      completedCount: 0,
      failedCount: 0,
      currentStock: manifestData.stocks[0]?.name || "",
      currentCode: manifestData.stocks[0]?.code || "",
      progressPercent: 0,
      completedCodes: [],
      failedList: [],
      isCircuitBroken: false,
      breakReason: ""
    });

    logToDrive("🏃‍♂️ [啟動事務循環] 正式進入 processManifestLoop，逐筆推導並逐筆註記 done 直到全數完成！");

    // 🚀 核心設計 3：啟動推導 Loop，直到清單中所有股票都註記已完成
    processManifestLoop(apiKey, model);

    return createJsonResponse({
      ok: true,
      message: "批次推導已成功啟動並處理完畢！",
      totalRequested: stocks.length
    }, 200);

  } catch (err) {
    logToDrive("💥 doPost 嚴重例外: " + err.toString());
    return createJsonResponse({ ok: false, error: err.toString() }, 500);
  }
}

/**
 * 🔄 核心事務循環機：讀取未執行的股票代號呼叫 Gemini，完成後即時註記，持續 loop 直到清單全數完成
 */
function processManifestLoop(apiKey, model) {
  const loopStartTs = new Date().getTime();
  let consecutiveFailures = 0;
  let isCircuitBroken = false;
  let breakReason = "";

  while (true) {
    // 🛡️ 時間安全紅線檢查 (防止超過 Google 360 秒硬上限)
    const elapsedSeconds = (new Date().getTime() - loopStartTs) / 1000;
    if (elapsedSeconds >= MAX_SAFE_EXECUTION_SECONDS) {
      isCircuitBroken = true;
      breakReason = "因時間安全防護，Worker 於 " + elapsedSeconds.toFixed(0) + " 秒安全收工，已保留清單進度待續！";
      logToDrive("🛑 [安全收工] " + breakReason);
      break;
    }

    // 1. 讀取最新實體清單檔案
    const manifest = readManifestFromCloudDrive();
    if (!manifest || !Array.isArray(manifest.stocks)) {
      logToDrive("❌ [循環中止] 無法讀取實體清單檔案或清單格式錯誤！");
      break;
    }

    // 2. 尋找下一檔未執行的股票 (status === 'pending')
    const nextPendingStock = manifest.stocks.find(s => s.status === "pending");

    // 3. 🎯 終結條件：清單中所有股票都已經註記已完成！
    if (!nextPendingStock) {
      const doneCount = manifest.stocks.filter(s => s.status === "done").length;
      logToDrive("🏆 [全數完工！] 清單中全數 " + doneCount + "/" + manifest.stocks.length + " 檔皆已註記 done！大功告成！");

      const finalReport = {
        status: "completed",
        batchId: manifest.batchId,
        batchTime: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
        startTime: manifest.createdAt,
        lastHeartbeat: new Date().getTime(),
        totalRequested: manifest.stocks.length,
        completedCount: doneCount,
        failedCount: manifest.stocks.filter(s => s.status === "failed").length,
        currentStock: "",
        currentCode: "",
        progressPercent: 100,
        completedCodes: manifest.stocks.filter(s => s.status === "done").map(s => s.code),
        failedList: manifest.stocks.filter(s => s.status === "failed").map(s => ({ code: s.code, name: s.name, error: s.error })),
        isCircuitBroken: false,
        breakReason: ""
      };

      saveStatusReportToCloudDrive(finalReport);
      break;
    }

    // 4. 開始處理當前 pending 股票
    const code = nextPendingStock.code;
    const name = nextPendingStock.name;
    const reportText = nextPendingStock.reportText;
    const systemPrompt = nextPendingStock.systemPrompt;
    const currentCompleted = manifest.stocks.filter(s => s.status === "done").length;

    // 💓 心跳與狀態即時更新 (通知手機端目前推導到哪一檔)
    saveStatusReportToCloudDrive({
      status: "running",
      batchId: manifest.batchId,
      startTime: manifest.createdAt,
      lastHeartbeat: new Date().getTime(),
      totalRequested: manifest.stocks.length,
      completedCount: currentCompleted,
      failedCount: manifest.stocks.filter(s => s.status === "failed").length,
      currentStock: name,
      currentCode: code,
      progressPercent: Math.round((currentCompleted / manifest.stocks.length) * 100),
      completedCodes: manifest.stocks.filter(s => s.status === "done").map(s => s.code),
      failedList: manifest.stocks.filter(s => s.status === "failed").map(s => ({ code: s.code, name: s.name, error: s.error })),
      isCircuitBroken: false,
      breakReason: ""
    });

    logToDrive("⏳ [推導開始] " + code + " " + name + " (進度: " + (currentCompleted + 1) + "/" + manifest.stocks.length + ")...");

    if (!reportText) {
      logToDrive("⚠️ [" + code + " " + name + "] 缺少指標文本，註記 failed");
      nextPendingStock.status = "failed";
      nextPendingStock.error = "缺少技術指標戰報文本";
      saveManifestToCloudDrive(manifest);
      continue;
    }

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

          // 💾 1. 戰報落地存檔至 gem_strategy_batch.json
          appendReportToCloudDrive(reportData);

          // 📝 2. 在實體清單中將該股票標記為 done！
          nextPendingStock.status = "done";
          nextPendingStock.doneTime = nowStr;
          saveManifestToCloudDrive(manifest);

          success = true;
          consecutiveFailures = 0;
          logToDrive("✅ [註記完成] " + code + " " + name + " 戰報成功落地，清單已註記 done！");
          break;
        }
      } catch (err) {
        lastErrorMsg = err.message || err.toString();
        logToDrive("⚠️ [" + code + " " + name + "] 第 " + attempt + " 次呼叫失敗: " + lastErrorMsg);

        if (lastErrorMsg.includes("429") || lastErrorMsg.includes("503") || lastErrorMsg.includes("overloaded") || lastErrorMsg.includes("ResourceExhausted")) {
          const sleepSeconds = attempt === 1 ? 2 : (attempt === 2 ? 5 : 10);
          Utilities.sleep(sleepSeconds * 1000);
        } else {
          break;
        }
      }
    }

    // 處理單檔最終失敗
    if (!success) {
      consecutiveFailures++;
      nextPendingStock.status = "failed";
      nextPendingStock.error = lastErrorMsg;
      saveManifestToCloudDrive(manifest);
      logToDrive("❌ [" + code + " " + name + "] 推導失敗，清單註記 failed (連續失敗: " + consecutiveFailures + ")");

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        isCircuitBroken = true;
        breakReason = "連續 " + consecutiveFailures + " 檔股票推導失敗，觸發安全熔斷停止後續推導！";
        logToDrive("🛑 [熔斷終止] " + breakReason);
        break;
      }
    }

    // 溫和間隔防抖
    Utilities.sleep(600);
  }

  // 若因安全煞車或熔斷跳出，更新狀態日誌
  if (isCircuitBroken) {
    const finalManifest = readManifestFromCloudDrive();
    if (finalManifest) {
      const doneCount = finalManifest.stocks.filter(s => s.status === "done").length;
      saveStatusReportToCloudDrive({
        status: "paused",
        batchId: finalManifest.batchId,
        batchTime: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
        startTime: finalManifest.createdAt,
        lastHeartbeat: new Date().getTime(),
        totalRequested: finalManifest.stocks.length,
        completedCount: doneCount,
        failedCount: finalManifest.stocks.filter(s => s.status === "failed").length,
        currentStock: "",
        currentCode: "",
        progressPercent: Math.round((doneCount / finalManifest.stocks.length) * 100),
        completedCodes: finalManifest.stocks.filter(s => s.status === "done").map(s => s.code),
        failedList: finalManifest.stocks.filter(s => s.status === "failed").map(s => ({ code: s.code, name: s.name, error: s.error })),
        isCircuitBroken: true,
        breakReason: breakReason
      });
    }
  }
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

    // 將多餘的非垃圾桶重複同名檔案清理，保持唯一直屬檔案
    for (let i = 0; i < trashedOrOld.length; i++) {
      try { trashedOrOld[i].setTrashed(true); } catch (e) {}
    }

    return latestFile;
  } catch (err) {
    return null;
  }
}

/**
 * 實體清單檔案讀取與儲存函式 (gem_batch_manifest.json)
 */
function readManifestFromCloudDrive() {
  try {
    const file = getValidDriveFile(MANIFEST_FILE_NAME);
    if (file) {
      const content = file.getContentText();
      if (content) return JSON.parse(content);
    }
  } catch (e) {
    logToDrive("讀取 Manifest 失敗: " + e.toString());
  }
  return null;
}

function saveManifestToCloudDrive(manifestData) {
  const jsonStr = JSON.stringify(manifestData, null, 2);
  const file = getValidDriveFile(MANIFEST_FILE_NAME);
  if (file) {
    file.setContent(jsonStr);
  } else {
    DriveApp.createFile(MANIFEST_FILE_NAME, jsonStr, MimeType.PLAIN_TEXT);
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

/**
 * 呼叫 Google 官方 Gemini REST API
 */
function callGeminiApi(apiKey, model, systemPrompt, userContent) {
  const cleanModel = encodeURIComponent(model);
  const cleanKey = encodeURIComponent(apiKey);
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + cleanModel + ":generateContent?key=" + cleanKey;

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
    let errMsg = "HTTP " + responseCode;
    try {
      const errObj = JSON.parse(responseText);
      if (errObj.error && errObj.error.message) {
        errMsg += ": " + errObj.error.message;
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
  saveStatusReportToCloudDrive({
    test: "success",
    time: new Date().toISOString()
  });
  logToDrive("✅ Google Drive 存取測試成功！");
}
