// 資料存取層、雲端/單機雙引擎與補交狀態計算核心
(function (global) {
  const CFG = global.ATTENDANCE_CONFIG;
  const API_URL = `${CFG.SUPABASE_URL}/functions/v1/${CFG.FUNCTION_NAME}`;
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

  function formatDateLocal(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseDateLocal(dateStr) {
    const [y, m, d] = String(dateStr).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function getTodayDateStr() {
    return formatDateLocal(new Date());
  }

  function getCurrentMonthStr() {
    return getTodayDateStr().slice(0, 7);
  }

  function addDays(dateStr, delta) {
    const d = parseDateLocal(dateStr);
    d.setDate(d.getDate() + delta);
    return formatDateLocal(d);
  }

  function formatShortDate(dateStr) {
    const d = parseDateLocal(dateStr);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const w = WEEKDAYS[d.getDay()];
    return `${m}/${day}(${w})`;
  }

  function enumerateDateRange(startStr, endStr, skipWeekends) {
    if (!startStr || !endStr) return [];
    const start = parseDateLocal(startStr);
    const end = parseDateLocal(endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return [];
    }
    const dates = [];
    const cur = new Date(start.getTime());
    let guard = 0;
    while (cur <= end && guard < 120) {
      const dow = cur.getDay();
      if (!skipWeekends || (dow !== 0 && dow !== 6)) {
        dates.push(formatDateLocal(cur));
      }
      cur.setDate(cur.getDate() + 1);
      guard += 1;
    }
    return dates;
  }

  function createEmptyState() {
    return {
      settings: { ...CFG.DEFAULT_SETTINGS, inactive_seats: [] },
      contact_days: [],
      contact_items: [],
      absences: [],
      makeup_records: [],
    };
  }

  function createSampleLocalState() {
    const today = getTodayDateStr();
    const day1 = addDays(today, -2);
    const day2 = addDays(today, -1);
    const day3 = today;

    const item1 = crypto.randomUUID();
    const item2 = crypto.randomUUID();
    const item3 = crypto.randomUUID();
    const item4 = crypto.randomUUID();
    const item5 = crypto.randomUUID();
    const item6 = crypto.randomUUID();
    const item7 = crypto.randomUUID();

    const abs1 = crypto.randomUUID();
    const abs2 = crypto.randomUUID();
    const abs3 = crypto.randomUUID();
    const abs4 = crypto.randomUUID();

    return {
      settings: { id: "default", class_name: "402 班", max_seat: 29, inactive_seats: [] },
      contact_days: [
        {
          date: day1,
          raw_text: "1. 國語習作 L8\n2. 數學習作 P.44-45\n3. 明日穿班服",
          note: "",
        },
        {
          date: day2,
          raw_text: "1. 國語 L8 聽寫小考（上午）\n2. 數學練習卷訂簽\n3. 生字乙本 L9 半課",
          note: "",
        },
        {
          date: day3,
          raw_text: "1. 國語學習單一張\n2. 數學習作 P.46-47（下午）\n3. 下週一帶三角板",
          note: "週五聯絡簿範例",
        },
      ],
      contact_items: [
        { id: item1, date: day1, sort_order: 0, title: "國語習作 L8", category: "homework", period: "all", requires_makeup: true },
        { id: item2, date: day1, sort_order: 1, title: "數學習作 P.44-45", category: "homework", period: "all", requires_makeup: true },
        { id: item3, date: day1, sort_order: 2, title: "明日穿班服", category: "notice", period: "all", requires_makeup: false },
        { id: item4, date: day2, sort_order: 0, title: "國語 L8 聽寫小考（上午）", category: "quiz", period: "am", requires_makeup: true },
        { id: item5, date: day2, sort_order: 1, title: "數學練習卷訂簽", category: "correction", period: "all", requires_makeup: true },
        { id: item6, date: day2, sort_order: 2, title: "生字乙本 L9 半課", category: "homework", period: "all", requires_makeup: true },
        { id: item7, date: day3, sort_order: 0, title: "國語學習單一張", category: "homework", period: "all", requires_makeup: true },
        { id: crypto.randomUUID(), date: day3, sort_order: 1, title: "數學習作 P.46-47（下午）", category: "homework", period: "pm", requires_makeup: true },
        { id: crypto.randomUUID(), date: day3, sort_order: 2, title: "下週一帶三角板", category: "notice", period: "all", requires_makeup: false },
      ],
      absences: [
        { id: abs1, seat: 3, date: day1, leave_type: "sick", session: "full", note: "發燒請假" },
        { id: abs2, seat: 3, date: day2, leave_type: "sick", session: "full", note: "在家休養" },
        { id: abs3, seat: 11, date: day2, leave_type: "personal", session: "am", note: "上午家裡有事，下午返校" },
        { id: abs4, seat: 18, date: day3, leave_type: "bereavement", session: "full", note: "外婆告別式" },
      ],
      makeup_records: [
        { id: crypto.randomUUID(), absence_id: abs1, item_id: item1, status: "done", note: "" },
        { id: crypto.randomUUID(), absence_id: abs1, item_id: item2, status: "submitted", note: "已放講桌待改" },
      ],
    };
  }

  function doesItemApplyToAbsence(item, absence) {
    if (!item || !item.requires_makeup) return false;
    if (absence.session === "full") return true;
    if (absence.session === "am") return item.period === "all" || item.period === "am";
    if (absence.session === "pm") return item.period === "all" || item.period === "pm";
    return true;
  }

  function getActiveSeats(settings) {
    const maxSeat = Number(settings?.max_seat) || 29;
    const inactive = new Set(Array.isArray(settings?.inactive_seats) ? settings.inactive_seats : []);
    const seats = [];
    for (let s = 1; s <= maxSeat; s += 1) {
      if (!inactive.has(s)) seats.push(s);
    }
    return seats;
  }

  function buildDerivedIndexes(state) {
    const daysByDate = new Map();
    for (const d of state.contact_days || []) {
      daysByDate.set(d.date, d);
    }

    const itemsByDate = new Map();
    const itemsById = new Map();
    const sortedItems = [...(state.contact_items || [])].sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    });
    for (const it of sortedItems) {
      itemsById.set(it.id, it);
      if (!itemsByDate.has(it.date)) itemsByDate.set(it.date, []);
      itemsByDate.get(it.date).push(it);
    }

    const makeupByKey = new Map();
    for (const rec of state.makeup_records || []) {
      makeupByKey.set(`${rec.absence_id}:${rec.item_id}`, rec);
    }

    const absencesByDate = new Map();
    const absencesBySeat = new Map();
    const sortedAbsences = [...(state.absences || [])].sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return a.seat - b.seat;
    });

    for (const abs of sortedAbsences) {
      if (!absencesByDate.has(abs.date)) absencesByDate.set(abs.date, []);
      absencesByDate.get(abs.date).push(abs);
      if (!absencesBySeat.has(abs.seat)) absencesBySeat.set(abs.seat, []);
      absencesBySeat.get(abs.seat).push(abs);
    }

    // 計算每筆缺席對應的待補／略過項目
    const entriesByAbsenceId = new Map();
    const allTrackedEntries = [];

    for (const abs of sortedAbsences) {
      const dayItems = itemsByDate.get(abs.date) || [];
      const active = [];
      const skipped = [];

      for (const item of dayItems) {
        const rec = makeupByKey.get(`${abs.id}:${item.id}`) || null;
        const autoMatch = doesItemApplyToAbsence(item, abs);
        if (rec) {
          const entry = {
            absence: abs,
            item,
            record: rec,
            status: rec.status,
            note: rec.note || "",
            manuallyAdded: !autoMatch,
          };
          active.push(entry);
          allTrackedEntries.push(entry);
        } else if (autoMatch) {
          const entry = {
            absence: abs,
            item,
            record: null,
            status: "pending",
            note: "",
            manuallyAdded: false,
          };
          active.push(entry);
          allTrackedEntries.push(entry);
        } else {
          skipped.push({
            absence: abs,
            item,
            reason: !item.requires_makeup ? "純提醒免補" : "半天時段未重疊",
          });
        }
      }

      entriesByAbsenceId.set(abs.id, { active, skipped });
    }

    return {
      daysByDate,
      itemsByDate,
      itemsById,
      makeupByKey,
      absencesByDate,
      absencesBySeat,
      entriesByAbsenceId,
      allTrackedEntries,
    };
  }

  function computeLeaveStats(state, indexes, startDate, endDate) {
    const seats = getActiveSeats(state.settings);
    const bySeat = new Map();
    for (const seat of seats) {
      bySeat.set(seat, {
        seat,
        personal: 0,
        sick: 0,
        bereavement: 0,
        official: 0,
        other: 0,
        totalDays: 0,
        absences: [],
        unfinishedCount: 0,
      });
    }

    const totals = {
      personal: 0,
      sick: 0,
      bereavement: 0,
      official: 0,
      other: 0,
      totalDays: 0,
      absenceRecords: 0,
    };

    for (const abs of state.absences || []) {
      if (startDate && abs.date < startDate) continue;
      if (endDate && abs.date > endDate) continue;
      if (!bySeat.has(abs.seat)) {
        bySeat.set(abs.seat, {
          seat: abs.seat,
          personal: 0,
          sick: 0,
          bereavement: 0,
          official: 0,
          other: 0,
          totalDays: 0,
          absences: [],
          unfinishedCount: 0,
        });
      }
      const row = bySeat.get(abs.seat);
      const weight = CFG.SESSIONS[abs.session]?.weight ?? 1;
      const type = CFG.LEAVE_TYPES[abs.leave_type] ? abs.leave_type : "other";
      row[type] += weight;
      row.totalDays += weight;
      row.absences.push(abs);

      const tracked = indexes.entriesByAbsenceId.get(abs.id)?.active || [];
      row.unfinishedCount += tracked.filter(
        (e) => e.status === "pending" || e.status === "submitted"
      ).length;

      totals[type] += weight;
      totals.totalDays += weight;
      totals.absenceRecords += 1;
    }

    const rows = Array.from(bySeat.values()).sort((a, b) => a.seat - b.seat);
    for (const r of rows) {
      r.absences.sort((a, b) => a.date.localeCompare(b.date));
    }
    return { rows, totals };
  }

  function escapeCsvCell(value) {
    const s = String(value ?? "");
    if (/[",\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportAttendanceCsv(state, indexes, startDate, endDate, formatSeatFn) {
    const { rows } = computeLeaveStats(state, indexes, startDate, endDate);
    const header = ["座號／稱呼", "事假(天)", "病假(天)", "喪假(天)", "公假(天)", "其他(天)", "合計天數", "未完成補交項數", "缺席明細"];
    const lines = [header.map(escapeCsvCell).join(",")];
    for (const r of rows) {
      const detail = r.absences
        .map((a) => {
          const lt = CFG.LEAVE_TYPES[a.leave_type]?.label || a.leave_type;
          const ss = CFG.SESSIONS[a.session]?.label || a.session;
          return `${a.date} ${lt}(${ss})${a.note ? "：" + a.note : ""}`;
        })
        .join("；");
      lines.push(
        [
          formatSeatFn(r.seat),
          r.personal,
          r.sick,
          r.bereavement,
          r.official,
          r.other,
          r.totalDays,
          r.unfinishedCount,
          detail,
        ]
          .map(escapeCsvCell)
          .join(",")
      );
    }
    downloadTextFile(
      `出缺席假別統計_${startDate || "全部"}_${endDate || "至今"}.csv`,
      "\uFEFF" + lines.join("\r\n"),
      "text/csv;charset=utf-8;"
    );
  }

  function exportUnfinishedMakeupCsv(state, indexes, formatSeatFn) {
    const header = ["座號／稱呼", "缺席日期", "假別", "時段", "作業／小考項目", "類別", "補交狀態", "備註"];
    const lines = [header.map(escapeCsvCell).join(",")];
    const unfinished = indexes.allTrackedEntries
      .filter((e) => e.status === "pending" || e.status === "submitted")
      .sort((a, b) => {
        if (a.absence.seat !== b.absence.seat) return a.absence.seat - b.absence.seat;
        return a.absence.date.localeCompare(b.absence.date);
      });

    for (const e of unfinished) {
      lines.push(
        [
          formatSeatFn(e.absence.seat),
          e.absence.date,
          CFG.LEAVE_TYPES[e.absence.leave_type]?.label || e.absence.leave_type,
          CFG.SESSIONS[e.absence.session]?.label || e.absence.session,
          e.item.title,
          CFG.CATEGORIES[e.item.category]?.label || e.item.category,
          CFG.MAKEUP_STATUSES[e.status]?.label || e.status,
          e.absence.note || e.note || "",
        ]
          .map(escapeCsvCell)
          .join(",")
      );
    }

    downloadTextFile(
      `待補作業未完成明細_${getTodayDateStr()}.csv`,
      "\uFEFF" + lines.join("\r\n"),
      "text/csv;charset=utf-8;"
    );
  }

  class AttendanceStore {
    constructor() {
      this.mode = "cloud"; // "cloud" | "local"
      this.pw = "";
      this.state = createEmptyState();
      this.privateNames = this.loadPrivateNames();
      this.privacyMask = localStorage.getItem(`${CFG.STORAGE_PREFIX}privacy_mask`) === "1";
    }

    getSavedPassword() {
      return localStorage.getItem(`${CFG.STORAGE_PREFIX}saved_pw`) || "";
    }

    savePasswordPreference(pw, remember) {
      if (remember && pw) {
        localStorage.setItem(`${CFG.STORAGE_PREFIX}saved_pw`, pw);
      } else {
        localStorage.removeItem(`${CFG.STORAGE_PREFIX}saved_pw`);
      }
    }

    clearSavedPassword() {
      localStorage.removeItem(`${CFG.STORAGE_PREFIX}saved_pw`);
    }

    loadPrivateNames() {
      try {
        const raw = localStorage.getItem(`${CFG.STORAGE_PREFIX}private_names`);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    }

    savePrivateNames(map) {
      this.privateNames = map || {};
      localStorage.setItem(`${CFG.STORAGE_PREFIX}private_names`, JSON.stringify(this.privateNames));
    }

    setPrivacyMask(masked) {
      this.privacyMask = Boolean(masked);
      localStorage.setItem(`${CFG.STORAGE_PREFIX}privacy_mask`, this.privacyMask ? "1" : "0");
    }

    formatSeatLabel(seat, includeName = true) {
      const numStr = `${String(seat).padStart(2, "0")} 號`;
      if (!includeName || this.privacyMask) return numStr;
      const name = this.privateNames[String(seat)];
      return name ? `${numStr} ${name}` : numStr;
    }

    loadLocalState() {
      try {
        const raw = localStorage.getItem(`${CFG.STORAGE_PREFIX}local_state`);
        if (!raw) return createEmptyState();
        const parsed = JSON.parse(raw);
        return {
          settings: { ...CFG.DEFAULT_SETTINGS, ...(parsed.settings || {}) },
          contact_days: Array.isArray(parsed.contact_days) ? parsed.contact_days : [],
          contact_items: Array.isArray(parsed.contact_items) ? parsed.contact_items : [],
          absences: Array.isArray(parsed.absences) ? parsed.absences : [],
          makeup_records: Array.isArray(parsed.makeup_records) ? parsed.makeup_records : [],
        };
      } catch {
        return createEmptyState();
      }
    }

    persistLocalState() {
      localStorage.setItem(`${CFG.STORAGE_PREFIX}local_state`, JSON.stringify(this.state));
    }

    async callCloud(action, payload = {}) {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: CFG.SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ action, pw: this.pw, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = data.error;
        err.detail = data.detail;
        throw err;
      }
      return data;
    }

    async loginCloud(pw, remember) {
      this.mode = "cloud";
      this.pw = pw;
      const data = await this.callCloud("get_state");
      this.savePasswordPreference(pw, remember);
      this.state = {
        settings: data.settings || { ...CFG.DEFAULT_SETTINGS },
        contact_days: data.contact_days || [],
        contact_items: data.contact_items || [],
        absences: data.absences || [],
        makeup_records: data.makeup_records || [],
      };
      return this.state;
    }

    enterLocalMode() {
      this.mode = "local";
      this.pw = "";
      this.state = this.loadLocalState();
      return this.state;
    }

    loadLocalDemo() {
      if (this.mode !== "local") return;
      this.state = createSampleLocalState();
      this.persistLocalState();
      return this.state;
    }

    async refresh() {
      if (this.mode === "local") {
        this.state = this.loadLocalState();
        return this.state;
      }
      const data = await this.callCloud("get_state");
      this.state = {
        settings: data.settings || { ...CFG.DEFAULT_SETTINGS },
        contact_days: data.contact_days || [],
        contact_items: data.contact_items || [],
        absences: data.absences || [],
        makeup_records: data.makeup_records || [],
      };
      return this.state;
    }

    async updateSettings(nextSettings) {
      const class_name = String(nextSettings.class_name || "402 班").trim() || "402 班";
      const max_seat = Math.min(45, Math.max(1, Number(nextSettings.max_seat) || 29));
      const inactive_seats = Array.from(
        new Set(
          (nextSettings.inactive_seats || [])
            .map(Number)
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= max_seat)
        )
      ).sort((a, b) => a - b);

      if (this.mode === "local") {
        this.state.settings = { id: "default", class_name, max_seat, inactive_seats };
        this.persistLocalState();
        return this.state.settings;
      }

      const data = await this.callCloud("update_settings", { class_name, max_seat, inactive_seats });
      this.state.settings = data.settings;
      return data.settings;
    }

    async saveContactDay(date, rawText, note, items) {
      if (this.mode === "local") {
        const cleanItems = (items || [])
          .filter((it) => String(it.title || "").trim())
          .map((it, idx) => ({
            id: it.id || crypto.randomUUID(),
            date,
            sort_order: idx,
            title: String(it.title).trim(),
            category: it.category || "homework",
            period: it.period || "all",
            requires_makeup: it.category === "notice" ? Boolean(it.requires_makeup) : it.requires_makeup !== false,
          }));

        if (cleanItems.length === 0 && !String(rawText || "").trim() && !String(note || "").trim()) {
          const removedIds = new Set(
            this.state.contact_items.filter((i) => i.date === date).map((i) => i.id)
          );
          this.state.contact_days = this.state.contact_days.filter((d) => d.date !== date);
          this.state.contact_items = this.state.contact_items.filter((i) => i.date !== date);
          this.state.makeup_records = this.state.makeup_records.filter((r) => !removedIds.has(r.item_id));
          this.persistLocalState();
          return { day: null, items: [] };
        }

        const existingDayIdx = this.state.contact_days.findIndex((d) => d.date === date);
        const dayObj = { date, raw_text: rawText || "", note: note || "", updated_at: new Date().toISOString() };
        if (existingDayIdx >= 0) this.state.contact_days[existingDayIdx] = dayObj;
        else this.state.contact_days.push(dayObj);

        const keptIds = new Set(cleanItems.map((i) => i.id));
        const removedIds = new Set(
          this.state.contact_items.filter((i) => i.date === date && !keptIds.has(i.id)).map((i) => i.id)
        );
        this.state.contact_items = [
          ...this.state.contact_items.filter((i) => i.date !== date),
          ...cleanItems,
        ];
        if (removedIds.size > 0) {
          this.state.makeup_records = this.state.makeup_records.filter((r) => !removedIds.has(r.item_id));
        }
        this.persistLocalState();
        return { day: dayObj, items: cleanItems };
      }

      const data = await this.callCloud("save_contact_day", {
        date,
        raw_text: rawText,
        note,
        items,
      });

      if (data.deleted_day) {
        const removedIds = new Set(
          this.state.contact_items.filter((i) => i.date === date).map((i) => i.id)
        );
        this.state.contact_days = this.state.contact_days.filter((d) => d.date !== date);
        this.state.contact_items = this.state.contact_items.filter((i) => i.date !== date);
        this.state.makeup_records = this.state.makeup_records.filter((r) => !removedIds.has(r.item_id));
      } else {
        const idx = this.state.contact_days.findIndex((d) => d.date === date);
        if (idx >= 0) this.state.contact_days[idx] = data.day;
        else this.state.contact_days.push(data.day);

        const nextItems = data.items || [];
        const keptIds = new Set(nextItems.map((i) => i.id));
        const removedIds = new Set(
          this.state.contact_items.filter((i) => i.date === date && !keptIds.has(i.id)).map((i) => i.id)
        );
        this.state.contact_items = [
          ...this.state.contact_items.filter((i) => i.date !== date),
          ...nextItems,
        ];
        if (removedIds.size > 0) {
          this.state.makeup_records = this.state.makeup_records.filter((r) => !removedIds.has(r.item_id));
        }
      }
      return data;
    }

    async upsertAbsences({ seats, dates, leave_type, session, note }) {
      if (this.mode === "local") {
        const updated = [];
        for (const date of dates) {
          for (const seat of seats) {
            const idx = this.state.absences.findIndex((a) => a.seat === seat && a.date === date);
            if (idx >= 0) {
              this.state.absences[idx] = {
                ...this.state.absences[idx],
                leave_type,
                session,
                note: note || "",
              };
              updated.push(this.state.absences[idx]);
            } else {
              const row = {
                id: crypto.randomUUID(),
                seat,
                date,
                leave_type,
                session,
                note: note || "",
              };
              this.state.absences.push(row);
              updated.push(row);
            }
          }
        }
        this.persistLocalState();
        return updated;
      }

      const isSingle = seats.length === 1 && dates.length === 1;
      const data = isSingle
        ? await this.callCloud("upsert_absence", {
            seat: seats[0],
            date: dates[0],
            leave_type,
            session,
            note,
          })
        : await this.callCloud("batch_upsert_absences", {
            seats,
            dates,
            leave_type,
            session,
            note,
          });

      const returned = data.absences || [];
      for (const row of returned) {
        const idx = this.state.absences.findIndex(
          (a) => a.id === row.id || (a.seat === row.seat && a.date === row.date)
        );
        if (idx >= 0) this.state.absences[idx] = row;
        else this.state.absences.push(row);
      }
      return returned;
    }

    async deleteAbsence(id) {
      if (this.mode === "local") {
        this.state.absences = this.state.absences.filter((a) => a.id !== id);
        this.state.makeup_records = this.state.makeup_records.filter((r) => r.absence_id !== id);
        this.persistLocalState();
        return;
      }
      await this.callCloud("delete_absence", { id });
      this.state.absences = this.state.absences.filter((a) => a.id !== id);
      this.state.makeup_records = this.state.makeup_records.filter((r) => r.absence_id !== id);
    }

    async setMakeupStatuses(entries) {
      if (!entries || entries.length === 0) return;

      if (this.mode === "local") {
        for (const entry of entries) {
          const idx = this.state.makeup_records.findIndex(
            (r) => r.absence_id === entry.absence_id && r.item_id === entry.item_id
          );
          if (idx >= 0) {
            this.state.makeup_records[idx] = {
              ...this.state.makeup_records[idx],
              status: entry.status,
              note: entry.note ?? this.state.makeup_records[idx].note ?? "",
            };
          } else {
            this.state.makeup_records.push({
              id: crypto.randomUUID(),
              absence_id: entry.absence_id,
              item_id: entry.item_id,
              status: entry.status,
              note: entry.note || "",
            });
          }
        }
        this.persistLocalState();
        return;
      }

      const data =
        entries.length === 1
          ? await this.callCloud("set_makeup_status", entries[0])
          : await this.callCloud("batch_set_makeup_status", { entries });

      for (const rec of data.records || []) {
        const idx = this.state.makeup_records.findIndex(
          (r) =>
            r.id === rec.id || (r.absence_id === rec.absence_id && r.item_id === rec.item_id)
        );
        if (idx >= 0) this.state.makeup_records[idx] = rec;
        else this.state.makeup_records.push(rec);
      }
    }

    exportJsonBackup() {
      const payload = {
        app: "chaohe-attendance-homework",
        version: 1,
        exported_at: new Date().toISOString(),
        data: this.state,
      };
      downloadTextFile(
        `出缺席與聯絡簿備份_${getTodayDateStr()}.json`,
        JSON.stringify(payload, null, 2),
        "application/json;charset=utf-8;"
      );
    }

    async importJsonBackup(parsedJson, mode) {
      const data = parsedJson?.data && typeof parsedJson.data === "object" ? parsedJson.data : parsedJson;
      if (!data || typeof data !== "object") {
        throw new Error("備份檔格式不正確");
      }

      if (this.mode === "local") {
        if (mode === "replace") {
          this.state = {
            settings: { ...CFG.DEFAULT_SETTINGS, ...(data.settings || {}) },
            contact_days: Array.isArray(data.contact_days) ? data.contact_days : [],
            contact_items: Array.isArray(data.contact_items) ? data.contact_items : [],
            absences: Array.isArray(data.absences) ? data.absences : [],
            makeup_records: Array.isArray(data.makeup_records) ? data.makeup_records : [],
          };
        } else {
          // merge locally
          const next = this.loadLocalState();
          if (data.settings) next.settings = { ...next.settings, ...data.settings };
          const dayMap = new Map(next.contact_days.map((d) => [d.date, d]));
          for (const d of data.contact_days || []) if (d?.date) dayMap.set(d.date, d);
          next.contact_days = Array.from(dayMap.values());

          const itemMap = new Map(next.contact_items.map((i) => [i.id, i]));
          for (const i of data.contact_items || []) if (i?.id && i?.date) itemMap.set(i.id, i);
          next.contact_items = Array.from(itemMap.values());

          const absMap = new Map(next.absences.map((a) => [`${a.seat}:${a.date}`, a]));
          for (const a of data.absences || []) if (a?.seat && a?.date) absMap.set(`${a.seat}:${a.date}`, a);
          next.absences = Array.from(absMap.values());

          const recMap = new Map(next.makeup_records.map((r) => [`${r.absence_id}:${r.item_id}`, r]));
          for (const r of data.makeup_records || []) {
            if (r?.absence_id && r?.item_id) recMap.set(`${r.absence_id}:${r.item_id}`, r);
          }
          next.makeup_records = Array.from(recMap.values());
          this.state = next;
        }
        this.persistLocalState();
        return this.state;
      }

      const res = await this.callCloud("import_backup", { mode, data });
      this.state = {
        settings: res.settings || { ...CFG.DEFAULT_SETTINGS },
        contact_days: res.contact_days || [],
        contact_items: res.contact_items || [],
        absences: res.absences || [],
        makeup_records: res.makeup_records || [],
      };
      return this.state;
    }
  }

  global.AttendanceStoreUtils = {
    formatDateLocal,
    parseDateLocal,
    getTodayDateStr,
    getCurrentMonthStr,
    addDays,
    formatShortDate,
    enumerateDateRange,
    doesItemApplyToAbsence,
    getActiveSeats,
    buildDerivedIndexes,
    computeLeaveStats,
    exportAttendanceCsv,
    exportUnfinishedMakeupCsv,
    AttendanceStore,
  };
})(window);
