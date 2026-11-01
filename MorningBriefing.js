// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-gray; icon-glyph: sun;

/*
 * Morning Briefing for Scriptable (iPhone)
 * ----------------------------------------
 * Two connected views in one widget:
 *   1. MORNING ROUTINE - three activities + progress, until done/skipped or the morning cutoff.
 *   2. MY DAY          - next/current appointment, upcoming, due reminders, all-day + overnight.
 *
 * Everything runs on the phone. Nothing is sent anywhere. Calendar events and
 * reminders are only READ. Routine progress + gratitude live in this script's own
 * JSON files in Scriptable's documents directory:
 *   morning-briefing-settings.json, morning-briefing-data.json
 *
 * Run the script inside Scriptable for setup, the routine, settings and past gratitude.
 * Add it as a Medium or Large Scriptable widget (Large recommended).
 * Widget Parameter (optional): "day" = always My Day, "routine" = always the routine,
 * empty = automatic. Lock Screen widgets also accept "reminders".
 */

const TEST = typeof globalThis.__MB_TEST__ !== "undefined";

// ---------------------------------------------------------------- constants
const C = {
  bg1: new Color("#0D1015"),
  bg2: new Color("#181C23"),
  card: new Color("#1D222B"),
  line: new Color("#2B313C"),
  text: new Color("#EEF1F5"),
  dim: new Color("#8C95A4"),
  blue: new Color("#3D9BFF"),
  amber: new Color("#F2B661"),
  tile: new Color("#15253D"),
};

const ACTIVITIES = [
  { id: "breathe", symbol: "wind", short: "Breathe", label: "Breathe for 5 minutes" },
  { id: "gratitude", symbol: "heart.fill", short: "Gratitude", label: "Write three things I’m grateful for" },
  { id: "water", symbol: "drop.fill", short: "Water", label: "Drink 500 ml of water" },
];

const DEFAULT_SETTINGS = {
  setupDone: false,
  name: "Mantas",
  labels: ACTIVITIES.map((a) => a.label),
  cutoff: "11:00", // end of morning window, local time HH:MM
  calendarIds: [],
  reminderListIds: [],
  demo: false, // demo mode: explicitly labelled, OFF by default
};

