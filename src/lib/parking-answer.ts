import { evaluateSpot, formatTime, localClock, timeToMinutes } from "./parking-rules";
import type { LocalClock, ParkingRule } from "./parking-rules";

// ─── Plain-language "Can I park here?" answer ─────────────────────────────────

export type ParkingAnswer = {
  answer: string;
  can_park: boolean | null;
};

function formatLimit(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h > 0 ? `${h}h` : ""}${m > 0 ? ` ${m}m` : ""}`.trim();
}

/**
 * Start time ("HH:MM") of the next restriction that begins later today, or null.
 * permit_only counts as a restriction so the answer can warn "free now, permit
 * zone starts at 8AM" even though permit_only is not is_prohibited.
 */
export function nextRestrictionStart(rules: ParkingRule[], clock: LocalClock): string | null {
  let next: string | null = null;

  for (const rule of rules) {
    const isRestriction = rule.is_prohibited || rule.rule_type === "permit_only";
    if (!isRestriction || !rule.time_window) continue;
    if (rule.days !== null && !rule.days.includes(clock.day)) continue;

    const start = timeToMinutes(rule.time_window.start);
    if (start > clock.minutes && (next === null || start < timeToMinutes(next))) {
      next = rule.time_window.start;
    }
  }

  return next;
}

/**
 * Turns a sign's rules into a yes/no answer for the instant `now`.
 * `now` is evaluated in the parking timezone, not the host's.
 */
export function generateAnswer(rules: ParkingRule[], now: Date = new Date()): ParkingAnswer {
  const status = evaluateSpot(rules, now);
  const nextRestrictionAt = nextRestrictionStart(rules, localClock(now));

  switch (status.status) {
    case "no_stopping":
      return { answer: "No — tow-away zone in effect. Do not stop here.", can_park: false };

    case "no_parking": {
      // If ALL active prohibited rules are directional (left/right only, not both/null),
      // the other side may be free — give a directional answer instead of a blanket "no".
      const activeProhibited = status.activeRules.filter((r) => r.is_prohibited);
      const allDirectional =
        activeProhibited.length > 0 &&
        activeProhibited.every((r) => r.direction === "left" || r.direction === "right");

      if (allDirectional) {
        const leftBlocked  = activeProhibited.some((r) => r.direction === "left");
        const rightBlocked = activeProhibited.some((r) => r.direction === "right");
        if (leftBlocked && !rightBlocked) {
          const cleaningNote = nextRestrictionAt ? ` Street cleaning starts at ${formatTime(nextRestrictionAt)}.` : "";
          return { answer: `No parking ← left (always). The right side is free to park right now.${cleaningNote}`, can_park: true };
        }
        if (rightBlocked && !leftBlocked) {
          const cleaningNote = nextRestrictionAt ? ` Street cleaning starts at ${formatTime(nextRestrictionAt)}.` : "";
          return { answer: `No parking → right (always). The left side is free to park right now.${cleaningNote}`, can_park: true };
        }
      }

      const active = status.activeRules.find((r) => r.is_prohibited && r.time_window);
      if (active?.time_window) {
        return {
          answer: `No — no parking right now. Restriction lifts at ${formatTime(active.time_window.end)}.`,
          can_park: false,
        };
      }
      return { answer: "No — no parking allowed here.", can_park: false };
    }

    case "paid": {
      const paid = status.activeRules.find((r) => r.rule_type === "paid");
      const limit = paid?.time_limit_minutes;
      const end = paid?.time_window?.end;
      let answer = "Yes — paid parking.";
      if (limit) answer = `Yes — paid parking, ${formatLimit(limit)} maximum.`;
      if (end) answer += ` Meters enforced until ${formatTime(end)}.`;
      return { answer, can_park: true };
    }

    case "permit":
      return { answer: "No — permit zone. A residential parking permit is required.", can_park: false };

    case "accessible":
      return { answer: "No — accessible parking only. A valid accessibility permit is required.", can_park: false };

    case "free": {
      const limitRule = rules.find((r) => r.time_limit_minutes && !r.is_prohibited);
      const timeLimit = limitRule?.time_limit_minutes;
      let answer = "Yes — free to park here.";
      if (timeLimit) answer = `Yes — free parking, ${formatLimit(timeLimit)} maximum.`;
      if (nextRestrictionAt) answer += ` Restrictions begin at ${formatTime(nextRestrictionAt)}.`;
      return { answer, can_park: true };
    }

    default:
      return {
        answer: "Unable to read this sign clearly. Please check the posted sign directly.",
        can_park: null,
      };
  }
}
