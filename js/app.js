// 班級出缺席請假與聯絡簿補作業追蹤 - 主應用邏輯
(function (global) {
  const CFG = global.ATTENDANCE_CONFIG;
  const Parser = global.AttendanceParser;
  const U = global.AttendanceStoreUtils;
  const store = new U.AttendanceStore();

  const SCHEMA_SQL = `-- 班級出缺席請假與聯絡簿補作業追蹤系統資料表
-- 隱私設計：雲端僅儲存座號（1~45），不儲存學生真實姓名

create table if not exists public.att_settings (
  id text primary key default 'default',
  class_name text not null default '402 班',
  max_seat integer not null default 29 check (max_seat between 1 and 45),
  inactive_seats integer[] not null default '{}',
  updated_at timestamptz not null default now()
);

insert into public.att_settings (id, class_name, max_seat, inactive_seats)
values ('default', '402 班', 29, '{}')
on conflict (id) do nothing;

create table if not exists public.att_contact_days (
  date date primary key,
  raw_text text not null default '',
  note text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.att_contact_items (
  id uuid primary key default gen_random_uuid(),
  date date not null references public.att_contact_days(date) on delete cascade,
  sort_order integer not null default 0,
  title text not null check (char_length(btrim(title)) > 0),
  category text not null default 'homework' check (category in ('homework', 'quiz', 'correction', 'notice')),
  period text not null default 'all' check (period in ('all', 'am', 'pm')),
  requires_makeup boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_att_contact_items_date
  on public.att_contact_items (date, sort_order);

create table if not exists public.att_absences (
  id uuid primary key default gen_random_uuid(),
  seat integer not null check (seat between 1 and 45),
  date date not null,
  leave_type text not null check (leave_type in ('personal', 'sick', 'bereavement', 'official', 'other')),
  session text not null default 'full' check (session in ('full', 'am', 'pm')),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint att_absences_seat_date_unique unique (seat, date)
);

create index if not exists idx_att_absences_date
  on public.att_absences (date, seat);

create table if not exists public.att_makeup_records (
  id uuid primary key default gen_random_uuid(),
  absence_id uuid not null references public.att_absences(id) on delete cascade,
  item_id uuid not null references public.att_contact_items(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'submitted', 'done', 'exempt')),
  note text not null default '',
  updated_at timestamptz not null default now(),
  constraint att_makeup_records_absence_item_unique unique (absence_id, item_id)
);

create index if not exists idx_att_makeup_records_absence_id
  on public.att_makeup_records (absence_id);

create index if not exists idx_att_makeup_records_item_id
  on public.att_makeup_records (item_id);

create or replace function public.set_att_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_att_settings_updated_at on public.att_settings;
create trigger trg_att_settings_updated_at
  before update on public.att_settings
  for each row
  execute function public.set_att_updated_at();

drop trigger if exists trg_att_contact_days_updated_at on public.att_contact_days;
create trigger trg_att_contact_days_updated_at
  before update on public.att_contact_days
  for each row
  execute function public.set_att_updated_at();

drop trigger if exists trg_att_contact_items_updated_at on public.att_contact_items;
create trigger trg_att_contact_items_updated_at
  before update on public.att_contact_items
  for each row
  execute function public.set_att_updated_at();

drop trigger if exists trg_att_absences_updated_at on public.att_absences;
create trigger trg_att_absences_updated_at
  before update on public.att_absences
  for each row
  execute function public.set_att_updated_at();

drop trigger if exists trg_att_makeup_records_updated_at on public.att_makeup_records;
create trigger trg_att_makeup_records_updated_at
  before update on public.att_makeup_records
  for each row
  execute function public.set_att_updated_at();

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'att_settings',
    'att_contact_days',
    'att_contact_items',
    'att_absences',
    'att_makeup_records'
  ]
  loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on table public.%I from public, anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on table public.%I to service_role', tbl);
    execute format('drop policy if exists "deny_direct_client_access" on public.%I', tbl);
    execute format(
      'create policy "deny_direct_client_access" on public.%I for all to anon, authenticated using (false) with check (false)',
      tbl
    );
  end loop;
end $$;`;

  const ui = {
    activeTab: "overview",
    overview: {
      viewMode: "student", // "student" | "item"
      onlyUnfinished: true,
      leaveFilter: "all",
      rangeFilter: "all", // "all" | "7d" | "month" | "custom"
      startDate: U.addDays(U.getTodayDateStr(), -14),
      endDate: U.getTodayDateStr(),
      search: "",
    },
    daily: {
      selectedDate: U.getTodayDateStr(),
      selectedSeat: null,
      quickLeaveType: "sick",
      quickSession: "full",
      quickNote: "",
      draftRawText: "",
      draftNote: "",
      draftItems: [],
      dirty: false,
    },
    batch: {
      seats: new Set(),
      leaveType: "sick",
      session: "full",
    },
    stats: {
      rangeMode: "month", // "month" | "all" | "custom"
      month: U.getCurrentMonthStr(),
      startDate: `${U.getCurrentMonthStr()}-01`,
      endDate: U.getTodayDateStr(),
      onlyWithAbsences: true,
    },
  };

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(msg, type = "") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  async function copyTextToClipboard(text, successMsg = "已複製到剪貼簿") {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMsg, "ok");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showToast(successMsg, "ok");
    }
  }

  function leaveBadgeHtml(leaveType, session) {
    const lt = CFG.LEAVE_TYPES[leaveType] || CFG.LEAVE_TYPES.other;
    const ss = CFG.SESSIONS[session] || CFG.SESSIONS.full;
    return `<span class="badge" style="color:${lt.color};background:${lt.bg};border-color:${lt.border}">${escapeHtml(lt.label)}・${escapeHtml(ss.label)}</span>`;
  }

  function categoryBadgeHtml(category) {
    const c = CFG.CATEGORIES[category] || CFG.CATEGORIES.homework;
    return `<span class="badge" style="color:${c.color};background:${c.bg}">${escapeHtml(c.label)}</span>`;
  }

  function periodBadgeHtml(period) {
    if (!period || period === "all") return "";
    const p = CFG.PERIODS[period];
    return p ? `<span class="badge" style="color:#515154;background:rgba(118,118,128,0.10)">${escapeHtml(p.label)}</span>` : "";
  }

  function loadDailyDraftFromState(date) {
    const day = (store.state.contact_days || []).find((d) => d.date === date);
    const items = (store.state.contact_items || [])
      .filter((it) => it.date === date)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    ui.daily.draftRawText = day?.raw_text || "";
    ui.daily.draftNote = day?.note || "";
    ui.daily.draftItems = items.map((it) => ({
      id: it.id,
      title: it.title,
      category: it.category || "homework",
      period: it.period || "all",
      requires_makeup: Boolean(it.requires_makeup),
    }));
    ui.daily.dirty = false;
  }

  function selectDailySeat(seat) {
    ui.daily.selectedSeat = seat;
    const existing = (store.state.absences || []).find(
      (a) => a.seat === seat && a.date === ui.daily.selectedDate
    );
    if (existing) {
      ui.daily.quickLeaveType = existing.leave_type;
      ui.daily.quickSession = existing.session;
      ui.daily.quickNote = existing.note || "";
    } else {
      ui.daily.quickNote = "";
    }
    renderDailyTab();
  }

  function switchDailyDate(nextDate) {
    if (nextDate === ui.daily.selectedDate) return;
    if (ui.daily.dirty && !confirm("當日聯絡簿尚有未儲存的修改，確定要切換日期嗎？")) {
      return;
    }
    ui.daily.selectedDate = nextDate;
    ui.daily.selectedSeat = null;
    loadDailyDraftFromState(nextDate);
    renderDailyTab();
  }

  function updateHeader() {
    const className = store.state.settings?.class_name || "402 班";
    document.getElementById("hdr-class-badge").textContent = className;

    const pill = document.getElementById("hdr-sync-pill");
    if (store.mode === "local") {
      pill.textContent = "本機離線模式";
      pill.classList.add("local");
    } else {
      pill.textContent = "Supabase 雲端同步";
      pill.classList.remove("local");
    }

    const hasNames = Object.keys(store.privateNames || {}).length > 0;
    const privacyBtn = document.getElementById("btn-toggle-privacy");
    privacyBtn.classList.toggle("hidden", !hasNames);
    privacyBtn.classList.toggle("active", store.privacyMask);
    privacyBtn.textContent = store.privacyMask ? "僅顯座號（顯示姓名）" : "隱藏姓名（僅座號）";

    const demoBtn = document.getElementById("btn-load-demo");
    demoBtn.classList.toggle("hidden", store.mode !== "local");

    document.getElementById("btn-refresh").classList.toggle("hidden", store.mode === "local");
  }

  function updateTabCounts(indexes) {
    const unfinishedCount = indexes.allTrackedEntries.filter(
      (e) => e.status === "pending" || e.status === "submitted"
    ).length;
    const badge = document.getElementById("tab-badge-unfinished");
    badge.textContent = String(unfinishedCount);
    badge.classList.toggle("hidden", unfinishedCount === 0);
  }

  function renderAll() {
    updateHeader();
    const indexes = U.buildDerivedIndexes(store.state);
    updateTabCounts(indexes);

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === ui.activeTab);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.id !== `panel-${ui.activeTab}`);
    });

    if (ui.activeTab === "overview") renderOverviewTab(indexes);
    else if (ui.activeTab === "daily") renderDailyTab(indexes);
    else if (ui.activeTab === "stats") renderStatsTab(indexes);
    else if (ui.activeTab === "settings") renderSettingsTab();
  }

  function getOverviewDateBounds() {
    const today = U.getTodayDateStr();
    if (ui.overview.rangeFilter === "7d") {
      return { start: U.addDays(today, -6), end: today };
    }
    if (ui.overview.rangeFilter === "month") {
      return { start: `${U.getCurrentMonthStr()}-01`, end: today };
    }
    if (ui.overview.rangeFilter === "custom") {
      return { start: ui.overview.startDate || "", end: ui.overview.endDate || "" };
    }
    return { start: "", end: "" };
  }

  function matchesOverviewFilters(absence, entryOrNull, indexes) {
    const { start, end } = getOverviewDateBounds();
    if (start && absence.date < start) return false;
    if (end && absence.date > end) return false;
    if (ui.overview.leaveFilter !== "all" && absence.leave_type !== ui.overview.leaveFilter) {
      return false;
    }
    const q = ui.overview.search.trim().toLowerCase();
    if (q) {
      const seatNumStr = String(absence.seat);
      const seatPad = seatNumStr.padStart(2, "0");
      const nameStr = store.privacyMask ? "" : String(store.privateNames[seatNumStr] || "");
      const noteStr = String(absence.note || "");
      const itemTitle = entryOrNull ? String(entryOrNull.item.title || "") : "";
      const haystack = `${seatNumStr} ${seatPad}號 ${nameStr} ${noteStr} ${itemTitle}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }

  function buildStudentBroadcastText(studentGroup) {
    const unfinished = studentGroup.absences.flatMap((block) =>
      block.entries
        .filter((e) => e.status === "pending" || e.status === "submitted")
        .map((e) => ({ date: block.absence.date, leaveType: block.absence.leave_type, entry: e }))
    );
    if (unfinished.length === 0) return "";
    const parts = unfinished.map((u) => {
      const tag = u.entry.status === "submitted" ? "[已交待改]" : "";
      return `${U.formatShortDate(u.date)} ${u.entry.item.title}${tag}`;
    });
    return `${store.formatSeatLabel(studentGroup.seat, false)} 待補項目：${parts.join("、")}`;
  }

  function renderOverviewTab(precomputedIndexes) {
    const indexes = precomputedIndexes || U.buildDerivedIndexes(store.state);
    const panel = document.getElementById("panel-overview");
    const today = U.getTodayDateStr();

    // 全局 KPI
    const allUnfinishedEntries = indexes.allTrackedEntries.filter(
      (e) => e.status === "pending" || e.status === "submitted"
    );
    const pendingOnlyCount = allUnfinishedEntries.filter((e) => e.status === "pending").length;
    const submittedOnlyCount = allUnfinishedEntries.filter((e) => e.status === "submitted").length;
    const unfinishedSeats = new Set(allUnfinishedEntries.map((e) => e.absence.seat));
    const completedCount = indexes.allTrackedEntries.filter(
      (e) => e.status === "done" || e.status === "exempt"
    ).length;

    const todayAbsences = indexes.absencesByDate.get(today) || [];
    const todayBreakdown = {
      personal: todayAbsences.filter((a) => a.leave_type === "personal").length,
      sick: todayAbsences.filter((a) => a.leave_type === "sick").length,
      bereavement: todayAbsences.filter((a) => a.leave_type === "bereavement").length,
    };

    // 依學生分組
    const studentMap = new Map();
    const sortedAbsences = [...(store.state.absences || [])].sort((a, b) => {
      if (a.seat !== b.seat) return a.seat - b.seat;
      return b.date.localeCompare(a.date);
    });

    for (const abs of sortedAbsences) {
      const absData = indexes.entriesByAbsenceId.get(abs.id) || { active: [], skipped: [] };
      const q = ui.overview.search.trim().toLowerCase();
      let filteredActive = absData.active;
      if (q) {
        const seatMatches =
          `${abs.seat} ${String(abs.seat).padStart(2, "0")}號 ${store.privacyMask ? "" : store.privateNames[String(abs.seat)] || ""} ${abs.note || ""}`
            .toLowerCase()
            .includes(q);
        if (!seatMatches) {
          filteredActive = absData.active.filter((e) => e.item.title.toLowerCase().includes(q));
          if (filteredActive.length === 0) continue;
        }
      }
      if (!matchesOverviewFilters(abs, null, indexes) && !q) continue;
      if (q) {
        // 仍套用日期與假別篩選
        const { start, end } = getOverviewDateBounds();
        if (start && abs.date < start) continue;
        if (end && abs.date > end) continue;
        if (ui.overview.leaveFilter !== "all" && abs.leave_type !== ui.overview.leaveFilter) continue;
      }

      if (!studentMap.has(abs.seat)) {
        studentMap.set(abs.seat, {
          seat: abs.seat,
          absences: [],
          pendingCount: 0,
          submittedCount: 0,
          doneCount: 0,
          exemptCount: 0,
          unfinishedCount: 0,
        });
      }
      const grp = studentMap.get(abs.seat);
      const dayItems = indexes.itemsByDate.get(abs.date) || [];
      grp.absences.push({
        absence: abs,
        entries: filteredActive,
        skipped: absData.skipped,
        hasContactDay: dayItems.length > 0 || indexes.daysByDate.has(abs.date),
      });

      for (const e of filteredActive) {
        if (e.status === "pending") grp.pendingCount += 1;
        else if (e.status === "submitted") grp.submittedCount += 1;
        else if (e.status === "done") grp.doneCount += 1;
        else if (e.status === "exempt") grp.exemptCount += 1;
      }
      grp.unfinishedCount = grp.pendingCount + grp.submittedCount;
    }

    let studentGroups = Array.from(studentMap.values());
    if (ui.overview.onlyUnfinished) {
      studentGroups = studentGroups.filter((g) => g.unfinishedCount > 0);
    }
    studentGroups.sort((a, b) => {
      if (b.unfinishedCount !== a.unfinishedCount) return b.unfinishedCount - a.unfinishedCount;
      return a.seat - b.seat;
    });

    // 依項目分組
    const itemGroupMap = new Map();
    for (const grp of studentGroups) {
      for (const block of grp.absences) {
        for (const e of block.entries) {
          if (ui.overview.onlyUnfinished && e.status !== "pending" && e.status !== "submitted") continue;
          if (!itemGroupMap.has(e.item.id)) {
            itemGroupMap.set(e.item.id, {
              item: e.item,
              entries: [],
            });
          }
          itemGroupMap.get(e.item.id).entries.push(e);
        }
      }
    }
    const itemGroups = Array.from(itemGroupMap.values()).sort((a, b) => {
      if (a.item.date !== b.item.date) return b.item.date.localeCompare(a.item.date);
      return (a.item.sort_order ?? 0) - (b.item.sort_order ?? 0);
    });

    const leaveBtns = [
      { key: "all", label: "全部假別" },
      ...CFG.PRIMARY_LEAVE_ORDER.map((k) => ({ key: k, label: CFG.LEAVE_TYPES[k].label })),
    ];

    const rangeBtns = [
      { key: "all", label: "全部日期" },
      { key: "7d", label: "最近 7 天" },
      { key: "month", label: "本月" },
      { key: "custom", label: "自訂區間" },
    ];

    let listHtml = "";
    if (ui.overview.viewMode === "student") {
      if (studentGroups.length === 0) {
        listHtml = `
          <div class="empty-state">
            <h4>${ui.overview.onlyUnfinished ? "目前篩選條件下沒有待補作業" : "尚無符合條件的出缺席紀錄"}</h4>
            <p class="muted-text" style="margin-bottom:14px;">
              可切換到「全部有請假紀錄」，或前往「出缺席 ＆ 聯絡簿」登記請假與當日聯絡簿。
            </p>
            <button type="button" class="btn btn-primary btn-sm" id="btn-goto-daily-empty">前往登記出缺席與聯絡簿 →</button>
          </div>`;
      } else {
        listHtml = `<div class="student-cards">${studentGroups
          .map((grp) => {
            const seatLabel = escapeHtml(store.formatSeatLabel(grp.seat));
            const statusBadges = [
              grp.pendingCount > 0
                ? `<span class="badge" style="color:#D70015;background:rgba(255,59,48,0.11)">未補 ${grp.pendingCount}</span>`
                : "",
              grp.submittedCount > 0
                ? `<span class="badge" style="color:#B25000;background:rgba(255,149,0,0.13)">待改 ${grp.submittedCount}</span>`
                : "",
              grp.doneCount > 0
                ? `<span class="badge" style="color:#1E8E3E;background:rgba(52,199,89,0.13)">完成 ${grp.doneCount}</span>`
                : "",
            ]
              .filter(Boolean)
              .join("");

            const blocksHtml = grp.absences
              .map((block) => {
                const abs = block.absence;
                let entriesHtml = "";
                if (!block.hasContactDay) {
                  entriesHtml = `
                    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:10px 14px;border-radius:12px;background:rgba(255,149,0,0.08);border:1px dashed rgba(255,149,0,0.35);">
                      <span class="muted-text" style="color:#B25000;font-weight:600;">尚未輸入 ${escapeHtml(abs.date)} 的聯絡簿內容</span>
                      <button type="button" class="btn btn-secondary btn-sm btn-jump-date" data-date="${escapeHtml(abs.date)}">補登該日聯絡簿 →</button>
                    </div>`;
                } else if (block.entries.length === 0) {
                  entriesHtml = `<div class="muted-text" style="padding:4px 0;">當日聯絡簿沒有需要補交的項目</div>`;
                } else {
                  entriesHtml = `<div class="makeup-list">${block.entries
                    .map((e) => {
                      const statusClass = `status-${e.status}`;
                      return `
                        <div class="makeup-row ${statusClass}">
                          <div class="makeup-item-info">
                            ${categoryBadgeHtml(e.item.category)}
                            ${periodBadgeHtml(e.item.period)}
                            <span class="makeup-item-title">${escapeHtml(e.item.title)}</span>
                            ${e.manuallyAdded ? '<span class="badge" style="color:#515154;background:rgba(118,118,128,0.12);">手動加補</span>' : ""}
                          </div>
                          <div class="status-seg" role="group" aria-label="補交狀態">
                            ${["pending", "submitted", "done", "exempt"]
                              .map((st) => {
                                const info = CFG.MAKEUP_STATUSES[st];
                                const activeCls = e.status === st ? `active-${st}` : "";
                                return `<button type="button" class="status-seg-btn ${activeCls} btn-set-status" data-absence-id="${escapeHtml(abs.id)}" data-item-id="${escapeHtml(e.item.id)}" data-status="${st}">${escapeHtml(info.short)}</button>`;
                              })
                              .join("")}
                          </div>
                        </div>`;
                    })
                    .join("")}</div>`;
                }

                const skippedHtml =
                  block.skipped.length > 0
                    ? `<details class="skipped-details">
                        <summary>同日略過 ${block.skipped.length} 項（半天時段未重疊或純提醒）</summary>
                        ${block.skipped
                          .map(
                            (sk) => `
                          <div class="skipped-row">
                            <span>${categoryBadgeHtml(sk.item.category)} ${escapeHtml(sk.item.title)} <span class="muted-text">(${escapeHtml(sk.reason)})</span></span>
                            <button type="button" class="btn btn-secondary btn-sm btn-set-status" data-absence-id="${escapeHtml(abs.id)}" data-item-id="${escapeHtml(sk.item.id)}" data-status="pending">+ 加入待補</button>
                          </div>`
                          )
                          .join("")}
                      </details>`
                    : "";

                return `
                  <div class="absence-block">
                    <div class="absence-block-title">
                      <div class="absence-meta">
                        <span>${escapeHtml(U.formatShortDate(abs.date))}</span>
                        ${leaveBadgeHtml(abs.leave_type, abs.session)}
                        ${abs.note ? `<span class="absence-note-text">${escapeHtml(abs.note)}</span>` : ""}
                      </div>
                      <button type="button" class="btn btn-secondary btn-sm btn-jump-date" data-date="${escapeHtml(abs.date)}">查看當日</button>
                    </div>
                    ${entriesHtml}
                    ${skippedHtml}
                  </div>`;
              })
              .join("");

            return `
              <article class="student-card ${grp.unfinishedCount > 0 ? "has-unfinished" : ""}">
                <div class="student-card-head">
                  <div class="student-head-left">
                    <span class="seat-chip">${seatLabel}</span>
                    ${statusBadges}
                  </div>
                  <div class="student-head-actions">
                    ${
                      grp.unfinishedCount > 0
                        ? `<button type="button" class="btn btn-secondary btn-sm btn-copy-student" data-seat="${grp.seat}">複製通知</button>
                           <button type="button" class="btn btn-primary btn-sm btn-finish-student" data-seat="${grp.seat}">本生全數完成</button>`
                        : `<span class="badge" style="color:#1E8E3E;background:rgba(52,199,89,0.13)">已無待補作業</span>`
                    }
                  </div>
                </div>
                ${blocksHtml}
              </article>`;
          })
          .join("")}</div>`;
      }
    } else {
      // 依作業項目反查
      if (itemGroups.length === 0) {
        listHtml = `
          <div class="empty-state">
            <h4>目前沒有符合條件的作業追查項目</h4>
            <p class="muted-text">可切換篩選條件或回到「依學生座號」檢視。</p>
          </div>`;
      } else {
        listHtml = `<div class="student-cards">${itemGroups
          .map((ig) => {
            const unfinishedInItem = ig.entries.filter(
              (e) => e.status === "pending" || e.status === "submitted"
            ).length;
            return `
              <article class="student-card ${unfinishedInItem > 0 ? "has-unfinished" : ""}">
                <div class="student-card-head">
                  <div class="student-head-left">
                    <span class="badge" style="color:#0066CC;background:rgba(0,122,255,0.11)">${escapeHtml(U.formatShortDate(ig.item.date))}</span>
                    ${categoryBadgeHtml(ig.item.category)}
                    ${periodBadgeHtml(ig.item.period)}
                    <strong style="font-size:0.98rem;">${escapeHtml(ig.item.title)}</strong>
                  </div>
                  <span class="badge" style="color:${unfinishedInItem > 0 ? "#D70015" : "#1E8E3E"};background:${unfinishedInItem > 0 ? "rgba(255,59,48,0.11)" : "rgba(52,199,89,0.13)"}">
                    ${unfinishedInItem > 0 ? `待追蹤 ${unfinishedInItem} 人` : "全部已結案"}
                  </span>
                </div>
                <div class="absence-block">
                  <div class="makeup-list">
                    ${ig.entries
                      .sort((a, b) => a.absence.seat - b.absence.seat)
                      .map(
                        (e) => `
                        <div class="makeup-row status-${e.status}">
                          <div class="makeup-item-info">
                            <span class="seat-chip" style="font-size:0.84rem;padding:3px 10px;">${escapeHtml(store.formatSeatLabel(e.absence.seat))}</span>
                            ${leaveBadgeHtml(e.absence.leave_type, e.absence.session)}
                            ${e.absence.note ? `<span class="absence-note-text">${escapeHtml(e.absence.note)}</span>` : ""}
                          </div>
                          <div class="status-seg">
                            ${["pending", "submitted", "done", "exempt"]
                              .map((st) => {
                                const info = CFG.MAKEUP_STATUSES[st];
                                const activeCls = e.status === st ? `active-${st}` : "";
                                return `<button type="button" class="status-seg-btn ${activeCls} btn-set-status" data-absence-id="${escapeHtml(e.absence.id)}" data-item-id="${escapeHtml(e.item.id)}" data-status="${st}">${escapeHtml(info.short)}</button>`;
                              })
                              .join("")}
                          </div>
                        </div>`
                      )
                      .join("")}
                  </div>
                </div>
              </article>`;
          })
          .join("")}</div>`;
      }
    }

    panel.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card ${allUnfinishedEntries.length > 0 ? "alert" : "ok"}">
          <div class="kpi-top">
            <span class="kpi-label">全班未完成補交</span>
            <span class="kpi-dot" aria-hidden="true"></span>
          </div>
          <div class="kpi-value">${allUnfinishedEntries.length} 項</div>
          <div class="kpi-sub">未補 ${pendingOnlyCount} 項・已交待改 ${submittedOnlyCount} 項</div>
        </div>
        <div class="kpi-card ${unfinishedSeats.size > 0 ? "warn" : "ok"}">
          <div class="kpi-top">
            <span class="kpi-label">待追蹤學生人數</span>
            <span class="kpi-dot" aria-hidden="true"></span>
          </div>
          <div class="kpi-value">${unfinishedSeats.size} 人</div>
          <div class="kpi-sub">點下方卡片按鈕可即時更新</div>
        </div>
        <div class="kpi-card info">
          <div class="kpi-top">
            <span class="kpi-label">今日請假人數</span>
            <span class="kpi-dot" aria-hidden="true"></span>
          </div>
          <div class="kpi-value">${todayAbsences.length} 人</div>
          <div class="kpi-sub">${escapeHtml(U.formatShortDate(today))}｜事 ${todayBreakdown.personal}・病 ${todayBreakdown.sick}・喪 ${todayBreakdown.bereavement}</div>
        </div>
        <div class="kpi-card ok">
          <div class="kpi-top">
            <span class="kpi-label">已結案補交項目</span>
            <span class="kpi-dot" aria-hidden="true"></span>
          </div>
          <div class="kpi-value">${completedCount} 項</div>
          <div class="kpi-sub">包含已完成與教師免補</div>
        </div>
      </div>

      <div class="toolbar">
        <div class="toolbar-row">
          <div class="pill-group">
            <div class="seg-track" role="group" aria-label="檢視維度">
              <button type="button" class="seg-btn ${ui.overview.viewMode === "student" ? "active" : ""}" data-view-mode="student">依學生座號</button>
              <button type="button" class="seg-btn ${ui.overview.viewMode === "item" ? "active" : ""}" data-view-mode="item">依作業項目</button>
            </div>
            <div class="seg-track" role="group" aria-label="完成度篩選">
              <button type="button" class="seg-btn ${ui.overview.onlyUnfinished ? "active" : ""}" data-unfinished="1">只看有未補作業</button>
              <button type="button" class="seg-btn ${!ui.overview.onlyUnfinished ? "active" : ""}" data-unfinished="0">全部有請假紀錄</button>
            </div>
          </div>
          <div class="pill-group" style="flex:1;justify-content:flex-end;">
            <div class="search-wrap">
              <svg class="icon-svg search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="20" y1="20" x2="16.2" y2="16.2" />
              </svg>
              <input id="ov-search" class="search-input" type="search" value="${escapeHtml(ui.overview.search)}" placeholder="搜尋座號或作業關鍵字…" />
            </div>
            <button id="btn-copy-class-reminder" type="button" class="btn btn-soft btn-sm">複製全班催交（純座號）</button>
          </div>
        </div>
        <div class="toolbar-row">
          <div class="pill-group">
            <span class="muted-text" style="font-weight:600;">假別</span>
            ${leaveBtns
              .map(
                (b) =>
                  `<button type="button" class="pill-btn ${ui.overview.leaveFilter === b.key ? "active" : ""}" data-leave-filter="${b.key}">${escapeHtml(b.label)}</button>`
              )
              .join("")}
          </div>
          <div class="pill-group">
            <span class="muted-text" style="font-weight:600;">期間</span>
            ${rangeBtns
              .map(
                (b) =>
                  `<button type="button" class="pill-btn ${ui.overview.rangeFilter === b.key ? "active" : ""}" data-range-filter="${b.key}">${escapeHtml(b.label)}</button>`
              )
              .join("")}
            ${
              ui.overview.rangeFilter === "custom"
                ? `<input id="ov-start-date" type="date" class="cb-mini-select" value="${escapeHtml(ui.overview.startDate)}" />
                   <span class="muted-text">–</span>
                   <input id="ov-end-date" type="date" class="cb-mini-select" value="${escapeHtml(ui.overview.endDate)}" />`
                : ""
            }
          </div>
        </div>
      </div>

      ${listHtml}
    `;

    // 事件綁定
    panel.querySelectorAll("[data-view-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.overview.viewMode = btn.dataset.viewMode;
        renderOverviewTab();
      });
    });

    panel.querySelectorAll("[data-unfinished]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.overview.onlyUnfinished = btn.dataset.unfinished === "1";
        renderOverviewTab();
      });
    });

    panel.querySelectorAll("[data-leave-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.overview.leaveFilter = btn.dataset.leaveFilter;
        renderOverviewTab();
      });
    });

    panel.querySelectorAll("[data-range-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.overview.rangeFilter = btn.dataset.rangeFilter;
        renderOverviewTab();
      });
    });

    const startInput = panel.querySelector("#ov-start-date");
    const endInput = panel.querySelector("#ov-end-date");
    if (startInput) {
      startInput.addEventListener("change", () => {
        ui.overview.startDate = startInput.value;
        renderOverviewTab();
      });
    }
    if (endInput) {
      endInput.addEventListener("change", () => {
        ui.overview.endDate = endInput.value;
        renderOverviewTab();
      });
    }

    const searchInput = panel.querySelector("#ov-search");
    searchInput.addEventListener("input", (e) => {
      ui.overview.search = e.target.value;
      const pos = e.target.selectionStart;
      renderOverviewTab();
      const refreshed = document.getElementById("ov-search");
      if (refreshed) {
        refreshed.focus();
        if (typeof pos === "number") refreshed.setSelectionRange(pos, pos);
      }
    });

    panel.querySelector("#btn-goto-daily-empty")?.addEventListener("click", () => {
      ui.activeTab = "daily";
      loadDailyDraftFromState(ui.daily.selectedDate);
      renderAll();
    });

    panel.querySelectorAll(".btn-jump-date").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.activeTab = "daily";
        ui.daily.selectedDate = btn.dataset.date;
        ui.daily.selectedSeat = null;
        loadDailyDraftFromState(btn.dataset.date);
        renderAll();
      });
    });

    panel.querySelectorAll(".btn-set-status").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await store.setMakeupStatuses([
            {
              absence_id: btn.dataset.absenceId,
              item_id: btn.dataset.itemId,
              status: btn.dataset.status,
            },
          ]);
          showToast(`已更新為「${CFG.MAKEUP_STATUSES[btn.dataset.status]?.label}」`, "ok");
          renderAll();
        } catch (err) {
          showToast(`更新失敗：${err.message}`, "err");
        }
      });
    });

    panel.querySelectorAll(".btn-finish-student").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const seat = Number(btn.dataset.seat);
        const grp = studentGroups.find((g) => g.seat === seat);
        if (!grp) return;
        const entries = grp.absences.flatMap((b) =>
          b.entries
            .filter((e) => e.status === "pending" || e.status === "submitted")
            .map((e) => ({ absence_id: b.absence.id, item_id: e.item.id, status: "done" }))
        );
        if (entries.length === 0) return;
        try {
          await store.setMakeupStatuses(entries);
          showToast(`${store.formatSeatLabel(seat, false)} 已全部標記完成（${entries.length} 項）`, "ok");
          renderAll();
        } catch (err) {
          showToast(`更新失敗：${err.message}`, "err");
        }
      });
    });

    panel.querySelectorAll(".btn-copy-student").forEach((btn) => {
      btn.addEventListener("click", () => {
        const seat = Number(btn.dataset.seat);
        const grp = studentGroups.find((g) => g.seat === seat);
        if (!grp) return;
        const msg = buildStudentBroadcastText(grp);
        if (msg) copyTextToClipboard(msg, `已複製 ${store.formatSeatLabel(seat, false)} 待補清單`);
      });
    });

    panel.querySelector("#btn-copy-class-reminder")?.addEventListener("click", () => {
      const lines = studentGroups
        .map((g) => buildStudentBroadcastText(g))
        .filter(Boolean);
      if (lines.length === 0) {
        showToast("目前沒有需要催交的未補作業", "ok");
        return;
      }
      const cls = store.state.settings?.class_name || "402 班";
      copyTextToClipboard(`【${cls} 待補作業提醒】\n${lines.join("\n")}`, "已複製全班純座號催交提醒");
    });
  }

  function renderDailyTab(precomputedIndexes) {
    const indexes = precomputedIndexes || U.buildDerivedIndexes(store.state);
    const panel = document.getElementById("panel-daily");
    const date = ui.daily.selectedDate;
    const today = U.getTodayDateStr();
    const maxSeat = Number(store.state.settings?.max_seat) || 29;
    const inactiveSet = new Set(store.state.settings?.inactive_seats || []);
    const dayAbsences = indexes.absencesByDate.get(date) || [];
    const absenceBySeat = new Map(dayAbsences.map((a) => [a.seat, a]));

    // 14 天快速日期列（以選取日期前後展開）
    const stripDates = [];
    for (let offset = -8; offset <= 5; offset += 1) {
      stripDates.push(U.addDays(date, offset));
    }

    const seatGridHtml = Array.from({ length: maxSeat }, (_, i) => {
      const seat = i + 1;
      const isInactive = inactiveSet.has(seat);
      const abs = absenceBySeat.get(seat);
      const isSelected = ui.daily.selectedSeat === seat;
      const lt = abs ? CFG.LEAVE_TYPES[abs.leave_type] || CFG.LEAVE_TYPES.other : null;
      const ss = abs ? CFG.SESSIONS[abs.session] || CFG.SESSIONS.full : null;
      const privateName = !store.privacyMask ? store.privateNames[String(seat)] || "" : "";
      const style = abs
        ? `background:${lt.bg};border-color:${lt.border};`
        : "";
      return `
        <button type="button"
          class="seat-tile ${isSelected ? "selected" : ""} ${isInactive ? "inactive" : ""}"
          data-seat="${seat}"
          style="${style}"
          ${isInactive ? "disabled" : ""}>
          <span class="seat-tile-num">${String(seat).padStart(2, "0")}</span>
          ${privateName ? `<span class="seat-tile-name">${escapeHtml(privateName)}</span>` : ""}
          ${abs ? `<span class="seat-tile-tag" style="color:${lt.color};background:#fff;">${escapeHtml(lt.short)}・${escapeHtml(ss.short)}</span>` : ""}
        </button>`;
    }).join("");

    const selectedSeat = ui.daily.selectedSeat;
    const selectedExistingAbs = selectedSeat ? absenceBySeat.get(selectedSeat) : null;

    const quickEditorHtml = selectedSeat
      ? `
      <div class="quick-editor">
        <div class="panel-head" style="margin-bottom:8px;">
          <strong style="font-size:0.98rem;">正在登記：${escapeHtml(store.formatSeatLabel(selectedSeat))}（${escapeHtml(U.formatShortDate(date))}）</strong>
          <button type="button" id="btn-close-quick-seat" class="btn btn-secondary btn-sm">收合</button>
        </div>
        <div class="field-group" style="margin-bottom:8px;">
          <span class="field-label" style="margin-bottom:4px;">請假類別</span>
          <div class="chip-select-row" style="margin-bottom:0;">
            ${CFG.PRIMARY_LEAVE_ORDER.map((k) => {
              const info = CFG.LEAVE_TYPES[k];
              return `<button type="button" class="choice-chip ${ui.daily.quickLeaveType === k ? "active" : ""}" data-quick-leave="${k}">${escapeHtml(info.label)}</button>`;
            }).join("")}
          </div>
        </div>
        <div class="field-group" style="margin-bottom:8px;">
          <span class="field-label" style="margin-bottom:4px;">請假時段</span>
          <div class="chip-select-row" style="margin-bottom:0;">
            ${["full", "am", "pm"]
              .map((k) => {
                const info = CFG.SESSIONS[k];
                return `<button type="button" class="choice-chip ${ui.daily.quickSession === k ? "active" : ""}" data-quick-session="${k}">${escapeHtml(info.label)}</button>`;
              })
              .join("")}
          </div>
        </div>
        <div class="field-group" style="margin-bottom:10px;">
          <input id="quick-abs-note" class="input-text" type="text" value="${escapeHtml(ui.daily.quickNote)}" placeholder="備註／節次（選填，例如：看牙醫第3-4節）" />
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" id="btn-save-quick-abs" class="btn btn-primary btn-sm">${selectedExistingAbs ? "更新請假紀錄" : "登記請假"}</button>
          ${
            selectedExistingAbs
              ? `<button type="button" id="btn-del-quick-abs" class="btn btn-danger btn-sm">取消該日請假</button>`
              : ""
          }
        </div>
      </div>`
      : `<div class="muted-text" style="margin-bottom:12px;">點選上方任一座號格，即可快速登記「事假／病假／喪假」與時段。</div>`;

    const dayAbsencesHtml =
      dayAbsences.length === 0
        ? `<div class="muted-text">此日目前沒有請假紀錄。</div>`
        : `<div class="makeup-list">${dayAbsences
            .map((a) => {
              const tracked = indexes.entriesByAbsenceId.get(a.id)?.active || [];
              const unfinished = tracked.filter((e) => e.status === "pending" || e.status === "submitted").length;
              return `
                <div class="makeup-row">
                  <div class="makeup-item-info">
                    <button type="button" class="seat-chip btn-pick-seat" data-seat="${a.seat}" style="border:none;cursor:pointer;font-size:0.84rem;padding:3px 10px;">${escapeHtml(store.formatSeatLabel(a.seat))}</button>
                    ${leaveBadgeHtml(a.leave_type, a.session)}
                    ${a.note ? `<span class="absence-note-text">${escapeHtml(a.note)}</span>` : ""}
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span class="badge" style="color:${unfinished > 0 ? "#D70015" : "#1E8E3E"};background:${unfinished > 0 ? "rgba(255,59,48,0.11)" : "rgba(52,199,89,0.13)"}">
                      ${tracked.length === 0 ? "無應補項" : unfinished > 0 ? `未補 ${unfinished}/${tracked.length}` : `全 ${tracked.length} 項完成`}
                    </span>
                    <button type="button" class="btn btn-danger btn-sm btn-del-abs-row" data-abs-id="${escapeHtml(a.id)}">刪除</button>
                  </div>
                </div>`;
            })
            .join("")}</div>`;

    const cbItemsHtml =
      ui.daily.draftItems.length === 0
        ? `<div class="muted-text" style="padding:8px 0;">尚無拆解項目。貼上聯絡簿後點「智慧拆解」，或點「新增一項」。</div>`
        : ui.daily.draftItems
            .map(
              (item, idx) => `
            <div class="cb-item-row ${!item.requires_makeup ? "is-notice" : ""}" data-idx="${idx}">
              <div class="cb-item-top">
                <span class="muted-text" style="font-weight:700;min-width:22px;">${idx + 1}.</span>
                <input type="text" class="input-text cb-title-input" data-idx="${idx}" value="${escapeHtml(item.title)}" style="padding:6px 10px;" />
                <button type="button" class="btn btn-danger btn-sm btn-del-cb-item" data-idx="${idx}" title="刪除此項">✕</button>
              </div>
              <div class="cb-item-controls">
                <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                  <select class="cb-mini-select cb-cat-select" data-idx="${idx}">
                    ${Object.values(CFG.CATEGORIES)
                      .map((c) => `<option value="${c.key}" ${item.category === c.key ? "selected" : ""}>${escapeHtml(c.label)}</option>`)
                      .join("")}
                  </select>
                  <select class="cb-mini-select cb-period-select" data-idx="${idx}">
                    ${Object.values(CFG.PERIODS)
                      .map((p) => `<option value="${p.key}" ${item.period === p.key ? "selected" : ""}>時段：${escapeHtml(p.label)}</option>`)
                      .join("")}
                  </select>
                </div>
                <button type="button" class="toggle-makeup-btn ${item.requires_makeup ? "req" : "exempt"} btn-toggle-req" data-idx="${idx}">
                  ${item.requires_makeup ? "需補交" : "免補（純提醒）"}
                </button>
              </div>
            </div>`
            )
            .join("");

    // 當日即時連動預覽
    const savedDayItems = indexes.itemsByDate.get(date) || [];
    let liveMatrixHtml = "";
    if (dayAbsences.length === 0) {
      liveMatrixHtml = `<div class="muted-text">此日目前無請假學生；未來若補登記此日缺席，已儲存的聯絡簿項目會自動套用。</div>`;
    } else if (savedDayItems.length === 0) {
      liveMatrixHtml = `<div class="muted-text">此日已有 ${dayAbsences.length} 位請假學生，請先在右上方拆解並按下「儲存當日聯絡簿」即可追蹤補交進度。</div>`;
    } else {
      liveMatrixHtml = `<div class="student-cards">${dayAbsences
        .map((abs) => {
          const data = indexes.entriesByAbsenceId.get(abs.id) || { active: [], skipped: [] };
          return `
            <div class="absence-block" style="background:#fff;border:1px solid var(--separator);border-radius:14px;">
              <div class="absence-block-title">
                <div class="absence-meta">
                  <span class="seat-chip" style="font-size:0.86rem;padding:3px 10px;">${escapeHtml(store.formatSeatLabel(abs.seat))}</span>
                  ${leaveBadgeHtml(abs.leave_type, abs.session)}
                  ${abs.note ? `<span class="absence-note-text">${escapeHtml(abs.note)}</span>` : ""}
                </div>
              </div>
              ${
                data.active.length === 0
                  ? `<div class="muted-text">依時段設定，此生當日無須補交項目。</div>`
                  : `<div class="makeup-list">
                      ${data.active
                        .map(
                          (e) => `
                        <div class="makeup-row status-${e.status}">
                          <div class="makeup-item-info">
                            ${categoryBadgeHtml(e.item.category)}
                            ${periodBadgeHtml(e.item.period)}
                            <span class="makeup-item-title">${escapeHtml(e.item.title)}</span>
                          </div>
                          <div class="status-seg">
                            ${["pending", "submitted", "done", "exempt"]
                              .map((st) => {
                                const info = CFG.MAKEUP_STATUSES[st];
                                return `<button type="button" class="status-seg-btn ${e.status === st ? `active-${st}` : ""} btn-set-status" data-absence-id="${escapeHtml(abs.id)}" data-item-id="${escapeHtml(e.item.id)}" data-status="${st}">${escapeHtml(info.short)}</button>`;
                              })
                              .join("")}
                          </div>
                        </div>`
                        )
                        .join("")}
                    </div>`
              }
              ${
                data.skipped.length > 0
                  ? `<details class="skipped-details">
                      <summary>已略過 ${data.skipped.length} 項（半天時段未重疊／純提醒）</summary>
                      ${data.skipped
                        .map(
                          (sk) => `
                        <div class="skipped-row">
                          <span>${categoryBadgeHtml(sk.item.category)} ${escapeHtml(sk.item.title)} <span class="muted-text">(${escapeHtml(sk.reason)})</span></span>
                          <button type="button" class="btn btn-secondary btn-sm btn-set-status" data-absence-id="${escapeHtml(abs.id)}" data-item-id="${escapeHtml(sk.item.id)}" data-status="pending">+ 加入待補</button>
                        </div>`
                        )
                        .join("")}
                    </details>`
                  : ""
              }
            </div>`;
        })
        .join("")}</div>`;
    }

    panel.innerHTML = `
      <div class="date-nav-card">
        <div class="date-bar">
          <div class="date-controls">
            <button type="button" id="btn-prev-day" class="btn btn-secondary btn-sm">‹ 前一天</button>
            <input id="daily-date-picker" type="date" class="input-text" style="width:auto;padding:6px 11px;" value="${escapeHtml(date)}" />
            <span style="font-weight:700;font-size:1.02rem;letter-spacing:-0.01em;">${escapeHtml(U.formatShortDate(date))}</span>
            <button type="button" id="btn-next-day" class="btn btn-secondary btn-sm">後一天 ›</button>
            ${date !== today ? `<button type="button" id="btn-goto-today" class="btn btn-soft btn-sm">回到今天</button>` : ""}
          </div>
          <button type="button" id="btn-open-batch" class="btn btn-primary btn-sm">連續多日／批次請假</button>
        </div>
        <div class="date-strip">
          ${stripDates
            .map((d) => {
              const dow = U.parseDateLocal(d).getDay();
              const isWeekend = dow === 0 || dow === 6;
              const hasAbs = (indexes.absencesByDate.get(d) || []).length > 0;
              const hasCb = (indexes.itemsByDate.get(d) || []).length > 0 || indexes.daysByDate.has(d);
              return `
                <button type="button" class="day-chip ${d === date ? "active" : ""} ${isWeekend ? "weekend" : ""}" data-strip-date="${d}">
                  <div class="day-chip-date">${escapeHtml(U.formatShortDate(d))}</div>
                  <div class="day-chip-dots">
                    ${hasAbs ? '<span class="dot dot-abs" title="有出缺席紀錄"></span>' : ""}
                    ${hasCb ? '<span class="dot dot-cb" title="有聯絡簿紀錄"></span>' : ""}
                  </div>
                </button>`;
            })
            .join("")}
        </div>
      </div>

      <div class="two-col-grid">
        <section class="card">
          <div class="panel-head">
            <h3>1. 當日出缺席登記</h3>
            <span class="muted-text">點座號快速請假｜藍點標示</span>
          </div>
          <div class="seat-grid">${seatGridHtml}</div>
          ${quickEditorHtml}
          <div class="panel-head" style="margin-top:8px;margin-bottom:8px;">
            <strong style="font-size:0.93rem;">本日請假名單（${dayAbsences.length} 人）</strong>
          </div>
          ${dayAbsencesHtml}
        </section>

        <section class="card">
          <div class="panel-head">
            <h3>2. 當日聯絡簿內容 ＆ 拆解</h3>
            ${ui.daily.dirty ? '<span class="unsaved-badge">尚未儲存</span>' : '<span class="muted-text">綠點標示</span>'}
          </div>
          <div class="field-group">
            <label class="field-label" for="cb-raw-text">貼上聯絡簿全文（自動辨識作業／小考／訂簽／純提醒與上下午）</label>
            <textarea id="cb-raw-text" class="input-textarea" rows="5" placeholder="例：&#10;1. 國語習作 L8&#10;2. 數學習作 P.44-45（下午）&#10;3. 國語 L8 聽寫小考（上午）&#10;4. 明天穿班服、帶三角板">${escapeHtml(ui.daily.draftRawText)}</textarea>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
            <button type="button" id="btn-parse-cb" class="btn btn-soft btn-sm">智慧拆解成項目</button>
            <button type="button" id="btn-add-cb-item" class="btn btn-secondary btn-sm">＋ 新增一項</button>
            <input id="cb-day-note" class="input-text" style="flex:1;min-width:160px;padding:6px 11px;" type="text" value="${escapeHtml(ui.daily.draftNote)}" placeholder="當日備註（例：段考週）" />
          </div>
          <div class="cb-items-list">${cbItemsHtml}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--separator);">
            <button type="button" id="btn-clear-cb-day" class="btn btn-danger btn-sm">清空當日聯絡簿</button>
            <button type="button" id="btn-save-cb-day" class="btn btn-primary">儲存當日聯絡簿並連動學生</button>
          </div>
        </section>
      </div>

      <section class="card">
        <div class="panel-head">
          <h3>3. 本日請假學生 × 聯絡簿對照（${escapeHtml(U.formatShortDate(date))}）</h3>
          <span class="muted-text">半天請假未重疊時段會自動略過，可隨時按「免補」或「加入待補」</span>
        </div>
        ${liveMatrixHtml}
      </section>
    `;

    // 日期切換事件
    panel.querySelector("#btn-prev-day").addEventListener("click", () => switchDailyDate(U.addDays(date, -1)));
    panel.querySelector("#btn-next-day").addEventListener("click", () => switchDailyDate(U.addDays(date, 1)));
    panel.querySelector("#btn-goto-today")?.addEventListener("click", () => switchDailyDate(today));
    panel.querySelector("#daily-date-picker").addEventListener("change", (e) => {
      if (e.target.value) switchDailyDate(e.target.value);
    });
    panel.querySelectorAll("[data-strip-date]").forEach((btn) => {
      btn.addEventListener("click", () => switchDailyDate(btn.dataset.stripDate));
    });
    panel.querySelector("#btn-open-batch").addEventListener("click", openBatchModal);

    // 座號快選
    panel.querySelectorAll(".seat-tile:not(.inactive), .btn-pick-seat").forEach((btn) => {
      btn.addEventListener("click", () => selectDailySeat(Number(btn.dataset.seat)));
    });

    panel.querySelector("#btn-close-quick-seat")?.addEventListener("click", () => {
      ui.daily.selectedSeat = null;
      renderDailyTab();
    });
    panel.querySelectorAll("[data-quick-leave]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.daily.quickLeaveType = btn.dataset.quickLeave;
        renderDailyTab();
      });
    });
    panel.querySelectorAll("[data-quick-session]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.daily.quickSession = btn.dataset.quickSession;
        renderDailyTab();
      });
    });
    panel.querySelector("#quick-abs-note")?.addEventListener("input", (e) => {
      ui.daily.quickNote = e.target.value;
    });

    panel.querySelector("#btn-save-quick-abs")?.addEventListener("click", async () => {
      if (!ui.daily.selectedSeat) return;
      try {
        await store.upsertAbsences({
          seats: [ui.daily.selectedSeat],
          dates: [date],
          leave_type: ui.daily.quickLeaveType,
          session: ui.daily.quickSession,
          note: ui.daily.quickNote.trim(),
        });
        showToast(`已登記 ${store.formatSeatLabel(ui.daily.selectedSeat, false)} 請假`, "ok");
        ui.daily.selectedSeat = null;
        renderAll();
      } catch (err) {
        showToast(`儲存失敗：${err.message}`, "err");
      }
    });

    panel.querySelector("#btn-del-quick-abs")?.addEventListener("click", async () => {
      if (!selectedExistingAbs) return;
      try {
        await store.deleteAbsence(selectedExistingAbs.id);
        showToast("已取消該日請假紀錄", "ok");
        ui.daily.selectedSeat = null;
        renderAll();
      } catch (err) {
        showToast(`刪除失敗：${err.message}`, "err");
      }
    });

    panel.querySelectorAll(".btn-del-abs-row").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("確定刪除此筆請假紀錄？（該筆對應的補交勾選紀錄也會一併移除）")) return;
        try {
          await store.deleteAbsence(btn.dataset.absId);
          showToast("已刪除請假紀錄", "ok");
          renderAll();
        } catch (err) {
          showToast(`刪除失敗：${err.message}`, "err");
        }
      });
    });

    // 聯絡簿編輯事件
    panel.querySelector("#cb-raw-text").addEventListener("input", (e) => {
      ui.daily.draftRawText = e.target.value;
      ui.daily.dirty = true;
    });
    panel.querySelector("#cb-day-note").addEventListener("input", (e) => {
      ui.daily.draftNote = e.target.value;
      ui.daily.dirty = true;
    });

    panel.querySelector("#btn-parse-cb").addEventListener("click", () => {
      const text = ui.daily.draftRawText.trim();
      if (!text) {
        showToast("請先在上方貼上聯絡簿內容", "err");
        return;
      }
      ui.daily.draftItems = Parser.parseContactBookText(text, ui.daily.draftItems);
      ui.daily.dirty = true;
      renderDailyTab();
      showToast(`已拆解 ${ui.daily.draftItems.length} 個項目（記得按儲存）`, "ok");
    });

    panel.querySelector("#btn-add-cb-item").addEventListener("click", () => {
      ui.daily.draftItems.push({
        id: crypto.randomUUID(),
        title: "",
        category: "homework",
        period: "all",
        requires_makeup: true,
      });
      ui.daily.dirty = true;
      renderDailyTab();
      const inputs = panel.querySelectorAll(".cb-title-input");
      inputs[inputs.length - 1]?.focus();
    });

    panel.querySelectorAll(".cb-title-input").forEach((inp) => {
      inp.addEventListener("input", (e) => {
        const idx = Number(inp.dataset.idx);
        ui.daily.draftItems[idx].title = e.target.value;
        ui.daily.dirty = true;
      });
    });

    panel.querySelectorAll(".cb-cat-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const idx = Number(sel.dataset.idx);
        const cat = e.target.value;
        ui.daily.draftItems[idx].category = cat;
        ui.daily.draftItems[idx].requires_makeup = cat !== "notice";
        ui.daily.dirty = true;
        renderDailyTab();
      });
    });

    panel.querySelectorAll(".cb-period-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const idx = Number(sel.dataset.idx);
        ui.daily.draftItems[idx].period = e.target.value;
        ui.daily.dirty = true;
        renderDailyTab();
      });
    });

    panel.querySelectorAll(".btn-toggle-req").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        ui.daily.draftItems[idx].requires_makeup = !ui.daily.draftItems[idx].requires_makeup;
        ui.daily.dirty = true;
        renderDailyTab();
      });
    });

    panel.querySelectorAll(".btn-del-cb-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        ui.daily.draftItems.splice(idx, 1);
        ui.daily.dirty = true;
        renderDailyTab();
      });
    });

    panel.querySelector("#btn-save-cb-day").addEventListener("click", async () => {
      // 如果有貼全文卻忘了按拆解，自動貼心幫忙拆一次
      if (ui.daily.draftItems.length === 0 && ui.daily.draftRawText.trim()) {
        ui.daily.draftItems = Parser.parseContactBookText(ui.daily.draftRawText, []);
      }
      const cleanItems = ui.daily.draftItems.filter((it) => String(it.title || "").trim());
      try {
        await store.saveContactDay(date, ui.daily.draftRawText, ui.daily.draftNote, cleanItems);
        loadDailyDraftFromState(date);
        showToast("已儲存當日聯絡簿並更新補交連動", "ok");
        renderAll();
      } catch (err) {
        showToast(`儲存失敗：${err.message}`, "err");
      }
    });

    panel.querySelector("#btn-clear-cb-day").addEventListener("click", async () => {
      if (!confirm(`確定清空 ${date} 的聯絡簿與所有項目？（已紀錄的當日補交狀態將一併清除）`)) return;
      try {
        await store.saveContactDay(date, "", "", []);
        loadDailyDraftFromState(date);
        showToast("已清空當日聯絡簿", "ok");
        renderAll();
      } catch (err) {
        showToast(`清空失敗：${err.message}`, "err");
      }
    });

    // 即時對照區的補交狀態按鈕
    panel.querySelectorAll(".btn-set-status").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await store.setMakeupStatuses([
            {
              absence_id: btn.dataset.absenceId,
              item_id: btn.dataset.itemId,
              status: btn.dataset.status,
            },
          ]);
          showToast(`已更新為「${CFG.MAKEUP_STATUSES[btn.dataset.status]?.label}」`, "ok");
          renderAll();
        } catch (err) {
          showToast(`更新失敗：${err.message}`, "err");
        }
      });
    });
  }

  function renderStatsTab(precomputedIndexes) {
    const indexes = precomputedIndexes || U.buildDerivedIndexes(store.state);
    const panel = document.getElementById("panel-stats");

    let startDate = "";
    let endDate = "";
    if (ui.stats.rangeMode === "month") {
      const m = ui.stats.month || U.getCurrentMonthStr();
      const [y, mon] = m.split("-").map(Number);
      const lastDay = new Date(y, mon, 0).getDate();
      startDate = `${m}-01`;
      endDate = `${m}-${String(lastDay).padStart(2, "0")}`;
    } else if (ui.stats.rangeMode === "custom") {
      startDate = ui.stats.startDate || "";
      endDate = ui.stats.endDate || "";
    }

    const { rows, totals } = U.computeLeaveStats(store.state, indexes, startDate, endDate);
    const displayRows = ui.stats.onlyWithAbsences ? rows.filter((r) => r.totalDays > 0) : rows;

    panel.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-row">
          <div class="pill-group">
            <div class="seg-track" role="group" aria-label="統計範圍">
              <button type="button" class="seg-btn ${ui.stats.rangeMode === "month" ? "active" : ""}" data-stats-mode="month">依月份統計</button>
              <button type="button" class="seg-btn ${ui.stats.rangeMode === "all" ? "active" : ""}" data-stats-mode="all">全學期／全部</button>
              <button type="button" class="seg-btn ${ui.stats.rangeMode === "custom" ? "active" : ""}" data-stats-mode="custom">自訂區間</button>
            </div>
            ${
              ui.stats.rangeMode === "month"
                ? `<input id="stats-month" type="month" class="cb-mini-select" value="${escapeHtml(ui.stats.month)}" />`
                : ui.stats.rangeMode === "custom"
                  ? `<input id="stats-start" type="date" class="cb-mini-select" value="${escapeHtml(ui.stats.startDate)}" />
                     <span class="muted-text">–</span>
                     <input id="stats-end" type="date" class="cb-mini-select" value="${escapeHtml(ui.stats.endDate)}" />`
                  : ""
            }
          </div>
          <div class="pill-group">
            <div class="seg-track" role="group" aria-label="座號顯示">
              <button type="button" class="seg-btn ${ui.stats.onlyWithAbsences ? "active" : ""}" data-stats-only="1">只看有請假學生</button>
              <button type="button" class="seg-btn ${!ui.stats.onlyWithAbsences ? "active" : ""}" data-stats-only="0">顯示全班座號</button>
            </div>
            <button type="button" id="btn-export-stats-csv" class="btn btn-primary btn-sm">匯出假別統計 CSV</button>
            <button type="button" id="btn-export-makeup-csv" class="btn btn-soft btn-sm">匯出待補明細 CSV</button>
          </div>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card info">
          <div class="kpi-top">
            <span class="kpi-label">事假合計</span>
            <span class="kpi-dot" aria-hidden="true"></span>
          </div>
          <div class="kpi-value">${totals.personal} 天</div>
          <div class="kpi-sub">半天以 0.5 天計入</div>
        </div>
        <div class="kpi-card warn">
          <div class="kpi-top">
            <span class="kpi-label">病假合計</span>
            <span class="kpi-dot" aria-hidden="true"></span>
          </div>
          <div class="kpi-value">${totals.sick} 天</div>
          <div class="kpi-sub">半天以 0.5 天計入</div>
        </div>
        <div class="kpi-card ok">
          <div class="kpi-top">
            <span class="kpi-label">喪假合計</span>
            <span class="kpi-dot" aria-hidden="true"></span>
          </div>
          <div class="kpi-value">${totals.bereavement} 天</div>
          <div class="kpi-sub">公假／其他：${totals.official + totals.other} 天</div>
        </div>
        <div class="kpi-card alert">
          <div class="kpi-top">
            <span class="kpi-label">總缺席人日</span>
            <span class="kpi-dot" aria-hidden="true"></span>
          </div>
          <div class="kpi-value">${totals.totalDays} 天</div>
          <div class="kpi-sub">共 ${totals.absenceRecords} 筆缺席紀錄</div>
        </div>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>座號</th>
              <th class="num-cell">事假</th>
              <th class="num-cell">病假</th>
              <th class="num-cell">喪假</th>
              <th class="num-cell">公假</th>
              <th class="num-cell">其他</th>
              <th class="num-cell">總天數</th>
              <th class="num-cell">尚未補齊</th>
              <th>請假日期明細</th>
            </tr>
          </thead>
          <tbody>
            ${
              displayRows.length === 0
                ? `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:32px;">此區間內無請假紀錄</td></tr>`
                : displayRows
                    .map(
                      (r) => `
                  <tr>
                    <td><strong>${escapeHtml(store.formatSeatLabel(r.seat))}</strong></td>
                    <td class="num-cell">${r.personal || "-"}</td>
                    <td class="num-cell">${r.sick || "-"}</td>
                    <td class="num-cell">${r.bereavement || "-"}</td>
                    <td class="num-cell">${r.official || "-"}</td>
                    <td class="num-cell">${r.other || "-"}</td>
                    <td class="num-cell"><strong>${r.totalDays}</strong></td>
                    <td class="num-cell">
                      ${
                        r.unfinishedCount > 0
                          ? `<span class="badge" style="color:#D70015;background:rgba(255,59,48,0.11);">${r.unfinishedCount} 項</span>`
                          : '<span class="muted-text">0</span>'
                      }
                    </td>
                    <td>
                      <div style="display:flex;gap:5px;flex-wrap:wrap;">
                        ${r.absences
                          .map((a) => {
                            const lt = CFG.LEAVE_TYPES[a.leave_type] || CFG.LEAVE_TYPES.other;
                            const ss = CFG.SESSIONS[a.session] || CFG.SESSIONS.full;
                            return `<span class="badge" style="color:${lt.color};background:${lt.bg};border-color:${lt.border}">${escapeHtml(U.formatShortDate(a.date))} ${escapeHtml(lt.short)}(${escapeHtml(ss.short)})</span>`;
                          })
                          .join("")}
                      </div>
                    </td>
                  </tr>`
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    `;

    panel.querySelectorAll("[data-stats-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.stats.rangeMode = btn.dataset.statsMode;
        renderStatsTab();
      });
    });
    panel.querySelectorAll("[data-stats-only]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.stats.onlyWithAbsences = btn.dataset.statsOnly === "1";
        renderStatsTab();
      });
    });
    panel.querySelector("#stats-month")?.addEventListener("change", (e) => {
      ui.stats.month = e.target.value;
      renderStatsTab();
    });
    panel.querySelector("#stats-start")?.addEventListener("change", (e) => {
      ui.stats.startDate = e.target.value;
      renderStatsTab();
    });
    panel.querySelector("#stats-end")?.addEventListener("change", (e) => {
      ui.stats.endDate = e.target.value;
      renderStatsTab();
    });
    panel.querySelector("#btn-export-stats-csv").addEventListener("click", () => {
      U.exportAttendanceCsv(store.state, indexes, startDate, endDate, (seat) =>
        store.formatSeatLabel(seat)
      );
      showToast("已下載假別統計 CSV", "ok");
    });
    panel.querySelector("#btn-export-makeup-csv").addEventListener("click", () => {
      U.exportUnfinishedMakeupCsv(store.state, indexes, (seat) => store.formatSeatLabel(seat));
      showToast("已下載待補作業明細 CSV", "ok");
    });
  }

  function renderSettingsTab() {
    const panel = document.getElementById("panel-settings");
    const settings = store.state.settings || CFG.DEFAULT_SETTINGS;
    const maxSeat = Number(settings.max_seat) || 29;
    const inactiveSet = new Set(settings.inactive_seats || []);

    const privateLines = Object.entries(store.privateNames || {})
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([seat, name]) => `${seat} ${name}`)
      .join("\n");

    panel.innerHTML = `
      <div class="two-col-grid">
        <section class="card">
          <div class="panel-head">
            <h3>班級與座號設定</h3>
          </div>
          <div class="field-group">
            <label class="field-label" for="set-class-name">班級名稱</label>
            <input id="set-class-name" class="input-text" type="text" value="${escapeHtml(settings.class_name)}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="set-max-seat">最大座號（1～45）</label>
            <input id="set-max-seat" class="input-text" type="number" min="1" max="45" value="${maxSeat}" />
          </div>
          <div class="field-group">
            <label class="field-label">空號／轉出座號（點選切換，停用座號不參與點名）</label>
            <div id="set-inactive-grid" class="seat-grid" style="margin-bottom:8px;">
              ${Array.from({ length: maxSeat }, (_, i) => {
                const s = i + 1;
                const off = inactiveSet.has(s);
                return `<button type="button" class="seat-tile ${off ? "inactive" : ""}" style="min-height:40px;" data-toggle-inactive="${s}">
                  <span class="seat-tile-num">${s}</span>
                  <span class="seat-tile-name">${off ? "空號" : "在班"}</span>
                </button>`;
              }).join("")}
            </div>
          </div>
          <button type="button" id="btn-save-settings" class="btn btn-primary">儲存班級設定</button>
        </section>

        <section class="card">
          <div class="panel-head">
            <h3>本機私密「座號－姓名」對照表</h3>
          </div>
          <p class="muted-text" style="margin-bottom:10px;">
            為保護學生個資，<strong>雲端資料庫永遠只存座號，不會上傳任何姓名</strong>。若想在目前裝置方便辨識，可在此貼上座號與姓名（僅存於本機瀏覽器），投影時可按頁首「隱藏姓名」一鍵遮蔽。
          </p>
          <div class="field-group">
            <label class="field-label" for="set-private-names">貼上名單（支援 Excel 兩欄貼上、空白或逗號分隔）</label>
            <textarea id="set-private-names" class="input-textarea" rows="7" placeholder="1 王小明&#10;2 李小華&#10;3 陳小美">${escapeHtml(privateLines)}</textarea>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" id="btn-save-private-names" class="btn btn-primary">僅存於本機</button>
            <button type="button" id="btn-clear-private-names" class="btn btn-danger">清除本機名單</button>
          </div>
        </section>
      </div>

      <section class="card" style="margin-bottom:16px;">
        <div class="panel-head">
          <h3>JSON 資料備份與還原</h3>
        </div>
        <p class="muted-text" style="margin-bottom:12px;">
          支援將所有出缺席紀錄、聯絡簿與補作業進度匯出成單一 JSON 檔，可作為學期備份，或在本機模式與雲端 Supabase 之間搬移資料。
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <button type="button" id="btn-export-json" class="btn btn-primary">下載完整 JSON 備份</button>
          <label class="choice-chip" style="display:inline-flex;align-items:center;gap:6px;">
            <input type="radio" name="import-mode" value="merge" checked /> 合併匯入（保留現有）
          </label>
          <label class="choice-chip" style="display:inline-flex;align-items:center;gap:6px;">
            <input type="radio" name="import-mode" value="replace" /> 完整覆蓋（清除舊資料）
          </label>
          <input id="file-import-json" type="file" accept="application/json,.json" class="hidden" />
          <button type="button" id="btn-trigger-import-json" class="btn btn-secondary">選擇 JSON 檔匯入</button>
        </div>
      </section>

      <section class="card">
        <div class="panel-head">
          <h3>Supabase 建表 SQL 參考</h3>
          <button type="button" id="btn-copy-settings-sql" class="btn btn-secondary btn-sm">複製建表 SQL</button>
        </div>
        <pre class="sql-preview">${escapeHtml(SCHEMA_SQL)}</pre>
      </section>
    `;

    const draftInactive = new Set(inactiveSet);
    panel.querySelectorAll("[data-toggle-inactive]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const seat = Number(btn.dataset.toggleInactive);
        if (draftInactive.has(seat)) draftInactive.delete(seat);
        else draftInactive.add(seat);
        btn.classList.toggle("inactive", draftInactive.has(seat));
        btn.querySelector(".seat-tile-name").textContent = draftInactive.has(seat) ? "空號" : "在班";
      });
    });

    panel.querySelector("#btn-save-settings").addEventListener("click", async () => {
      try {
        await store.updateSettings({
          class_name: panel.querySelector("#set-class-name").value,
          max_seat: Number(panel.querySelector("#set-max-seat").value),
          inactive_seats: Array.from(draftInactive),
        });
        showToast("已儲存班級設定", "ok");
        renderAll();
      } catch (err) {
        showToast(`儲存失敗：${err.message}`, "err");
      }
    });

    panel.querySelector("#btn-save-private-names").addEventListener("click", () => {
      const parsed = Parser.parsePrivateNameLines(
        panel.querySelector("#set-private-names").value,
        Number(store.state.settings?.max_seat) || 45
      );
      store.savePrivateNames(parsed);
      showToast(`已於本機儲存 ${Object.keys(parsed).length} 筆座號姓名對照`, "ok");
      renderAll();
    });

    panel.querySelector("#btn-clear-private-names").addEventListener("click", () => {
      if (!confirm("確定清除此瀏覽器儲存的私密姓名對照表？")) return;
      store.savePrivateNames({});
      store.setPrivacyMask(false);
      showToast("已清除本機姓名對照", "ok");
      renderAll();
    });

    panel.querySelector("#btn-export-json").addEventListener("click", () => {
      store.exportJsonBackup();
      showToast("已匯出 JSON 備份檔", "ok");
    });

    const fileInput = panel.querySelector("#file-import-json");
    panel.querySelector("#btn-trigger-import-json").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const mode = panel.querySelector('input[name="import-mode"]:checked')?.value || "merge";
      if (mode === "replace" && !confirm("「完整覆蓋」會先清空目前所有出缺席與聯絡簿資料，確定繼續嗎？")) {
        fileInput.value = "";
        return;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        await store.importJsonBackup(parsed, mode);
        loadDailyDraftFromState(ui.daily.selectedDate);
        showToast("JSON 備份匯入完成！", "ok");
        renderAll();
      } catch (err) {
        showToast(`匯入失敗：${err.message}`, "err");
      } finally {
        fileInput.value = "";
      }
    });

    panel.querySelector("#btn-copy-settings-sql").addEventListener("click", () => {
      copyTextToClipboard(SCHEMA_SQL, "已複製建表 SQL");
    });
  }

  function openBatchModal() {
    const modal = document.getElementById("batch-modal");
    ui.batch.seats = new Set(ui.daily.selectedSeat ? [ui.daily.selectedSeat] : []);
    document.getElementById("batch-start-date").value = ui.daily.selectedDate;
    document.getElementById("batch-end-date").value = ui.daily.selectedDate;
    document.getElementById("batch-note").value = "";
    renderBatchModalInner();
    modal.classList.remove("hidden");
  }

  function renderBatchModalInner() {
    const maxSeat = Number(store.state.settings?.max_seat) || 29;
    const inactiveSet = new Set(store.state.settings?.inactive_seats || []);
    const seatPicker = document.getElementById("batch-seat-picker");
    seatPicker.innerHTML = Array.from({ length: maxSeat }, (_, i) => {
      const seat = i + 1;
      const isInactive = inactiveSet.has(seat);
      const isSel = ui.batch.seats.has(seat);
      const name = !store.privacyMask ? store.privateNames[String(seat)] || "" : "";
      return `
        <button type="button" class="seat-tile ${isSel ? "selected" : ""} ${isInactive ? "inactive" : ""}" style="min-height:44px;${isSel ? "background:rgba(0,113,227,0.12);border-color:#0071E3;color:#0071E3;" : ""}" data-batch-seat="${seat}" ${isInactive ? "disabled" : ""}>
          <span class="seat-tile-num">${String(seat).padStart(2, "0")}</span>
          ${name ? `<span class="seat-tile-name">${escapeHtml(name)}</span>` : ""}
        </button>`;
    }).join("");

    seatPicker.querySelectorAll("[data-batch-seat]:not(.inactive)").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = Number(btn.dataset.batchSeat);
        if (ui.batch.seats.has(s)) ui.batch.seats.delete(s);
        else ui.batch.seats.add(s);
        renderBatchModalInner();
      });
    });

    const leaveWrap = document.getElementById("batch-leave-chips");
    leaveWrap.innerHTML = CFG.PRIMARY_LEAVE_ORDER.map((k) => {
      const info = CFG.LEAVE_TYPES[k];
      return `<button type="button" class="choice-chip ${ui.batch.leaveType === k ? "active" : ""}" data-batch-leave="${k}">${escapeHtml(info.label)}</button>`;
    }).join("");
    leaveWrap.querySelectorAll("[data-batch-leave]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.batch.leaveType = btn.dataset.batchLeave;
        renderBatchModalInner();
      });
    });

    const sessionWrap = document.getElementById("batch-session-chips");
    sessionWrap.innerHTML = ["full", "am", "pm"]
      .map((k) => {
        const info = CFG.SESSIONS[k];
        return `<button type="button" class="choice-chip ${ui.batch.session === k ? "active" : ""}" data-batch-session="${k}">${escapeHtml(info.label)}</button>`;
      })
      .join("");
    sessionWrap.querySelectorAll("[data-batch-session]").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.batch.session = btn.dataset.batchSession;
        renderBatchModalInner();
      });
    });
  }

  function showWorkspace() {
    document.getElementById("auth-section").classList.add("hidden");
    document.getElementById("app-header").classList.remove("hidden");
    document.getElementById("app-main").classList.remove("hidden");
    loadDailyDraftFromState(ui.daily.selectedDate);
    renderAll();
  }

  function showLoginScreen() {
    document.getElementById("app-header").classList.add("hidden");
    document.getElementById("app-main").classList.add("hidden");
    document.getElementById("auth-section").classList.remove("hidden");
    document.getElementById("login-card").classList.remove("hidden");
    document.getElementById("schema-card").classList.add("hidden");
  }

  function showSchemaGuide() {
    document.getElementById("login-card").classList.add("hidden");
    document.getElementById("schema-card").classList.remove("hidden");
    document.getElementById("schema-sql-preview").textContent = SCHEMA_SQL;
  }

  async function tryCloudLogin(pw, remember) {
    const errBox = document.getElementById("login-error");
    const schemaErr = document.getElementById("schema-error");
    errBox.classList.add("hidden");
    schemaErr.classList.add("hidden");

    try {
      await store.loginCloud(pw, remember);
      showWorkspace();
      showToast("已連線至 Supabase 雲端資料庫", "ok");
    } catch (err) {
      if (err.code === "schema_missing" || err.status === 503) {
        store.savePasswordPreference(pw, remember);
        showSchemaGuide();
        return;
      }
      const msg = err.status === 401 ? "教師密碼不正確，請再確認一次。" : `連線失敗：${err.message}`;
      errBox.textContent = msg;
      errBox.classList.remove("hidden");
      schemaErr.textContent = msg;
      schemaErr.classList.remove("hidden");
    }
  }

  function initEventListeners() {
    document.getElementById("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("btn-login-submit");
      const pw = document.getElementById("input-pw").value;
      const remember = document.getElementById("chk-remember-pw").checked;
      btn.disabled = true;
      btn.textContent = "驗證連線中…";
      await tryCloudLogin(pw, remember);
      btn.disabled = false;
      btn.textContent = "登入雲端工作台";
    });

    document.getElementById("btn-enter-local").addEventListener("click", () => {
      store.enterLocalMode();
      showWorkspace();
      showToast("已進入本機離線模式", "ok");
    });

    document.getElementById("btn-copy-sql").addEventListener("click", () => {
      copyTextToClipboard(SCHEMA_SQL, "已複製建表 SQL，請貼到 Supabase SQL Editor 執行");
    });

    document.getElementById("btn-retry-cloud").addEventListener("click", async () => {
      const btn = document.getElementById("btn-retry-cloud");
      btn.disabled = true;
      await tryCloudLogin(store.pw, document.getElementById("chk-remember-pw").checked);
      btn.disabled = false;
    });

    document.getElementById("btn-fallback-local").addEventListener("click", () => {
      store.enterLocalMode();
      showWorkspace();
    });

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        ui.activeTab = btn.dataset.tab;
        if (ui.activeTab === "daily" && !ui.daily.dirty) {
          loadDailyDraftFromState(ui.daily.selectedDate);
        }
        renderAll();
      });
    });

    document.getElementById("btn-toggle-privacy").addEventListener("click", () => {
      store.setPrivacyMask(!store.privacyMask);
      renderAll();
    });

    document.getElementById("btn-load-demo").addEventListener("click", () => {
      if (!confirm("這將以 402 班近三天的範例資料覆蓋目前本機瀏覽器紀錄，確定載入體驗嗎？")) return;
      store.loadLocalDemo();
      loadDailyDraftFromState(ui.daily.selectedDate);
      renderAll();
      showToast("已載入範例資料，可立即體驗篩選與補交追蹤！", "ok");
    });

    document.getElementById("btn-refresh").addEventListener("click", async () => {
      try {
        await store.refresh();
        if (!ui.daily.dirty) loadDailyDraftFromState(ui.daily.selectedDate);
        renderAll();
        showToast("已從雲端重新同步最新資料", "ok");
      } catch (err) {
        showToast(`同步失敗：${err.message}`, "err");
      }
    });

    document.getElementById("btn-logout").addEventListener("click", () => {
      store.clearSavedPassword();
      store.pw = "";
      document.getElementById("input-pw").value = "";
      showLoginScreen();
    });

    // 批次彈窗事件
    const closeBatch = () => document.getElementById("batch-modal").classList.add("hidden");
    document.getElementById("btn-close-batch").addEventListener("click", closeBatch);
    document.getElementById("btn-cancel-batch").addEventListener("click", closeBatch);
    document.getElementById("btn-submit-batch").addEventListener("click", async () => {
      const seats = Array.from(ui.batch.seats).sort((a, b) => a - b);
      const start = document.getElementById("batch-start-date").value;
      const end = document.getElementById("batch-end-date").value;
      const skipWeekends = document.getElementById("batch-skip-weekends").checked;
      const note = document.getElementById("batch-note").value.trim();

      if (seats.length === 0) {
        showToast("請至少選擇一位座號", "err");
        return;
      }
      const dates = U.enumerateDateRange(start, end, skipWeekends);
      if (dates.length === 0) {
        showToast("日期區間無效（或該區間全為週末）", "err");
        return;
      }

      try {
        await store.upsertAbsences({
          seats,
          dates,
          leave_type: ui.batch.leaveType,
          session: ui.batch.session,
          note,
        });
        closeBatch();
        showToast(`已批次登記 ${seats.length} 人 × ${dates.length} 天出缺席`, "ok");
        renderAll();
      } catch (err) {
        showToast(`批次登記失敗：${err.message}`, "err");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initEventListeners();
    const savedPw = store.getSavedPassword();
    if (savedPw) {
      document.getElementById("input-pw").value = savedPw;
      tryCloudLogin(savedPw, true);
    }
  });
})(window);
