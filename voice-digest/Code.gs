/**
 * Voice Digest
 * ------------
 * iPhone voice notes (saved to a Google Drive folder by a Shortcut)
 *   -> transcribed -> collected -> one evening email digest.
 *
 * Runs entirely inside your own Google account (Drive + Sheets + Gmail).
 * Secrets (API keys) live in Script Properties, never in this code.
 *
 * Safety rules built in:
 *  - A capture is never deleted before it has been emailed (retention only removes
 *    already-digested items older than RETENTION_DAYS).
 *  - Every file is logged once (by Drive file id AND normalised file name), so retries
 *    and sync duplicates do not create duplicate notes.
 *  - A digest is always sent even if the AI summary fails (raw transcripts included).
 *  - The timeline and transcripts are built from YOUR data, not from model output.
 *  - Capture time comes from the file name written by the Shortcut (not upload time).
 */

const CONFIG = {
  TZ_NAME: "Europe/London",           // all times shown in UK local time (DST handled)
  FOLDER_NAME: "VoiceCaptures",       // Drive folder the Shortcut saves into
  SPREADSHEET_NAME: "Voice Digest Log",
  DIGEST_HOUR: 18,                    // evening digest time (24h, UK time)
  DIGEST_NEAR_MINUTE: 30,             // Apps Script only allows 0, 15, 30 or 45
  PROCESS_EVERY_MINUTES: 10,          // allowed: 1, 5, 10, 15, 30
  RETENTION_DAYS: 14,                 // audio + transcripts removed this long after capture
  MAX_ATTEMPTS: 6,                    // transcription retries per recording
  RUN_BUDGET_MS: 4.5 * 60 * 1000,     // stay under Apps Script's 6-minute limit
  TRANSCRIBE_MODEL: "whisper-1",      // OpenAI speech-to-text model
  SUMMARY_PROVIDER: "openai",         // "openai" or "anthropic"
  OPENAI_SUMMARY_MODEL: "gpt-4o",     // check this is a current model name
  ANTHROPIC_SUMMARY_MODEL: "claude-sonnet-5-5",
  AUDIO_RE: /\.(m4a|mp3|wav|aac|caf|mp4|aif|aiff)$/i,
};

const COLS = ["fileId", "fileName", "dupKey", "capturedMs", "capturedSource", "status",
              "attempts", "transcript", "error", "processedMs", "digestedMs"];
// status: new | failed | transcribed | empty

// ------------------------------------------------------------------ UK time (no library needed)
function lastSundayUTC_(year, monthIndex) {
  const d = new Date(Date.UTC(year, monthIndex + 1, 0, 1, 0, 0)); // last day of month, 01:00 UTC
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}
/** UK offset from UTC in minutes: 60 during BST (last Sun Mar 01:00 UTC to last Sun Oct 01:00 UTC), else 0. */
function londonOffsetMin_(ms) {
  const y = new Date(ms).getUTCFullYear();
  return ms >= lastSundayUTC_(y, 2) && ms < lastSundayUTC_(y, 9) ? 60 : 0;
}
const pad2_ = (n) => (n < 10 ? "0" : "") + n;
const DAYS_ = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_ = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function londonParts_(ms) {
  const s = new Date(ms + londonOffsetMin_(ms) * 60000);
  return {
    key: s.getUTCFullYear() + "-" + pad2_(s.getUTCMonth() + 1) + "-" + pad2_(s.getUTCDate()),
    time: pad2_(s.getUTCHours()) + ":" + pad2_(s.getUTCMinutes()),
    label: DAYS_[s.getUTCDay()] + " " + s.getUTCDate() + " " + MONTHS_[s.getUTCMonth()] + " " + s.getUTCFullYear(),
    short: DAYS_[s.getUTCDay()] + " " + s.getUTCDate() + " " + MONTHS_[s.getUTCMonth()],
  };
}
/** Interpret y-m-d h:m:s as UK local wall-clock time and return UTC ms. */
function londonLocalToMs_(y, mo, d, h, mi, s) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  for (const off of [60, 0]) {
    const cand = naive - off * 60000;
    if (londonOffsetMin_(cand) === off) return cand;
  }
  return naive; // non-existent local time (spring-forward gap): treat as GMT
}

