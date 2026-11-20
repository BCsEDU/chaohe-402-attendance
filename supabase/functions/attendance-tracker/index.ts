import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_LEAVE_TYPES = new Set(["personal", "sick", "bereavement", "official", "other"]);
const VALID_SESSIONS = new Set(["full", "am", "pm"]);
const VALID_CATEGORIES = new Set(["homework", "quiz", "correction", "notice"]);
const VALID_PERIODS = new Set(["all", "am", "pm"]);
const VALID_STATUSES = new Set(["pending", "submitted", "done", "exempt"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function getSecretKey(): string {
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretJson) {
    try {
      const parsed = JSON.parse(secretJson);
      if (parsed?.default) return String(parsed.default);
    } catch {
      // Fallback to service role key
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function getAllowedClientKeys(): string[] {
  const keys: string[] = [];
  const pubJson = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (pubJson) {
    try {
      const parsed = JSON.parse(pubJson);
      Object.values(parsed).forEach((v) => {
        if (typeof v === "string" && v) keys.push(v);
      });
    } catch {
      // Ignore malformed JSON
    }
  }
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (anon) keys.push(anon);
  keys.push("sb_publishable_4_8Lj3idSkZ0z74V4AIpRA_qqyEicMd");
  return keys;
}

function isAuthorizedClient(req: Request): boolean {
  const allowed = getAllowedClientKeys();
  if (allowed.length === 0) return true;
  const apiKey = req.headers.get("apikey") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return allowed.includes(apiKey) || (bearer !== "" && allowed.includes(bearer));
}

function isValidDateStr(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidSeat(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 45;
}

function mapDbError(error: { code?: string; message?: string } | null): Response {
  const msg = error?.message ?? "Database error";
  const code = error?.code ?? "";
  const isMissingTable =
    code === "42P01" ||
    code === "PGRST205" ||
    msg.includes("Could not find the table") ||
    msg.includes("does not exist");
  return jsonResponse(
    {
      error: isMissingTable ? "schema_missing" : msg,
      detail: msg,
    },
    isMissingTable ? 503 : 500
  );
}

async function fetchFullState(supabaseAdmin: ReturnType<typeof createClient>) {
  const [settingsRes, daysRes, itemsRes, absencesRes, makeupRes] = await Promise.all([
    supabaseAdmin.from("att_settings").select("*").eq("id", "default").maybeSingle(),
    supabaseAdmin.from("att_contact_days").select("*").order("date", { ascending: false }),
    supabaseAdmin
      .from("att_contact_items")
      .select("*")
      .order("date", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("att_absences")
      .select("*")
      .order("date", { ascending: false })
      .order("seat", { ascending: true }),
    supabaseAdmin.from("att_makeup_records").select("*"),
  ]);

  const firstErr =
    settingsRes.error ?? daysRes.error ?? itemsRes.error ?? absencesRes.error ?? makeupRes.error;
  if (firstErr) {
    return { error: firstErr };
  }

  return {
    state: {
      settings: settingsRes.data ?? {
        id: "default",
        class_name: "402 班",
        max_seat: 29,
        inactive_seats: [],
      },
      contact_days: daysRes.data ?? [],
      contact_items: itemsRes.data ?? [],
      absences: absencesRes.data ?? [],
      makeup_records: makeupRes.data ?? [],
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (!isAuthorizedClient(req)) {
    return jsonResponse({ error: "Forbidden client" }, 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) {
    return jsonResponse({ error: "Missing Supabase server configuration" }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json();
    const action = String(body?.action ?? "");
    const pw = String(body?.pw ?? "");

    if (!pw) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const { data: pwRow, error: pwErr } = await supabaseAdmin
      .from("teacher_config")
      .select("pw")
      .eq("pw", pw)
      .maybeSingle();

    if (pwErr || !pwRow) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    // 1. 登入並拉取完整資料
    if (action === "get_state") {
      const result = await fetchFullState(supabaseAdmin);
      if ("error" in result && result.error) return mapDbError(result.error);
      return jsonResponse({ ok: true, ...result.state });
    }

    // 2. 更新班級設定
    if (action === "update_settings") {
      const className = String(body?.class_name ?? "402 班").trim().slice(0, 40) || "402 班";
      const maxSeat = Number(body?.max_seat ?? 29);
      if (!isValidSeat(maxSeat)) {
        return jsonResponse({ error: "Invalid max_seat (1-45)" }, 400);
      }
      const rawInactive = Array.isArray(body?.inactive_seats) ? body.inactive_seats : [];
      const inactiveSeats = Array.from(
        new Set(
          rawInactive
            .map((n: unknown) => Number(n))
            .filter((n: number) => isValidSeat(n) && n <= maxSeat)
        )
      ).sort((a, b) => a - b);

      const { data, error } = await supabaseAdmin
        .from("att_settings")
        .upsert(
          {
            id: "default",
            class_name: className,
            max_seat: maxSeat,
            inactive_seats: inactiveSeats,
          },
          { onConflict: "id" }
        )
        .select("*")
        .single();

      if (error) return mapDbError(error);
      return jsonResponse({ ok: true, settings: data });
    }

    // 3. 儲存單日聯絡簿與拆解項目（保留既有 item UUID 以避免覆寫已補交狀態）
    if (action === "save_contact_day") {
      const date = body?.date;
      if (!isValidDateStr(date)) {
        return jsonResponse({ error: "Invalid date" }, 400);
      }
      const rawText = String(body?.raw_text ?? "");
      const note = String(body?.note ?? "");
      const rawItems = Array.isArray(body?.items) ? body.items : [];

      const sanitizedItems = rawItems
        .map((item: Record<string, unknown>, index: number) => {
          const title = String(item?.title ?? "").trim();
          if (!title) return null;
          const category = VALID_CATEGORIES.has(String(item?.category))
            ? String(item.category)
            : "homework";
          const period = VALID_PERIODS.has(String(item?.period)) ? String(item.period) : "all";
          const requiresMakeup =
            category === "notice" ? Boolean(item?.requires_makeup ?? false) : Boolean(item?.requires_makeup ?? true);
          const id = typeof item?.id === "string" && UUID_RE.test(item.id) ? item.id : null;
          return {
            id,
            sort_order: index,
            title: title.slice(0, 200),
            category,
            period,
            requires_makeup: requiresMakeup,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (sanitizedItems.length === 0 && !rawText.trim() && !note.trim()) {
        const { error: delDayErr } = await supabaseAdmin
          .from("att_contact_days")
          .delete()
          .eq("date", date);
        if (delDayErr) return mapDbError(delDayErr);
        return jsonResponse({ ok: true, deleted_day: date, day: null, items: [] });
      }

      const { data: dayData, error: dayErr } = await supabaseAdmin
        .from("att_contact_days")
        .upsert({ date, raw_text: rawText, note }, { onConflict: "date" })
        .select("*")
        .single();

      if (dayErr) return mapDbError(dayErr);

      const { data: existingRows, error: existingErr } = await supabaseAdmin
        .from("att_contact_items")
        .select("id")
        .eq("date", date);

      if (existingErr) return mapDbError(existingErr);

      const existingIds = new Set((existingRows ?? []).map((r) => String(r.id)));
      const keptExistingIds = new Set<string>();

      for (const item of sanitizedItems) {
        if (item.id && existingIds.has(item.id)) {
          keptExistingIds.add(item.id);
        }
      }

      const idsToDelete = Array.from(existingIds).filter((id) => !keptExistingIds.has(id));
      if (idsToDelete.length > 0) {
        const { error: delItemsErr } = await supabaseAdmin
          .from("att_contact_items")
          .delete()
          .in("id", idsToDelete);
        if (delItemsErr) return mapDbError(delItemsErr);
      }

      for (const item of sanitizedItems) {
        if (item.id && keptExistingIds.has(item.id)) {
          const { error: updErr } = await supabaseAdmin
            .from("att_contact_items")
            .update({
              sort_order: item.sort_order,
              title: item.title,
              category: item.category,
              period: item.period,
              requires_makeup: item.requires_makeup,
            })
            .eq("id", item.id)
            .eq("date", date);
          if (updErr) return mapDbError(updErr);
        }
      }

      const newItems = sanitizedItems
        .filter((item) => !item.id || !keptExistingIds.has(item.id))
        .map((item) => ({
          ...(item.id ? { id: item.id } : {}),
          date,
          sort_order: item.sort_order,
          title: item.title,
          category: item.category,
          period: item.period,
          requires_makeup: item.requires_makeup,
        }));

      if (newItems.length > 0) {
        const { error: insErr } = await supabaseAdmin.from("att_contact_items").insert(newItems);
        if (insErr) return mapDbError(insErr);
      }

      const { data: updatedItems, error: fetchErr } = await supabaseAdmin
        .from("att_contact_items")
        .select("*")
        .eq("date", date)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (fetchErr) return mapDbError(fetchErr);
      return jsonResponse({ ok: true, day: dayData, items: updatedItems ?? [] });
    }

    // 4. 新增或更新單筆／批次出缺席紀錄
    if (action === "upsert_absence" || action === "batch_upsert_absences") {
      const leaveType = String(body?.leave_type ?? "");
      const session = String(body?.session ?? "full");
      const note = String(body?.note ?? "").slice(0, 200);

      if (!VALID_LEAVE_TYPES.has(leaveType)) {
        return jsonResponse({ error: "Invalid leave_type" }, 400);
      }
      if (!VALID_SESSIONS.has(session)) {
        return jsonResponse({ error: "Invalid session" }, 400);
      }

      const seatsRaw = action === "upsert_absence" ? [body?.seat] : body?.seats;
      const datesRaw = action === "upsert_absence" ? [body?.date] : body?.dates;
      const seats = Array.from(
        new Set((Array.isArray(seatsRaw) ? seatsRaw : []).map((n) => Number(n)).filter(isValidSeat))
      );
      const dates = Array.from(
        new Set((Array.isArray(datesRaw) ? datesRaw : []).filter(isValidDateStr))
      );

      if (seats.length === 0 || dates.length === 0) {
        return jsonResponse({ error: "Missing valid seats or dates" }, 400);
      }
      if (seats.length * dates.length > 300) {
        return jsonResponse({ error: "Too many absence rows in single batch" }, 400);
      }

      const rows = [];
      for (const date of dates) {
        for (const seat of seats) {
          rows.push({ seat, date, leave_type: leaveType, session, note });
        }
      }

      const { data, error } = await supabaseAdmin
        .from("att_absences")
        .upsert(rows, { onConflict: "seat,date" })
        .select("*");

      if (error) return mapDbError(error);
      return jsonResponse({ ok: true, absences: data ?? [] });
    }

    // 5. 刪除單筆或批次出缺席紀錄
    if (action === "delete_absence") {
      const id = typeof body?.id === "string" && UUID_RE.test(body.id) ? body.id : null;
      const seat = Number(body?.seat);
      const date = body?.date;

      if (id) {
        const { error } = await supabaseAdmin.from("att_absences").delete().eq("id", id);
        if (error) return mapDbError(error);
        return jsonResponse({ ok: true, deleted_id: id });
      }
      if (isValidSeat(seat) && isValidDateStr(date)) {
        const { data, error } = await supabaseAdmin
          .from("att_absences")
          .delete()
          .eq("seat", seat)
          .eq("date", date)
          .select("id");
        if (error) return mapDbError(error);
        return jsonResponse({ ok: true, deleted_id: data?.[0]?.id ?? null });
      }
      return jsonResponse({ error: "Invalid absence identifier" }, 400);
    }

    if (action === "batch_delete_absences") {
      const ids = Array.isArray(body?.ids)
        ? body.ids.filter((id: unknown): id is string => typeof id === "string" && UUID_RE.test(id))
        : [];
      if (ids.length === 0) {
        return jsonResponse({ error: "Missing valid absence ids" }, 400);
      }
      const { error } = await supabaseAdmin.from("att_absences").delete().in("id", ids);
      if (error) return mapDbError(error);
      return jsonResponse({ ok: true, deleted_ids: ids });
    }

    // 6. 設定單項或批次作業補交狀態
    if (action === "set_makeup_status" || action === "batch_set_makeup_status") {
      const rawEntries =
        action === "set_makeup_status"
          ? [
              {
                absence_id: body?.absence_id,
                item_id: body?.item_id,
                status: body?.status,
                note: body?.note,
              },
            ]
          : Array.isArray(body?.entries)
            ? body.entries
            : [];

      const rows = rawEntries
        .map((entry: Record<string, unknown>) => {
          const absenceId = String(entry?.absence_id ?? "");
          const itemId = String(entry?.item_id ?? "");
          const status = String(entry?.status ?? "");
          const note = String(entry?.note ?? "").slice(0, 200);
          if (!UUID_RE.test(absenceId) || !UUID_RE.test(itemId) || !VALID_STATUSES.has(status)) {
            return null;
          }
          return { absence_id: absenceId, item_id: itemId, status, note };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (rows.length === 0) {
        return jsonResponse({ error: "No valid makeup status entries" }, 400);
      }

      const { data, error } = await supabaseAdmin
        .from("att_makeup_records")
        .upsert(rows, { onConflict: "absence_id,item_id" })
        .select("*");

      if (error) return mapDbError(error);
      return jsonResponse({ ok: true, records: data ?? [] });
    }

    // 7. JSON 備份匯入（支援合併或取代）
    if (action === "import_backup") {
      const mode = body?.mode === "replace" ? "replace" : "merge";
      const payload = body?.data ?? {};

      if (mode === "replace") {
        const { error: delM } = await supabaseAdmin
          .from("att_makeup_records")
          .delete()
          .neq("status", "__none__");
        if (delM) return mapDbError(delM);
        const { error: delA } = await supabaseAdmin.from("att_absences").delete().gte("seat", 1);
        if (delA) return mapDbError(delA);
        const { error: delI } = await supabaseAdmin
          .from("att_contact_items")
          .delete()
          .neq("title", "");
        if (delI) return mapDbError(delI);
        const { error: delD } = await supabaseAdmin
          .from("att_contact_days")
          .delete()
          .gte("date", "1900-01-01");
        if (delD) return mapDbError(delD);
      }

      if (payload.settings && typeof payload.settings === "object") {
        const s = payload.settings;
        const maxSeat = isValidSeat(Number(s.max_seat)) ? Number(s.max_seat) : 29;
        const inactive = Array.isArray(s.inactive_seats)
          ? s.inactive_seats.map(Number).filter((n: number) => isValidSeat(n) && n <= maxSeat)
          : [];
        await supabaseAdmin.from("att_settings").upsert(
          {
            id: "default",
            class_name: String(s.class_name ?? "402 班").slice(0, 40) || "402 班",
            max_seat: maxSeat,
            inactive_seats: inactive,
          },
          { onConflict: "id" }
        );
      }

      const days = Array.isArray(payload.contact_days)
        ? payload.contact_days
            .filter((d: Record<string, unknown>) => isValidDateStr(d?.date))
            .map((d: Record<string, unknown>) => ({
              date: String(d.date),
              raw_text: String(d.raw_text ?? ""),
              note: String(d.note ?? ""),
            }))
        : [];
      if (days.length > 0) {
        const { error } = await supabaseAdmin
          .from("att_contact_days")
          .upsert(days, { onConflict: "date" });
        if (error) return mapDbError(error);
      }

      const itemIdMap = new Map<string, string>();
      const validDaySet = new Set(days.map((d) => d.date));
      const items = Array.isArray(payload.contact_items)
        ? payload.contact_items
            .filter((it: Record<string, unknown>) => isValidDateStr(it?.date) && String(it?.title ?? "").trim())
            .map((it: Record<string, unknown>, idx: number) => {
              const oldId = String(it.id ?? "");
              const newId = UUID_RE.test(oldId) ? oldId : crypto.randomUUID();
              if (oldId) itemIdMap.set(oldId, newId);
              const date = String(it.date);
              if (!validDaySet.has(date)) {
                validDaySet.add(date);
                days.push({ date, raw_text: "", note: "" });
              }
              const category = VALID_CATEGORIES.has(String(it.category)) ? String(it.category) : "homework";
              const period = VALID_PERIODS.has(String(it.period)) ? String(it.period) : "all";
              return {
                id: newId,
                date,
                sort_order: Number.isInteger(Number(it.sort_order)) ? Number(it.sort_order) : idx,
                title: String(it.title).trim().slice(0, 200),
                category,
                period,
                requires_makeup: Boolean(it.requires_makeup ?? category !== "notice"),
              };
            })
        : [];

      // Ensure parent contact_days exist for any orphan items
      if (days.length > 0) {
        await supabaseAdmin.from("att_contact_days").upsert(days, { onConflict: "date" });
      }
      if (items.length > 0) {
        const { error } = await supabaseAdmin
          .from("att_contact_items")
          .upsert(items, { onConflict: "id" });
        if (error) return mapDbError(error);
      }

      const absenceIdMap = new Map<string, string>();
      const absences = Array.isArray(payload.absences)
        ? payload.absences
            .filter(
              (a: Record<string, unknown>) =>
                isValidSeat(Number(a?.seat)) &&
                isValidDateStr(a?.date) &&
                VALID_LEAVE_TYPES.has(String(a?.leave_type))
            )
            .map((a: Record<string, unknown>) => {
              const oldId = String(a.id ?? "");
              const newId = UUID_RE.test(oldId) ? oldId : crypto.randomUUID();
              if (oldId) absenceIdMap.set(oldId, newId);
              return {
                id: newId,
                seat: Number(a.seat),
                date: String(a.date),
                leave_type: String(a.leave_type),
                session: VALID_SESSIONS.has(String(a.session)) ? String(a.session) : "full",
                note: String(a.note ?? "").slice(0, 200),
              };
            })
        : [];

      if (absences.length > 0) {
        const { data: upsertedAbs, error } = await supabaseAdmin
          .from("att_absences")
          .upsert(absences, { onConflict: "seat,date" })
          .select("id, seat, date");
        if (error) return mapDbError(error);

        // If seat+date conflicted in merge mode, remap oldId -> actual DB id
        const bySeatDate = new Map(
          (upsertedAbs ?? []).map((r) => [`${r.seat}:${r.date}`, String(r.id)])
        );
        for (const a of absences) {
          const actualId = bySeatDate.get(`${a.seat}:${a.date}`);
          if (actualId) {
            absenceIdMap.set(a.id, actualId);
            for (const [k, v] of absenceIdMap.entries()) {
              if (v === a.id) absenceIdMap.set(k, actualId);
            }
          }
        }
      }

      const validItemIds = new Set(items.map((i) => i.id));
      const validAbsenceIds = new Set(Array.from(absenceIdMap.values()));
      if (mode === "merge") {
        const { data: allItems } = await supabaseAdmin.from("att_contact_items").select("id");
        (allItems ?? []).forEach((r) => validItemIds.add(String(r.id)));
        const { data: allAbs } = await supabaseAdmin.from("att_absences").select("id");
        (allAbs ?? []).forEach((r) => validAbsenceIds.add(String(r.id)));
      }

      const makeups = Array.isArray(payload.makeup_records)
        ? payload.makeup_records
            .map((m: Record<string, unknown>) => {
              const rawAbsId = String(m?.absence_id ?? "");
              const rawItemId = String(m?.item_id ?? "");
              const absenceId = absenceIdMap.get(rawAbsId) ?? rawAbsId;
              const itemId = itemIdMap.get(rawItemId) ?? rawItemId;
              const status = VALID_STATUSES.has(String(m?.status)) ? String(m.status) : "pending";
              if (!validAbsenceIds.has(absenceId) || !validItemIds.has(itemId)) return null;
              return {
                absence_id: absenceId,
                item_id: itemId,
                status,
                note: String(m?.note ?? "").slice(0, 200),
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null)
        : [];

      if (makeups.length > 0) {
        const { error } = await supabaseAdmin
          .from("att_makeup_records")
          .upsert(makeups, { onConflict: "absence_id,item_id" });
        if (error) return mapDbError(error);
      }

      const result = await fetchFullState(supabaseAdmin);
      if ("error" in result && result.error) return mapDbError(result.error);
      return jsonResponse({ ok: true, ...result.state });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Bad request" }, 400);
  }
});
