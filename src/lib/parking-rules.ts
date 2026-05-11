// ─── Rule types ───────────────────────────────────────────────────────────────

export type RuleType =
  | "paid"
  | "free"
  | "permit_only"
  | "accessible"
  | "no_parking"
  | "no_stopping"
  | "street_cleaning"
  | "tow_away";

export type TimeWindow = {
  start: string; // "HH:MM" 24h
  end: string;   // "HH:MM" 24h
};

export type ParkingRule = {
  rule_type: RuleType;
  is_prohibited: boolean;
  days: number[] | null;          // null = all days; 0=Sun 1=Mon … 6=Sat
  time_window: TimeWindow | null; // null = 24/7
  time_limit_minutes: number | null;
  cost_per_hour: number | null;
  permit_zone: string | null;
  tow_away: boolean;
  raw_text: string;
};

export type SpotSchedule = {
  rules: ParkingRule[];
};

export type ExtractedParkingData = {
  rules: ParkingRule[];
  raw_text: string;
  confidence: number;
  // Derived summary kept for backward compat with existing DB columns
  parking_type: "free" | "paid" | "permit" | "accessible" | "unknown";
  time_limit_minutes: number | null;
  cost_per_hour: number | null;
  schedule: string | null;
};

// ─── Status ───────────────────────────────────────────────────────────────────

export type SpotStatus = {
  status: "free" | "paid" | "permit" | "accessible" | "no_parking" | "no_stopping" | "unknown";
  activeRules: ParkingRule[];
  label: string;
  color: string;
};

export const STATUS_COLOR: Record<string, string> = {
  free:        "#15803d",
  paid:        "#ea580c",
  permit:      "#d97706",
  accessible:  "#0284c7",
  no_parking:  "#dc2626",
  no_stopping: "#dc2626",
  unknown:     "#6b7280",
};

export const STATUS_LABEL: Record<string, string> = {
  free:        "Free parking",
  paid:        "Paid parking",
  permit:      "Permit only",
  accessible:  "Accessible only",
  no_parking:  "No parking",
  no_stopping: "No stopping / Tow away",
  unknown:     "Unknown",
};

// ─── Time helpers ─────────────────────────────────────────────────────────────

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

function isRuleActive(rule: ParkingRule, now: Date): boolean {
  const day = now.getDay();
  const minutesNow = now.getHours() * 60 + now.getMinutes();

  if (rule.days !== null && !rule.days.includes(day)) return false;

  if (rule.time_window) {
    const start = timeToMinutes(rule.time_window.start);
    const end = timeToMinutes(rule.time_window.end);
    if (start <= end) {
      if (minutesNow < start || minutesNow >= end) return false;
    } else {
      // Overnight window e.g. 23:00–06:00
      if (minutesNow < start && minutesNow >= end) return false;
    }
  }

  return true;
}

/**
 * Given a set of rules and the current time, returns the effective parking status.
 * Priority: no_stopping > no_parking/street_cleaning > paid > permit > accessible > free.
 * If rules exist but none are active right now, parking is implicitly free.
 */
export function evaluateSpot(rules: ParkingRule[], now: Date = new Date()): SpotStatus {
  const activeRules = rules.filter((r) => isRuleActive(r, now));

  const prohibited = activeRules.filter((r) => r.is_prohibited);

  if (prohibited.some((r) => r.rule_type === "no_stopping" || r.tow_away)) {
    return { status: "no_stopping", activeRules, label: STATUS_LABEL.no_stopping, color: STATUS_COLOR.no_stopping };
  }
  if (prohibited.length > 0) {
    return { status: "no_parking", activeRules, label: STATUS_LABEL.no_parking, color: STATUS_COLOR.no_parking };
  }

  const allowed = activeRules.filter((r) => !r.is_prohibited);
  const paid      = allowed.find((r) => r.rule_type === "paid");
  if (paid)       return { status: "paid",       activeRules, label: STATUS_LABEL.paid,       color: STATUS_COLOR.paid };
  const permit    = allowed.find((r) => r.rule_type === "permit_only");
  if (permit)     return { status: "permit",     activeRules, label: STATUS_LABEL.permit,     color: STATUS_COLOR.permit };
  const accessible = allowed.find((r) => r.rule_type === "accessible");
  if (accessible) return { status: "accessible", activeRules, label: STATUS_LABEL.accessible, color: STATUS_COLOR.accessible };
  const free       = allowed.find((r) => r.rule_type === "free");
  if (free)        return { status: "free",      activeRules, label: STATUS_LABEL.free,       color: STATUS_COLOR.free };

  // Rules exist but none active now → implicitly free outside restricted hours
  if (rules.length > 0) {
    return { status: "free", activeRules: [], label: "Free (outside restricted hours)", color: STATUS_COLOR.free };
  }

  return { status: "unknown", activeRules: [], label: STATUS_LABEL.unknown, color: STATUS_COLOR.unknown };
}

