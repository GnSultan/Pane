/**
 * Local-time augmentation for MCP tool outputs.
 *
 * Root cause this module exists for: the apple-calendar MCP server has no
 * timezone parameter and returns raw UTC ISO strings ("2026-08-27T03:00:00Z").
 * Both display surfaces for calendar data in Pane are conversational (agent
 * chat and voice answers) — the model reads the tool output and either echoes
 * raw UTC or mis-converts it, because it is never told the user's timezone.
 *
 * Fix at the correct layer: augment the tool RESULT (not the prompt, not the
 * stored data) with pre-converted, clearly labeled local times. The model
 * then reads "06:00 (UTC+3)" and speaks it directly — no arithmetic, no
 * ambiguity. Structurally correct beats instructionally encouraged: the
 * wrong answer becomes impossible because the right answer is already in
 * the data.
 *
 * Timezone resolution order:
 *   1. PANE_TZ environment variable (explicit override, used by tests)
 *   2. The machine's IANA zone via Intl.DateTimeFormat().resolvedOptions()
 *   3. "UTC" as a safe fallback (labeled as such)
 *
 * DST is handled correctly by construction: conversion uses
 * Intl.DateTimeFormat with the target timeZone, which applies the zone's
 * rules for the *instant being formatted*, not a fixed offset.
 */

/**
 * The user's IANA timezone identifier (e.g. "Africa/Dar_es_Salaam").
 * Resolved once per process; timezone changes mid-session are not a real
 * scenario for a desktop app on one machine.
 * @returns {string}
 */
