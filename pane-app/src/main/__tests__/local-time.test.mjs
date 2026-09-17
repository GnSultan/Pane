import { describe, it, expect, afterEach } from "vitest";
import {
  getUserTimezone,
  tzOffsetMinutes,
  formatOffsetLabel,
  toLocalDisplay,
  augmentCalendarResult,
  buildTimezoneContextLine,
  tzAbbreviation,
} from "../local-time.mjs";

const ORIGINAL_TZ = process.env.PANE_TZ;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.PANE_TZ;
  else process.env.PANE_TZ = ORIGINAL_TZ;
});

// ── tzOffsetMinutes ──────────────────────────────────────────────────────────

describe("tzOffsetMinutes", () => {
  it("returns +180 for EAT zones regardless of stored suffix", () => {
    // Z suffix and +03:00 suffix must land on the same instant
    expect(tzOffsetMinutes("2026-08-27T03:00:00Z", "Africa/Nairobi")).toBe(180);
    expect(tzOffsetMinutes("2026-08-27T06:00:00+03:00", "Africa/Nairobi")).toBe(180);
    expect(tzOffsetMinutes("2026-01-15T00:00:00Z", "Africa/Dar_es_salaam")).toBe(180);
  });

  it("handles DST correctly — same zone, different instants", () => {
    // Europe/London: +0 in January (GMT), +60 in August (BST)
    expect(tzOffsetMinutes("2026-01-15T12:00:00Z", "Europe/London")).toBe(0);
    expect(tzOffsetMinutes("2026-08-15T12:00:00Z", "Europe/London")).toBe(60);
    // America/New_York: -300 EST winter, -240 EDT summer
    expect(tzOffsetMinutes("2026-01-15T12:00:00Z", "America/New_York")).toBe(-300);
    expect(tzOffsetMinutes("2026-08-15T12:00:00Z", "America/New_York")).toBe(-240);
  });

  it("handles fractional offsets", () => {
    // Asia/Kolkata is UTC+5:30 year-round
    expect(tzOffsetMinutes("2026-08-15T12:00:00Z", "Asia/Kolkata")).toBe(330);
    // Asia/Kathmandu UTC+5:45
    expect(tzOffsetMinutes("2026-08-15T12:00:00Z", "Asia/Kathmandu")).toBe(345);
  });

  it("returns 0 for unparseable input rather than throwing", () => {
    expect(tzOffsetMinutes("not-a-date", "UTC")).toBe(0);
  });
});

// ── formatOffsetLabel ────────────────────────────────────────────────────────

describe("formatOffsetLabel", () => {
  it("labels whole and fractional offsets", () => {
    expect(formatOffsetLabel(180)).toBe("UTC+3");
    expect(formatOffsetLabel(0)).toBe("UTC");
    expect(formatOffsetLabel(-300)).toBe("UTC-5");
    expect(formatOffsetLabel(330)).toBe("UTC+5:30");
    expect(formatOffsetLabel(345)).toBe("UTC+5:45");
  });
});

// ── toLocalDisplay ───────────────────────────────────────────────────────────

describe("toLocalDisplay", () => {
  it("converts a real UTC event timestamp to labeled EAT local time", () => {
    // The exact case from the live bug: event at 03:00Z displayed as 03:00
    // should read 06:00 local (UTC+3).
    expect(toLocalDisplay("2026-08-27T03:00:00Z", "Africa/Dar_es_salaam")).toBe(
      "Thu 27 Aug 2026 06:00 (UTC+3)",
    );
  });

  it("rolls the date forward when conversion crosses midnight", () => {
    // 22:30Z on the 26th → 01:30 on the 27th in UTC+3
    expect(toLocalDisplay("2026-08-26T22:30:00Z", "Africa/Nairobi")).toBe(
      "Thu 27 Aug 2026 01:30 (UTC+3)",
    );
  });

  it("rolls the date backward for negative offsets crossing midnight", () => {
    // 01:30Z on the 27th → 21:30 on the 26th in New York (EDT, UTC-4)
    expect(toLocalDisplay("2026-08-27T01:30:00Z", "America/New_York")).toBe(
      "Wed 26 Aug 2026 21:30 (UTC-4)",
    );
  });

  it("applies DST rules per instant, not a fixed offset", () => {
    const summer = toLocalDisplay("2026-08-15T12:00:00Z", "Europe/London");
    const winter = toLocalDisplay("2026-01-15T12:00:00Z", "Europe/London");
    expect(summer).toContain("(UTC+1)");
    expect(winter).toContain("(UTC)"); // zero offset labels as plain UTC
  });

  it("returns null for unparseable input — never fabricates", () => {
    expect(toLocalDisplay("", "UTC")).toBeNull();
    expect(toLocalDisplay("garbage", "UTC")).toBeNull();
  });
});