/**
 * Capture time from the file name the Shortcut writes, e.g.
 *   capture_2026-11-02_14-05-33_+0000.m4a   (offset optional; if absent we assume UK local time)
 * If there is no timestamp we fall back to the Drive upload time and say so.
 */
function parseCaptureTime_(name, fallbackMs) {
  const m = /(\d{4})-(\d{2})-(\d{2})[_T ](\d{2})[-:.](\d{2})[-:.](\d{2})(?:_?([+-])(\d{2}):?(\d{2}))?/.exec(name);
  if (m) {
    const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
    let ms;
    if (m[7]) {
      const sign = m[7] === "-" ? -1 : 1;
      ms = Date.UTC(y, mo - 1, d, h, mi, s) - sign * (Number(m[8]) * 60 + Number(m[9])) * 60000;
    } else ms = londonLocalToMs_(y, mo, d, h, mi, s);
    if (!isNaN(ms)) return { ms, source: "filename" };
  }
  return { ms: fallbackMs, source: "upload-time" };
}

/** Sync tools may rename duplicates as "name (1).m4a" or "name copy.m4a"; treat them as the same capture. */
function dupKey_(name) {
  return String(name).toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s+copy(\s+\d+)?\s*$/, "")
    .trim();
}

// ------------------------------------------------------------------ properties / sheet access
function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k) { return props_().getProperty(k); }

function sheet_() {
  const id = prop_("SHEET_ID");
  if (!id) throw new Error("Not set up yet: run setup() first.");
  return SpreadsheetApp.openById(id).getSheetByName("captures");
}

function readRows_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, COLS.length).getValues();
  return values.map((v, i) => {
    const o = { _row: i + 2 };
    COLS.forEach((c, j) => { o[c] = v[j]; });
    ["capturedMs", "attempts", "processedMs", "digestedMs"].forEach((k) => {
      o[k] = o[k] === "" || o[k] === null ? "" : Number(o[k]);
    });
    return o;
  });
}

function patchRow_(row, patch) {
  const sh = sheet_();
  Object.keys(patch).forEach((k) => {
    const col = COLS.indexOf(k) + 1;
    if (col > 0) sh.getRange(row._row, col).setValue(patch[k]);
    row[k] = patch[k];
  });
}

function appendRow_(o) {
  sheet_().appendRow(COLS.map((c) => (o[c] === undefined ? "" : o[c])));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { console.log("Another run is in progress; skipping."); return null; }
  try { return fn(); } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------------ 1) pick up + transcribe
function folder_() {
  const id = prop_("FOLDER_ID");
  if (!id) throw new Error("Not set up yet: run setup() first.");
  return DriveApp.getFolderById(id);
}

function registerNewFiles_() {
  const rows = readRows_();
  const ids = {}, keys = {};
  rows.forEach((r) => { ids[r.fileId] = true; keys[r.dupKey] = true; });
  const it = folder_().getFiles();
  let added = 0;
  while (it.hasNext()) {
    const f = it.next();
    const name = f.getName();
    if (!CONFIG.AUDIO_RE.test(name)) continue;
    const id = f.getId();
    if (ids[id]) continue;
    const key = dupKey_(name);
    if (keys[key]) { console.log("Skipping duplicate of already-logged capture: " + name); continue; }
    const t = parseCaptureTime_(name, f.getDateCreated().getTime());
    appendRow_({ fileId: id, fileName: name, dupKey: key, capturedMs: t.ms, capturedSource: t.source,
                 status: "new", attempts: 0, transcript: "", error: "", processedMs: "", digestedMs: "" });
    ids[id] = true; keys[key] = true; added++;
  }
  return added;
}

