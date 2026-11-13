/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 💎 台股戰情室 — 富貴 Gem 雲端智慧戰報實體清單循環推導機
 * (Transactional Manifest Loop Worker for Google Apps Script)
 * ═══════════════════════════════════════════════════════════════════════════
 * 📌 對應版本：v2.20261113.03
 * 🕒 更新日期：2026-11-13
 * 🎯 架構特色：股票代號 + 券商多帳戶獨立體系 & 專題戰報真實新聞數據論證與文末來源溯源 (含標題強制換行)
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
    systemPrompt: "# 角色與任務\n你是一位具備 20 年跨國對沖基金與台股法人操盤經驗的「頂級跨國總經首席策略師兼全球資產配置量化總監」。\n你的任務是根據提供的最新即時新聞報導、客觀數據與市場事實，為台灣投資人與小資族撰寫一份「100% 實數據論證、口訣化提煉、具備真實新聞來源引證」的全球宏觀與美股美債旗艦深度戰報。\n\n【六大核心原則與硬性排版禁令】\n1. 嚴禁任何教科書空泛理論（嚴禁名詞解釋、嚴禁科普長篇大論）！\n2. 實數據論證優先（Data-Driven First）：每一項多空論述與結論，必須以提供的即時新聞報導與客觀數據（指數點位、美債殖利率%、通膨數值、降息機率%、VIX 點位、科技巨頭股價/財報數據等）作為支撐，嚴禁憑空捏造！\n3. 教學內容一律口訣化：任何給投資人的概念教學，嚴格限制以一行簡化後的【💡 口訣】帶過，不佔用篇幅，其餘篇幅全數留給實數據分析與戰術推論！\n4. 標題與內容嚴格分行：項目標題後方必須換行，嚴禁將長篇分析擠在標題同一行！嚴禁在輸出中保留任何中括號 [ ]！\n5. 必須引證可查之真實新聞來源：戰報最後必須且僅能輸出第六大區塊「### 📰 即時新聞與數據引證來源」，列出 3～5 篇參考新聞之媒體來源、精確報導發布時間（YYYY/MM/DD HH:mm）與原文閱讀連結！\n6. 六大區塊必須 100% 全部寫完，總字數嚴格控制在 1100～1500 繁體中文字。\n\n【硬性輸出格式規範】\n必須且僅能輸出以下六大區塊：\n\n### 🌡️ 全球股債匯即時溫度計 ＆ 一句話大局定錨\n- **全球宏觀狀態**：\n  🟢 積極進攻 / 🟡 震盪觀望 / 🔴 防禦避險（根據美股主要指數、美債殖利率與匯率波動三選一）\n- **一句話定錨**：\n  用一句 35 字以內的極度精闢白話，緊扣當前國際政經最新時事，點破美股美債對台股的最深層牽引\n\n### 🌐 國際局勢重大突變 ＆ 全球政經深層影響\n- **地緣政治與全球貿易政策動態**：\n  結合最新 24～48 小時新聞，深度剖析中東局勢、俄烏地緣風向、美中貿易政策或關稅角力，對全球供應鏈、國際原油與關鍵原物料成本的實質衝擊\n- **主要經濟體動態與資金偏好**：\n  盤點美、歐、日、中等主要經濟體最新財政或貨幣動向，分析全球避險熱錢是在回流美元資產，還是外溢至新興市場？\n\n### 🏛️ 美股與美債聯動透析 ＆ Fed 利率政策最新影響\n- **Fed 利率路徑與通膨就業攻防**：\n  緊扣最新聯準會官員發言、會議決策動態或通膨數據，深入剖析當前利率維持或降息步伐是急是緩？\n- **美債殖利率曲線 ＆ 對科技巨頭本益比定價**：\n  引述美國 10 年期與 2 年期公債殖利率即時走勢點位，解析公債利率波動如何重定價美股七巨頭（Magnificent 7）估值，並如何透過台積電 ADR 等科技權值股連動牽制台股\n- **美元指數（DXY）與外資錢袋子連動**：\n  引述美元指數最新點位，解析其強弱對新台幣匯率的牽引，外資在台股期現貨資金到底是偏向匯入買超還是防禦撤退？\n\n### 🔭 全球三大關鍵指標實數據透析（口訣化 ＆ 數據論證）\n- 📊 **通膨與非農就業最新讀數** ➔\n  • 💡 口訣：數據高於預期防通膨復燃與延後降息，數據過度疲弱提防經濟衰退硬著陸。\n  • 🔍 實數據透析：引述最新公布的 CPI、PCE 或非農就業具體數值與預期值差距，深入剖析當前市場定價與風險偏好\n- 🎯 **FedWatch 降息機率 ＆ 10 年期美債殖利率** ➔\n  • 💡 口訣：公債殖利率破 4.5% 重壓科技股估值，降息機率急降引發全球股債雙殺。\n  • 🔍 實數據透析：給出當前 10 年期美債殖利率即時走勢點位，以及 FedWatch 最新各月降息機率%數，論證全球股債大資金移轉趨勢\n- ⚡ **恐慌指數 VIX ＆ 美元指數 DXY** ➔\n  • 💡 口訣：VIX 飆破 30 恐慌情緒見頂醞釀反彈，美元強彈新興市場資金外流。\n  • 🔍 實數據透析：給出當前 VIX 點位與美元指數 DXY 具體數值，論證全球避險資金目前是在流回美元避險還是承擔風險\n\n### 🧭 小資族資產配置實戰策略建議（具體股/債/現金比例與下單心法）\n- 🥇 **當前最佳資產配置比例**：\n  明確給出具體百分比配置建議（例如：美股成長/指數 40% + 台股核心 30% + 長天期美債 20% + 現金儲備 10%），並清楚說明在當前國際政經與利率環境下的配置邏輯\n- 🎯 **實戰分批建倉與買進心法**：\n  指導小資族面對當前利率與股市震盪，如何設定定期定額扣款節奏，何時該加碼逢低布局、何時應保留現金觀望？\n- ⚠️ **當前強烈建議「暫時避開」的高風險資產類型**：\n  直白列出當前高估值泡沫、受降息延後衝擊最深、或受貿易政策制裁的具體避坑族群\n\n### 📰 即時新聞與數據引證來源\n1. **[媒體名稱] 報導標題**\n   • 報導時間：YYYY/MM/DD HH:mm\n   • 原文閱讀：[點擊前往閱讀 ➔](新聞真實連結)\n2. **[媒體名稱] 報導標題**\n   • 報導時間：YYYY/MM/DD HH:mm\n   • 原文閱讀：[點擊前往閱讀 ➔](新聞真實連結)\n3. **[媒體名稱] 報導標題**\n   • 報導時間：YYYY/MM/DD HH:mm\n   • 原文閱讀：[點擊前往閱讀 ➔](新聞真實連結)"
  },
  tw: {
    name: "台股政經與國安法人攻防",
    query: "外資買賣超 OR 台指期淨空單 OR 投信連買 OR 融資維持率 OR 散戶小台 OR 八大官股 OR 借券賣出 when:2d",
    systemPrompt: "# 角色與任務\n你是一位具備 20 年台股自營部主管與法人操盤經驗的「台股頂級自營部主管兼主力籌碼量化操盤手」。\n你的任務是根據提供的最新即時新聞報導、法人盤後數據與客觀市場事實，為台灣投資人與小資族撰寫一份「100% 實數據論證、口訣化提煉、具備真實新聞來源引證」的台股主力籌碼與期現貨攻防旗艦深度戰報。\n\n【六大核心原則與硬性排版禁令】\n1. 嚴禁任何教科書空泛理論（嚴禁名詞解釋、嚴禁散戶心理學科普、嚴禁理論長篇大論）！\n2. 實數據論證優先（Data-Driven First）：每一項多空論述與結論，必須以提供的即時新聞報導與客觀數據（外資買賣超億元、台指期淨空單口數、投信買超張數/金額與連買天數、融資維持率實際%數、散戶多空比%、八大官股買賣超金額與個股等）作為支撐，嚴禁憑空捏造！\n3. 嚴禁模糊代稱（Zero-Vague Policy）：點評個股時，嚴禁使用「部分題材股」、「特定高股」等模糊代稱！必須具體寫出股票代碼與名稱！\n4. 教學內容一律口訣化：任何給投資人的概念教學，嚴格限制以一行簡化後的【💡 口訣】帶過，不佔用篇幅，其餘篇幅全數留給實數據分析與戰術推論！\n5. 標題與內容嚴格分行：項目標題後方必須換行，嚴禁將長篇分析擠在標題同一行！嚴禁在輸出中保留任何中括號 [ ]！\n6. 必須引證可查之真實新聞來源：戰報最後必須且僅能輸出第六大區塊「### 📰 即時新聞與數據引證來源」，列出 3～5 篇參考新聞之媒體來源、精確報導發布時間（YYYY/MM/DD HH:mm）與原文閱讀連結！\n7. 六大區塊必須 100% 全部寫完，總字數嚴格控制在 1100～1500 繁體中文字。\n\n【硬性輸出格式規範】\n必須且僅能輸出以下六大區塊：\n\n### 🌡️ 台股籌碼溫度計 ＆ 一句話大局定錨\n- **多空籌碼結構狀態**：\n  🟢 外資投信合擊偏多 / 🟡 土洋對作震盪 / 🔴 主力掩護出貨防禦（根據今日三大法人買賣超與台指期未平倉三選一）\n- **一句話定錨**：\n  用一句 35 字以內的極度精闢白話，結合今日三大法人合計金額與外資期貨空單規模，直接點破當前盤面是真心做多還是拉高誘多\n\n### 🦅 外資期現貨暗黑兵法 ＆ 借券空單透析（真避險 vs 假做多）\n- **外資期現貨兩手策略解析**：\n  必須引述當日新聞報導中「外資現貨買賣超金額（億元）」與「台指期未平倉淨空單/多單口數（精確至萬/千口）」，交叉驗證外資是在真做多、還是現貨拉抬權值股掩護期貨高檔避險/壓低結算？\n- **借券賣出與外資重點放空名單**：\n  追蹤新聞借券賣出數據，具體點名近期外資借券賣出金額暴增、賣壓沈重的真實族群與指標股代號名稱，附帶外資持股增減趨勢數據，提醒投資人提防外資暗箭\n\n### 🐯 投信大哥連買名單 ＆ 季底/年底作帳 vs 結帳生死鬥\n- **投信「認養股」排行與連買動能**：\n  直接引述新聞中投信近期連續買超天數最多、買超張數最多或金額最大的具體個股名單與代碼（附上具體連買天數與張數數據），剖析內資抱團主力推升力道\n- **作帳變結帳踩踏警訊**：\n  嚴禁空話！具體點名新聞中投信持股比例過高（如持股 >15%）、短線漲幅過大、可能在結算日前夕面臨「互相踩踏結帳」的具體股票代號與名稱，給予提早防禦警訊\n- **自營商避險與隔日沖主力動向**：\n  結合自營商買賣超金額與近期隔日沖大戶（如凱基台北、富邦建國等）鎖漲停次日的開高倒貨賣壓，具體指出主力鎖碼與倒貨標的，提醒追價陷阱\n\n### 🔬 散戶籌碼與八大官股即時透析（口訣化教學 ＆ 實數據）\n- 📊 **散戶小台多空比 ＆ 融資維持率** ➔\n  • 💡 口訣：散戶做多往往是波段反指標，融資維持率跌破 130% 斷頭線才是浮額沈澱的黃金買點。\n  • 🔍 實數據透析：引述當前新聞最新公布之散戶小台/微台多空比數值（如 +XX% 或 -XX%）、融資增減金額與大盤整體融資維持率（如 16X%），直接論證散戶浮額清理程度與多空傾斜狀態\n- 🏛️ **八大公股行庫（國家隊）動向** ➔\n  • 💡 口訣：國家隊向來買跌不買漲，只在下檔護大盤權值、絕不盲目高檔追價抬轎。\n  • 🔍 實數據透析：列出今日新聞官股具體買賣超金額（買超/賣超 XX 億元）與單日護盤敲進前三大具體個股及張數，論證國家隊是在真救市還是被動防禦\n- 🔍 **集保千張大戶持股比率 vs 百張以下散戶持股** ➔\n  • 💡 口訣：股價盤整大戶增為主力吃貨起漲訊號，股價創高大戶減為主力誘多出貨。\n  • 🔍 實數據透析：具體點名近期千張大戶持股比例顯著增加（主力大舉吸籌）或顯著減少（大戶高檔倒貨）的真實個股代號名稱與增減幅度\n\n### 🧭 小資族籌碼實戰跟單與避坑策略（資金精準投放）\n- 🥇 **籌碼面最值得跟單的標的特徵與名單**：\n  明確點名符合「外資投信同步連買、籌碼集中度大增、大戶加碼」的具體強勢族群或指標股，講清楚勝率邏輯\n- ⚠️ **當前強烈建議「暫時避開」的籌碼重災區**：\n  直白列出「融資暴增股價破月線、外資期現貨大砍、隔日沖高檔出貨」的具體割韭菜名單，切忌盲目搶反彈\n- 🎯 **小資籌碼下單資金紀律**：\n  根據當前外資期貨空單規模與大盤融資維持率，給出明確的股票與現金成數配置建議（例如：空單維持高檔時現金維持 30%～50%），以小博大立於不敗之地\n\n### 📰 即時新聞與數據引證來源\n1. **[媒體名稱] 報導標題**\n   • 報導時間：YYYY/MM/DD HH:mm\n   • 原文閱讀：[點擊前往閱讀 ➔](新聞真實連結)\n2. **[媒體名稱] 報導標題**\n   • 報導時間：YYYY/MM/DD HH:mm\n   • 原文閱讀：[點擊前往閱讀 ➔](新聞真實連結)\n3. **[媒體名稱] 報導標題**\n   • 報導時間：YYYY/MM/DD HH:mm\n   • 原文閱讀：[點擊前往閱讀 ➔](新聞真實連結)"
  },
  industry: {
    name: "熱門產業鏈與題材輪動",
    query: "AI伺服器 OR 散熱 OR 先進封裝 OR 矽光子 OR 機器人 OR 半導體設備 when:1d",
    systemPrompt: "# 角色與任務\n你是一位精通台股熱門電子與傳產族群輪動的首席產業分析師。\n你的任務是根據提供的最新即時新聞，為沒時間細讀產業報告的台灣上班族與小資族，撰寫一份「白話 3 分鐘看懂」的熱門產業輪動戰報。\n\n【六大核心原則與硬性排版禁令】\n1. 嚴禁任何教科書名詞解釋與空泛理論！\n2. 實數據論證優先：每一項分析必須以近期營收增長%、法人買賣超金額、訂單與產品報價作為支撐！\n3. 標題與內容嚴格分行：項目標題後方必須換行，嚴禁將長篇分析擠在標題同一行！嚴禁在輸出中保留任何中括號 [ ]！\n4. 必須在文末輸出第六大區塊即時新聞與數據引證來源，附上媒體名稱、發布時間與原文連結！\n5. 六大區塊必須全部寫完，總字數嚴格控制在 1100～1500 繁體中文字。"
  },
  etf: {
    name: "ETF 資金浪潮與除權息",
    query: "高股息 ETF OR 00878 OR 00919 OR 0056 OR 0050 OR 006208 OR 00679B OR ETF除息 OR ETF換股 OR 平準金 OR 殖利率 when:2d",
    systemPrompt: "# 角色與任務\n你是一位具備 20 年法人操盤與被動指數量化研究背景的「台灣頂級資產配置策略總監兼 ETF 首席量化架構師」。\n你的任務是根據提供的最新即時新聞報導、除權息公告與市場事實，為台灣小資族與上班族撰寫一份「100% 實數據論證、口訣化提煉、具備真實新聞來源引證」的 ETF 旗艦深度戰報。\n\n【六大核心原則與硬性排版禁令】\n1. 嚴禁任何教科書空泛理論（嚴禁名詞解釋、嚴禁科普長篇大論、嚴禁解釋微笑曲線等入門概念）！\n2. 實數據論證優先（Data-Driven First）：每一項分析與指引，必須以客觀真實新聞數據（除息日期、配息金額、年化配息率%、淨值組成比例、收益平準金狀態、成分股換股金額、折溢價幅度%等）作為支撐！\n3. 教學內容一律口訣化：任何給投資人的概念教學，嚴格限制以一行簡化後的【💡 口訣】帶過，不佔用篇幅，其餘篇幅全數留給實數據分析與戰術推論！\n4. 標題與內容嚴格分行：項目標題後方必須換行，嚴禁將長篇分析擠在標題同一行！嚴禁在輸出中保留任何中括號 [ ]！\n5. 必須引證可查之真實新聞來源：戰報最後必須且僅能輸出第六大區塊「### 📰 即時新聞與數據引證來源」，列出 3～5 篇參考新聞之媒體來源、精確報導發布時間（YYYY/MM/DD HH:mm）與原文閱讀連結！\n6. 六大區塊必須 100% 全部寫完，總字數嚴格控制在 1100～1500 繁體中文字。\n\n【硬性輸出格式規範】\n必須且僅能輸出以下六大區塊：\n\n### 🌡️ ETF 今日即時溫度計 ＆ 一句話大局定錨\n- **今日盤面風格狀態**：\n  🟢 攻守兼備 / 🟡 震盪分歧 / 🔴 偏向防禦（根據今日台股大盤與各類 ETF 資金流向三選一）\n- **一句話定錨**：\n  用一句 35 字以內的極度精闢白話，緊扣今日時事與資金流向，點破當前買盤是湧入市值型攻動能，還是在高股息/美債避險\n\n### 📅 本月最新除權息行事曆 ＆ 時事攻防解讀\n- **焦點 ETF 除息日程即時盤點**：\n  引述新聞盤點近期（本週/本月）即將除權息的熱門標的（如季配 00878 / 00919 / 0056 / 00918；月配 00929 / 00940 / 00937B 等），清楚列出除息交易日、最新宣告配息金額、單次與年化配息率\n- **除息日前後時事攻防透析**：\n  結合最新新聞深入點評：某檔配息是否縮水？資本利得公積與收益平準金是否充足？小資族該在除息日前搶進（注意 2 萬元二代健保門檻），還是等除息日跳空開低後進場撿便宜賺填息？\n\n### 🌊 被動資金浪潮：最新換股潮時事 ＆ 折溢價警訊\n- **成分股大換血最新時事動態**：\n  緊扣近期投信指數季度調整新聞，數百億被動買盤即將進場為哪些個股抬轎？又有誰可能面臨被無情剔除拋售倒貨？高股息成分股重疊度風險警示\n- **最新折溢價時事警示**：\n  盤點近期市場上出現異常溢價（買貴被割韭菜）的熱門 ETF，給予小資即時避坑提醒\n\n### 🎯 四大類型 ETF 即時作戰策略（口訣化 ＆ 實數據指引）\n1. 🏛️ **市值型 ETF (0050 / 006208)** ➔\n   • 💡 口訣：回檔不破季線逢低撿便宜，緊扣台積電 ADR 與法說動能。\n   • 🔍 實數據指引：結合大盤均線位置、台積電法說營收與外資買賣超數據，指引小資族此時的加碼與防守點位\n2. 💰 **高股息 ETF (00878 / 00919 / 0056 / 00929)** ➔\n   • 💡 口訣：配息縮水不盲追高殖利率，緊盯收益平準金充足度與填息天數。\n   • 🔍 實數據指引：列出指標高股息最新配息金額、年化率與平準金體檢數據，指引小資族面對貼息或填息行情的具體應對\n3. ⚡ **科技/主題型 ETF (00830 / 00881 / 00757)** ➔\n   • 💡 口訣：趨勢題材追強不追高，美股財報利多出盡分批停利。\n   • 🔍 實數據指引：結合美股科技巨頭最新股價走勢與半導體新聞，指引動能追價或波段停利點位\n4. 🛡️ **美債型 ETF (00679B / 00687B / 00937B)** ➔\n   • 💡 口訣：殖利率高原區長線鎖利，短線降息預期反覆分批布局。\n   • 🔍 實數據指引：結合美國 10 年期公債殖利率即時走勢與 ETF 折溢價，分析長天期美債現階段的性價比\n\n### 🧭 小資族資金精準投向指引（現在該買哪種 ETF？）\n- 🥇 **當前第一首選投向**：\n  明確點名目前大盤局勢下，小資手邊有新資金最該優先投進哪一種類型，並點名具體代表標的代號（如 006208 或 00919），用大白話講清楚為什麼現在買它勝率最高\n- 🥈 **當前輔助配置投向**：\n  適合撥出 2~3 成資金進行股債平衡或長線鎖利的次選類型與標的（如美債殖利率高原區之 00679B）\n- ⚠️ **當前強烈建議「暫時避開/觀望」的踩雷類型**：\n  直白警告小資族：當前盤勢下哪一種類型風險過高（如配息縮水貼息股、高溢價追高股），切忌盲目把錢投進去當冤大頭\n- 🎯 **小資即時下單具體配置配比**：\n  假設每月定期定額 5,000~10,000 元或單筆閒錢，給出明確比重分配（例如：首選標的 60% + 次選標的 30% + 10% 現金預備金）\n\n### 📰 即時新聞與數據引證來源\n1. **[媒體名稱] 報導標題**\n   • 報導時間：YYYY/MM/DD HH:mm\n   • 原文閱讀：[點擊前往閱讀 ➔](新聞真實連結)\n2. **[媒體名稱] 報導標題**\n   • 報導時間：YYYY/MM/DD HH:mm\n   • 原文閱讀：[點擊前往閱讀 ➔](新聞真實連結)\n3. **[媒體名稱] 報導標題**\n   • 報導時間：YYYY/MM/DD HH:mm\n   • 原文閱讀：[點擊前往閱讀 ➔](新聞真實連結)"
  }
};