// ─── Display helpers ──────────────────────────────────────────────────────────

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const hour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${hour}${period}` : `${hour}:${String(m).padStart(2, "0")}${period}`;
}

export function formatTimeWindow(tw: TimeWindow): string {
  return `${formatTime(tw.start)}–${formatTime(tw.end)}`;
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDays(days: number[] | null): string {
  if (!days || days.length === 7) return "Every day";
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return "Mon–Fri";
  if (days.length === 6 && [1, 2, 3, 4, 5, 6].every((d) => days.includes(d))) return "Mon–Sat";
  if (days.length === 2 && days.includes(0) && days.includes(6)) return "Sat–Sun";
  if (days.length === 1) return DAY_SHORT[days[0]];
  return days.map((d) => DAY_SHORT[d]).join(", ");
}

export function ruleLabel(rule: ParkingRule): string {
  const parts: string[] = [];

  switch (rule.rule_type) {
    case "no_stopping":     parts.push("No stopping"); break;
    case "no_parking":      parts.push("No parking");  break;
    case "street_cleaning": parts.push("Street cleaning"); break;
    case "tow_away":        parts.push("Tow away"); break;
    case "paid":            parts.push("Paid parking"); break;
    case "permit_only":     parts.push("Permit only"); break;
    case "accessible":      parts.push("Accessible only"); break;
    case "free":            parts.push("Free parking"); break;
  }

  if (rule.tow_away && rule.rule_type !== "tow_away" && rule.rule_type !== "no_stopping") {
    parts.push("(tow-away)");
  }
  if (rule.time_window)         parts.push(formatTimeWindow(rule.time_window));
  if (rule.days)                parts.push(formatDays(rule.days));
  if (rule.time_limit_minutes) {
    const h = Math.floor(rule.time_limit_minutes / 60);
    const m = rule.time_limit_minutes % 60;
    parts.push(`${h > 0 ? `${h}h` : ""}${m > 0 ? `${m}m` : ""} max`);
  }
  if (rule.cost_per_hour)       parts.push(`$${rule.cost_per_hour.toFixed(2)}/hr`);
  if (rule.permit_zone)         parts.push(`Zone ${rule.permit_zone}`);

  return parts.join(" · ");
}

export const RULE_TYPE_COLOR: Record<RuleType, string> = {
  paid:           "#ea580c",
  free:           "#15803d",
  permit_only:    "#d97706",
  accessible:     "#0284c7",
  no_parking:     "#dc2626",
  no_stopping:    "#dc2626",
  street_cleaning:"#0891b2",
  tow_away:       "#dc2626",
};

export const RULE_TYPE_LABEL: Record<RuleType, string> = {
  paid:           "Paid",
  free:           "Free",
  permit_only:    "Permit only",
  accessible:     "Accessible",
  no_parking:     "No parking",
  no_stopping:    "No stopping",
  street_cleaning:"Street cleaning",
  tow_away:       "Tow away",
};

// ─── HRM on-street paid parking default ──────────────────────────────────────
// Halifax on-street metered parking is enforced Mon–Fri 8AM–6PM only.
// Free after 6PM on weekdays, all day weekends, and most holidays.
// Source: HRM parking bylaws + Downtown Halifax Business Commission.
// Applied as a fallback for paid spots that have no explicit schedule in the DB.
export const HALIFAX_DEFAULT_PAID_RULES: ParkingRule[] = [
  {
    rule_type:          "paid",
    is_prohibited:      false,
    days:               [1, 2, 3, 4, 5], // Mon–Fri
    time_window:        { start: "08:00", end: "18:00" },
    time_limit_minutes: null,
    cost_per_hour:      null,
    permit_zone:        null,
    tow_away:           false,
    raw_text:           "Payment required 8AM–6PM Mon–Fri (HRM on-street default)",
  },
];

// ─── Derive legacy parking_type from rules ────────────────────────────────────

export function deriveParkingType(rules: ParkingRule[]): "free" | "paid" | "permit" | "accessible" | "unknown" {
  const types = rules.map((r) => r.rule_type);
  if (types.includes("accessible"))   return "accessible";
  if (types.includes("permit_only"))  return "permit";
  if (types.includes("paid"))         return "paid";
  if (types.length > 0)               return "free"; // restricted at times but free otherwise
  return "unknown";
}

// ─── Haversine distance (metres) ──────────────────────────────────────────────

export function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