function transcribe_(blob) {
  const key = prop_("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not set in Script Properties.");
  const res = UrlFetchApp.fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "post",
    headers: { Authorization: "Bearer " + key },
    payload: { file: blob, model: CONFIG.TRANSCRIBE_MODEL, language: "en", response_format: "json" },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error("Transcription HTTP " + code + ": " + String(res.getContentText()).slice(0, 300));
  return String(JSON.parse(res.getContentText()).text || "").trim();
}

function processNewCaptures() {
  return withLock_(() => processNewCapturesLocked_());
}

function processNewCapturesLocked_() {
  const started = Date.now();
  const added = registerNewFiles_();
  let done = 0, failed = 0;
  const todo = readRows_().filter((r) => (r.status === "new" || r.status === "failed") && r.attempts < CONFIG.MAX_ATTEMPTS);
  for (const r of todo) {
    if (Date.now() - started > CONFIG.RUN_BUDGET_MS) break;
    try {
      const blob = DriveApp.getFileById(r.fileId).getBlob();
      let text = transcribe_(blob);
      if (text.length > 45000) text = text.slice(0, 45000) + " [truncated]";
      patchRow_(r, { transcript: text, status: text ? "transcribed" : "empty", error: "",
                     attempts: r.attempts + 1, processedMs: Date.now() });
      done++;
    } catch (e) {
      patchRow_(r, { status: "failed", error: String(e.message || e).slice(0, 500), attempts: r.attempts + 1 });
      failed++;
    }
  }
  return { added, done, failed };
}

// ------------------------------------------------------------------ 2) summarise
const SYSTEM_PROMPT = [
  "You organise one self-employed person's spoken voice notes into a daily digest.",
  "Each note has an id and the time it was RECORDED (recording time, which may differ from when the events happened).",
  "STRICT RULES:",
  "- Use ONLY what is said in the notes. Never invent or guess names, clients, owners, deadlines, amounts, figures, dates or decisions.",
  "- Copy names and numbers exactly as written in the transcript. If a name or number looks unclear, doubtful, or like a mis-hearing, keep it as written and add an entry to \"flags\".",
  "- Distinguish carefully: \"decisions\" = the speaker clearly states something is decided or committed; \"actions\" = things the speaker explicitly said need doing; \"ideas\" = suggestions, thoughts, maybes; \"questions\" = open questions or things to find out. Never turn an idea into an action or decision.",
  "- An action's \"owner\" and \"deadline\" must be null unless explicitly stated in the notes.",
  "- Keep unrelated subjects separate. Group related notes under \"topics\"; every note id must appear in exactly one topic.",
  "- Refer to notes only by their numeric id. Write concise British English.",
  "Return ONLY valid JSON with exactly this shape:",
  "{",
  '  "overview": ["short bullet on main topics", "..."],',
  '  "topics": [{"title": "...", "ids": [1, 2]}],',
  '  "timeline": [{"id": 1, "summary": "one concise sentence"}],',
  '  "actions": [{"text": "...", "ids": [1], "owner": null, "deadline": null}],',
  '  "decisions": [{"text": "...", "ids": [1]}],',
  '  "ideas": [{"text": "...", "ids": [1]}],',
  '  "questions": [{"text": "...", "ids": [1]}],',
  '  "flags": [{"id": 1, "issue": "what is unclear", "quote": "exact words from the transcript"}]',
  "}",
].join("\n");

function buildUserMessage_(items) {
  return "Voice notes (JSON). Times are UK local recording times.\n" +
    JSON.stringify(items.map((i) => ({ id: i.id, recorded: i.date + " " + i.time, text: i.text })));
}

function extractJson_(s) {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Model did not return JSON.");
  return JSON.parse(s.slice(a, b + 1));
}