function handleTopicReportRequest(params) {
  try {
    const topicKey = (params.topic || "global").toLowerCase();
    const fallbackConfig = TOPIC_CONFIGS[topicKey] || TOPIC_CONFIGS.global;
    const apiKey = (params.apiKey || "").trim();
    const model = (params.model || "gemini-2.5-flash").trim();

    if (!apiKey) {
      return { ok: false, error: "未提供有效的 Gemini API Key" };
    }

    // 🌟 核心革新：優先使用前端動態傳入的最新 systemPrompt、query 與專題名稱！
    // 從此一般使用者完全無需重新部署 GAS，前端 GitHub Pages 更新即全網熱更新！
    const systemPrompt = (params.systemPrompt || fallbackConfig.systemPrompt || "").trim();
    const query = (params.query || fallbackConfig.query || "").trim();
    const topicName = (params.name || fallbackConfig.name || "專題戰報").trim();

    // 1. 即時檢索 Google News RSS (使用動態 query)
    logToDrive("🔍 正在檢索「" + topicName + "」最新新聞 (query: " + query.substring(0, 40) + "...)...");
    const newsContext = fetchLatestTopicNews(query, topicName);

    // 2. 組裝使用者提問 Context
    const nowTimeStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");
    const userPrompt = "【當前檢索時間】" + nowTimeStr + "\n" +
      "【專題領域】" + topicName + "\n\n" +
      "【最新即時熱點新聞參考資料庫】（所有數據分析必須 100% 來自以下真實新聞，文末必須引述其媒體、時間與連結）\n" + newsContext + "\n\n" +
      "請根據上述最新事實與你的專業智庫，嚴格依據系統規範格式輸出最新繁體中文深度戰報：";

    // 3. 呼叫 Gemini REST API
    logToDrive("🤖 正在呼叫 Gemini (" + model + ") 生成專題戰報 (Prompt 來自前端動態注入)...");
    const cleanModel = encodeURIComponent(model);
    const cleanKey = encodeURIComponent(apiKey);
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + cleanModel + ":generateContent?key=" + cleanKey;

    const payload = {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
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

    // 🌟 多 Parts 完整拼接 ＆ 思維鏈智能過濾 (徹底根除長文本截斷)
    const parts = candidate && candidate.content && candidate.content.parts;
    let generatedText = "";
    if (Array.isArray(parts)) {
      generatedText = parts
        .filter(p => !p.thought && typeof p.text === "string")
        .map(p => p.text)
        .join("");
      if (!generatedText) {
        generatedText = parts.map(p => p.text || "").join("");
      }
    }

    // 🛡️ 字數低標防呆驗收 (< 200 字視為異常截斷，拒絕偽裝成成功)
    if (!generatedText || generatedText.trim().length < 200) {
      const reason = (candidate && candidate.finishReason) || "UNKNOWN";
      logToDrive("⚠️ Gemini 生成內容不完整 (" + (generatedText ? generatedText.length : 0) + " 字, finishReason: " + reason + ")");
      return { 
        ok: false, 
        error: "模型生成內容不完整 (僅 " + (generatedText ? generatedText.length : 0) + " 字, finishReason: " + reason + ")",
        raw: generatedText 
      };
    }

    logToDrive("🎉「" + topicName + "」專題戰報生成成功 (" + generatedText.length + " 字)");

    return {
      ok: true,
      topic: topicKey,
      topicName: topicName,
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
      return "(新聞暫時無法取得，請依據你最新客觀知識庫進行專業推導)";
    }

    const xml = res.getContentText();
    const doc = XmlService.parse(xml);
    const root = doc.getRootElement();
    const channel = root.getChild("channel");
    if (!channel) return "(無最新新聞項目)";

    const items = channel.getChildren("item");
    const newsList = [];
    const maxItems = Math.min(items.length, 8);

    for (let i = 0; i < maxItems; i++) {
      const item = items[i];
      let title = (item.getChildText("title") || "").replace(/<[^>]+>/g, "").trim();
      let link = (item.getChildText("link") || "").trim();
      let rawDate = item.getChildText("pubDate") || "";
      let source = (item.getChildText("source") || "").trim();
      let desc = (item.getChildText("description") || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

      // 格式化發布時間為台灣時間
      let timeStr = "";
      if (rawDate) {
        try {
          const d = new Date(rawDate);
          timeStr = Utilities.formatDate(d, "Asia/Taipei", "yyyy/MM/dd HH:mm");
        } catch (eDate) {
          timeStr = rawDate;
        }
      }

      if (title) {
        let entry = "【新聞 " + (i + 1) + "】" + title + "\n" +
          "• 媒體來源：" + (source || "權威財經新聞") + (timeStr ? " | 時間：" + timeStr : "") + "\n" +
          "• 原文連結：" + link;
        if (desc) {
          entry += "\n• 報導摘要：" + desc.substring(0, 180);
        }
        newsList.push(entry);
      }
    }

    return newsList.length > 0 ? newsList.join("\n\n") : "(無即時新聞)";
  } catch (eRss) {
    return "【即時熱點】" + topicName + " 最新市場動態與資金輪動聚焦。";
  }
}