const HOTEL_RE = /\b(hotel|inn|hostel|motel|lodge|b&b|airbnb|overnight|travelodge|premier inn)\b|^\s*stay\s*:/i;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ------------------------------------------------------------------ helpers
const pad = (n) => String(n).padStart(2, "0");
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDateLong = (d) => `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
const fmtDateShort = (d) => `${DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function greeting(now) {
  const h = now.getHours();
  if (h < 5) return "Hello";
  if (h < 12) return "Morning";
  if (h < 18) return "Afternoon";
  return "Evening";
}

function validTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${pad(h)}:${pad(mi)}`;
}

function cutoffDate(now, settings) {
  const [h, m] = settings.cutoff.split(":").map(Number);
  const d = startOfDay(now);
  d.setHours(h, m, 0, 0);
  return d;
}

// ------------------------------------------------------------------ storage
const fm = FileManager.local();
const filePath = (name) => fm.joinPath(fm.documentsDirectory(), `morning-briefing-${name}.json`);
let storageProblem = null; // human-readable string if reading/writing failed

function readJSON(name, fallback) {
  const p = filePath(name);
  try {
    if (!fm.fileExists(p)) return fallback;
    return JSON.parse(fm.readString(p));
  } catch (e) {
    storageProblem = `Could not read ${name} data (${e.message || e}).`;
    try { fm.writeString(p + ".corrupt", fm.readString(p)); } catch (_) { /* keep going */ }
    return fallback;
  }
}

function writeJSON(name, obj) {
  try {
    fm.writeString(filePath(name), JSON.stringify(obj));
    return true;
  } catch (e) {
    storageProblem = `Could not save ${name} data (${e.message || e}).`;
    return false;
  }
}

function loadSettings() {
  const s = Object.assign({}, DEFAULT_SETTINGS, readJSON("settings", {}));
  if (!Array.isArray(s.labels) || s.labels.length !== 3) s.labels = DEFAULT_SETTINGS.labels.slice();
  s.labels = s.labels.map((l, i) => (typeof l === "string" && l.trim() ? l.trim() : DEFAULT_SETTINGS.labels[i]));
  if (s.labels[0] === "Breathe for 2 minutes") s.labels[0] = DEFAULT_SETTINGS.labels[0]; // upgrade old default to 5 min
  if (!validTime(s.cutoff)) s.cutoff = "11:00";
  if (!Array.isArray(s.calendarIds)) s.calendarIds = [];
  if (!Array.isArray(s.reminderListIds)) s.reminderListIds = [];
  if (typeof s.name !== "string") s.name = "";
  return s;
}
const saveSettings = (s) => writeJSON("settings", s);

function loadData() {
  const d = readJSON("data", { days: {} });
  if (!d || typeof d !== "object" || typeof d.days !== "object" || d.days === null) return { days: {} };
  return d;
}
const saveData = (d) => writeJSON("data", d);

// A day record is created on demand, so each local calendar day starts fresh
// while earlier days (including gratitude entries) stay in the file.
function getDay(data, key) {
  let day = data.days[key];
  if (!day || typeof day !== "object") day = data.days[key] = {};
  if (!day.done || typeof day.done !== "object") day.done = {};
  for (const a of ACTIVITIES) day.done[a.id] = day.done[a.id] === true;
  day.skipped = day.skipped === true;
  if (!Array.isArray(day.gratitude) || day.gratitude.length !== 3) day.gratitude = ["", "", ""];
  return day;
}
const doneCount = (day) => ACTIVITIES.filter((a) => day.done[a.id]).length;
// Ticking anything cancels an earlier "skip", so the routine reopens and progress is honest.
function setDone(day, id, value) { day.done[id] = value === true; if (value) day.skipped = false; }

function chooseMode(now, settings, day) {
  const finished = day.skipped || doneCount(day) === ACTIVITIES.length;
  if (finished) return "day";
  return now < cutoffDate(now, settings) ? "routine" : "day";
}

// ----------------------------------------------------------- calendar data
function normalizeEvent(ev) {
  const start = ev.startDate, end = ev.endDate;
  const title = (ev.title || "Untitled").trim();
  const location = ev.location || "";
  const allDay = ev.isAllDay === true;
  const spansMidnight = !allDay && dayKey(start) !== dayKey(end) && end - start >= 8 * 3600 * 1000;
  const hotel = HOTEL_RE.test(title);
  const kind = hotel || spansMidnight ? "overnight" : allDay ? "allday" : "timed";
  return { title, location, start, end, allDay, kind };
}

async function getCalendars(settings) {
  let all;
  try { all = await Calendar.forEvents(); } catch (e) { return { status: "unavailable", cals: [], all: [] }; }
  if (!all || all.length === 0) return { status: "unavailable", cals: [], all: [] };
  if (settings.calendarIds.length === 0) return { status: "none-selected", cals: [], all };
  const cals = all.filter((c) => settings.calendarIds.includes(c.identifier));
  return { status: cals.length ? "ok" : "missing", cals, all };
}

async function getReminderLists(settings) {
  let all;
  try { all = await Calendar.forReminders(); } catch (e) { return { status: "unavailable", lists: [], all: [] }; }
  if (!all || all.length === 0) return { status: "unavailable", lists: [], all: [] };
  if (settings.reminderListIds.length === 0) return { status: "none-selected", lists: [], all };
  const lists = all.filter((c) => settings.reminderListIds.includes(c.identifier));
  return { status: lists.length ? "ok" : "missing", lists, all };
}

async function loadAgenda(settings, now) {
  if (settings.demo) return demoAgenda(now);
  const today0 = startOfDay(now), tom0 = addDays(today0, 1);
  const a = { demo: false, calStatus: "ok", remStatus: "ok", events: [], reminders: [], nextLater: null };

  const cs = await getCalendars(settings);
  a.calStatus = cs.status;
  if (cs.status === "ok") {
    try {
      const raw = await CalendarEvent.between(today0, tom0, cs.cals);
      a.events = raw.filter((e) => e.endDate > today0 && e.startDate < tom0).map(normalizeEvent)
        .sort((x, y) => x.start - y.start);
      const remainingTimed = a.events.filter((e) => e.kind === "timed" && e.end > now);
      if (remainingTimed.length === 0) {
        const later = await CalendarEvent.between(tom0, addDays(tom0, 7), cs.cals);
        a.nextLater = later.map(normalizeEvent).filter((e) => e.kind === "timed" && e.start >= tom0)
          .sort((x, y) => x.start - y.start)[0] || null;
      }
    } catch (e) { a.calStatus = "unavailable"; a.events = []; }
  }

  const rs = await getReminderLists(settings);
  a.remStatus = rs.status;
  if (rs.status === "ok") {
    try {
      const raw = await Reminder.allIncomplete(rs.lists);
      a.reminders = raw.filter((r) => r.dueDate && r.dueDate >= today0 && r.dueDate < tom0) // due today only
        .map((r) => ({
          title: (r.title || "Untitled").trim(),
          due: r.dueDate,
          hasTime: r.dueDateIncludesTime === true,
          overdue: r.dueDate < today0,
        }))
        .sort((x, y) => x.due - y.due);
    } catch (e) { a.remStatus = "unavailable"; a.reminders = []; }
  }
  return a;
}

// Sample data is always shown as if it were 08:30 today, so the layout is easy to judge.
function demoNow(now) { const d = startOfDay(now); d.setHours(8, 30, 0, 0); return d; }

function demoAgenda(now) {
  const t0 = startOfDay(now);
  const at = (h, m) => { const d = new Date(t0); d.setHours(h, m, 0, 0); return d; };
  const mk = (title, sh, sm, eh, em) => ({ title, location: "", start: at(sh, sm), end: at(eh, em), allDay: false, kind: "timed" });
  return {
    demo: true, calStatus: "ok", remStatus: "ok", nextLater: null,
    events: [
      mk("Site review", 9, 0, 10, 0), mk("Client call", 11, 30, 12, 0), mk("Project planning", 15, 0, 16, 0),
      { title: "Carlisle", location: "", start: t0, end: addDays(t0, 1), allDay: true, kind: "overnight" },
    ],
    reminders: [
      { title: "Send weekly update", due: at(0, 0), hasTime: false, overdue: false },
      { title: "Book train tickets", due: at(17, 0), hasTime: true, overdue: false },
    ],
  };
}

// Pure shaping of the agenda for display.
function shapeAgenda(a, now) {
  const timed = a.events.filter((e) => e.kind === "timed");
  const remaining = timed.filter((e) => e.end > now);
  const current = remaining.find((e) => e.start <= now) || null;
  const featured = current || remaining[0] || null;
  return {
    totalTimed: timed.length,
    featured,
    featuredIsNow: !!current,
    upcoming: remaining.filter((e) => e !== featured),
    compact: a.events.filter((e) => e.kind !== "timed")
      .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "overnight" ? -1 : 1)),
    reminders: a.reminders.slice(0, 3),
    remindersTotal: a.reminders.length,
  };
}

// ----------------------------------------------------------- widget helpers
function fontFor(size, weight) {
  switch (weight) {
    case "bold": return Font.boldSystemFont(size);
    case "semibold": return Font.semiboldSystemFont(size);
    case "medium": return Font.mediumSystemFont(size);
    default: return Font.regularSystemFont(size);
  }
}

function txt(parent, s, size, color, weight, lines) {
  const t = parent.addText(String(s));
  t.font = fontFor(size, weight || "regular");
  t.textColor = color || C.text;
  t.lineLimit = lines || 1;
  t.minimumScaleFactor = 0.75;
  return t;
}

function label(parent, s) { return txt(parent, s.toUpperCase(), 9.5, C.dim, "semibold"); }

function icon(parent, name, size, color) {
  try {
    const sym = SFSymbol.named(name);
    if (!sym) return null;
    const im = parent.addImage(sym.image);
    im.imageSize = new Size(size, size);
    im.tintColor = color || C.dim;
    return im;
  } catch (e) { return null; }
}

function hstack(parent, spacing) {
  const s = parent.addStack();
  s.layoutHorizontally();
  s.centerAlignContent();
  if (spacing !== undefined) s.spacing = spacing;
  return s;
}

function vstack(parent, spacing) {
  const s = parent.addStack();
  s.layoutVertically();
  if (spacing !== undefined) s.spacing = spacing;
  return s;
}

function divider(parent) {
  const d = parent.addStack();
  d.size = new Size(0, 1);
  d.backgroundColor = C.line;
}

function vdivider(parent, h) {
  const d = parent.addStack();
  d.size = new Size(1, h);
  d.backgroundColor = C.line;
}

function runUrl(view) {
  try { return URLScheme.forRunningScript() + `?view=${view}`; } catch (e) { return null; }
}

function newWidget() {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [C.bg2, C.bg1];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  return w;
}

function statusLine(parent, text, size) {
  const row = hstack(parent, 5);
  icon(row, "exclamationmark.triangle", size + 1, C.amber);
  txt(row, text, size, C.amber, "medium", 2);
}

function calendarMessage(status) {
  return {
    unavailable: "Calendar access unavailable. Open the script and check permissions.",
    "none-selected": "No calendars selected. Open the script → Settings.",
    missing: "Selected calendars no longer exist. Open Settings.",
  }[status];
}
function reminderMessage(status) {
  return {
    unavailable: "Reminders access unavailable. Check permissions.",
    "none-selected": "No reminder lists selected (Settings).",
    missing: "Selected reminder lists no longer exist.",
  }[status];
}

// ---------------------------------------------------------- widget: routine
function buildRoutineWidget(settings, day, now, fam) {
  const w = newWidget();
  const large = fam === "large", small = fam === "small";
  w.setPadding(large ? 20 : 14, large ? 20 : 16, large ? 18 : 12, large ? 20 : 16);
  w.url = runUrl("routine");
  const n = doneCount(day);

  const head = hstack(w);
  const left = vstack(head, 1);
  txt(left, `${greeting(now)}${settings.name ? ", " + settings.name : ""}.`, large ? 26 : small ? 15 : 20, C.text, "semibold");
  if (!small) txt(left, fmtDateLong(now), large ? 14 : 11.5, C.dim);
  if (!small) {
    head.addSpacer();
    txt(head, `${n} of ${ACTIVITIES.length} complete`, large ? 14 : 12, n === 3 ? C.blue : C.dim, "medium");
  }
  w.addSpacer(small ? 6 : large ? 14 : 7);

  const bar = hstack(w, 4);
  bar.size = new Size(0, 4);
  for (let i = 0; i < ACTIVITIES.length; i++) {
    const seg = bar.addStack();
    seg.size = new Size(0, 4);
    seg.cornerRadius = 2;
    seg.backgroundColor = i < n ? C.blue : C.line;
  }
  w.addSpacer(small ? 6 : large ? 16 : 8);

  if (small) {
    txt(w, `${n} of 3 complete`, 13, C.blue, "medium");
    w.addSpacer();
    txt(w, "Tap to open routine", 10.5, C.dim);
    return w;
  }

  ACTIVITIES.forEach((a, i) => {
    const row = hstack(w, 10);
    row.url = runUrl("toggle&id=" + a.id); // tap a row to tick / untick it
    const done = day.done[a.id];
    icon(row, done ? "checkmark.circle.fill" : "circle", large ? 22 : 17, done ? C.blue : C.dim);
    txt(row, settings.labels[i], large ? 17 : 14.5, done ? C.dim : C.text, done ? "regular" : "medium");
    row.addSpacer();
    w.addSpacer(large ? 14 : 5);
  });

  if (large) {
    w.addSpacer();
    divider(w);
    w.addSpacer(8);
    txt(w, `Tap an item to tick it. Tap the title for the full routine. My Day appears when done, skipped, or at ${settings.cutoff}.`, 11.5, C.dim, "regular", 2);
  }
  return w;
}

// -------------------------------------------------------------- widget: day
function reminderWhen(r) {
  if (r.overdue) return "Overdue";
  return r.hasTime ? fmtTime(r.due) : "Today";
}

function compactText(e) {
  if (e.kind === "overnight") return `${e.title} · Overnight`;
  return `All day · ${e.title}`;
}

function addCompact(parent, e, size) {
  const row = hstack(parent, 5);
  icon(row, e.kind === "overnight" ? "bed.double.fill" : "sun.max", size + 1, C.dim);
  txt(row, compactText(e), size, C.dim);
}

function addRoutineLink(parent, settings, day, size, short) {
  const n = doneCount(day);
  const row = hstack(parent, 5);
  row.url = runUrl("routine");
  icon(row, n === 3 ? "checkmark.circle.fill" : "sunrise", size + 1, C.blue);
  const txtLabel = short
    ? (n === 3 ? "Routine done" : n > 0 ? `Routine ${n}/3` : day.skipped ? "Routine skipped" : "Routine 0/3")
    : (n === 3 ? "Routine done · Reopen" : n > 0 ? `Routine ${n} of 3 · Open` : day.skipped ? "Routine skipped · Reopen" : "Routine 0 of 3 · Open");
  txt(row, txtLabel, size, C.blue, "medium");
}

function emptyAgendaBlock(parent, a, size, stacked) {
  txt(parent, stacked ? "Nothing more today" : "No more appointments today", size, C.dim);
  if (a.calStatus === "ok") {
    if (a.nextLater && stacked) {
      txt(parent, `Next · ${fmtDateShort(a.nextLater.start).split(" ").slice(0, 2).join(" ")} · ${fmtTime(a.nextLater.start)}`, size - 1, C.blue, "semibold");
      txt(parent, a.nextLater.title, size - 1, C.text, "medium");
    } else if (a.nextLater) {
      const row = hstack(parent, 6);
      txt(row, `${fmtDateShort(a.nextLater.start)} · ${fmtTime(a.nextLater.start)}`, size, C.blue, "semibold");
      txt(row, a.nextLater.title, size, C.text, "medium");
    } else {
      txt(parent, "Nothing in the next 7 days", size - 1, C.dim);
    }
  }
}

function buildDayWidget(settings, data, day, a, now, fam) {
  const sh = shapeAgenda(a, now);
  const w = newWidget();
  const large = fam === "large", small = fam === "small";
  w.setPadding(large ? 20 : 12, large ? 20 : 16, large ? 16 : 10, large ? 20 : 16);
  w.url = runUrl("menu");

  // header
  const head = hstack(w);
  const left = vstack(head, 0);
  txt(left, `${greeting(now)}${settings.name ? ", " + settings.name : ""}.`, large ? 26 : small ? 15 : 19, C.text, "semibold");
  if (!small) txt(left, fmtDateLong(now), large ? 14 : 11, C.dim);
  if (!small) {
    head.addSpacer();
    const r = hstack(head, 4);
    icon(r, "calendar", large ? 15 : 12, C.dim);
    txt(r, plural(sh.totalTimed, "event"), large ? 14 : 12, C.dim);
  }
  if (a.demo) { w.addSpacer(2); txt(w, "DEMO DATA · not your real calendar", 9.5, C.amber, "bold"); }
  w.addSpacer(small ? 6 : large ? 14 : 5);

  // ---- small: next appointment only
  if (small) {
    if (a.calStatus !== "ok") statusLine(w, "Calendar unavailable", 10.5);
    else if (sh.featured) {
      label(w, sh.featuredIsNow ? "Now" : "Next up");
      txt(w, `${fmtTime(sh.featured.start)}–${fmtTime(sh.featured.end)}`, 14, C.blue, "semibold");
      txt(w, sh.featured.title, 14, C.text, "semibold", 2);
    } else emptyAgendaBlock(w, a, 11.5, true);
    w.addSpacer();
    addRoutineLink(w, settings, day, 10);
    return w;
  }

  // ---- featured (icon tile + next up) and, on medium, reminders beside it
  const top = hstack(w, 10);
  const tile = top.addStack();
  tile.size = new Size(large ? 46 : 34, large ? 46 : 34);
  tile.cornerRadius = large ? 13 : 9;
  tile.backgroundColor = C.tile;
  tile.centerAlignContent();
  icon(tile, "calendar", large ? 23 : 17, C.blue);
  const featCol = vstack(top, 1);
  if (a.calStatus !== "ok") {
    statusLine(featCol, calendarMessage(a.calStatus), large ? 12 : 10.5);
  } else if (sh.featured) {
    const f = sh.featured;
    label(featCol, `${sh.featuredIsNow ? "Now" : "Next up"} · ends ${fmtTime(f.end)}`);
    const row = hstack(featCol, 8);
    txt(row, fmtTime(f.start), large ? 22 : 17, C.blue, "semibold");
    txt(row, f.title, large ? 20 : 17, C.text, "semibold");
    if (large && f.location) txt(featCol, f.location, 12, C.dim);
  } else {
    label(featCol, "Today");
    emptyAgendaBlock(featCol, a, large ? 15 : 12, !large);
  }

  if (!large) {
    top.addSpacer();
    vdivider(top, 34);
    const remCol = vstack(top, 2);
    remCol.size = new Size(126, 0);
    label(remCol, "Don’t forget");
    addReminders(remCol, a, sh, 1, 12.5, settings);
  }

  // ---- upcoming
  w.addSpacer(large ? 14 : 5);
  divider(w);
  w.addSpacer(large ? 10 : 4);
  if (a.calStatus === "ok" && sh.featured) {
    label(w, "Upcoming today");
    w.addSpacer(2);
    if (sh.upcoming.length === 0) {
      txt(w, "Nothing else today", large ? 14 : 12, C.dim);
    } else if (large) {
      sh.upcoming.slice(0, 4).forEach((e) => {
        const r = hstack(w, 12);
        txt(r, fmtTime(e.start), 15, C.blue, "semibold");
        txt(r, e.title, 15, C.text, "medium");
        w.addSpacer(4);
      });
      if (sh.upcoming.length > 4) txt(w, `+${sh.upcoming.length - 4} more`, 12, C.dim);
    } else {
      const r = hstack(w, 10);
      sh.upcoming.slice(0, 2).forEach((e, i) => {
        if (i) { r.addSpacer(); vdivider(r, 18); }
        const c = hstack(r, 7);
        txt(c, fmtTime(e.start), 15, C.blue, "semibold");
        txt(c, e.title, 15, C.text, "medium");
      });
      if (sh.upcoming.length > 2) txt(r, `+${sh.upcoming.length - 2}`, 11, C.dim);
    }
  }

  // ---- large: reminders
  if (large) {
    w.addSpacer(12);
    divider(w);
    w.addSpacer(10);
    label(w, "Reminders due");
    w.addSpacer(3);
    addReminders(w, a, sh, 3, 15, settings);
  }

  w.addSpacer();

  // ---- medium: one compact footer row (overnight / all-day + routine link)
  if (!large) {
    divider(w);
    w.addSpacer(4);
    const r = hstack(w, 8);
    if (a.calStatus === "ok" && sh.compact.length) {
      addCompact(r, sh.compact[0], 11.5);
      if (sh.compact.length > 1) txt(r, `+${sh.compact.length - 1}`, 10.5, C.dim);
    }
    r.addSpacer();
    addRoutineLink(r, settings, day, 10.5, true);
    return w;
  }

  // ---- large: compact all-day / overnight list
  if (a.calStatus === "ok" && sh.compact.length) {
    divider(w); w.addSpacer(8); label(w, "All day & overnight"); w.addSpacer(3);
    const maxC = 4;
    sh.compact.slice(0, maxC).forEach((e) => { addCompact(w, e, 12.5); w.addSpacer(2); });
    if (sh.compact.length > maxC) txt(w, `+${sh.compact.length - maxC} more all-day`, 10.5, C.dim);
  }
  w.addSpacer(8);
  const foot = hstack(w);
  addRoutineLink(foot, settings, day, 12);
  if (storageProblem) { foot.addSpacer(); statusLine(foot, "Storage issue", 10); }
  return w;
}

function addReminders(parent, a, sh, max, size, settings) {
  if (a.remStatus !== "ok") { statusLine(parent, reminderMessage(a.remStatus), size - 2); return; }
  if (sh.remindersTotal === 0) { txt(parent, "No reminders due", size, C.dim); return; }
  sh.reminders.slice(0, max).forEach((r) => {
    const row = hstack(parent, 6);
    icon(row, "doc.text", size + 1, r.overdue ? C.amber : C.text);
    txt(row, r.title, size, C.text, "medium");
    if (max > 1) { row.addSpacer(); txt(row, reminderWhen(r), size - 2.5, r.overdue ? C.amber : C.dim); }
    if (max > 1) parent.addSpacer(3);
  });
  if (sh.remindersTotal > max) txt(parent, `+${sh.remindersTotal - max} more`, size - 2, C.dim);
}

// ------------------------------------------------------ widget: Lock Screen
// Lock Screen widgets are tiny and drawn in one tint by iOS. Optional widget Parameter:
//   (empty) = automatic: routine before the cutoff, otherwise My Day
//   routine = routine progress   day = next appointments   reminders = today's reminders
function lockLine(parent, s, size, weight) {
  const t = parent.addText(String(s));
  t.font = fontFor(size, weight || "regular");
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

async function buildLockWidget(settings, data, now, fam, param) {
  const w = new ListWidget();
  try { w.addAccessoryWidgetBackground = true; } catch (e) { /* older iOS */ }
  const key = String(param || "auto").trim().toLowerCase();
  const day = getDay(data, dayKey(now));
  const n = doneCount(day);
  let mode = chooseMode(now, settings, day);
  if (key === "routine") mode = "routine";
  if (key === "day" || key === "reminders") mode = "day";
  w.url = runUrl(mode === "routine" ? "routine" : "menu");

  let sh = null, a = null;
  if (mode === "day") {
    const t = settings.demo ? demoNow(now) : now;
    a = await loadAgenda(settings, t);
    sh = shapeAgenda(a, t);
  }
  const undone = ACTIVITIES.filter((x) => !day.done[x.id]).map((x) => x.short);

  if (fam === "accessoryInline") {
    let line;
    if (mode === "routine") line = `Routine ${n}/3${undone.length ? " · " + undone[0] : ""}`;
    else if (a.calStatus !== "ok") line = "Calendar unavailable";
    else if (key === "reminders") line = a.remStatus !== "ok" ? "Reminders unavailable" : `${sh.remindersTotal} reminder${sh.remindersTotal === 1 ? "" : "s"} today`;
    else if (sh.featured) line = `${fmtTime(sh.featured.start)} ${sh.featured.title}`;
    else line = "No more appointments";
    w.addText(line);
    return w;
  }

  if (fam === "accessoryCircular") {
    const st = w.addStack();
    st.layoutVertically();
    st.centerAlignContent();
    if (mode === "routine") {
      icon(st, n === 3 ? "checkmark.circle" : "sunrise", 14, Color.white());
      lockLine(st, `${n}/3`, 16, "bold");
    } else if (key === "reminders") {
      icon(st, "checklist", 14, Color.white());
      lockLine(st, a.remStatus === "ok" ? String(sh.remindersTotal) : "–", 16, "bold");
    } else {
      icon(st, "calendar", 13, Color.white());
      lockLine(st, a.calStatus === "ok" && sh.featured ? fmtTime(sh.featured.start) : "–", 14, "bold");
    }
    return w;
  }

  // accessoryRectangular (and any unknown accessory size)
  w.setPadding(2, 4, 2, 4);
  const lines = [];
  if (mode === "routine") {
    lines.push([`Routine ${n}/3 · until ${settings.cutoff}`, "bold"]);
    if (undone.length === 0) lines.push(["All done ✓", "regular"]);
    undone.slice(0, 2).forEach((u) => lines.push(["○ " + u, "regular"]));
  } else if (a.calStatus !== "ok" && key !== "reminders") {
    lines.push(["Calendar unavailable", "bold"], ["Open Morning Briefing", "regular"]);
  } else if (key === "reminders") {
    lines.push(["Reminders today", "bold"]);
    if (a.remStatus !== "ok") lines.push(["Unavailable: check access", "regular"]);
    else if (sh.remindersTotal === 0) lines.push(["None due today", "regular"]);
    else sh.reminders.slice(0, 2).forEach((r) => lines.push(["○ " + r.title, "regular"]));
    if (a.remStatus === "ok" && sh.remindersTotal > 2) lines.push([`+${sh.remindersTotal - 2} more`, "regular"]);
  } else {
    if (sh.featured) lines.push([`${sh.featuredIsNow ? "Now" : "Next"} ${fmtTime(sh.featured.start)} ${sh.featured.title}`, "bold"]);
    else lines.push(["No more appointments", "bold"]);
    if (sh.upcoming[0]) lines.push([`${fmtTime(sh.upcoming[0].start)} ${sh.upcoming[0].title}`, "regular"]);
    else if (!sh.featured && a.nextLater) lines.push([`${fmtDateShort(a.nextLater.start)} ${fmtTime(a.nextLater.start)} ${a.nextLater.title}`, "regular"]);
    else lines.push(["Nothing else today", "regular"]);
    if (a.remStatus === "ok") lines.push([sh.remindersTotal ? `○ ${sh.reminders[0].title}${sh.remindersTotal > 1 ? " +" + (sh.remindersTotal - 1) : ""}` : "No reminders today", "regular"]);
  }
  lines.slice(0, 3).forEach((l) => lockLine(w, l[0], 12, l[1]));
  return w;
}

function buildSetupWidget() {
  const w = newWidget();
  w.url = runUrl("menu");
  w.setPadding(16, 16, 16, 16);
  txt(w, "Morning Briefing", 18, C.text, "semibold");
  w.addSpacer(6);
  txt(w, "Open this script in Scriptable once to finish setup (choose calendars and reminder lists). Tap here.", 13, C.dim, "regular", 4);
  return w;
}

async function buildWidget(settings, data, now, fam, force, param) {
  if (!settings.setupDone && !settings.demo && !force) {
    if (String(fam).indexOf("accessory") === 0) { const lw = new ListWidget(); lw.url = runUrl("menu"); lw.addText("Open Morning Briefing to set up"); return lw; }
    return buildSetupWidget();
  }
  if (String(fam).indexOf("accessory") === 0) return buildLockWidget(settings, data, now, fam, param);
  const day = getDay(data, dayKey(now)); // not saved from the widget: reading only
  // Widget Parameter "day" or "routine" pins the view; empty = automatic.
  const p = String(param || "").trim().toLowerCase();
  const pinned = p === "day" || p === "routine" ? p : undefined;
  const mode = force || pinned || chooseMode(now, settings, day);
  if (mode === "routine") {
    const w = buildRoutineWidget(settings, day, now, fam);
    w.refreshAfterDate = nextRefresh(null, now, settings, mode);
    return w;
  }
  const t = settings.demo ? demoNow(now) : now;
  const a = await loadAgenda(settings, t);
  const w = buildDayWidget(settings, data, day, a, t, fam);
  w.refreshAfterDate = nextRefresh(a, now, settings, mode);
  return w;
}

// iOS decides when widgets really refresh; this is only a request.
function nextRefresh(a, now, settings, mode) {
  const min = new Date(now.getTime() + 5 * 60000);
  let t = new Date(now.getTime() + 15 * 60000);
  const consider = (d) => { if (d && d > min && d < t) t = d; };
  consider(cutoffDate(now, settings));
  consider(addDays(startOfDay(now), 1));
  if (a) a.events.filter((e) => e.kind === "timed").forEach((e) => { consider(e.start); consider(e.end); });
  return t < min ? min : t;
}

// ------------------------------------------------------------------ in-app UI
function mkRow(table, o) {
  const row = new UITableRow();
  row.dismissOnSelect = false;
  if (o.height) row.height = o.height;
  const cell = row.addText(o.title || "", o.subtitle);
  if (o.titleColor) cell.titleColor = o.titleColor;
  if (o.subtitleColor) cell.subtitleColor = o.subtitleColor;
  if (o.onSelect) row.onSelect = o.onSelect;
  table.addRow(row);
  return row;
}

function mkButtons(table, buttons) {
  const row = new UITableRow();
  row.dismissOnSelect = false;
  for (const b of buttons) {
    const cell = row.addButton(b.title);
    cell.dismissOnTap = false;
    if (b.color) cell.titleColor = b.color;
    cell.centerAligned();
    cell.onTap = b.onTap;
  }
  table.addRow(row);
}

async function say(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message || "";
  a.addAction("OK");
  await a.presentAlert();
}

async function persist(settings, data) {
  let ok = true;
  if (settings) ok = saveSettings(settings) && ok;
  if (data) ok = saveData(data) && ok;
  if (!ok) await say("Couldn’t save", storageProblem || "Storage error. Your change may not be kept.");
  return ok;
}

// --- breathing guide (local HTML, no network). Optional; manual completion always available.
async function showBreathing() { // returns true if the user confirms they finished
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;height:100%;background:#0D1015;color:#EEF1F5;font-family:-apple-system,system-ui,sans-serif;text-align:center}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px}
.orb{width:180px;height:180px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#7CC0FF,#3D9BFF 60%,#1F5FA8);transform:scale(.55);transition:transform 4s ease-in-out,opacity 4s;opacity:.7}
.orb.in{transform:scale(1);opacity:1}.orb.out{transform:scale(.55);transition:transform 6s ease-in-out,opacity 6s;opacity:.7}
h1{font-weight:500;font-size:30px;margin:0}p{margin:0;color:#8C95A4;font-size:16px}
button{font-size:17px;padding:12px 28px;border-radius:14px;border:0;background:#3D9BFF;color:#fff}
</style></head><body><div class="wrap">
<div class="orb" id="o"></div><h1 id="t">Ready?</h1><p id="s">5 minutes · breathe in 4s, out 6s · no breath holds</p>
<button id="b">Start</button></div>
<script>
var TOTAL=300,left=TOTAL,timer=null,o=document.getElementById('o'),t=document.getElementById('t'),s=document.getElementById('s'),b=document.getElementById('b');
function cycle(){t.textContent='Breathe in';o.className='orb in';setTimeout(function(){if(left<=0)return;t.textContent='Breathe out';o.className='orb out';},4000);}
b.onclick=function(){b.style.display='none';cycle();var c=0;
timer=setInterval(function(){left--;c++;s.textContent=Math.floor(left/60)+':'+('0'+(left%60)).slice(-2)+' left';
if(c%10===0&&left>0)cycle();
if(left<=0){clearInterval(timer);o.className='orb out';t.textContent='Well done';s.textContent='Close this screen and tick \\u201cbreathing\\u201d to log it.';}},1000);};
</script></body></html>`;
  try {
    const wv = new WebView();
    await wv.loadHTML(html);
    await wv.present(true);
    const q = new Alert();
    q.title = "Finished your 5 minutes?";
    q.addAction("Mark breathing done");
    q.addCancelAction("Not yet");
    return (await q.presentAlert()) === 0;
  } catch (e) {
    await say("Guide unavailable", "Breathe gently for five minutes, then tick it off. No guide needed.");
    return false;
  }
}