export function getUserTimezone() {
  const fromEnv = process.env.PANE_TZ;
  if (fromEnv && typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Offset in minutes of the target timezone AT THE GIVEN INSTANT. Negative
 * means west of UTC (matches Date.getTimezoneOffset semantics inverted —
 * here east is positive, which is the conventional ISO sign).
 * @param {string} iso - ISO timestamp string (with or without Z / offset)
 * @param {string} timeZone - IANA timezone identifier
 * @returns {number} offset in minutes, e.g. 180 for UTC+3
 */
export function tzOffsetMinutes(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 0;
  // Format the same instant in both the target zone and UTC; the wall-clock
  // difference is the offset. This uses the platform tz database via Intl,
  // so DST transitions per-instant are handled exactly.
  let dtf;
  try {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return 0; // invalid zone identifier — UTC-equivalent, labeled UTC
  }
  const parts = dtf.formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

/**
 * Format an offset label like "UTC+3", "UTC-7", "UTC+3:30", or "UTC".
 * @param {number} minutes - offset in minutes, east positive
 * @returns {string}
 */
export function formatOffsetLabel(minutes) {
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/**
 * Convert a UTC (or offset-bearing) ISO string to a human-friendly local
 * string in the user's timezone, clearly labeled, e.g.
 *   "Thu 27 Aug 2026, 06:00 (UTC+3)".
 * Returns null for unparseable input — callers decide whether to keep the
 * raw value visible (never hide data; never fabricate).
 * @param {string} iso
 * @param {string} [timeZone] - defaults to the user's timezone
 * @returns {string | null}
 */
export function toLocalDisplay(iso, timeZone = getUserTimezone()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const offset = tzOffsetMinutes(iso, timeZone);
  let label;
  try {
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    label = dtf.format(date).replace(/,/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    label = date.toISOString().replace("T", " ").slice(0, 16); // invalid zone — UTC fallback
  }
  return `${label} (${formatOffsetLabel(offset)})`;
}

/**
 * SPOKEN-form local time — what voice reads aloud.
 * Same conversion as toLocalDisplay but WITHOUT the offset suffix: people
 * say "eleven a.m.", not "eleven a.m. UTC plus three". Models parrot
 * displayed suffixes verbatim, so the suffix must not appear in the string
 * the model consumes for speech. The zone itself is anchored separately in
 * the session's timezone context line.
 */
export function toSpokenLocal(iso, timeZone = getUserTimezone()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  let label;
  try {
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    label = dtf.format(date).replace(/,/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    label = date.toISOString().replace("T", " ").slice(0, 16);
  }
  return label;
}

/**
 * Augment apple-calendar tool results with local-time display strings.
 * Mutates event objects in place by adding `start_local` / `end_local`
 * fields — original `start` / `end` UTC strings are preserved untouched
 * (storage stays UTC; only display is added).
 *
 * Scope is deliberately narrow: only the apple-calendar server, only its
 * event-listing/detail shapes. Generic timestamp rewriting across every MCP
 * server would be speculative; this is the verified problem surface.
 *
 * @param {string} namespacedName - full tool name, e.g. "ext__apple-calendar__calendar_list_events"
 * @param {{ success: boolean, output?: string, error?: string }} result
 * @returns {{ success: boolean, output?: string, error?: string }} same shape
 */
export function augmentCalendarResult(namespacedName, result, timeZone = getUserTimezone()) {
  if (!result?.success || !result.output) return result;
  if (!namespacedName.startsWith("ext__apple-calendar__")) return result;

  try {
    const parsed = JSON.parse(result.output);
    const events = Array.isArray(parsed) ? parsed : parsed?.events;
    if (!Array.isArray(events)) return result; // not an event payload — leave untouched

    for (const ev of events) {
      if (ev && typeof ev.start === "string") {
        // Spoken form: no offset suffix — voice parrots displayed suffixes
        // ("eleven a.m. UTC plus three"), which is false-feeling to a local
        // user. The offset lives in the session timezone line instead.
        const localStart = toSpokenLocal(ev.start, timeZone);
        if (localStart) ev.start_local = localStart;
      }
    if (ev && typeof ev.end === "string") {
        const localEnd = toSpokenLocal(ev.end, timeZone);
        if (localEnd) ev.end_local = localEnd;
      }
    }

    // Re-serialize deterministically — same field order as before, with the
    // new fields appended right after their UTC siblings via object key
    // insertion order (start, end, then start_local, end_local land after
    // any other fields; acceptable for LLM consumption).
    return { ...result, output: JSON.stringify(parsed, null, 2) };
  } catch {
    // Non-JSON output (or unexpected shape) — pass through unchanged.
    return result;
  }
}

/**
 * One-line timezone context for prompt injection (chat + voice). Example:
 *   "Local timezone: Africa/Dar_es_Salaam (UTC+3, EAT). Current local time: 2026-08-26 17:42 (UTC+3)."
 * The abbreviation (EAT) is derived from a small East-Africa-aware map when
 * the platform reports the generic "GMT+3"; Intl in Chromium's ICU returns
 * "GMT+3" rather than "EAT" for these zones, and a familiar label matters
 * when the model speaks times aloud.
 * @returns {string}
 */
export function buildTimezoneContextLine() {
  const tz = getUserTimezone();
  const now = new Date();
  const offset = tzOffsetMinutes(now.toISOString(), tz);
  const abbr = tzAbbreviation(tz, offset);
  const local = toLocalDisplay(now.toISOString(), tz);
  // Deliberate instruction: the user's zone is context, not a spoken unit.
  // Times themselves come pre-localized in *_local fields (spoken form,
  // no offset suffix) — read and say those directly.
  return `Local timezone: ${tz} (${formatOffsetLabel(offset)}${abbr ? `, ${abbr}` : ""}). Current local time: ${local}. All calendar/event tool results include *_local display fields in this timezone — speak those times as-is, naturally, without appending the timezone or UTC offset. The raw Z-suffixed fields are UTC for storage only.`;
}

const EAST_AFRICA_ABBR = new Map([
  ["africa/dar_es_salaam", "EAT"],
  ["africa/nairobi", "EAT"],
  ["africa/kampala", "EAT"],
  ["africa/addis_ababa", "EAT"],
  ["africa/kigali", "EAT"],
  ["africa/djibouti", "EAT"],
  ["africa/mogadishu", "EAT"],
  ["africa/asmara", "EAT"],
  ["africa/juba", "EAT"],
  ["indian/comoro", "EAT"],
  ["indian/antananarivo", "EAT"],
]);

/**
 * Best-effort familiar abbreviation for the zone. Falls back to null when
 * unknown — callers omit it rather than printing something wrong.
 * @param {string} timeZone
 * @param {number} offsetMinutes
 * @returns {string | null}
 */
export function tzAbbreviation(timeZone, offsetMinutes) {
  const mapped = EAST_AFRICA_ABBR.get(String(timeZone).toLowerCase());
  if (mapped) return mapped;
  let cldr;
  try {
    cldr = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      timeZoneName: "short",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
  } catch {
    return null; // invalid zone identifier — no abbreviation, omit
  }
  // CLDR returns "GMT+3" style for zones without a common abbreviation —
  // that's redundant with the offset label, so suppress it.
  if (cldr && !/^GMT/i.test(cldr)) return cldr;
  return null;
}