// ── tzAbbreviation ───────────────────────────────────────────────────────────

describe("tzAbbreviation", () => {
  it("maps East Africa zones to EAT (Chromium ICU reports GMT+3, not EAT)", () => {
    expect(tzAbbreviation("Africa/Dar_es_salaam", 180)).toBe("EAT");
    expect(tzAbbreviation("Africa/Nairobi", 180)).toBe("EAT");
  });

  it("uses CLDR abbreviations where they exist and aren't GMT+N", () => {
    expect(tzAbbreviation("Europe/London", 60)).toBe("BST");
  });

  it("returns null rather than a redundant GMT+N label", () => {
    // Zones with no CLDR abbreviation get "GMT+X" from ICU — suppress it.
    expect(tzAbbreviation("Africa/Khartoum", 120)).toBeNull();
  });
});

// ── augmentCalendarResult ────────────────────────────────────────────────────

describe("augmentCalendarResult", () => {
  const livePayload = {
    ok: true,
    events: [
      {
        event_id: "0B36D60C",
        title: "First work session",
        calendar_name: "Work",
        start: "2026-08-27T03:00:00Z",
        end: "2026-08-27T07:00:00Z",
        all_day: false,
      },
      {
        event_id: "9701B678",
        title: "Tws",
        calendar_name: "Work",
        start: "2026-08-27T08:00:00Z",
        end: "2026-08-27T10:00:00Z",
        all_day: false,
      },
    ],
    count: 2,
  };

  it("adds labeled *_local fields and preserves raw UTC untouched", () => {
    const result = { success: true, output: JSON.stringify(livePayload) };
    const out = augmentCalendarResult("ext__apple-calendar__calendar_list_events", result, "Africa/Dar_es_salaam");
    const parsed = JSON.parse(out.output);

    expect(parsed.events[0].start_local).toBe("Thu 27 Aug 2026 06:00");
    expect(parsed.events[0].end_local).toBe("Thu 27 Aug 2026 10:00");
    expect(parsed.events[1].start_local).toBe("Thu 27 Aug 2026 11:00");
    // Storage contract: original fields unchanged
    expect(parsed.events[0].start).toBe("2026-08-27T03:00:00Z");
    expect(parsed.events[0].end).toBe("2026-08-27T07:00:00Z");
  });

  it("is a pure augmentation — input result object's output string is not mutated in place", () => {
    const original = JSON.stringify(livePayload);
    const result = { success: true, output: original };
    augmentCalendarResult("ext__apple-calendar__calendar_list_events", result, "Africa/Dar_es_salaam");
    expect(result.output).toBe(original);
  });

  it("passes through non-calendar tools untouched", () => {
    const result = { success: true, output: JSON.stringify({ start: "2026-08-27T03:00:00Z" }) };
    const out = augmentCalendarResult("ext__notion__API-get-page", result, "Africa/Dar_es_salaam");
    expect(out).toBe(result);
  });

  it("passes through failed results and non-JSON outputs untouched", () => {
    const failed = { success: false, error: "boom" };
    expect(augmentCalendarResult("ext__apple-calendar__calendar_list_events", failed)).toBe(failed);
    const texty = { success: true, output: "not json" };
    expect(augmentCalendarResult("ext__apple-calendar__calendar_list_events", texty)).toBe(texty);
  });

  it("ignores payloads without an events array (e.g. calendar_health)", () => {
    const health = { success: true, output: JSON.stringify({ ok: true, server_name: "Apple Calendar" }) };
    expect(augmentCalendarResult("ext__apple-calendar__calendar_health", health)).toBe(health);
  });
});

// ── buildTimezoneContextLine ─────────────────────────────────────────────────

describe("buildTimezoneContextLine", () => {
  it("anchors zone, offset, abbreviation, and the read-local-fields rule", () => {
    process.env.PANE_TZ = "Africa/Nairobi";
    const line = buildTimezoneContextLine();
    expect(line).toContain("Africa/Nairobi");
    expect(line).toContain("UTC+3");
    expect(line).toContain("EAT");
    expect(line).toContain("*_local");
  });

  it("survives an unknown zone without throwing", () => {
    process.env.PANE_TZ = "Mars/Olympus_Mons";
    // Intl throws for invalid zones inside try/catch paths; the line must
    // still come back as a string (offset may fall back oddly, never crash).
    expect(typeof buildTimezoneContextLine()).toBe("string");
  });
});

// ── getUserTimezone ──────────────────────────────────────────────────────────

describe("getUserTimezone", () => {
  it("prefers the explicit PANE_TZ override", () => {
    process.env.PANE_TZ = "Africa/Nairobi";
    expect(getUserTimezone()).toBe("Africa/Nairobi");
  });

  it("falls back to the machine zone when unset", () => {
    delete process.env.PANE_TZ;
    const tz = getUserTimezone();
    expect(tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});
