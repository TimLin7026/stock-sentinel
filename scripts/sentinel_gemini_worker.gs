

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


