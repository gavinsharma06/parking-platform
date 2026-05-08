/**
 * Batch OCR test script — runs Google Vision on every image in a folder
 * and prints what the parser would extract from each sign.
 *
 * Usage:
 *   node scripts/run-ocr-batch.js <folder>
 *   node scripts/run-ocr-batch.js C:\Users\seema\Downloads\parkingsign
 *
 * Requires GOOGLE_VISION_API_KEY in .env (loaded automatically).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Load .env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const API_KEY = process.env.GOOGLE_VISION_API_KEY ?? process.env.NEXT_PUBLIC_VISION_API_KEY;
if (!API_KEY) {
  console.error("❌  GOOGLE_VISION_API_KEY not set in .env");
  process.exit(1);
}

const folder = process.argv[2];
if (!folder) {
  console.error("Usage: node scripts/run-ocr-batch.js <image-folder>");
  process.exit(1);
}

const IMAGE_EXTS = /\.(jpe?g|png|webp|bmp)$/i;

async function visionOcr(base64) {
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ image: { content: base64 }, features: [{ type: "TEXT_DETECTION", maxResults: 1 }] }],
      }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  const ann = data.responses?.[0];
  if (ann?.error) throw new Error(ann.error.message);
  return ann?.textAnnotations?.[0]?.description ?? "";
}

// ── Inline parser (mirrors src/app/api/analyse-sign/route.ts) ────────────────

const DAY_MAP = { SUN:0,SUNDAY:0,MON:1,MONDAY:1,TUE:2,TUESDAY:2,TUES:2,WED:3,WEDNESDAY:3,THU:4,THURSDAY:4,THURS:4,FRI:5,FRIDAY:5,SAT:6,SATURDAY:6 };
const RANGE_RE = /\b(SUN|MON|TUE|TUES|WED|THU|THURS|FRI|SAT|SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\s*[-–]\s*(SUN|MON|TUE|TUES|WED|THU|THURS|FRI|SAT|SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\b/gi;
const DAY_RE  = /\b(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\b/gi;

function parseDays(text) {
  // Normalize "IMON-FRI" → "MON-FRI" (Vision OCR artifact: misread pipe/l before day names)
  const u = text.toUpperCase()
    .replace(/\bI(MON|TUE|TUES|WED|THU|THURS|FRI|SAT|SUN|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\b/g, "$1");
  const days = new Set();
  for (const m of u.matchAll(RANGE_RE)) {
    const a = DAY_MAP[m[1]], b = DAY_MAP[m[2]];
    if (a !== undefined && b !== undefined) {
      if (a <= b) { for (let d=a;d<=b;d++) days.add(d); }
      else { for (let d=a;d<=6;d++) days.add(d); for (let d=0;d<=b;d++) days.add(d); }
    }
  }
  if (days.size===0) for (const m of u.matchAll(DAY_RE)) { const n=DAY_MAP[m[1]]; if(n!==undefined) days.add(n); }
  return days.size>0 ? [...days].sort((a,b)=>a-b) : null;
}

function parseTime(raw) {
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let h=parseInt(m[1]); const min=m[2]?parseInt(m[2]):0;
  if (m[3].toUpperCase()==="AM"){if(h===12)h=0;} else {if(h!==12)h+=12;}
  return `${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}`;
}

function parseTimeWindow(text) {
  const T = /\d{1,2}(?::\d{2})?\s*(?:AM|PM)/i.source;
  const pm = new RegExp(`(${T})\\s*[-–]\\s*(${T})`, "i").exec(text);
  const fm = new RegExp(`(${T})\\s+(${T})`, "i").exec(text);
  // Pick whichever match starts earliest in the text
  const m = !pm&&!fm ? null : !pm ? fm : !fm ? pm : pm.index<=fm.index ? pm : fm;
  if (!m) return null;
  const s=parseTime(m[1].replace(/\s/g,"")), e=parseTime(m[2].replace(/\s/g,""));
  return (s&&e) ? {start:s,end:e} : null;
}

function classifySegment(text) {
  const u = text.toUpperCase();
  if (/\bNO\s+STOPPING\b|\bNO\s+STANDING\b/.test(u)) return {type:"no_stopping",prohibited:true,tow:/TOW/.test(u)};
  if (/\bSTREET\s+CLEANING\b/.test(u)) return {type:"street_cleaning",prohibited:true,tow:false};
  if (/\bTOW[\s-]+AWAY\b/.test(u)) return {type:"no_stopping",prohibited:true,tow:true};
  if (/\bNO\s+PARKING\b/.test(u)) return {type:"no_parking",prohibited:true,tow:/TOW/.test(u)};
  if (/\bACCESSIBLE/.test(u)) return {type:"accessible",prohibited:false,tow:false};
  if (/\bEXCEPT\s+BY\s+PERMIT\b|\bPERMIT\s+(?:ONLY|PARKING)\b/.test(u)) return {type:"permit_only",prohibited:false,tow:false};
  if (/\bPAYMENT\s+REQUIRED\b|\bPAY\s+(?:ZONE|STATION)\b/.test(u)) return {type:"paid",prohibited:false,tow:false};
  if (/\bFREE\s+PARKING\b/.test(u)) return {type:"free",prohibited:false,tow:false};
  if (/\$|\bPER\s+H/.test(u)) return {type:"paid",prohibited:false,tow:false};
  if (/\b\d+\s*(?:HOUR|HR|MIN)\b/.test(u)) return {type:"free",prohibited:false,tow:false};
  return null;
}

const ANCHORS = [/\bNO\s+STOPPING\b/i,/\bNO\s+STANDING\b/i,/\bNO\s+PARKING\b/i,/\bPAYMENT\s+REQUIRED\b/i,/\bPAY\s+(?:ZONE|STATION)\b/i,/\bACCESSIBLE\s+PARKING\b/i,/\bEXCEPT\s+BY\s+PERMIT\b/i,/\bPERMIT\s+(?:ONLY|PARKING)\b/i,/\bSTREET\s+CLEANING\b/i,/\bTOW[\s-]+AWAY\b/i,/\bFREE\s+PARKING\b/i];

const TIME_ONLY_RE  = /\d{1,2}(?::\d{2})?\s*(?:AM|PM)/i;
const DAY_ABBREVS   = "SUN|MON|TUE|TUES|WED|THU|THURS|FRI|SAT|SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY";
const DAY_ONLY_RE   = new RegExp(`^(?:(?:${DAY_ABBREVS})[\\s,–-]*)+$`, "i");
const NOISE_LINE_RE = /^P$|^[^A-Za-z0-9]+$/;

function normalizeRaw(raw) {
  return raw
    .replace(/\bTOW\s*\n\s*AWAY/gi,        "TOW AWAY")
    .replace(/\bPAY\s*\n\s*ZONE/gi,         "PAY ZONE")
    .replace(/\bNO\s*\n\s*PARKING/gi,       "NO PARKING")
    .replace(/\bNO\s*\n\s*STOPPING/gi,      "NO STOPPING")
    .replace(/\bNO\s*\n\s*STANDING/gi,      "NO STANDING")
    .replace(/\bSTREET\s*\n\s*CLEANING/gi,  "STREET CLEANING")
    .replace(/\bPAYMENT\s*\n\s*REQUIRED/gi, "PAYMENT REQUIRED")
    .replace(/\bFREE\s*\n\s*PARKING/gi,     "FREE PARKING");
}

function parseTimeLimit(text) {
  const hourM = text.match(/(?<!\d)(\d+(?:\.\d+)?)\s*H(?:OUR|R)S?\b(?!\s*[-–]\s*\d)/i);
  const minM  = text.match(/(\d+)\s*MIN(?:UTE)?S?\b/i);
  if (hourM) return Math.round(parseFloat(hourM[1]) * 60);
  if (minM)  return parseInt(minM[1], 10);
  return null;
}

function deduplicateRules(rules) {
  const result = [];
  for (const rule of rules) {
    const isBare = !rule.time_window && !rule.days && rule.cost_per_hour == null && rule.time_limit_minutes == null && !rule.permit_zone;
    if (isBare && result.some(r => r.type === rule.type)) continue;
    result.push(rule);
  }
  return result;
}

function parseText(raw) {
  const lines = normalizeRaw(raw).split(/\n+/).map(l=>l.trim()).filter(l=>l.length>0&&!NOISE_LINE_RE.test(l));
  const segs = []; let cur = []; let pending = [];
  for (const line of lines) {
    const isAnchor = ANCHORS.some(re=>re.test(line));
    if (isAnchor) {
      if (cur.length>0) { segs.push([...pending,...cur].join(" ")); pending=[]; }
      cur = [line];
    } else if (cur.length===0 && (TIME_ONLY_RE.test(line) || DAY_ONLY_RE.test(line))) {
      pending.push(line);
    } else {
      cur.push(line);
    }
  }
  if (cur.length>0) segs.push([...pending,...cur].join(" "));
  else if (pending.length>0) segs.push(pending.join(" "));
  const rules = [];
  for (const seg of segs) {
    const cls = classifySegment(seg);
    if (!cls) continue;
    rules.push({
      type: cls.type, prohibited: cls.prohibited, tow_away: cls.tow,
      days: parseDays(seg), time_window: parseTimeWindow(seg),
      time_limit_minutes: parseTimeLimit(seg),
    });
  }
  return deduplicateRules(rules);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const files = fs.readdirSync(folder).filter(f => IMAGE_EXTS.test(f)).sort();
if (files.length === 0) {
  console.log(`No images found in ${folder}`);
  process.exit(0);
}

console.log(`\nRunning OCR on ${files.length} image(s) in ${folder}\n${"─".repeat(60)}`);

for (const file of files) {
  const imgPath = path.join(folder, file);
  process.stdout.write(`\n📷  ${file}\n`);

  try {
    const base64 = fs.readFileSync(imgPath).toString("base64");
    const rawText = await visionOcr(base64);

    if (!rawText.trim()) {
      console.log("   (no text detected)");
      continue;
    }

    console.log("   Raw OCR text:");
    for (const line of rawText.split("\n").slice(0, 20)) {
      console.log(`     ${line}`);
    }

    const rules = parseText(rawText);
    if (rules.length === 0) {
      console.log("   ⚠️  Parser: no rules extracted");
    } else {
      console.log(`\n   ✅  Parser extracted ${rules.length} rule(s):`);
      const DAY_SHORT = ["Su","Mo","Tu","We","Th","Fr","Sa"];
      for (const r of rules) {
        const dayStr   = r.days ? r.days.map(d=>DAY_SHORT[d]).join(",") : "all days";
        const twStr    = r.time_window ? `${r.time_window.start}–${r.time_window.end}` : "24/7";
        const limitStr = r.time_limit_minutes ? ` | ${r.time_limit_minutes}min limit` : "";
        console.log(`      • ${r.type}${r.prohibited?" [PROHIBITED]":""}${r.tow_away?" [TOW-AWAY]":""} | ${twStr} | ${dayStr}${limitStr}`);
      }
    }
  } catch (e) {
    console.log(`   ❌  Error: ${e.message}`);
  }
}

console.log(`\n${"─".repeat(60)}\nDone.\n`);