function callSummaryModel_(items) {
  const user = buildUserMessage_(items);
  if (CONFIG.SUMMARY_PROVIDER === "anthropic") {
    const key = prop_("ANTHROPIC_API_KEY");
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
    const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post", contentType: "application/json", muteHttpExceptions: true,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      payload: JSON.stringify({ model: CONFIG.ANTHROPIC_SUMMARY_MODEL, max_tokens: 4096, temperature: 0,
                                system: SYSTEM_PROMPT, messages: [{ role: "user", content: user }] }),
    });
    if (res.getResponseCode() !== 200) throw new Error("Summary HTTP " + res.getResponseCode() + ": " + String(res.getContentText()).slice(0, 300));
    const body = JSON.parse(res.getContentText());
    return extractJson_(body.content.map((c) => c.text || "").join(""));
  }
  const key = prop_("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  const res = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + key },
    payload: JSON.stringify({ model: CONFIG.OPENAI_SUMMARY_MODEL, temperature: 0,
                              response_format: { type: "json_object" },
                              messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }] }),
  });
  if (res.getResponseCode() !== 200) throw new Error("Summary HTTP " + res.getResponseCode() + ": " + String(res.getContentText()).slice(0, 300));
  return extractJson_(JSON.parse(res.getContentText()).choices[0].message.content);
}

const str_ = (v) => (typeof v === "string" ? v.trim() : "");
function numbersIn_(s) { return (String(s).match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, "")); }

/** Which numbers in `text` do not appear in the cited transcripts? */
function missingNumbers_(text, ids, byId, allText) {
  const hay = (ids && ids.length ? ids.map((i) => (byId[i] ? byId[i].text : "")).join(" ") : allText).replace(/,/g, "");
  return numbersIn_(text).filter((n) => hay.indexOf(n) === -1);
}

/** Make model output safe: valid ids only, strings only, numbers cross-checked against transcripts. */
function validateSummary_(raw, items) {
  const byId = {};
  items.forEach((i) => { byId[i.id] = i; });
  const allText = items.map((i) => i.text).join(" ");
  const okIds = (arr) => (Array.isArray(arr) ? arr : []).map(Number).filter((n) => byId[n]);
  const list = (arr) => (Array.isArray(arr) ? arr : []);
  const withRefs = (arr) => list(arr).map((x) => {
    const ids = okIds(x && x.ids);
    const text = str_(x && x.text);
    let owner = str_(x && x.owner) || null, deadline = str_(x && x.deadline) || null;
    // Owners and deadlines are only kept if the speaker actually said them in the cited notes.
    const hay = (ids.length ? ids.map((i) => byId[i].text).join(" ") : allText).toLowerCase();
    let removed = false;
    if (owner && hay.indexOf(owner.toLowerCase()) === -1) { owner = null; removed = true; }
    if (deadline && hay.indexOf(deadline.toLowerCase()) === -1) { deadline = null; removed = true; }
    const miss = missingNumbers_(text, ids, byId, allText);
    return { text, ids, owner, deadline, warn: miss, removed };
  }).filter((x) => x.text);

  const timelineMap = {};
  list(raw && raw.timeline).forEach((t) => {
    const id = Number(t && t.id);
    if (byId[id] && !timelineMap[id]) {
      const summary = str_(t.summary);
      timelineMap[id] = { summary, warn: missingNumbers_(summary, [id], byId, allText) };
    }
  });

  const seen = {};
  const topics = list(raw && raw.topics).map((t) => {
    const ids = okIds(t && t.ids).filter((i) => !seen[i] && (seen[i] = true));
    return { title: str_(t && t.title), ids };
  }).filter((t) => t.title && t.ids.length);
  const ungrouped = items.filter((i) => !seen[i.id]).map((i) => i.id);
  if (ungrouped.length) topics.push({ title: "Other notes", ids: ungrouped });

  return {
    overview: list(raw && raw.overview).map(str_).filter(Boolean),
    topics,
    timelineMap,
    actions: withRefs(raw && raw.actions),
    decisions: withRefs(raw && raw.decisions),
    ideas: withRefs(raw && raw.ideas),
    questions: withRefs(raw && raw.questions),
    flags: list(raw && raw.flags).map((f) => ({ id: Number(f && f.id), issue: str_(f && f.issue), quote: str_(f && f.quote) }))
      .filter((f) => byId[f.id] && f.issue),
  };
}