async function editGratitude(settings, data, day) {
  const a = new Alert();
  a.title = "Three things I’m grateful for";
  a.message = "Your text is saved as a draft even if you close this.";
  day.gratitude.forEach((g, i) => a.addTextField(`${i + 1}.`, g));
  a.addAction("Save");
  a.addCancelAction("Close");
  const idx = await a.presentAlert();
  try { // keep whatever was typed, even on dismissal
    day.gratitude = day.gratitude.map((_, i) => (a.textFieldValue(i) || "").trim());
  } catch (e) { /* if values can't be read after dismissal, previous text stays */ }
  const complete = day.gratitude.every((g) => g.length > 0);
  if (idx === 0 && complete) setDone(day, "gratitude", true);
  await persist(null, data);
  if (idx === 0 && !complete) await say("Saved as draft", "Saved. Tap “Mark done” when you’re finished, or fill in all three.");
}

async function showRoutine(settings, data) {
  const table = new UITable();
  table.showSeparators = true;

  async function build() {
    table.removeAllRows();
    const now = new Date();
    const day = getDay(data, dayKey(now));
    const n = doneCount(day);
    mkRow(table, { title: `${greeting(now)}${settings.name ? ", " + settings.name : ""}.`, subtitle: `${fmtDateLong(now)} · ${n} of 3 complete${day.skipped && n < 3 ? " · skipped for today" : ""}`, height: 70 });

    // Breathing
    mkRow(table, { title: `${day.done.breathe ? "✅" : "⬜"}  ${settings.labels[0]}`, subtitle: "Optional 5-minute guide: breathe in 4s, out 6s, no breath holds.", height: 64 });
    mkButtons(table, [
      { title: "Start guide", color: Color.blue(), onTap: async () => { if (await showBreathing()) { setDone(day, "breathe", true); await persist(null, data); } await build(); } },
      { title: day.done.breathe ? "Undo done" : "Mark done", color: Color.blue(), onTap: async () => { setDone(day, "breathe", !day.done.breathe); await persist(null, data); await build(); } },
    ]);

    // Gratitude
    const g = day.gratitude.filter(Boolean);
    mkRow(table, { title: `${day.done.gratitude ? "✅" : "⬜"}  ${settings.labels[1]}`, subtitle: g.length ? g.map((x, i) => `${i + 1}. ${x}`).join("\n") : "Three short lines is plenty.", height: g.length ? 100 : 64 });
    mkButtons(table, [
      { title: g.length ? "Edit" : "Write", color: Color.blue(), onTap: async () => { await editGratitude(settings, data, day); await build(); } },
      { title: day.done.gratitude ? "Undo done" : "Mark done (said aloud)", color: Color.blue(), onTap: async () => { setDone(day, "gratitude", !day.done.gratitude); await persist(null, data); await build(); } },
    ]);

    // Water
    mkRow(table, {
      title: `${day.done.water ? "✅" : "⬜"}  ${settings.labels[2]}`, subtitle: day.done.water ? "Tap to undo" : "Tap when finished", height: 64,
      onSelect: async () => { setDone(day, "water", !day.done.water); await persist(null, data); await build(); },
    });

    if (n === 3) {
      const go = new UITableRow();
      go.dismissOnSelect = true; // routine is complete: just close and show My Day
      go.height = 52;
      const gc = go.addText("All done · go to my day");
      gc.titleColor = Color.blue();
      gc.centerAligned();
      table.addRow(go);
    } else if (day.skipped) {
      mkButtons(table, [{ title: "Reopen routine (clear skip)", color: Color.blue(), onTap: async () => { day.skipped = false; await persist(null, data); await build(); } }]);
    } else {
      const skip = new UITableRow();
      skip.dismissOnSelect = true; // closes this screen, then My Day is shown below
      skip.height = 52;
      const sc = skip.addText("Skip to my day");
      sc.titleColor = Color.blue();
      sc.centerAligned();
      skip.onSelect = () => { day.skipped = true; saveData(data); }; // unfinished items stay unfinished
      table.addRow(skip);
    }
    table.reload();
  }
  await build();
  await table.present(false);
  const day = getDay(data, dayKey(new Date()));
  if (day.skipped || doneCount(day) === 3) await presentMyDay(settings, data);
}

