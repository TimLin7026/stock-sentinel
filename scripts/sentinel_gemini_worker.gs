/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 💎 台股戰情室 — 富貴 Gem 雲端智慧戰報實體清單循環推導機
 * (Transactional Manifest Loop Worker for Google Apps Script)
 * ═══════════════════════════════════════════════════════════════════════════
 * 📌 對應版本：v2.20261028.07
 * 🕒 更新日期：2026-10-28
 * 🎯 架構特色：股票代號 + 證券商 (code + broker) 多帳戶獨立策略體系 & 3 檔平行併發
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
const BATCH_CONCURRENCY = 3;           // 🚀 每批平行併發調用 Gemini API 之個股數量 (加速 3 倍)

/**
 * 📝 Google Drive 即時黑盒子追蹤日誌 (寫入 gem_batch_debug.txt)
 */
function logToDrive(msg, isOverwrite) {
  try {
    const timeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss.SSS");
    const line = "[" + timeStr + "] " + msg + "\n";
    Logger.log(line.trim());
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
  } catch (e) {
    Logger.log("logToDrive 異常: " + e.toString());
  }
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
          processManifestLoop(apiKey, model, manifest);
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

    // 🧹 同步初始化舊的 gem_strategy_batch.json，確保本次全新派工戰報乾淨累積
    try {
      const oldBatchFile = getValidDriveFile(BATCH_FILE_NAME);
      if (oldBatchFile) {
        oldBatchFile.setContent("[]");
      }
    } catch (eCleanBatch) {}

    const batchId = "batch_" + new Date().getTime();
    const startTimeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

    // 📋 核心設計 2：每次上傳清空並寫入全新的實體清單檔案 (gem_batch_manifest.json)
    const manifestData = {
      batchId: batchId,
      createdAt: startTimeStr,
      apiKey: apiKey,
      model: model,
      totalCount: stocks.length,
      stocks: stocks.map(s => {
        const sc = String(s.code || "").padStart(4, "0");
        const bk = s.broker || "關注";
        const uid = s.uid || (sc + "_" + bk);
        return {
          code: sc,
          name: s.name || s.code,
          broker: bk,
          uid: uid,
          status: "pending", // 初始狀態皆為 pending
          doneTime: null,
          error: null,
          reportText: s.reportText || "",
          systemPrompt: s.systemPrompt || ""
        };
      })
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

    // 🚀 核心設計 3：啟動推導 Loop，直接傳入記憶體物件，徹底杜絕 Google Drive 剛建檔時的查詢延遲！
    processManifestLoop(apiKey, model, manifestData);

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
 * @param {string} apiKey - Gemini API 金鑰
 * @param {string} model - 模型名稱
 * @param {Object} [initialManifest] - 可選。由呼叫端直接直通傳入之清單物件，避免立即讀取 Drive 的延遲
 */
function processManifestLoop(apiKey, model, initialManifest) {
  const loopStartTs = new Date().getTime();
  let consecutiveFailures = 0;
  let isCircuitBroken = false;
  let breakReason = "";

  // 🛡️ 核心防護 1：首輪直接使用傳入之記憶體清單物件；若無傳入則自 Drive 讀取
  let manifest = initialManifest || null;
  if (!manifest) {
    manifest = readManifestFromCloudDrive();
  }

  if (!manifest || !Array.isArray(manifest.stocks)) {
    logToDrive("❌ [循環中止] 無法讀取實體清單檔案或清單格式錯誤！");
    return;
  }

  // 💾 核心戰報記憶體累積器：杜絕每檔讀取 Google Drive 導致的覆寫與延遲漏洞！
  let accumulatedReports = [];
  let batchDriveFile = getValidDriveFile(BATCH_FILE_NAME);

  if (batchDriveFile) {
    try {
      const rawBatch = batchDriveFile.getContentText();
      if (rawBatch) {
        const parsed = JSON.parse(rawBatch);
        if (Array.isArray(parsed)) accumulatedReports = parsed;
      }
    } catch (e) {
      logToDrive("⚠️ 讀取現有 gem_strategy_batch.json 失敗，以空陣列初始化: " + e.toString());
    }
  } else {
    try {
      batchDriveFile = DriveApp.createFile(BATCH_FILE_NAME, "[]", MimeType.PLAIN_TEXT);
    } catch (e) {
      logToDrive("⚠️ 建立 gem_strategy_batch.json 異常: " + e.toString());
    }
  }

  logToDrive("📦 [戰報累積器就緒] 目前現存戰報筆數: " + accumulatedReports.length + "，準備開始循環推進！");

  while (true) {
    // 🛡️ 時間安全紅線檢查 (防止超過 Google 360 秒硬上限)
    const elapsedSeconds = (new Date().getTime() - loopStartTs) / 1000;
    if (elapsedSeconds >= MAX_SAFE_EXECUTION_SECONDS) {
      isCircuitBroken = true;
      breakReason = "因時間安全防護，Worker 於 " + elapsedSeconds.toFixed(0) + " 秒安全收工，已保留清單進度待續！";
      logToDrive("🛑 [安全收工] " + breakReason);
      break;
    }

    // 🚀 取出下一批待執行的股票 (status === 'pending')，最多 BATCH_CONCURRENCY 檔 (預設 3 檔平行)
    const pendingBatch = manifest.stocks.filter(s => s.status === "pending").slice(0, BATCH_CONCURRENCY);

    // 🎯 終結條件：清單中所有股票都已經註記已完成！
    if (pendingBatch.length === 0) {
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
        completedCodes: manifest.stocks.filter(s => s.status === "done").map(s => s.uid || (s.code + "_" + (s.broker || "關注"))),
        failedList: manifest.stocks.filter(s => s.status === "failed").map(s => ({ code: s.code, name: s.name, broker: s.broker || "關注", uid: s.uid || (s.code + "_" + (s.broker || "關注")), error: s.error })),
        isCircuitBroken: false,
        breakReason: ""
      };

      saveStatusReportToCloudDrive(finalReport);
      break;
    }

    // 4. 開始處理當前批次 (平行併發組裝)
    const currentCompleted = manifest.stocks.filter(s => s.status === "done").length;
    const batchNames = pendingBatch.map(s => s.name + "(" + (s.broker || "關注") + ")").join(", ");
    const batchCodes = pendingBatch.map(s => s.code).join(", ");

    // 💓 心跳與狀態即時更新 (通知手機端目前推導哪幾檔)
    saveStatusReportToCloudDrive({
      status: "running",
      batchId: manifest.batchId,
      startTime: manifest.createdAt,
      lastHeartbeat: new Date().getTime(),
      totalRequested: manifest.stocks.length,
      completedCount: currentCompleted,
      failedCount: manifest.stocks.filter(s => s.status === "failed").length,
      currentStock: batchNames,
      currentCode: batchCodes,
      progressPercent: Math.round((currentCompleted / manifest.stocks.length) * 100),
      completedCodes: manifest.stocks.filter(s => s.status === "done").map(s => s.uid || (s.code + "_" + (s.broker || "關注"))),
      failedList: manifest.stocks.filter(s => s.status === "failed").map(s => ({ code: s.code, name: s.name, broker: s.broker || "關注", uid: s.uid || (s.code + "_" + (s.broker || "關注")), error: s.error })),
      isCircuitBroken: false,
      breakReason: ""
    });

    logToDrive("⚡ [併發推導啟動] 同時調用 " + batchCodes + " (" + batchNames + ") 共 " + pendingBatch.length + " 檔...");

    // 組裝各檔的 Gemini API 請求
    const cleanModel = encodeURIComponent(model);
    const cleanKey = encodeURIComponent(apiKey);
    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + cleanModel + ":generateContent?key=" + cleanKey;

    const validStocksInBatch = [];
    const requests = [];

    for (let sIdx = 0; sIdx < pendingBatch.length; sIdx++) {
      const stock = pendingBatch[sIdx];
      if (!stock.reportText) {
        logToDrive("⚠️ [" + stock.code + " " + stock.name + "] 缺少指標文本，註記 failed");
        stock.status = "failed";
        stock.error = "缺少技術指標戰報文本";
        saveManifestToCloudDrive(manifest);
        continue;
      }

      validStocksInBatch.push(stock);

      const payload = {
        contents: [{ role: "user", parts: [{ text: stock.reportText }] }]
      };
      if (stock.systemPrompt) {
        payload.systemInstruction = { parts: [{ text: stock.systemPrompt }] };
      }

      requests.push({
        url: geminiUrl,
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    }

    if (validStocksInBatch.length === 0) {
      continue;
    }

    // 🚀 平行調用 UrlFetchApp.fetchAll
    let responses = [];
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (eFetchAll) {
      logToDrive("💥 [平行調用例外] UrlFetchApp.fetchAll 異常: " + eFetchAll.toString());
      for (let fIdx = 0; fIdx < validStocksInBatch.length; fIdx++) {
        const st = validStocksInBatch[fIdx];
        st.retryCount = (st.retryCount || 0) + 1;
        if (st.retryCount >= MAX_RETRY_COUNT) {
          st.status = "failed";
          st.error = eFetchAll.toString();
        }
      }
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        isCircuitBroken = true;
        breakReason = "連續 " + consecutiveFailures + " 批平行調用失敗，觸發安全熔斷！";
        logToDrive("🛑 [熔斷終止] " + breakReason);
        break;
      }
      Utilities.sleep(2000);
      continue;
    }

    // 逐筆解析回傳結果
    let anySuccessInBatch = false;
    let anyRateLimitInBatch = false;
    const nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

    for (let rIdx = 0; rIdx < validStocksInBatch.length; rIdx++) {
      const stock = validStocksInBatch[rIdx];
      const resp = responses[rIdx];

      // 🛡️ 關鍵防護：為同批次各檔賦予獨立唯一的秒數時間戳，徹底杜絕撞秒覆寫！
      const stockDate = new Date(new Date().getTime() + rIdx * 1000);
      const stockTimeStr = Utilities.formatDate(stockDate, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

      if (!resp) {
        stock.status = "failed";
        stock.error = "未收到伺服器回應";
        continue;
      }

      const responseCode = resp.getResponseCode();
      const responseText = resp.getContentText();

      if (responseCode === 200) {
        try {
          const data = JSON.parse(responseText);
          if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
            const generatedText = data.candidates[0].content.parts[0].text;
            const parsed = parseStrategyContent(generatedText, stock.code);

            const stockBroker = stock.broker || "關注";
            const stockUid = stock.uid || (stock.code + "_" + stockBroker);

            const reportData = {
              recordTime: stockTimeStr,
              code: stock.code,
              name: stock.name,
              broker: stockBroker,
              uid: stockUid,
              raw: parsed.raw,
              summary: parsed.summary,
              buyLow: parsed.buyLow,
              buyHigh: parsed.buyHigh,
              defense: parsed.defense,
              targetLow: parsed.targetLow,
              targetHigh: parsed.targetHigh
            };

            // 💾 記憶體累積陣列直推 (以 uid = code_broker 為唯一識別，玉山與中信同代碼共存！)
            accumulatedReports = accumulatedReports.filter(r => {
              const rUid = r.uid || (r.code + "_" + (r.broker || "關注"));
              return rUid !== stockUid;
            });
            accumulatedReports.push(reportData);

            stock.status = "done";
            stock.doneTime = stockTimeStr;
            stock.error = null;
            anySuccessInBatch = true;
            logToDrive("✅ [" + stock.code + " " + stock.name + "] 戰報推導成功！(時間戳: " + stockTimeStr + ")");
          } else {
            stock.status = "failed";
            stock.error = "Gemini 回傳結構無有效文本";
            logToDrive("❌ [" + stock.code + " " + stock.name + "] 解析失敗: 無有效文本結構");
          }
        } catch (errJson) {
          stock.status = "failed";
          stock.error = "戰報解析例外: " + errJson.toString();
          logToDrive("❌ [" + stock.code + " " + stock.name + "] 文本解析異常: " + errJson.toString());
        }
      } else {
        // HTTP 非 200 (429 忙碌或其他)
        let errMsg = "HTTP " + responseCode;
        try {
          const errObj = JSON.parse(responseText);
          if (errObj.error && errObj.error.message) errMsg += ": " + errObj.error.message;
        } catch (eParse) {}

        stock.retryCount = (stock.retryCount || 0) + 1;
        if (stock.retryCount < MAX_RETRY_COUNT && (responseCode === 429 || responseCode === 503 || responseText.includes("ResourceExhausted") || responseText.includes("overloaded"))) {
          stock.status = "pending";
          anyRateLimitInBatch = true;
          logToDrive("⚠️ [" + stock.code + " " + stock.name + "] 遇 " + errMsg + "，第 " + stock.retryCount + " 次重試等待下一批");
        } else {
          stock.status = "failed";
          stock.error = errMsg;
          logToDrive("❌ [" + stock.code + " " + stock.name + "] 推導失敗: " + errMsg);
        }
      }
    }

    // 💾 1. 本批次處理完畢，將累積戰報全集寫入 gem_strategy_batch.json
    try {
      if (!batchDriveFile) {
        batchDriveFile = getValidDriveFile(BATCH_FILE_NAME) || DriveApp.createFile(BATCH_FILE_NAME, "[]", MimeType.PLAIN_TEXT);
      }
      batchDriveFile.setContent(JSON.stringify(accumulatedReports, null, 2));
    } catch (eWriteBatch) {
      logToDrive("⚠️ 寫入 gem_strategy_batch.json 異常: " + eWriteBatch.toString());
    }

    // 📝 2. 同步寫回實體清單檔案
    saveManifestToCloudDrive(manifest);

    const currentDoneCount = manifest.stocks.filter(s => s.status === "done").length;
    logToDrive("📊 [批次完工] 目前進度: " + currentDoneCount + "/" + manifest.stocks.length + " 檔已註記 done (累計戰報: " + accumulatedReports.length + " 筆)");

    if (anySuccessInBatch) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        isCircuitBroken = true;
        breakReason = "連續 " + consecutiveFailures + " 批平行推導全數失敗，觸發安全熔斷停止後續推導！";
        logToDrive("🛑 [熔斷終止] " + breakReason);
        break;
      }
    }

    // 遇 429 忙碌時多休息 3 秒避讓，平時溫和間隔 500ms
    if (anyRateLimitInBatch) {
      Utilities.sleep(3000);
    } else {
      Utilities.sleep(500);
    }
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