// ------------------------------------------------------------------ 3) render email
const esc_ = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function makeItems_(rows, digestDayKey) {
  return rows.map((r, idx) => {
    const p = londonParts_(r.capturedMs);
    return {
      id: idx + 1, fileId: r.fileId, ms: r.capturedMs, date: p.key, time: p.time,
      when: p.key === digestDayKey ? p.time : p.short + " " + p.time,
      text: r.status === "empty" ? "" : String(r.transcript || ""),
      empty: r.status === "empty", source: r.capturedSource,
    };
  });
}

function renderDigest_(items, summary, meta) {
  const byId = {};
  items.forEach((i) => { byId[i.id] = i; });
  const refs = (ids) => (ids && ids.length ? " [" + ids.map((i) => byId[i].when).join(", ") + "]" : "");
  const warnTxt = (w) => (w && w.length ? " ⚠ number(s) " + w.join(", ") + " not found in the transcript" : "");
  const H = [], T = [];
  const h2 = (t) => { H.push('<h2 style="font-size:16px;margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px">' + esc_(t) + "</h2>"); T.push("\n== " + t.toUpperCase() + " =="); };
  const bullet = (html, text) => { H.push('<div style="margin:3px 0 3px 12px">• ' + html + "</div>"); T.push("• " + text); };

  const subject = "Voice digest – " + meta.dayLabel + " (" + items.length + (items.length === 1 ? " note" : " notes") + ")";
  H.push('<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45;color:#111;max-width:680px">');
  H.push('<h1 style="font-size:20px;margin:0 0 4px">Daily voice digest</h1><div style="color:#666">' + esc_(meta.dayLabel) + " · " + items.length + " note" + (items.length === 1 ? "" : "s") + "</div>");
  T.push("DAILY VOICE DIGEST – " + meta.dayLabel + " (" + items.length + " notes)");

  if (meta.summaryError) {
    H.push('<div style="background:#fff4e5;border:1px solid #f2b661;padding:8px 10px;margin:12px 0;border-radius:6px">⚠ The AI summary could not be produced (' + esc_(meta.summaryError) + "). Your timeline and original transcripts are below, unsummarised.</div>");
    T.push("\n⚠ AI summary unavailable (" + meta.summaryError + "). Transcripts below.");
  }
  if (meta.pending > 0) {
    H.push('<div style="background:#eef5ff;border:1px solid #9cc2ff;padding:8px 10px;margin:12px 0;border-radius:6px">' + meta.pending + " recording" + (meta.pending === 1 ? " is" : "s are") + " still waiting to be transcribed and will appear in the next digest.</div>");
    T.push("\n" + meta.pending + " recording(s) still waiting to be transcribed; they will appear in the next digest.");
  }

  if (summary) {
    h2("Daily overview");
    if (summary.overview.length) summary.overview.forEach((o) => bullet(esc_(o), o)); else bullet("No overview produced.", "No overview produced.");
    if (summary.topics.length > 1) {
      h2("By subject");
      summary.topics.forEach((t) => bullet("<b>" + esc_(t.title) + "</b>" + esc_(refs(t.ids)), t.title + refs(t.ids)));
    }
  }

  h2("Timeline");
  items.forEach((i) => {
    const tl = summary && summary.timelineMap[i.id];
    let line;
    if (i.empty) line = "(no speech detected in this recording)";
    else if (tl && tl.summary) line = tl.summary + warnTxt(tl.warn);
    else line = (summary ? "(not summarised) " : "") + (i.text.length > 180 ? i.text.slice(0, 180) + "…" : i.text);
    bullet("<b>" + esc_(i.when) + "</b> — " + esc_(line), i.when + " — " + line);
  });

  if (summary) {
    const sect = (title, arr, none, extra) => {
      h2(title);
      if (!arr.length) { bullet('<span style="color:#888">' + esc_(none) + "</span>", none); return; }
      arr.forEach((a) => {
        const more = (extra ? extra(a) : "") + (a.removed ? " (owner/deadline not stated by you, so left blank)" : "");
        bullet(esc_(a.text + more + refs(a.ids) + warnTxt(a.warn)), a.text + more + refs(a.ids) + warnTxt(a.warn));
      });
    };
    sect("Actions and follow-ups", summary.actions, "Nothing explicitly marked as an action.",
      (a) => (a.owner ? " (owner: " + a.owner + ")" : "") + (a.deadline ? " (deadline: " + a.deadline + ")" : ""));
    sect("Decisions and commitments", summary.decisions, "No clear decisions stated.");
    sect("Ideas", summary.ideas, "No ideas captured.");
    sect("Questions", summary.questions, "No open questions.");
    if (summary.flags.length) {
      h2("Please check (unclear wording, names or numbers)");
      summary.flags.forEach((f) => bullet(esc_("[" + byId[f.id].when + "] " + f.issue + (f.quote ? ' — "' + f.quote + '"' : "")), "[" + byId[f.id].when + "] " + f.issue + (f.quote ? ' — "' + f.quote + '"' : "")));
    }
  }

  h2("Original transcripts");
  items.forEach((i) => {
    const src = i.source === "upload-time" ? " (capture time unknown: showing upload time)" : "";
    const body = i.empty ? "(no speech detected)" : i.text;
    H.push('<div style="margin:10px 0"><b>' + esc_(i.when) + "</b>" + esc_(src) + '<div style="white-space:pre-wrap;color:#333">' + esc_(body) + "</div></div>");
    T.push("\n[" + i.when + "]" + src + "\n" + body);
  });
  H.push('<div style="color:#888;font-size:12px;margin-top:20px">Times are when each note was recorded (UK time). Summaries are machine-generated: check names and numbers against the transcripts.</div></div>');
  return { subject, html: H.join("\n"), text: T.join("\n") };
}

