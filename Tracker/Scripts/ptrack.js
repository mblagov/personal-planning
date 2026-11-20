/*
 * ptrack.js — weekly goals, projects, inbox and analytics for Obsidian.
 *
 * One file, two roles:
 *   1. Command runner, loaded by the notes in Tracker/Commands (works on desktop and mobile —
 *      no Templater "user scripts" setting needed):  module.exports(tp, "plan")
 *      commands: capture | process | classify | plan | review | newProject | register
 *   2. Library for the Dataview view in Tracker/Views/tracker (module.exports.core)
 *
 * Tasks use the Tasks plugin emoji format: 📅 due · ⏳ scheduled · 🛫 start · ➕ created · ✅ done · ⏫🔼🔽 priority.
 * The Tracker folder must sit at the vault root (Tracker/...).
 */
const CONFIG_PATH = "Tracker/Config.md";
const VIEW_PATH = "Tracker/Views/tracker";
const COMMANDS_FOLDER = "Tracker/Commands";

const DEFAULTS = {
  project_roots: [],
  weeks_folder: "Tracker/Weeks",
  inbox: "Tracker/Inbox.md",
  goals_min: 5,
  goals_max: 7,
  focus_priority: 2,            // projects with this priority or higher (1 = top) are flagged when they're not in the week's plan
  plan_next_week_from: 5,
  llm_provider: "ollama",
  llm_url: "http://localhost:11434",
  llm_model: "qwen2.5:7b-instruct",
  llm_flag_below: 0.6,          // the review marks items the model is less sure about with [check:: unsure]
  reference_folder: "References", // reference notes: places to visit, recommendations, how-tos… (one note per topic)
  finance_file: "Finance/Spendings.md", // spendings from the inbox are collected here
  finance_project: "",          // project for the "Process new spendings" task; empty = in the finance file
  currency: "",                 // currency for spendings that don't say, e.g. EUR
  llm_examples_per_project: 3,
  llm_batch: 6,                 // inbox items sorted per request (the project list is read once per request); 1 = one at a time
  llm_context: 8192,            // Ollama: context window in tokens — the project list must fit
  llm_keep_alive: "30m",        // Ollama: keep the model loaded between requests
  llm_think: false,             // thinking models (qwen3, deepseek-r1…): false = answer without the long reasoning (much faster)
  llm_mobile: "off",            // iPhone: off | shortcut (Apple on-device model via Shortcuts) | url
  llm_shortcut: "Tracker Classify",
  llm_url_mobile: "",
  llm_provider_mobile: "",
  llm_model_mobile: "",
  plan_schedule_tasks: true,
  plan_due_dates: true,
  plan_estimates: true,        // ask for a time estimate when a task is planned
  log_time_on_done: true,      // ticking a task with an estimate (in Tracker views) asks for the time spent
  upcoming_days: 7,
  task_tag: "",
  plan_times: true,            // when planning a dated task, ask whether it has a set time (→ Google Calendar)
  calendar_client_id: "",      // Google Calendar: your OAuth client (Start here → Google Calendar)
  calendar_client_secret: "",
  calendar_id: "primary",      // calendar the timed tasks go to
  calendar_show: "",           // more calendars to show on Home (ids, comma-separated)
  calendar_timezone: "",       // empty = this device's time zone
  calendar_default_minutes: 30, // length of an event when the task has no end time and no estimate
  calendar_sync_minutes: 15,   // Home syncs when the last sync is older than this; 0 = only with Sync calendar
};
const TRACKER_ROOT = "Tracker";

const MISS_REASONS = [
  ["no-time", "No time / overcommitted"],
  ["blocked", "Blocked by someone or something"],
  ["deprioritized", "Deprioritized on purpose"],
  ["underestimated", "Underestimated the work"],
  ["motivation", "Lost motivation / energy"],
  ["unclear", "Goal was unclear"],
];

/* ------------------------------------------------------------------ utils */

function getMoment() {
  if (typeof window !== "undefined" && window.moment) return window.moment;
  if (typeof globalThis !== "undefined" && globalThis.moment) return globalThis.moment;
  throw new Error("moment.js is not available");
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toArr = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : String(v).split(",")).map((s) => String(s).trim()).filter(Boolean);
const oneLine = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(" · ").replace(/[\[\]]/g, "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

class Cancelled extends Error {}
/** Thrown when we hand over to the Shortcuts app; the command stops quietly. */
class Handoff extends Error {}

/* ------------------------------------------------------------------ weeks */

const WEEK_RE = /^(\d{4})-W(\d{2})$/;
function weekId(m) { return m.format("GGGG-[W]WW"); }
function weekStart(id) {
  const mt = String(id).match(WEEK_RE);
  if (!mt) return null;
  const jan4 = getMoment()(`${mt[1]}-01-04`, "YYYY-MM-DD");
  const start = jan4.clone().startOf("isoWeek").add(Number(mt[2]) - 1, "weeks").startOf("day");
  return weekId(start) === id ? start : null;
}
function shiftWeek(id, n) { return weekId(weekStart(id).add(n, "weeks")); }
function weeksBetween(a, b) { return Math.round(weekStart(b).diff(weekStart(a), "days") / 7); }
function weekRange(id) {
  const s = weekStart(id), e = s.clone().add(6, "days");
  return s.month() === e.month() ? `${s.format("D")}–${e.format("D MMM")}` : `${s.format("D MMM")} – ${e.format("D MMM")}`;
}
function shortWeek(id) { return "W" + String(id).slice(-2); }
/** All week ids in a field value: "2026-W45", "[[2026-W45]]", "2026-W44, 2026-W45" */
const weekIds = (v) => String(v || "").match(/\d{4}-W\d{2}/g) || [];
const PLANNED_SEC = "Planned";
const DONE_SEC = "Done";
const UNPLANNED_SEC = "Unplanned"; // tasks added during the week (Add tasks) — shown like planned ones, told apart in analytics

/* ------------------------------------------------------------------ config */

function getConfig(app) {
  const f = app.vault.getAbstractFileByPath(CONFIG_PATH);
  const fm = (f && app.metadataCache.getFileCache(f)?.frontmatter) || {};
  const cfg = Object.assign({}, DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) if (fm[k] !== undefined && fm[k] !== null && fm[k] !== "") cfg[k] = fm[k];
  cfg.project_roots = toArr(cfg.project_roots).map((r) => r.replace(/\/+$/, ""));
  cfg.weeks_folder = String(cfg.weeks_folder).replace(/\/+$/, "");
  for (const k of ["goals_min", "goals_max", "focus_priority", "plan_next_week_from", "upcoming_days", "llm_flag_below", "llm_examples_per_project", "llm_batch", "llm_context", "calendar_default_minutes", "calendar_sync_minutes"]) cfg[k] = Number(cfg[k]);
  return cfg;
}

/* ------------------------------------------------------------------ markdown */

const FIELD_SRC = "\\[([A-Za-z][\\w-]*)::\\s*((?:\\[\\[[^\\]]*\\]\\]|[^\\[\\]])*?)\\s*\\]";
const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[(.)\](?:[ \t]+|$))?(.*)$/;
const HEAD_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;

function parseFields(text) {
  const out = {};
  const re = new RegExp(FIELD_SRC, "g");
  let m;
  while ((m = re.exec(text))) out[m[1].toLowerCase()] = m[2].trim();
  return out;
}
function stripFields(text) { return text.replace(new RegExp(FIELD_SRC, "g"), "").replace(/\s{2,}/g, " ").trim(); }
function setField(line, key, value) {
  const re = new RegExp(`[ \\t]*\\[${key}::\\s*(?:\\[\\[[^\\]]*\\]\\]|[^\\[\\]])*?\\s*\\]`, "i");
  if (value === null || value === undefined || value === "") return line.replace(re, "");
  const tag = ` [${key}:: ${value}]`;
  if (re.test(line)) return line.replace(re, tag);
  return insertBeforeMeta(line, tag.trim());
}
function setStatus(line, ch) { return line.replace(/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[.\]/, `$1[${ch}]`); }
function indentWidth(ws) { let w = 0; for (const c of ws) w += c === "\t" ? 4 : 1; return w; }
const isDone = (t) => t.status === "x" || t.status === "X";
const isOpen = (t) => t.status === " " || t.status === "/";
/** A task moved to another week / back to the backlog: cancelled in Tasks, but still counts as planned-not-done. */
const isMoved = (t) => t.status === "-" && /⇢/.test(t.body || "");
const countsAsPlanned = (t) => t.status !== "-" || isMoved(t);
/** Cancelled on purpose (Cancel task, or dropped in the review): not done, not planned — left out of every score. */
const isCancelled = (t) => t.status === "-" && !isMoved(t) && !/\[missed::/i.test(String(t.raw || t.body || ""));

/* Tasks plugin signifiers. Tasks reads them from the END of the line, so anything we add goes before them. */
const SIG_RE = /(?:📅|🗓️?|⏳|⌛|🛫|➕|✅|❌|🔁|⏫|🔼|🔽|🔺|⏬|🆔|⛔|🏁)/u;
function metaStart(line) {
  const box = line.match(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]*)?/);
  const from = box ? box[0].length : 0;
  const m = line.slice(from).match(SIG_RE);
  return m ? from + m.index : -1;
}
function splitMeta(line) {
  const i = metaStart(line);
  return i < 0 ? { head: line.replace(/\s+$/, ""), meta: "" } : { head: line.slice(0, i).replace(/\s+$/, ""), meta: line.slice(i).trim() };
}
function joinMeta(head, meta) { return meta ? `${head} ${meta}` : head; }
/** Insert text right before the Tasks signifiers (or at the end). */
function insertBeforeMeta(line, text) { const { head, meta } = splitMeta(line); return joinMeta(`${head} ${text}`, meta); }
const DATE_SIG = { due: "📅", scheduled: "⏳", start: "🛫", created: "➕", done: "✅", cancelled: "❌" };
function getDate(line, key) {
  const e = DATE_SIG[key];
  const alt = key === "due" ? "(?:📅|🗓️?)" : key === "scheduled" ? "(?:⏳|⌛)" : e;
  const m = line.match(new RegExp(`${alt}\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})`, "u"));
  return m ? m[1] : null;
}
function setDate(line, key, date) {
  const e = DATE_SIG[key];
  const alt = key === "due" ? "(?:📅|🗓️?)" : key === "scheduled" ? "(?:⏳|⌛)" : e;
  let out = line.replace(new RegExp(`\\s*${alt}\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}`, "u"), "");
  return date ? `${out.replace(/\s+$/, "")} ${e} ${date}` : out;
}
const PRIO_SIG = [["🔺", 0, "highest"], ["⏫", 1, "high"], ["🔼", 2, "medium"], ["🔽", 4, "low"], ["⏬", 5, "lowest"]];
function prioOf(line) { const p = PRIO_SIG.find(([e]) => line.includes(e)); return p ? p[2] : "normal"; }
function setPrio(line, name) {
  let out = line;
  for (const [e] of PRIO_SIG) out = out.split(` ${e}`).join("").split(e).join("");
  const p = PRIO_SIG.find((x) => x[2] === name);
  return p ? `${out.replace(/\s+$/, "")} ${p[0]}` : out;
}
function taskLabel(it) {
  const p = prioOf(it.raw);
  const bits = [];
  const due = getDate(it.raw, "due"), sch = getDate(it.raw, "scheduled");
  if (sch) bits.push(`⏳ ${sch.slice(5)}`);
  if (due) bits.push(`📅 ${due.slice(5)}`);
  const est = timeOf(it.raw).est;
  if (est) bits.push(`≈${fmtDur(est)}`);
  return `${p === "highest" || p === "high" ? "‼ " : p === "low" || p === "lowest" ? "· " : ""}${it.desc}${bits.length ? "  " + bits.join(" ") : ""}`;
}

/** Lines that are frontmatter or inside code fences — never treated as structure. */
function maskedLines(lines) {
  const mask = new Array(lines.length).fill(false);
  let i = 0;
  if (lines[0] === "---") {
    mask[0] = true;
    for (i = 1; i < lines.length; i++) { mask[i] = true; if (lines[i] === "---" || lines[i] === "...") { i++; break; } }
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const f = lines[i].match(/^\s*(```+|~~~+)/);
    if (fence) { mask[i] = true; if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; }
    else if (f) { fence = f[1]; mask[i] = true; }
  }
  return mask;
}

function findSection(lines, name) {
  const mask = maskedLines(lines);
  const target = name.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const h = lines[i].match(HEAD_RE);
    if (!h || h[2].trim().toLowerCase() !== target) continue;
    const lvl = h[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (mask[j]) continue;
      const h2 = lines[j].match(HEAD_RE);
      if (h2 && h2[1].length <= lvl) { end = j; break; }
    }
    return { head: i, start: i + 1, end, level: lvl };
  }
  return null;
}

function parseItems(lines, start = 0, end = lines.length) {
  const mask = maskedLines(lines);
  const items = [], stack = [];
  for (let i = start; i < end; i++) {
    if (mask[i]) { stack.length = 0; continue; }
    const m = lines[i].match(LIST_RE);
    if (!m) { if (/^\S/.test(lines[i])) stack.length = 0; continue; }
    const it = { line: i, raw: lines[i], ws: m[1], indent: indentWidth(m[1]), task: m[2] !== undefined, status: m[2] === undefined ? null : m[2], body: m[3], children: [], parent: null };
    it.fields = parseFields(it.body);
    it.text = stripFields(it.body);
    it.desc = stripFields(splitMeta(it.body).head).replace(/^🎯\s*/u, "");
    while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
    if (stack.length) { it.parent = stack[stack.length - 1]; it.parent.children.push(it); }
    stack.push(it);
    items.push(it);
  }
  return items;
}
function descendants(it) { const out = []; (function rec(x) { for (const c of x.children) { out.push(c); rec(c); } })(it); return out; }
/** Index just after the last line belonging to an item (its children and continuation lines). */
function blockEnd(lines, it) {
  let end = it.line + 1;
  for (let i = it.line + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (indentWidth(lines[i].match(/^[ \t]*/)[0]) > it.indent) end = i + 1; else break;
  }
  return end;
}
function dedent(block, ws) { return block.map((l) => (l.startsWith(ws) ? l.slice(ws.length) : l.replace(/^[ \t]+/, ""))); }

function insertIntoSection(lines, name, newLines, level = 2) {
  if (!newLines.length) return;
  const sec = findSection(lines, name);
  if (!sec) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", "#".repeat(level) + " " + name, ...newLines, "");
    return;
  }
  let pos = sec.start;
  for (let i = sec.start; i < sec.end; i++) if (lines[i].trim() !== "") pos = i + 1;
  const ins = [...newLines];
  if (pos > sec.start && !LIST_RE.test(lines[pos - 1]) && !/^\s/.test(lines[pos - 1])) ins.unshift("");
  if (pos < lines.length && HEAD_RE.test(lines[pos])) ins.push("");
  lines.splice(pos, 0, ...ins);
}
/** Like insertIntoSection, but a missing "## Planned" is created just above "## Backlog". */
function insertIntoProjectSection(lines, name, newLines) {
  if (!newLines.length) return;
  if (!findSection(lines, name) && name === PLANNED_SEC) {
    const b = findSection(lines, "Backlog");
    if (b) { lines.splice(b.head, 0, `## ${name}`, ...newLines, ""); return; }
  }
  if (!findSection(lines, name) && name === UNPLANNED_SEC) {
    const pl = findSection(lines, PLANNED_SEC), b = findSection(lines, "Backlog");
    const at = pl ? pl.end : b ? b.head : -1;
    if (at >= 0) { lines.splice(at, 0, ...(at > 0 && lines[at - 1].trim() !== "" ? [""] : []), `## ${name}`, ...newLines, ""); return; }
  }
  insertIntoSection(lines, name, newLines);
}
/** Make sure a project note has Planned / Backlog / Notes & ideas sections. Returns true if it changed. */
function ensureProjectSections(lines) {
  let changed = false;
  if (!findSection(lines, "Backlog")) { while (lines.length && lines[lines.length - 1].trim() === "") lines.pop(); lines.push("", "## Backlog", ""); changed = true; }
  if (!findSection(lines, PLANNED_SEC)) { const b = findSection(lines, "Backlog"); lines.splice(b.head, 0, `## ${PLANNED_SEC}`, ""); changed = true; }
  if (!findSection(lines, "Notes & ideas")) { while (lines.length && lines[lines.length - 1].trim() === "") lines.pop(); lines.push("", "## Notes & ideas", ""); changed = true; }
  return changed;
}
function replaceSection(lines, name, newLines, level = 2) {
  const sec = findSection(lines, name);
  if (!sec) return insertIntoSection(lines, name, newLines, level);
  const after = sec.end < lines.length ? [""] : [];
  lines.splice(sec.start, sec.end - sec.start, ...newLines, ...after);
}

/* ------------------------------------------------------------------ vault io */

async function readPath(app, path) {
  const f = app.vault.getAbstractFileByPath(path);
  return f ? app.vault.read(f) : null;
}
async function ensureFolder(app, path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
  }
}
async function createFile(app, path, content) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir) await ensureFolder(app, dir);
  return app.vault.create(path, content);
}
async function editFile(app, path, fn) {
  const f = app.vault.getAbstractFileByPath(path);
  if (!f) throw new Error(`File not found: ${path}`);
  if (app.vault.process) return app.vault.process(f, (c) => fn(c));
  const c = await app.vault.read(f);
  return app.vault.modify(f, fn(c));
}
async function editLines(app, path, fn) {
  return editFile(app, path, (c) => { const lines = c.split("\n"); fn(lines); return lines.join("\n"); });
}

/* ------------------------------------------------------------------ links */

function linkTo(app, path, from, alias) {
  const f = app.vault.getAbstractFileByPath(path);
  const text = f ? app.metadataCache.fileToLinktext(f, from || "", true) : path.replace(/\.md$/, "");
  return alias && alias !== text.split("/").pop() ? `[[${text}|${alias}]]` : `[[${text}]]`;
}
function projectLink(app, path, from) {
  const p = listProjects(app, getConfig(app)).find((x) => x.path === path);
  return linkTo(app, path, from, p && p.name);
}
function linkLabel(v) {
  const m = String(v || "").match(/\[\[([^\]]+)\]\]/);
  if (!m) return String(v || "").trim();
  const [target, alias] = m[1].split("|");
  return (alias || target.split("#")[0].split("/").pop()).trim();
}
function resolveProject(app, value, from, projects) {
  if (!value) return null;
  const m = String(value).match(/\[\[([^\]|#]+)/);
  if (m) {
    const f = app.metadataCache.getFirstLinkpathDest(m[1].trim(), from || "");
    if (f) return f.path;
  }
  const name = linkLabel(value).toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === name || p.file.basename.toLowerCase() === name)?.path || null;
}

/* ------------------------------------------------------------------ model */

function listProjects(app, cfg) {
  const out = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith(TRACKER_ROOT + "/")) continue;
    const root = cfg.project_roots.find((r) => f.path.startsWith(r + "/"));
    if (cfg.project_roots.length && !root) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || fm.type !== "project") continue;
    const folder = f.parent && f.parent.path ? f.parent : null;
    const grand = folder && folder.parent && folder.parent.path ? folder.parent.name : "";
    out.push({
      path: f.path, file: f, name: String(fm.title || (folder && folder.path !== root ? folder.name : f.basename)),
      status: String(fm.status || "active").toLowerCase(),
      scope: String(fm.scope || (root ? root.split("/").pop() : grand) || "").toLowerCase(),
      description: String(fm.description || ""), objective: String(fm.objective || ""),
      keywords: toArr(fm.keywords),
      routine: String(fm.kind || "").toLowerCase() === "routine",
      priority: normPriority(fm.priority),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
/* Project priority (frontmatter `priority`): 1 (top) … 5 (someday), set in Tracker/Projects. Unset = 3.
   Older notes may still say high / medium / low: read as 2 / 3 / 4 (Register projects rewrites them). */
const PROJECT_PRIOS = [1, 2, 3, 4, 5];
const PRIO_LABEL = { 1: "1 · top", 2: "2 · high", 3: "3 · medium", 4: "4 · low", 5: "5 · someday" };
const LEGACY_PRIO = { high: 2, h: 2, medium: 3, m: 3, low: 4, l: 4 };
function normPriority(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (/^[1-5]$/.test(s)) return Number(s);
  return LEGACY_PRIO[s] || 3;
}
const projPrioRank = (p) => p.priority || 3;
const isTopPrio = (cfg, p) => (p.priority || 3) <= (Number(cfg.focus_priority) || 0);
/** Rewrite high / medium / low (older versions) as 2 / 3 / 4. Returns how many notes changed. */
async function migratePriorities(app, cfg) {
  let n = 0;
  for (const p of listProjects(app, cfg)) {
    const fm = app.metadataCache.getFileCache(p.file)?.frontmatter || {};
    const v = String(fm.priority ?? "").trim().toLowerCase();
    if (!LEGACY_PRIO[v]) continue;
    await app.fileManager.processFrontMatter(p.file, (f) => { f.priority = LEGACY_PRIO[v]; });
    n++;
  }
  return n;
}
function weekPath(cfg, id) { return `${cfg.weeks_folder}/${id}.md`; }
function weekFiles(app, cfg) {
  const pre = cfg.weeks_folder + "/";
  return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(pre) && app.metadataCache.getFileCache(f)?.frontmatter?.type === "week");
}

function parseWeek(content) {
  const lines = content.split("\n");
  const goals = [];
  const sec = findSection(lines, "Goals");
  if (sec) {
    for (const g of parseItems(lines, sec.start, sec.end)) {
      if (g.parent || !g.desc) continue;
      goals.push({ item: g, line: g.line, raw: g.raw, text: g.desc, status: g.status, done: g.task && isDone(g), fields: g.fields, tasks: descendants(g).filter((t) => t.task) });
    }
  }
  const review = {};
  const rs = findSection(lines, "Review");
  if (rs) for (let i = rs.start; i < rs.end; i++) {
    const m = lines[i].match(/^\s*(?:[-*]\s+)?([A-Za-z][\w ]*?)::\s*(.*)$/);
    if (m) review[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return { lines, goals, review };
}
function scoreGoal(g) {
  if (g.done) return 100;
  const r = parseFloat(g.fields.result);
  if (!isNaN(r)) return clamp(Math.round(r), 0, 100);
  const counted = g.tasks.filter(countsAsPlanned);
  if (!counted.length) return 0;
  return Math.round((100 * counted.filter(isDone).length) / counted.length);
}
function inboxItems(lines) {
  const sec = findSection(lines, "Queue");
  const items = sec ? parseItems(lines, sec.start, sec.end) : parseItems(lines);
  return items.filter((i) => i.task && !i.parent && i.status === " " && i.text);
}
function backlogItems(lines) {
  const sec = findSection(lines, "Backlog");
  return sec ? parseItems(lines, sec.start, sec.end).filter((i) => i.task && !i.parent && isOpen(i)) : [];
}
const PRIO_RANK = { highest: 0, high: 1, medium: 2, normal: 3, low: 4, lowest: 5 };
const prioRank = (it) => PRIO_RANK[prioOf(it.raw)];
const byPrioDue = (a, b) => prioRank(a) - prioRank(b) || String(getDate(a.raw, "due") || "9999").localeCompare(String(getDate(b.raw, "due") || "9999"));

/* ------------------------------------------------------------------ routines */
// A routine project (frontmatter `kind: routine`, one per scope) holds recurring tasks (Tasks 🔁).
// Each task line is one occurrence of its routine (routines are told apart by their text) and counts in the
// ISO week of its date: 📅 due, else ⏳ scheduled, else 🛫 start. Routine projects are always in focus,
// need no weekly goal and are scored separately: done ÷ (done + missed).
// A missed occurrence (open, date before today) is cancelled as `[-] … [missed:: yes] ❌ <today>` and the next
// occurrence is created — repeatedly, so every missed day/week/month is recorded.

const RULE_RE = /🔁️?\s*(.+?)\s*(?=(?:📅|🗓️?|⏳|⌛|🛫|➕|✅|❌|🔁|⏫|🔼|🔽|🔺|⏬|🆔|⛔|🏁)|$)/u;
function ruleOf(line) { const m = String(line).match(RULE_RE); return m ? m[1].trim() : null; }
function refDate(line) { return getDate(line, "due") || getDate(line, "scheduled") || getDate(line, "start"); }
function freqOf(rule) {
  const r = String(rule || "").toLowerCase().replace(/\s+when done$/, "");
  if (/^every (1 )?day$|^every weekday$/.test(r)) return "daily";
  if (/^every (\d+ )?weeks?\b/.test(r)) return "weekly";
  if (/^every (\d+ )?months?\b/.test(r)) return "monthly";
  if (/^every (\d+ )?years?\b|^every (january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(r)) return "yearly";
  return "other";
}
const isoD = (iso) => new Date(iso + "T00:00:00Z");
const isoS = (d) => d.toISOString().slice(0, 10);
function isoAdd(iso, n) { const d = isoD(iso); d.setUTCDate(d.getUTCDate() + n); return isoS(d); }
const isoDiff = (a, b) => Math.round((isoD(b) - isoD(a)) / 864e5); // b − a, in days
const isoDow = (iso) => isoD(iso).getUTCDay() || 7;           // 1 = Mon … 7 = Sun
const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
function monthsAdd(iso, n, day) {
  const d = isoD(iso), mo = d.getUTCMonth() + n;
  const y = d.getUTCFullYear() + Math.floor(mo / 12), m = ((mo % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return isoS(new Date(Date.UTC(y, m, day === "last" ? last : Math.min(day || d.getUTCDate(), last))));
}
/** Next occurrence after `ref` for the common Tasks rules; null when the rule isn't understood. */
function nextOccurrence(rule, ref) {
  const r = String(rule).toLowerCase().replace(/\s+when done$/, "").replace(/\s+/g, " ").trim();
  let m;
  if ((m = r.match(/^every (?:(\d+) )?days?$/))) return isoAdd(ref, Number(m[1] || 1));
  if (r === "every weekday") { let x = isoAdd(ref, 1); while (isoDow(x) > 5) x = isoAdd(x, 1); return x; }
  if ((m = r.match(/^every (?:(\d+) )?weeks?(?: on (.+))?$/))) {
    const n = Number(m[1] || 1);
    if (!m[2]) return isoAdd(ref, 7 * n);
    const days = m[2].split(/,|\band\b/).map((s) => DAY_NAMES.indexOf(s.trim()) + 1).filter((x) => x > 0).sort((a, b) => a - b);
    if (!days.length) return null;
    const dow = isoDow(ref), later = days.find((x) => x > dow);
    return later ? isoAdd(ref, later - dow) : isoAdd(ref, 7 * n - dow + days[0]);
  }
  if ((m = r.match(/^every (?:(\d+) )?months?(?: on the (last|\d+)(?:st|nd|rd|th)?)?$/))) return monthsAdd(ref, Number(m[1] || 1), m[2] ? (m[2] === "last" ? "last" : Number(m[2])) : null);
  if ((m = r.match(/^every (?:(\d+) )?years?$/))) return monthsAdd(ref, 12 * Number(m[1] || 1), null);
  return null;
}
/** The next occurrence's line: all dates shifted by `delta` days, no done/cancelled date, ➕ today. */
function shiftOccurrence(line, delta, today) {
  let out = line;
  for (const k of ["due", "scheduled", "start"]) { const v = getDate(out, k); if (v) out = setDate(out, k, isoAdd(v, delta)); }
  out = setField(setDate(setDate(out, "done", null), "cancelled", null), "cal", null);
  return setDate(out, "created", today);
}
function markMissed(line, today) {
  return setDate(setField(setDate(setStatus(line, "-"), "done", null), "missed", "yes"), "cancelled", today);
}
/** Roll one open routine line whose date has passed. → { lines: [next open, …missed newest first], missed } or null. */
async function rollLine(line, rule, today, api, path) {
  const whenDone = /\bwhen done\s*$/i.test(rule);
  const missed = [];
  let cur = line;
  for (let guard = 0; guard < 400; guard++) {
    const ref = refDate(cur);
    if (!ref || ref >= today) break;
    const nextIso = whenDone ? today : nextOccurrence(rule, ref);
    let next;
    if (nextIso) next = shiftOccurrence(cur, isoDiff(ref, nextIso), today);
    else if (api) { // a rule we don't parse: let the Tasks plugin compute the next occurrence
      const out = String((await api.executeToggleTaskDoneCommand(cur, path)) || "").split("\n");
      next = out.find((l) => /^\s*[-*+]\s+\[ \]/.test(l));
      if (!next) return null;
      next = next.replace(/^[ \t]+/, "");
      if (refDate(next) && refDate(next) <= ref) return null; // no progress — give up rather than loop
    } else return null;
    missed.push(markMissed(cur, today));
    cur = next;
  }
  return missed.length ? { lines: [cur, ...missed.reverse()], missed: missed.length } : null;
}
/** Cancel every missed occurrence in the active routine projects and create the next ones. Returns { missed, stuck }. */
async function rollRoutines(app, today) {
  const cfg = getConfig(app), api = tasksPluginApi(app);
  let missed = 0;
  const stuck = [];
  for (const p of listProjects(app, cfg).filter((x) => x.routine && x.status === "active")) {
    const lines = (await app.vault.read(p.file)).split("\n");
    const jobs = [];
    for (const it of parseItems(lines)) {
      if (!it.task || it.parent || !isOpen(it)) continue;
      const rule = ruleOf(it.raw), ref = refDate(it.raw);
      if (!rule || !ref || ref >= today) continue;
      const rep = await rollLine(it.raw.replace(/^[ \t]+/, ""), rule, today, api, p.path);
      if (rep) jobs.push({ it, rep }); else stuck.push(`${p.name}: ${it.desc} (🔁 ${rule})`);
    }
    if (!jobs.length) continue;
    await editLines(app, p.path, (ls) => {
      for (const { it, rep } of jobs.reverse()) { // bottom-up, so earlier line numbers stay valid
        const k = locateRaw(ls, it.raw, it.line);
        if (k < 0) continue;
        ls.splice(k, 1, ...rep.lines.map((l) => it.ws + l));
        missed += rep.missed;
      }
    });
  }
  return { missed, stuck };
}
/** Move finished (done or cancelled) routine occurrences up to week `uptoWeek` into ## Done. Returns how many. */
function archiveRoutineLines(ls, uptoWeek) {
  const m = getMoment();
  const dsec = findSection(ls, DONE_SEC);
  const inDone = (i) => dsec && i >= dsec.start && i < dsec.end;
  const take = parseItems(ls).filter((t) => t.task && !t.parent && !inDone(t.line) && (isDone(t) || t.status === "-") && ruleOf(t.raw) && refDate(t.raw)
    && weekId(m(refDate(t.raw), "YYYY-MM-DD")) <= uptoWeek);
  const moved = [];
  for (const t of [...take].reverse()) {
    const end = blockEnd(ls, t);
    moved.unshift(...dedent(ls.slice(t.line, end), t.ws).filter((l) => l.trim() !== ""));
    ls.splice(t.line, end - t.line);
  }
  insertIntoSection(ls, DONE_SEC, moved);
  return take.length;
}
// mins = time spent on done occurrences: the logged hands-on time, or else the routine's estimate (assumed)
const R0 = () => ({ done: 0, missed: 0, upcoming: 0, skipped: 0, mins: 0, passive: 0, logged: 0, assumed: 0 });
const rTime = (a) => (a && a.mins ? fmtDur(a.mins) : "–");
const rTimeTitle = (a) => (a && (a.logged || a.assumed) ? `${a.logged} logged · ${a.assumed} from the estimate${a.passive ? ` · ⌛ ${fmtDur(a.passive)} passive` : ""}` : "no time logged and no estimate");
/** Average time per week over the last n closed weeks that had occurrences. */
function rWeekAvg(map, ids, n) { const ws = ids.filter((id) => map.get(id) && map.get(id).done + map.get(id).missed + map.get(id).skipped).slice(-n); return ws.length ? Math.round(sum(ws.map((id) => map.get(id).mins)) / ws.length) : null; }
const rPct = (a) => (a && a.done + a.missed ? Math.round((100 * a.done) / (a.done + a.missed)) : null);
function rSum(map, ids) { const out = R0(); for (const id of ids) { const a = map.get(id); if (a) for (const k of Object.keys(out)) out[k] += a[k]; } return out; }
/** Routines and their occurrences, per routine and per week (the "integral" over all routines). */
function loadRoutines(d, linesByPath) {
  const m = getMoment(), today = d.today.format("YYYY-MM-DD");
  const routines = [], byKey = new Map(), weeks = new Map();
  for (const p of d.projects) {
    if (!p.routine) continue;
    for (const it of parseItems(linesByPath.get(p.path) || [])) {
      if (!it.task || it.parent) continue;
      const rule = ruleOf(it.raw);
      if (!rule) continue;
      const key = `${p.path}|${it.desc.toLowerCase()}`;
      let r = byKey.get(key);
      if (!r) { r = { key, name: it.desc, project: p, rule, freq: freqOf(rule), weeks: new Map(), next: null }; byKey.set(key, r); routines.push(r); }
      const ref = refDate(it.raw);
      if (isOpen(it)) { r.rule = rule; r.freq = freqOf(rule); if (ref && (!r.next || ref < r.next)) r.next = ref; }
      if (!ref) continue;
      let state = isDone(it) ? "done" : it.status === "-" ? (/\[missed::/i.test(it.raw) ? "missed" : "skipped") : ref < today ? "missed" : "upcoming";
      if (state === "missed" && isOpen(it) && p.status !== "active") state = "skipped"; // paused project: not held against you
      const wid = weekId(m(ref, "YYYY-MM-DD"));
      const tm = state === "done" ? timeOf(it.raw) : null;
      for (const map of [r.weeks, weeks]) {
        if (!map.has(wid)) map.set(wid, R0());
        const a = map.get(wid);
        a[state]++;
        if (tm) { if (tm.active) { a.mins += tm.active; a.logged++; } else if (tm.est) { a.mins += tm.est; a.assumed++; } a.passive += tm.passive || 0; }
      }
    }
  }
  const order = { daily: 0, weekly: 1, monthly: 2, yearly: 3, other: 4 };
  routines.sort((a, b) => a.project.name.localeCompare(b.project.name) || order[a.freq] - order[b.freq] || a.name.localeCompare(b.name));
  d.routines = routines;
  d.routineWeeks = weeks;
}
/** Mean of the weekly routine % over the last n weeks before `before` that had routine occurrences. */
function routineAvg(d, before, n, routine = null) {
  const map = routine ? routine.weeks : d.routineWeeks;
  const v = [...map.keys()].filter((w) => w < before).sort().map((w) => rPct(map.get(w))).filter((x) => x !== null).slice(-n);
  return v.length ? Math.round(mean(v)) : null;
}
/** Is this path inside a routine project? (for "done outside goals") */
function routinePathTest(app) {
  const cfg = getConfig(app), ctx = { cfg, projects: listProjects(app, cfg) };
  return (path) => { const p = projectOfPath(ctx, path); return !!(p && p.routine); };
}

async function loadAll(app) {
  const cfg = getConfig(app);
  const m = getMoment();
  const projects = listProjects(app, cfg);
  const byPath = new Map(projects.map((p) => [p.path, p]));
  const linesByPath = new Map();
  for (const p of projects) {
    const lines = (await app.vault.cachedRead(p.file)).split("\n");
    linesByPath.set(p.path, lines);
    p.backlog = backlogItems(lines).sort(byPrioDue);
    p.okr = parseOkr(lines);
    p.openPlanned = parseItems(lines).filter((t) => t.task && !t.parent && isOpen(t) && t.fields.week).length;
    const ns = findSection(lines, "Notes & ideas");
    p.notes = ns ? parseItems(lines, ns.start, ns.end).filter((i) => !i.parent) : [];
  }
  // Tasks picked for a week live in their project's notes, marked [week:: 2026-W46].
  // [from:: 2026-W45] remembers weeks a task was planned for before (carried or returned).
  const sel = new Map();
  const bucket = (wid, pp) => {
    if (!sel.has(wid)) sel.set(wid, new Map());
    const m2 = sel.get(wid);
    if (!m2.has(pp)) m2.set(pp, { here: [], carried: [] });
    return m2.get(pp);
  };
  const scopeCtx = { cfg, projects };
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith(TRACKER_ROOT + "/")) continue;
    const p = projectOfPath(scopeCtx, f.path);
    if (!p) continue;
    const content = await app.vault.cachedRead(f);
    if (!content.includes("[week::") && !content.includes("[from::")) continue;
    const flines = content.split("\n"), us = findSection(flines, UNPLANNED_SEC);
    for (const it of parseItems(flines)) {
      if (!it.task) continue;
      const wk = weekIds(it.fields.week)[0] || null;
      const from = weekIds(it.fields.from);
      if (!wk && !from.length) continue;
      const t = { path: f.path, line: it.line, raw: it.raw, body: it.body, text: it.body, status: it.status, fields: it.fields, desc: it.desc, week: wk, from, projectPath: p.path,
        unplannedIn: weekIds(it.fields.unplanned), inUnplanned: !!(us && it.line >= us.start && it.line < us.end) };
      if (wk) bucket(wk, p.path).here.push(t);
      for (const fw of from) if (fw !== wk) bucket(fw, p.path).carried.push(t);
    }
  }
  const weeks = [], seen = new Set();
  for (const f of weekFiles(app, cfg)) {
    const fm = app.metadataCache.getFileCache(f).frontmatter;
    const id = String(fm.week || f.basename);
    if (!weekStart(id) || seen.has(id)) continue;
    seen.add(id);
    const w = parseWeek(await app.vault.cachedRead(f));
    Object.assign(w, { id, path: f.path, file: f, status: String(fm.status || "planned").toLowerCase() });
    for (const g of w.goals) {
      g.projectPath = resolveProject(app, g.fields.project, f.path, projects);
      g.projectName = byPath.get(g.projectPath)?.name || linkLabel(g.fields.project) || "(no project)";
    }
    weeks.push(w);
  }
  // weeks that only have picked tasks (no week note yet)
  for (const wid of sel.keys()) if (!seen.has(wid) && weekStart(wid)) { seen.add(wid); weeks.push({ id: wid, path: weekPath(cfg, wid), file: null, virtual: true, status: "planned", goals: [], review: {}, lines: [] }); }
  weeks.sort((a, b) => a.id.localeCompare(b.id));
  for (const w of weeks) attachSelections(w, sel.get(w.id), byPath);
  const inbox = { path: cfg.inbox, open: 0, free: 0, review: !!(await loadSnap(app)) };
  const ib = app.vault.getAbstractFileByPath(cfg.inbox);
  if (ib) {
    const items = inboxItems((await app.vault.cachedRead(ib)).split("\n"));
    inbox.open = items.length;
    inbox.free = inboxFree((await app.vault.cachedRead(ib)).split("\n")).idx.length;
  }
  const d = computeStats({ app, cfg, projects, byPath, weeks, sel, inbox, today: m(), curId: weekId(m()) });
  loadRoutines(d, linesByPath);
  return d;
}

/** Attach each week's picked tasks to the goal of their project (or to w.extra when the project has no goal). */
function attachSelections(w, m2, byPath) {
  const used = new Set();
  for (const g of w.goals) {
    const b = g.projectPath && !used.has(g.projectPath) && m2 ? m2.get(g.projectPath) : null;
    if (g.projectPath) used.add(g.projectPath);
    g.legacy = g.tasks;                       // tasks nested under the goal in the week note (older plans)
    g.here = b ? b.here : [];                 // tasks in project notes marked for this week
    g.carriedOut = b ? b.carried : [];        // planned this week, moved on later → planned, not done
    g.tasks = [...g.legacy, ...g.here];
    g.counted = [...g.legacy.filter(countsAsPlanned), ...g.here.filter((t) => t.status !== "-"), ...g.carriedOut];
    g.doneCount = g.legacy.filter(isDone).length + g.here.filter(isDone).length;
    g.cancelled = [...g.legacy, ...g.here].filter(isCancelled);
    g.score = goalScore(g);
  }
  w.extra = [];
  if (m2) for (const [pp, b] of m2) {
    if (used.has(pp)) continue;
    w.extra.push({ projectPath: pp, projectName: byPath.get(pp)?.name || pp, here: b.here, carriedOut: b.carried,
      counted: [...b.here.filter((t) => t.status !== "-"), ...b.carried], doneCount: b.here.filter(isDone).length, cancelled: b.here.filter(isCancelled) });
  }
}
function goalScore(g) {
  if (g.done) return 100;
  const r = parseFloat(g.fields.result);
  if (!isNaN(r)) return clamp(Math.round(r), 0, 100);
  if (!g.counted.length) return 0;
  return Math.round((100 * g.doneCount) / g.counted.length);
}

function computeStats(d) {
  for (const w of d.weeks) {
    const gs = w.goals;
    w.m = {
      goals: gs.length,
      achieved: gs.filter((g) => g.score >= 100).length,
      avg: gs.length ? Math.round(mean(gs.map((g) => g.score))) : null,
      planned: sum(gs.map((g) => g.counted.length)) + sum((w.extra || []).map((x) => x.counted.length)),
      done: sum(gs.map((g) => g.doneCount)) + sum((w.extra || []).map((x) => x.doneCount)),
      carriedIn: gs.filter((g) => g.fields.from).length,
      cancelled: sum(gs.map((g) => g.cancelled.length)) + sum((w.extra || []).map((x) => x.cancelled.length)),
    };
  }
  d.weekMap = new Map(d.weeks.map((w) => [w.id, w]));
  // Planned vs unplanned (Add tasks): every task picked for a week, per project; dropped ones don't count.
  d.mix = new Map();
  for (const [wid, m2] of d.sel) {
    const pm = new Map();
    for (const [pp, b] of m2) {
      const a = { planned: 0, unplanned: 0, plannedDone: 0, unplannedDone: 0, cancelled: 0 };
      for (const t of b.here) { if (isCancelled(t)) a.cancelled++; if (t.status === "-") continue; const k = isUnplannedIn(t, wid) ? "unplanned" : "planned"; a[k]++; if (isDone(t)) a[k + "Done"]++; }
      for (const t of b.carried) a[isUnplannedIn(t, wid) ? "unplanned" : "planned"]++; // planned that week, moved on: not done
      pm.set(pp, a);
    }
    d.mix.set(wid, pm);
  }
  // Time: estimates and time spent on the tasks picked for each week (dropped ones don't count)
  d.time = new Map();
  for (const [wid, m2] of d.sel) {
    const pm = new Map();
    for (const [pp, b] of m2) { const a = T0(); for (const t of b.here) if (t.status !== "-") tAdd(a, t); pm.set(pp, a); }
    d.time.set(wid, pm);
  }
  for (const w of d.weeks) {
    const a = mixSum(d, [w.id]);
    w.m.unplanned = a.unplanned; w.m.unplannedDone = a.unplannedDone; w.m.plannedOnly = a.planned;
  }
  for (const p of d.projects) p.history = [];
  for (const w of d.weeks) for (const g of w.goals) {
    const p = d.byPath.get(g.projectPath);
    if (p) p.history.push({ week: w.id, goal: g, score: g.score });
  }
  for (const p of d.projects) {
    const past = p.history.filter((h) => h.week <= d.curId);
    p.focusWeeks = new Set(past.map((h) => h.week)).size;
    p.lastFocus = past.length ? past[past.length - 1].week : null;
    p.weeksSince = p.lastFocus ? weeksBetween(p.lastFocus, d.curId) : null;
    const closed = past.filter((h) => h.week < d.curId || d.weekMap.get(h.week)?.status === "reviewed");
    p.avg = closed.length ? Math.round(mean(closed.map((h) => h.score))) : null;
    p.tasksDone = sum(p.history.map((h) => h.goal.doneCount));
    p.recentAvg = (() => { const r = closed.slice(-4); return r.length ? Math.round(mean(r.map((h) => h.score))) : null; })();
  }
  d.reasons = {};
  for (const w of d.weeks) for (const g of w.goals) if (g.fields.miss) {
    const k = g.fields.miss.toLowerCase();
    d.reasons[k] = (d.reasons[k] || 0) + 1;
  }
  return d;
}

/** Last n week ids ending at the later of the current week and the last planned week. */
function timeline(d, n, { trim = false, min = 6 } = {}) {
  const lastPlanned = d.weeks.length ? d.weeks[d.weeks.length - 1].id : d.curId;
  const end = lastPlanned > d.curId ? lastPlanned : d.curId;
  let out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftWeek(end, -i));
  if (trim && d.weeks.length) {
    const first = d.weeks[0].id;
    const kept = out.filter((id) => id >= first);
    out = out.slice(Math.max(0, out.length - Math.max(kept.length, Math.min(min, n))));
  }
  return out;
}

/* ------------------------------------------------------------------ time: estimates and time spent
 * On a task line:  [est:: 2h]        estimate of the hands-on time
 *                  [active:: 1h30m]  hands-on time actually spent
 *                  [passive:: 3h]    time it took without your attention (drying, waiting for a reply, a long upload)
 * Durations: 45m · 2h · 1h30m · 1.5h · 1:30 · a plain number = minutes. Stored as 1h30m. */
const TIME_KEYS = ["est", "active", "passive"];
function parseDur(s) {
  const v = String(s ?? "").trim().toLowerCase().replace(/\s+/g, "").replace(/,/g, ".");
  if (!v) return null;
  let m = v.match(/^(\d+):([0-5]?\d)$/);
  if (m) return +m[1] * 60 + +m[2];
  if (/^\d+$/.test(v)) return +v;
  m = v.match(/^(?:(\d+(?:\.\d+)?)h(?:rs?|ours?)?)?(?:(\d+)m(?:in)?)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Math.round(parseFloat(m[1] || 0) * 60 + parseInt(m[2] || 0, 10));
}
function fmtDur(min) {
  if (min === null || min === undefined || isNaN(min)) return "";
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
}
/** {est, active, passive} in minutes (null when not set) from a task line or its parsed fields. */
function timeOf(x) {
  const f = typeof x === "string" ? parseFields(x) : x || {};
  const out = {};
  for (const k of TIME_KEYS) out[k] = f[k] !== undefined ? parseDur(f[k]) : null;
  return out;
}
function setTime(line, key, min) { return setField(line, key, min === null || min === undefined || min <= 0 ? null : fmtDur(min)); }
function addTime(line, key, min) { return setTime(line, key, (timeOf(line)[key] || 0) + min); }
/** Set several time fields at once: vals = {est, active, passive} in minutes; undefined = leave, null/0 = remove. */
function setTimes(line, vals) {
  for (const k of TIME_KEYS) if (vals[k] !== undefined) line = setTime(line, k, vals[k]);
  return line;
}
/** A recurring task's next occurrence must not inherit the time spent on this one. */
function cleanRecurrence(text) {
  const ls = String(text).split("\n");
  if (ls.length < 2) return text;
  return ls.map((l) => (/^\s*[-*+]\s+\[[ /]\]/.test(l) ? setField(setTimes(l, { active: null, passive: null }), "cal", null) : l)).join("\n");
}
const T0 = () => ({ tasks: 0, est: 0, estN: 0, active: 0, passive: 0, logged: 0, doneEst: 0, doneActive: 0, doneN: 0 });
function tAdd(a, t) {
  const tm = timeOf(t.fields);
  a.tasks++;
  if (tm.est) { a.est += tm.est; a.estN++; }
  if (tm.active || tm.passive) a.logged++;
  a.active += tm.active || 0; a.passive += tm.passive || 0;
  if (isDone(t) && tm.est && tm.active) { a.doneEst += tm.est; a.doneActive += tm.active; a.doneN++; }
}
function tSum(d, ids, pp = null) {
  const out = T0();
  for (const id of ids) { const pm = d.time && d.time.get(id); if (!pm) continue; for (const [k, a] of pm) if (!pp || k === pp) for (const f of Object.keys(out)) out[f] += a[f]; }
  return out;
}
/** Actual hands-on time as % of the estimate, over done tasks that have both (100% = spot on, 150% = took 1.5×). */
const tAcc = (a) => (a.doneEst ? Math.round((100 * a.doneActive) / a.doneEst) : null);

/* ------------------------------------------------------------------ local LLM */

function stripThink(s) { return String(s || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim(); }
function extractJson(s) {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("the model did not return JSON");
  return JSON.parse(s.slice(a, b + 1));
}
function llmBase(env, cfg) {
  if (env.isMobile && String(cfg.llm_mobile).toLowerCase() !== "url") throw new Error("no local model set up for this iPhone (llm_mobile is \"" + cfg.llm_mobile + "\" in Tracker/Config) — see Start here → iPhone");
  const url = env.isMobile ? cfg.llm_url_mobile : cfg.llm_url;
  if (!url) throw new Error("llm_url_mobile is empty in Tracker/Config");
  return String(url).replace(/\/+$/, "");
}
/* Progress of model jobs: a pinned panel (step, current item, bar, elapsed / left, Stop). Every model call goes
   through llmChat, which gives up waiting as soon as Stop is pressed (the answer, if it still comes, is ignored). */
class Stopped extends Error { constructor() { super("stopped"); } }
const fmtSecs = (s) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
/** Text of the panel (also used without a panel, and in tests). */
function jobText(job, now = Date.now()) {
  const el = (now - job.t0) / 1000;
  const doneN = Math.max(0, job.i - 1);
  const per = doneN ? (job.tDone - job.t0) / 1000 / doneN : null;
  const left = per && job.total > 1 ? Math.max(0, per * (job.total - doneN) - (now - job.tDone) / 1000) : null;
  return {
    title: job.title,
    count: job.total > 1 ? `${Math.min(job.i, job.total)}/${job.total}` : "",
    label: job.label,
    time: `⏱ ${fmtSecs(el)}${left !== null ? ` · about ${fmtSecs(left)} left` : ""}`,
    pct: job.total ? Math.round((100 * doneN) / job.total) : 0,
  };
}
function startJob(env, title, total = 1) {
  const job = { title, total, i: 0, label: "", t0: Date.now(), tDone: Date.now(), stopped: false, waiters: [], aborts: [], prev: env.job, output: "", results: [] };
  const ui = env.progressUI ? env.progressUI(job) : null;
  job.step = (i, label) => {
    if (i > job.i && job.i > 0) job.tDone = Date.now();
    job.i = i; job.label = String(label || "").slice(0, 80); job.output = "";
    if (ui) ui.update(); else env.notice(`${title}${total > 1 ? ` ${i}/${total}` : ""}: ${job.label}`, 2500);
  };
  job.stop = () => { if (job.stopped) return; job.stopped = true; job.waiters.splice(0).forEach((f) => f()); job.aborts.splice(0).forEach((f) => { try { f(); } catch (e) { /* gone */ } }); };
  /** The model's text so far for the current item (streamed on the Mac, all at once elsewhere). */
  job.out = (text) => { job.output = String(text || ""); if (ui && ui.output) ui.output(); };
  /** One line per finished item: what the model decided. */
  job.result = (line) => { job.results.push(String(line).slice(0, 120)); if (job.results.length > 50) job.results.shift(); if (ui && ui.output) ui.output(); };
  job.wait = (p) => {
    p.catch(() => {}); // an answer that arrives after Stop is dropped quietly
    if (job.stopped) return Promise.reject(new Stopped());
    return Promise.race([p, new Promise((_, rej) => job.waiters.push(() => rej(new Stopped())))]);
  };
  job.end = () => { if (ui) ui.close(); env.job = job.prev; };
  env.job = job;
  return job;
}
async function llmChat(env, cfg, messages, schema) {
  const call = llmChatRaw(env, cfg, messages, schema);
  return env.job ? env.job.wait(call) : call;
}
async function llmChatRaw(env, cfg, messages, schema) {
  const prov = String((env.isMobile && cfg.llm_provider_mobile) || cfg.llm_provider).toLowerCase();
  const model = (env.isMobile && cfg.llm_model_mobile) || cfg.llm_model;
  const base = llmBase(env, cfg);
  const ollama = prov === "ollama";
  const url = ollama ? `${base}/api/chat` : base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const body = ollama
    ? { model, messages, stream: false, keep_alive: cfg.llm_keep_alive || "30m", options: { temperature: 0, num_ctx: Number(cfg.llm_context) || 8192 } }
    : { model, messages, temperature: 0 };
  if (ollama && !cfg.llm_think) body.think = false; // thinking models: skip the long reasoning before the answer
  if (schema) {
    if (ollama) body.format = schema;
    else body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema } };
  }
  const job = env.job, streaming = !!(job && env.streamPost);
  const t0 = Date.now();
  const send = async () => {
    try {
      if (streaming) {
        body.stream = true;
        const st = { buf: "", content: "", thinking: "", stats: null };
        const r = await env.streamPost(url, JSON.stringify(body), (chunk) => { if (feedStream(st, chunk, ollama)) job.out(showStream(st)); }, (abort) => job.aborts.push(abort));
        if (r.status < 400) { feedStream(st, "\n", ollama); return { status: r.status, text: null, content: st.content, stats: st.stats }; }
        return r;
      }
      return await env.request({ url, method: "POST", contentType: "application/json", body: JSON.stringify(body) });
    }
    catch (e) { throw new Error(`can't reach the local model at ${base} (${e.message || e}). ${env.isMobile ? "Is the model app running?" : `Is ${ollama ? "Ollama" : "the server"} running?`}`); }
  };
  let r = await send();
  if (r.status >= 400 && body.think === false) { delete body.think; r = await send(); } // older Ollama: no "think" option
  if (r.status >= 400 && schema) { // older servers: fall back to plain JSON mode
    if (ollama) body.format = "json"; else delete body.response_format;
    r = await send();
  }
  if (r.status >= 400) throw new Error(`local model returned HTTP ${r.status}: ${String(r.text).slice(0, 200)}`);
  let text, stats = r.stats || null;
  if (r.content !== undefined) text = r.content;
  else {
    const data = JSON.parse(r.text);
    text = ollama ? data.message?.content : data.choices?.[0]?.message?.content;
    stats = llmStats(data);
    if (job) job.out(text);
  }
  if (job) job.stats = Object.assign({ wall: (Date.now() - t0) / 1000 }, stats || {});
  return stripThink(text);
}
/** Token counts and timings from the server's answer (Ollama reports both; OpenAI-style servers only tokens). */
function llmStats(o) {
  if (!o) return null;
  if (o.prompt_eval_count !== undefined || o.eval_count !== undefined) {
    const s = (ns) => (ns ? ns / 1e9 : 0);
    return { promptTok: o.prompt_eval_count || 0, promptSec: s(o.prompt_eval_duration), outTok: o.eval_count || 0, outSec: s(o.eval_duration), loadSec: s(o.load_duration) };
  }
  if (o.usage) return { promptTok: o.usage.prompt_tokens || 0, outTok: o.usage.completion_tokens || 0 };
  return null;
}
/** "prompt 3.1k tok 12s · answer 85 tok 3s · loading 4s" */
function statsText(st) {
  if (!st) return "";
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const sec = (x) => (x >= 10 ? `${Math.round(x)}s` : `${x.toFixed(1)}s`);
  const bits = [];
  if (st.promptTok !== undefined) bits.push(`prompt ${k(st.promptTok)} tok${st.promptSec ? ` ${sec(st.promptSec)}` : ""}`);
  if (st.outTok !== undefined) bits.push(`answer ${k(st.outTok)} tok${st.outSec ? ` ${sec(st.outSec)}` : ""}`);
  if (st.loadSec >= 1) bits.push(`loading the model ${sec(st.loadSec)}`);
  if (!bits.length && st.wall) bits.push(sec(st.wall));
  return bits.join(" · ");
}
/** Read streamed lines (Ollama: one JSON per line; OpenAI-style: "data: {…}"). Returns true if text was added. */
function feedStream(st, chunk, ollama) {
  st.buf += chunk;
  const lines = st.buf.split("\n");
  st.buf = lines.pop();
  let added = false;
  for (let l of lines) {
    l = l.trim();
    if (l.startsWith("data:")) l = l.slice(5).trim();
    if (!l || l === "[DONE]") continue;
    let o;
    try { o = JSON.parse(l); } catch (e) { continue; }
    const stats = llmStats(o.done || o.usage ? o : null);
    if (stats) st.stats = stats;
    const m = ollama ? o.message || {} : (o.choices && o.choices[0] && (o.choices[0].delta || o.choices[0].message)) || {};
    if (m.content) { st.content += m.content; added = true; }
    const th = m.thinking || m.reasoning_content || m.reasoning;
    if (th) { st.thinking += th; added = true; }
  }
  return added;
}
const showStream = (st) => (st.thinking ? `💭 ${st.thinking}${st.content ? "\n\n" : ""}` : "") + st.content;

async function projectCatalog(app, cfg) {
  const ps = listProjects(app, cfg).filter((p) => !["done", "archived", "dropped"].includes(p.status));
  for (const [i, p] of ps.entries()) {
    p.id = `P${i + 1}`;
    const lines = (await app.vault.cachedRead(p.file)).split("\n");
    const ex = backlogItems(lines).map((t) => t.desc);
    const ns = findSection(lines, "Notes & ideas");
    if (ns) ex.push(...parseItems(lines, ns.start, ns.end).filter((x) => !x.parent).map((x) => x.desc));
    p.examples = ex.slice(-cfg.llm_examples_per_project);
  }
  return ps;
}
function catalogText(catalog) {
  return catalog.map((p) => {
    let s = `${p.id} — ${p.name} [${p.scope}${p.status !== "active" ? ", " + p.status : ""}]`;
    if (p.description) s += `: ${p.description}`;
    if (p.objective) s += ` Objective: ${p.objective}.`;
    if (p.keywords.length) s += ` Keywords: ${p.keywords.join(", ")}.`;
    if (p.examples.length) s += ` Examples: ${p.examples.map((e) => `"${e}"`).join("; ")}.`;
    return s;
  }).join("\n");
}
/* ---- Free text in the inbox: notes, ideas, links written anywhere in the note (not as - [ ] tasks).
 * Process inbox sends it to the model, which splits it into separate items and sorts each one;
 * they become classified queue items, and the original text is kept in Tracker/Inbox archive.md. */
const INBOX_ARCHIVE = `${TRACKER_ROOT}/Inbox archive.md`;
const EXTRACT_CHUNK = 3500; // characters per model call
/** → { idx: [line numbers], text, chunks: [{ text, idx }] } for everything in the inbox that isn't a queue task. */
function inboxFree(lines) {
  const n = lines.length, skip = new Array(n).fill(false);
  let fmEnd = 0;
  if (lines[0] === "---") { const e = lines.indexOf("---", 1); fmEnd = e > 0 ? e + 1 : 0; }
  for (let i = 0; i < fmEnd; i++) skip[i] = true;
  for (const it of parseItems(lines)) if (it.task && !it.parent) for (let k = it.line; k < blockEnd(lines, it); k++) skip[k] = true;
  const mask = maskedLines(lines);
  let callout = false;
  for (let i = fmEnd; i < n; i++) {
    const l = lines[i];
    if (/^>\s*\[!/.test(l)) callout = true; else if (!/^>/.test(l)) callout = false;
    if (callout || (!mask[i] && HEAD_RE.test(l)) || /^Capture anything (as|—|-)/i.test(l.trim())) skip[i] = true;
  }
  const idx = [];
  for (let i = fmEnd; i < n; i++) if (!skip[i] && lines[i].trim() !== "") idx.push(i);
  // chunks: consecutive paragraphs up to EXTRACT_CHUNK characters
  const chunks = [];
  let cur = null, last = -2;
  for (const i of idx) {
    const gap = i - last > 1;
    if (!cur || (gap && cur.text.length > EXTRACT_CHUNK)) { cur = { text: "", idx: [] }; chunks.push(cur); }
    cur.text += (cur.text ? (gap ? "\n\n" : "\n") : "") + lines[i];
    cur.idx.push(i);
    last = i;
  }
  return { idx, text: chunks.map((c) => c.text).join("\n\n"), chunks };
}
/* ------------------------------------------------------------------ templates */

function weekNote(id) {
  const s = weekStart(id);
  return `---
type: week
week: ${id}
start: ${s.format("YYYY-MM-DD")}
end: ${s.clone().add(6, "days").format("YYYY-MM-DD")}
status: planned
---
# Week ${s.format("W")} · ${weekRange(id)} ${s.clone().add(6, "days").format("YYYY")}

\`\`\`dataviewjs
await dv.view("${VIEW_PATH}", {mode: "week"})
\`\`\`

> [!todo]- This week by day
> \`\`\`tasks
> not done
> (scheduled in ${s.format("YYYY-MM-DD")} ${s.clone().add(6, "days").format("YYYY-MM-DD")}) OR (due in ${s.format("YYYY-MM-DD")} ${s.clone().add(6, "days").format("YYYY-MM-DD")})
> sort by due
> sort by priority
> group by scheduled
> \`\`\`

## Goals

## Notes
`;
}
const PROJECT_BLOCK = `\`\`\`dataviewjs
await dv.view("${VIEW_PATH}", {mode: "project"})
\`\`\``;
function projectNote({ name, scope, status, description, objective, today }) {
  return `---
type: project
status: ${status}
scope: ${scope}
description: ${JSON.stringify(description || "")}
objective: ${JSON.stringify(objective || "")}
keywords: []
created: ${today}
---
# ${name}

${PROJECT_BLOCK}

## ${OKR_SEC}

## ${PLANNED_SEC}

## Backlog

## Notes & ideas
`;
}

/* ------------------------------------------------------------------ env */

function makeEnv(app, tp) {
  let obs = tp.obsidian || null;
  if (!obs) { try { obs = typeof require === "function" ? require("obsidian") : null; } catch (e) { /* not available */ } }
  return {
    app,
    isMobile: !!(obs && obs.Platform && obs.Platform.isMobile),
    moment: getMoment(),
    prompt: (q, def = "", multi = false) => tp.system.prompt(q, def, false, multi),
    suggest: (labels, values, placeholder = "") => tp.system.suggester(labels, values, false, placeholder),
    notice: (msg, ms = 6000) => { try { new obs.Notice(msg, ms); } catch (e) { console.log("[tracker]", msg); } },
    request: async (opts) => {
      if (obs && obs.requestUrl) { const r = await obs.requestUrl({ ...opts, throw: false }); return { status: r.status, text: r.text }; }
      const r = await fetch(opts.url, { method: opts.method, headers: Object.assign({ "Content-Type": opts.contentType }, opts.headers || {}), body: opts.body });
      return { status: r.status, text: await r.text() };
    },
    // Desktop: stream the model's answer through Node's http (no CORS, can be cut off). Not on the iPhone.
    streamPost: (() => {
      const req = typeof require === "function" ? require : typeof window !== "undefined" && window.require;
      if (!req || (obs && obs.Platform && obs.Platform.isMobile)) return null;
      return (url, body, onData, onAbort) => new Promise((resolve, reject) => {
        const u = new URL(url), mod = req(u.protocol === "https:" ? "https" : "http");
        const rq = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
          let all = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { if (res.statusCode >= 400) all += c; else onData(c); });
          res.on("end", () => resolve({ status: res.statusCode, text: all }));
          res.on("error", reject);
        });
        rq.on("error", reject);
        if (onAbort) onAbort(() => rq.destroy(new Error("stopped")));
        rq.end(body);
      });
    })(),
    progressUI: (job) => {
      if (!obs || !obs.Notice) return null;
      let n;
      try { n = new obs.Notice("", 0); } catch (e) { return null; }
      const el = n.noticeEl || (n.messageEl && n.messageEl.parentElement);
      if (!el) return null;
      el.classList.add("pt-progress");
      el.innerHTML = `<div class="pt-progress-head"><b class="pt-progress-title"></b><span class="pt-progress-count"></span></div><div class="pt-progress-label"></div><div class="pt-progress-bar"><div></div></div><pre class="pt-progress-out"></pre><div class="pt-progress-results"></div><div class="pt-progress-foot"><span class="pt-progress-time"></span><button class="pt-progress-stop">Stop</button></div>`;
      const $ = (c) => el.querySelector(c);
      const draw = () => {
        const t = jobText(job);
        $(".pt-progress-title").textContent = t.title; $(".pt-progress-count").textContent = t.count;
        $(".pt-progress-label").textContent = t.label; $(".pt-progress-time").textContent = job.stopped ? "Stopping…" : t.time;
        $(".pt-progress-bar > div").style.width = `${t.pct}%`;
      };
      const out = $(".pt-progress-out"), res = $(".pt-progress-results");
      const showOut = () => {
        out.textContent = job.output.length > 1500 ? "…" + job.output.slice(-1500) : job.output;
        out.style.display = job.output ? "" : "none";
        out.scrollTop = out.scrollHeight;
        res.innerHTML = job.results.slice(-4).map((x) => `<div>${esc(x)}</div>`).join("");
      };
      showOut();
      ["click", "mousedown", "pointerdown"].forEach((t) => [out, res].forEach((x) => x.addEventListener(t, (ev) => ev.stopPropagation()))); // reading the output doesn't hide the panel
      $(".pt-progress-stop").addEventListener("click", (ev) => { ev.stopPropagation(); job.stop(); draw(); });
      draw();
      const timer = setInterval(draw, 1000);
      return { update: draw, output: showOut, close: () => { clearInterval(timer); try { n.hide(); } catch (e) { /* gone */ } } };
    },
    open: async (path) => { const f = app.vault.getAbstractFileByPath(path); if (f) await app.workspace.getLeaf(false).openFile(f); },
    openUrl: (url) => {
      try { window.open(url); }
      catch (e) { const a = document.createElement("a"); a.href = url; a.target = "_blank"; document.body.appendChild(a); a.click(); a.remove(); }
    },
  };
}
async function ask(env, labels, values, placeholder) {
  const v = await env.suggest(labels, values, placeholder);
  if (v === null || v === undefined) throw new Cancelled();
  return v;
}

/* ------------------------------------------------------------------ commands: inbox */

const INBOX_TEMPLATE = `---
type: inbox
---
# Inbox

> [!info] How this works
> Write or paste anything in this note — tasks as \`- [ ] …\` under Queue, or plain notes, ideas, places, links and spendings anywhere.
> **Process inbox** reads the whole note and sorts it into [[Classified inbox]] — tasks and ideas to projects, reference information to your reference notes, spendings to your finance note. This note isn't changed until you check that and press **Apply inbox**; then everything is filed, the original text is kept in [[Inbox archive]], and this note is cleared.

## Queue
`;
async function ensureInbox(app, cfg) {
  if (app.vault.getAbstractFileByPath(cfg.inbox)) return;
  await createFile(app, cfg.inbox, INBOX_TEMPLATE);
}

async function cmdCapture(env) {
  const { app } = env, cfg = getConfig(app);
  const text = await env.prompt("Capture to inbox (one item per line)", "", true);
  if (!text || !text.trim()) return;
  await ensureInbox(app, cfg);
  const items = text.split(/\r?\n/).map((s) => s.trim().replace(/^[-*]\s+(\[.\]\s+)?/, "")).filter(Boolean);
  const today = env.moment().format("YYYY-MM-DD");
  // ➕ = when you captured it; filing later keeps this date.
  await editLines(app, cfg.inbox, (lines) => insertIntoSection(lines, "Queue", items.map((t) => withCreated(`- [ ] ${t}`, today))));
  env.notice(`Inbox: +${items.length}`);
}

/* ---- iPhone: Apple's on-device model through the Shortcuts app ----
 * 1. We write Tracker/AI/request.json  { prompts: [...], items: [...], projects: {P1: path} }
 * 2. We open the shortcut. It runs "Use Model (On-Device)" on each prompt and saves the answers,
 *    joined by SHORTCUT_SEP, to Tracker/AI/response.txt, then switches back to Obsidian.
 * 3. Next time Process inbox runs, we read the answers and apply them.            */
const AI_DIR = `${TRACKER_ROOT}/AI`;
const AI_REQ = `${AI_DIR}/request.json`;
const AI_RES = `${AI_DIR}/response.txt`;
const SHORTCUT_SEP = "#####";
async function aiExists(app, p) { try { return await app.vault.adapter.exists(p); } catch (e) { return false; } }
async function aiRemove(app, p) { try { if (await aiExists(app, p)) await app.vault.adapter.remove(p); } catch (e) { /* ignore */ } }
/* ------------------------------------------------------------------ project descriptions (LLM)
 * The inbox model sorts notes into projects by their descriptions, so the Projects note can have the local
 * model rate each description, and write one from what's in the project's folder.
 * Results live in Tracker/AI/descriptions.json: { path: { hash, checked, score, issues, suggestion, proposal } }. */
const DESC_STORE = `${AI_DIR}/descriptions.json`;
const DESC_CONTEXT_CHARS = 6000; // folder content sent to the model when writing a description
async function loadDescStore(app) {
  try { return (await aiExists(app, DESC_STORE)) ? JSON.parse(await app.vault.adapter.read(DESC_STORE)) || {} : {}; }
  catch (e) { return {}; }
}
async function saveDescStore(app, store) {
  if (!(await aiExists(app, AI_DIR))) await app.vault.adapter.mkdir(AI_DIR);
  await app.vault.adapter.write(DESC_STORE, JSON.stringify(store, null, 1));
}
/** Changes when anything the check looked at changes, so an old rating shows as out of date. */
function descHash(p) {
  const str = [p.name, p.description, p.objective, p.keywords.join(",")].join("\u0001");
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const descVerdict = (score) => (score >= 80 ? "good" : score >= 50 ? "fair" : "weak");
function descProjects(app, cfg) { return listProjects(app, cfg).filter((p) => !p.routine); }
const liveStatus = (p) => !["done", "archived", "dropped"].includes(p.status);
function othersText(p, all) {
  return all.filter((x) => x !== p && liveStatus(x)).map((x) => `- ${x.name}${x.description ? `: ${x.description}` : " (no description)"}`).join("\n") || "(none)";
}
async function sampleTasks(app, p, n = 10) {
  const ls = (await app.vault.cachedRead(p.file)).split("\n");
  return parseItems(ls).filter((t) => t.task && !t.parent).map((t) => taskDesc(t.raw)).filter(Boolean).slice(-n);
}
function descCheckMessages(p, all, tasks) {
  const system = "You review the short descriptions of projects in a personal planning system. A small local model reads these descriptions to decide which project an inbox note belongs to, so a good description makes that decision easy. You answer with one JSON object and nothing else.";
  const user = `Project: ${p.name} [${p.scope}]
Description: "${p.description}"
${p.objective ? `Objective: ${p.objective}\n` : ""}${p.keywords.length ? `Keywords: ${p.keywords.join(", ")}\n` : ""}Some of its tasks:
${tasks.length ? tasks.map((t) => `- ${t}`).join("\n") : "(none yet)"}

The other projects:
${othersText(p, all)}

Rate the description from 0 to 100:
- Clear: says in plain words what the project covers and what kind of work it involves.
- Distinct: easy to tell apart from the other projects. Name any project it overlaps with.
- Concrete: mentions the typical things, places, people or activities, so notes like the tasks above clearly match.
- Short: one to three sentences. Goals and deadlines belong in the objective, not here.
80 or more = good, 50 to 79 = could be better, under 50 = weak.

"issues": up to 3 short problems, in the same language as the description (empty if there are none).
"suggestion": a better description of one to three sentences in the same language, or "" if it is already good.

Answer with JSON like {"score":65,"issues":["Overlaps with Home renovation"],"suggestion":"…"}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}
const DESC_CHECK_SCHEMA = { type: "object", properties: { score: { type: "number" }, issues: { type: "array", items: { type: "string" } }, suggestion: { type: "string" } }, required: ["score", "issues", "suggestion"], additionalProperties: false };
function normalizeDescCheck(out, p) {
  let score = Number(out && out.score);
  if (!isFinite(score)) score = 0;
  if (score > 0 && score <= 1) score *= 100; // some models answer 0..1
  score = clamp(Math.round(score), 0, 100);
  const issues = (Array.isArray(out && out.issues) ? out.issues : []).map((x) => oneLine(x)).filter(Boolean).slice(0, 3);
  let suggestion = oneLine((out && out.suggestion) || "").replace(/^"|"$/g, "");
  if (suggestion.toLowerCase() === String(p.description).trim().toLowerCase()) suggestion = "";
  return { score, verdict: descVerdict(score), issues, suggestion };
}
/** The project's own folder (its note and every other file in it) as text for the model, capped at DESC_CONTEXT_CHARS. */
async function projectFolderText(app, cfg, p) {
  const all = listProjects(app, cfg);
  const ctx = { cfg, projects: all };
  const sc = projectScope(ctx, all.find((x) => x.path === p.path) || p);
  const clean = (c) => String(c).replace(/^---\n[\s\S]*?\n---\n/, "").replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const parts = [`### ${p.file.name} (the project note)\n${clean(await app.vault.cachedRead(p.file))}`];
  const others = [];
  if (sc.folder) {
    const md = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(sc.folder) && f.path !== p.path && (projectOfPath(ctx, f.path) || {}).path === p.path).sort((a, b) => a.path.localeCompare(b.path));
    for (const f of md) parts.push(`### ${f.path.slice(sc.folder.length)}\n${clean(await app.vault.cachedRead(f)).slice(0, 1500)}`);
    const root = app.vault.getAbstractFileByPath(sc.folder.replace(/\/$/, ""));
    (function walk(fo) { for (const c of (fo && fo.children) || []) { if (c.children) walk(c); else if (c.extension && c.extension !== "md") others.push(c.path.slice(sc.folder.length)); } })(root);
  }
  let text = parts.join("\n\n");
  if (others.length) text += `\n\n### Other files\n${others.slice(0, 40).join(", ")}`;
  return text.length > DESC_CONTEXT_CHARS ? text.slice(0, DESC_CONTEXT_CHARS) + "\n…(cut)" : text;
}
function descWriteMessages(p, all, content) {
  const system = "You write short descriptions of projects in a personal planning system. A small local model reads them to decide which project an inbox note belongs to. You answer with one JSON object and nothing else.";
  const user = `Write a description for the project "${p.name}" [${p.scope}].
${p.description ? `Current description: "${p.description}"\n` : ""}${p.objective ? `Objective: ${p.objective}\n` : ""}
The other projects (the description must make this one easy to tell apart from them):
${othersText(p, all)}

What's in the project's folder:
${content}

Rules:
- "description": one to three sentences, at most 300 characters, saying what the project covers and the kind of work it involves. Mention the typical things, places, people or activities. No goals, dates or progress. Use the language of the notes.
- "keywords": 3 to 8 short lowercase words or phrases that notes about this project are likely to contain.

Answer with JSON like {"description":"…","keywords":["…","…"]}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}
const DESC_WRITE_SCHEMA = { type: "object", properties: { description: { type: "string" }, keywords: { type: "array", items: { type: "string" } } }, required: ["description", "keywords"], additionalProperties: false };

async function checkDescription(env, path, store) {
  const { app } = env, cfg = getConfig(app);
  const all = descProjects(app, cfg), p = all.find((x) => x.path === path);
  if (!p) throw new Error(`not a project: ${path}`);
  const prev = store[path] || {};
  let r;
  if (!p.description.trim()) r = { score: 0, verdict: "missing", issues: ["No description yet — the inbox model can't match notes to this project."], suggestion: "" };
  else r = normalizeDescCheck(extractJson(await llmChat(env, cfg, descCheckMessages(p, all, await sampleTasks(app, p)), DESC_CHECK_SCHEMA)), p);
  store[path] = Object.assign({}, prev.proposal ? { proposal: prev.proposal } : {}, r, { hash: descHash(p), checked: env.moment().format("YYYY-MM-DD") });
  return store[path];
}
async function generateDescription(env, path, store) {
  const { app } = env, cfg = getConfig(app);
  const all = descProjects(app, cfg), p = all.find((x) => x.path === path);
  if (!p) throw new Error(`not a project: ${path}`);
  const out = extractJson(await llmChat(env, cfg, descWriteMessages(p, all, await projectFolderText(app, cfg, p)), DESC_WRITE_SCHEMA));
  const description = oneLine(out.description || "").replace(/^"|"$/g, "");
  if (!description) throw new Error("the model didn't write a description — try again or write it yourself");
  const keywords = [...new Set((Array.isArray(out.keywords) ? out.keywords : []).map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  store[path] = Object.assign({}, store[path] || {}, { proposal: { description, keywords, created: env.moment().format("YYYY-MM-DD") } });
  return store[path].proposal;
}
/** Write a description (a generated proposal, or the check's suggestion) into the project's properties. */
async function applyDescription(app, path, store, which) {
  const st = store[path] || {};
  const src = which === "suggestion" ? { description: st.suggestion, keywords: [] } : st.proposal;
  if (!src || !src.description) throw new Error("nothing to apply — generate or check again");
  const f = app.vault.getAbstractFileByPath(path);
  if (!f) throw new Error(`File not found: ${path}`);
  await app.fileManager.processFrontMatter(f, (fm) => {
    fm.description = src.description;
    const kw = toArr(fm.keywords);
    if (!kw.length && src.keywords && src.keywords.length) fm.keywords = src.keywords;
  });
  if (which === "suggestion") delete st.suggestion; else delete st.proposal;
  store[path] = st;
}
/** Actions from the Projects note's buttons: check | generate | use-proposal | use-suggestion | dismiss | check-all (new or changed) | recheck-all. Returns a message. */
async function descAction(env, act, path) {
  const { app } = env, cfg = getConfig(app);
  const store = await loadDescStore(app);
  let msg = "";
  const name = (descProjects(app, cfg).find((p) => p.path === path) || {}).name || "";
  const job = ["check", "generate"].includes(act) ? startJob(env, act === "check" ? "🤖 Rating the description" : "✨ Writing a description", 1) : act.endsWith("check-all") ? startJob(env, "🤖 Checking descriptions", 0) : null;
  if (job && job.total === 1) job.step(1, name);
  try {
    if (act === "check") { const r = await checkDescription(env, path, store); msg = r.verdict === "missing" ? "No description to check — try ✨ Write one." : `Description: ${r.score}/100 (${r.verdict})`; }
    else if (act === "generate") { await generateDescription(env, path, store); msg = "✨ Description written — use it or dismiss it."; }
    else if (act === "use-proposal" || act === "use-suggestion") { await applyDescription(app, path, store, act === "use-proposal" ? "proposal" : "suggestion"); msg = "Description saved to the project's properties. Check it again to rate it."; }
    else if (act === "dismiss") { if (store[path]) delete store[path].proposal; msg = ""; }
    else if (act === "check-all" || act === "recheck-all") {
      const todo = descProjects(app, cfg).filter((p) => liveStatus(p) && (act === "recheck-all" || !store[p.path] || store[p.path].hash !== descHash(p) || !store[p.path].verdict));
      if (!todo.length) msg = "All descriptions are already checked.";
      let i = 0;
      job.total = todo.length;
      for (const p of todo) {
        job.step(++i, p.name);
        await checkDescription(env, p.path, store);
        if (store[p.path]) job.result(`✓ ${p.name}: ${store[p.path].score ?? "–"} (${store[p.path].verdict})`);
        await saveDescStore(app, store); // keep what's done if a later one fails
      }
      if (todo.length) { const w = todo.filter((p) => store[p.path].verdict !== "good").length; msg = `Checked ${todo.length} description(s)${w ? ` · ${w} could be better` : " · all good"}`; }
    } else throw new Error(`unknown action ${act}`);
  } catch (e) {
    if (!(e instanceof Stopped)) throw e;
    msg = act.endsWith("check-all") ? `Stopped — ${Math.max(0, job.i - 1)} of ${job.total} checked; the rest keep their old rating.` : "Stopped — nothing changed.";
  } finally { if (job) job.end(); await saveDescStore(app, store); }
  return msg;
}

/** Normalise a task line for the Tasks plugin: open checkbox, optional global-filter tag, ➕ created date. */
function newTask(cfg, line, today) {
  let out = /^\s*[-*+]\s+\[.\]/.test(line) ? line.replace(/^\s+/, "") : `- [ ] ${line.replace(/^\s*[-*+]\s+/, "").trim()}`;
  const tag = String(cfg.task_tag || "").trim();
  if (tag && !out.includes(tag)) out = out.replace(/^(- \[.\] )/, `$1${tag} `);
  return withCreated(out, today);
}
/** Add a ➕ created date unless the line already has one (an earlier date always wins). */
function withCreated(line, date) {
  return getDate(line, "created") ? line : setDate(line, "created", date);
}

/* ------------------------------------------------------------------ inbox → Classified inbox → apply
 * Process inbox never changes the inbox. The model's proposal goes to Tracker/Classified inbox.md for you to review:
 *   ## Tasks, ## Ideas  → a project                            [to:: [[Sailing]]]
 *   ## References       → a reference note in reference_folder [to:: [[Travel]]] (never a project unless you write one)
 *   ## Spendings        → collected in finance_file, plus one task to process them
 * Apply inbox moves everything to its place, archives what the inbox held, and clears it.
 * Tracker/AI/classified.json keeps the exact inbox lines that were classified, so anything you add
 * to the inbox after classifying stays there. */
const REVIEW_PATH = `${TRACKER_ROOT}/Classified inbox.md`;
const REVIEW_SNAP = `${AI_DIR}/classified.json`;
const KINDS = ["task", "idea", "reference", "spending"];
const REVIEW_SECS = { task: "Tasks", idea: "Ideas", reference: "References", spending: "Spendings" };
const KIND_ICON = { task: "☐", idea: "💡", reference: "📎", spending: "💶" };
const KIND_NAME = { task: "task", idea: "idea", reference: "reference", spending: "spending" };
const SPEND_TASK_RE = /Process \d+ new spending\(s\)/;

function referenceNotes(app, cfg) {
  const root = String(cfg.reference_folder || "").replace(/\/+$/, "");
  if (!root) return [];
  return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(root + "/")).map((f) => {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter || {};
    return { path: f.path, file: f, name: String(fm.title || f.basename), description: String(fm.description || ""), keywords: toArr(fm.keywords) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
async function inboxCatalog(app, cfg) {
  const projects = (await projectCatalog(app, cfg)).filter((p) => !p.routine);
  projects.forEach((p, i) => { p.id = `P${i + 1}`; });
  const refs = referenceNotes(app, cfg);
  refs.forEach((r, i) => { r.id = `R${i + 1}`; });
  return { projects, refs };
}
function refsText(refs) {
  return refs.length ? refs.map((r) => `${r.id} — ${r.name}${r.description ? `: ${r.description}` : ""}${r.keywords.length ? ` Keywords: ${r.keywords.join(", ")}.` : ""}`).join("\n") : "(none yet)";
}
function inboxRules(cfg) {
  return `- "kind": "task" = a concrete action to do; "idea" = a possibility to think about later; "reference" = information to keep for later: places to visit, restaurants, addresses, recommendations, facts, how-tos, links; "spending" = money already spent or paid (a purchase, a bill paid) with an amount.
- "project": only for a task or an idea: the id of the single best-fitting project, or "none" if no project clearly fits.
- "topic": only for a reference: the id of the best-fitting reference note, "new" if none fits, otherwise "none". References never go to a project — a place to visit is travel information even when there is a trip project.
- "new_topic": when "topic" is "new", a short general name for a new reference note (one to three words, e.g. "Travel", "Recipes"), otherwise "".
- "amount", "currency", "date", "category": only for a spending: the amount as a number; the currency code${cfg.currency ? ` ("${cfg.currency}" if none is given)` : ` ("" if none is given)`}; the date as YYYY-MM-DD (resolve "yesterday" from today; today if none is given); a one-word category such as groceries, transport, home, health, eating-out, bills. Otherwise 0, "", "", "".
- "priority": "high" = time-sensitive or blocking other work; "low" = nice to have; otherwise "medium".
- "confidence": 0 to 1, how sure you are about the kind and where it goes.
- "due": for a task, a deadline as YYYY-MM-DD only if one is given (resolve "next Friday" from today), otherwise "".`;
}
function inboxContext(cat, today) {
  return `Today is ${today}.

Projects (for tasks and ideas):
${catalogText(cat.projects)}

Reference notes (for references):
${refsText(cat.refs)}`;
}
const INBOX_SYSTEM = "You sort a person's inbox: tasks and ideas into their projects, reference information into their reference notes, and money they spent into their spendings. You answer with a single JSON object and nothing else.";
function itemMessages(cat, item, today, cfg) {
  const user = `${inboxContext(cat, today)}

Rules:
${inboxRules(cfg)}

Item: "${item}"

Answer with JSON like {"kind":"task","project":"P1","topic":"none","new_topic":"","amount":0,"currency":"","date":"","category":"","priority":"medium","confidence":0.8,"due":""}`;
  return [{ role: "system", content: INBOX_SYSTEM }, { role: "user", content: user }];
}
/** Several inbox items in one request: the project list and the rules are read once for all of them. */
function batchMessages(cat, items, today, cfg) {
  const user = `${inboxContext(cat, today)}

Rules (for each item on its own):
${inboxRules(cfg)}

Items:
${items.map((t, i) => `${i + 1}. "${t}"`).join("\n")}

Answer with JSON like {"items":[{"n":1,"kind":"task","project":"P1","topic":"none","new_topic":"","amount":0,"currency":"","date":"","category":"","priority":"medium","confidence":0.8,"due":""}]} — one entry per item, "n" = the item's number, all ${items.length} items.`;
  return [{ role: "system", content: INBOX_SYSTEM }, { role: "user", content: user }];
}
function notesMessages(cat, notes, today, cfg) {
  const user = `${inboxContext(cat, today)}

Split the notes below into separate, self-contained items — one per distinct action, idea, piece of information or expense. Keep everything the person wrote; don't invent anything. Write in the language of the notes.
For each item:
- "text": one short line (at most about 100 characters); for a task, start with a verb.
- "details": anything else from the notes that belongs to this item (numbers, links, names, context), or "".
${inboxRules(cfg)}

Notes:
"""
${notes}
"""

Answer with JSON like {"items":[{"text":"Pay the deposit for the winter berth","details":"42 per metre","kind":"task","project":"P1","topic":"none","new_topic":"","amount":0,"currency":"","date":"","category":"","priority":"high","confidence":0.9,"due":"2026-11-20"}]}`;
  return [{ role: "system", content: INBOX_SYSTEM }, { role: "user", content: user }];
}
function itemProps(cat) {
  return {
    kind: { type: "string", enum: KINDS },
    project: { type: "string", enum: [...cat.projects.map((p) => p.id), "none"] },
    topic: { type: "string", enum: [...cat.refs.map((r) => r.id), "new", "none"] },
    new_topic: { type: "string" }, amount: { type: "number" }, currency: { type: "string" }, date: { type: "string" }, category: { type: "string" },
    priority: { type: "string", enum: ["high", "medium", "low"] }, confidence: { type: "number" }, due: { type: "string" },
  };
}
const ITEM_KEYS = ["kind", "project", "topic", "new_topic", "amount", "currency", "date", "category", "priority", "confidence", "due"];
const ITEM_SCHEMA = (cat) => ({ type: "object", properties: itemProps(cat), required: ITEM_KEYS, additionalProperties: false });
const BATCH_SCHEMA = (cat) => ({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: Object.assign({ n: { type: "integer" } }, itemProps(cat)), required: ["n", ...ITEM_KEYS], additionalProperties: false } } }, required: ["items"], additionalProperties: false });
const NOTES_SCHEMA = (cat) => ({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: Object.assign({ text: { type: "string" }, details: { type: "string" } }, itemProps(cat)), required: ["text", "details", ...ITEM_KEYS], additionalProperties: false } } }, required: ["items"], additionalProperties: false });

/** Remove the indentation the lines have in common (sub-bullets of an item → top level). */
function outdent(lines) {
  const ls = lines.filter((l) => l.trim() !== "");
  if (!ls.length) return [];
  const w = Math.min(...ls.map((l) => l.match(/^[ \t]*/)[0].length));
  return ls.map((l) => l.slice(w));
}
const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
/** A model answer → a record { kind, text, details[], dest, newTopic, prio, conf, due, spend, created }. */
function normalizeRecord(x, cat, cfg, today) {
  x = x || {};
  const kind = KINDS.includes(x.kind) ? x.kind : "task";
  const find = (list, v) => { v = String(v || "").trim().toLowerCase(); return v && v !== "none" && v !== "new" ? list.find((p) => p.id.toLowerCase() === v) || list.find((p) => p.name.toLowerCase() === v) || null : null; };
  let conf = Number(x.confidence);
  if (isNaN(conf)) conf = 0.5;
  if (conf > 1) conf /= 100;
  const r = { kind, text: oneLine(x.text), created: today,
    details: String(x.details || "").split(/\r?\n/).map((l) => l.trim().replace(/^[-*]\s+/, "")).filter(Boolean).map((l) => `- ${l.replace(/[\[\]]/g, "")}`),
    prio: ["high", "medium", "low"].includes(x.priority) ? x.priority : "medium", conf: clamp(conf, 0, 1),
    due: isIso(x.due) ? x.due : null, dest: null, newTopic: "", spend: null };
  if (kind === "task" || kind === "idea") { const p = find(cat.projects, x.project); if (p) r.dest = { path: p.path, name: p.name }; }
  else if (kind === "reference") {
    const t = find(cat.refs, x.topic) || find(cat.refs, x.new_topic);
    if (t) r.dest = { path: t.path, name: t.name };
    else { const n = sanitizeName(oneLine(x.new_topic)); if (n && !/^(none|new)$/i.test(n)) r.newTopic = n.charAt(0).toUpperCase() + n.slice(1); }
  } else {
    const a = Number(String(x.amount ?? "").replace(",", "."));
    r.spend = { amount: isFinite(a) && a > 0 ? Math.round(a * 100) / 100 : null, currency: oneLine(x.currency || cfg.currency || "").toUpperCase(), date: isIso(x.date) ? x.date : today, category: oneLine(x.category).toLowerCase().replace(/\s+/g, "-") };
  }
  return r;
}
/** Everything in the inbox to classify: queue items (one model call each) and the free text (one call per chunk). */
function inboxJobs(lines, today) {
  const jobs = [], sources = [];
  for (const it of parseItems(lines)) {
    if (!it.task || it.parent || it.status !== " " || !it.text) continue;
    const end = blockEnd(lines, it);
    const sub = outdent(lines.slice(it.line + 1, end));
    const body = ["to", "kind", "conf"].reduce((l, k) => setField(l, k, null), it.body).trim();
    sources.push({ block: true, lines: lines.slice(it.line, end) });
    jobs.push({ type: "item", text: it.desc + (sub.length ? ` — ${sub.map((l) => l.replace(/^\s*[-*]\s+/, "")).join("; ")}` : ""), body, desc: stripFields(splitMeta(body).head), sub, created: getDate(it.raw, "created") || today });
  }
  for (const c of inboxFree(lines).chunks) {
    sources.push({ block: false, lines: c.idx.map((i) => lines[i]) });
    jobs.push({ type: "notes", text: c.text });
  }
  return { jobs, sources };
}
/** Model answers (parsed JSON or null when there was none) → records. Without an answer an item stays a task with no destination. */
function jobRecords(jobs, answers, cat, cfg, today) {
  const out = [];
  jobs.forEach((j, k) => {
    const a = answers[k];
    if (j.type === "item") {
      const r = a ? normalizeRecord(a, cat, cfg, today) : { kind: "task", dest: null, newTopic: "", prio: "medium", conf: 0, due: null, spend: null };
      r.text = r.kind === "task" ? j.body : j.desc;
      r.details = j.sub; r.created = j.created;
      if (r.kind === "spending" && r.spend) r.text = j.desc;
      out.push(r);
    } else if (a) {
      const items = Array.isArray(a) ? a : Array.isArray(a.items) ? a.items : [];
      for (const x of items) { const r = normalizeRecord(x, cat, cfg, today); if (r.text) out.push(r); }
    } else {
      const ls = j.text.split("\n").filter((l) => l.trim());
      out.push({ kind: "reference", text: oneLine(ls[0]), details: ls.slice(1).map((l) => `- ${l.trim().replace(/^[-*]\s+/, "")}`), dest: null, newTopic: "", prio: "medium", conf: 0, due: null, spend: null, created: today });
    }
  });
  return out;
}
function reviewLines(app, cfg, r) {
  let line = `- ${KIND_ICON[r.kind]} ${r.text}`;
  if (r.kind === "task") {
    if (r.due && !getDate(line, "due")) line = setDate(line, "due", r.due);
    if (r.prio !== "medium" && prioOf(line) === "normal") line = setPrio(line, r.prio);
  }
  if (r.kind === "spending") {
    const sp = r.spend || {};
    line = setField(line, "amount", sp.amount === null || sp.amount === undefined ? "?" : String(sp.amount));
    line = setField(line, "currency", sp.currency || null);
    line = setField(line, "date", sp.date || null);
    line = setField(line, "category", sp.category || null);
  } else {
    line = setField(line, "to", r.dest ? linkTo(app, r.dest.path, REVIEW_PATH, r.dest.name) : r.newTopic ? `[[${r.newTopic}]]` : "none");
    if (!r.dest && r.newTopic) line = setField(line, "new", "reference note");
  }
  const unsure = r.kind === "spending" ? !r.spend || r.spend.amount === null || r.conf < cfg.llm_flag_below : (r.dest || r.newTopic) && r.conf < cfg.llm_flag_below;
  if (unsure) line = setField(line, "check", "unsure");
  return [withCreated(line, r.created), ...(r.details || []).map((d) => `\t${d}`)];
}
const REVIEW_BLOCK = `\`\`\`dataviewjs
await dv.view("${VIEW_PATH}", {mode: "classified"})
\`\`\``;
function reviewNote(app, cfg, records, stamp) {
  let s = `---
type: classified-inbox
classified: ${stamp}
---
# Classified inbox

${REVIEW_BLOCK}

> [!info] Check before applying — your inbox isn't changed until you press Apply
> Every line says where it goes in \`[to:: …]\`. Change it to any project or reference note (e.g. \`[to:: [[Travel]]]\`; a name that doesn't exist yet becomes a new note in \`${cfg.reference_folder}\`), move a line to another section to change what it is, edit the text, or delete lines you don't want. \`[check:: unsure]\` = the model wasn't sure. Lines with \`[to:: none]\` are asked about when you apply. Add \`[week:: ${weekId(getMoment()())}]\` to a task to plan it for that week.
`;
  for (const k of KINDS) {
    const rs = records.filter((r) => r.kind === k);
    s += `\n## ${REVIEW_SECS[k]}${k === "spending" ? "" : ""}\n`;
    for (const r of rs) s += reviewLines(app, cfg, r).join("\n") + "\n";
  }
  return s;
}
const EMPTY_REVIEW = `---
type: classified-inbox
---
# Classified inbox

${REVIEW_BLOCK}
`;
async function writeFile(app, path, content) {
  const f = app.vault.getAbstractFileByPath(path);
  if (f) await app.vault.modify(f, content); else await createFile(app, path, content);
}
async function loadSnap(app) {
  try { return (await aiExists(app, REVIEW_SNAP)) ? JSON.parse(await app.vault.adapter.read(REVIEW_SNAP)) : null; } catch (e) { return null; }
}
async function writeReview(app, cfg, records, sources, stamp) {
  if (!(await aiExists(app, AI_DIR))) await app.vault.adapter.mkdir(AI_DIR);
  await app.vault.adapter.write(REVIEW_SNAP, JSON.stringify({ created: stamp, sources }, null, 1));
  await writeFile(app, REVIEW_PATH, reviewNote(app, cfg, records, stamp));
}
const recSummary = (rs) => KINDS.map((k) => [k, rs.filter((r) => r.kind === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${KIND_NAME[k]}${n > 1 ? "s" : ""}`).join(", ");

/* ---- iPhone: Apple's on-device model through the Shortcuts app ----
 * 1. We write Tracker/AI/request.json  { prompts: [...], jobs, sources, ids: {P1: path, R1: path} }
 * 2. We open the shortcut. It runs "Use Model (On-Device)" on each prompt and saves the answers,
 *    joined by SHORTCUT_SEP, to Tracker/AI/response.txt, then switches back to Obsidian.
 * 3. Next time Process inbox runs, we read the answers and write the Classified inbox.   */
async function startShortcut(env, cfg, g, cat) {
  const { app } = env;
  if (!(await aiExists(app, AI_DIR))) await app.vault.adapter.mkdir(AI_DIR);
  await aiRemove(app, AI_RES);
  const today = env.moment().format("YYYY-MM-DD");
  const prompts = g.jobs.map((j) => {
    const [sys, user] = j.type === "item" ? itemMessages(cat, j.text, today, cfg) : notesMessages(cat, j.text, today, cfg);
    return `${sys.content}\n\n${user.content}\n\nReply with the JSON object only.`;
  });
  const ids = Object.fromEntries([...cat.projects, ...cat.refs].map((p) => [p.id, p.path]));
  await app.vault.adapter.write(AI_REQ, JSON.stringify({ created: env.moment().format(), prompts, jobs: g.jobs, sources: g.sources, ids }, null, 1));
  env.notice(`Sorting your inbox with the on-device model in Shortcuts… When it brings you back, tap Process inbox again.`, 8000);
  env.openUrl(`shortcuts://run-shortcut?name=${encodeURIComponent(cfg.llm_shortcut)}`);
  throw new Handoff();
}
/** Turn the shortcut's answers into the Classified inbox. Returns {pending, records}. */
async function applyShortcutResults(env, cfg) {
  const { app } = env;
  if (!(await aiExists(app, AI_REQ))) return { pending: false, records: 0 };
  if (!(await aiExists(app, AI_RES))) return { pending: true, records: 0 };
  const req = JSON.parse(await app.vault.adapter.read(AI_REQ));
  const parts = (await app.vault.adapter.read(AI_RES)).split(SHORTCUT_SEP);
  const ids = req.ids || {};
  const pick = (list) => list.filter((p) => Object.values(ids).includes(p.path)).map((p) => Object.assign({}, p, { id: Object.keys(ids).find((k) => ids[k] === p.path) }));
  const cat = { projects: pick(listProjects(app, cfg)), refs: pick(referenceNotes(app, cfg)) };
  const answers = (req.jobs || []).map((j, k) => { try { return extractJson(stripThink(parts[k] || "")); } catch (e) { return null; } });
  const today = env.moment().format("YYYY-MM-DD");
  const records = jobRecords(req.jobs || [], answers, cat, cfg, today);
  await writeReview(app, cfg, records, req.sources || [], env.moment().format("YYYY-MM-DD HH:mm"));
  await aiRemove(app, AI_REQ); await aiRemove(app, AI_RES);
  return { pending: false, records: records.length };
}

/** Classify the whole inbox into the Classified inbox note. noModel: sort nothing, just list the items for you to place. Returns how many records. */
/** "task · Sailing", "reference · Travel", "spending 86.4 EUR" — for the progress panel. */
function answerText(a, cat) {
  if (!a) return "?";
  const name = (id, list) => ((list || []).find((x) => x.id === id) || {}).name;
  if (a.kind === "spending") return `spending${a.amount ? ` ${a.amount}${a.currency ? " " + a.currency : ""}` : ""}`;
  if (a.kind === "reference") return `reference · ${a.topic === "new" ? `new “${a.new_topic}”` : name(a.topic, cat.refs) || "no note"}`;
  return `${a.kind || "task"} · ${name(a.project, cat.projects) || "no project"}${typeof a.confidence === "number" ? ` (${Math.round(a.confidence * 100)}%)` : ""}`;
}
async function classifyInbox(env, cfg, { noModel = false } = {}) {
  const { app } = env;
  const today = env.moment().format("YYYY-MM-DD");
  const lines = (await readPath(app, cfg.inbox)).split("\n");
  const g = inboxJobs(lines, today);
  if (!g.jobs.length) { env.notice("Inbox is empty 🎉"); return 0; }
  const cat = await inboxCatalog(app, cfg);
  const viaShortcut = env.isMobile && String(cfg.llm_mobile).toLowerCase() === "shortcut";
  if (!noModel && viaShortcut) await startShortcut(env, cfg, g, cat);
  if (!noModel) { try { llmBase(env, cfg); } catch (e) { env.notice(`${e.message} — listing the items without sorting them.`, 9000); noModel = true; } }
  const answers = new Array(g.jobs.length).fill(null);
  let stopped = 0, modelSecs = 0, calls = 0;
  const job = noModel ? null : startJob(env, "🤖 Sorting the inbox", g.jobs.length);
  // consecutive items go in batches (llm_batch per request); free-text notes are one request each
  const units = [];
  for (const [k, j] of g.jobs.entries()) {
    const last = units[units.length - 1];
    if (j.type === "item" && last && last.type === "item" && last.ks.length < Math.max(1, Number(cfg.llm_batch) || 1)) last.ks.push(k);
    else units.push({ type: j.type, ks: [k] });
  }
  const ask1 = async (k) => {
    const j = g.jobs[k];
    const a = extractJson(await llmChat(env, cfg, j.type === "item" ? itemMessages(cat, j.text, today, cfg) : notesMessages(cat, j.text, today, cfg), j.type === "item" ? ITEM_SCHEMA(cat) : NOTES_SCHEMA(cat)));
    answers[k] = a; calls++; modelSecs += (job.stats && job.stats.wall) || 0;
    job.result(j.type === "item" ? `✓ ${j.text.slice(0, 40)} → ${answerText(a, cat)}` : `✓ notes → ${(a.items || []).map((x) => answerText(x, cat)).join(", ") || "nothing"}`);
    if (job.stats) job.result(`   ${statsText(job.stats)}`);
  };
  try {
    for (const u of units) {
      if (noModel) { if (job && job.stopped) stopped += u.ks.length; continue; }
      const k0 = u.ks[0], j0 = g.jobs[k0];
      job.step(k0 + 1, u.type !== "item" ? "your notes (free text)" : u.ks.length > 1 ? `items ${k0 + 1}–${k0 + u.ks.length}: ${j0.text}` : j0.text);
      try {
        if (u.ks.length === 1) await ask1(k0);
        else {
          const texts = u.ks.map((k) => g.jobs[k].text);
          const a = extractJson(await llmChat(env, cfg, batchMessages(cat, texts, today, cfg), BATCH_SCHEMA(cat)));
          calls++; modelSecs += (job.stats && job.stats.wall) || 0;
          const got = Array.isArray(a.items) ? a.items : [];
          u.ks.forEach((k, i) => {
            const x = got.find((y) => Number(y.n) === i + 1) || (got.length === u.ks.length ? got[i] : null);
            if (x) { answers[k] = x; job.result(`✓ ${g.jobs[k].text.slice(0, 40)} → ${answerText(x, cat)}`); }
          });
          if (job.stats) job.result(`   ${u.ks.length} items in one request · ${statsText(job.stats)}`);
          for (const k of u.ks) if (!answers[k]) { job.step(k + 1, g.jobs[k].text); await ask1(k); } // the model skipped one: ask about it alone
        }
      } catch (e) {
        if (e instanceof Stopped) { noModel = true; stopped += u.ks.filter((k) => !answers[k]).length; }
        else if (/can't reach/.test(e.message)) { env.notice(`${e.message} — listing the rest without sorting.`, 9000); noModel = true; }
      }
    }
  } finally { if (job) job.end(); }
  if (calls) env.notice(`Model: ${calls} request(s) for ${g.jobs.length} item(s), ${fmtSecs(modelSecs)} in all (${fmtSecs(modelSecs / g.jobs.length)} per item).`, 8000);
  if (stopped) env.notice(`Stopped — ${stopped} item(s) are listed in the Classified inbox without a destination.`, 8000);
  const records = jobRecords(g.jobs, answers, cat, cfg, today);
  await writeReview(app, cfg, records, g.sources, env.moment().format("YYYY-MM-DD HH:mm"));
  const open = records.filter((r) => r.kind !== "spending" && !r.dest && !r.newTopic).length;
  env.notice(`Classified inbox: ${recSummary(records)}${open ? ` · ${open} without a destination` : ""}. Check it, then press Apply.`, 8000);
  return records.length;
}

/* ---- reading the reviewed note back */
function parseReview(content) {
  const ls = String(content || "").split("\n"), out = [];
  for (const k of KINDS) {
    const s = findSection(ls, REVIEW_SECS[k]);
    if (!s) continue;
    for (const it of parseItems(ls, s.start, s.end)) {
      if (it.parent) continue;
      const sub = outdent(ls.slice(it.line + 1, blockEnd(ls, it)));
      const body = (it.task ? it.body : it.body.replace(/^(?:☐|💡|📎|💶)️?\s*/u, "")).trim();
      if (!stripFields(splitMeta(body).head)) continue;
      out.push({ kind: k, body, fields: parseFields(body), sub });
    }
  }
  return out;
}
/** Where a reviewed record goes: {type: project | note | newref | finance, path, name} or null (ask). */
function resolveDest(app, cfg, rec, projects) {
  if (rec.kind === "spending") return { type: "finance", path: cfg.finance_file, name: linkLabel(cfg.finance_file).replace(/\.md$/, "") };
  const v = rec.fields.to;
  if (!v || /^none$/i.test(linkLabel(v))) return null;
  const m = String(v).match(/\[\[([^\]|#]+)/), target = (m ? m[1] : v).trim();
  const f = app.metadataCache.getFirstLinkpathDest(target, REVIEW_PATH) || app.vault.getAbstractFileByPath(/\.md$/.test(target) ? target : `${target}.md`);
  const pp = f ? f.path : resolveProject(app, v, REVIEW_PATH, projects);
  if (pp) { const p = projects.find((x) => x.path === pp); return p ? { type: "project", path: p.path, name: p.name } : { type: "note", path: pp, name: pp.split("/").pop().replace(/\.md$/, "") }; }
  if (rec.kind !== "reference") { rec.wanted = sanitizeName(target.split("/").pop()); return null; } // a task or idea with a name that doesn't exist: ask (＋ New project offers that name)
  const name = sanitizeName(target.split("/").pop());
  return name ? { type: "newref", path: `${String(cfg.reference_folder || "References").replace(/\/+$/, "")}/${name}.md`, name } : null;
}
const destText = (d) => (!d ? "no destination" : d.type === "project" ? `→ ${d.name}` : d.type === "newproject" ? `→ ${d.name} (new project)` : d.type === "newref" ? `→ ${d.name} (new reference note)` : d.type === "finance" ? `→ ${d.name}` : d.type === "leave" ? "⏸ stays in the inbox" : d.type === "delete" ? "🗑 deleted" : `→ ${d.name}`);
const cleanRec = (body) => ["to", "check", "new", "kind", "conf"].reduce((l, k) => setField(l, k, null), body).replace(/\s{2,}/g, " ").trim();
/** The lines a record becomes at its destination. */
function filedLines(cfg, rec, dest, today) {
  const clean = cleanRec(rec.body), created = getDate(clean, "created") || today;
  const sub = rec.sub.map((l) => `\t${l}`);
  if (rec.kind === "spending") return [`- 💶 ${clean}`, ...sub];
  if (rec.kind === "task") return [newTask(cfg, `- [ ] ${clean}`, created), ...sub];
  const desc = stripFields(splitMeta(clean).head);
  return [`- ${rec.kind === "idea" ? "💡" : "📎"} ${desc} (${created})`, ...sub];
}

/** Ask where the records without a destination go. Every menu has ← Back; nothing is written until the end. Esc cancels. */
async function askDestinations(env, cfg, pending, projects, refs) {
  const live = projects.filter((p) => !p.routine && liveStatus(p)).sort((a, b) => projPrioRank(a) - projPrioRank(b) || a.name.localeCompare(b.name));
  const BACK = "__back";
  const newProjects = [];
  for (const r of pending) if (r.dest && r.dest.type === "newproject" && !newProjects.some((x) => x.dest === r.dest)) newProjects.push({ name: r.dest.name, isNew: true, dest: r.dest });
  let i = 0;
  while (i < pending.length) {
    const r = pending[i];
    const head = `(${i + 1}/${pending.length}) ${KIND_ICON[r.kind]} “${stripFields(splitMeta(cleanRec(r.body)).head).slice(0, 70)}”${r.dest ? ` — now ${destText(r.dest)}` : r.wanted ? ` — “${r.wanted}” isn't a project yet` : ""} · Esc cancels, nothing is applied yet`;
    const newProj = [r.wanted && !r.dest ? `＋ New project “${r.wanted}”…` : "＋ New project…", "newproject"];
    const top = r.kind === "reference" ? [["📚 Reference note…", "ref"], ["＋ New reference note…", "newref"], ["→ Project…", "project"], newProj] : [["→ Project…", "project"], newProj, ["📚 Reference note…", "ref"], ["＋ New reference note…", "newref"]];
    top.push([`✎ Change type (now ${KIND_NAME[r.kind]})…`, "kind"], ["⏸ Leave in the inbox", "leave"], ["🗑 Delete", "delete"]);
    if (i > 0) top.push(["← Back to the previous item", "prev"]);
    const c = await ask(env, top.map((o) => o[0]), top.map((o) => o[1]), head);
    if (c === "prev") { i--; continue; }
    if (c === "leave" || c === "delete") { r.dest = { type: c }; i++; continue; }
    if (c === "kind") {
      const ks = ["task", "idea", "reference"].filter((k) => k !== r.kind);
      const k = await env.suggest([...ks.map((k) => `${KIND_ICON[k]} ${KIND_NAME[k]}`), "← Back"], [...ks, BACK], `What is “${stripFields(splitMeta(cleanRec(r.body)).head).slice(0, 60)}”?`);
      if (k && k !== BACK) r.kind = k;
      continue; // same item again, with the new type
    }
    if (c === "project") {
      const choices = [...newProjects, ...live];
      const p = await env.suggest([...choices.map((x) => `${x.name}${x.isNew ? " (new — created when you apply)" : x.status !== "active" ? ` (${x.status})` : ""}`), "← Back"], [...choices, BACK], `${KIND_ICON[r.kind]} To which project?`);
      if (!p || p === BACK) continue;
      r.dest = p.isNew ? p.dest : { type: "project", path: p.path, name: p.name };
    } else if (c === "newproject") {
      // nothing is created yet: the project note is made when you apply, with everything filed into it
      const name = sanitizeName(oneLine(await env.prompt("＋ New project — name (empty = back)", r.wanted || "")));
      if (!name) continue;
      const ex = projects.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (ex) { r.dest = { type: "project", path: ex.path, name: ex.name }; env.notice(`“${ex.name}” already exists — filed there.`, 4000); i++; continue; }
      const again = newProjects.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (again) { r.dest = again.dest; i++; continue; }
      const roots = cfg.project_roots.filter((x) => env.app.vault.getAbstractFileByPath(x));
      if (!roots.length) { env.notice("No project folders set up yet — run Register projects first.", 6000); continue; }
      const root = roots.length > 1 ? await env.suggest([...roots, "← Back"], [...roots, BACK], `Folder for “${name}”?`) : roots[0];
      if (!root || root === BACK) continue;
      const description = await env.prompt(`“${name}”: one line — what is it about? (optional; Esc = back)`, "");
      if (description === null || description === undefined) continue;
      const dest = { type: "newproject", path: `${root}/${name}/${name}.md`, name, root, description: oneLine(description) };
      newProjects.push({ name, isNew: true, dest });
      r.dest = dest;
    } else if (c === "ref") {
      if (!refs.length) { env.notice(`No reference notes in ${cfg.reference_folder} yet — use ＋ New reference note.`, 5000); continue; }
      const n = await env.suggest([...refs.map((x) => x.name), "← Back"], [...refs, BACK], "📚 To which reference note?");
      if (!n || n === BACK) continue;
      r.dest = { type: "note", path: n.path, name: n.name };
    } else if (c === "newref") {
      const name = sanitizeName(oneLine(await env.prompt(`＋ Name of the new reference note in ${cfg.reference_folder} (empty = back)`, "")));
      if (!name) continue;
      const ex = refs.find((x) => x.name.toLowerCase() === name.toLowerCase());
      r.dest = ex ? { type: "note", path: ex.path, name: ex.name } : { type: "newref", path: `${String(cfg.reference_folder).replace(/\/+$/, "")}/${name}.md`, name };
    }
    i++;
  }
}

const FINANCE_TEMPLATE = (name) => `---
type: finance
---
# ${name}

Spendings collected from the inbox. Move the ones you've dealt with out of **Unprocessed** (into your budget, a spreadsheet…) and tick the task.

## To do

## Unprocessed
`;
/** Add spending lines to the finance file and keep exactly one open task to process them. */
async function addSpendings(app, cfg, lines, today) {
  const path = cfg.finance_file;
  const name = path.split("/").pop().replace(/\.md$/, "");
  if (!app.vault.getAbstractFileByPath(path)) await createFile(app, path, FINANCE_TEMPLATE(name));
  let count = 0;
  await editLines(app, path, (ls) => {
    insertIntoSection(ls, "Unprocessed", lines);
    const s = findSection(ls, "Unprocessed");
    count = parseItems(ls, s.start, s.end).filter((x) => !x.parent && !x.task).length;
  });
  const projects = listProjects(app, cfg);
  const pp = cfg.finance_project ? resolveProject(app, cfg.finance_project, CONFIG_PATH, projects) : null;
  const where = pp || path;
  const text = `Process ${count} new spending(s) in ${linkTo(app, path, where, name)}`;
  await editLines(app, where, (ls) => {
    const k = ls.findIndex((l) => /^\s*[-*+]\s+\[[ /]\]/.test(l) && l.includes("[spendings:: inbox]"));
    if (k >= 0) { ls[k] = ls[k].replace(/Process \d+ new spending\(s\) in \[\[[^\]]*\]\]/, text); return; }
    const line = setDate(newTask(cfg, `- [ ] ${text} [spendings:: inbox]`, today), "scheduled", today);
    if (pp) insertIntoProjectSection(ls, "Backlog", [line]); else insertIntoSection(ls, "To do", [line]);
  });
  return { count, where };
}
function appendLines(ls, lines) {
  while (ls.length && ls[ls.length - 1].trim() === "") ls.pop();
  const last = ls[ls.length - 1] || "";
  if (ls.length && !LIST_RE.test(last) && !/^\s/.test(last)) ls.push("");
  ls.push(...lines, "");
}
function removeSources(ls, sources) {
  let missed = 0;
  for (const s of sources) {
    if (s.block) {
      const n = s.lines.length;
      let at = -1;
      for (let i = 0; i + n <= ls.length && at < 0; i++) if (s.lines.every((l, k) => ls[i + k] === l)) at = i;
      if (at >= 0) ls.splice(at, n); else missed++;
    } else for (const l of s.lines) { const i = ls.indexOf(l); if (i >= 0) ls.splice(i, 1); else missed++; }
  }
  // collapse the blank lines left behind (not inside the frontmatter)
  for (let i = ls.length - 1; i > 0; i--) if (ls[i].trim() === "" && ls[i - 1].trim() === "") ls.splice(i, 1);
  return missed;
}

async function cmdApplyInbox(env) {
  const { app } = env, cfg = getConfig(app);
  const snap = await loadSnap(app);
  const content = await readPath(app, REVIEW_PATH);
  if (!snap || content === null) { env.notice("Nothing to apply — run Process inbox first."); return; }
  const today = env.moment().format("YYYY-MM-DD");
  const projects = listProjects(app, cfg), refs = referenceNotes(app, cfg);
  const recs = parseReview(content);
  for (const r of recs) r.dest = resolveDest(app, cfg, r, projects);
  const pending = recs.filter((r) => !r.dest);
  if (pending.length) await askDestinations(env, cfg, pending, projects, refs);
  // last check, with a way back to the questions
  for (;;) {
    const by = (t) => recs.filter((r) => r.dest && r.dest.type === t).length;
    const sum = [[by("project") + by("newproject"), "to projects"], [by("note") + by("newref"), "to reference notes"], [by("finance"), "spendings"], [by("leave"), "left in the inbox"], [by("delete"), "deleted"]].filter(([n]) => n).map(([n, l]) => `${n} ${l}`).join(" · ");
    const opts = [["✔ Apply", "apply"]];
    if (pending.length) opts.push(["← Back to the questions", "back"]);
    opts.push(["✖ Cancel — change nothing", "cancel"]);
    const c = await ask(env, opts.map((o) => o[0]), opts.map((o) => o[1]), `Apply: ${sum || "nothing"}?`);
    if (c === "cancel") throw new Cancelled();
    if (c === "apply") break;
    await askDestinations(env, cfg, pending, projects, refs);
  }
  // 1. destinations
  const groups = new Map();
  const add = (d, section, lines) => { if (!groups.has(d.path)) groups.set(d.path, { d, secs: new Map() }); const g = groups.get(d.path).secs; if (!g.has(section)) g.set(section, []); g.get(section).push(...lines); };
  const spend = [], leftover = [];
  for (const r of recs) {
    const d = r.dest;
    if (d.type === "delete") continue;
    if (d.type === "leave") { const clean = cleanRec(r.body); leftover.push(/^\[.\]/.test(clean) ? `- ${clean}` : `- [ ] ${clean}`, ...r.sub.map((l) => `\t${l}`)); continue; }
    const lines = filedLines(cfg, r, d, today);
    if (d.type === "finance") { spend.push(...lines); continue; }
    if (d.type === "project" || d.type === "newproject") add(d, r.kind === "task" ? (parseFields(r.body).week ? PLANNED_SEC : "Backlog") : "Notes & ideas", lines);
    else add(d, "", lines);
  }
  for (const { d, secs } of groups.values()) {
    if (d.type === "newproject" && !app.vault.getAbstractFileByPath(d.path)) await createFile(app, d.path, projectNote({ name: d.name, scope: d.root.split("/").pop().toLowerCase(), status: "active", description: d.description, objective: "", today }));
    if (d.type === "newref" && !app.vault.getAbstractFileByPath(d.path)) await createFile(app, d.path, `---\ntype: reference\ndescription: ""\n---\n# ${d.name}\n`);
    await editLines(app, d.path, (ls) => { for (const [sec, lines] of secs) { if (sec) insertIntoProjectSection(ls, sec, lines); else appendLines(ls, lines); } });
  }
  let fin = null;
  if (spend.length) fin = await addSpendings(app, cfg, spend, today);
  // 2. the inbox: archive and remove what was classified, put back what you left
  const stamp = env.moment().format("YYYY-MM-DD HH:mm");
  let missed = 0;
  await editLines(app, cfg.inbox, (ls) => { missed = removeSources(ls, snap.sources || []); if (leftover.length) insertIntoSection(ls, "Queue", leftover); });
  const filed = recs.filter((r) => !["leave", "delete"].includes(r.dest.type));
  const entry = `\n## ${stamp}\n\n${(snap.sources || []).map((s) => s.lines.join("\n")).join("\n")}\n\n→ ${filed.length} filed: ${filed.map((r) => `${KIND_ICON[r.kind]} ${stripFields(splitMeta(cleanRec(r.body)).head)} ${destText(r.dest)}`).join(" · ")}\n`;
  const af = app.vault.getAbstractFileByPath(INBOX_ARCHIVE);
  if (af) await app.vault.modify(af, (await app.vault.read(af)).replace(/\s*$/, "\n") + entry);
  else await createFile(app, INBOX_ARCHIVE, `# Inbox archive\n\nWhat the inbox held, as you wrote it, each time Apply inbox filed it.\n${entry}`);
  // 3. done: empty review
  await writeFile(app, REVIEW_PATH, EMPTY_REVIEW);
  await aiRemove(app, REVIEW_SNAP);
  const by = (t) => recs.filter((r) => r.dest.type === t).length;
  const made = [...new Set(recs.filter((r) => r.dest.type === "newproject").map((r) => r.dest.name))];
  env.notice(`Inbox applied: ${by("project") + by("newproject")} to projects${made.length ? ` (new: ${made.join(", ")})` : ""} · ${by("note") + by("newref")} to reference notes${fin ? ` · ${spend.filter((l) => !/^\t/.test(l)).length} spending(s) → “Process ${fin.count} new spending(s)” task` : ""}${by("leave") ? ` · ${by("leave")} left in the inbox` : ""}${missed ? ` · ${missed} inbox line(s) changed after classifying were left in place` : ""}`, 9000);
}

/** Process inbox: classify into the Classified inbox (or, when one is waiting, apply / open / redo it). */
async function cmdProcess(env) {
  const { app } = env, cfg = getConfig(app);
  await ensureInbox(app, cfg);
  let noModel = false;
  if (env.isMobile && String(cfg.llm_mobile).toLowerCase() === "shortcut") {
    const st = await applyShortcutResults(env, cfg);
    if (st.records) { env.notice(`Classified inbox: ${st.records} item(s) from the on-device model. Check them, then press Apply.`, 8000); await env.open(REVIEW_PATH); return; }
    if (st.pending) {
      const c = await ask(env, ["↻ Run the on-device model again", "Continue without AI"], ["run", "skip"], "No answers from the shortcut yet");
      await aiRemove(app, AI_REQ);
      if (c === "skip") noModel = true;
    }
  }
  if (await loadSnap(app)) {
    const c = await ask(env, ["✔ Apply the reviewed items", "👀 Open the Classified inbox", "↻ Classify again (replaces the review)"], ["apply", "open", "again"], "Your classified inbox is waiting for review");
    if (c === "apply") return cmdApplyInbox(env);
    if (c === "open") return env.open(REVIEW_PATH);
  }
  if (await classifyInbox(env, cfg, { noModel })) await env.open(REVIEW_PATH);
}
async function cmdClassify(env) {
  const { app } = env, cfg = getConfig(app);
  await ensureInbox(app, cfg);
  if (await classifyInbox(env, cfg)) await env.open(REVIEW_PATH);
}

/** The summary on top of Tracker/Classified inbox. */
async function renderClassified(app) {
  const cfg = getConfig(app);
  const snap = await loadSnap(app);
  let h = `<div class="pt">`;
  if (!snap) return h + `<div class="pt-empty">Nothing to review. <b>Process inbox</b> sorts your inbox into this note, and your inbox stays as it is until you apply it.</div>${buttons([["Process inbox", "Process inbox", true]])}</div>`;
  const projects = listProjects(app, cfg);
  const recs = parseReview(await readPath(app, REVIEW_PATH));
  for (const r of recs) r.dest = resolveDest(app, cfg, r, projects);
  const n = (f) => recs.filter(f).length;
  const newRefs = [...new Set(recs.filter((r) => r.dest && r.dest.type === "newref").map((r) => r.dest.name))];
  h += `<div class="pt-kpis">${kpi("To projects", n((r) => r.dest && r.dest.type === "project"))}${kpi("To reference notes", n((r) => r.dest && ["note", "newref"].includes(r.dest.type)), newRefs.length ? `new: ${esc(newRefs.join(", "))}` : "")}${kpi("Spendings", n((r) => r.kind === "spending"), `→ ${esc(cfg.finance_file)}`)}${kpi("No destination", n((r) => !r.dest), "asked when you apply")}${kpi("Unsure", n((r) => r.fields.check), "[check:: unsure]")}</div>`;
  h += `<div class="pt-muted pt-hint">Classified ${esc(snap.created || "")} from ${(snap.sources || []).length} inbox entr${(snap.sources || []).length === 1 ? "y" : "ies"}. Anything added to the inbox since then stays there.</div>`;
  return h + buttons([["Apply inbox", "Apply inbox", true], ["Classify again", "Process inbox"]]) + `</div>`;
}

/* ------------------------------------------------------------------ project review (LLM): tasks vs goals, duplicates
 * On a project page, the local model compares the open tasks (Planned, Unplanned, Backlog) with the project's
 * objective and this / next week's goals: which tasks are missing to reach them, and which tasks are the same work.
 * Suggestions are kept in Tracker/AI/analysis.json until you add / merge / dismiss them. */
const ANALYSIS_STORE = `${AI_DIR}/analysis.json`;
const TASK_SECS = [PLANNED_SEC, UNPLANNED_SEC, "Backlog"];
async function loadAnalysis(app) {
  try { return (await aiExists(app, ANALYSIS_STORE)) ? JSON.parse(await app.vault.adapter.read(ANALYSIS_STORE)) || {} : {}; } catch (e) { return {}; }
}
async function saveAnalysis(app, store) {
  if (!(await aiExists(app, AI_DIR))) await app.vault.adapter.mkdir(AI_DIR);
  await app.vault.adapter.write(ANALYSIS_STORE, JSON.stringify(store, null, 1));
}
/** Open top-level tasks of a project note, by section. */
function projectTasks(lines) {
  const out = [];
  for (const sec of TASK_SECS) {
    const s = findSection(lines, sec);
    if (!s) continue;
    for (const it of parseItems(lines, s.start, s.end)) if (it.task && !it.parent && isOpen(it) && it.desc) out.push({ raw: it.raw, desc: it.desc, section: sec, week: weekIds(it.fields.week)[0] || null, due: getDate(it.raw, "due") });
  }
  return out;
}
function projectGoals(d, p, lines) {
  const gs = [];
  const okr = lines ? parseOkr(lines) : p.okr || [];
  if (p.objective && !okr.some((o) => o.text === p.objective)) gs.push({ id: "G1", text: p.objective, label: "Objective" });
  for (const o of okr) {
    gs.push({ id: `G${gs.length + 1}`, text: o.text, label: `Objective${o.by ? ` by ${o.by}` : ""}` });
    for (const k of o.krs) gs.push({ id: `G${gs.length + 1}`, text: `${k.text}${k.target !== null ? ` (now ${k.now ?? k.start ?? 0}, target ${k.target})` : ""}`, label: "Key result" });
  }
  for (const [wid, label] of [[d.curId, "This week"], [shiftWeek(d.curId, 1), "Next week"]]) {
    const w = d.weekMap.get(wid), g = w ? w.goals.find((x) => x.projectPath === p.path) : null;
    if (g) gs.push({ id: `G${gs.length + 1}`, text: g.text, label: `${label} (${wid})`, week: wid });
  }
  return gs;
}
function analysisHash(tasks, goals) {
  const str = tasks.map((t) => t.raw).join("\n") + "\u0001" + goals.map((g) => g.text).join("\n");
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function analysisMessages(p, goals, tasks, today) {
  const system = "You review a project in a personal planning system: do its tasks lead to its goals, and are some tasks duplicates of each other. You answer with one JSON object and nothing else.";
  const user = `Today is ${today}.
Project: ${p.name}${p.description ? ` — ${p.description}` : ""}

Goals:
${goals.length ? goals.map((g) => `${g.id} (${g.label}): ${g.text}`).join("\n") : "(no goals set)"}

Open tasks:
${tasks.length ? tasks.map((t, i) => `T${i + 1} [${t.section}${t.week ? `, ${t.week}` : ""}${t.due ? `, due ${t.due}` : ""}]: ${t.desc}`).join("\n") : "(none)"}

Answer:
- "summary": one or two sentences: how well the tasks cover the goals, and the biggest gap.
- "missing": up to 5 concrete tasks that are clearly needed to reach a goal but are not in the list (not just reworded existing tasks). Each: "text" (a short task starting with a verb, in the language of the tasks), "goal" (the goal id it serves), "why" (a few words).
- "duplicates": groups of tasks that describe the same work. Each: "tasks" (two or more task ids), "merged" (one task text that covers all of them), "why" (a few words). Only real duplicates — related but different steps are not duplicates. [] if there are none.

Answer with JSON like {"summary":"…","missing":[{"text":"Book the haul-out","goal":"G2","why":"needed before winter"}],"duplicates":[{"tasks":["T2","T5"],"merged":"…","why":"same call"}]}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}
const ANALYSIS_SCHEMA = (gids, tids) => ({ type: "object", properties: {
  summary: { type: "string" },
  missing: { type: "array", items: { type: "object", properties: { text: { type: "string" }, goal: { type: "string", enum: gids.length ? gids : ["none"] }, why: { type: "string" } }, required: ["text", "goal", "why"], additionalProperties: false } },
  duplicates: { type: "array", items: { type: "object", properties: { tasks: { type: "array", items: { type: "string", enum: tids.length ? tids : ["none"] } }, merged: { type: "string" }, why: { type: "string" } }, required: ["tasks", "merged", "why"], additionalProperties: false } },
}, required: ["summary", "missing", "duplicates"], additionalProperties: false });
function normalizeAnalysis(out, goals, tasks) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const have = new Set(tasks.map((t) => norm(t.desc)));
  const missing = (Array.isArray(out && out.missing) ? out.missing : []).map((m) => ({ text: oneLine(m && m.text), goal: (goals.find((g) => g.id === String(m && m.goal).trim()) || {}).id || null, why: oneLine(m && m.why) }))
    .filter((m) => m.text && !have.has(norm(m.text))).slice(0, 5);
  const used = new Set();
  const duplicates = [];
  for (const g of Array.isArray(out && out.duplicates) ? out.duplicates : []) {
    const idx = [...new Set((Array.isArray(g && g.tasks) ? g.tasks : []).map((t) => parseInt(String(t).replace(/\D/g, ""), 10) - 1))].filter((i) => i >= 0 && i < tasks.length && !used.has(i));
    if (idx.length < 2) continue;
    idx.forEach((i) => used.add(i));
    duplicates.push({ lines: idx.map((i) => tasks[i].raw), merged: oneLine(g.merged) || tasks[idx[0]].desc, why: oneLine(g.why) });
  }
  return { summary: oneLine(out && out.summary), missing, duplicates };
}
async function analyzeProject(env, path) {
  const { app } = env, cfg = getConfig(app);
  const d = await loadAll(app);
  const p = d.byPath.get(path);
  if (!p || p.routine) throw new Error("not a project with tasks");
  const plines = (await readPath(app, path)).split("\n");
  const tasks = projectTasks(plines), goals = projectGoals(d, p, plines);
  if (!tasks.length && !goals.length) throw new Error("no open tasks and no goals to compare yet");
  const out = extractJson(await llmChat(env, cfg, analysisMessages(p, goals, tasks, env.moment().format("YYYY-MM-DD")), ANALYSIS_SCHEMA(goals.map((g) => g.id), tasks.map((_, i) => `T${i + 1}`))));
  return Object.assign(normalizeAnalysis(out, goals, tasks), { goals: goals.map((g) => ({ id: g.id, text: g.text, label: g.label, week: g.week || null })), hash: analysisHash(tasks, goals), created: env.moment().format("YYYY-MM-DD HH:mm") });
}
/** Put new description text on a task line, keeping its checkbox, fields and Tasks signifiers. */
function replaceDesc(line, text) {
  const box = (line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s*/) || ["- [ ] "])[0];
  const { head, meta } = splitMeta(line);
  const fields = (head.match(new RegExp(FIELD_SRC, "g")) || []).join(" ");
  return joinMeta(`${box}${text}${fields ? " " + fields : ""}`, meta);
}
/** Merge duplicate tasks into the first one (a task planned for a week wins): new text, the others' sub-items and a (merged) note under it. */
async function mergeTasks(app, path, lines, text) {
  let ok = false;
  await editLines(app, path, (ls) => {
    const at = lines.map((raw) => ls.indexOf(raw));
    if (at.some((i) => i < 0)) return;
    const items = at.map((i) => parseItems(ls, i, i + 1)[0]);
    const order = items.map((_, k) => k).sort((a, b) => (!!parseFields(lines[b]).week - !!parseFields(lines[a]).week) || at[a] - at[b]);
    const keep = order[0], kIt = items[keep];
    const extra = [];
    for (const k of order.slice(1)) {
      const it = items[k];
      extra.push(`${kIt.ws}\t- (merged) ${it.desc}`, ...outdent(ls.slice(it.line + 1, blockEnd(ls, it))).map((l) => `${kIt.ws}\t\t${l}`));
    }
    // remove the others bottom-up, then rewrite the kept one
    for (const k of order.slice(1).sort((a, b) => at[b] - at[a])) { const it = items[k]; ls.splice(it.line, blockEnd(ls, it) - it.line); }
    const ki = ls.indexOf(lines[keep]);
    const kept = parseItems(ls, ki, ki + 1)[0];
    ls.splice(blockEnd(ls, kept), 0, ...extra);
    ls[ki] = replaceDesc(lines[keep], text);
    ok = true;
  });
  return ok;
}
/** Buttons on the project page's AI review card: analyze | add | add-week | skip-missing | merge | skip-dup. Returns a message. */
/* ---- Refine backlog: the model proposes clearer wording and merges of duplicates; you confirm each change on a diff. */
function backlogTasks(lines) {
  const s = findSection(lines, "Backlog");
  return s ? parseItems(lines, s.start, s.end).filter((it) => it.task && !it.parent && isOpen(it) && it.desc).map((it) => ({ raw: it.raw, desc: it.desc })) : [];
}
function refineMessages(p, tasks) {
  const system = "You tidy up the backlog of a project in a personal planning system. You answer with one JSON object and nothing else.";
  const user = `Project: ${p.name}${p.description ? ` — ${p.description}` : ""}

Backlog:
${tasks.map((t, i) => `T${i + 1}: ${t.desc}`).join("\n")}

Answer:
- "duplicates": groups of tasks that are the same work. Each: "tasks" (two or more ids), "merged" (one clear task text that covers all of them), "why" (a few words). Related but different steps are not duplicates. [] if none.
- "rewrites": tasks whose wording is unclear, vague, too long or not an action. Each: "task" (its id), "text" (the better wording), "why" (a few words). Start with a verb, keep it short and specific, keep the meaning, every name, number, link and #tag, and the language of the task. Don't touch tasks that are already clear, and don't rewrite tasks that are in a duplicates group. [] if none.

Answer with JSON like {"duplicates":[{"tasks":["T2","T5"],"merged":"Call the marina about the winter berth","why":"same call"}],"rewrites":[{"task":"T3","text":"Order 2 fenders for the stern","why":"vague"}]}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}
const REFINE_SCHEMA = (tids) => ({ type: "object", properties: {
  duplicates: { type: "array", items: { type: "object", properties: { tasks: { type: "array", items: { type: "string", enum: tids } }, merged: { type: "string" }, why: { type: "string" } }, required: ["tasks", "merged", "why"], additionalProperties: false } },
  rewrites: { type: "array", items: { type: "object", properties: { task: { type: "string", enum: tids }, text: { type: "string" }, why: { type: "string" } }, required: ["task", "text", "why"], additionalProperties: false } },
}, required: ["duplicates", "rewrites"], additionalProperties: false });
function normalizeRefine(out, tasks) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const id = (t) => parseInt(String(t).replace(/\D/g, ""), 10) - 1;
  const used = new Set(), changes = [];
  for (const g of Array.isArray(out && out.duplicates) ? out.duplicates : []) {
    const idx = [...new Set((Array.isArray(g && g.tasks) ? g.tasks : []).map(id))].filter((i) => i >= 0 && i < tasks.length && !used.has(i));
    if (idx.length < 2) continue;
    idx.forEach((i) => used.add(i));
    changes.push({ type: "merge", lines: idx.map((i) => tasks[i].raw), text: oneLine(g.merged) || tasks[idx[0]].desc, why: oneLine(g.why) });
  }
  for (const r of Array.isArray(out && out.rewrites) ? out.rewrites : []) {
    const i = id(r && r.task), text = oneLine(r && r.text);
    if (!(i >= 0 && i < tasks.length) || used.has(i) || !text || norm(text) === norm(tasks[i].desc)) continue;
    used.add(i);
    changes.push({ type: "rewrite", lines: [tasks[i].raw], text, why: oneLine(r.why) });
  }
  return changes;
}
async function refineBacklog(env, path) {
  const { app } = env, cfg = getConfig(app);
  const p = listProjects(app, cfg).find((x) => x.path === path);
  if (!p || p.routine) throw new Error("not a project with a backlog");
  const tasks = backlogTasks((await readPath(app, path)).split("\n"));
  if (tasks.length < 1) throw new Error("the backlog is empty");
  const out = extractJson(await llmChat(env, cfg, refineMessages(p, tasks), REFINE_SCHEMA(tasks.map((_, i) => `T${i + 1}`))));
  return { changes: normalizeRefine(out, tasks), count: tasks.length, created: env.moment().format("YYYY-MM-DD HH:mm") };
}
/** Word-level diff → [html of the old text with <del>, html of the new text with <ins>]. */
function wordDiff(a, b) {
  const A = String(a).split(/(\s+)/), B = String(b).split(/(\s+)/);
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, o = "", nw = "";
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { o += esc(A[i]); nw += esc(B[j]); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { nw += /^\s+$/.test(B[j]) ? B[j] : `<ins>${esc(B[j])}</ins>`; j++; }
    else { o += /^\s+$/.test(A[i]) ? A[i] : `<del>${esc(A[i])}</del>`; i++; }
  }
  return [o.replace(/<\/del>(\s*)<del>/g, "$1"), nw.replace(/<\/ins>(\s*)<ins>/g, "$1")];
}
function refineCard(d, p, r, lines) {
  const btn = (act, label, i, cta = false, title = "", dis = false) => `<button class="pt-mini${cta ? " mod-cta" : ""}" data-ai="${act}" data-path="${esc(p.path)}"${i !== undefined ? ` data-i="${i}"` : ""}${title ? ` title="${esc(title)}"` : ""}${dis ? " disabled" : ""}>${label}</button>`;
  let h = `<div class="pt-card pt-ai"><div class="pt-card-head"><span class="pt-h">✨ Refine backlog</span>${r ? `<span class="pt-muted">proposed ${esc(r.created)}</span>` : ""}${btn("refine", r ? "↻ Refine again" : "Refine with the local model", undefined, !r, "The model proposes clearer wording and merges of duplicates in ## Backlog; you confirm each change")}</div>`;
  if (!r) return h + `<div class="pt-muted pt-hint">Proposes clearer wording for vague backlog items and merges items that are the same work. Every change is shown as a diff and only made when you press Apply.</div></div>`;
  if (!r.changes.length) return h + `<div class="pt-muted">No changes proposed — the backlog looks clear.${btn("refine-clear", "OK", undefined)}</div></div>`;
  const here = new Set(lines || []);
  h += `<div class="pt-muted pt-hint">${r.changes.length} change(s). Dates, priorities and fields stay as they are; only the wording changes. Apply or skip each one.</div>`;
  h += r.changes.map((c, i) => {
    const stale = c.lines.some((l) => !here.has(l));
    let diff = "";
    if (c.type === "rewrite") {
      const [o, nw] = wordDiff(taskDesc(c.lines[0]), c.text);
      diff = `<div class="pt-diff-old">− ${o}</div><div class="pt-diff-new">+ ${nw}</div>`;
    } else {
      diff = c.lines.map((l) => `<div class="pt-diff-old">− ${wordDiff(taskDesc(l), c.text)[0]}</div>`).join("") + `<div class="pt-diff-new">+ ${wordDiff(taskDesc(c.lines[0]), c.text)[1]}</div>`;
    }
    return `<div class="pt-ai-row${stale ? " is-stale" : ""}"><div class="pt-diff"><div class="pt-diff-kind">${c.type === "merge" ? `Merge ${c.lines.length} duplicates` : "Rephrase"}${c.why ? ` <span class="pt-muted">· ${esc(c.why)}</span>` : ""}${stale ? ` <span class="pt-warn">· changed since — skip or refine again</span>` : ""}</div>${diff}${c.type === "merge" ? `<div class="pt-muted pt-hint">One task stays (the one planned for a week, else the first) with this text; the others become “(merged) …” notes under it.</div>` : ""}</div>`
      + `<div class="pt-ai-btns">${btn("refine-apply", "✔ Apply", i, true, "Make this change in the backlog", stale)}${btn("refine-skip", "Skip", i, false, "Don't make this change")}</div></div>`;
  }).join("");
  return h + `</div>`;
}
async function projectAction(env, act, path, i) {
  const { app } = env, cfg = getConfig(app);
  const store = await loadAnalysis(app);
  const a = store[path];
  const today = env.moment().format("YYYY-MM-DD");
  let msg = "";
  const rk = `refine:${path}`;
  if (act === "refine") {
    const job = startJob(env, "✨ Refining the backlog", 1);
    job.step(1, (listProjects(app, cfg).find((x) => x.path === path) || {}).name || "");
    try { store[rk] = await refineBacklog(env, path); }
    catch (e) { if (e instanceof Stopped) return "Stopped — nothing changed."; throw e; }
    finally { job.end(); }
    await saveAnalysis(app, store);
    const c = store[rk].changes;
    return c.length ? `✨ ${c.filter((x) => x.type === "rewrite").length} rewording(s), ${c.filter((x) => x.type === "merge").length} merge(s) proposed — check each one below.` : "✨ The backlog looks clear — nothing to change.";
  }
  if (act === "refine-apply" || act === "refine-skip" || act === "refine-clear") {
    const r = store[rk];
    if (!r) throw new Error("no proposals — refine first");
    i = Number(i);
    if (act === "refine-clear") delete store[rk];
    else {
      const c = r.changes[i];
      if (!c) throw new Error("that proposal is gone");
      if (act === "refine-apply") {
        if (c.type === "merge") { if (!(await mergeTasks(app, path, c.lines, c.text))) throw new Error("those tasks changed since — refine again"); msg = `Merged ${c.lines.length} tasks into “${c.text}”`; }
        else {
          let ok = false;
          await editLines(app, path, (ls) => { const k = ls.indexOf(c.lines[0]); if (k >= 0) { ls[k] = replaceDesc(c.lines[0], c.text); ok = true; } });
          if (!ok) throw new Error("that task changed since — refine again");
          msg = `Reworded: “${c.text}”`;
        }
      }
      r.changes.splice(i, 1);
      if (!r.changes.length) delete store[rk];
    }
    await saveAnalysis(app, store);
    return msg;
  }
  if (act === "analyze") {
    const job = startJob(env, "🔍 Analyzing tasks vs goals", 1);
    job.step(1, (getConfig(app) && (listProjects(app, cfg).find((x) => x.path === path) || {}).name) || "");
    try { store[path] = await analyzeProject(env, path); }
    catch (e) { if (e instanceof Stopped) return "Stopped — the previous review is kept."; throw e; }
    finally { job.end(); }
    const r = store[path];
    msg = `Project review: ${r.missing.length} missing task(s), ${r.duplicates.length} duplicate group(s)`;
  } else {
    if (!a) throw new Error("no review for this project — analyze it first");
    i = Number(i);
    if (act === "add" || act === "add-week") {
      const m = a.missing[i];
      if (!m) throw new Error("that suggestion is gone");
      let line = newTask(cfg, `- [ ] ${m.text}`, today);
      if (act === "add-week") { line = setField(line, "week", weekId(env.moment())); await addPlanned(app, path, [line]); }
      else await editLines(app, path, (ls) => insertIntoProjectSection(ls, "Backlog", [line]));
      a.missing.splice(i, 1);
      msg = act === "add-week" ? `Added to this week: ${m.text}` : `Added to the backlog: ${m.text}`;
    } else if (act === "merge") {
      const g = a.duplicates[i];
      if (!g) throw new Error("that suggestion is gone");
      if (!(await mergeTasks(app, path, g.lines, g.merged))) throw new Error("those tasks changed since the review — analyze again");
      a.duplicates.splice(i, 1);
      msg = `Merged ${g.lines.length} tasks into “${g.merged}”`;
    } else if (act === "skip-missing") a.missing.splice(i, 1);
    else if (act === "skip-dup") a.duplicates.splice(i, 1);
    else throw new Error(`unknown action ${act}`);
  }
  await saveAnalysis(app, store);
  return msg;
}
function analysisCard(d, p, a, lines) {
  const btn = (act, label, i, cta = false, title = "") => `<button class="pt-mini${cta ? " mod-cta" : ""}" data-ai="${act}" data-path="${esc(p.path)}"${i !== undefined ? ` data-i="${i}"` : ""}${title ? ` title="${esc(title)}"` : ""}>${label}</button>`;
  let h = `<div class="pt-card pt-ai"><div class="pt-card-head"><span class="pt-h">🔍 Tasks vs goals</span>${a ? `<span class="pt-muted">reviewed ${esc(a.created)}</span>` : ""}${btn("analyze", a ? "↻ Analyze again" : "Analyze with the local model", undefined, !a, "Check the open tasks against the objective and this / next week's goals, and look for duplicates")}</div>`;
  if (!a) return h + `<div class="pt-muted pt-hint">Finds tasks that are missing to reach the goals, and tasks that are the same work, so you can add or merge them.</div></div>`;
  const tasks = lines ? projectTasks(lines) : [];
  if (lines && a.hash !== analysisHash(tasks, projectGoals(d, p, lines))) h += `<div class="pt-muted pt-hint">The tasks or goals changed since this review.</div>`;
  if (a.summary) h += `<div class="pt-ai-summary">${esc(a.summary)}</div>`;
  const goalOf = (id) => (a.goals || []).find((g) => g.id === id);
  if (a.missing.length) {
    h += `<div class="pt-sub">Missing to reach the goals <span class="pt-count">${a.missing.length}</span></div>`;
    h += a.missing.map((m, i) => { const g = goalOf(m.goal); return `<div class="pt-ai-row"><div><b>＋ ${esc(m.text)}</b>${m.why || g ? `<div class="pt-muted">${g ? `${esc(g.label)}: ${esc(g.text)}` : ""}${m.why ? `${g ? " · " : ""}${esc(m.why)}` : ""}</div>` : ""}</div><div class="pt-ai-btns">${btn("add-week", "This week", i, true, "Add to Planned for this week")}${btn("add", "Backlog", i, false, "Add to the backlog")}${btn("skip-missing", "✕", i, false, "Dismiss")}</div></div>`; }).join("");
  }
  if (a.duplicates.length) {
    h += `<div class="pt-sub">Possible duplicates <span class="pt-count">${a.duplicates.length}</span></div>`;
    const here = new Set(lines || []);
    h += a.duplicates.map((g, i) => `<div class="pt-ai-row"><div>${g.lines.map((l) => `<div class="${here.has(l) ? "" : "pt-muted"}">☐ ${esc(taskDesc(l))}${here.has(l) ? "" : " (changed)"}</div>`).join("")}<div>→ <b>${esc(g.merged)}</b>${g.why ? ` <span class="pt-muted">· ${esc(g.why)}</span>` : ""}</div></div><div class="pt-ai-btns">${btn("merge", "Merge", i, true, "Keep one task with this text; the others become (merged) notes under it")}${btn("skip-dup", "✕", i, false, "Not duplicates")}</div></div>`).join("");
  }
  if (!a.missing.length && !a.duplicates.length) h += `<div class="pt-muted">No open suggestions.</div>`;
  return h + `</div>`;
}

/* ------------------------------------------------------------------ commands: projects */

const sanitizeName = (s) => String(s).replace(/[\\/:*?"<>|#^\[\]]/g, "").trim();

function allFolders(app) {
  const out = [];
  const walk = (f, depth) => {
    for (const c of f.children || []) {
      if (!c.children || c.name.startsWith(".") || c.path === TRACKER_ROOT || c.path.startsWith(TRACKER_ROOT + "/")) continue;
      out.push({ folder: c, depth });
      if (depth < 3) walk(c, depth + 1);
    }
  };
  walk(app.vault.getRoot(), 1);
  return out.sort((a, b) => a.folder.path.localeCompare(b.folder.path));
}
/** Ask which folders hold project folders and save them to Config. */
async function chooseProjectRoots(env) {
  const { app } = env;
  const chosen = [...getConfig(app).project_roots].filter((r) => app.vault.getAbstractFileByPath(r));
  for (;;) {
    const avail = allFolders(app).filter((x) => !chosen.some((c) => x.folder.path === c || x.folder.path.startsWith(c + "/") || c.startsWith(x.folder.path + "/")));
    const opts = [];
    if (chosen.length) opts.push([`✔ Done — ${chosen.join(", ")}`, "done"]);
    for (const x of avail) {
      const subs = x.folder.children.filter((c) => c.children).length;
      opts.push([`📁 ${x.folder.path}  ·  ${subs} sub-folder${subs === 1 ? "" : "s"}`, x.folder.path]);
    }
    if (chosen.length) opts.push(["↺ Start over", "reset"]);
    const c = await ask(env, opts.map((o) => o[0]), opts.map((o) => o[1]),
      chosen.length ? "Add another folder, or Done" : "Which folder holds your project folders? (each sub-folder = one project)");
    if (c === "done") break;
    if (c === "reset") { chosen.length = 0; continue; }
    chosen.push(c);
  }
  const cf = app.vault.getAbstractFileByPath(CONFIG_PATH);
  if (cf) await app.fileManager.processFrontMatter(cf, (f) => { f.project_roots = [...chosen]; });
  else env.notice(`Can't find ${CONFIG_PATH} — is the Tracker folder at the root of your vault?`, 10000);
  return chosen;
}

async function cmdNewProject(env, opts = {}) {
  const { app } = env, cfg = getConfig(app);
  const name = sanitizeName(await env.prompt("Project name", opts.name || ""));
  if (!name) throw new Cancelled();
  let roots = cfg.project_roots.filter((r) => app.vault.getAbstractFileByPath(r));
  if (!roots.length) roots = await chooseProjectRoots(env);
  const root = roots.length > 1 ? await ask(env, roots, roots, "Which folder?") : roots[0];
  const description = oneLine(await env.prompt("One line: what is this project about? (helps the inbox classifier)", ""));
  const objective = oneLine(await env.prompt("Objective — what does success look like? (optional)", ""));
  const status = opts.status || await ask(env, ["Active — can be picked for a week", "Backlog — someday"], ["active", "backlog"], "Status");
  const path = `${root}/${name}/${name}.md`;
  if (app.vault.getAbstractFileByPath(path)) throw new Error(`${path} already exists`);
  await createFile(app, path, projectNote({ name, scope: root.split("/").pop().toLowerCase(), status, description, objective, today: env.moment().format("YYYY-MM-DD") }));
  if (!opts.noOpen) await env.open(path);
  return path;
}

async function cmdRegister(env) {
  const { app } = env;
  let roots = getConfig(app).project_roots.filter((r) => app.vault.getAbstractFileByPath(r));
  if (!roots.length) roots = await chooseProjectRoots(env);
  else if (await ask(env, [`Use ${roots.join(", ")}`, "Change project folders…"], [false, true], "Project folders")) roots = await chooseProjectRoots(env);
  const cfgFile = app.vault.getAbstractFileByPath(CONFIG_PATH);
  const ignored = new Set(toArr(cfgFile ? app.metadataCache.getFileCache(cfgFile)?.frontmatter?.ignored_folders : null));
  const today = env.moment().format("YYYY-MM-DD");
  let added = 0, seen = 0, upgraded = 0, stop = false;
  for (const root of roots) {
    if (stop) break;
    const folder = app.vault.getAbstractFileByPath(root);
    if (!folder || !folder.children) { env.notice(`Project folder not found: ${root}`); continue; }
    const scope = root.split("/").pop().toLowerCase();
    for (const sub of folder.children.filter((c) => c.children).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(sub.path)) { seen++; continue; }
      const top = app.vault.getMarkdownFiles().filter((f) => f.parent && f.parent.path === sub.path).sort((a, b) => a.name.localeCompare(b.name));
      const fmOf = (f) => app.metadataCache.getFileCache(f)?.frontmatter || {};
      const reg = top.find((f) => fmOf(f).type === "project");
      if (reg) { if (await upgradeProjectNote(app, reg)) upgraded++; seen++; continue; }
      if (top.some((f) => fmOf(f).tracker === "ignore")) { seen++; continue; }

      // 1) What is this folder?
      const choice = await ask(env,
        ["Active project", "Backlog project", "Not a project — ignore", "Stop for now"],
        ["active", "backlog", "ignore", "stop"],
        `📁 ${sub.path} · ${top.length} note${top.length === 1 ? "" : "s"}`);
      if (choice === "stop") { stop = true; break; }
      if (choice === "ignore") {
        ignored.add(sub.path);
        const cf = app.vault.getAbstractFileByPath(CONFIG_PATH);
        if (cf) await app.fileManager.processFrontMatter(cf, (f) => { f.ignored_folders = [...ignored]; });
        continue;
      }

      // 2) Which note is the project's root? (existing note, or a new one)
      // A note named like the folder is the root by convention; otherwise ask (existing note or a new one).
      const sameName = top.find((f) => f.basename === sub.name);
      let note = sameName || null, newName = null;
      if (!top.length) newName = sub.name;
      else if (!sameName) {
        const opts = [[`＋ New note “${sub.name}.md”`, "new"], ["＋ New note with another name…", "named"]];
        for (const f of top) opts.push([`📄 ${f.name}`, f]);
        const pick = await ask(env, opts.map((o) => o[0]), opts.map((o) => o[1]), `Root note for “${sub.name}”`);
        if (pick === "new") newName = sub.name;
        else if (pick === "named") {
          newName = sanitizeName(await env.prompt(`Name of the root note for “${sub.name}”`, sub.name));
          if (!newName) continue;
        } else note = pick;
      }

      if (newName) {
        let path = `${sub.path}/${newName}.md`;
        for (let i = 2; app.vault.getAbstractFileByPath(path); i++) path = `${sub.path}/${newName} ${i}.md`;
        await createFile(app, path, projectNote({ name: newName, scope, status: choice, description: "", objective: "", today }));
        added++;
        continue;
      }

      // 3) Turn an existing note into the root
      await app.fileManager.processFrontMatter(note, (f) => {
        f.type = "project"; f.status = choice; f.scope = f.scope || scope;
        if (f.description === undefined) f.description = "";
        if (f.objective === undefined) f.objective = "";
      });
      await editLines(app, note.path, (ls) => { ensureProjectBlock(ls); ensureProjectSections(ls); });
      added++;
    }
  }
  // projects registered outside the scanned folders (e.g. by hand) get the sections too
  for (const p of listProjects(app, getConfig(app))) if (await upgradeProjectNote(app, p.file)) upgraded++;
  const reprio = await migratePriorities(app, getConfig(app));
  if (reprio) env.notice(`Priorities: ${reprio} project(s) changed from high / medium / low to 2 / 3 / 4 — adjust them in Tracker/Projects.`, 10000);
  env.notice(`Registered ${added} project(s); ${seen} already set up or ignored${upgraded ? `; added the “${PLANNED_SEC}” section to ${upgraded} existing project note(s)` : ""}. Add a one-line description to each — it makes the inbox classifier much better.`, 10000);
}
async function upgradeProjectNote(app, file) {
  // routine projects only get the dashboard — their tasks live in sections of your choice (e.g. ## Daily / ## Weekly)
  const routine = String(app.metadataCache.getFileCache(file)?.frontmatter?.kind || "").toLowerCase() === "routine";
  const fix = (ls) => ensureProjectBlock(ls) | (routine ? false : ensureProjectSections(ls));
  if (!fix((await app.vault.read(file)).split("\n"))) return false; // already fine — don't touch the file
  await editLines(app, file.path, (ls) => { fix(ls); });
  return true;
}
/** Put the project dashboard right under the note's title (or after the properties). Returns true if added. */
function ensureProjectBlock(ls) {
  if (ls.some((l) => l.includes(`dv.view("${VIEW_PATH}"`))) return false;
  let fmEnd = 0;
  if (ls[0] === "---") { const e = ls.indexOf("---", 1); fmEnd = e > 0 ? e + 1 : 0; }
  const mask = maskedLines(ls);
  let pos = fmEnd;
  for (let i = fmEnd; i < ls.length; i++) { if (!mask[i] && /^#\s/.test(ls[i])) { pos = i + 1; break; } if (!mask[i] && HEAD_RE.test(ls[i])) break; }
  ls.splice(pos, 0, "", ...PROJECT_BLOCK.split("\n"), ...(ls[pos] !== undefined && ls[pos].trim() === "" ? [] : [""]));
  return true;
}

/* ------------------------------------------------------------------ commands: planning */

async function ensureWeek(app, cfg, id) {
  const path = weekPath(cfg, id);
  if (!app.vault.getAbstractFileByPath(path)) await createFile(app, path, weekNote(id));
  return path;
}
async function takeBacklogItem(app, projectPath, raw) {
  let block = null;
  await editLines(app, projectPath, (ls) => {
    const k = ls.indexOf(raw);
    if (k < 0) return;
    const it = parseItems(ls, k, k + 1)[0];
    const end = blockEnd(ls, it);
    block = dedent(ls.slice(k, end), it.ws).filter((l) => l.trim() !== "");
    ls.splice(k, end - k);
  });
  return block;
}
async function addGoal(app, wp, text, projectPath, blocks, extra = {}) {
  await editLines(app, wp, (ls) => {
    let line = `- 🎯 ${text} [project:: ${projectLink(app, projectPath, wp)}]`;
    for (const [k, v] of Object.entries(extra)) line = setField(line, k, v);
    insertIntoSection(ls, "Goals", [line, ...blocks.flat().map((l) => "\t" + l)]);
  });
}
async function addTasksToGoal(app, wp, goalIndex, blocks) {
  if (!blocks.length) return;
  await editLines(app, wp, (ls) => {
    const g = parseWeek(ls.join("\n")).goals[goalIndex];
    ls.splice(blockEnd(ls, g.item), 0, ...blocks.flat().map((l) => g.item.ws + "\t" + l));
  });
}

/** When planning a task: ask the day to do it (⏳ scheduled), then its deadline (📅 due). Each step can be turned off in Config. */
async function askSchedule(env, cfg, target, line) {
  if (cfg.plan_schedule_tasks) line = await askScheduled(env, target, line);
  if (cfg.plan_due_dates) line = await askDue(env, target, line);
  if (cfg.plan_estimates) line = await askEstimate(env, line);
  if (cfg.plan_times) line = await askClock(env, line);
  return line;
}
const EST_CHOICES = [15, 30, 60, 90, 120, 180, 240, 360, 480];
/** Ask for a time estimate of the hands-on work. Sets [est:: …]. Esc leaves the line as it is. */
async function askEstimate(env, line) {
  const cur = timeOf(line).est;
  const opts = cur ? [[`Keep ≈ ${fmtDur(cur)}`, cur], ["Remove estimate", 0]] : [["No estimate", 0]];
  for (const m of EST_CHOICES) if (m !== cur) opts.push([`≈ ${fmtDur(m)}`, m]);
  opts.push(["Other…", "other"]);
  let v = await env.suggest(opts.map((o) => o[0]), opts.map((o) => o[1]), `≈ How long will “${taskDesc(line)}” take (hands-on)?`);
  if (v === null || v === undefined) return line;
  if (v === "other") v = await askDuration(env, `≈ Estimate for “${taskDesc(line)}” — e.g. 45m, 2h, 1h30m (empty = none)`, cur ? fmtDur(cur) : "");
  if (v === undefined) return line;
  return setTime(line, "est", v || null);
}
/** Prompt for a duration until it parses. Returns minutes, 0 for empty, undefined on Esc. */
async function askDuration(env, q, def = "") {
  for (;;) {
    const t = await env.prompt(q, def);
    if (t === null || t === undefined) return undefined;
    if (!String(t).trim()) return 0;
    const m = parseDur(t);
    if (m !== null) return m;
    env.notice(`“${t}” isn't a duration. Use e.g. 45m, 2h, 1h30m or 1:30.`, 5000);
  }
}
const taskDesc = (line) => stripFields(splitMeta(line.replace(/^\s*[-*+]\s+\[.\]\s*/, "")).head);
const isIsoDate = (s, env) => /^\d{4}-\d{2}-\d{2}$/.test(s) && env.moment(s, "YYYY-MM-DD").format("YYYY-MM-DD") === s;
/** Ask for a deadline: days of the target week from the scheduled day (or today) on, or any other date. Sets 📅 due. */
async function askDue(env, target, line) {
  const today = env.moment().format("YYYY-MM-DD");
  const due = getDate(line, "due"), sched = getDate(line, "scheduled");
  const from = sched && sched > today ? sched : today;
  const day = (iso) => env.moment(iso, "YYYY-MM-DD").format("ddd D MMM");
  const opts = due ? [[`Keep 📅 ${day(due)}`, due], ["Remove deadline", ""]] : [["No deadline", ""]];
  const s = weekStart(target);
  for (let i = 0; i < 7; i++) {
    const iso = s.clone().add(i, "days").format("YYYY-MM-DD");
    if (iso < from || iso === due) continue;
    opts.push([`${day(iso)}${iso === today ? " · today" : ""}${iso === sched ? " · ⏳ scheduled" : ""}`, iso]);
  }
  opts.push(["Other date…", "other"]);
  let v = await env.suggest(opts.map((o) => o[0]), opts.map((o) => o[1]), `📅 Deadline for “${taskDesc(line)}”?`);
  if (v === null || v === undefined) return line;
  if (v === "other") {
    for (;;) {
      const t = await env.prompt(`📅 Deadline for “${taskDesc(line)}” — date as YYYY-MM-DD (empty = no deadline)`, due || "");
      if (t === null || t === undefined) return line;
      v = String(t).trim();
      if (!v || isIsoDate(v, env)) break;
      env.notice(`“${v}” isn't a date like ${today}. Try again.`, 5000);
    }
    if (v && sched && v < sched) env.notice(`Note: the deadline (${v}) is before the scheduled day (${sched}).`, 7000);
  }
  return setDate(line, "due", v || null);
}
/** Ask which day of the target week to do a task; sets the Tasks ⏳ scheduled date. */
async function askScheduled(env, target, line) {
  const today = env.moment().format("YYYY-MM-DD");
  const cur = getDate(line, "scheduled"), due = getDate(line, "due");
  const desc = stripFields(splitMeta(line.replace(/^\s*[-*+]\s+\[.\]\s*/, "")).head);
  const opts = [];
  if (cur) opts.push([`Keep ⏳ ${env.moment(cur, "YYYY-MM-DD").format("ddd D MMM")}`, cur], ["No date", ""]);
  else opts.push(["No date (any day this week)", ""]);
  const s = weekStart(target);
  for (let i = 0; i < 7; i++) {
    const d = s.clone().add(i, "days"), iso = d.format("YYYY-MM-DD");
    if (iso < today || iso === cur) continue;
    opts.push([`${d.format("ddd D MMM")}${iso === today ? " · today" : ""}${iso === due ? " · 📅 due" : ""}`, iso]);
  }
  const v = await env.suggest(opts.map((o) => o[0]), opts.map((o) => o[1]), `⏳ When will you do “${desc}”?`);
  if (v === null || v === undefined) return line;
  return setDate(line, "scheduled", v || null);
}
const planLine = (line, wid) => setField(line, "week", wid);
async function addPlanned(app, projectPath, lines) { return addToSection(app, projectPath, PLANNED_SEC, lines); }
async function addToSection(app, projectPath, section, lines) {
  if (lines.length) await editLines(app, projectPath, (ls) => insertIntoProjectSection(ls, section, lines));
}
/** Pick tasks for a week from one project: they move from ## Backlog to ## Planned with [week:: target]. Returns how many. */
/** Pick tasks for a week. unplanned: Add tasks during the week → ## Unplanned with [unplanned:: <week>], no tidy-up first. */
async function pickTasks(env, project, header, target, { unplanned = false } = {}) {
  const { app } = env, cfg = getConfig(app);
  const today = env.moment().format("YYYY-MM-DD");
  if (!unplanned) await tidyPlanned(env, project);
  // [unplanned:: 2026-W46] = the week(s) it was added outside the plan; kept as history when it moves on later
  const mark = (line) => (unplanned ? setField(planLine(line, target), "unplanned", addFrom(parseFields(line).unplanned, target)) : planLine(line, target));
  const add = (lines) => (unplanned ? addToSection(app, project.path, UNPLANNED_SEC, lines) : addPlanned(app, project.path, lines));
  const lines0 = (await readPath(app, project.path)).split("\n");
  const inWeek = parseItems(lines0).filter((t) => t.task && isOpen(t) && weekIds(t.fields.week)[0] === target);
  const already = inWeek.length;
  let estMin = sum(inWeek.map((t) => timeOf(t.fields).est || 0));
  const remaining = backlogItems(lines0).sort(byPrioDue);
  let added = 0;
  for (;;) {
    const est = estMin ? ` · ≈ ${fmtDur(estMin)} estimated` : "";
    const opts = [[unplanned ? `✔ Done — ${added} task(s) added to ${shortWeek(target)} (unplanned)${est}` : `✔ Done — ${already + added} task(s) planned for ${shortWeek(target)}${est}`, "done"], ["＋ Type new task(s)…", "new"],
      ...remaining.map((t) => [taskLabel(t), t])];
    const c = await env.suggest(opts.map((o) => o[0]), opts.map((o) => o[1]), header);
    if (c === null || c === undefined || c === "done") break;
    if (c === "new") {
      const txt = await env.prompt("New task(s) — one per line (Tasks dates like 📅 2026-11-20 are fine)", "", true);
      if (txt) for (const t of txt.split(/\r?\n/).map((x) => x.trim().replace(/^[-*]\s+(\[.\]\s+)?/, "")).filter(Boolean)) {
        const ln = mark(await askSchedule(env, cfg, target, newTask(cfg, `- [ ] ${t}`, today)));
        await add([ln]);
        estMin += timeOf(ln).est || 0;
        added++;
      }
      continue;
    }
    const block = await takeBacklogItem(app, project.path, c.raw);
    if (block) {
      block[0] = mark(await askSchedule(env, cfg, target, block[0]));
      await add(block);
      estMin += timeOf(block[0]).est || 0;
      added++;
    }
    remaining.splice(remaining.indexOf(c), 1);
  }
  return added;
}

/** Plan one project: choose this or next week, optionally set its goal, pick tasks. */
async function cmdPlanProject(env) {
  const { app } = env, cfg = getConfig(app);
  await rollRoutinesNotice(env);
  const data = await loadAll(app);
  const af = app.workspace && app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
  let p = af ? data.byPath.get(af.path) || projectOfPath(data, af.path) : null;
  if (p && p.routine) p = null; // routines repeat by themselves — nothing to plan
  if (!p) {
    const list = data.projects.filter((x) => !x.routine && !["done", "archived", "dropped"].includes(x.status)).sort((a, b) => projPrioRank(a) - projPrioRank(b) || a.name.localeCompare(b.name));
    if (!list.length) throw new Error("no projects yet — run Register projects first");
    p = await ask(env, list.map((x) => `${x.name}${x.status !== "active" ? ` (${x.status})` : ""}`), list, "Plan tasks for which project?");
  }
  const cur = data.curId, next = shiftWeek(cur, 1);
  const cnt = (wid) => ((data.sel.get(wid) && data.sel.get(wid).get(p.path)) || { here: [] }).here.filter(isOpen).length;
  const lbl = (wid, name) => `${name} · ${wid} · ${weekRange(wid)}${cnt(wid) ? ` · ${cnt(wid)} planned` : ""}`;
  const order = env.moment().isoWeekday() >= cfg.plan_next_week_from ? [[lbl(next, "Next week"), next], [lbl(cur, "This week"), cur]] : [[lbl(cur, "This week"), cur], [lbl(next, "Next week"), next]];
  const target = await ask(env, order.map((o) => o[0]), order.map((o) => o[1]), `${p.name}: plan tasks for…`);
  const wp = await ensureWeek(app, cfg, target);
  const hasGoal = parseWeek(await readPath(app, wp)).goals.some((g) => resolveProject(app, g.fields.project, wp, data.projects) === p.path);
  if (!hasGoal) {
    const goal = oneLine(await env.prompt(`${p.name} · ${shortWeek(target)} goal — what will be true by Sunday? (empty = no goal, just tasks)`, ""));
    if (goal) await addGoal(app, wp, goal, p.path, []);
  }
  const n = await pickTasks(env, p, `${p.name} · tasks for ${shortWeek(target)}`, target);
  env.notice(`${p.name}: ${n} task(s) planned for ${target}. They're in the project's “${PLANNED_SEC}” section and in the ${shortWeek(target)} week note.`, 7000);
}

/** Cancel missed routine occurrences; tell the user about it and about rules that couldn't be rolled. */
async function rollRoutinesNotice(env) {
  const r = await rollRoutines(env.app, env.moment().format("YYYY-MM-DD"));
  if (r.missed) env.notice(`Routines: ${r.missed} missed occurrence(s) marked as missed (cancelled); the next ones are scheduled.`, 6000);
  if (r.stuck.length) env.notice(`Routines: couldn't work out the next date for ${r.stuck.join("; ")}. Enable the Tasks plugin or use a simpler 🔁 rule.`, 10000);
  return r;
}

/** Add tasks to a project during the current week: like Plan project, but they go to ## Unplanned and nothing is tidied. */
async function cmdAddTasks(env) {
  const { app } = env;
  const data = await loadAll(app);
  const af = app.workspace && app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
  let p = af ? data.byPath.get(af.path) || projectOfPath(data, af.path) : null;
  if (p && p.routine) p = null;
  if (!p) {
    const list = data.projects.filter((x) => !x.routine && !["done", "archived", "dropped"].includes(x.status)).sort((a, b) => projPrioRank(a) - projPrioRank(b) || a.name.localeCompare(b.name));
    if (!list.length) throw new Error("no projects yet — run Register projects first");
    p = await ask(env, list.map((x) => `${x.name}${x.status !== "active" ? ` (${x.status})` : ""}`), list, "Add unplanned tasks to which project?");
  }
  const cur = data.curId;
  await ensureWeek(app, data.cfg, cur);
  const n = await pickTasks(env, p, `${p.name} · add unplanned tasks to ${shortWeek(cur)}`, cur, { unplanned: true });
  if (n) env.notice(`${p.name}: ${n} unplanned task(s) added to ${cur}. They're in the project's “${UNPLANNED_SEC}” section and count like planned ones; Analytics shows the planned/unplanned split.`, 7000);
}

const timeText = (tm) => [tm.est ? `≈ ${fmtDur(tm.est)} est.` : "", tm.active ? `⏱ ${fmtDur(tm.active)} active` : "", tm.passive ? `⌛ ${fmtDur(tm.passive)} passive` : ""].filter(Boolean).join(" · ");
/** Log time spent (active / passive) or set the estimate for a task: the one under the cursor, or one picked from this or last week. */
async function cmdLogTime(env) {
  const { app } = env;
  let path = null, raw = null, hint;
  const ae = app.workspace && app.workspace.activeEditor;
  if (ae && ae.editor && ae.file) {
    const ln = ae.editor.getCursor().line, txt = ae.editor.getLine(ln);
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[.\]/.test(txt)) { path = ae.file.path; raw = txt; hint = ln; }
  }
  if (!path) {
    const d = await loadAll(app);
    const ts = [];
    for (const wid of [d.curId, shiftWeek(d.curId, -1)]) {
      const m2 = d.sel.get(wid);
      if (m2) for (const [pp, b] of m2) for (const t of b.here) if (t.status !== "-") ts.push({ t, wid, p: d.byPath.get(pp) });
    }
    if (!ts.length) throw new Error("no tasks planned for this or last week — put the cursor on a task line and run Log time again");
    ts.sort((a, b) => b.wid.localeCompare(a.wid) || isDone(a.t) - isDone(b.t) || (a.p ? a.p.name : "").localeCompare(b.p ? b.p.name : ""));
    const label = (x) => { const tm = timeText(timeOf(x.t.fields)); return `${isDone(x.t) ? "✓ " : ""}${taskDesc(x.t.raw)}  ·  ${x.p ? x.p.name : ""} · ${shortWeek(x.wid)}${tm ? `  ·  ${tm}` : ""}`; };
    const c = await ask(env, ts.map(label), ts, "⏱ Log time for which task?");
    path = c.t.path; raw = c.t.raw; hint = c.t.line;
  }
  const desc = taskDesc(raw);
  let changed = false;
  for (;;) {
    const tm = timeOf(raw);
    const opts = [["✔ Done", "done"], [`⏱ Add active time${tm.active ? ` (now ${fmtDur(tm.active)})` : ""}`, "active"], [`⌛ Add passive time${tm.passive ? ` (now ${fmtDur(tm.passive)})` : ""}`, "passive"], [`≈ ${tm.est ? `Change estimate (${fmtDur(tm.est)})` : "Set estimate"}`, "est"]];
    if (tm.active || tm.passive) opts.push(["Clear time spent", "reset"]);
    const c = await env.suggest(opts.map((o) => o[0]), opts.map((o) => o[1]), `⏱ ${desc}${timeText(tm) ? ` — ${timeText(tm)}` : ""}`);
    if (c === null || c === undefined || c === "done") break;
    let next = raw;
    if (c === "active" || c === "passive") {
      const m = await askDuration(env, c === "active" ? `⏱ Hands-on time to add to “${desc}” — e.g. 25m, 1h30m` : `⌛ Waiting / unattended time to add to “${desc}” — e.g. 2h`);
      if (!m) continue;
      next = addTime(raw, c, m);
    } else if (c === "est") {
      const m = await askDuration(env, `≈ Estimate for “${desc}” — e.g. 45m, 2h (empty = none)`, tm.est ? fmtDur(tm.est) : "");
      if (m === undefined) continue;
      next = setTime(raw, "est", m || null);
    } else next = setTimes(raw, { active: null, passive: null });
    if (next === raw) continue;
    await editLines(app, path, (ls) => {
      const i = locateRaw(ls, raw, hint);
      if (i < 0) throw new Error("couldn't find the task any more — it may have been edited");
      ls[i] = next; hint = i;
    });
    raw = next; changed = true;
  }
  if (changed) env.notice(`⏱ ${desc}: ${timeText(timeOf(raw)) || "no time logged"}`);
}

/* ------------------------------------------------------------------ cancel a task */

/** `[-]` + ❌ today (+ an optional [reason:: …]); no done date. */
function cancelLine(line, today, reason) {
  let out = setDate(setDate(setStatus(line, "-"), "done", null), "cancelled", today);
  if (reason) out = setField(out, "reason", oneLine(reason).replace(/[\[\]]/g, ""));
  return out;
}
const CANCEL_FROM = [PLANNED_SEC, UNPLANNED_SEC, "Backlog"];
/**
 * Cancel the task at `raw` (near line `hint`) in `path`. A repeating task gets its next occurrence (the cancelled one stays
 * below it, like a skipped routine); any other top-level task in Planned / Unplanned / Backlog moves, with its sub-items,
 * to ## Done, so it leaves every list. Returns { ok, moved, next }.
 */
async function cancelTask(app, path, raw, hint, today, reason = "") {
  const res = { ok: false, moved: false, next: false };
  await editLines(app, path, (ls) => {
    const k = locateRaw(ls, raw, hint);
    if (k < 0) return;
    const it = parseItems(ls, k, k + 1)[0];
    if (!it || !it.task || !isOpen(it)) return;
    const gone = cancelLine(ls[k], today, reason);
    const rule = ruleOf(ls[k]), ref = refDate(ls[k]);
    const nextIso = rule && ref ? (/\bwhen done\s*$/i.test(rule) ? today : nextOccurrence(rule, ref)) : null;
    res.ok = true;
    if (nextIso) { ls.splice(k, 1, shiftOccurrence(ls[k], isoDiff(ref, nextIso), today), gone); res.next = true; return; }
    ls[k] = gone;
    const all = parseItems(ls), me = all.find((x) => x.line === k);
    const sec = CANCEL_FROM.map((n) => findSection(ls, n)).find((x) => x && k >= x.start && k < x.end);
    if (!me || me.parent || !sec) return;
    const end = blockEnd(ls, me);
    const block = dedent(ls.slice(k, end), me.ws).filter((l) => l.trim() !== "");
    ls.splice(k, end - k);
    insertIntoSection(ls, DONE_SEC, block);
    res.moved = true;
  });
  return res;
}
/** Cancel task: the task under the cursor, or one picked from this / next week. Asks for an optional reason. */
async function cmdCancelTask(env) {
  const { app } = env;
  let path = null, raw = null, hint;
  const ae = app.workspace && app.workspace.activeEditor;
  if (ae && ae.editor && ae.file) {
    const ln = ae.editor.getCursor().line, txt = ae.editor.getLine(ln);
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[[ /]\]/.test(txt)) { path = ae.file.path; raw = txt; hint = ln; }
  }
  if (!path) {
    const d = await loadAll(app);
    const ts = [];
    for (const wid of [d.curId, shiftWeek(d.curId, 1)]) {
      const m2 = d.sel.get(wid);
      if (m2) for (const [pp, b] of m2) for (const t of b.here) if (isOpen(t)) ts.push({ t, wid, p: d.byPath.get(pp) });
    }
    if (!ts.length) throw new Error("no open tasks planned for this or next week — put the cursor on a task line and run Cancel task again");
    ts.sort((a, b) => a.wid.localeCompare(b.wid) || (a.p ? a.p.name : "").localeCompare(b.p ? b.p.name : ""));
    const c = await ask(env, ts.map((x) => `${taskDesc(x.t.raw)}  ·  ${x.p ? x.p.name : ""} · ${shortWeek(x.wid)}`), ts, "✖ Cancel which task? It won't count as done or as planned.");
    path = c.t.path; raw = c.t.raw; hint = c.t.line;
  }
  const desc = taskDesc(raw);
  const reason = await env.prompt(`✖ Cancel “${desc}” — why? (optional; Esc = keep the task)`, "");
  if (reason === null || reason === undefined) throw new Cancelled();
  const r = await cancelTask(app, path, raw, hint, env.moment().format("YYYY-MM-DD"), reason);
  if (!r.ok) throw new Error("couldn't find the open task any more — it may have been edited");
  env.notice(`✖ Cancelled “${desc}”${r.next ? " — the next occurrence is scheduled" : r.moved ? ` — moved to “${DONE_SEC}”` : ""}. It's left out of the scores.`);
}

async function cmdPlan(env, forcedId) {
  const { app } = env, cfg = getConfig(app);
  await rollRoutinesNotice(env);
  const now = env.moment();
  const cur = weekId(now), next = shiftWeek(cur, 1);
  let target = forcedId;
  if (!target) {
    const nextFirst = now.isoWeekday() >= cfg.plan_next_week_from;
    const lbl = (id, w) => {
      const ex = app.vault.getAbstractFileByPath(weekPath(cfg, id));
      return `${w} · ${id} · ${weekRange(id)}${ex ? " (has a plan — add to it)" : ""}`;
    };
    const opts = nextFirst ? [[lbl(next, "Next week"), next], [lbl(cur, "This week"), cur]] : [[lbl(cur, "This week"), cur], [lbl(next, "Next week"), next]];
    target = await ask(env, opts.map((o) => o[0]), opts.map((o) => o[1]), "Plan which week?");
  }
  const prev = shiftWeek(target, -1);
  const prevFile = app.vault.getAbstractFileByPath(weekPath(cfg, prev));
  if (!forcedId && prevFile && app.metadataCache.getFileCache(prevFile)?.frontmatter?.status !== "reviewed" && parseWeek(await app.vault.read(prevFile)).goals.length) {
    const r = await ask(env, [`Review ${prev} first (recommended — carries unfinished work over)`, "Skip the review"], [true, false], `${prev} isn't reviewed yet`);
    if (r) await cmdReview(env, prev, { thenPlan: false });
  }
  const wp = await ensureWeek(app, cfg, target);
  let data = await loadAll(app);
  for (;;) {
    const week = parseWeek(await readPath(app, wp));
    const goalByProject = new Map();
    week.goals.forEach((g, i) => { const p = resolveProject(app, g.fields.project, wp, data.projects); if (p && !goalByProject.has(p)) goalByProject.set(p, i); });
    const n = week.goals.length;
    const picked = data.sel.get(target) || new Map();
    const pickedOpen = (pp) => (picked.get(pp) ? picked.get(pp).here.filter(isOpen).length : 0);
    const active = data.projects.filter((p) => p.status === "active" && !p.routine); // routines are always in focus, no goal needed
    const noGoal = data.projects.filter((p) => !goalByProject.has(p.path) && pickedOpen(p.path));
    // Finish before you start: priority first; within a priority, projects you're already working on, then the ones closest to done.
    const left = (p) => p.backlog.length + (p.openPlanned || 0);
    const recent = (p) => (p.weeksSince === null ? 999 : Math.max(0, p.weeksSince));
    const fresh = active.filter((p) => !goalByProject.has(p.path) && !pickedOpen(p.path))
      .sort((a, b) => projPrioRank(a) - projPrioRank(b) || recent(a) - recent(b) || left(a) - left(b) || a.name.localeCompare(b.name));
    const meta = (p) => {
      const bits = [`P${p.priority}`];
      if (new Set(active.map((x) => x.scope)).size > 1) bits.push(p.scope);
      bits.push(p.lastFocus ? (p.weeksSince <= 0 ? "in focus this week" : p.weeksSince === 1 ? "in focus last week" : `last focus ${p.weeksSince}w ago`) : "not started");
      if (p.avg !== null) bits.push(`avg ${p.avg}%`);
      bits.push(left(p) ? `${left(p)} open task(s) left` : "no open tasks");
      return bits.join(" · ");
    };
    const opts = [];
    if (n) opts.push([`✔ Done planning — ${n} goal${n === 1 ? "" : "s"}${n < cfg.goals_min ? ` (aim for ${cfg.goals_min}–${cfg.goals_max})` : ""}`, { a: "done" }]);
    for (const [path, i] of goalByProject) opts.push([`● ${data.byPath.get(path)?.name} — ${week.goals[i].text}  · ${pickedOpen(path)} task(s) · add more`, { a: "tasks", path, i }]);
    for (const p of noGoal) opts.push([`◐ ${p.name} — ${pickedOpen(p.path)} task(s) picked, no goal yet`, { a: "goal", p }]);
    for (const p of fresh) opts.push([`${p.name}  ·  ${meta(p)}`, { a: "goal", p }]);
    opts.push(["＋ Activate a backlog project…", { a: "activate" }], ["＋ New project…", { a: "new" }]);
    const top = fresh[0];
    const header = n >= cfg.goals_max ? `${target}: ${n} goals — that's your max of ${cfg.goals_max}. Finish?` : `${target}: pick a project to set a goal (${n}/${cfg.goals_max}) · highest priority first${top ? ` — next: ${top.name} (P${top.priority})` : ""}`;
    const c = await env.suggest(opts.map((o) => o[0]), opts.map((o) => o[1]), header);
    if (c === null || c === undefined || c.a === "done") break;
    if (c.a === "tasks") {
      const p = data.byPath.get(c.path);
      await pickTasks(env, p, `${p.name} · tasks for “${week.goals[c.i].text}”`, target);
      data = await loadAll(app);
      continue;
    }
    let p = c.p;
    if (c.a === "activate") {
      const back = data.projects.filter((x) => x.status === "backlog" && !x.routine);
      if (!back.length) { env.notice("No backlog projects"); continue; }
      p = await env.suggest(back.map((x) => x.name), back, "Activate which project?");
      if (!p) continue;
      await app.fileManager.processFrontMatter(p.file, (f) => { f.status = "active"; });
    }
    if (c.a === "new") {
      const path = await cmdNewProject(env, { status: "active", noOpen: true });
      data = await loadAll(app);
      p = data.byPath.get(path) || { path, name: path.split("/").pop().replace(/\.md$/, "") };
    }
    if (n >= cfg.goals_max) env.notice(`That's goal #${n + 1} — more than your max of ${cfg.goals_max}. Fine, but be honest about capacity.`);
    const goal = oneLine(await env.prompt(`${p.name}: what will be true by Sunday?`, ""));
    if (!goal) continue;
    const proj = data.byPath.get(p.path) || p;
    await addGoal(app, wp, goal, p.path, []);
    await pickTasks(env, proj, `${proj.name} · tasks for “${goal}”`, target);
    data = await loadAll(app);
  }
  const final = parseWeek(await readPath(app, wp)).goals.length;
  if (final && final < cfg.goals_min) env.notice(`${final} goals planned (you aim for ${cfg.goals_min}–${cfg.goals_max}).`);
  await env.open(wp);
}

/* ------------------------------------------------------------------ commands: review */

/** Find a task line again by its exact text (line numbers may have moved). */
function locateRaw(lines, raw, hint) {
  if (hint !== undefined && lines[hint] === raw) return hint;
  return lines.indexOf(raw);
}
const addFrom = (v, id) => { const ids = weekIds(v); if (!ids.includes(id)) ids.push(id); return ids.join(", "); };
/** carry → re-plan for next week · return → back to ## Backlog · drop → cancelled. History kept in [from:: …]. */
async function applyTaskAction(app, tasks, action, id, nextId) {
  if (action === "leave" || !tasks.length) return 0;
  let n = 0;
  for (const t of tasks) {
    await editLines(app, t.path, (ls) => {
      const k = locateRaw(ls, t.raw, t.line);
      if (k < 0) return;
      if (action === "drop") { ls[k] = cancelLine(ls[k], getMoment()().format("YYYY-MM-DD")); n++; return; }
      let line = setField(ls[k], "from", addFrom(t.fields.from, id));
      line = setDate(line, "scheduled", null);
      const inUnpl = !!t.inUnplanned;
      if (action === "carry" && !inUnpl) { ls[k] = setField(line, "week", nextId); n++; return; }
      // return to backlog (or carry out of ## Unplanned): move the task and its sub-items
      const it = parseItems(ls, k, k + 1)[0];
      const end = blockEnd(ls, it);
      const block = dedent(ls.slice(k, end), it.ws).filter((l) => l.trim() !== "");
      let fresh = line.replace(/^[ \t]+/, "");
      if (inUnpl && !weekIds(t.fields.unplanned).length) fresh = setField(fresh, "unplanned", id); // keep the history
      ls.splice(k, end - k);
      if (action === "carry") { // an unplanned task carried over is planned now: next week, ## Planned
        block[0] = setField(fresh, "week", nextId);
        insertIntoProjectSection(ls, PLANNED_SEC, block);
      } else {
        block[0] = setField(fresh, "week", null);
        insertIntoProjectSection(ls, "Backlog", block);
      }
      n++;
    });
  }
  return n;
}
/** Was task t added outside the plan in week wid? (marker, or written in ## Unplanned for that week) */
function isUnplannedIn(t, wid) { return (t.unplannedIn || []).includes(wid) || (!!t.inUnplanned && t.week === wid && !(t.unplannedIn || []).length); }
function mixSum(d, ids, pp = null) {
  const a = { planned: 0, unplanned: 0, plannedDone: 0, unplannedDone: 0, cancelled: 0 };
  for (const id of ids) {
    const pm = d.mix.get(id);
    if (!pm) continue;
    for (const [k, x] of pm) if (!pp || k === pp) for (const f of Object.keys(a)) a[f] += x[f];
  }
  return a;
}
const unplPct = (a) => (a.planned + a.unplanned ? Math.round((100 * a.unplanned) / (a.planned + a.unplanned)) : null);
/** Move finished tasks of week `id` from ## Planned to ## Done in each project's root note. */
async function archiveDone(app, d, id) {
  let n = 0;
  for (const p of d.projects) {
    const content = await app.vault.read(p.file);
    if (!content.includes(`[week:: ${id}]`)) continue;
    await editLines(app, p.path, (ls) => { for (const sec of [PLANNED_SEC, UNPLANNED_SEC]) n += moveDoneOut(ls, (t) => weekIds(t.fields.week)[0] === id, sec); });
  }
  return n;
}
/** Move finished top-level tasks (with their sub-items) from ## Planned to ## Done. `keep(t)` filters which. Returns how many. */
function moveDoneOut(ls, keep = () => true, section = PLANNED_SEC) {
  const sec = findSection(ls, section);
  if (!sec) return 0;
  const done = parseItems(ls, sec.start, sec.end).filter((t) => t.task && !t.parent && isDone(t) && keep(t));
  const moved = [];
  for (const t of done.reverse()) {
    const end = blockEnd(ls, t);
    moved.unshift(...dedent(ls.slice(t.line, end), t.ws).filter((l) => l.trim() !== ""));
    ls.splice(t.line, end - t.line);
  }
  insertIntoSection(ls, DONE_SEC, moved);
  return done.length;
}
function tasksPluginApi(app) {
  const p = app.plugins && app.plugins.plugins && app.plugins.plugins["obsidian-tasks-plugin"];
  return p && p.apiV1 && p.apiV1.executeToggleTaskDoneCommand ? p.apiV1 : null;
}
/**
 * Before planning a project: for each open task in ## Planned, ask whether it's actually done
 * (marking goes through the Tasks plugin when present, so ✅ dates and 🔁 repeats work),
 * then move every done task in ## Planned to ## Done.
 */
async function tidyPlanned(env, project) {
  const { app } = env;
  const today = env.moment().format("YYYY-MM-DD");
  const api = tasksPluginApi(app);
  const lines0 = (await readPath(app, project.path)).split("\n");
  const sec = findSection(lines0, PLANNED_SEC);
  if (!sec) return;
  const open = parseItems(lines0, sec.start, sec.end).filter((t) => t.task && !t.parent && isOpen(t));
  let marked = 0;
  for (let i = 0; i < open.length; i++) {
    const t = open[i];
    const wk = weekIds(t.fields.week)[0];
    const c = await env.suggest(
      ["Not yet", "✔ Done — mark it done", "Stop asking — keep the rest as they are"], ["no", "yes", "stop"],
      `${project.name} · open in ${PLANNED_SEC} ${i + 1}/${open.length}${wk ? ` · ${shortWeek(wk)}` : ""}: “${t.desc}” — done?`);
    if (c === "stop" || c === null || c === undefined) break;
    if (c !== "yes") continue;
    const raw = t.raw.replace(/^[ \t]+/, "");
    const next = api ? await api.executeToggleTaskDoneCommand(raw, project.path) : toggleDoneLine(raw, today);
    if (!next || next === raw) continue;
    let ok = false;
    await editLines(app, project.path, (ls) => {
      const k = locateRaw(ls, t.raw, t.line);
      if (k < 0) return;
      ls.splice(k, 1, ...String(next).split("\n").map((l) => t.ws + l));
      ok = true;
    });
    if (ok) marked++;
  }
  let moved = 0;
  await editLines(app, project.path, (ls) => { moved = moveDoneOut(ls); });
  if (marked || moved) env.notice(`${project.name}: ${marked ? `${marked} marked done · ` : ""}${moved} finished task(s) moved to “${DONE_SEC}”`, 6000);
}

async function cmdReview(env, forcedId, { thenPlan = true } = {}) {
  const { app } = env, cfg = getConfig(app);
  await rollRoutinesNotice(env);
  const curId = weekId(env.moment());
  let d = await loadAll(app);
  let id = forcedId;
  if (!id) {
    const cands = d.weeks.filter((w) => w.status !== "reviewed" && w.id <= curId && (w.goals.length || w.extra.length)).map((w) => w.id).reverse();
    if (!cands.length) { env.notice("Nothing to review — no unreviewed weeks with goals or planned tasks."); return; }
    id = cands.length === 1 ? cands[0] : await ask(env, cands.map((c) => `${c} · ${weekRange(c)}${c === curId ? " (this week)" : ""}`), cands, "Review which week?");
  }
  const wp = await ensureWeek(app, cfg, id);
  const wlink = linkTo(app, wp, wp);
  const nextId = shiftWeek(id, 1);
  d = await loadAll(app);
  const w0 = d.weekMap.get(id), count = w0.goals.length;
  const rw0 = d.routineWeeks.get(id), rp0 = rPct(rw0);
  const rLine = rw0 && rp0 !== null ? `${rp0}% (${rw0.done}/${rw0.done + rw0.missed} done, ${rw0.missed} missed${rw0.mins ? `, ⏱ ${fmtDur(rw0.mins)}` : ""})` : null;
  const canSummarize = !env.isMobile || String(cfg.llm_mobile).toLowerCase() === "url";

  // 1. All the questions first — nothing is written until the end, and every question has ← Back.
  const BACK = "__back__";
  const ans = {};
  const steps = [];
  const pick = async (labels, values, head, key, first) => {
    const prev = ans[key];
    const i = values.findIndex((v) => v === prev);
    const L = [...labels], V = [...values];
    if (!first) { L.push("← Back"); V.push(BACK); }
    const v = await env.suggest(L, V, `${head}${i >= 0 ? ` — now: ${labels[i].replace(/^[^\w(]+/u, "").slice(0, 40)}` : ""}${first ? " · Esc cancels" : ""}`);
    if (v === null || v === undefined) throw new Cancelled();
    return v;
  };
  const text = async (q, key, multi = false) => { // Esc = back
    const v = await env.prompt(`${q} · Esc = back`, ans[key] !== undefined ? String(ans[key]) : "", multi);
    return v === null || v === undefined ? BACK : v;
  };
  w0.goals.forEach((g, gi) => {
    if (g.fields.result !== undefined && g.fields.result !== "") return; // already reviewed
    const k = `g${gi}`, nOpen = g.here.filter(isOpen).length + g.legacy.filter(isOpen).length;
    const head = `${gi + 1}/${count} · ${g.projectName}: “${g.text}” — ${g.doneCount}/${g.counted.length} tasks done`;
    steps.push({ key: `${k}.outcome`, run: (first) => pick(["✅ Achieved", `◐ Partly (${g.score}% by tasks — adjust)`, "✗ Missed"], ["ok", "part", "miss"], head, `${k}.outcome`, first) });
    steps.push({ key: `${k}.pct`, when: () => ans[`${k}.outcome`] === "part", run: async () => {
      const v = await text(`${g.projectName}: how far did you get? (0–100)`, `${k}.pct`);
      if (v === BACK) return BACK;
      const n = parseInt(v, 10);
      return isNaN(n) ? g.score : clamp(n, 0, 99);
    } });
    steps.push({ key: `${k}.miss`, when: () => ans[`${k}.outcome`] && ans[`${k}.outcome`] !== "ok",
      run: () => pick([...MISS_REASONS.map((r) => r[1]), "Other…"], [...MISS_REASONS.map((r) => r[0]), "other"], `${g.projectName}: main reason it fell short?`, `${k}.miss`) });
    steps.push({ key: `${k}.missText`, when: () => ans[`${k}.outcome`] !== "ok" && ans[`${k}.miss`] === "other", run: () => text(`${g.projectName}: reason (a few words)`, `${k}.missText`) });
    if (nOpen) steps.push({ key: `${k}.action`, run: () => pick(
      [`→ Plan the ${nOpen} open task(s) for ${nextId}${ans[`${k}.outcome`] !== "ok" ? " (and carry the goal)" : ""}`, `↩ Return them to the ${g.projectName} backlog`, "✗ Drop them", "Leave them as they are"],
      ["carry", "return", "drop", "leave"], `${g.projectName}: ${nOpen} unfinished task(s)`, `${k}.action`) });
  });
  w0.extra.forEach((x, xi) => {
    const n = x.here.filter(isOpen).length;
    if (!n) return;
    steps.push({ key: `x${xi}.action`, run: (first) => pick([`→ Plan them for ${nextId}`, `↩ Return them to the ${x.projectName} backlog`, "✗ Drop them", "Leave them as they are"],
      ["carry", "return", "drop", "leave"], `${x.projectName} (no goal): ${n} unfinished task(s)`, `x${xi}.action`, first) });
  });
  steps.push({ key: "wins", run: () => text("Wins — what moved forward? (optional)", "wins", true) });
  steps.push({ key: "lessons", run: () => text("What got in the way / what will you change? (optional)", "lessons", true) });
  steps.push({ key: "energy", run: () => pick(["5 — great", "4 — good", "3 — okay", "2 — low", "1 — drained", "Skip"], [5, 4, 3, 2, 1, 0], "Energy this week", "energy") });
  if (canSummarize) steps.push({ key: "ai", run: () => pick(["Write a short AI summary with the local model", "No summary"], [true, false], "Summary", "ai") });
  steps.push({ key: "confirm", run: () => pick(["✔ Save the review", "✖ Cancel — change nothing"], ["save", "cancel"], `${id}: ${Object.keys(ans).filter((x) => x.endsWith(".outcome")).length} goal(s) answered — save?`, "confirm") });
  const hist = [];
  for (let i = 0; i < steps.length;) {
    const st = steps[i];
    if (st.when && !st.when()) { i++; continue; }
    const v = await st.run(!hist.length);
    if (v === BACK) { if (hist.length) i = hist.pop(); continue; }
    ans[st.key] = v;
    if (st.key === "confirm" && v === "cancel") throw new Cancelled();
    hist.push(i); i++;
  }

  // 2. Write it all.
  for (let gi = 0; gi < count; gi++) {
    const k = `g${gi}`, outcome = ans[`${k}.outcome`];
    if (!outcome) continue;
    d = await loadAll(app);
    const g = d.weekMap.get(id).goals[gi];
    const openHere = g.here.filter(isOpen);
    const result = outcome === "ok" ? 100 : outcome === "miss" ? 0 : ans[`${k}.pct`];
    let miss = outcome === "ok" ? null : ans[`${k}.miss`];
    if (miss === "other") miss = oneLine(ans[`${k}.missText`]).toLowerCase() || "other";
    const action = ans[`${k}.action`] || "leave";
    // goal line (+ tasks nested in the week note by older plans)
    const legacyCopies = [];
    await editLines(app, wp, (ls) => {
      const fresh = parseWeek(ls.join("\n")).goals[gi];
      let line = ls[fresh.line];
      if (fresh.item.task) line = setStatus(line, outcome === "ok" ? "x" : " ");
      line = setField(line, "result", result);
      if (miss) line = setField(line, "miss", miss);
      ls[fresh.line] = line;
      for (const t of fresh.tasks.filter(isOpen)) {
        if (action === "carry" || action === "return") {
          let copy = setStatus(ls[t.line].replace(/^[ \t]+/, ""), " ");
          copy = setDate(setDate(setDate(copy, "scheduled", null), "done", null), "cancelled", null);
          copy = withCreated(copy, env.moment().format("YYYY-MM-DD"));
          legacyCopies.push(action === "carry" ? setField(copy, "week", nextId) : copy);
          ls[t.line] = insertBeforeMeta(setStatus(ls[t.line], "-"), action === "carry" ? `⇢ [[${nextId}]]` : "⇢ backlog");
        } else if (action === "drop") ls[t.line] = cancelLine(ls[t.line], getMoment()().format("YYYY-MM-DD"));
      }
    });
    if (g.projectPath && legacyCopies.length) await editLines(app, g.projectPath, (ls) => insertIntoProjectSection(ls, action === "carry" ? PLANNED_SEC : "Backlog", legacyCopies));
    await applyTaskAction(app, openHere, action, id, nextId);
    if (action === "carry" && outcome !== "ok" && g.projectPath) {
      const np = await ensureWeek(app, cfg, nextId);
      const has = parseWeek(await readPath(app, np)).goals.some((x) => resolveProject(app, x.fields.project, np, d.projects) === g.projectPath);
      if (!has) await addGoal(app, np, g.text, g.projectPath, [], { from: wlink });
    }
  }
  // projects with tasks picked for this week but no goal
  d = await loadAll(app);
  for (let xi = 0; xi < w0.extra.length; xi++) {
    const action = ans[`x${xi}.action`];
    if (!action) continue;
    const x = d.weekMap.get(id).extra.find((e) => e.projectPath === w0.extra[xi].projectPath);
    if (x) await applyTaskAction(app, x.here.filter(isOpen), action, id, nextId);
  }
  const archived = await archiveDone(app, await loadAll(app), id);
  let rArchived = 0;
  for (const p of (await loadAll(app)).projects.filter((x) => x.routine)) await editLines(app, p.path, (ls) => { rArchived += archiveRoutineLines(ls, id); });

  const wins = oneLine(ans.wins), lessons = oneLine(ans.lessons), energy = ans.energy || null;
  const fields = [];
  if (wins) fields.push(`- Wins:: ${wins}`);
  if (lessons) fields.push(`- Lessons:: ${lessons}`);
  if (energy) fields.push(`- Energy:: ${energy}`);
  if (rLine) fields.push(`- Routines:: ${rLine}`);
  if (ans.ai) {
    try {
      const w = (await loadAll(app)).weekMap.get(id);
      const facts = w.goals.map((g) => `- ${g.projectName}: "${g.text}" → ${g.score}%${g.fields.miss ? ` (reason: ${g.fields.miss})` : ""}; tasks done ${g.doneCount}/${g.counted.length}${g.cancelled.length ? `, ${g.cancelled.length} cancelled` : ""}`).join("\n");
      const msg = `Here is my week ${id}:\n${facts}${rLine ? `\nRoutines: ${rLine}` : ""}\nWins: ${wins || "-"}\nObstacles: ${lessons || "-"}\nEnergy (1-5): ${energy || "-"}\n\nWrite 2–3 plain sentences: what the week was really about, the pattern behind what slipped, and one concrete adjustment for next week. Be direct, no praise, no bullet points.`;
      const job = startJob(env, "🤖 Writing the week's summary", 1);
      job.step(1, id);
      let sm = "";
      try { sm = oneLine(await llmChat(env, cfg, [{ role: "user", content: msg }])); } finally { job.end(); }
      if (sm) fields.push(`- Summary:: ${sm}`);
    } catch (e) { env.notice(`AI summary skipped — ${e.message}`, 8000); }
  }
  await editLines(app, wp, (ls) => replaceSection(ls, "Review", fields.length ? fields : ["- Reviewed:: yes"]));
  const wf = app.vault.getAbstractFileByPath(wp);
  await app.fileManager.processFrontMatter(wf, (f) => { f.status = "reviewed"; f.reviewed = env.moment().format("YYYY-MM-DD"); });
  const final = (await loadAll(app)).weekMap.get(id).goals;
  env.notice(`${id} reviewed: ${final.filter((g) => g.score >= 100).length}/${final.length} goals achieved, average ${Math.round(mean(final.map((g) => g.score)) || 0)}%${rLine ? ` · routines ${rLine}` : ""}${archived + rArchived ? ` · ${archived + rArchived} finished task(s) moved to “${DONE_SEC}”` : ""}`, 8000);
  if (thenPlan && nextId >= curId) {
    const go = await env.suggest([`Plan ${nextId} now`, "Later"], [true, false], "Next");
    if (go) await cmdPlan(env, nextId);
  }
}

/* ------------------------------------------------------------------ home task widgets */

/** Where a project's tasks live: its own folder (one project per folder), or just its root note. */
function projectScope(d, p) {
  const folder = p.file.parent && p.file.parent.path ? p.file.parent.path : "";
  const isRoot = !folder || d.cfg.project_roots.includes(folder) || d.projects.filter((x) => x.file.parent && x.file.parent.path === folder).length > 1;
  return isRoot ? { file: p.path } : { folder: folder + "/" };
}
function projectOfPath(d, path) {
  let best = null, len = -1;
  for (const p of d.projects) {
    const sc = projectScope(d, p);
    if (sc.file === path) return p;
    if (sc.folder && path.startsWith(sc.folder) && sc.folder.length > len) { best = p; len = sc.folder.length; }
  }
  return best;
}
/** Focus = projects with a goal in the week plan. Tasks in week notes belong to their goal's project.
 *  Today uses this week's focus. The upcoming days (rolling `upcoming_days` window) use the UNION of this
 *  week's focus and the focus of any already-planned week that starts inside the window (normally next week). */
function classifyTasks(d, tasks) {
  const cur = d.weekMap.get(d.curId);
  const focusOfWeek = (w) => new Set(w ? [...w.goals.map((g) => g.projectPath), ...(w.extra || []).map((x) => x.projectPath)].filter(Boolean) : []);
  const focus = focusOfWeek(cur);
  const weekTask = new Map();
  for (const w of d.weeks) for (const g of w.goals) for (const t of g.tasks) weekTask.set(`${w.path}:${t.line}`, { week: w, goal: g });
  const today = d.today.format("YYYY-MM-DD");
  const days = Math.max(1, Number(d.cfg.upcoming_days) || 7);
  const weekEnd = d.today.clone().add(days, "days").format("YYYY-MM-DD"); // end of the rolling window
  const upcomingFocus = new Set(focus);
  const planned = [];
  for (const w of d.weeks) {
    if (w.id <= d.curId || !(w.goals.length || (w.extra || []).length) || weekStart(w.id).format("YYYY-MM-DD") > weekEnd) continue;
    planned.push(w.id);
    for (const p of focusOfWeek(w)) upcomingFocus.add(p);
  }
  const out = { today: [], later: [], anytime: [], outside: [], focus, upcomingFocus, planned, days, hasPlan: !!(cur && (cur.goals.length || (cur.extra || []).length)), todayIso: today, weekEnd };
  for (const t of tasks) {
    if (t.status !== " " && t.status !== "/") continue;
    if (t.path.startsWith(TRACKER_ROOT + "/") && !t.path.startsWith(d.cfg.weeks_folder + "/") && t.path !== d.cfg.inbox) continue;
    const text = String(t.text || "");
    const item = {
      path: t.path, line: t.line, text,
      desc: stripFields(splitMeta(text).head).replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2").replace(/^🎯\s*/u, "").trim(),
      due: getDate(text, "due"), scheduled: getDate(text, "scheduled"), start: getDate(text, "start"), prio: prioOf(text), time: timeOf(text), recurring: !!ruleOf(text),
      clock: clockOf(text, d.cfg), cal: !!parseFields(text).cal,
    };
    const wt = weekTask.get(`${t.path}:${t.line}`);
    const firstDate = [getDate(text, "scheduled"), getDate(text, "due")].filter(Boolean).sort()[0];
    const fset = firstDate && firstDate > today ? upcomingFocus : focus;
    let proj = null, inFocus = false, inCurWeek = false;
    const planWk = weekIds(parseFields(text).week)[0];
    if (planWk) {                         // picked for a week in its project note
      proj = projectOfPath(d, t.path);
      inCurWeek = planWk === d.curId;
      inFocus = planWk >= d.curId || !!(proj && fset.has(proj.path));
    } else if (wt) {
      proj = d.byPath.get(wt.goal.projectPath) || null;
      inCurWeek = wt.week.id === d.curId;
      inFocus = wt.week.id >= d.curId || !!(proj && fset.has(proj.path)); // planned weeks are focus by definition
    } else if (t.path === d.cfg.inbox) {
      item.group = "Inbox";
    } else {
      proj = projectOfPath(d, t.path);
      if (proj && proj.routine && proj.status !== "active") continue; // paused routines: not shown
      inFocus = !!(proj && (proj.routine || fset.has(proj.path)));   // routines are always in focus
    }
    item.project = proj;
    item.routine = !!(proj && proj.routine);
    if (item.routine) item.freq = freqOf(ruleOf(text));
    item.group = item.group || (proj ? proj.name : t.path.split("/").pop().replace(/\.md$/, ""));
    if (item.start && item.start > today) continue; // not startable yet
    // Both dates count: a task is "today" if it's scheduled OR due today (or earlier),
    // and "upcoming" if it's scheduled OR due within the next N days. It's listed under its earliest date.
    const dates = [item.scheduled, item.due].filter(Boolean).sort();
    const isToday = dates.some((x) => x <= today);
    const isThisWeek = dates.some((x) => x <= weekEnd);
    item.when = isToday ? today : dates.find((x) => x > today && x <= weekEnd) || dates[0] || null;
    item.overdue = !!(item.due && item.due < today) || !!(item.scheduled && item.scheduled < today);
    if (inFocus) {
      if (isToday) out.today.push(item);
      else if (isThisWeek) out.later.push(item);
      else if (inCurWeek && !dates.length) out.anytime.push(item);
    } else if (isThisWeek) out.outside.push(item);
  }
  // Tasks with a deadline (📅) come first, earliest deadline first; then priority; then scheduled date.
  const byDeadline = (a, b) =>
    (!!b.due - !!a.due) ||
    String(a.due || "").localeCompare(String(b.due || "")) ||
    PRIO_RANK[a.prio] - PRIO_RANK[b.prio] ||
    String(a.scheduled || "9").localeCompare(String(b.scheduled || "9")) ||
    a.desc.localeCompare(b.desc);
  // Routines rank below project work, unless they have a deadline (📅) or a high priority (⏫ / 🔺).
  const lowRoutine = (t) => t.routine && !t.clock && !t.due && t.prio !== "high" && t.prio !== "highest";
  const byDayThenDeadline = (a, b) => String(a.when).localeCompare(String(b.when)) || (lowRoutine(a) - lowRoutine(b)) || byDeadline(a, b);
  out.today.sort(byDeadline); out.later.sort(byDayThenDeadline); out.anytime.sort(byDeadline); out.outside.sort(byDeadline);
  out.routines = out.today.filter(lowRoutine);            // shown as a compact list under Today
  out.today = out.today.filter((t) => !lowRoutine(t));
  out.later = out.later.filter((t) => !(lowRoutine(t) && t.freq === "daily")); // daily ones would repeat every day
  return out;
}
/** { start, end } minutes of a task's [time::] (end from the estimate or the default length), or null. */
function clockOf(text, cfg) {
  const r = parseClockRange(parseFields(text).time);
  if (!r) return null;
  return { start: r.start, end: r.end !== null ? r.end : r.start + (timeOf(text).est || Number(cfg && cfg.calendar_default_minutes) || 30) };
}
function toTaskItem(d, t) {
  const text = String(t.body !== undefined ? t.body : t.text || "");
  const today = d.today.format("YYYY-MM-DD");
  const it = { path: t.path, line: t.line, text, status: t.status,
    desc: stripFields(splitMeta(text).head).replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2").trim(),
    due: getDate(text, "due"), scheduled: getDate(text, "scheduled"), start: getDate(text, "start"), prio: prioOf(text), time: timeOf(text), recurring: !!ruleOf(text), clock: clockOf(text, d.cfg), cal: !!parseFields(text).cal };
  it.overdue = isOpen(t) && (!!(it.due && it.due < today) || !!(it.scheduled && it.scheduled < today));
  return it;
}
function taskRow(d, t, { showProject = true, done = false, keep = false } = {}) {
  const m = getMoment();
  const chip = (emoji, iso, cls = "") => `<span class="pt-chip ${cls}">${emoji} ${iso === d.today.format("YYYY-MM-DD") ? "today" : m(iso, "YYYY-MM-DD").format("ddd D MMM")}</span>`;
  const chips = [];
  const p = t.prio;
  if (t.clock) chips.push(`<span class="pt-chip pt-chip-clock" title="${t.cal ? "in Google Calendar" : "set time — goes to the calendar on the next sync"}">🕒 ${fmtClock(t.clock.start)}–${fmtClock(t.clock.end)}${t.cal ? " 📆" : ""}</span>`);
  if (p === "highest" || p === "high") chips.push(`<span class="pt-chip pt-chip-prio">${p === "highest" ? "🔺" : "⏫"}</span>`);
  if (t.scheduled) chips.push(chip("⏳", t.scheduled, t.scheduled < d.today.format("YYYY-MM-DD") ? "pt-chip-late" : ""));
  if (t.due) chips.push(chip("📅", t.due, t.due < d.today.format("YYYY-MM-DD") ? "pt-chip-late" : t.due === d.today.format("YYYY-MM-DD") ? "pt-chip-today" : ""));
  const tm = t.time || {};
  if (tm.est || tm.active || tm.passive) {
    const over = tm.est && tm.active > tm.est;
    const bits = [tm.active ? `⏱ ${fmtDur(tm.active)}` : "", tm.est ? `${tm.active ? "/ " : ""}≈ ${fmtDur(tm.est)}` : "", tm.passive ? `⌛ ${fmtDur(tm.passive)}` : ""].filter(Boolean);
    chips.push(`<span class="pt-chip pt-chip-time${over ? " pt-chip-late" : ""}" title="${esc(timeText(tm))}">${esc(bits.join(" "))}</span>`);
  }
  const proj = showProject ? (t.project ? link(t.project.path, t.group, "pt-task-proj") : `<span class="pt-task-proj">${esc(t.group)}</span>`) : "";
  return `<div class="pt-task${t.overdue ? " is-overdue" : ""}${done ? " is-done" : ""}" data-path="${esc(t.path)}" data-line="${t.line}" data-text="${esc(t.text)}"${done || keep ? ' data-keep="1"' : ""}${tm.est ? ` data-est="${tm.est}"` : ""}${tm.active ? ` data-active="${tm.active}"` : ""}${t.recurring ? ' data-recurring="1"' : ""}>
    <input type="checkbox" class="task-list-item-checkbox pt-task-check" aria-label="Done"${done ? " checked" : ""}>
    <div class="pt-task-body"><span class="pt-task-text">${esc(t.desc || t.text)}</span><span class="pt-task-meta">${proj}${chips.join("")}</span></div>
    ${done ? "" : `<button class="pt-task-btn clickable-icon" data-act="clock" data-clock="${t.clock ? esc(parseFields(t.text).time || "") : ""}" title="Set time of day (goes to Google Calendar) or any time" aria-label="Set time">🕒</button>`}
    <button class="pt-task-btn clickable-icon" data-act="time" title="Estimate and time spent" aria-label="Time">⏱</button>
    <button class="pt-task-btn clickable-icon" data-act="edit" title="Edit dates and priority" aria-label="Edit">✎</button>
    ${done ? "" : `<button class="pt-task-btn clickable-icon" data-act="cancel" title="Cancel — not done, left out of the scores" aria-label="Cancel task">✖</button>`}
    <button class="pt-task-btn clickable-icon" data-act="open" title="Open the note" aria-label="Open">↗</button>
  </div>`;
}
/** Calendar events (not the tracker's own) on a day, from the last sync. */
function calEvents(d, iso) {
  const items = (d.cal && d.cal.cache && d.cal.cache.items) || [];
  return items.filter((e) => (e.allDay ? e.date <= iso && (e.endDate || e.date) >= iso : e.date === iso));
}
function agoText(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function calNote(d) {
  if (!d.calOn) return "";
  const at = d.cal && d.cal.lastSync;
  return ` <span class="pt-muted pt-cal-note">· 📆 ${at ? `synced ${agoText(at)}` : "not synced yet"} <button class="pt-mini" data-cal="sync" title="Sync timed tasks with Google Calendar">Sync</button></span>`;
}
function eventRow(e) {
  const when = e.allDay ? "all day" : `${fmtClock(e.start)}–${fmtClock(e.end)}`;
  return `<div class="pt-event${e.allDay ? " is-allday" : ""}"><span class="pt-event-time">${when}</span><span class="pt-event-title">${e.link ? `<a href="${esc(e.link)}" class="external-link">${esc(e.title)}</a>` : esc(e.title)}</span><span class="pt-muted">📆</span></div>`;
}
/** A day: all-day events, then timed tasks and events in time order, then tasks for any time of the day. */
function dayList(d, tasks, evs, today) {
  const timed = [...tasks.filter((t) => t.clock).map((t) => ({ at: t.clock.start, html: taskRow(d, t) })), ...evs.filter((e) => !e.allDay).map((e) => ({ at: e.start, html: eventRow(e) }))].sort((a, b) => a.at - b.at);
  const rest = tasks.filter((t) => !t.clock);
  let h = evs.filter((e) => e.allDay).map(eventRow).join("") + timed.map((x) => x.html).join("");
  if (rest.length && timed.length && today) h += `<div class="pt-day pt-anytime-head">Any time today</div>`;
  return h + rest.map((t) => taskRow(d, t)).join("");
}
function renderTaskWidgets(d, tasks) {
  const c = classifyTasks(d, tasks);
  const m = getMoment();
  let h = "";
  const focusNames = [...c.focus].map((p) => d.byPath.get(p)?.name).filter(Boolean);
  const nextNames = [...c.upcomingFocus].filter((p) => !c.focus.has(p)).map((p) => d.byPath.get(p)?.name).filter(Boolean);
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Focus tasks</span><span class="pt-muted">${esc(focusNames.join(" · "))}${nextNames.length ? ` <span class="pt-next">+ next week: ${esc(nextNames.join(" · "))}</span>` : ""}</span></div>`;
  if (!c.hasPlan && !c.today.length && !c.later.length && !c.routines.length) h += `<div class="pt-empty">No plan for this week — only tasks outside focus are shown below.</div>`;
  else {
    const evToday = calEvents(d, c.todayIso);
    h += `<div class="pt-sub">Today${c.today.length ? ` <span class="pt-count">${c.today.length}</span>` : ""}${calNote(d)}</div>`;
    h += c.today.length || evToday.length ? dayList(d, c.today, evToday, true) : `<div class="pt-empty">Nothing scheduled or due today.</div>`;
    if (d.routines.some((r) => r.project.status === "active")) {
      const rw = d.routineWeeks.get(d.curId), rp = rPct(rw), avg = routineAvg(d, d.curId, 4);
      const multi = new Set(c.routines.map((t) => t.project.path)).size > 1;
      h += `<div class="pt-sub">Routines today${c.routines.length ? ` <span class="pt-count">${c.routines.length}</span>` : ""} <span class="pt-muted">· this week ${rw && rw.done + rw.missed ? `${rw.done}/${rw.done + rw.missed} · ${rp}%` : "–"}${avg !== null ? ` · 4-wk avg ${avg}%` : ""}${rw && rw.mins ? ` · ⏱ ${fmtDur(rw.mins)}` : ""}</span></div>`;
      h += c.routines.length ? `<div class="pt-routines">${c.routines.map((t) => taskRow(d, t, { showProject: multi })).join("")}</div>` : `<div class="pt-empty">No routines left for today.</div>`;
    }
    const laterDays = [];
    for (let i = 1; i <= c.days; i++) laterDays.push(isoAdd(c.todayIso, i));
    if (c.later.length || laterDays.some((x) => calEvents(d, x).length)) {
      h += `<div class="pt-sub">Next ${c.days} days${c.planned.length ? ` <span class="pt-muted">· this week + ${c.planned.map(shortWeek).join(", ")} focus</span>` : ""}</div>`;
      for (const day of laterDays) {
        const ts = c.later.filter((t) => t.when === day), evs = calEvents(d, day);
        if (!ts.length && !evs.length) continue;
        h += `<div class="pt-day">${m(day, "YYYY-MM-DD").format("dddd D MMM")}</div>` + dayList(d, ts, evs, false);
      }
    }
    if (c.anytime.length) h += `<details class="pt-anytime"><summary class="pt-sub">Any day this week <span class="pt-count">${c.anytime.length}</span></summary>${c.anytime.map((t) => taskRow(d, t)).join("")}</details>`;
  }
  h += `</div>`;
  if (c.outside.length) {
    const groups = new Map();
    for (const t of c.outside) { if (!groups.has(t.group)) groups.set(t.group, []); groups.get(t.group).push(t); }
    const late = c.outside.filter((t) => t.overdue).length;
    h += `<div class="pt-card pt-card-alert"><div class="pt-card-head"><span class="pt-h">⚠ Outside this week's focus</span><span class="pt-muted">${c.outside.length} due or scheduled in the next ${c.days} days${late ? ` · <b class="pt-late">${late} overdue</b>` : ""}</span></div>`;
    for (const [g, ts] of groups) {
      const p = ts[0].project;
      h += `<div class="pt-day">${p ? link(p.path, g) : esc(g)}${p && p.status !== "active" ? ` <span class="pt-muted">${esc(p.status)}</span>` : ""}</div>`;
      h += ts.map((t) => taskRow(d, t, { showProject: false })).join("");
    }
    h += `<div class="pt-muted pt-hint">Do it, move the date (✎), or make room for it in next week's plan.</div></div>`;
  }
  return h;
}

/** Fallback when the Tasks plugin API isn't available: tick the box and add a ✅ date. */
function toggleDoneLine(line, today) {
  const m = line.match(/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[(.)\]/);
  if (!m) return line;
  if (m[2] === "x" || m[2] === "X") return setDate(setStatus(line, " "), "done", null);
  return setDate(setStatus(line, "x"), "done", today);
}

/* ------------------------------------------------------------------ Google Calendar */
// A task with a precise time has [time:: 14:30] or [time:: 14:30-15:30] plus a day (⏳ scheduled, else 📅 due).
// Sync calendar pushes those to Google Calendar as events ([cal:: <event id>] links them), pulls back a day/time you
// changed in the calendar, and keeps a copy of your other calendar events for Home. Tasks without a time stay out.

const GCAL_TOKEN = `${AI_DIR}/google-calendar-token.json`;
const GCAL_STATE = `${AI_DIR}/calendar.json`;
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GCAL_API = "https://www.googleapis.com/calendar/v3";
const GCAL_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** "14:30", "9", "9.15", "0930", "2pm", "2:30 pm" → minutes after midnight, or null. */
function parseClock(s) {
  const t = String(s || "").trim().toLowerCase().replace(/\s+/g, "");
  let m = t.match(/^(\d{1,2})(?:[:.h](\d{2}))?(am|pm)?$/) || t.match(/^(\d{2})(\d{2})()$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0), ap = m[3];
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === "pm" ? 12 : 0); }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const fmtClock = (min) => { const v = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; };
/** "14:30" or "14:30-15:30" (also –, "to") → { start, end } in minutes (end null when not given), or null. */
function parseClockRange(v) {
  const parts = String(v || "").trim().split(/\s*(?:-|–|—|\bto\b)\s*/i).filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  const start = parseClock(parts[0]);
  if (start === null) return null;
  const end = parts[1] !== undefined ? parseClock(parts[1]) : null;
  if (parts[1] !== undefined && end === null) return null;
  return { start, end };
}
/** Set or clear the time of a task. value: "14:30", "14:30-15:30", "" / null = any time. Returns the line, or null if it doesn't parse. */
function setClock(line, value) {
  if (value === null || value === undefined || !String(value).trim()) return setField(line, "time", null);
  const r = parseClockRange(value);
  if (!r) return null;
  return setField(line, "time", r.end === null ? fmtClock(r.start) : `${fmtClock(r.start)}-${fmtClock(r.end)}`);
}
/** The calendar slot of a task line: { date, start, end, endDate } (minutes; end may pass midnight), or null for an any-time task. */
function slotOf(line, cfg) {
  const f = parseFields(line);
  const r = parseClockRange(f.time);
  const date = getDate(line, "scheduled") || getDate(line, "due");
  if (!r || !date) return null;
  const est = timeOf(f).est;
  let end = r.end !== null ? r.end : r.start + (est || Number(cfg.calendar_default_minutes) || 30);
  if (end <= r.start) end += 1440;
  return { date, start: r.start, end, endDate: isoAdd(date, Math.floor(end / 1440)) };
}
const clockText = (s) => (s ? `${fmtClock(s.start)}–${fmtClock(s.end)}` : "");
function calTz(cfg) {
  if (cfg.calendar_timezone) return String(cfg.calendar_timezone);
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
}
/** An RFC 3339 time from Google → { date, min } in the calendar's time zone. */
function localParts(dt, tz) {
  const d = new Date(dt);
  try {
    const p = {};
    for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d)) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
  } catch (e) {
    return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, min: d.getHours() * 60 + d.getMinutes() };
  }
}
const GCAL_ID_CHARS = "0123456789abcdefghijklmnopqrstuv"; // Google event ids: base32hex
function newEventId() { let s = "pt"; for (let i = 0; i < 18; i++) s += GCAL_ID_CHARS[Math.floor(Math.random() * 32)]; return s; }

async function readJson(app, path) {
  const f = app.vault.getAbstractFileByPath(path);
  if (!f) return null;
  try { return JSON.parse(await app.vault.read(f)); } catch (e) { return null; }
}
async function gcalLoadState(app) { const s = await readJson(app, GCAL_STATE); return Object.assign({ events: {}, cache: null, lastSync: null }, s || {}); }
async function gcalConnected(app) { const t = await readJson(app, GCAL_TOKEN); return !!(t && t.refresh_token); }

const formBody = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }

/** One-time sign-in (desktop): opens Google in the browser and catches the answer on a local port. Saves the refresh token. */
async function gcalConnect(env, cfg) {
  if (!cfg.calendar_client_id) throw new Error("set calendar_client_id and calendar_client_secret in Tracker/Config first — see Start here → Google Calendar");
  if (env.isMobile) throw new Error("connect Google Calendar once on the Mac — the iPhone then uses the same sign-in (Tracker/AI, synced with the vault)");
  const req = typeof require === "function" ? require : typeof window !== "undefined" && window.require;
  if (!req) throw new Error("can't open a local port for the Google sign-in here — connect on the Mac");
  const http = req("http");
  const verifier = randomString(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = randomString(12);
  let server;
  const got = new Promise((resolve, reject) => {
    server = http.createServer((rq, rs) => {
      const u = new URL(rq.url, "http://127.0.0.1");
      if (!u.searchParams.get("code") && !u.searchParams.get("error")) { rs.writeHead(404); rs.end(); return; }
      const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
      rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      rs.end(`<html><body style="font-family:-apple-system,sans-serif;padding:3em"><h2>${ok ? "✔ Google Calendar is connected" : "✖ Sign-in failed"}</h2><p>You can close this tab and go back to Obsidian.</p></body></html>`);
      if (ok) resolve(u.searchParams.get("code")); else reject(new Error(`Google sign-in failed: ${u.searchParams.get("error") || "state mismatch"}`));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1");
    setTimeout(() => reject(new Error("Google sign-in timed out — run Sync calendar again")), 5 * 60 * 1000);
  });
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${formBody({ client_id: cfg.calendar_client_id, redirect_uri: redirect, response_type: "code", scope: GCAL_SCOPE, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", state })}`;
  env.notice("📆 Sign in to Google in your browser to connect the calendar…", 10000);
  env.openUrl(url);
  let code;
  try { code = await got; } finally { try { server.close(); } catch (e) { /* closed */ } }
  const r = await env.request({ url: GCAL_TOKEN_URL, method: "POST", contentType: "application/x-www-form-urlencoded",
    body: formBody({ code, client_id: cfg.calendar_client_id, client_secret: cfg.calendar_client_secret || "", redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier }) });
  const j = JSON.parse(r.text || "{}");
  if (r.status !== 200 || !j.refresh_token) throw new Error(`Google didn't return a sign-in token (${r.status}): ${j.error_description || j.error || r.text}`);
  await writeFile(env.app, GCAL_TOKEN, JSON.stringify({ refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 }, null, 2));
  env.notice("📆 Google Calendar connected.");
}
async function gcalAccess(env, cfg, force = false) {
  const tok = await readJson(env.app, GCAL_TOKEN);
  if (!tok || !tok.refresh_token) return null;
  if (!force && tok.access_token && tok.expires_at > Date.now() + 60000) return tok.access_token;
  const r = await env.request({ url: GCAL_TOKEN_URL, method: "POST", contentType: "application/x-www-form-urlencoded",
    body: formBody({ client_id: cfg.calendar_client_id, client_secret: cfg.calendar_client_secret || "", refresh_token: tok.refresh_token, grant_type: "refresh_token" }) });
  const j = JSON.parse(r.text || "{}");
  if (r.status !== 200 || !j.access_token) {
    if (j.error === "invalid_grant") throw new Error("the Google sign-in has expired or was revoked — run Sync calendar on the Mac to connect again");
    throw new Error(`couldn't refresh the Google sign-in (${r.status}): ${j.error_description || j.error || r.text}`);
  }
  Object.assign(tok, { access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 });
  await writeFile(env.app, GCAL_TOKEN, JSON.stringify(tok, null, 2));
  return tok.access_token;
}
/** Call the Calendar API. Returns parsed JSON, null for 404 / 410 (gone), {} for an empty answer. */
async function gapi(env, cfg, method, path, { query, body } = {}) {
  let url = `${GCAL_API}${path}`;
  if (query) url += `?${formBody(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)))}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await gcalAccess(env, cfg, attempt > 0);
    if (!token) throw new Error("Google Calendar isn't connected — run Sync calendar on the Mac");
    const r = await env.request({ url, method, contentType: "application/json", headers: { Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && attempt === 0) continue;
    if (r.status === 404 || r.status === 410) return null;
    if (r.status < 200 || r.status >= 300) {
      let msg = r.text;
      try { msg = JSON.parse(r.text).error.message; } catch (e) { /* plain text */ }
      throw new Error(`Google Calendar: ${msg} (${r.status})`);
    }
    return r.text ? JSON.parse(r.text) : {};
  }
  return null;
}
const calPath = (cfg) => `/calendars/${encodeURIComponent(cfg.calendar_id || "primary")}/events`;
async function gcalList(env, cfg, calId, query) {
  const out = [];
  let page;
  for (let i = 0; i < 20; i++) {
    const j = await gapi(env, cfg, "GET", `/calendars/${encodeURIComponent(calId)}/events`, { query: Object.assign({ singleEvents: "true", maxResults: 2500, pageToken: page }, query) });
    if (!j) break;
    out.push(...(j.items || []));
    if (!(page = j.nextPageToken)) break;
  }
  return out;
}

/** What the calendar should show for a task. */
function taskSig(t) { return JSON.stringify([t.slot.date, t.slot.start, t.slot.end, t.desc, isDone(t) ? "done" : "open"]); }
function eventBody(app, cfg, t, projName) {
  const tz = calTz(cfg), s = t.slot;
  const vault = app.vault.getName ? app.vault.getName() : "";
  return {
    summary: `${isDone(t) ? "✓ " : ""}${t.desc}`,
    description: `${projName ? `${projName} · ` : ""}from Obsidian\nobsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(t.path.replace(/\.md$/, ""))}`,
    start: { dateTime: `${s.date}T${fmtClock(s.start)}:00`, timeZone: tz },
    end: { dateTime: `${s.endDate}T${fmtClock(s.end)}:00`, timeZone: tz },
    extendedProperties: { private: { ptrack: "1" } },
  };
}
/** Write a time (and day) that was changed in the calendar back into a task line. */
function pullSlot(line, ev, cfg) {
  const tz = calTz(cfg);
  const a = localParts(ev.start.dateTime, tz), b = localParts(ev.end.dateTime, tz);
  let dur = isoDiff(a.date, b.date) * 1440 + b.min - a.min;
  if (dur <= 0) dur = Number(cfg.calendar_default_minutes) || 30;
  const derived = timeOf(line).est || Number(cfg.calendar_default_minutes) || 30;
  let out = setField(line, "time", dur === derived ? fmtClock(a.min) : `${fmtClock(a.min)}-${fmtClock(a.min + dur)}`);
  const cur = getDate(line, "scheduled") || getDate(line, "due");
  if (a.date !== cur) out = setDate(out, "scheduled", a.date);
  return out;
}

/**
 * Two-way sync. Tasks with a time and a day get an event; a day / time changed in the calendar comes back to the task
 * (the task wins when both changed); an event deleted in the calendar (or made all-day) turns the task into an any-time
 * task; done tasks show as “✓ …”; cancelled tasks and tasks whose time was removed lose their event.
 * Returns a summary { created, updated, pulled, removed, unlinked, conflicts, events }.
 */
async function syncCalendar(env, { quiet = false } = {}) {
  const { app } = env, cfg = getConfig(app);
  if (!(await gcalConnected(app))) {
    if (quiet) return null;
    await gcalConnect(env, cfg);
  }
  const today = env.moment().format("YYYY-MM-DD");
  const from = isoAdd(today, -60), to = isoAdd(today, 400);
  const state = await gcalLoadState(app);
  const projects = listProjects(app, cfg), ctx = { cfg, projects };
  // 1. every task that has a time or an event
  const tasks = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith(TRACKER_ROOT + "/")) continue;
    const p = projectOfPath(ctx, f.path);
    if (!p) continue;
    const content = await app.vault.cachedRead(f);
    if (!content.includes("[time::") && !content.includes("[cal::")) continue;
    for (const it of parseItems(content.split("\n"))) {
      if (!it.task || (!it.fields.time && !it.fields.cal)) continue;
      const t = { path: f.path, line: it.line, raw: it.raw, status: it.status, fields: it.fields, desc: taskDesc(it.raw), cal: it.fields.cal || null, project: p.name };
      t.slot = slotOf(it.raw, cfg);
      tasks.push(t);
    }
  }
  // a repeating task's next occurrence may have copied the event id: only one line keeps it
  const byId = new Map();
  for (const t of tasks) if (t.cal) { if (!byId.has(t.cal)) byId.set(t.cal, []); byId.get(t.cal).push(t); }
  for (const [id, ts] of byId) if (ts.length > 1) {
    const st = state.events[id];
    const keep = ts.find((t) => t.slot && st && taskSig(t) === st.sig) || ts.find((t) => !isOpen(t)) || ts[0];
    for (const t of ts) if (t !== keep) { t.cal = null; t.dropId = true; }
  }
  // 2. our events in the calendar
  const evs = await gcalList(env, cfg, cfg.calendar_id || "primary", { privateExtendedProperty: "ptrack=1", showDeleted: "true", timeMin: `${from}T00:00:00Z`, timeMax: `${to}T00:00:00Z` });
  const evById = new Map(evs.map((e) => [e.id, e]));
  const res = { created: 0, updated: 0, pulled: 0, removed: 0, unlinked: 0, conflicts: 0, events: 0 };
  const edits = [];
  const edit = (t, line) => { if (line !== t.raw) edits.push({ path: t.path, raw: t.raw, line: t.line, next: line }); };
  const inWindow = (date) => date >= from && date < to;
  const del = async (id) => { await gapi(env, cfg, "DELETE", `${calPath(cfg)}/${encodeURIComponent(id)}`); delete state.events[id]; res.removed++; };
  const linked = new Set();
  for (const t of tasks) {
    let line = t.raw;
    if (t.dropId) line = setField(line, "cal", null);
    const id = t.cal;
    if (!id) {
      if (isOpen(t) && t.slot && t.slot.date >= today && t.slot.date < to) {
        const nid = newEventId();
        const ev = await gapi(env, cfg, "POST", calPath(cfg), { body: Object.assign({ id: nid }, eventBody(app, cfg, t, t.project)) });
        line = setField(line, "cal", nid);
        state.events[nid] = { sig: taskSig(t), updated: ev && ev.updated, path: t.path };
        linked.add(nid); res.created++;
      }
      edit(t, line);
      continue;
    }
    linked.add(id);
    const ev = evById.get(id), st = state.events[id];
    if (!t.slot || t.status === "-") {   // no time / no day any more, or cancelled: the event goes
      if (ev && ev.status !== "cancelled") await del(id); else delete state.events[id];
      edit(t, setField(line, "cal", null)); res.unlinked++;
      continue;
    }
    if (!inWindow(t.slot.date)) continue; // far past / far future: leave it alone
    const gone = ev ? ev.status === "cancelled" : !!st;
    if (gone || (ev && ev.start && ev.start.date)) { // deleted in the calendar, or made all-day → any time that day
      if (ev && ev.status !== "cancelled") await del(id); else delete state.events[id];
      edit(t, setField(setField(line, "cal", null), "time", null)); res.unlinked++;
      continue;
    }
    const sig = taskSig(t);
    const taskChanged = !st || st.sig !== sig;
    const evChanged = !!(ev && st && ev.updated !== st.updated);
    if (!ev) { // never seen by this device and not in the calendar: make it again under a new id
      const nid = newEventId();
      const made = await gapi(env, cfg, "POST", calPath(cfg), { body: Object.assign({ id: nid }, eventBody(app, cfg, t, t.project)) });
      edit(t, setField(line, "cal", nid));
      state.events[nid] = { sig, updated: made && made.updated, path: t.path };
      linked.add(nid); res.created++;
      continue;
    }
    if (evChanged && !taskChanged) {
      const next = pullSlot(line, ev, cfg);
      const nt = Object.assign({}, t, { slot: slotOf(next, cfg) });
      state.events[id] = { sig: nt.slot ? taskSig(nt) : sig, updated: ev.updated, path: t.path };
      if (next !== line) res.pulled++;
      edit(t, next);
      continue;
    }
    if (evChanged && taskChanged) res.conflicts++;
    if (taskChanged) {
      const up = await gapi(env, cfg, "PATCH", `${calPath(cfg)}/${encodeURIComponent(id)}`, { body: eventBody(app, cfg, t, t.project) });
      state.events[id] = { sig, updated: up && up.updated, path: t.path };
      res.updated++;
    }
    edit(t, line);
  }
  // 3. events whose task was deleted from a note that still exists (a few minutes' grace for notes still syncing)
  for (const ev of evs) {
    if (ev.status === "cancelled" || linked.has(ev.id)) continue;
    const st = state.events[ev.id];
    if (!st || !app.vault.getAbstractFileByPath(st.path)) continue;
    if (ev.updated && Date.now() - new Date(ev.updated).getTime() < 10 * 60 * 1000) continue;
    await del(ev.id);
  }
  // 4. write the task changes
  const byPath = new Map();
  for (const e of edits) { if (!byPath.has(e.path)) byPath.set(e.path, []); byPath.get(e.path).push(e); }
  for (const [path, es] of byPath) await editLines(app, path, (ls) => { for (const e of es) { const k = locateRaw(ls, e.raw, e.line); if (k >= 0) ls[k] = e.next; } });
  // 5. the coming days' calendar events for Home (yours, not the tracker's)
  const days = Math.max(1, Number(cfg.upcoming_days) || 7);
  const show = [cfg.calendar_id || "primary", ...toArr(cfg.calendar_show)].filter((x, i, a) => a.indexOf(x) === i);
  const items = [];
  const tz = calTz(cfg);
  for (const calId of show) {
    for (const e of await gcalList(env, cfg, calId, { timeMin: `${isoAdd(today, -1)}T00:00:00Z`, timeMax: `${isoAdd(today, days + 2)}T00:00:00Z`, orderBy: "startTime" })) {
      if (e.status === "cancelled" || (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.ptrack)) continue;
      if (e.start.date) { items.push({ title: e.summary || "(busy)", date: e.start.date, endDate: isoAdd(e.end.date, -1), allDay: true, link: e.htmlLink || "" }); continue; }
      const a = localParts(e.start.dateTime, tz), b = localParts(e.end.dateTime, tz);
      items.push({ title: e.summary || "(busy)", date: a.date, start: a.min, end: b.date === a.date ? b.min : 1440, allDay: false, link: e.htmlLink || "" });
    }
  }
  res.events = items.length;
  state.cache = { at: new Date().toISOString(), from: today, items };
  state.lastSync = new Date().toISOString();
  await writeFile(app, GCAL_STATE, JSON.stringify(state, null, 2));
  return res;
}
function syncSummary(r) {
  if (!r) return "Google Calendar isn't connected.";
  const bits = [r.created && `${r.created} added`, r.updated && `${r.updated} updated`, r.pulled && `${r.pulled} moved from the calendar`, r.unlinked && `${r.unlinked} back to any time / removed`, r.removed && !r.unlinked && `${r.removed} removed`, r.conflicts && `${r.conflicts} changed on both sides — kept the task's time`].filter(Boolean);
  return `📆 Calendar synced${bits.length ? `: ${bits.join(" · ")}` : " — nothing to change"}.`;
}
async function cmdSyncCalendar(env) { env.notice(syncSummary(await syncCalendar(env)), 8000); }

/** Ask whether a task has a precise time (→ calendar) or can be done any time that day. */
async function askClock(env, line) {
  if (!getDate(line, "scheduled") && !getDate(line, "due")) return line;
  const cur = parseFields(line).time;
  const opts = cur ? [[`Keep 🕒 ${cur}`, "keep"], ["Any time that day (no calendar event)", ""], ["Another time…", "set"]] : [["Any time that day", ""], ["🕒 At a set time… (goes to the calendar)", "set"]];
  const v = await env.suggest(opts.map((o) => o[0]), opts.map((o) => o[1]), `🕒 Does “${taskDesc(line)}” have a set time?`);
  if (v === null || v === undefined || v === "keep") return line;
  if (v === "") return setClock(line, null);
  for (;;) {
    const t = await env.prompt(`🕒 Time for “${taskDesc(line)}” — e.g. 14:30 or 14:30-15:30`, cur || "");
    if (t === null || t === undefined) return line;
    const next = setClock(line, t);
    if (next !== null) return next;
    env.notice(`“${t}” isn't a time. Use e.g. 9:00, 14:30 or 14:30-15:30.`, 5000);
  }
}

/* ------------------------------------------------------------------ rendering */

const CMD = (name) => `${COMMANDS_FOLDER}/${name}.md`;
const link = (path, label, cls = "") => `<a class="internal-link pt-link ${cls}" data-href="${esc(path)}" href="${esc(path)}">${esc(label)}</a>`;
const scoreCls = (s) => (s === null || s === undefined ? "none" : s >= 100 ? "full" : s >= 70 ? "good" : s >= 40 ? "mid" : "low");
function bar(pct) { return `<div class="pt-bar"><div class="pt-bar-fill pt-${scoreCls(pct)}" style="width:${clamp(pct || 0, 0, 100)}%"></div></div>`; }
function kpi(label, value, sub = "") { return `<div class="pt-kpi"><div class="pt-kpi-label">${esc(label)}</div><div class="pt-kpi-value">${value}</div>${sub ? `<div class="pt-kpi-sub">${sub}</div>` : ""}</div>`; }
function delta(cur, base, unit = "") {
  if (cur === null || base === null || cur === undefined || base === undefined) return "";
  const d = Math.round(cur - base);
  if (!d) return `<span class="pt-flat">= 4-wk avg</span>`;
  return `<span class="${d > 0 ? "pt-up" : "pt-down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d)}${unit} vs 4-wk avg</span>`;
}
/** "80% / 20%" planned vs unplanned, with the counts on hover. */
function mixCell(a) {
  const tot = a.planned + a.unplanned;
  if (!tot) return `<td class="pt-num"><span class="pt-muted">–</span></td>`;
  const u = unplPct(a);
  return `<td class="pt-num" title="${a.planned} planned (${a.plannedDone} done) · ${a.unplanned} unplanned (${a.unplannedDone} done)">${100 - u}% / ${u}%</td>`;
}
const reasonLabel = (k) => (MISS_REASONS.find((r) => r[0] === k) || [k, k])[1];

/** Move a goal (and anything nested under it) up (-1) or down (+1) in its week note. Returns false if it can't move. */
async function moveGoal(app, weekPath, raw, delta) {
  let moved = false;
  await editLines(app, weekPath, (ls) => {
    const gs = parseWeek(ls.join("\n")).goals;
    const i = gs.findIndex((g) => g.raw === raw), j = i + delta;
    if (i < 0 || j < 0 || j >= gs.length) return;
    const [a, b] = i < j ? [gs[i], gs[j]] : [gs[j], gs[i]];
    const aEnd = blockEnd(ls, a.item), bEnd = blockEnd(ls, b.item);
    const blockA = ls.slice(a.line, aEnd), between = ls.slice(aEnd, b.line), blockB = ls.slice(b.line, bEnd);
    ls.splice(a.line, bEnd - a.line, ...blockB, ...between, ...blockA);
    moved = true;
  });
  return moved;
}
function goalRows(d, w, { showProject = true, compact = false, reorder = false } = {}) {
  if (!w.goals.length) return `<div class="pt-empty">No goals yet.</div>`;
  const n = w.goals.length;
  const mv = (g, i) => (reorder && !w.virtual && n > 1 ? `<span class="pt-move">${[[-1, "↑", "Move up"], [1, "↓", "Move down"]].map(([dl, lbl, t]) => `<button class="pt-task-btn clickable-icon" data-move="${dl}" data-week="${esc(w.path)}" data-raw="${esc(g.raw)}" title="${t}" aria-label="${t}"${(dl < 0 && i === 0) || (dl > 0 && i === n - 1) ? " disabled" : ""}>${lbl}</button>`).join("")}</span>` : "");
  return `<div class="pt-goals">${w.goals.map((g, gi) => {
    const badges = [];
    if (g.fields.from) badges.push(`<span class="pt-badge">carried from ${esc(linkLabel(g.fields.from))}</span>`);
    if (g.fields.miss) badges.push(`<span class="pt-badge pt-badge-miss">${esc(reasonLabel(g.fields.miss))}</span>`);
    const proj = g.projectPath ? link(g.projectPath, g.projectName, "pt-proj") : `<span class="pt-proj">${esc(g.projectName)}</span>`;
    return `<div class="pt-goal ${g.score >= 100 ? "is-done" : ""}">
      <div class="pt-goal-head">${showProject ? proj : ""}<span class="pt-goal-text">${esc(g.text)}</span>${badges.join("")}${mv(g, gi)}</div>
      <div class="pt-goal-bar">${bar(g.score)}<span class="pt-goal-num">${g.score}%</span>${compact ? "" : `<span class="pt-goal-tasks">${g.doneCount}/${g.counted.length} tasks${g.cancelled && g.cancelled.length ? ` · ${g.cancelled.length} cancelled` : ""}</span>`}</div>
    </div>`;
  }).join("")}</div>`;
}

function chartScores(d, ids) {
  return chartPct(d, ids, ids.map((id) => d.weekMap.get(id)?.m.avg ?? null),
    (id, v) => `${id}: ${v}% avg, ${d.weekMap.get(id).m.achieved}/${d.weekMap.get(id).m.goals} achieved`, "Average goal score per week");
}
/** Bar per week (0–100 %) with a 4-week trend line. */
function chartPct(d, ids, vals, titleOf, label) {
  const W = 640, H = 170, L = 30, R = 8, T = 10, B = 24, n = ids.length;
  const cw = (W - L - R) / n, bw = Math.min(28, cw * 0.62);
  const y = (v) => T + (H - T - B) * (1 - v / 100);
  let s = `<svg class="pt-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
  for (const v of [0, 50, 100]) s += `<line class="pt-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="pt-axis" x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
  const pts = [];
  ids.forEach((id, i) => {
    const v = vals[i], x = L + cw * i + cw / 2;
    if (v !== null) s += `<rect class="pt-bar-${scoreCls(v)}" x="${x - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0, y(0) - y(v))}" rx="3"><title>${esc(titleOf(id, v))}</title></rect>`;
    else s += `<circle class="pt-gap" cx="${x}" cy="${y(0) - 3}" r="2"/>`;
    const win = vals.slice(Math.max(0, i - 3), i + 1).filter((x) => x !== null);
    if (win.length && v !== null) pts.push([x, y(mean(win))]);
    if (i % Math.ceil(n / 12) === 0 || i === n - 1) s += `<text class="pt-axis ${id === d.curId ? "pt-axis-cur" : ""}" x="${x}" y="${H - 6}" text-anchor="middle">${shortWeek(id)}</text>`;
  });
  if (pts.length > 1) s += `<polyline class="pt-trend" points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}"/>`;
  return s + `</svg>`;
}
function chartTasks(d, ids) {
  const W = 640, H = 150, L = 30, R = 8, T = 10, B = 24, n = ids.length;
  const max = Math.max(4, ...ids.map((id) => d.weekMap.get(id)?.m.planned || 0));
  const cw = (W - L - R) / n, bw = Math.min(28, cw * 0.62);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let s = `<svg class="pt-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tasks planned and done per week">`;
  const step = max > 20 ? 10 : 5;
  for (let v = 0; v <= max; v += step) s += `<line class="pt-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="pt-axis" x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
  ids.forEach((id, i) => {
    const m = d.weekMap.get(id)?.m, x = L + cw * i + cw / 2;
    if (m) {
      s += `<rect class="pt-planned" x="${x - bw / 2}" y="${y(m.planned)}" width="${bw}" height="${y(0) - y(m.planned)}" rx="3"/>`;
      s += `<rect class="pt-done" x="${x - bw / 2}" y="${y(m.done)}" width="${bw}" height="${y(0) - y(m.done)}" rx="3"><title>${id}: ${m.done} of ${m.planned} tasks done${m.cancelled ? ` · ${m.cancelled} cancelled` : ""}</title></rect>`;
    }
    if (i % Math.ceil(n / 12) === 0 || i === n - 1) s += `<text class="pt-axis ${id === d.curId ? "pt-axis-cur" : ""}" x="${x}" y="${H - 6}" text-anchor="middle">${shortWeek(id)}</text>`;
  });
  return s + `</svg>`;
}
function sparkline(d, ids) {
  return `<div class="pt-spark">${ids.map((id) => {
    const v = d.weekMap.get(id)?.m.avg ?? null;
    return `<div class="pt-spark-col" title="${id}: ${v === null ? "no plan" : v + "%"}"><div class="pt-spark-bar pt-${scoreCls(v)}" style="height:${v === null ? 2 : Math.max(4, v)}%"></div></div>`;
  }).join("")}</div>`;
}
function buttons(list) { return `<div class="pt-actions">${list.map(([lbl, cmd, primary]) => `<button class="pt-btn ${primary ? "mod-cta" : ""}" data-cmd="${esc(CMD(cmd))}">${esc(lbl)}</button>`).join("")}</div>`; }

function lastClosedWeek(d) { return [...d.weeks].reverse().find((w) => w.m.goals && (w.id < d.curId || w.status === "reviewed")) || null; }
function baseline(d, before, key) {
  const ws = d.weeks.filter((w) => w.id < before && w.m.goals).slice(-4);
  return ws.length ? mean(ws.map((w) => (key === "rate" ? (100 * w.m.achieved) / w.m.goals : w.m[key]))) : null;
}
/** Active projects of top priority (≤ focus_priority) without a goal this week. Lower priorities may wait as long as they like. */
function neglected(d) {
  return d.projects.filter((p) => p.status === "active" && !p.routine && isTopPrio(d.cfg, p) && !d.weekMap.get(d.curId)?.goals.some((g) => g.projectPath === p.path))
    .sort((a, b) => projPrioRank(a) - projPrioRank(b) || a.name.localeCompare(b.name));
}

function renderHome(d, opts = {}) {
  const w = d.weekMap.get(d.curId);
  let h = `<div class="pt">`;
  h += buttons([["Capture", "Capture"], ["Process inbox", "Process inbox"], ["Plan week", "Plan week", true], ["Add tasks", "Add tasks"], ["Weekly review", "Weekly review"], ["New project", "New project"]]);
  const daysLeft = 7 - d.today.isoWeekday();
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">This week</span><span class="pt-muted">${w ? link(w.path, `${d.curId} · ${weekRange(d.curId)}`) : `${d.curId} · ${weekRange(d.curId)}`}</span></div>`;
  if (w && w.goals.length) {
    h += `<div class="pt-summary">${w.m.achieved}/${w.m.goals} goals done · ${w.m.done}/${w.m.planned} tasks · ${w.status === "reviewed" ? "reviewed" : daysLeft ? `${daysLeft} day${daysLeft > 1 ? "s" : ""} left` : "last day"}</div>`;
    h += goalRows(d, w, { compact: true, reorder: true });
  } else h += `<div class="pt-empty">No plan for this week yet — hit <b>Plan week</b>.</div>`;
  h += `</div>`;
  if (opts.tasks) h += renderTaskWidgets(d, opts.tasks);
  h += `<div class="pt-grid3">`;
  h += `<div class="pt-card"><div class="pt-h">Inbox</div><div class="pt-big">${d.inbox.open}</div><div class="pt-muted">${d.inbox.free ? `+ ${d.inbox.free} line(s) of notes · ` : ""}${d.inbox.review ? `${link(REVIEW_PATH, "✔ classified — review & apply", "pt-warn")} · ` : ""}${link(d.inbox.path, "open inbox")}</div></div>`;
  const ids = timeline(d, 8);
  const lw = lastClosedWeek(d);
  h += `<div class="pt-card"><div class="pt-h">Momentum · 8 weeks</div>${sparkline(d, ids)}<div class="pt-muted">${lw ? `last week ${lw.m.avg}% avg goal score` : "no history yet"}</div></div>`;
  const att = [];
  const unrev = d.weeks.filter((x) => x.id < d.curId && x.status !== "reviewed" && x.goals.length);
  for (const x of unrev.slice(-2)) att.push(`${link(x.path, x.id)} not reviewed`);
  for (const p of neglected(d).slice(0, 5)) att.push(`${link(p.path, p.name)} <span class="pt-muted">P${p.priority} · not in this week's plan</span>`);
  h += `<div class="pt-card"><div class="pt-h">Needs attention</div>${att.length ? `<ul class="pt-list">${att.map((a) => `<li>${a}</li>`).join("")}</ul>` : `<div class="pt-muted">Nothing — nice.</div>`}</div>`;
  h += `</div>`;
  const act = d.projects.filter((p) => p.status === "active" && !p.routine).length, back = d.projects.filter((p) => p.status === "backlog" && !p.routine).length;
  const nr = d.routines.filter((r) => r.project.status === "active").length;
  h += `<div class="pt-foot pt-muted">${act} active · ${back} backlog projects${nr ? ` · ${nr} routines` : ""} · ${link(ACTIVE_PATH, "Active projects →")} · ${link(PROJECTS_PATH, "Projects & priorities →")} · ${link("Tracker/Analytics.md", "Analytics →")}</div>`;
  return h + `</div>`;
}

function renderWeek(d, path, opts = {}) {
  const w = d.weeks.find((x) => x.path === path);
  if (!w) return `<div class="pt pt-empty">This note isn't a week note (needs <code>type: week</code> and <code>week: YYYY-Www</code>).</div>`;
  const isCur = w.id === d.curId, past = w.id < d.curId;
  const daysLeft = 7 - d.today.isoWeekday();
  const state = w.status === "reviewed" ? "reviewed" : past ? "awaiting review" : isCur ? (daysLeft ? `${daysLeft} day${daysLeft > 1 ? "s" : ""} left` : "review tonight") : "upcoming";
  let h = `<div class="pt">`;
  const outside = opts.completions ? opts.completions[w.id] || 0 : null;
  h += `<div class="pt-kpis">${kpi("Goals achieved", `${w.m.achieved}<span class="pt-of">/${w.m.goals}</span>`)}${kpi("Avg goal progress", w.m.avg === null ? "–" : `${w.m.avg}%`)}${kpi("Tasks done", `${w.m.done}<span class="pt-of">/${w.m.planned}</span>`, w.m.cancelled ? `✖ ${w.m.cancelled} cancelled, not counted` : "")}${outside === null ? "" : kpi("Done outside goals", outside, "✅ elsewhere in the vault")}${mixKpi("Unplanned tasks", mixSum(d, [w.id]))}${timeKpi("Time", tSum(d, [w.id]))}${routineKpi(d, w.id)}${kpi("Status", esc(state))}</div>`;
  const btn = [];
  if (w.status !== "reviewed" && (isCur || past)) btn.push(["Weekly review", "Weekly review", true]);
  if (!past) btn.push(["Plan / add goals", "Plan week"], ["Plan a project", "Plan project"]);
  if (isCur) btn.push(["Add tasks (unplanned)", "Add tasks"]);
  if (btn.length) h += buttons(btn);
  h += weekTaskList(d, w);
  h += routineWeekCard(d, w.id);
  return h + `</div>`;
}
function timeBadge(a) {
  if (!a.est && !a.active && !a.passive) return "";
  const acc = tAcc(a);
  return `<span class="pt-goal-time pt-muted" title="${esc(timeTitle(a))}">${a.active ? `⏱ ${fmtDur(a.active)}` : ""}${a.est ? ` / ≈ ${fmtDur(a.est)}` : ""}${a.passive ? ` · ⌛ ${fmtDur(a.passive)}` : ""}${acc !== null ? ` · <span class="${acc > 120 ? "pt-late" : ""}">${acc}% of est.</span>` : ""}</span>`;
}
const timeTitle = (a) => `estimated ${fmtDur(a.est) || "0m"} on ${a.estN}/${a.tasks} task(s) · active ${fmtDur(a.active) || "0m"} · passive ${fmtDur(a.passive) || "0m"}${a.doneN ? ` · done tasks with estimate and time: ${fmtDur(a.doneActive)} spent vs ${fmtDur(a.doneEst)} estimated` : ""}`;
function timeKpi(label, a) {
  if (!a.est && !a.active && !a.passive) return "";
  const acc = tAcc(a);
  return kpi(label, `${fmtDur(a.active) || "0m"}<span class="pt-of">${a.est ? ` / ≈ ${fmtDur(a.est)}` : ""}</span>`,
    [a.passive ? `⌛ ${fmtDur(a.passive)} passive` : "", acc !== null ? `${acc}% of estimate on ${a.doneN} done` : "", `${a.estN}/${a.tasks} estimated`].filter(Boolean).join(" · "));
}
function mixKpi(label, a) {
  const tot = a.planned + a.unplanned;
  if (!tot) return "";
  return kpi(label, `${a.unplanned}<span class="pt-of">/${tot} · ${unplPct(a)}%</span>`, `${a.planned} planned · ${a.unplanned} added during the week`);
}
function routineKpi(d, wid) {
  const a = d.routineWeeks.get(wid);
  if (!a || !(a.done + a.missed + a.upcoming)) return "";
  const p = rPct(a);
  return kpi("Routines", p === null ? "–" : `${p}%`, `${a.done}/${a.done + a.missed} done${a.upcoming ? ` · ${a.upcoming} to go` : ""}${a.mins ? ` · ⏱ ${fmtDur(a.mins)}` : ""}`);
}
const pctCell = (a) => { const p = rPct(a); return p === null ? `<span class="pt-muted">–</span>` : `<span class="pt-dot pt-${scoreCls(p)}"></span>${p}%`; };
const pctTitle = (a) => (a ? `${a.done} done · ${a.missed} missed${a.upcoming ? ` · ${a.upcoming} to go` : ""}${a.skipped ? ` · ${a.skipped} skipped` : ""}` : "no occurrences");
/** This week's routines: integral % plus one row per routine. */
function routineWeekCard(d, wid) {
  const rows = d.routines.filter((r) => r.weeks.has(wid));
  if (!rows.length) return "";
  const a = d.routineWeeks.get(wid);
  const multi = new Set(rows.map((r) => r.project.path)).size > 1;
  let h = `<div class="pt-card pt-wgroup"><div class="pt-goal-head"><span class="pt-proj">🔁 Routines</span><span class="pt-goal-text pt-muted">${esc(pctTitle(a))}${a.mins ? ` · ⏱ ${fmtDur(a.mins)} spent` : ""}</span></div>`;
  h += `<div class="pt-goal-bar">${bar(rPct(a))}<span class="pt-goal-num">${rPct(a) === null ? "–" : rPct(a) + "%"}</span><span class="pt-goal-tasks">${a.done}/${a.done + a.missed} done</span></div>`;
  h += `<table class="pt-table"><thead><tr><th>Routine</th><th>Repeats</th><th class="pt-num">Done</th><th class="pt-num">Missed</th><th class="pt-num">To go</th><th class="pt-num">%</th><th class="pt-num" title="Time spent: logged ⏱, or the routine's estimate">⏱ Time</th></tr></thead><tbody>`;
  for (const r of rows) {
    const x = r.weeks.get(wid);
    h += `<tr><td>${link(r.project.path, r.name)}${multi ? ` <span class="pt-muted">${esc(r.project.scope || r.project.name)}</span>` : ""}</td><td class="pt-muted">${esc(r.rule)}</td>`
      + `<td class="pt-num">${x.done}</td><td class="pt-num${x.missed ? " pt-late" : ""}">${x.missed}</td><td class="pt-num">${x.upcoming}</td><td class="pt-num" title="${esc(pctTitle(x))}">${pctCell(x)}</td><td class="pt-num" title="${esc(rTimeTitle(x))}">${rTime(x)}</td></tr>`;
  }
  return h + `</tbody></table></div>`;
}
/** Analytics: routine completion per week (integral), the separate routine average, and per-routine rates. */
function routineAnalytics(d, ids, routines = d.routines, title = "Routines") {
  if (!routines.length) return "";
  const weeksOf = (wid) => { // integral over the given routines for one week
    const out = R0();
    for (const r of routines) { const a = r.weeks.get(wid); if (a) for (const k of Object.keys(out)) out[k] += a[k]; }
    return out;
  };
  const map = new Map(ids.map((id) => [id, weeksOf(id)]));
  const lastId = shiftWeek(d.curId, -1), last = weeksOf(lastId), cur = weeksOf(d.curId);
  const closed = ids.filter((id) => id < d.curId);
  const avgOf = (before, n) => { const v = closed.filter((id) => id < before).map((id) => rPct(map.get(id))).filter((x) => x !== null).slice(-n); return v.length ? Math.round(mean(v)) : null; };
  const span = rSum(map, closed);
  let h = `<div class="pt-h">${esc(title)}</div><div class="pt-kpis">`;
  h += kpi("Last week", rPct(last) === null ? "–" : `${rPct(last)}%`, `${last.done}/${last.done + last.missed} done ${delta(rPct(last), avgOf(lastId, 4), " pts")}`);
  h += kpi("Routine avg · 4 wks", avgOf(d.curId, 4) === null ? "–" : `${avgOf(d.curId, 4)}%`, "mean of weekly %");
  h += kpi(`Routine avg · ${closed.length} wks`, avgOf(d.curId, closed.length) === null ? "–" : `${avgOf(d.curId, closed.length)}%`, `${span.done}/${span.done + span.missed} done · ${span.missed} missed`);
  h += kpi("This week so far", rPct(cur) === null ? "–" : `${rPct(cur)}%`, `${cur.done}/${cur.done + cur.missed} done${cur.upcoming ? ` · ${cur.upcoming} to go` : ""}`);
  const avgT = rWeekAvg(map, closed, 4);
  if (span.mins || cur.mins) h += kpi("⏱ Time · last week", rTime(last), `${avgT !== null ? `4-wk avg ${fmtDur(avgT) || "0m"} / week · ` : ""}this week ${rTime(cur)}`);
  h += `</div>`;
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Routine completion per week</span><span class="pt-legend"><i class="pt-lg-bar"></i>done ÷ (done + missed) <i class="pt-lg-line"></i>4-week trend</span></div>`
    + chartPct(d, ids, ids.map((id) => rPct(map.get(id))), (id, v) => `${id}: ${v}% · ${pctTitle(map.get(id))}`, "Routine completion per week") + `</div>`;
  const multi = new Set(routines.map((r) => r.project.path)).size > 1;
  h += `<div class="pt-card"><div class="pt-h">Per routine</div><div class="pt-heat-wrap"><table class="pt-table"><thead><tr><th>Routine</th><th>Repeats</th><th class="pt-num">This week</th><th class="pt-num">Last week</th><th class="pt-num">4-wk avg</th><th class="pt-num">${closed.length} wks</th><th class="pt-num">Missed</th><th class="pt-num" title="Average time per week over the last 4 weeks: logged ⏱, or the routine's estimate">⏱ / week</th></tr></thead><tbody>`;
  for (const r of routines) {
    const cw = r.weeks.get(d.curId), lw = r.weeks.get(lastId), all = rSum(r.weeks, closed);
    const a4 = routineAvg(d, d.curId, 4, r);
    h += `<tr><td>${link(r.project.path, r.name)}${multi ? ` <span class="pt-muted">${esc(r.project.scope || r.project.name)}</span>` : ""}${r.project.status !== "active" ? ` <span class="pt-muted">paused</span>` : ""}</td><td class="pt-muted">${esc(r.rule)}</td>`
      + `<td class="pt-num" title="${esc(pctTitle(cw))}">${pctCell(cw)}</td><td class="pt-num" title="${esc(pctTitle(lw))}">${pctCell(lw)}</td>`
      + `<td class="pt-num">${a4 === null ? `<span class="pt-muted">–</span>` : `<span class="pt-dot pt-${scoreCls(a4)}"></span>${a4}%`}</td>`
      + `<td class="pt-num" title="${esc(pctTitle(all))}">${pctCell(all)}</td><td class="pt-num${all.missed ? " pt-late" : ""}">${all.missed}</td>`
      + `<td class="pt-num" title="${esc(rTimeTitle(all))}">${(() => { const v = rWeekAvg(r.weeks, closed, 4); return v ? fmtDur(v) : `<span class="pt-muted">–</span>`; })()}</td></tr>`;
  }
  h += `</tbody></table></div></div>`;
  // time per area: each routine project is one part of your life (household, health, admin…)
  const areas = [...new Set(routines.map((r) => r.project))];
  const areaMap = (p) => { const m2 = new Map(); for (const id of ids) { const out = R0(); for (const r of routines.filter((x) => x.project === p)) { const a = r.weeks.get(id); if (a) for (const k of Object.keys(out)) out[k] += a[k]; } m2.set(id, out); } return m2; };
  if (span.mins || cur.mins) {
    h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">⏱ Time on routines</span><span class="pt-muted">logged time, or each routine's estimate (<code>[est::]</code>) when nothing was logged</span></div><div class="pt-heat-wrap"><table class="pt-table"><thead><tr><th>Area</th><th class="pt-num">This week</th><th class="pt-num">Last week</th><th class="pt-num">Avg / week · 4 wks</th><th class="pt-num">${closed.length} wks total</th><th class="pt-num">Logged</th></tr></thead><tbody>`;
    const rows = areas.map((p) => [p, areaMap(p)]);
    if (areas.length > 1) rows.push([null, map]);
    for (const [p, m2] of rows) {
      const tot = rSum(m2, closed), av = rWeekAvg(m2, closed, 4);
      h += `<tr${p ? "" : ' class="pt-total"'}><td>${p ? link(p.path, p.name) : "<b>All routines</b>"}</td><td class="pt-num">${rTime(m2.get(d.curId))}</td><td class="pt-num">${rTime(m2.get(lastId))}</td><td class="pt-num">${av ? fmtDur(av) : "–"}</td><td class="pt-num" title="${esc(rTimeTitle(tot))}">${rTime(tot)}</td><td class="pt-num">${tot.logged + tot.assumed ? `${Math.round((100 * tot.logged) / (tot.logged + tot.assumed))}%` : "–"}</td></tr>`;
    }
    h += `</tbody></table></div></div>`;
  }
  return h;
}
/** All tasks picked for the week, grouped by goal (project), with live progress. Tick / edit right here. */
function weekTaskList(d, w) {
  const groups = [];
  for (const g of w.goals) groups.push({ projectPath: g.projectPath, name: g.projectName, goal: g, here: g.tasks, carried: g.carriedOut, score: g.score, counted: g.counted.length, done: g.doneCount, cancelled: g.cancelled });
  for (const x of w.extra) groups.push({ projectPath: x.projectPath, name: x.projectName, goal: null, here: x.here, carried: x.carriedOut, score: x.counted.length ? Math.round((100 * x.doneCount) / x.counted.length) : 0, counted: x.counted.length, done: x.doneCount, cancelled: x.cancelled });
  if (!groups.length) return `<div class="pt-empty">No goals or tasks yet — use <b>Plan week</b> or <b>Plan a project</b>.</div>`;
  let h = "";
  for (const gr of groups) {
    const p = d.byPath.get(gr.projectPath);
    const badges = [];
    if (gr.goal && gr.goal.fields.from) badges.push(`<span class="pt-badge">carried from ${esc(linkLabel(gr.goal.fields.from))}</span>`);
    if (gr.goal && gr.goal.fields.miss) badges.push(`<span class="pt-badge pt-badge-miss">${esc(reasonLabel(gr.goal.fields.miss))}</span>`);
    if (!gr.goal) badges.push(`<span class="pt-badge">no goal</span>`);
    h += `<div class="pt-card pt-wgroup${gr.score >= 100 && gr.counted ? " is-done" : ""}">
      <div class="pt-goal-head">${p ? link(p.path, gr.name, "pt-proj") : `<span class="pt-proj">${esc(gr.name)}</span>`}<span class="pt-goal-text">${gr.goal ? esc(gr.goal.text) : ""}</span>${badges.join("")}</div>
      <div class="pt-goal-bar">${bar(gr.score)}<span class="pt-goal-num">${gr.score}%</span><span class="pt-goal-tasks">${gr.done}/${gr.counted} tasks</span>${timeBadge(tSum(d, [w.id], gr.projectPath))}</div>`;
    const items = gr.here.filter((t) => t.status !== "-").map((t) => Object.assign(toTaskItem(d, t), { project: p, group: gr.name, isDone: isDone(t) }));
    const open = items.filter((t) => !t.isDone).sort((a, b) => (!!b.due - !!a.due) || String(a.due || "").localeCompare(String(b.due || "")) || String(a.scheduled || "9").localeCompare(String(b.scheduled || "9")) || PRIO_RANK[a.prio] - PRIO_RANK[b.prio]);
    const done = items.filter((t) => t.isDone);
    h += open.map((t) => taskRow(d, t, { showProject: false, keep: true })).join("");
    if (done.length) h += `<details class="pt-anytime"><summary class="pt-sub">Done <span class="pt-count">${done.length}</span></summary>${done.map((t) => taskRow(d, t, { showProject: false, done: true })).join("")}</details>`;
    if (gr.cancelled.length) h += `<details class="pt-anytime pt-cancelled"><summary class="pt-sub">Cancelled <span class="pt-count">${gr.cancelled.length}</span> <span class="pt-muted">· not counted</span></summary><ul class="pt-list">${gr.cancelled.map((t) => { const it = toTaskItem(d, t), why = parseFields(String(t.body || t.raw || "")).reason; return `<li><s>${esc(it.desc)}</s>${why ? ` <span class="pt-muted">— ${esc(why)}</span>` : ""}</li>`; }).join("")}</ul></details>`;
    if (gr.carried.length) h += `<div class="pt-muted pt-hint">${gr.carried.length} task(s) moved on to a later week or the backlog</div>`;
    if (!items.length && !gr.carried.length && !gr.cancelled.length) h += `<div class="pt-empty">No tasks picked — use <b>Plan a project</b>.</div>`;
    h += `</div>`;
  }
  return h;
}

/* ------------------------------------------------------------------ add a task from the project page
 * "＋ Add task" on a project page: one task per line, with a ➕ created date (and the task_tag), an optional 📅 deadline,
 * into ## Backlog — or ## Planned for this week. */
const cleanText = (s) => String(s || "").replace(/\s+/g, " ").trim();
async function addProjectTask(env, path, text, { due = "", week = false } = {}) {
  const { app } = env, cfg = getConfig(app);
  const p = listProjects(app, cfg).find((x) => x.path === path);
  if (!p) throw new Error("not a tracked project");
  const descs = String(text || "").split(/\r?\n/).map((l) => cleanText(l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s*)?/, ""))).filter(Boolean);
  if (!descs.length) throw new Error("type the task first");
  due = cleanText(due);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("the deadline must be a date like 2026-12-31");
  const today = env.moment().format("YYYY-MM-DD"), wid = weekId(env.moment());
  const lines = descs.map((d) => {
    let l = newTask(cfg, `- [ ] ${d}`, today);
    if (week) l = setField(l, "week", wid);
    return due ? setDate(l, "due", due) : l;
  });
  await addToSection(app, path, week ? PLANNED_SEC : "Backlog", lines);
  const what = descs.length === 1 ? `“${descs[0]}”` : `${descs.length} tasks`;
  return `Added ${what} to ${week ? `this week (${wid})` : "the backlog"}${due ? ` · 📅 ${due}` : ""}`;
}

/* ------------------------------------------------------------------ objectives & key results (OKR)
 * In the project note, under ## Objectives (plain bullets, not tasks, so they never show up as to-dos):
 *   - 🎯 Sail confidently single-handed [by:: 2027-06-30]
 *   	- Solo outings [start:: 0] [now:: 3] [target:: 10]
 * A key result's progress = (now − start) ÷ (target − start), so "lower is better" works too (start 90, target 80).
 * An objective's progress is the average of its key results. The local model can check them against the OKR rules. */
const OKR_SEC = "Objectives";
function okrNum(v) {
  const s = String(v ?? "").replace(/\s/g, "").replace(",", ".");
  if (!/\d/.test(s)) return null;
  const n = Number(s.replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function krOf(k) {
  const start = okrNum(k.fields.start), now = okrNum(k.fields.now), target = okrNum(k.fields.target);
  const s0 = start ?? 0;
  const progress = target !== null && target !== s0 ? clamp(Math.round((100 * ((now ?? s0) - s0)) / (target - s0)), 0, 100) : null;
  return { line: k.line, raw: k.raw, text: k.desc, start, now, target, progress };
}
/** Objectives of a project note: [{raw, text, by, krs:[{raw, text, start, now, target, progress}], progress}]. */
function parseOkr(lines) {
  const s = findSection(lines || [], OKR_SEC);
  if (!s) return [];
  return parseItems(lines, s.start, s.end).filter((i) => !i.parent && !i.task && i.desc).map((o) => {
    const krs = o.children.filter((c) => !c.task && c.desc).map(krOf);
    const ps = krs.map((k) => k.progress).filter((v) => v !== null);
    return { line: o.line, raw: o.raw, text: o.desc, by: o.fields.by || null, krs, progress: ps.length ? Math.round(mean(ps)) : null };
  });
}
/** A bullet with new text and fields; other fields on the old line are kept ("" removes a field). */
function okrLine(ws, text, fields, objective, old = "") {
  let l = `${ws}- ${objective ? "🎯 " : ""}${cleanText(text)}`;
  const all = Object.assign({}, old ? parseFields(old) : {}, fields);
  for (const [k, v] of Object.entries(all)) if (v !== null && v !== undefined && String(v).trim() !== "") l = setField(l, k, String(v).trim());
  return l;
}
function okrFields(a, objective) {
  if (objective) {
    const by = cleanText(a.by);
    if (by && !/^\d{4}-\d{2}-\d{2}$/.test(by)) throw new Error("the date must look like 2027-06-30");
    return { by };
  }
  const f = {};
  for (const k of ["start", "now", "target"]) {
    const v = cleanText(a[k]);
    if (v && okrNum(v) === null) throw new Error(`${k} must be a number`);
    f[k] = v;
  }
  return f;
}
/** Add lines to ## Objectives; a missing section is created above the task sections. */
function insertOkrLines(ls, newLines) {
  if (!findSection(ls, OKR_SEC)) {
    const at = [PLANNED_SEC, UNPLANNED_SEC, "Backlog"].map((n) => findSection(ls, n)).filter(Boolean).sort((a, b) => a.head - b.head)[0];
    if (at) { ls.splice(at.head, 0, ...(at.head > 0 && ls[at.head - 1].trim() !== "" ? [""] : []), `## ${OKR_SEC}`, ...newLines, ""); return; }
  }
  insertIntoSection(ls, OKR_SEC, newLines);
}
/** The item on `raw` inside ## Objectives, or null when the line changed. */
function okrFind(ls, raw) {
  const s = findSection(ls, OKR_SEC);
  if (!s || !raw) return null;
  return parseItems(ls, s.start, s.end).find((i) => i.raw === raw) || null;
}
function okrHash(okr) {
  const str = okr.map((o) => [o.raw, ...o.krs.map((k) => k.raw)].join("\n")).join("\u0001");
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function okrIds(okr) {
  const ids = [];
  okr.forEach((o, i) => { ids.push({ id: `O${i + 1}`, raw: o.raw, text: o.text, objective: true }); o.krs.forEach((k, j) => ids.push({ id: `K${i + 1}.${j + 1}`, raw: k.raw, text: k.text, objective: false, oRaw: o.raw })); });
  return ids;
}
function okrMessages(p, okr, today) {
  const num = (k) => (k.target === null ? "no numbers set" : `start ${k.start ?? 0}, now ${k.now ?? "not set"}, target ${k.target}`);
  const system = "You coach people on OKRs (objectives and key results) in a personal planning system and check that they are set up well. You answer with one JSON object and nothing else.";
  const user = `Project: ${p.name}${p.description ? ` — ${p.description}` : ""}
Today: ${today}

${okr.map((o, i) => `O${i + 1}: ${o.text} (${o.by ? `by ${o.by}` : "no date"})\n${o.krs.length ? o.krs.map((k, j) => `  K${i + 1}.${j + 1}: ${k.text} — ${num(k)}`).join("\n") : "  (no key results)"}`).join("\n")}

The rules:
- An objective says where you want to be: qualitative and motivating, one short sentence, within your own control, with a time frame (a date or a period). It is not a task and not a number.
- Each objective has 2 to 5 key results.
- A key result is measurable: a number with a start, a current value and a target. It is an outcome, not an activity or a task to tick off ("Reach 500 readers a month" rather than "Write blog posts"). Specific, ambitious but realistic by the objective's date. Together the key results show the objective is reached; no two measure the same thing.

Answer:
- "verdict": "good", "needs work" or "poor", for all of it.
- "summary": one or two sentences: what is good and the most important fix.
- "items": only the objectives and key results that break a rule. Each: "id", "problems" (short sentences: which rule and why), "rewrite" (a better wording that keeps the meaning, the names and the language; "" when the wording is fine and only a number or date is missing).
- "add": key results that are missing — for an objective with fewer than 2, or whose key results clearly don't show it is reached. Each: "objective" (its id), "text", "target" (a number, or null), "why" (a few words). [] if none.

Answer with JSON like {"verdict":"needs work","summary":"…","items":[{"id":"K1.2","problems":["An activity, not an outcome"],"rewrite":"Sail 3 days solo in a force 4"}],"add":[{"objective":"O1","text":"Nights on board alone","target":5,"why":"shows independence"}]}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}
const OKR_SCHEMA = (ids, oids) => ({ type: "object", properties: {
  verdict: { type: "string", enum: ["good", "needs work", "poor"] },
  summary: { type: "string" },
  items: { type: "array", items: { type: "object", properties: { id: { type: "string", enum: ids }, problems: { type: "array", items: { type: "string" } }, rewrite: { type: "string" } }, required: ["id", "problems", "rewrite"], additionalProperties: false } },
  add: { type: "array", items: { type: "object", properties: { objective: { type: "string", enum: oids }, text: { type: "string" }, target: { type: ["number", "null"] }, why: { type: "string" } }, required: ["objective", "text", "target", "why"], additionalProperties: false } },
}, required: ["verdict", "summary", "items", "add"], additionalProperties: false });
function normalizeOkrCheck(out, okr) {
  const ids = okrIds(okr), byId = new Map(ids.map((x) => [x.id, x]));
  const verdict = ["good", "needs work", "poor"].includes(String(out && out.verdict)) ? out.verdict : "needs work";
  const items = [], seen = new Set();
  for (const it of Array.isArray(out && out.items) ? out.items : []) {
    const x = byId.get(String(it && it.id).trim());
    const problems = (Array.isArray(it && it.problems) ? it.problems : []).map(cleanText).filter(Boolean);
    if (!x || seen.has(x.id) || !problems.length) continue;
    seen.add(x.id);
    let rewrite = cleanText(it.rewrite).replace(/^🎯\s*/u, "");
    if (rewrite.toLowerCase() === x.text.toLowerCase()) rewrite = "";
    items.push({ id: x.id, raw: x.raw, text: x.text, objective: x.objective, problems, rewrite });
  }
  const add = [];
  for (const a of Array.isArray(out && out.add) ? out.add : []) {
    const o = byId.get(String(a && a.objective).trim()), text = cleanText(a && a.text);
    if (!o || !o.objective || !text) continue;
    add.push({ objective: o.id, oRaw: o.raw, oText: o.text, text, target: typeof (a && a.target) === "number" && Number.isFinite(a.target) ? a.target : null, why: cleanText(a.why) });
  }
  return { verdict, summary: cleanText(out && out.summary), items, add };
}
async function checkOkr(env, path) {
  const { app } = env, cfg = getConfig(app);
  const p = listProjects(app, cfg).find((x) => x.path === path);
  if (!p) throw new Error("not a tracked project");
  const okr = parseOkr((await readPath(app, path)).split("\n"));
  if (!okr.length) throw new Error("add an objective first");
  const ids = okrIds(okr);
  const out = extractJson(await llmChat(env, cfg, okrMessages(p, okr, env.moment().format("YYYY-MM-DD")), OKR_SCHEMA(ids.map((x) => x.id), ids.filter((x) => x.objective).map((x) => x.id))));
  return Object.assign(normalizeOkrCheck(out, okr), { hash: okrHash(okr), created: env.moment().format("YYYY-MM-DD HH:mm") });
}
/** Buttons on the OKR card. a = {raw, text, by, start, now, target}. Returns a message. */
async function okrAction(env, act, path, a = {}, i) {
  const { app } = env;
  const key = `okr:${path}`;
  let msg = "", ok = false;
  const gone = () => new Error("that line changed in the note since — try again");
  if (act === "add-o") {
    const text = cleanText(a.text);
    if (!text) throw new Error("type the objective first");
    const line = okrLine("", text, okrFields(a, true), true);
    await editLines(app, path, (ls) => insertOkrLines(ls, [line]));
    return `Objective added: ${text}`;
  }
  if (act === "edit-o" || act === "edit-kr") {
    const text = cleanText(a.text), objective = act === "edit-o", f = okrFields(a, objective);
    if (!text) throw new Error("the text can't be empty");
    await editLines(app, path, (ls) => { const it = okrFind(ls, a.raw); if (it) { ls[it.line] = okrLine(it.ws, text, f, objective, it.raw); ok = true; } });
    if (!ok) throw gone();
    return objective ? "Objective saved" : "Key result saved";
  }
  if (act === "add-kr") {
    const text = cleanText(a.text);
    if (!text) throw new Error("type the key result first");
    const f = okrFields(a, false);
    await editLines(app, path, (ls) => { const o = okrFind(ls, a.raw); if (o && !o.parent) { ls.splice(blockEnd(ls, o), 0, okrLine(o.ws + "\t", text, f, false)); ok = true; } });
    if (!ok) throw gone();
    return `Key result added: ${text}`;
  }
  if (act === "del-o" || act === "del-kr") {
    await editLines(app, path, (ls) => { const it = okrFind(ls, a.raw); if (it) { ls.splice(it.line, blockEnd(ls, it) - it.line); ok = true; } });
    if (!ok) throw gone();
    return act === "del-o" ? "Objective and its key results removed" : "Key result removed";
  }
  const store = await loadAnalysis(app);
  if (act === "check") {
    const job = startJob(env, "🧭 Checking objectives & key results", 1);
    job.step(1, (listProjects(app, getConfig(app)).find((x) => x.path === path) || {}).name || "");
    try { store[key] = await checkOkr(env, path); }
    catch (e) { if (e instanceof Stopped) return "Stopped — nothing changed."; throw e; }
    finally { job.end(); }
    await saveAnalysis(app, store);
    const r = store[key];
    return `🧭 OKRs: ${r.verdict}${r.items.length ? ` · ${r.items.length} to fix` : ""}${r.add.length ? ` · ${r.add.length} key result(s) suggested` : ""}`;
  }
  const r = store[key];
  if (!r) throw new Error("no check yet — check with the local model first");
  i = Number(i);
  if (act === "check-clear") delete store[key];
  else if (act === "check-apply" || act === "check-skip") {
    const it = r.items[i];
    if (!it) throw new Error("that suggestion is gone");
    if (act === "check-apply") {
      if (!it.rewrite) throw new Error("no new wording to apply — edit the numbers or the date instead");
      await editLines(app, path, (ls) => { const x = okrFind(ls, it.raw); if (x) { ls[x.line] = okrLine(x.ws, it.rewrite, {}, it.objective, x.raw); ok = true; } });
      if (!ok) throw gone();
      msg = `Reworded: ${it.rewrite}`;
    }
    r.items.splice(i, 1);
  } else if (act === "check-add" || act === "check-skip-add") {
    const s = r.add[i];
    if (!s) throw new Error("that suggestion is gone");
    if (act === "check-add") {
      await editLines(app, path, (ls) => { const o = okrFind(ls, s.oRaw); if (o) { ls.splice(blockEnd(ls, o), 0, okrLine(o.ws + "\t", s.text, s.target !== null ? { start: "0", now: "0", target: String(s.target) } : {}, false)); ok = true; } });
      if (!ok) throw gone();
      msg = `Key result added: ${s.text}${s.target === null ? " — set its numbers with ✎" : ""}`;
    }
    r.add.splice(i, 1);
  } else throw new Error(`unknown action ${act}`);
  if (store[key] && !r.items.length && !r.add.length && act !== "check-clear") r.done = true;
  await saveAnalysis(app, store);
  return msg;
}
function okrCard(d, p, lines) {
  const okr = parseOkr(lines);
  const r = (d.aiStore || {})[`okr:${p.path}`];
  const attrs = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("");
  const btn = (act, label, data = {}, cta = false, title = "", dis = false) => `<button class="pt-mini${cta ? " mod-cta" : ""}" data-okr="${act}" data-path="${esc(p.path)}"${attrs(data)}${title ? ` title="${esc(title)}"` : ""}${dis ? " disabled" : ""}>${label}</button>`;
  const fmtN = (v) => (v === null ? "–" : String(v));
  let h = `<div class="pt-card pt-okr"><div class="pt-card-head"><span class="pt-h">🧭 Objectives & key results</span><span class="pt-muted">kept under “## ${OKR_SEC}” below</span>${btn("add-o", "＋ Objective", { text: okr.length ? "" : p.objective }, !okr.length, "Add an objective")}${okr.length ? btn("check", r ? "↻ Check again" : "🧭 Check with the local model", {}, !r, "The local model checks the objectives and key results against the OKR rules") : ""}</div>`;
  if (!okr.length) return h + `<div class="pt-muted pt-hint">An objective is where you want to be — qualitative, with a date. Each has 2–5 key results: numbers that show you got there (start → now → target).${p.objective ? ` The objective in this project's properties is offered as a start.` : ""}</div></div>`;
  okr.forEach((o) => {
    h += `<div class="pt-okr-o"><div class="pt-okr-row"><span class="pt-okr-text"><b>🎯 ${esc(o.text)}</b>${o.by ? ` <span class="pt-muted">· by ${esc(getMoment()(o.by, "YYYY-MM-DD").format("D MMM YYYY"))}</span>` : ""}</span>`
      + `<span class="pt-okr-prog">${o.progress === null ? `<span class="pt-muted">no numbers yet</span>` : `${bar(o.progress)}<span class="pt-num">${o.progress}%</span>`}</span>`
      + `<span class="pt-ai-btns">${btn("add-kr", "＋ KR", { raw: o.raw }, false, "Add a key result")}${btn("edit-o", "✎", { raw: o.raw, text: o.text, by: o.by || "" }, false, "Edit")}${btn("del-o", "✕", { raw: o.raw, text: o.text }, false, "Remove this objective and its key results")}</span></div>`;
    if (!o.krs.length) h += `<div class="pt-muted pt-hint pt-okr-kr">No key results yet — add 2 to 5 numbers that show this objective is reached.</div>`;
    h += o.krs.map((k) => `<div class="pt-okr-row pt-okr-kr"><span class="pt-okr-text">${esc(k.text)}</span>`
      + `<span class="pt-okr-prog">${k.target === null ? `<span class="pt-warn">no target</span>` : `${bar(k.progress)}<span class="pt-num" title="start ${fmtN(k.start ?? 0)}">${fmtN(k.now ?? k.start ?? 0)} / ${fmtN(k.target)}</span>`}</span>`
      + `<span class="pt-ai-btns">${btn("edit-kr", "✎", { raw: k.raw, text: k.text, start: k.start ?? "", now: k.now ?? "", target: k.target ?? "" }, false, "Update the current value, or edit")}${btn("del-kr", "✕", { raw: k.raw, text: k.text }, false, "Remove this key result")}</span></div>`).join("");
    h += `</div>`;
  });
  if (r) {
    const stale = r.hash !== okrHash(okr), here = new Set(lines || []);
    h += `<div class="pt-okr-check"><div class="pt-sub">Check <span class="pt-q pt-q-${r.verdict === "good" ? "good" : r.verdict === "poor" ? "weak" : "fair"}">${esc(r.verdict)}</span> <span class="pt-muted">${esc(r.created)}${stale ? " · the objectives changed since" : ""}</span></div>`;
    if (r.summary) h += `<div class="pt-ai-summary">${esc(r.summary)}</div>`;
    h += r.items.map((it, i) => {
      const gone = !here.has(it.raw);
      let diff = "";
      if (it.rewrite) { const [o, nw] = wordDiff(it.text, it.rewrite); diff = `<div class="pt-diff-old">− ${o}</div><div class="pt-diff-new">+ ${nw}</div>`; }
      return `<div class="pt-ai-row${gone ? " is-stale" : ""}"><div class="pt-diff"><div class="pt-diff-kind">${it.objective ? "Objective" : "Key result"} <span class="pt-muted">· ${esc(it.text)}</span></div><ul class="pt-list">${it.problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${diff}${gone ? `<div class="pt-warn">changed since — skip or check again</div>` : ""}</div>`
        + `<div class="pt-ai-btns">${it.rewrite ? btn("check-apply", "✔ Apply", { i }, true, "Use the new wording (numbers and dates stay)", gone) : ""}${btn("check-skip", it.rewrite ? "Skip" : "OK", { i }, false, "Dismiss")}</div></div>`;
    }).join("");
    if (r.add.length) h += `<div class="pt-sub">Key results to add <span class="pt-count">${r.add.length}</span></div>` + r.add.map((s, i) => `<div class="pt-ai-row"><div><b>＋ ${esc(s.text)}</b>${s.target !== null ? ` <span class="pt-muted">→ ${esc(s.target)}</span>` : ""}<div class="pt-muted">for: ${esc(s.oText)}${s.why ? ` · ${esc(s.why)}` : ""}</div></div><div class="pt-ai-btns">${btn("check-add", "Add", { i }, true, "Add as a key result (start 0, now 0)", !here.has(s.oRaw))}${btn("check-skip-add", "✕", { i }, false, "Dismiss")}</div></div>`).join("");
    if (!r.items.length && !r.add.length) h += `<div class="pt-muted">${r.verdict === "good" && !r.done ? "Nothing to fix." : "All suggestions handled."} ${btn("check-clear", "OK")}</div>`;
    h += `</div>`;
  }
  return h + `</div>`;
}

function renderProject(d, path) {
  const p = d.byPath.get(path);
  if (!p) return `<div class="pt pt-empty">Not a tracked project — add <code>type: project</code> to the frontmatter (or run <b>Register projects</b>).</div>`;
  const ids = timeline(d, 16);
  if (p.routine) {
    const mine = d.routines.filter((r) => r.project === p);
    let h = `<div class="pt">${link(ACTIVE_PATH, "All active projects", "pt-nav-up")}`;
    if (p.status !== "active") h += `<div class="pt-empty">Paused (status: ${esc(p.status)}) — missed occurrences aren't recorded and the routines are hidden on Home.</div>`;
    if (!mine.length) return h + `<div class="pt-empty">No routines yet. Add recurring tasks here, e.g. <code>- [ ] Stretch 🔁 every day ⏳ ${d.today.format("YYYY-MM-DD")}</code>.</div></div>`;
    const nxt = mine.filter((r) => r.next).map((r) => `<li>${esc(r.name)} <span class="pt-muted">· next ${r.next === d.today.format("YYYY-MM-DD") ? "today" : getMoment()(r.next, "YYYY-MM-DD").format("ddd D MMM")} · 🔁 ${esc(r.rule)}</span></li>`);
    if (nxt.length) h += `<div class="pt-card"><div class="pt-h">Coming up</div><ul class="pt-list">${nxt.join("")}</ul></div>`;
    return h + routineAnalytics(d, ids, mine, `${p.name} · last ${ids.length} weeks`) + `</div>`;
  }
  let h = `<div class="pt">${projectNav(d, p)}`;
  if (p.objective) h += `<div class="pt-objective">🎯 ${esc(p.objective)}</div>`;
  h += `<div class="pt-kpis">${kpi("Status", esc(p.status))}${kpi("Weeks in focus", p.focusWeeks)}${kpi("Avg goal score", p.avg === null ? "–" : `${p.avg}%`)}${kpi("Tasks done", p.tasksDone, (() => { const c = mixSum(d, ids, p.path).cancelled; return c ? `✖ ${c} cancelled in 16 wks` : ""; })())}${mixKpi("Unplanned · 16 wks", mixSum(d, ids, p.path))}${timeKpi("Time · 16 wks", tSum(d, ids, p.path))}${kpi("Backlog", p.backlog.length)}</div>`;
  h += `<div class="pt-h">Focus · last 16 weeks</div><div class="pt-strip">${ids.map((id) => {
    const hs = p.history.filter((x) => x.week === id);
    const v = hs.length ? Math.round(mean(hs.map((x) => x.score))) : null;
    if (v !== null && id > d.curId) return `<div class="pt-cell pt-heat-planned" title="${id}: planned">•</div>`;
    return `<div class="pt-cell pt-heat-${scoreCls(v)}" style="--s:${v ?? 0}" title="${id}: ${v === null ? "not in focus" : v + "%"}">${v === null ? "" : v}</div>`;
  }).join("")}</div><div class="pt-strip-axis"><span>${shortWeek(ids[0])}</span><span>${shortWeek(ids[ids.length - 1])}</span></div>`;
  const nextId = shiftWeek(d.curId, 1);
  const planned = [[d.curId, "This week"], [nextId, "Next week"]].map(([wid, label]) => {
    const b = d.sel.get(wid) && d.sel.get(wid).get(p.path);
    const here = b ? b.here.filter((t) => t.status !== "-") : [];
    const w = d.weekMap.get(wid);
    const goal = w ? w.goals.find((g) => g.projectPath === p.path) : null;
    return { wid, label, open: here.filter(isOpen).length, done: here.filter(isDone).length, moved: b ? b.carried.length : 0, goal, w, unpl: here.filter((t) => isUnplannedIn(t, wid)).length, cancelled: b ? b.here.filter(isCancelled).length : 0 };
  });
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Planned</span><span class="pt-muted">tasks are in the “${PLANNED_SEC}” and “${UNPLANNED_SEC}” sections below</span></div><div class="pt-plan">`;
  for (const x of planned) {
    const total = x.open + x.done + x.moved;
    h += `<div class="pt-plan-row"><span class="pt-plan-week">${x.w && !x.w.virtual ? link(x.w.path, `${x.label} · ${shortWeek(x.wid)}`) : `${x.label} · ${shortWeek(x.wid)}`}</span>
      <span class="pt-plan-goal">${x.goal ? `🎯 ${esc(x.goal.text)}` : `<span class="pt-muted">no goal</span>`}</span>
      <span class="pt-num">${total ? `${x.done}/${total} done${x.unpl ? ` <span class="pt-muted">· ${x.unpl} unplanned</span>` : ""}${x.moved ? ` <span class="pt-muted">· ${x.moved} moved on</span>` : ""}${x.cancelled ? ` <span class="pt-muted">· ${x.cancelled} cancelled</span>` : ""}` : x.cancelled ? `<span class="pt-muted">${x.cancelled} cancelled</span>` : `<span class="pt-muted">no tasks</span>`}</span></div>`;
  }
  const addBtn = `<button class="pt-btn mod-cta" data-addtask="1" data-path="${esc(p.path)}" title="Add a task to this project's backlog (with today's ➕ created date and an optional 📅 deadline)">＋ Add task</button>`;
  h += `</div>${buttons([["Pick tasks for this / next week", "Plan project", false], ["Add tasks this week (unplanned)", "Add tasks"]]).replace(`<div class="pt-actions">`, `<div class="pt-actions">${addBtn}`)}</div>`;
  h += okrCard(d, p, d.aiLines || []);
  h += analysisCard(d, p, (d.aiStore || {})[p.path], d.aiLines);
  h += refineCard(d, p, (d.aiStore || {})[`refine:${p.path}`], d.aiLines);
  const past = p.history.filter((x) => x.week < d.curId).slice(-8).reverse();
  if (past.length) {
    h += `<div class="pt-h">Recent goals</div><table class="pt-table"><thead><tr><th>Week</th><th>Goal</th><th>Score</th><th></th></tr></thead><tbody>`;
    for (const x of past) {
      const w = d.weekMap.get(x.week);
      h += `<tr><td>${link(w.path, x.week)}</td><td>${esc(x.goal.text)}</td><td class="pt-num"><span class="pt-dot pt-${scoreCls(x.score)}"></span>${x.score}%</td><td class="pt-muted">${x.goal.fields.miss ? esc(reasonLabel(x.goal.fields.miss)) : ""}</td></tr>`;
    }
    h += `</tbody></table>`;
  }
  if (!p.history.length) h += `<div class="pt-empty">Not picked for a week yet.</div>`;
  return h + `</div>`;
}

/** Estimates vs time spent: per week and per project, for tasks picked for a week. */
function timeAnalytics(d, ids) {
  const all = tSum(d, ids);
  if (!all.est && !all.active && !all.passive) return "";
  const pctCellT = (a) => { const v = tAcc(a); return `<td class="pt-num" title="${esc(timeTitle(a))}">${v === null ? `<span class="pt-muted">–</span>` : `<span class="pt-dot pt-${v <= 110 && v >= 80 ? "full" : v <= 130 && v >= 60 ? "mid" : "low"}"></span>${v}%`}</td>`; };
  const row = (label, a) => `<tr><td>${label}</td><td class="pt-num">${a.estN}/${a.tasks}</td><td class="pt-num">${a.est ? fmtDur(a.est) : "–"}</td><td class="pt-num">${a.active ? fmtDur(a.active) : "–"}</td><td class="pt-num">${a.passive ? fmtDur(a.passive) : "–"}</td>${pctCellT(a)}</tr>`;
  const head = (first) => `<thead><tr><th>${first}</th><th class="pt-num" title="tasks with an estimate / tasks picked">Estimated</th><th class="pt-num">≈ Estimate</th><th class="pt-num">⏱ Active</th><th class="pt-num">⌛ Passive</th><th class="pt-num" title="Hands-on time as % of the estimate, on done tasks that have both. 100% = spot on.">Actual / est.</th></tr></thead>`;
  let h = `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Time · estimates vs spent</span><span class="pt-muted">${tAcc(all) === null ? "log time on done tasks to see how good your estimates are" : `overall ${tAcc(all)}% of estimate on ${all.doneN} done task(s)`}</span></div>`;
  h += `<div class="pt-heat-wrap"><table class="pt-table">${head("Week")}<tbody>`;
  for (const id of [...ids].reverse()) { const a = tSum(d, [id]); if (a.tasks && (a.est || a.active || a.passive)) { const w = d.weekMap.get(id); h += row(w && !w.virtual ? link(w.path, id) : id, a); } }
  h += `</tbody></table></div>`;
  const ps = d.projects.filter((p) => !p.routine).map((p) => [p, tSum(d, ids, p.path)]).filter(([, a]) => a.est || a.active || a.passive).sort((a, b) => b[1].active - a[1].active || a[0].name.localeCompare(b[0].name));
  if (ps.length) h += `<div class="pt-heat-wrap"><table class="pt-table">${head("Project")}<tbody>${ps.map(([p, a]) => row(link(p.path, p.name), a)).join("")}</tbody></table></div>`;
  return h + `</div>`;
}

function renderAnalytics(d, opts = {}) {
  const n = opts.weeks || 12;
  const ids = timeline(d, n, { trim: true });
  let h = `<div class="pt">`;
  if (!d.weeks.some((w) => w.goals.length)) return h + `<div class="pt-empty">No weekly goals yet. Plan your first week and come back after the review.</div>${routineAnalytics(d, timeline(d, n))}</div>`;
  const lw = lastClosedWeek(d);
  if (lw) {
    const rate = Math.round((100 * lw.m.achieved) / lw.m.goals);
    h += `<div class="pt-h">Last week · ${link(lw.path, lw.id)}</div><div class="pt-kpis">`;
    h += kpi("Goals achieved", `${lw.m.achieved}<span class="pt-of">/${lw.m.goals} · ${rate}%</span>`, delta(rate, baseline(d, lw.id, "rate"), " pts"));
    h += kpi("Avg goal score", `${lw.m.avg}%`, delta(lw.m.avg, baseline(d, lw.id, "avg"), " pts"));
    h += kpi("Tasks done", `${lw.m.done}<span class="pt-of">/${lw.m.planned}</span>`, delta(lw.m.done, baseline(d, lw.id, "done")) + (lw.m.cancelled ? ` · ✖ ${lw.m.cancelled} cancelled` : ""));
    h += kpi("Carried in", lw.m.carriedIn, lw.m.carriedIn ? "goals rolled over" : "");
    if (opts.completions) h += kpi("Done outside goals", opts.completions[lw.id] || 0, "✅ elsewhere in the vault");
    h += mixKpi("Unplanned tasks", mixSum(d, [lw.id]));
    h += timeKpi("Time", tSum(d, [lw.id]));
    h += `</div>`;
  }
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Average goal score per week</span><span class="pt-legend"><i class="pt-lg-bar"></i>week <i class="pt-lg-line"></i>4-week trend</span></div>${chartScores(d, ids)}</div>`;
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Tasks done vs planned</span><span class="pt-legend"><i class="pt-lg-done"></i>done <i class="pt-lg-planned"></i>planned</span></div>${chartTasks(d, ids)}</div>`;

  h += routineAnalytics(d, ids);
  h += timeAnalytics(d, ids);

  const rows = d.projects.filter((p) => !p.routine && (p.history.some((x) => ids.includes(x.week)) || p.status === "active"));
  rows.sort((a, b) => (b.focusWeeks - a.focusWeeks) || a.name.localeCompare(b.name));
  h += `<div class="pt-card"><div class="pt-h">Where your weeks went</div><div class="pt-heat-wrap"><table class="pt-heat"><thead><tr><th></th>${ids.map((id) => `<th class="${id === d.curId ? "pt-axis-cur" : ""}">${shortWeek(id)}</th>`).join("")}</tr></thead><tbody>`;
  for (const p of rows) {
    h += `<tr><th>${link(p.path, p.name)}</th>${ids.map((id) => {
      const hs = p.history.filter((x) => x.week === id);
      const v = hs.length ? Math.round(mean(hs.map((x) => x.score))) : null;
      if (v !== null && id > d.curId) return `<td><div class="pt-cell pt-heat-planned" title="${p.name} · ${id}: planned">•</div></td>`;
      return `<td><div class="pt-cell pt-heat-${scoreCls(v)}" style="--s:${v ?? 0}" title="${p.name} · ${id}: ${v === null ? "not in focus" : v + "%"}">${v === null ? "" : v}</div></td>`;
    }).join("")}</tr>`;
  }
  h += `</tbody></table></div></div>`;

  h += `<div class="pt-card"><div class="pt-h">Projects</div><table class="pt-table"><thead><tr><th>Project</th><th class="pt-num">Focus wks</th><th class="pt-num">Avg</th><th class="pt-num">Last 4</th><th class="pt-num">Tasks done</th><th class="pt-num" title="Tasks picked for a week: planned / added during the week (Add tasks), last ${ids.length} weeks">Planned / unplanned</th><th class="pt-num" title="Tasks cancelled during the week, last ${ids.length} weeks — not counted as planned or done">Cancelled</th><th class="pt-num">Backlog</th><th>Last focus</th></tr></thead><tbody>`;
  for (const p of [...d.projects].filter((p) => !p.routine && (p.status === "active" || p.focusWeeks)).sort((a, b) => (b.focusWeeks - a.focusWeeks) || a.name.localeCompare(b.name))) {
    const trend = p.avg !== null && p.recentAvg !== null && p.focusWeeks > 4 ? (p.recentAvg - p.avg >= 5 ? ` <span class="pt-up">▲</span>` : p.avg - p.recentAvg >= 5 ? ` <span class="pt-down">▼</span>` : "") : "";
    const stale = p.status === "active" && isTopPrio(d.cfg, p) && !(p.weeksSince !== null && p.weeksSince <= 0);
    h += `<tr><td>${link(p.path, p.name)}${p.status !== "active" ? ` <span class="pt-muted">${esc(p.status)}</span>` : ""}</td><td class="pt-num">${p.focusWeeks}</td><td class="pt-num">${p.avg === null ? "–" : p.avg + "%"}</td><td class="pt-num">${p.recentAvg === null ? "–" : p.recentAvg + "%"}${trend}</td><td class="pt-num">${p.tasksDone}</td>${mixCell(mixSum(d, ids, p.path))}<td class="pt-num">${mixSum(d, ids, p.path).cancelled || `<span class="pt-muted">–</span>`}</td><td class="pt-num">${p.backlog.length}</td><td class="${stale ? "pt-warn" : ""}">${p.lastFocus ? (p.weeksSince <= 0 ? "this week" : `${p.weeksSince}w ago`) : "never"}</td></tr>`;
  }
  h += `</tbody></table></div>`;

  const reasons = Object.entries(d.reasons).sort((a, b) => b[1] - a[1]);
  h += `<div class="pt-grid2"><div class="pt-card"><div class="pt-h">Why goals fell short</div>`;
  if (reasons.length) {
    const max = reasons[0][1];
    h += reasons.map(([k, v]) => `<div class="pt-hbar"><span class="pt-hbar-label">${esc(reasonLabel(k))}</span><div class="pt-hbar-track"><div class="pt-hbar-fill" style="width:${(100 * v) / max}%"></div></div><span class="pt-num">${v}</span></div>`).join("");
  } else h += `<div class="pt-muted">No reasons recorded yet — they come from the weekly review.</div>`;
  h += `</div><div class="pt-card"><div class="pt-h">Top priority (P1–P${d.cfg.focus_priority}) not in this week's plan</div>`;
  const ng = neglected(d);
  h += ng.length ? `<ul class="pt-list">${ng.map((p) => `<li>${link(p.path, p.name)} <span class="pt-muted">P${p.priority}${p.lastFocus ? ` · last focus ${p.weeksSince}w ago` : " · not started"}</span></li>`).join("")}</ul><div class="pt-muted pt-hint">Your top projects come first — or lower their priority so the list stays honest. Lower priorities aren't flagged: it's fine to leave them alone until the top ones are done.</div>` : `<div class="pt-muted">None.</div>`;
  h += `</div></div>`;

  const reviewed = d.weeks.filter((w) => w.review && (w.review.energy || w.review.summary || w.review.wins)).slice(-6).reverse();
  if (reviewed.length) {
    h += `<div class="pt-card"><div class="pt-h">Review notes</div><table class="pt-table"><thead><tr><th>Week</th><th class="pt-num">Energy</th><th>Notes</th></tr></thead><tbody>`;
    for (const w of reviewed) h += `<tr><td>${link(w.path, w.id)}</td><td class="pt-num">${esc(w.review.energy || "–")}</td><td>${w.review.summary ? `<div>${esc(w.review.summary)}</div>` : ""}${w.review.wins ? `<div class="pt-muted">Wins: ${esc(w.review.wins)}</div>` : ""}${w.review.lessons ? `<div class="pt-muted">Lessons: ${esc(w.review.lessons)}</div>` : ""}</td></tr>`;
    h += `</tbody></table></div>`;
  }
  return h + `</div>`;
}

const PROJECTS_PATH = `${TRACKER_ROOT}/Projects.md`;
/** Description + its rating, the model's suggestion, and a generated proposal, with buttons (handled in view.js). */
function descCell(p, st) {
  const btn = (act, label, title, cta = false) => `<button class="pt-mini${cta ? " mod-cta" : ""}" data-desc="${act}" data-path="${esc(p.path)}" title="${esc(title)}">${label}</button>`;
  const write = btn("generate", "✨ Write", "Write a description with the local model from what's in the project's folder", !p.description);
  let h = p.description ? `<div class="pt-muted pt-desc">${esc(p.description)}</div>` : `<div class="pt-muted pt-desc pt-warn">no description — the inbox model needs one</div>`;
  const fresh = st && st.verdict && st.hash === descHash(p);
  let badge = "";
  if (fresh && st.verdict !== "missing") badge = `<span class="pt-q pt-q-${st.verdict}" title="checked ${esc(st.checked)}">${st.verdict === "good" ? "✓" : st.verdict === "fair" ? "~" : "!"} ${st.score}</span>`;
  else if (st && st.verdict && p.description) badge = `<span class="pt-q pt-q-unchecked" title="the description changed since it was checked">changed</span>`;
  h += `<div class="pt-desc-tools">${badge}${p.description ? btn("check", fresh ? "Re-check" : "Check", "Rate this description with the local model") : ""}${write}</div>`;
  if (fresh && (st.issues.length || st.suggestion) && st.verdict !== "good" && st.verdict !== "missing") {
    h += `<details class="pt-desc-more"><summary>${st.issues.length ? esc(st.issues[0]) : "Suggestion"}${st.issues.length > 1 ? ` <span class="pt-muted">+${st.issues.length - 1}</span>` : ""}</summary>`;
    if (st.issues.length > 1) h += `<ul class="pt-list">${st.issues.slice(1).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    if (st.suggestion) h += `<div class="pt-proposal"><div>💡 ${esc(st.suggestion)}</div>${btn("use-suggestion", "Use this", "Save as the project's description")}</div>`;
    h += `</details>`;
  }
  if (st && st.proposal) {
    const pr = st.proposal;
    h += `<div class="pt-proposal"><div>✨ ${esc(pr.description)}</div>${pr.keywords && pr.keywords.length ? `<div class="pt-muted">keywords: ${esc(pr.keywords.join(", "))}${p.keywords.length ? " (yours are kept)" : ""}</div>` : ""}<div>${btn("use-proposal", "Use it", "Save as the project's description", true)}${btn("dismiss", "Dismiss", "Throw this proposal away")}${btn("generate", "↻ Again", "Write another one")}</div></div>`;
  }
  return h;
}
const STATUSES = ["active", "backlog", "done"];
function selectHtml(path, key, value, options, labels = {}) {
  const opts = options.includes(value) ? options : [value, ...options];
  return `<select class="dropdown pt-select pt-select-${key}" data-path="${esc(path)}" data-key="${esc(key)}" aria-label="${esc(key)}">${opts.map((o) => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(labels[o] || o)}</option>`).join("")}</select>`;
}
const ACTIVE_PATH = `${TRACKER_ROOT}/Active projects.md`;
/** Active (non-routine) projects in priority order — the order of Active projects and of ← / → on project pages. */
function activeOrder(d) { return d.projects.filter((p) => p.status === "active" && !p.routine).sort((a, b) => projPrioRank(a) - projPrioRank(b) || a.name.localeCompare(b.name)); }
/** ← previous · Active projects · next → at the top of a project page. */
function projectNav(d, p) {
  const list = activeOrder(d), i = list.indexOf(p);
  if (i < 0) return `<div class="pt-nav">${link(ACTIVE_PATH, "All active projects")}<span class="pt-muted"> · ${esc(p.status)} — not in the active list</span></div>`;
  const prev = list[(i - 1 + list.length) % list.length], next = list[(i + 1) % list.length];
  return `<div class="pt-nav">${list.length > 1 ? link(prev.path, `← ${prev.name}`, "pt-nav-prev") : "<span></span>"}<span>${link(ACTIVE_PATH, `Active projects · ${i + 1}/${list.length}`)} <span class="pt-muted">P${p.priority}</span></span>${list.length > 1 ? link(next.path, `${next.name} →`, "pt-nav-next") : "<span></span>"}</div>`;
}
/** Tracker/Active projects: every active project as a card, by priority, with a filter box. */
function renderActive(d) {
  const list = activeOrder(d);
  let h = `<div class="pt">`;
  if (!list.length) return h + `<div class="pt-empty">No active projects — set a project's status to active in ${link(PROJECTS_PATH, "Projects")}.</div></div>`;
  const cur = d.weekMap.get(d.curId);
  h += `<div class="pt-actions"><input type="search" class="pt-filter" placeholder="Filter ${list.length} active projects…" aria-label="Filter projects"><span class="pt-muted">by priority · ${link(PROJECTS_PATH, "change priority / status")}</span></div><div class="pt-proj-grid">`;
  for (const p of list) {
    const g = cur ? cur.goals.find((x) => x.projectPath === p.path) : null;
    const b = d.sel.get(d.curId) && d.sel.get(d.curId).get(p.path);
    const open = b ? b.here.filter(isOpen).map((t) => toTaskItem(d, t)).sort((x, y) => String(x.scheduled || x.due || "9").localeCompare(String(y.scheduled || y.due || "9"))) : [];
    const left = p.backlog.length + (p.openPlanned || 0);
    h += `<div class="pt-card pt-proj-card pt-prio-${p.priority}" data-name="${esc(`${p.name} ${p.scope} ${p.description} ${p.keywords.join(" ")}`.toLowerCase())}">
      <div class="pt-card-head">${link(p.path, p.name, "pt-proj")}<span class="pt-badge">P${p.priority}</span></div>
      ${p.description ? `<div class="pt-muted pt-desc">${esc(p.description)}</div>` : ""}
      ${p.okr && p.okr.length ? p.okr.map((o) => `<div class="pt-okr-mini"><span>🎯 ${esc(o.text)}</span>${o.progress === null ? "" : `${bar(o.progress)}<span class="pt-num">${o.progress}%</span>`}</div>`).join("") : p.objective ? `<div class="pt-objective">🎯 ${esc(p.objective)}</div>` : ""}
      ${g ? `<div class="pt-goal-text">This week: ${esc(g.text)}</div><div class="pt-goal-bar">${bar(g.score)}<span class="pt-goal-num">${g.score}%</span><span class="pt-goal-tasks">${g.doneCount}/${g.counted.length} tasks</span></div>` : `<div class="pt-muted">Not in this week's plan</div>`}
      ${open.length ? `<ul class="pt-list">${open.slice(0, 3).map((t) => `<li>${esc(t.desc)}${t.scheduled || t.due ? ` <span class="pt-muted">${t.due ? "📅" : "⏳"} ${getMoment()(t.due || t.scheduled, "YYYY-MM-DD").format("ddd D")}</span>` : ""}</li>`).join("")}${open.length > 3 ? `<li class="pt-muted">+${open.length - 3} more</li>` : ""}</ul>` : ""}
      <div class="pt-muted pt-proj-foot">${left} open task(s) · ${p.lastFocus ? (p.weeksSince <= 0 ? "in focus this week" : `last focus ${p.weeksSince}w ago`) : "not started"}${p.avg !== null ? ` · avg ${p.avg}%` : ""}</div>
    </div>`;
  }
  h += `</div>`;
  const areas = d.projects.filter((p) => p.routine && p.status === "active");
  if (areas.length) h += `<div class="pt-muted pt-hint">Routines: ${areas.map((p) => link(p.path, p.name)).join(" · ")}</div>`;
  const parked = d.projects.filter((p) => !p.routine && p.status === "backlog");
  if (parked.length) h += `<div class="pt-muted pt-hint">Backlog (not active): ${parked.sort((a, b) => projPrioRank(a) - projPrioRank(b)).map((p) => link(p.path, p.name)).join(" · ")}</div>`;
  return h + `</div>`;
}
/** Tracker/Projects: every project, with priority and status you can change right here. */
function renderProjects(d) {
  const store = d.descStore || {};
  let h = `<div class="pt">`;
  const work = d.projects.filter((p) => !p.routine);
  if (!work.length) return h + `<div class="pt-empty">No projects yet — run <b>Register projects</b>.</div></div>`;
  const cur = d.weekMap.get(d.curId), next = d.weekMap.get(shiftWeek(d.curId, 1));
  const inWeek = (w, p) => !!(w && (w.goals.some((g) => g.projectPath === p.path) || (w.extra || []).some((x) => x.projectPath === p.path)));
  const counts = PROJECT_PRIOS.map((k) => `P${k}: ${work.filter((p) => p.status === "active" && p.priority === k).length}`).join(" · ");
  h += `<div class="pt-summary">${work.filter((p) => p.status === "active").length} active (${counts}) · ${work.filter((p) => p.status === "backlog").length} backlog · Plan week lists projects by priority (1 = top), and within a priority the ones you're working on and closest to done first.</div>`;
  const live = work.filter(liveStatus), stOf = (p) => { const st = store[p.path]; return st && st.verdict && st.hash === descHash(p) ? st.verdict : p.description ? "unchecked" : "missing"; };
  const dc = (v) => live.filter((p) => stOf(p) === v).length;
  h += `<div class="pt-desc-bar"><span>Descriptions <span class="pt-muted">(the inbox model sorts notes by them)</span>: ${[["good", "✓ good"], ["fair", "could be better"], ["weak", "weak"], ["missing", "missing"], ["unchecked", "not checked"]].filter(([v]) => dc(v)).map(([v, l]) => `<span class="pt-q pt-q-${v}">${dc(v)} ${l}</span>`).join(" ")}</span>${dc("unchecked") + live.filter((p) => store[p.path] && store[p.path].verdict && store[p.path].hash !== descHash(p)).length ? `<button class="pt-mini mod-cta" data-desc="check-all">Check descriptions</button>` : `<button class="pt-mini" data-desc="recheck-all">Check all again</button>`}</div>`;
  const groups = [["Active", work.filter((p) => p.status === "active")], ["Backlog", work.filter((p) => p.status === "backlog")], ["Other", work.filter((p) => !["active", "backlog"].includes(p.status))]];
  const multiScope = new Set(work.map((p) => p.scope)).size > 1;
  for (const [title, ps] of groups) {
    if (!ps.length) continue;
    ps.sort((a, b) => projPrioRank(a) - projPrioRank(b) || (multiScope ? a.scope.localeCompare(b.scope) : 0) || a.name.localeCompare(b.name));
    h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">${title}</span><span class="pt-count">${ps.length}</span></div><div class="pt-heat-wrap"><table class="pt-table pt-projects"><thead><tr><th>Project</th>${multiScope ? "<th>Scope</th>" : ""}<th>Priority</th><th>Status</th><th>This / next week</th><th>Last focus</th><th class="pt-num">Avg</th><th class="pt-num">Backlog</th></tr></thead><tbody>`;
    for (const p of ps) {
      const wk = [inWeek(cur, p) ? "this" : "", inWeek(next, p) ? "next" : ""].filter(Boolean).join(" + ");
      h += `<tr class="pt-prio-${p.priority}"><td>${link(p.path, p.name)}${descCell(p, store[p.path])}</td>`
        + `${multiScope ? `<td class="pt-muted">${esc(p.scope)}</td>` : ""}<td>${selectHtml(p.path, "priority", p.priority, PROJECT_PRIOS, PRIO_LABEL)}</td><td>${selectHtml(p.path, "status", p.status, STATUSES)}</td>`
        + `<td>${wk ? `🎯 ${wk}` : `<span class="pt-muted">–</span>`}</td><td class="${p.status === "active" && isTopPrio(d.cfg, p) && !(p.weeksSince !== null && p.weeksSince <= 0) ? "pt-warn" : ""}">${p.lastFocus ? (p.weeksSince <= 0 ? "this week" : `${p.weeksSince}w ago`) : "never"}</td>`
        + `<td class="pt-num">${p.avg === null ? "–" : p.avg + "%"}</td><td class="pt-num">${p.backlog.length}</td></tr>`;
    }
    h += `</tbody></table></div></div>`;
  }
  const rps = d.projects.filter((p) => p.routine);
  if (rps.length) {
    h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">🔁 Routine projects</span><span class="pt-muted">always in focus · scored on their own</span></div><table class="pt-table"><thead><tr><th>Project</th><th>Status</th><th class="pt-num">Routines</th><th class="pt-num">4-wk avg</th></tr></thead><tbody>`;
    for (const p of rps) {
      const mine = d.routines.filter((r) => r.project === p);
      const v = [...new Set(mine.flatMap((r) => [...r.weeks.keys()]))].filter((w) => w < d.curId).sort().slice(-4)
        .map((w) => rPct(mine.reduce((a, r) => { const x = r.weeks.get(w); if (x) { a.done += x.done; a.missed += x.missed; } return a; }, R0()))).filter((x) => x !== null);
      h += `<tr><td>${link(p.path, p.name)}</td><td>${selectHtml(p.path, "status", p.status, ["active", "backlog"], { backlog: "paused" })}</td><td class="pt-num">${mine.length}</td><td class="pt-num">${v.length ? Math.round(mean(v)) + "%" : "–"}</td></tr>`;
    }
    h += `</tbody></table></div>`;
  }
  h += `<div class="pt-muted pt-hint">Priority and status are saved in each project's properties (<code>priority</code>, <code>status</code>).</div>`;
  return h + `</div>`;
}

async function render(app, mode, path, opts = {}) {
  if (mode === "classified") return renderClassified(app);
  const d = await loadAll(app);
  if (mode === "home") { d.cal = await gcalLoadState(app); d.calOn = !!d.cfg.calendar_client_id; return renderHome(d, opts); }
  if (mode === "week") return renderWeek(d, path, opts);
  if (mode === "project") { d.aiStore = await loadAnalysis(app); d.aiLines = ((await readPath(app, path)) || "").split("\n"); return renderProject(d, path); }
  if (mode === "analytics") return renderAnalytics(d, opts);
  if (mode === "active") return renderActive(d);
  if (mode === "projects") { d.descStore = await loadDescStore(app); return renderProjects(d); }
  return `<div class="pt-empty">Unknown mode: ${esc(mode)}</div>`;
}

/* ------------------------------------------------------------------ entry */

const COMMANDS = { capture: cmdCapture, process: cmdProcess, classify: cmdClassify, applyInbox: cmdApplyInbox, plan: cmdPlan, planProject: cmdPlanProject, addTasks: cmdAddTasks, logTime: cmdLogTime, cancelTask: cmdCancelTask, syncCalendar: cmdSyncCalendar, review: cmdReview, newProject: cmdNewProject, register: cmdRegister };

async function ptrack(tp, cmd, ...args) {
  const app = tp.app || window.app;
  const env = makeEnv(app, tp);
  return run(env, cmd, ...args);
}
async function run(env, cmd, ...args) {
  const fn = COMMANDS[cmd];
  if (!fn) { env.notice(`Tracker: unknown command “${cmd}”`); return ""; }
  try { await fn(env, ...args); }
  catch (e) {
    if (e instanceof Cancelled || e instanceof Handoff) return "";
    console.error("[tracker]", e);
    env.notice(`Tracker: ${e.message || e}`, 10000);
  }
  return "";
}

module.exports = ptrack;
module.exports.core = {
  CONFIG_PATH, VIEW_PATH, COMMANDS_FOLDER, DEFAULTS, MISS_REASONS,
  getConfig, loadAll, render, run, makeEnv, descAction, projectAction, addProjectTask, okrAction, parseOkr, okrMessages, normalizeOkrCheck, OKR_SEC, replaceDesc, moveGoal, loadDescStore, descHash, normalizeDescCheck, projectFolderText,
  wordDiff, normalizeRefine, backlogTasks, startJob, jobText, Stopped, feedStream, answerText, llmStats, statsText, batchMessages, cancelTask, cancelLine, isCancelled, syncCalendar, syncSummary, gcalConnected, gcalLoadState, setClock, parseClockRange, slotOf, fmtClock, pullSlot, GCAL_STATE, GCAL_TOKEN, parseDur, fmtDur, timeOf, setTimes, addTime, cleanRecurrence, tSum, Cancelled, Handoff, inboxFree, normalizeRecord, parseReview, inboxJobs, REVIEW_PATH, REVIEW_SNAP, INBOX_TEMPLATE, normPriority, PROJECT_PRIOS, rollRoutines, routinePathTest, nextOccurrence, ruleOf, freqOf, classifyTasks, toggleDoneLine, AI_REQ, AI_RES, SHORTCUT_SEP, splitMeta, getDate, setDate, prioOf, setPrio, newTask, isMoved,
  parseWeek, parseItems, parseFields, setField, setStatus, findSection, insertIntoSection, scoreGoal, inboxItems, backlogItems,
  normPriority, migratePriorities, weekId, weekStart, shiftWeek, weeksBetween, weekRange, weekNote, projectNote, itemMessages, notesMessages, extractJson, stripThink,
};