// Opened from a tap on a widget row: tick / untick one item, no forms.
async function quickToggle(settings, data, id) {
  const act = ACTIVITIES.find((x) => x.id === id);
  if (!act) { await say("Unknown item", "That item isn’t part of the routine."); return null; }
  const day = getDay(data, dayKey(new Date()));
  setDone(day, id, !day.done[id]);
  await persist(null, data);
  const n = doneCount(day);
  const a = new Alert();
  a.title = `${day.done[id] ? "✓" : "○"} ${act.short} ${day.done[id] ? "done" : "unticked"}`;
  a.message = `${n} of 3 complete${n === 3 ? "\nAll done: My Day shows next." : ""}`;
  a.addAction("OK");
  a.addAction("Open routine");
  if ((await a.presentAlert()) === 1) await showRoutine(settings, data);
  return day;
}

async function presentMyDay(settings, data) {
  const w = await buildWidget(settings, data, new Date(), "large");
  await w.presentLarge();
}

async function presentPreview(settings, data) {
  const opts = [
    ["Morning routine · Medium", "routine", "medium", false],
    ["Morning routine · Large", "routine", "large", false],
    ["My Day · Medium (your data)", "day", "medium", false],
    ["My Day · Large (your data)", "day", "large", false],
    ["My Day · Medium (SAMPLE data)", "day", "medium", true],
    ["My Day · Large (SAMPLE data)", "day", "large", true],
    ["Lock Screen · Rectangular", "auto", "accessoryRectangular", false],
    ["Lock Screen · Circular", "auto", "accessoryCircular", false],
    ["Lock Screen · Inline", "auto", "accessoryInline", false],
  ];
  const a = new Alert();
  a.title = "Preview widget";
  a.message = "Sample data is clearly labelled and shown as if it were 08:30.";
  opts.forEach((o) => a.addAction(o[0]));
  a.addCancelAction("Cancel");
  const i = await a.presentAlert();
  if (i < 0) return;
  const [, mode, fam, demo] = opts[i];
  const s = demo ? Object.assign({}, settings, { demo: true }) : settings;
  const w = await buildWidget(s, data, new Date(), fam, mode === "auto" ? undefined : mode);
  if (fam === "large") await w.presentLarge();
  else if (fam === "medium") await w.presentMedium();
  else {
    const fn = { accessoryRectangular: "presentAccessoryRectangular", accessoryCircular: "presentAccessoryCircular", accessoryInline: "presentAccessoryInline" }[fam];
    if (typeof w[fn] === "function") await w[fn]();
    else await say("Preview not available", "Add the widget to your Lock Screen to see it.");
  }
}