// ------------------------------------------------------------------ 4) digest
function scheduledDigest() { return sendDigest_({ manual: false }); }
function runDigestNow() { return sendDigest_({ manual: true }); } // "Summarise now"

function sendDigest_(opts) {
  return withLock_(() => {
    processNewCapturesLocked_(); // pick up anything just uploaded
    const all = readRows_();
    const rows = all.filter((r) => (r.status === "transcribed" || r.status === "empty") && r.digestedMs === "")
      .sort((a, b) => a.capturedMs - b.capturedMs);
    const pending = all.filter((r) => (r.status === "new" || r.status === "failed") && r.digestedMs === "").length;
    if (!rows.length) return "No new notes to send." + (pending ? " (" + pending + " still waiting for transcription)" : "");

    const nowMs = Date.now();
    const dayKey = londonParts_(nowMs).key;
    const items = makeItems_(rows, dayKey);
    const textItems = items.filter((i) => !i.empty);
    let summary = null, summaryError = "";
    if (textItems.length) {
      try { summary = validateSummary_(callSummaryModel_(textItems), textItems); }
      catch (e) { summaryError = String(e.message || e).slice(0, 200); summary = null; }
    }
    const meta = { dayLabel: londonParts_(nowMs).label, summaryError, pending };
    const mail = renderDigest_(items, summary, meta);
    const to = prop_("RECIPIENT") || Session.getEffectiveUser().getEmail();
    GmailApp.sendEmail(to, mail.subject, mail.text, { htmlBody: mail.html, name: "Voice Digest" }); // throws => nothing marked as sent
    rows.forEach((r) => patchRow_(r, { digestedMs: nowMs }));
    return "Digest sent to " + to + " (" + items.length + " notes).";
  });
}

