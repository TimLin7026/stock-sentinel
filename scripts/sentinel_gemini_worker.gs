/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 💎 台股戰情室 — 富貴 Gem 雲端智慧戰報實體清單循環推導機
 * (Transactional Manifest Loop Worker for Google Apps Script)
 * ═══════════════════════════════════════════════════════════════════════════
 * 📌 對應版本：v2.20261111.04
 * 🕒 更新日期：2026-11-11
 * 🎯 架構特色：股票代號 + 證券商 (code + broker) 多帳戶獨立策略體系 & 3 檔平行併發
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 📌 核心架構與部署規範：
 * 1. 實體清單檔案定錨：所有待辦股票持久化存入 Drive 的「gem_batch_manifest.json」。
 * 2. 上傳即清空重置：每次新派工，徹底清空舊清單與除錯日誌「gem_batch_debug.txt」。
 * 3. 逐筆推導、逐筆註記：讀取 pending 股票呼叫 Gemini，產出戰報存入 json 後立即標記 done。
 * 4. 循環推進直到全數完工：持續 loop 直到清單中所有股票都註記 done，才標記 completed。
 * 5. 支援手機鎖屏離線：派工後 0.8 秒即可關閉網頁鎖屏，GAS 在雲端獨立滿血跑完。
 * 6. 徹底摒除跨請求排程：無 Trigger、無自閉 Webhook，純粹高穩定單一執行循環。
 * 7. 🔑【重要授權步驟】：貼上代碼儲存後，務必先於上方函式選單選取「testDrivePermission」並點【執行】完成 Drive 授權，再前往右上角【部署】！
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
    // 支援全域大勢專題戰報 (全球美股 / 台股籌碼 / 產業輪動 / ETF焦點)
    if (e && e.parameter && e.parameter.action === "generate_topic_report") {
      logToDrive("🌐 [doGet] 收到專題戰報生成請求: " + (e.parameter.topic || "global"));
      const topicResult = handleTopicReportRequest(e.parameter);
      return createJsonResponse(topicResult, topicResult.ok ? 200 : 500);
    }

    // 支援斷點續跑未完成的清單股票
    if (e && e.parameter && e.parameter.action === "resume_manifest") {
      logToDrive("⚡ [doGet] 收到斷點續跑請求，準備讀取現存未執行清單...");
      const manifest = readManifestFromCloudDrive();
      if (manifest && manifest.stocks) {
        // 🌟 收到外部新的觸發：將 pending 以及未達重試上限的 failed 股票重置為 pending 接續重跑！
        const retryableStocks = manifest.stocks.filter(s => s.status === "pending" || (s.status === "failed" && (!s.retryCount || s.retryCount < MAX_RETRY_COUNT)));
        if (retryableStocks.length > 0) {
          retryableStocks.forEach(s => {
            if (s.status === "failed") {
              s.status = "pending";
              s.error = null;
            }
          });
          saveManifestToCloudDrive(manifest);
          const apiKey = (e.parameter.apiKey || manifest.apiKey || "").trim();
          const model = (e.parameter.model || manifest.model || "gemini-3.8-flash").trim();
          if (apiKey) {
            processManifestLoop(apiKey, model, manifest);
            return createJsonResponse({ ok: true, message: "未執行/失敗重試清單已接續啟動推導 (" + retryableStocks.length + " 檔)" }, 200);
          }
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
    
    // 支援全域大勢專題戰報 (POST 模式)
    if (payload.action === "generate_topic_report") {
      logToDrive("🌐 [doPost] 收到專題戰報生成請求: " + (payload.topic || "global"));
      const topicResult = handleTopicReportRequest(payload);
      return createJsonResponse(topicResult, topicResult.ok ? 200 : 500);
    }

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

            // 🛡️ 戰報完整性嚴格審核：不完整的戰報絕對不存 JSON，並註記失敗等待新觸發！
            const validation = isStrategyReportComplete(parsed, generatedText);
            if (!validation.ok) {
              stock.status = "failed";
              stock.error = "戰報內容不完整: " + validation.reason;
              stock.retryCount = (stock.retryCount || 0) + 1;
              logToDrive("⚠️ [" + stock.code + " " + stock.name + "] 戰報不完整 (" + validation.reason + ")，放棄存檔並註記 failed，等待下次觸發");
              continue;
            }

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
            logToDrive("✅ [" + stock.code + " " + stock.name + "] 戰報推導完整成功！(時間戳: " + stockTimeStr + ")");
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
/**
 * 🛡️ 審核戰報內容之【系統解析專用區塊】格式是否完整
 * 必須完整包含 [REPORT_START] 與 [REPORT_END] 邊界，且 7 大欄位全數具備 (防腰斬截斷)
 */
function isStrategyReportComplete(parsed, rawText) {
  if (!rawText || typeof rawText !== "string") {
    return { ok: false, reason: "戰報原始文本為空" };
  }
  const cleanRaw = rawText.trim();

  // 1. 檢驗專用區塊邊界標記：必須同時具備 [REPORT_START] 與 [REPORT_END]
  const hasStart = cleanRaw.includes("[REPORT_START]") || cleanRaw.includes("REPORT_START");
  const hasEnd = cleanRaw.includes("[REPORT_END]") || cleanRaw.includes("REPORT_END");

  if (!hasStart || !hasEnd) {
    const miss = [];
    if (!hasStart) miss.push("[REPORT_START]");
    if (!hasEnd) miss.push("[REPORT_END]");
    return { ok: false, reason: "缺少系統解析專用區塊邊界標記: " + miss.join(", ") };
  }

  // 確保 [REPORT_START] 在 [REPORT_END] 之前
  const startIdx = cleanRaw.indexOf("REPORT_START");
  const endIdx = cleanRaw.indexOf("REPORT_END");
  if (startIdx >= endIdx) {
    return { ok: false, reason: "解析專用區塊標記順序異常 (REPORT_START 位於 REPORT_END 之後)" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "解析結構物件無效" };
  }

  // 2. 檢驗 7 大關鍵欄位是否全數成功匹配且具備有效格式
  const missingFields = [];

  // (1) 代碼
  if (!parsed.code || String(parsed.code).trim().length === 0) {
    missingFields.push("代碼");
  }

  // (2) 戰情總結 (長度需 >= 5 字)
  if (!parsed.summary || String(parsed.summary).trim().length < 5) {
    missingFields.push("戰情總結");
  }

  // (3) 佈局區間下限 (必須為有效數字且 >= 0，支援極端行情觀望填 0)
  if (parsed.buyLow === null || parsed.buyLow === undefined || isNaN(Number(parsed.buyLow)) || Number(parsed.buyLow) < 0) {
    missingFields.push("佈局區間下限");
  }

  // (4) 佈局區間上限 (必須為有效數字且 >= 0，支援極端行情觀望填 0)
  if (parsed.buyHigh === null || parsed.buyHigh === undefined || isNaN(Number(parsed.buyHigh)) || Number(parsed.buyHigh) < 0) {
    missingFields.push("佈局區間上限");
  }

  // (5) 防守停損點 (必須為有效數字且 >= 0，支援 ETF 填 0)
  if (parsed.defense === null || parsed.defense === undefined || isNaN(Number(parsed.defense)) || Number(parsed.defense) < 0) {
    missingFields.push("防守停損點");
  }

  // (6) 目標調節下限 (必須為有效數字且 >= 0)
  if (parsed.targetLow === null || parsed.targetLow === undefined || isNaN(Number(parsed.targetLow)) || Number(parsed.targetLow) < 0) {
    missingFields.push("目標調節下限");
  }

  // (7) 目標調節上限 (必須為有效數字且 >= 0)
  if (parsed.targetHigh === null || parsed.targetHigh === undefined || isNaN(Number(parsed.targetHigh)) || Number(parsed.targetHigh) < 0) {
    missingFields.push("目標調節上限");
  }

  if (missingFields.length > 0) {
    return { ok: false, reason: "解析專用區塊缺失必要欄位: " + missingFields.join(", ") };
  }

  // (8) 數值邏輯校驗：上限不可小於下限 (若兩者皆為 0 代表觀望，0 >= 0 合法通過)
  const bLow = Number(parsed.buyLow);
  const bHigh = Number(parsed.buyHigh);
  if (bHigh < bLow) {
    return { ok: false, reason: "佈局區間上限小於下限 (" + bHigh + " < " + bLow + ")" };
  }

  return { ok: true, reason: "系統解析專用區塊格式完整無缺" };
}

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
 * 🔑 核心授權與測試進入點 (初次部署或更新請務必執行一次)：
 * 
 * 📌 使用方式：
 * 在上方函式選單選擇「testDrivePermission」➔ 點擊【執行】。
 * Google 會彈出授權視窗，請點選「審查權限」➔ 選擇您的 Google 帳號 ➔
 * 點擊「進階」➔ 點擊「前往「未命名專案」(不安全)」➔ 點擊「允許」。
 * 看到下方執行紀錄顯示「🎉【Google Drive 授權成功！】」即代表已成功授權，
 * 隨後即可點擊右上角【部署】➔【新增部署作業】！
 */
function testDrivePermission() {
  saveStatusReportToCloudDrive({
    test: "success",
    time: new Date().toISOString()
  });
  logToDrive("✅ Google Drive 存取測試成功！");
  Logger.log("═══════════════════════════════════════════════════════════════════════");
  Logger.log("🎉【Google Drive 授權成功！】專案已具備雲端硬碟讀寫權限。");
  Logger.log("👉 請接續點擊右上角【部署】➔【新增部署作業】完成網頁應用程式發布！");
  Logger.log("═══════════════════════════════════════════════════════════════════════");
}


// ═══════════════════════════════════════════════════════════════════════
// 🌐 全域大勢四大專題戰報引擎 (全球美股 / 台股籌碼 / 產業輪動 / ETF焦點)
// ═══════════════════════════════════════════════════════════════════════

const TOPIC_CONFIGS = {
  global: {
    name: "全球宏觀與美股科技巨頭",
    query: "美股 OR 美債殖利率 OR Fed利率 OR 聯準會 OR 國際局勢 OR 地緣政治 OR 美元指數 OR 通膨CPI OR 科技巨頭 OR 台積電ADR when:2d",
    systemPrompt: "# 角色與任務\n你是一位具備 20 年跨國對沖基金與台股法人操盤經驗的「頂級跨國總經首席策略師兼全球資產配置量化總監」。\n你的任務是根據提供的最新即時新聞與客觀市場事實，為台灣投資人與小資族撰寫一份「100% 時事驅動、專業穿透、直切核心」的全球宏觀與美股美債旗艦深度戰報。\n\n【四大核心原則與嚴格禁令】\n1. 嚴禁任何教科書空泛理論（嚴禁名詞解釋、嚴禁泛泛而談的理論）！每一點分析必須 100% 緊扣近期 24～48 小時內發生的「國際地緣政治、美國大選政策、最新經濟數據、Fed 利率動態、美債殖利率波動與科技巨頭財報/股價」展開！\n2. 嚴禁輸出任何思考草稿、排版規劃或字數統計（例如 Section 2: ~420 chars 等），直接從第一大標題開始輸出！\n3. 嚴禁使用「<」或「>」等角括號符號（請改用一般全形括號（）或「」以免網頁 HTML 標籤解析錯誤導致內容被吞噬）！\n4. 五大區塊必須 100% 全部寫完，總字數嚴格控制在 1000～1400 繁體中文字。\n\n【硬性輸出格式規範】\n必須且僅能輸出以下五大區塊：\n\n### 🌡️ 全球股債匯即時溫度計 ＆ 一句話大局定錨\n- **全球宏觀狀態**：[🟢 積極進攻 / 🟡 震盪觀望 / 🔴 防禦避險]（根據美股主要指數、美債殖利率與匯率波動三選一）\n- **一句話定錨**：[用一句 35 字以內的極度精闢白話，緊扣當前國際政經最新時事，點破美股美債對台股的最深層牽引]\n\n### 🌐 國際局勢重大突變 ＆ 全球政經深層影響\n- **地緣政治與全球貿易政策動態**：[結合最新 24～48 小時新聞，深度剖析中東局勢、俄烏地緣風向、美中貿易政策或關稅角力，對全球供應鏈、國際原油與關鍵原物料成本的實質衝擊]\n- **主要經濟體動態與資金偏好**：[盤點美、歐、日、中等主要經濟體最新財政或貨幣動向，分析全球避險熱錢是在回流美元資產，還是外溢至新興市場？]\n\n### 🏛️ 美股與美債聯動透析 ＆ Fed 利率政策最新影響\n- **Fed 利率路徑與通膨就業攻防**：[緊扣最新聯準會官員發言、會議決策動態或通膨數據，深入剖析當前利率維持或降息步伐是急是緩？]\n- **美債殖利率曲線 ＆ 對科技巨頭本益比定價**：[分析美國 10 年期與 2 年期公債殖利率即時走勢，解析公債利率波動如何重定價美股七巨頭（Magnificent 7）估值，並如何透過台積電 ADR 等科技權值股連動牽制台股]\n- **美元指數（DXY）與外資錢袋子連動**：[解析美元指數強弱對新台幣匯率的牽引，外資在台股期現貨資金到底是偏向匯入買超還是防禦撤退？]\n\n### 🔭 教小資族怎麼觀察未來趨勢？（手把手看懂三大關鍵指標）\n- 📊 **指標一：通膨與就業數據（CPI / PCE / 非農就業）** ➔ [大白話教學：數據公布高於或低於預期時，如何分辨是「經濟強韌（軟著陸）」還是「通膨復燃 / 衰退警訊」？小資族何時該提高風險戒備？]\n- 🎯 **指標二：FedWatch 降息機率 ＆ 10 年期美債殖利率** ➔ [大白話教學：如何將 10 年期美債殖利率 4.0%～4.5% 視為股債性價比的關鍵分水嶺？如何看出法人大資金何時開始股債移轉？]\n- ⚡ **指標三：恐慌指數 VIX ＆ 美元指數 DXY 雙信號** ➔ [大白話教學：當市場劇烈震盪時，如何利用這兩個指標抓出全球市場恐慌情緒的高潮與反轉右側買點？]\n\n### 🧭 小資族資產配置實戰策略建議（具體股/債/現金比例與下單心法）\n- 🥇 **當前最佳資產配置比例**：[明確給出具體百分比配置建議（例如：美股成長/指數 40% + 台股核心 30% + 長天期美債 20% + 現金儲備 10%），並清楚說明在當前國際政經與利率環境下的配置邏輯]\n- 🎯 **實戰分批建倉與買進心法**：[指導小資族面對當前利率與政經震盪，具體該在何種回檔位階（如回測關鍵均線支撐）分批分筆進場，切忌單筆一次歐印追高]\n- ⚠️ **當前強烈建議「暫時避開/觀望」的資產類別**：[直白明確警告：當前局勢下哪一類資產風險極高（如缺乏獲利支撐的高估值題材投機股、受貿易摩擦或高利率直接衝擊的受害族群），切忌盲目搶反彈]"
  },
  tw: {
    name: "台股政經與國安法人攻防",
    query: "台股 OR 國安基金 OR 金管會 OR 外資買賣超 OR 融資券 OR 台指期 when:1d",
    systemPrompt: "# 角色與任務\n你是一位精通台灣政府財經政策與主力籌碼攻防的首席策略師。\n你的任務是根據提供的最新即時新聞，為沒時間細讀、不懂複雜籌碼的台灣上班族與小資族，撰寫一份「白話 3 分鐘看懂」的台股政策與籌碼戰報。\n\n【硬性輸出格式規範與四大嚴格禁令】\n1. 必須且僅能輸出以下三大區塊，語氣專業白話、直切核心，嚴禁冗長贅詞，總字數嚴格控制在 600～850 繁體中文字。\n2. 嚴禁輸出任何思考草稿、排版規劃或字數統計（例如 Section 2: ~420 chars 等），直接從第一大標題開始輸出！\n3. 嚴禁使用「<」或「>」等角括號符號（請改用一般全形括號（）或「」以免網頁 HTML 標籤解析錯誤導致內容被吞噬）！\n4. 三大區塊與三大大事要點（1、2、3）必須 100% 全部寫完，嚴禁中途截斷！\n\n### 🌡️ 市場溫度計 ＆ 一句話大局\n- **政策籌碼狀態**：[🟢 綠燈謹慎 / 🟡 黃燈震盪 / 🔴 紅燈偏多]（請根據政策與法人籌碼大勢三選一）\n- **一句話定錨**：[用一句 35 字以內的極度白話，精準總結當前政府政策護盤意願與主力籌碼動向]\n\n### 🏛️ 三件你必須知道的台股大事（人話翻譯）\n1. **政府政策與護盤態度** ➔ [人話翻譯：近期重大財經政策、國安基金或公股行庫動態，台股下檔支撐鐵板在哪裡？]\n2. **外資期現貨對沖真相** ➔ [人話翻譯：外資近期的買賣超與期貨淨空單，到底是在真倒貨還是假避險？]\n3. **散戶融資與內資攻防** ➔ [人話翻譯：散戶融資浮額清洗程度、投信內資大單支撐力道如何？]\n\n### 🧭 上班族/小資防坑指南\n- [白話直接告訴讀者：現在有政策保護傘的族群有哪些？哪些是純炒作題材別碰？給出具體 2~3 點守穩均線與分批佈局策略。]"
  },
  industry: {
    name: "熱門產業鏈與題材輪動",
    query: "AI伺服器 OR 散熱 OR 先進封裝 OR 矽光子 OR 機器人 OR 半導體設備 when:1d",
    systemPrompt: "# 角色與任務\n你是一位精通台股熱門電子與傳產族群輪動的首席產業分析師。\n你的任務是根據提供的最新即時新聞，為沒時間細讀產業報告的台灣上班族與小資族，撰寫一份「白話 3 分鐘看懂」的熱門產業輪動戰報。\n\n【硬性輸出格式規範與四大嚴格禁令】\n1. 必須且僅能輸出以下三大區塊，語氣專業白話、直切核心，嚴禁冗長贅詞，總字數嚴格控制在 600～850 繁體中文字。\n2. 嚴禁輸出任何思考草稿、排版規劃或字數統計（例如 Section 2: ~420 chars 等），直接從第一大標題開始輸出！\n3. 嚴禁使用「<」或「>」等角括號符號（請改用一般全形括號（）或「」以免網頁 HTML 標籤解析錯誤導致內容被吞噬）！\n4. 三大區塊與三大大事要點（1、2、3）必須 100% 全部寫完，嚴禁中途截斷！\n\n### 🌡️ 市場溫度計 ＆ 一句話大局\n- **族群輪動狀態**：[🟢 綠燈謹慎 / 🟡 黃燈震盪 / 🔴 紅燈偏多]（請根據盤面資金輪動熱度三選一）\n- **一句話定錨**：[用一句 35 字以內的極度白話，精準總結當前主流領漲族群與資金真實去向]\n\n### ⚡ 三件你必須知道的產業大事（人話翻譯）\n1. **今日主流領跑族群** ➔ [人話翻譯：最吸金的族群（如AI伺服器/先進封裝/散熱等），是真有營收訂單拉貨，還是純消息炒作？]\n2. **產業鏈上下游傳導** ➔ [人話翻譯：這個產業鏈上誰吃肉（高毛利關鍵零組件）、誰喝湯、誰面臨預算排擠？]\n3. **主流強勢股 vs 掩護撤退股** ➔ [人話翻譯：如何分辨哪些是剛起跑第一棒，哪些是高檔放量主力掩護撤退？]\n\n### 🧭 上班族/小資防坑指南\n- [白話直接告訴讀者：面對當前熱門族群，拉回時該鎖定哪些技術指標（如守住MA10/布林中軌）再切入？哪類狂飆追高的股票千萬別碰？]"
  },
  etf: {
    name: "ETF 資金浪潮與除權息",
    query: "高股息 ETF OR 00878 OR 00919 OR 0056 OR 0050 OR 006208 OR 00679B OR ETF除息 OR ETF換股 OR 平準金 OR 殖利率 when:2d",
    systemPrompt: "# 角色與任務\n你是一位具備 20 年法人操盤與被動指數量化研究背景的「台灣頂級資產配置策略總監兼 ETF 首席量化架構師」。\n你的任務是根據提供的最新即時新聞、除權息公告與市場事實，為台灣小資族與上班族撰寫一份「100% 時事驅動、專業穿透、直截了當」的 ETF 旗艦深度戰報。\n\n【四大核心原則與嚴格禁令】\n1. 嚴禁任何教科書名詞解釋與空泛雞湯（嚴禁解釋什麼是微笑曲線、什麼是定存複利、ETF 基礎定義等）！\n2. 每一點分析必須 100% 緊扣「近期 24～48 小時內發生的最新時事新聞、除息公告、投信換股動態或行情數據」展開！\n3. 嚴禁輸出任何思考草稿、排版規劃或字數統計（例如 Section 2: ~420 chars 等），直接從第一大標題開始輸出！\n4. 嚴禁使用「<」或「>」等角括號符號（請改用一般全形括號（）或「」以免網頁 HTML 標籤解析錯誤導致內容被吞噬）！\n5. 五大區塊必須 100% 全部寫完，總字數嚴格控制在 1000～1400 繁體中文字。\n\n【硬性輸出格式規範】\n必須且僅能輸出以下五大區塊：\n\n### 🌡️ ETF 今日即時溫度計 ＆ 一句話大局定錨\n- **今日盤面風格狀態**：[🟢 攻守兼備 / 🟡 震盪分歧 / 🔴 偏向防禦]（根據今日台股大盤與各類 ETF 資金流向三選一）\n- **一句話定錨**：[用一句 35 字以內的極度精闢白話，緊扣今日時事，點破當前買盤是湧入市值型攻動能，還是在高股息/美債避險]\n\n### 📅 本月最新除權息行事曆 ＆ 時事攻防解讀\n- **焦點 ETF 除息日程即時盤點**：[盤點近期（本週/本月）即將除權息的熱門標的（如季配 00878 / 00919 / 0056 / 00918；月配 00929 / 00940 / 00937B 等），清楚列出除息交易日、最新宣告配息金額、單次與年化配息率]\n- **除息日前後時事攻防透析**：[結合最新時事深入點評：某檔配息是否縮水？資本利得公積與收益平準金是否充足？小資族該在除息日前搶進（注意 2 萬元二代健保門檻），還是等除息日跳空開低後進場撿便宜賺填息？]\n\n### 🌊 被動資金浪潮：最新換股潮時事 ＆ 折溢價警訊\n- **成分股大換血最新時事動態**：[緊扣近期投信指數季度調整新聞，數百億被動買盤即將進場為哪些個股抬轎？又有誰可能面臨被無情剔除拋售倒貨？高股息成分股重疊度風險警示]\n- **最新折溢價時事警示**：[盤點近期市場上出現異常溢價（買貴被割韭菜）的熱門 ETF，給予小資即時避坑提醒]\n\n### 🎯 依當前最新時事動態：四大類型 ETF 即時作戰策略\n1. 🏛️ **市值型 ETF (0050 / 006208)** ➔ [結合台積電最新營收法說與大盤動態，指引小資此時回檔是逢低撿便宜機會，還是該嚴守季線防守]\n2. 💰 **高股息 ETF (00878 / 00919 / 0056 / 00929)** ➔ [結合最新配息公告與平準金體檢，指引小資面對配息縮水或填息行情的具體操作]\n3. ⚡ **科技/主題型 ETF (00830 / 00881 / 00757)** ➔ [結合美股科技巨頭最新財報與半導體新聞，指引動能追價或波段停利點位]\n4. 🛡️ **美債型 ETF (00679B / 00687B / 00937B)** ➔ [結合最新美國 Fed 降息動態與美債殖利率即時走勢，分析長天期美債現階段的性價比]\n\n### 🧭 小資族資金精準投向指引（現在該買哪種 ETF？）\n- 🥇 **當前第一首選投向**：[明確點名目前大盤局勢下，小資手邊有新資金最該優先投進哪一種類型，並點名具體代表標的代號（如 006208 或 00919），用大白話講清楚「為什麼現在買它勝率最高」]\n- 🥈 **當前輔助配置投向**：[適合撥出 2~3 成資金進行股債平衡或長線鎖利的次選類型與標的（如美債殖利率高原區之 00679B）]\n- ⚠️ **當前強烈建議「暫時避開/觀望」的踩雷類型**：[直白警告小資族：當前盤勢下哪一種類型風險過高（如配息縮水貼息股、高溢價追高股），切忌盲目把錢投進去當冤大頭]\n- 🎯 **小資即時下單具體配置配比**：[假設每月定期定額 5,000~10,000 元或單筆閒錢，給出明確比重分配（例如：首選標的 60% + 次選標的 30% + 10% 現金預備金）]"
  }
};

/**
 * 處理專題戰報生成請求
 */
function handleTopicReportRequest(params) {
  try {
    const topicKey = (params.topic || "global").toLowerCase();
    const config = TOPIC_CONFIGS[topicKey] || TOPIC_CONFIGS.global;
    const apiKey = (params.apiKey || "").trim();
    const model = (params.model || "gemini-2.5-flash").trim();

    if (!apiKey) {
      return { ok: false, error: "未提供有效的 Gemini API Key" };
    }

    // 1. 即時檢索 Google News RSS
    logToDrive("🔍 正在檢索「" + config.name + "」最新新聞...");
    const newsContext = fetchLatestTopicNews(config.query, config.name);

    // 2. 組裝使用者提問 Context
    const nowTimeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");
    const userPrompt = "【當前檢索時間】" + nowTimeStr + "\n" +
      "【專題領域】" + config.name + "\n\n" +
      "【最新即時熱點新聞參考】\n" + newsContext + "\n\n" +
      "請根據上述最新事實與你的專業智庫，嚴格依照三大區塊輸出最新繁體中文深度戰報：";

    // 3. 呼叫 Gemini REST API
    logToDrive("🤖 正在呼叫 Gemini (" + model + ") 生成專題戰報...");
    const cleanModel = encodeURIComponent(model);
    const cleanKey = encodeURIComponent(apiKey);
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + cleanModel + ":generateContent?key=" + cleanKey;

    const payload = {
      systemInstruction: {
        parts: [{ text: config.systemPrompt }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    const options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    const resText = response.getContentText();

    if (code !== 200) {
      logToDrive("❌ Gemini API 呼叫失敗 (" + code + "): " + resText.substring(0, 200));
      return { ok: false, error: "Gemini 呼叫失敗 (" + code + ")" };
    }

    const data = JSON.parse(resText);
    const candidate = data.candidates && data.candidates[0];
    const generatedText = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] ? candidate.content.parts[0].text : "";

    if (!generatedText) {
      return { ok: false, error: "Gemini 回傳內容為空" };
    }

    logToDrive("🎉「" + config.name + "」專題戰報生成成功 (" + generatedText.length + " 字)！");

    return {
      ok: true,
      topic: topicKey,
      topicName: config.name,
      time: nowTimeStr,
      content: generatedText
    };

  } catch (err) {
    logToDrive("💥 handleTopicReportRequest 異常: " + err.toString());
    return { ok: false, error: err.toString() };
  }
}

/**
 * 抓取 Google News RSS 即時新聞並摘錄
 */
function fetchLatestTopicNews(query, topicName) {
  try {
    const rssUrl = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
    const res = UrlFetchApp.fetch(rssUrl, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return "(新聞暫時無法取得，請依據你最新知識庫進行客觀專業推導)";
    }

    const xml = res.getContentText();
    const doc = XmlService.parse(xml);
    const root = doc.getRootElement();
    const channel = root.getChild("channel");
    if (!channel) return "(無最新新聞項目)";

    const items = channel.getChildren("item");
    const newsList = [];
    const maxItems = Math.min(items.length, 7);

    for (let i = 0; i < maxItems; i++) {
      const item = items[i];
      const title = item.getChildText("title") || "";
      const pubDate = item.getChildText("pubDate") || "";
      const source = item.getChildText("source") || "";
      if (title) {
        newsList.push((i + 1) + ". " + title.replace(/<[^>]+>/g, "").trim() + (source ? " (" + source + ")" : ""));
      }
    }

    return newsList.length > 0 ? newsList.join("\n") : "(無即時新聞)";
  } catch (eRss) {
    return "【即時熱點】" + topicName + " 最新市場動態與資金輪動聚焦。";
  }
}