async function showPastGratitude(data) {
  const table = new UITable();
  table.showSeparators = true;
  const keys = Object.keys(data.days).sort().reverse().filter((k) => (data.days[k].gratitude || []).some((g) => g && g.trim()));
  mkRow(table, { title: "Past gratitude", subtitle: keys.length ? `${keys.length} days saved on this phone` : "Nothing saved yet", height: 60 });
  keys.forEach((k) => {
    const g = data.days[k].gratitude.filter((x) => x && x.trim());
    mkRow(table, { title: k, subtitle: g.map((x, i) => `${i + 1}. ${x}`).join("\n"), height: 24 + 22 * g.length });
  });
  await table.present(false);
}

// ----------------------------------------------------- settings + setup flow
async function promptText(title, message, fields, okLabel) {
  const a = new Alert();
  a.title = title;
  a.message = message || "";
  fields.forEach((f) => a.addTextField(f.placeholder, f.value));
  a.addAction(okLabel || "Save");
  a.addCancelAction("Cancel");
  const idx = await a.presentAlert();
  if (idx !== 0) return null;
  return fields.map((_, i) => (a.textFieldValue(i) || "").trim());
}

async function editProfile(settings) {
  const r = await promptText("Your name & routine", "Leave a routine label blank to restore its default.", [
    { placeholder: "Name", value: settings.name },
    ...settings.labels.map((l, i) => ({ placeholder: `Routine ${i + 1}`, value: l })),
  ]);
  if (!r) return false;
  settings.name = r[0];
  settings.labels = r.slice(1).map((l, i) => l || DEFAULT_SETTINGS.labels[i]);
  return true;
}