// ------------------------------------------------------------------ 5) retention
function cleanup() {
  return withLock_(() => {
    const cutoff = Date.now() - CONFIG.RETENTION_DAYS * 86400000;
    const rows = readRows_();
    const doomed = rows.filter((r) => r.digestedMs !== "" && r.capturedMs < cutoff);
    doomed.forEach((r) => { try { DriveApp.getFileById(r.fileId).setTrashed(true); } catch (e) { /* already gone */ } });
    doomed.map((r) => r._row).sort((a, b) => b - a).forEach((n) => sheet_().deleteRow(n));
    return doomed.length;
  });
}

// ------------------------------------------------------------------ optional "Summarise now" web endpoint
function doGet(e) {
  const token = prop_("WEBHOOK_TOKEN");
  if (!token || !e || !e.parameter || e.parameter.token !== token) return ContentService.createTextOutput("Unauthorized");
  return ContentService.createTextOutput(String(runDigestNow()));
}

// ------------------------------------------------------------------ setup helpers
function setup() {
  const p = props_();
  let folder;
  if (p.getProperty("FOLDER_ID")) folder = DriveApp.getFolderById(p.getProperty("FOLDER_ID"));
  else {
    const it = DriveApp.getFoldersByName(CONFIG.FOLDER_NAME);
    folder = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.FOLDER_NAME);
    p.setProperty("FOLDER_ID", folder.getId());
  }
  if (!p.getProperty("SHEET_ID")) {
    const ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
    const sh = ss.getSheets()[0];
    sh.setName("captures");
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]);
    sh.setFrozenRows(1);
    ["B", "C", "H", "I"].forEach((c) => sh.getRange(c + ":" + c).setNumberFormat("@")); // plain text columns
    p.setProperty("SHEET_ID", ss.getId());
  }
  if (!p.getProperty("RECIPIENT")) p.setProperty("RECIPIENT", Session.getEffectiveUser().getEmail());
  if (!p.getProperty("WEBHOOK_TOKEN")) p.setProperty("WEBHOOK_TOKEN", Utilities.getUuid() + Utilities.getUuid());

  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("processNewCaptures").timeBased().everyMinutes(CONFIG.PROCESS_EVERY_MINUTES).create();
  ScriptApp.newTrigger("scheduledDigest").timeBased().atHour(CONFIG.DIGEST_HOUR).nearMinute(CONFIG.DIGEST_NEAR_MINUTE).everyDays(1).create();
  ScriptApp.newTrigger("cleanup").timeBased().atHour(3).everyDays(1).create();
  console.log("Folder: " + folder.getUrl());
  console.log("Add OPENAI_API_KEY in Project Settings > Script properties, then run checkSetup().");
  return checkSetup();
}

function checkSetup() {
  const problems = [];
  if (!prop_("FOLDER_ID") || !prop_("SHEET_ID")) problems.push("Run setup().");
  if (!prop_("OPENAI_API_KEY")) problems.push("Missing script property OPENAI_API_KEY (needed for transcription).");
  if (CONFIG.SUMMARY_PROVIDER === "anthropic" && !prop_("ANTHROPIC_API_KEY")) problems.push("Missing script property ANTHROPIC_API_KEY.");
  const msg = problems.length ? "PROBLEMS:\n- " + problems.join("\n- ") : "Setup looks good. Recipient: " + prop_("RECIPIENT");
  console.log(msg);
  return msg;
}

if (typeof module !== "undefined") {
  module.exports = { parseCaptureTime_, londonOffsetMin_, londonParts_, londonLocalToMs_, dupKey_, validateSummary_,
    renderDigest_, makeItems_, processNewCaptures, sendDigest_, cleanup, scheduledDigest, doGet, setup, checkSetup, CONFIG, COLS, SYSTEM_PROMPT };
}
