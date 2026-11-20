// 聯絡簿智慧解析與本機名單解析工具
(function (global) {
  const HOMEWORK_HEADER_RE = /^(?:【)?(?:今日|本日)?(?:作業|回家作業|功課|應交作業|作業項目)(?:】)?[：:]?$/;
  const NOTICE_HEADER_RE =
    /^(?:【)?(?:今日|本日)?(?:提醒|提醒事項|注意事項|帶物品|攜帶物品|通知|通知事項|備忘|生活提醒)(?:】)?[：:]?$/;
  const PURE_DATE_HEADER_RE =
    /^(?:\d{1,4}[\/.\-年]\d{1,2}(?:[\/.\-月]\d{1,2}日?)?(?:\s*(?:[（(](?:星期|週)?[一二三四五六日天][)）]|(?:星期|週)[一二三四五六日天]))?\s*(?:聯絡簿)?|聯絡簿[：:]?)$/;
  const DIVIDER_RE = /^[-=_—~～＊*]{3,}$/;
  const LEADING_BULLET_RE = /^(?:[（(]\d{1,2}[)）]|\d{1,2}[.、)）:：]|[①-⑳]|[-•・*▪▫□☑✅•])\s*/;

  const PERIOD_AM_RE = /(?:^|[\s【(（])(?:上午|早自習|晨間|第[一二三四1-4]節)(?:[\s】)）：:]|$)/;
  const PERIOD_PM_RE = /(?:^|[\s【(（])(?:下午|午休|放學前|第[五六七5-7]節)(?:[\s】)）：:]|$)/;

  const QUIZ_RE = /(?:小考|測驗|聽寫|默寫|隨堂考|複習卷|練習卷|評量卷|單元卷|考卷|考試)/;
  const CORRECTION_RE = /(?:訂正|訂簽|改錯|考卷簽名|習作簽名)/;
  const HOMEWORK_VERB_RE = /(?:寫|完成|習作|甲本|乙本|作業|生字|造詞|作文|學習單|筆記|預習|複習|閱讀|背誦|朗讀|練習|訂正|訂簽|測驗|考)/;
  const NOTICE_PREFIX_RE = /^(?:帶|穿|記得|明天|明日|下週|週[一二三四五]|準備|提醒|交.*回條|繳.*費|發下)/;
  const NOTICE_KEYWORD_RE =
    /(?:回條|通知單|同意書|調查表|班服|運動服|便服|水壺|便當|餐盒|餐袋|潔牙|文具|直尺|三角板|圓規|美勞用具|疫苗|健檢|視力|體溫|打掃|校外教學)/;

  function normalizeTitleKey(title) {
    return String(title || "")
      .trim()
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function detectPeriod(line) {
    if (PERIOD_AM_RE.test(line)) return "am";
    if (PERIOD_PM_RE.test(line)) return "pm";
    return "all";
  }

  function detectCategoryAndMakeup(cleanLine, sectionDefaultNotice) {
    if (sectionDefaultNotice) {
      if (CORRECTION_RE.test(cleanLine)) {
        return { category: "correction", requires_makeup: true };
      }
      if (QUIZ_RE.test(cleanLine) && !NOTICE_PREFIX_RE.test(cleanLine)) {
        return { category: "quiz", requires_makeup: true };
      }
      return { category: "notice", requires_makeup: false };
    }

    if (CORRECTION_RE.test(cleanLine)) {
      return { category: "correction", requires_makeup: true };
    }
    if (QUIZ_RE.test(cleanLine) && !/^(?:帶|發|交)/.test(cleanLine)) {
      return { category: "quiz", requires_makeup: true };
    }
    if (
      NOTICE_PREFIX_RE.test(cleanLine) ||
      (NOTICE_KEYWORD_RE.test(cleanLine) && !HOMEWORK_VERB_RE.test(cleanLine))
    ) {
      return { category: "notice", requires_makeup: false };
    }
    return { category: "homework", requires_makeup: true };
  }

  /**
   * 將整段聯絡簿文字拆解成結構化項目，並盡量保留既有項目的 UUID 與設定。
   */
  function parseContactBookText(rawText, existingItems) {
    const existingList = Array.isArray(existingItems) ? existingItems : [];
    const existingByTitle = new Map();
    for (const item of existingList) {
      const key = normalizeTitleKey(item.title);
      if (!key) continue;
      if (!existingByTitle.has(key)) {
        existingByTitle.set(key, []);
      }
      existingByTitle.get(key).push(item);
    }

    const lines = String(rawText || "").split(/\r?\n/);
    const parsed = [];
    let sectionDefaultNotice = false;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || DIVIDER_RE.test(trimmed)) continue;
      if (HOMEWORK_HEADER_RE.test(trimmed)) {
        sectionDefaultNotice = false;
        continue;
      }
      if (NOTICE_HEADER_RE.test(trimmed)) {
        sectionDefaultNotice = true;
        continue;
      }
      if (PURE_DATE_HEADER_RE.test(trimmed)) {
        continue;
      }

      const cleaned = trimmed.replace(LEADING_BULLET_RE, "").trim();
      if (!cleaned) continue;

      if (HOMEWORK_HEADER_RE.test(cleaned)) {
        sectionDefaultNotice = false;
        continue;
      }
      if (NOTICE_HEADER_RE.test(cleaned)) {
        sectionDefaultNotice = true;
        continue;
      }

      const key = normalizeTitleKey(cleaned);
      const matchedQueue = existingByTitle.get(key);
      const reused = matchedQueue && matchedQueue.length > 0 ? matchedQueue.shift() : null;

      if (reused) {
        parsed.push({
          id: reused.id || crypto.randomUUID(),
          title: cleaned.slice(0, 200),
          category: reused.category,
          period: reused.period,
          requires_makeup: Boolean(reused.requires_makeup),
        });
      } else {
        const detected = detectCategoryAndMakeup(cleaned, sectionDefaultNotice);
        parsed.push({
          id: crypto.randomUUID(),
          title: cleaned.slice(0, 200),
          category: detected.category,
          period: detectPeriod(cleaned),
          requires_makeup: detected.requires_makeup,
        });
      }
    }

    return parsed;
  }

  /**
   * 解析本機私密座號姓名文字（支援空白、Tab、逗號分隔）。
   */
  function parsePrivateNameLines(rawText, maxSeat) {
    const cap = Number.isInteger(maxSeat) ? maxSeat : 45;
    const map = {};
    const lines = String(rawText || "").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^0*(\d{1,2})\s*[,，\t\s:：\-]+\s*(.+)$/);
      if (!m) continue;
      const seat = Number(m[1]);
      const name = m[2].trim().slice(0, 30);
      if (seat >= 1 && seat <= cap && name) {
        map[String(seat)] = name;
      }
    }
    return map;
  }

  global.AttendanceParser = {
    parseContactBookText,
    parsePrivateNameLines,
  };
})(window);