async function editCutoff(settings) {
  for (;;) {
    const r = await promptText("Morning window ends", "24-hour time, e.g. 11:00. After this, My Day shows even if the routine is unfinished.", [{ placeholder: "HH:MM", value: settings.cutoff }]);
    if (!r) return false;
    const t = validTime(r[0]);
    if (t) { settings.cutoff = t; return true; }
    await say("Not a valid time", "Please use HH:MM, for example 11:00.");
  }
}

// Generic multi-select. items: [{id,title}]. Returns new id array, or null if cancelled.
async function pickMany(title, hint, items, selected) {
  const chosen = new Set(selected.filter((id) => items.some((i) => i.id === id)));
  const stale = selected.length - chosen.size;
  const table = new UITable();
  table.showSeparators = true;
  function build() {
    table.removeAllRows();
    mkRow(table, { title, subtitle: hint + (stale ? `  (${plural(stale, "saved item")} no longer exist and will be dropped.)` : ""), height: 80 });
    items.forEach((it) => {
      mkRow(table, { title: `${chosen.has(it.id) ? "✅" : "⬜"}  ${it.title}`, height: 48, onSelect: () => { chosen.has(it.id) ? chosen.delete(it.id) : chosen.add(it.id); build(); } });
    });
    const doneRow = new UITableRow();
    doneRow.dismissOnSelect = true;
    doneRow.height = 52;
    const dc = doneRow.addText("Done");
    dc.titleColor = Color.blue();
    dc.centerAligned();
    table.addRow(doneRow);
    table.reload();
  }
  build();
  await table.present(false);
  // Selection counts whether Done was tapped or the sheet was simply closed.
  return Array.from(chosen);
}

async function chooseCalendars(settings, firstRun) {
  const cs = await getCalendars(settings);
  if (cs.status === "unavailable") {
    await say("Calendar access needed", "Allow Scriptable to access Calendars: Settings → Apps → Scriptable → Calendars → Full Access. Then run the script again.");
    return false;
  }
  const items = cs.all.map((c) => ({ id: c.identifier, title: c.title }));
  let selected = settings.calendarIds;
  if (firstRun && selected.length === 0) {
    selected = cs.all.filter((c) => !(c.isSubscribed === true) && !/holiday|birthday/i.test(c.title)).map((c) => c.identifier);
    if (!selected.length) selected = items.map((i) => i.id);
  }
  const res = await pickMany("Calendars to include", "Tap to select. Untick holiday and birthday calendars to keep them out.", items, selected);
  if (res) settings.calendarIds = res;
  return true;
}

async function chooseReminderLists(settings, firstRun) {
  const rs = await getReminderLists(settings);
  if (rs.status === "unavailable") {
    await say("Reminders access needed", "Allow Scriptable to access Reminders: Settings → Apps → Scriptable → Reminders → Full Access. Then run the script again.");
    return false;
  }
  const items = rs.all.map((c) => ({ id: c.identifier, title: c.title }));
  const selected = firstRun && settings.reminderListIds.length === 0 ? items.map((i) => i.id) : settings.reminderListIds;
  const res = await pickMany("Reminder lists to include", "Only incomplete reminders due today are shown.", items, selected);
  if (res) settings.reminderListIds = res;
  return true;
}

async function runSetup(settings, data) {
  await say("Welcome", "A short setup: your name, morning window, calendars and reminder lists. iOS will ask for calendar and reminder access. Everything stays on this phone.");
  await editProfile(settings);
  await editCutoff(settings);
  await chooseCalendars(settings, true);
  await chooseReminderLists(settings, true);
  settings.setupDone = true;
  await persist(settings, null);
  await say("All set", "Add a Scriptable widget (Medium or Large), choose this script, and you’re done. iOS decides when widgets refresh.");
}

async function showSettings(settings, data) {
  const table = new UITable();
  table.showSeparators = true;
  function build() {
    table.removeAllRows();
    mkRow(table, { title: "Settings", subtitle: "Changes save immediately.", height: 56 });
    mkRow(table, { title: "Name & routine labels", subtitle: `${settings.name || "(no name)"} · ${settings.labels.join(" / ")}`, height: 64, onSelect: async () => { if (await editProfile(settings)) await persist(settings, null); build(); } });
    mkRow(table, { title: "Morning window ends", subtitle: settings.cutoff, height: 56, onSelect: async () => { if (await editCutoff(settings)) await persist(settings, null); build(); } });
    mkRow(table, { title: "Calendars", subtitle: `${settings.calendarIds.length} selected`, height: 56, onSelect: async () => { if (await chooseCalendars(settings, false)) await persist(settings, null); build(); } });
    mkRow(table, { title: "Reminder lists", subtitle: `${settings.reminderListIds.length} selected`, height: 56, onSelect: async () => { if (await chooseReminderLists(settings, false)) await persist(settings, null); build(); } });
    mkRow(table, { title: `Demo mode: ${settings.demo ? "ON" : "off"}`, subtitle: "Shows clearly labelled sample data instead of your calendar.", height: 64, onSelect: async () => { settings.demo = !settings.demo; await persist(settings, null); build(); } });
    mkRow(table, { title: "Reset today’s routine", subtitle: "Clears today’s ticks, skip and gratitude. Older days stay.", height: 64, titleColor: Color.red(), onSelect: async () => {
      const a = new Alert(); a.title = "Reset today?"; a.addDestructiveAction("Reset"); a.addCancelAction("Cancel");
      if ((await a.presentAlert()) === 0) { delete data.days[dayKey(new Date())]; await persist(null, data); }
      build();
    } });
    mkRow(table, { title: "Run setup again", height: 52, onSelect: async () => { await runSetup(settings, data); build(); } });
    table.reload();
  }
  build();
  await table.present(false);
}

async function showMenu(settings, data) {
  const table = new UITable();
  table.showSeparators = true;
  async function build() {
    table.removeAllRows();
    const now = new Date();
    const day = getDay(data, dayKey(now));
    mkRow(table, { title: "Morning Briefing", subtitle: `${fmtDateLong(now)}${settings.demo ? " · DEMO MODE ON" : ""}`, height: 64 });
    if (storageProblem) mkRow(table, { title: "Storage issue", subtitle: storageProblem, titleColor: Color.orange(), height: 64 });
    mkRow(table, { title: "Morning routine", subtitle: `${doneCount(day)} of 3 complete${day.skipped ? " · skipped" : ""}`, height: 60, onSelect: async () => { await showRoutine(settings, data); await build(); } });
    mkRow(table, { title: "Preview widget", subtitle: "Routine or My Day · Medium or Large · real or sample data", height: 60, onSelect: async () => { await presentPreview(settings, data); } });
    mkRow(table, { title: "Past gratitude", height: 52, onSelect: async () => { await showPastGratitude(data); } });
    mkRow(table, { title: "Settings", height: 52, onSelect: async () => { await showSettings(settings, data); await build(); } });
    table.reload();
  }
  await build();
  await table.present(false);
}

// -------------------------------------------------------------------- main
async function main() {
  const settings = loadSettings();
  const data = loadData();

  if (config.runsInWidget) {
    let w;
    try {
      w = await buildWidget(settings, data, new Date(), config.widgetFamily || "medium", undefined, args.widgetParameter);
    } catch (e) {
      w = newWidget();
      txt(w, "Morning Briefing", 16, C.text, "semibold");
      txt(w, `Something went wrong: ${e.message || e}`, 12, C.amber, "regular", 4);
      w.url = runUrl("menu");
    }
    Script.setWidget(w);
    Script.complete();
    return;
  }

  if (!settings.setupDone) await runSetup(settings, data);
  const view = args.queryParameters && args.queryParameters.view;
  if (view === "routine") await showRoutine(settings, data);
  else if (view === "toggle") await quickToggle(settings, data, args.queryParameters.id);
  else await showMenu(settings, data);
  Script.complete();
}

if (!TEST) await main();
else globalThis.__MB__ = { buildWidget, chooseMode, getDay, shapeAgenda, normalizeEvent, loadAgenda, loadSettings, loadData, saveData, saveSettings, nextRefresh, doneCount, validTime, DEFAULT_SETTINGS, setDone, quickToggle };
