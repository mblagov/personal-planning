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
  neglect_weeks: 3,
  plan_next_week_from: 5,
  llm_provider: "ollama",
  llm_url: "http://localhost:11434",
  llm_model: "qwen2.5:7b-instruct",
  llm_auto_file_confidence: 0.9,
  llm_examples_per_project: 3,
  llm_mobile: "off",            // iPhone: off | shortcut (Apple on-device model via Shortcuts) | url
  llm_shortcut: "Tracker Classify",
  llm_url_mobile: "",
  llm_provider_mobile: "",
  llm_model_mobile: "",
  plan_schedule_tasks: true,
  upcoming_days: 7,
  task_tag: "",
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

/* ------------------------------------------------------------------ config */

function getConfig(app) {
  const f = app.vault.getAbstractFileByPath(CONFIG_PATH);
  const fm = (f && app.metadataCache.getFileCache(f)?.frontmatter) || {};
  const cfg = Object.assign({}, DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) if (fm[k] !== undefined && fm[k] !== null && fm[k] !== "") cfg[k] = fm[k];
  cfg.project_roots = toArr(cfg.project_roots).map((r) => r.replace(/\/+$/, ""));
  cfg.weeks_folder = String(cfg.weeks_folder).replace(/\/+$/, "");
  for (const k of ["goals_min", "goals_max", "neglect_weeks", "plan_next_week_from", "upcoming_days", "llm_auto_file_confidence", "llm_examples_per_project"]) cfg[k] = Number(cfg[k]);
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
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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

async function loadAll(app) {
  const cfg = getConfig(app);
  const m = getMoment();
  const projects = listProjects(app, cfg);
  const byPath = new Map(projects.map((p) => [p.path, p]));
  for (const p of projects) {
    const lines = (await app.vault.cachedRead(p.file)).split("\n");
    p.backlog = backlogItems(lines).sort(byPrioDue);
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
    for (const it of parseItems(content.split("\n"))) {
      if (!it.task) continue;
      const wk = weekIds(it.fields.week)[0] || null;
      const from = weekIds(it.fields.from);
      if (!wk && !from.length) continue;
      const t = { path: f.path, line: it.line, raw: it.raw, body: it.body, text: it.body, status: it.status, fields: it.fields, desc: it.desc, week: wk, from, projectPath: p.path };
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
  const inbox = { path: cfg.inbox, open: 0, classified: 0 };
  const ib = app.vault.getAbstractFileByPath(cfg.inbox);
  if (ib) {
    const items = inboxItems((await app.vault.cachedRead(ib)).split("\n"));
    inbox.open = items.length;
    inbox.classified = items.filter((i) => i.fields.to).length;
  }
  return computeStats({ app, cfg, projects, byPath, weeks, sel, inbox, today: m(), curId: weekId(m()) });
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
    g.score = goalScore(g);
  }
  w.extra = [];
  if (m2) for (const [pp, b] of m2) {
    if (used.has(pp)) continue;
    w.extra.push({ projectPath: pp, projectName: byPath.get(pp)?.name || pp, here: b.here, carriedOut: b.carried,
      counted: [...b.here.filter((t) => t.status !== "-"), ...b.carried], doneCount: b.here.filter(isDone).length });
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
    };
  }
  d.weekMap = new Map(d.weeks.map((w) => [w.id, w]));
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
async function llmChat(env, cfg, messages, schema) {
  const prov = String((env.isMobile && cfg.llm_provider_mobile) || cfg.llm_provider).toLowerCase();
  const model = (env.isMobile && cfg.llm_model_mobile) || cfg.llm_model;
  const base = llmBase(env, cfg);
  const ollama = prov === "ollama";
  const url = ollama ? `${base}/api/chat` : base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const body = ollama
    ? { model, messages, stream: false, options: { temperature: 0 } }
    : { model, messages, temperature: 0 };
  if (schema) {
    if (ollama) body.format = schema;
    else body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema } };
  }
  const send = async () => {
    try { return await env.request({ url, method: "POST", contentType: "application/json", body: JSON.stringify(body) }); }
    catch (e) { throw new Error(`can't reach the local model at ${base} (${e.message || e}). ${env.isMobile ? "Is the model app running?" : `Is ${ollama ? "Ollama" : "the server"} running?`}`); }
  };
  let r = await send();
  if (r.status >= 400 && schema) { // older servers: fall back to plain JSON mode
    if (ollama) body.format = "json"; else delete body.response_format;
    r = await send();
  }
  if (r.status >= 400) throw new Error(`local model returned HTTP ${r.status}: ${String(r.text).slice(0, 200)}`);
  const data = JSON.parse(r.text);
  return stripThink(ollama ? data.message?.content : data.choices?.[0]?.message?.content);
}

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
function classifyMessages(catalog, item, today) {
  const cat = catalog.map((p) => {
    let s = `${p.id} — ${p.name} [${p.scope}${p.status !== "active" ? ", " + p.status : ""}]`;
    if (p.description) s += `: ${p.description}`;
    if (p.objective) s += ` Objective: ${p.objective}.`;
    if (p.keywords.length) s += ` Keywords: ${p.keywords.join(", ")}.`;
    if (p.examples.length) s += ` Examples: ${p.examples.map((e) => `"${e}"`).join("; ")}.`;
    return s;
  }).join("\n");
  const system = "You sort items from a person's inbox into their projects. You answer with a single JSON object and nothing else.";
  const user = `Today is ${today}.

Projects:
${cat}

Rules:
- "project": the id of the single best-fitting project, or "none" if no project clearly fits.
- "kind": "task" = a concrete action to do; "idea" = a possibility to think about later; "reference" = information or a link to keep.
- "priority": "high" = time-sensitive or blocking other work; "low" = nice to have; otherwise "medium".
- "confidence": 0 to 1, how sure you are about the project choice.

Item: "${item}"

Answer with JSON like {"project":"P1","kind":"task","priority":"medium","confidence":0.8}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}
async function classifyItem(env, cfg, catalog, text) {
  const ids = [...catalog.map((p) => p.id), "none"];
  const schema = {
    type: "object",
    properties: {
      project: { type: "string", enum: ids },
      kind: { type: "string", enum: ["task", "idea", "reference"] },
      priority: { type: "string", enum: ["high", "medium", "low"] },
      confidence: { type: "number" },
    },
    required: ["project", "kind", "priority", "confidence"],
    additionalProperties: false,
  };
  const out = extractJson(await llmChat(env, cfg, classifyMessages(catalog, text, env.moment().format("YYYY-MM-DD")), schema));
  return normalizeClassification(out, catalog);
}
function normalizeClassification(out, catalog) {
  const pid = String(out.project || "none").trim();
  const proj = catalog.find((p) => p.id === pid) || catalog.find((p) => p.name.toLowerCase() === pid.toLowerCase());
  const kind = ["task", "idea", "reference"].includes(out.kind) ? out.kind : "task";
  const prio = ["high", "medium", "low"].includes(out.priority) ? out.priority : "medium";
  let conf = Number(out.confidence);
  if (isNaN(conf)) conf = 0.5;
  if (conf > 1) conf = conf / 100;
  return { project: proj || null, kind, prio, conf: clamp(conf, 0, 1) };
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
      const r = await fetch(opts.url, { method: opts.method, headers: { "Content-Type": opts.contentType }, body: opts.body });
      return { status: r.status, text: await r.text() };
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

async function ensureInbox(app, cfg) {
  if (app.vault.getAbstractFileByPath(cfg.inbox)) return;
  await createFile(app, cfg.inbox, "---\ntype: inbox\n---\n# Inbox\n\nCapture anything as `- [ ] item`. Run **Process inbox** to classify and file it.\n\n## Queue\n");
}

async function cmdCapture(env) {
  const { app } = env, cfg = getConfig(app);
  const text = await env.prompt("Capture to inbox (one item per line)", "", true);
  if (!text || !text.trim()) return;
  await ensureInbox(app, cfg);
  const items = text.split(/\r?\n/).map((s) => s.trim().replace(/^[-*]\s+(\[.\]\s+)?/, "")).filter(Boolean);
  await editLines(app, cfg.inbox, (lines) => insertIntoSection(lines, "Queue", items.map((t) => `- [ ] ${t}`)));
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
async function startShortcut(env, cfg, todo, catalog) {
  const { app } = env;
  if (!(await aiExists(app, AI_DIR))) await app.vault.adapter.mkdir(AI_DIR);
  await aiRemove(app, AI_RES);
  const today = env.moment().format("YYYY-MM-DD");
  const prompts = todo.map((it) => {
    const [sys, user] = classifyMessages(catalog, it.desc, today);
    return `${sys.content}\n\n${user.content}\n\nReply with the JSON object only.`;
  });
  const projects = Object.fromEntries(catalog.map((p) => [p.id, p.path]));
  await app.vault.adapter.write(AI_REQ, JSON.stringify({ created: env.moment().format(), prompts, items: todo.map((t) => t.raw), projects }, null, 1));
  env.notice(`Sorting ${todo.length} item(s) with the on-device model in Shortcuts… When it brings you back, tap Process inbox again.`, 8000);
  env.openUrl(`shortcuts://run-shortcut?name=${encodeURIComponent(cfg.llm_shortcut)}`);
  throw new Handoff();
}
/** Apply answers saved by the shortcut. Returns {pending, applied}. */
async function applyShortcutResults(env, cfg) {
  const { app } = env;
  if (!(await aiExists(app, AI_REQ))) return { pending: false, applied: 0 };
  if (!(await aiExists(app, AI_RES))) return { pending: true, applied: 0 };
  const req = JSON.parse(await app.vault.adapter.read(AI_REQ));
  const answers = (await app.vault.adapter.read(AI_RES)).split(SHORTCUT_SEP);
  const all = listProjects(app, cfg);
  const catalog = Object.entries(req.projects || {}).map(([id, path]) => all.find((p) => p.path === path) && Object.assign({}, all.find((p) => p.path === path), { id })).filter(Boolean);
  const results = new Map();
  req.items.forEach((raw, i) => {
    let r;
    try { r = normalizeClassification(extractJson(stripThink(answers[i] || "")), catalog); }
    catch (e) { r = { project: null, kind: "task", prio: "medium", conf: 0 }; }
    results.set(raw, r);
  });
  const n = await writeClassifications(app, cfg, results);
  await aiRemove(app, AI_REQ); await aiRemove(app, AI_RES);
  return { pending: false, applied: n };
}

async function cmdClassify(env, { quiet = false } = {}) {
  const { app } = env, cfg = getConfig(app);
  await ensureInbox(app, cfg);
  const unclassified = async () => inboxItems((await readPath(app, cfg.inbox)).split("\n")).filter((i) => !i.fields.to);
  let todo = await unclassified();
  const viaShortcut = env.isMobile && String(cfg.llm_mobile).toLowerCase() === "shortcut";
  if (viaShortcut) {
    const st = await applyShortcutResults(env, cfg);
    if (st.applied) { if (!quiet) env.notice(`Applied ${st.applied} result(s) from the on-device model`); return st.applied; }
    if (st.pending) {
      const c = await ask(env, ["↻ Run the on-device model again", "Continue without AI"], ["run", "skip"], "No answers from the shortcut yet");
      if (c === "skip") { await aiRemove(app, AI_REQ); return 0; }
    }
    todo = await unclassified();
  }
  if (!todo.length) { if (!quiet) env.notice("Inbox: nothing new to classify"); return 0; }
  if (!viaShortcut) llmBase(env, cfg); // fail fast with a clear message when no model is configured for this device
  const catalog = await projectCatalog(app, cfg);
  if (!catalog.length) throw new Error("no projects found — run Register projects or New project first");
  if (viaShortcut) await startShortcut(env, cfg, todo, catalog);
  const results = new Map();
  let i = 0;
  for (const it of todo) {
    i++;
    env.notice(`Classifying ${i}/${todo.length}: ${it.desc.slice(0, 40)}`, 2500);
    const r = await classifyItem(env, cfg, catalog, it.desc);
    results.set(it.raw, r);
  }
  await writeClassifications(app, cfg, results);
  if (!quiet) env.notice(`Classified ${todo.length} inbox item(s)`);
  return todo.length;
}
async function writeClassifications(app, cfg, results) {
  let n = 0;
  await editLines(app, cfg.inbox, (ls) => {
    for (let k = 0; k < ls.length; k++) {
      const orig = ls[k];
      const r = results.get(orig);
      if (!r) continue;
      let line = orig;
      line = setField(line, "to", r.project ? linkTo(app, r.project.path, cfg.inbox, r.project.name) : "none");
      line = setField(line, "kind", r.kind);
      line = setField(line, "conf", r.conf.toFixed(2));
      if (r.kind === "task" && prioOf(line) === "normal" && r.prio !== "medium") line = setPrio(line, r.prio);
      ls[k] = line;
      results.delete(orig);
      n++;
    }
  });
  return n;
}

/** Normalise a task line for the Tasks plugin: open checkbox, optional global-filter tag, ➕ created date. */
function newTask(cfg, line, today) {
  let out = /^\s*[-*+]\s+\[.\]/.test(line) ? line.replace(/^\s+/, "") : `- [ ] ${line.replace(/^\s*[-*+]\s+/, "").trim()}`;
  const tag = String(cfg.task_tag || "").trim();
  if (tag && !out.includes(tag)) out = out.replace(/^(- \[.\] )/, `$1${tag} `);
  if (!getDate(out, "created")) out = setDate(out, "created", today);
  return out;
}

/** Move one inbox line (by exact text) to a project / week goal. */
async function fileItem(app, cfg, raw, dest) {
  let found = false;
  const it = parseItems([raw])[0];
  const clean = (line) => ["to", "kind", "conf", "prio"].reduce((l, k) => setField(l, k, null), line);
  const today = getMoment()().format("YYYY-MM-DD");
  let out = clean(it.raw.replace(/^[ \t]+/, ""));
  if (dest.kind === "task" || dest.planWeek) out = newTask(cfg, out, today);
  if (dest.planWeek) out = setField(out, "week", dest.planWeek);
  if (dest.kind !== "task" && !dest.planWeek) {
    const icon = dest.kind === "idea" ? "💡" : "📎";
    out = `- ${icon} ${it.desc} (${today})`;
  }
  const section = dest.planWeek ? PLANNED_SEC : dest.kind === "task" ? "Backlog" : "Notes & ideas";
  await editLines(app, dest.projectPath, (ls) => insertIntoProjectSection(ls, section, [out]));
  await editLines(app, cfg.inbox, (ls) => {
    const k = ls.indexOf(raw);
    if (k >= 0) { const item = parseItems(ls, k, k + 1)[0]; ls.splice(k, blockEnd(ls, item) - k); found = true; }
  });
  return found;
}
async function deleteInboxLine(app, cfg, raw) {
  await editLines(app, cfg.inbox, (ls) => { const k = ls.indexOf(raw); if (k >= 0) ls.splice(k, 1); });
}

async function cmdProcess(env) {
  const { app } = env, cfg = getConfig(app);
  try { await cmdClassify(env, { quiet: true }); }
  catch (e) { if (e instanceof Cancelled || e instanceof Handoff) throw e; env.notice(`Classifier unavailable (${e.message}) — continuing manually.`, 9000); }
  const projects = listProjects(app, cfg).filter((p) => !["done", "archived", "dropped"].includes(p.status));
  const items = inboxItems((await readPath(app, cfg.inbox)).split("\n"));
  if (!items.length) { env.notice("Inbox is empty 🎉"); return; }
  const curId = weekId(env.moment());
  const stats = { filed: 0, auto: 0, kept: 0, deleted: 0 };
  const label = (p) => `${p.name}${p.status !== "active" ? ` (${p.status})` : ""}`;
  for (const it of items) {
    const f = it.fields;
    const sugPath = f.to && f.to !== "none" ? resolveProject(app, f.to, cfg.inbox, projects) : null;
    const sug = projects.find((p) => p.path === sugPath);
    const kind = ["task", "idea", "reference"].includes(f.kind) ? f.kind : "task";
    const conf = parseFloat(f.conf);
    if (sug && !isNaN(conf) && conf >= cfg.llm_auto_file_confidence) {
      await fileItem(app, cfg, it.raw, { projectPath: sug.path, kind });
      stats.filed++; stats.auto++;
      continue;
    }
    const opts = [];
    const pr = prioOf(it.raw);
    if (sug) opts.push([`✓ ${sug.name} · ${kind}${pr !== "normal" ? " · " + pr : ""}${isNaN(conf) ? "" : ` · ${Math.round(conf * 100)}%`}`, { a: "file", p: sug, kind }]);
    if (sug && kind === "task") opts.push([`✓ ${sug.name} · as idea`, { a: "file", p: sug, kind: "idea" }]);
    if (sug && kind !== "task") opts.push([`✓ ${sug.name} · as task`, { a: "file", p: sug, kind: "task" }]);
    opts.push(["→ Another project…", { a: "other", kind }]);
    opts.push([sug ? `★ ${sug.name} · plan for this week (${shortWeek(curId)})` : `★ Plan for this week (${shortWeek(curId)})…`, { a: "plan", p: sug }]);
    opts.push(["⏸ Keep in inbox", { a: "keep" }], ["🗑 Delete", { a: "delete" }]);
    const choice = await ask(env, opts.map((o) => o[0]), opts.map((o) => o[1]), `“${it.desc}”`);
    if (choice.a === "file") { await fileItem(app, cfg, it.raw, { projectPath: choice.p.path, kind: choice.kind }); stats.filed++; }
    else if (choice.a === "other") {
      const p = await ask(env, projects.map(label), projects, `File “${it.desc}” to…`);
      const k = await ask(env, ["Task (backlog)", "Idea", "Reference"], ["task", "idea", "reference"], "As…");
      await fileItem(app, cfg, it.raw, { projectPath: p.path, kind: k });
      stats.filed++;
    } else if (choice.a === "plan") {
      const p = choice.p || await ask(env, projects.map(label), projects, `Plan “${it.desc}” for this week in…`);
      await fileItem(app, cfg, it.raw, { projectPath: p.path, kind: "task", planWeek: curId });
      stats.filed++;
    } else if (choice.a === "delete") { await deleteInboxLine(app, cfg, it.raw); stats.deleted++; }
    else stats.kept++;
  }
  env.notice(`Inbox: filed ${stats.filed}${stats.auto ? ` (${stats.auto} automatically)` : ""}, kept ${stats.kept}, deleted ${stats.deleted}`);
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
  env.notice(`Registered ${added} project(s); ${seen} already set up or ignored${upgraded ? `; added the “${PLANNED_SEC}” section to ${upgraded} existing project note(s)` : ""}. Add a one-line description to each — it makes the inbox classifier much better.`, 10000);
}
async function upgradeProjectNote(app, file) {
  const probe = (await app.vault.read(file)).split("\n");
  if (!(ensureProjectBlock(probe) | ensureProjectSections(probe))) return false; // already fine — don't touch the file
  await editLines(app, file.path, (ls) => { ensureProjectBlock(ls); ensureProjectSections(ls); });
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

/** Ask which day of the target week to do a task; sets the Tasks ⏳ scheduled date. */
async function askSchedule(env, cfg, target, line) {
  if (!cfg.plan_schedule_tasks) return line;
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
async function addPlanned(app, projectPath, lines) {
  if (lines.length) await editLines(app, projectPath, (ls) => insertIntoProjectSection(ls, PLANNED_SEC, lines));
}
/** Pick tasks for a week from one project: they move from ## Backlog to ## Planned with [week:: target]. Returns how many. */
async function pickTasks(env, project, header, target) {
  const { app } = env, cfg = getConfig(app);
  const today = env.moment().format("YYYY-MM-DD");
  const lines0 = (await readPath(app, project.path)).split("\n");
  const already = parseItems(lines0).filter((t) => t.task && isOpen(t) && weekIds(t.fields.week)[0] === target).length;
  const remaining = backlogItems(lines0).sort(byPrioDue);
  let added = 0;
  for (;;) {
    const opts = [[`✔ Done — ${already + added} task(s) planned for ${shortWeek(target)}`, "done"], ["＋ Type new task(s)…", "new"],
      ...remaining.map((t) => [taskLabel(t), t])];
    const c = await env.suggest(opts.map((o) => o[0]), opts.map((o) => o[1]), header);
    if (c === null || c === undefined || c === "done") break;
    if (c === "new") {
      const txt = await env.prompt("New task(s) — one per line (Tasks dates like 📅 2026-11-20 are fine)", "", true);
      if (txt) for (const t of txt.split(/\r?\n/).map((x) => x.trim().replace(/^[-*]\s+(\[.\]\s+)?/, "")).filter(Boolean)) {
        await addPlanned(app, project.path, [planLine(await askSchedule(env, cfg, target, newTask(cfg, `- [ ] ${t}`, today)), target)]);
        added++;
      }
      continue;
    }
    const block = await takeBacklogItem(app, project.path, c.raw);
    if (block) {
      block[0] = planLine(await askSchedule(env, cfg, target, block[0]), target);
      await addPlanned(app, project.path, block);
      added++;
    }
    remaining.splice(remaining.indexOf(c), 1);
  }
  return added;
}

/** Plan one project: choose this or next week, optionally set its goal, pick tasks. */
async function cmdPlanProject(env) {
  const { app } = env, cfg = getConfig(app);
  const data = await loadAll(app);
  const af = app.workspace && app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
  let p = af ? data.byPath.get(af.path) || projectOfPath(data, af.path) : null;
  if (!p) {
    const list = data.projects.filter((x) => !["done", "archived", "dropped"].includes(x.status));
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

async function cmdPlan(env, forcedId) {
  const { app } = env, cfg = getConfig(app);
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
    const active = data.projects.filter((p) => p.status === "active");
    const noGoal = data.projects.filter((p) => !goalByProject.has(p.path) && pickedOpen(p.path));
    const fresh = active.filter((p) => !goalByProject.has(p.path) && !pickedOpen(p.path))
      .sort((a, b) => (b.weeksSince ?? 999) - (a.weeksSince ?? 999) || a.name.localeCompare(b.name));
    const meta = (p) => {
      const bits = [];
      if (new Set(active.map((x) => x.scope)).size > 1) bits.push(p.scope);
      bits.push(p.lastFocus ? (p.weeksSince <= 0 ? "focused this week" : `last focus ${p.weeksSince}w ago`) : "never focused");
      if (p.avg !== null) bits.push(`avg ${p.avg}%`);
      if (p.backlog.length) bits.push(`${p.backlog.length} in backlog`);
      return bits.join(" · ");
    };
    const opts = [];
    if (n) opts.push([`✔ Done planning — ${n} goal${n === 1 ? "" : "s"}${n < cfg.goals_min ? ` (aim for ${cfg.goals_min}–${cfg.goals_max})` : ""}`, { a: "done" }]);
    for (const [path, i] of goalByProject) opts.push([`● ${data.byPath.get(path)?.name} — ${week.goals[i].text}  · ${pickedOpen(path)} task(s) · add more`, { a: "tasks", path, i }]);
    for (const p of noGoal) opts.push([`◐ ${p.name} — ${pickedOpen(p.path)} task(s) picked, no goal yet`, { a: "goal", p }]);
    for (const p of fresh) opts.push([`${p.name}  ·  ${meta(p)}`, { a: "goal", p }]);
    opts.push(["＋ Activate a backlog project…", { a: "activate" }], ["＋ New project…", { a: "new" }]);
    const header = n >= cfg.goals_max ? `${target}: ${n} goals — that's your max of ${cfg.goals_max}. Finish?` : `${target}: pick a project to set a goal (${n}/${cfg.goals_max})`;
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
      const back = data.projects.filter((x) => x.status === "backlog");
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
      if (action === "drop") { ls[k] = setStatus(ls[k], "-"); n++; return; }
      let line = setField(ls[k], "from", addFrom(t.fields.from, id));
      line = setDate(line, "scheduled", null);
      if (action === "carry") { ls[k] = setField(line, "week", nextId); n++; return; }
      // return to backlog: move the task (and its sub-items) out of ## Planned
      const it = parseItems(ls, k, k + 1)[0];
      const end = blockEnd(ls, it);
      const block = dedent(ls.slice(k, end), it.ws).filter((l) => l.trim() !== "");
      block[0] = setField(line.replace(/^[ \t]+/, ""), "week", null);
      ls.splice(k, end - k);
      insertIntoProjectSection(ls, "Backlog", block);
      n++;
    });
  }
  return n;
}
/** Move finished tasks of week `id` from ## Planned to ## Done in each project's root note. */
async function archiveDone(app, d, id) {
  let n = 0;
  for (const p of d.projects) {
    const content = await app.vault.read(p.file);
    if (!content.includes(`[week:: ${id}]`)) continue;
    await editLines(app, p.path, (ls) => {
      const sec = findSection(ls, PLANNED_SEC);
      if (!sec) return;
      const done = parseItems(ls, sec.start, sec.end).filter((t) => t.task && !t.parent && isDone(t) && weekIds(t.fields.week)[0] === id);
      const moved = [];
      for (const t of done.reverse()) {
        const end = blockEnd(ls, t);
        moved.unshift(...dedent(ls.slice(t.line, end), t.ws).filter((l) => l.trim() !== ""));
        ls.splice(t.line, end - t.line);
        n++;
      }
      insertIntoSection(ls, DONE_SEC, moved);
    });
  }
  return n;
}

async function cmdReview(env, forcedId, { thenPlan = true } = {}) {
  const { app } = env, cfg = getConfig(app);
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
  const count = d.weekMap.get(id).goals.length;

  for (let gi = 0; gi < count; gi++) {
    d = await loadAll(app);
    const g = d.weekMap.get(id).goals[gi];
    if (g.fields.result !== undefined && g.fields.result !== "") continue; // already reviewed
    const live = g.score;
    const projName = g.projectName;
    const openHere = g.here.filter(isOpen), openLegacy = g.legacy.filter(isOpen);
    const nOpen = openHere.length + openLegacy.length;
    const head = `${gi + 1}/${count} · ${projName}: “${g.text}” — ${g.doneCount}/${g.counted.length} tasks done`;
    const outcome = await ask(env, ["✅ Achieved", `◐ Partly (${live}% by tasks — adjust)`, "✗ Missed"], ["ok", "part", "miss"], head);
    let result = 100, miss = null;
    if (outcome === "part") {
      const v = parseInt(await env.prompt(`How far did you get? (0–100)`, String(live)), 10);
      result = isNaN(v) ? live : clamp(v, 0, 99);
    } else if (outcome === "miss") result = 0;
    if (outcome !== "ok") {
      miss = await ask(env, [...MISS_REASONS.map((r) => r[1]), "Other…"], [...MISS_REASONS.map((r) => r[0]), "other"], "Main reason it fell short?");
      if (miss === "other") miss = oneLine(await env.prompt("Reason (a few words)", "")).toLowerCase() || "other";
    }
    let action = "leave";
    if (nOpen) {
      action = await ask(env,
        [`→ Plan the ${nOpen} open task(s) for ${nextId}${outcome !== "ok" ? " (and carry the goal)" : ""}`, `↩ Return them to the ${projName} backlog`, "✗ Drop them", "Leave them as they are"],
        ["carry", "return", "drop", "leave"], `${nOpen} unfinished task(s)`);
    }
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
          legacyCopies.push(action === "carry" ? setField(copy, "week", nextId) : copy);
          ls[t.line] = insertBeforeMeta(setStatus(ls[t.line], "-"), action === "carry" ? `⇢ [[${nextId}]]` : "⇢ backlog");
        } else if (action === "drop") ls[t.line] = setStatus(ls[t.line], "-");
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
  for (const x of d.weekMap.get(id).extra) {
    const open = x.here.filter(isOpen);
    if (!open.length) continue;
    const action = await ask(env, [`→ Plan them for ${nextId}`, `↩ Return them to the ${x.projectName} backlog`, "✗ Drop them", "Leave them as they are"],
      ["carry", "return", "drop", "leave"], `${x.projectName} (no goal): ${open.length} unfinished task(s)`);
    await applyTaskAction(app, open, action, id, nextId);
  }
  const archived = await archiveDone(app, await loadAll(app), id);

  const wins = oneLine(await env.prompt("Wins — what moved forward? (optional)", "", true));
  const lessons = oneLine(await env.prompt("What got in the way / what will you change? (optional)", "", true));
  const energy = await env.suggest(["5 — great", "4 — good", "3 — okay", "2 — low", "1 — drained", "Skip"], [5, 4, 3, 2, 1, null], "Energy this week");
  const fields = [];
  if (wins) fields.push(`- Wins:: ${wins}`);
  if (lessons) fields.push(`- Lessons:: ${lessons}`);
  if (energy) fields.push(`- Energy:: ${energy}`);

  const canSummarize = !env.isMobile || String(cfg.llm_mobile).toLowerCase() === "url";
  const wantAi = canSummarize ? await env.suggest(["Write a short AI summary with the local model", "No summary"], [true, false], "Summary") : false;
  if (wantAi) {
    try {
      const w = (await loadAll(app)).weekMap.get(id);
      const facts = w.goals.map((g) => `- ${g.projectName}: "${g.text}" → ${g.score}%${g.fields.miss ? ` (reason: ${g.fields.miss})` : ""}; tasks done ${g.doneCount}/${g.counted.length}`).join("\n");
      const msg = `Here is my week ${id}:\n${facts}\nWins: ${wins || "-"}\nObstacles: ${lessons || "-"}\nEnergy (1-5): ${energy || "-"}\n\nWrite 2–3 plain sentences: what the week was really about, the pattern behind what slipped, and one concrete adjustment for next week. Be direct, no praise, no bullet points.`;
      const sm = oneLine(await llmChat(env, cfg, [{ role: "user", content: msg }]));
      if (sm) fields.push(`- Summary:: ${sm}`);
    } catch (e) { env.notice(`AI summary skipped — ${e.message}`, 8000); }
  }
  await editLines(app, wp, (ls) => replaceSection(ls, "Review", fields.length ? fields : ["- Reviewed:: yes"]));
  const wf = app.vault.getAbstractFileByPath(wp);
  await app.fileManager.processFrontMatter(wf, (f) => { f.status = "reviewed"; f.reviewed = env.moment().format("YYYY-MM-DD"); });
  const final = (await loadAll(app)).weekMap.get(id).goals;
  env.notice(`${id} reviewed: ${final.filter((g) => g.score >= 100).length}/${final.length} goals achieved, average ${Math.round(mean(final.map((g) => g.score)) || 0)}%${archived ? ` · ${archived} finished task(s) moved to “${DONE_SEC}”` : ""}`, 8000);
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
      due: getDate(text, "due"), scheduled: getDate(text, "scheduled"), start: getDate(text, "start"), prio: prioOf(text),
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
      inFocus = !!(proj && fset.has(proj.path));
    }
    item.project = proj;
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
  const byDayThenDeadline = (a, b) => String(a.when).localeCompare(String(b.when)) || byDeadline(a, b);
  out.today.sort(byDeadline); out.later.sort(byDayThenDeadline); out.anytime.sort(byDeadline); out.outside.sort(byDeadline);
  return out;
}
function toTaskItem(d, t) {
  const text = String(t.body !== undefined ? t.body : t.text || "");
  const today = d.today.format("YYYY-MM-DD");
  const it = { path: t.path, line: t.line, text, status: t.status,
    desc: stripFields(splitMeta(text).head).replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2").trim(),
    due: getDate(text, "due"), scheduled: getDate(text, "scheduled"), start: getDate(text, "start"), prio: prioOf(text) };
  it.overdue = isOpen(t) && (!!(it.due && it.due < today) || !!(it.scheduled && it.scheduled < today));
  return it;
}
function taskRow(d, t, { showProject = true, done = false, keep = false } = {}) {
  const m = getMoment();
  const chip = (emoji, iso, cls = "") => `<span class="pt-chip ${cls}">${emoji} ${iso === d.today.format("YYYY-MM-DD") ? "today" : m(iso, "YYYY-MM-DD").format("ddd D MMM")}</span>`;
  const chips = [];
  const p = t.prio;
  if (p === "highest" || p === "high") chips.push(`<span class="pt-chip pt-chip-prio">${p === "highest" ? "🔺" : "⏫"}</span>`);
  if (t.scheduled) chips.push(chip("⏳", t.scheduled, t.scheduled < d.today.format("YYYY-MM-DD") ? "pt-chip-late" : ""));
  if (t.due) chips.push(chip("📅", t.due, t.due < d.today.format("YYYY-MM-DD") ? "pt-chip-late" : t.due === d.today.format("YYYY-MM-DD") ? "pt-chip-today" : ""));
  const proj = showProject ? (t.project ? link(t.project.path, t.group, "pt-task-proj") : `<span class="pt-task-proj">${esc(t.group)}</span>`) : "";
  return `<div class="pt-task${t.overdue ? " is-overdue" : ""}${done ? " is-done" : ""}" data-path="${esc(t.path)}" data-line="${t.line}" data-text="${esc(t.text)}"${done || keep ? ' data-keep="1"' : ""}>
    <input type="checkbox" class="task-list-item-checkbox pt-task-check" aria-label="Done"${done ? " checked" : ""}>
    <div class="pt-task-body"><span class="pt-task-text">${esc(t.desc || t.text)}</span><span class="pt-task-meta">${proj}${chips.join("")}</span></div>
    <button class="pt-task-btn clickable-icon" data-act="edit" title="Edit dates and priority" aria-label="Edit">✎</button>
    <button class="pt-task-btn clickable-icon" data-act="open" title="Open the note" aria-label="Open">↗</button>
  </div>`;
}
function renderTaskWidgets(d, tasks) {
  const c = classifyTasks(d, tasks);
  const m = getMoment();
  let h = "";
  const focusNames = [...c.focus].map((p) => d.byPath.get(p)?.name).filter(Boolean);
  const nextNames = [...c.upcomingFocus].filter((p) => !c.focus.has(p)).map((p) => d.byPath.get(p)?.name).filter(Boolean);
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Focus tasks</span><span class="pt-muted">${esc(focusNames.join(" · "))}${nextNames.length ? ` <span class="pt-next">+ next week: ${esc(nextNames.join(" · "))}</span>` : ""}</span></div>`;
  if (!c.hasPlan && !c.today.length && !c.later.length) h += `<div class="pt-empty">No plan for this week — only tasks outside focus are shown below.</div>`;
  else {
    h += `<div class="pt-sub">Today${c.today.length ? ` <span class="pt-count">${c.today.length}</span>` : ""}</div>`;
    h += c.today.length ? c.today.map((t) => taskRow(d, t)).join("") : `<div class="pt-empty">Nothing scheduled or due today.</div>`;
    if (c.later.length) {
      let day = null;
      h += `<div class="pt-sub">Next ${c.days} days${c.planned.length ? ` <span class="pt-muted">· this week + ${c.planned.map(shortWeek).join(", ")} focus</span>` : ""}</div>`;
      for (const t of c.later) {
        if (t.when !== day) { day = t.when; h += `<div class="pt-day">${m(day, "YYYY-MM-DD").format("dddd D MMM")}</div>`; }
        h += taskRow(d, t);
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
const reasonLabel = (k) => (MISS_REASONS.find((r) => r[0] === k) || [k, k])[1];

function goalRows(d, w, { showProject = true, compact = false } = {}) {
  if (!w.goals.length) return `<div class="pt-empty">No goals yet.</div>`;
  return `<div class="pt-goals">${w.goals.map((g) => {
    const badges = [];
    if (g.fields.from) badges.push(`<span class="pt-badge">carried from ${esc(linkLabel(g.fields.from))}</span>`);
    if (g.fields.miss) badges.push(`<span class="pt-badge pt-badge-miss">${esc(reasonLabel(g.fields.miss))}</span>`);
    const proj = g.projectPath ? link(g.projectPath, g.projectName, "pt-proj") : `<span class="pt-proj">${esc(g.projectName)}</span>`;
    return `<div class="pt-goal ${g.score >= 100 ? "is-done" : ""}">
      <div class="pt-goal-head">${showProject ? proj : ""}<span class="pt-goal-text">${esc(g.text)}</span>${badges.join("")}</div>
      <div class="pt-goal-bar">${bar(g.score)}<span class="pt-goal-num">${g.score}%</span>${compact ? "" : `<span class="pt-goal-tasks">${g.doneCount}/${g.counted.length} tasks</span>`}</div>
    </div>`;
  }).join("")}</div>`;
}

function chartScores(d, ids) {
  const W = 640, H = 170, L = 30, R = 8, T = 10, B = 24, n = ids.length;
  const cw = (W - L - R) / n, bw = Math.min(28, cw * 0.62);
  const y = (v) => T + (H - T - B) * (1 - v / 100);
  let s = `<svg class="pt-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Average goal score per week">`;
  for (const v of [0, 50, 100]) s += `<line class="pt-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="pt-axis" x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
  const pts = [];
  const vals = ids.map((id) => d.weekMap.get(id)?.m.avg ?? null);
  ids.forEach((id, i) => {
    const v = vals[i], x = L + cw * i + cw / 2;
    if (v !== null) s += `<rect class="pt-bar-${scoreCls(v)}" x="${x - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0, y(0) - y(v))}" rx="3"><title>${id}: ${v}% avg, ${d.weekMap.get(id).m.achieved}/${d.weekMap.get(id).m.goals} achieved</title></rect>`;
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
      s += `<rect class="pt-done" x="${x - bw / 2}" y="${y(m.done)}" width="${bw}" height="${y(0) - y(m.done)}" rx="3"><title>${id}: ${m.done} of ${m.planned} tasks done</title></rect>`;
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
function neglected(d) {
  return d.projects.filter((p) => p.status === "active" && !d.weekMap.get(d.curId)?.goals.some((g) => g.projectPath === p.path) && (p.weeksSince === null || p.weeksSince >= d.cfg.neglect_weeks))
    .sort((a, b) => (b.weeksSince ?? 999) - (a.weeksSince ?? 999));
}

function renderHome(d, opts = {}) {
  const w = d.weekMap.get(d.curId);
  let h = `<div class="pt">`;
  h += buttons([["Capture", "Capture"], ["Process inbox", "Process inbox"], ["Plan week", "Plan week", true], ["Weekly review", "Weekly review"], ["New project", "New project"]]);
  const daysLeft = 7 - d.today.isoWeekday();
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">This week</span><span class="pt-muted">${w ? link(w.path, `${d.curId} · ${weekRange(d.curId)}`) : `${d.curId} · ${weekRange(d.curId)}`}</span></div>`;
  if (w && w.goals.length) {
    h += `<div class="pt-summary">${w.m.achieved}/${w.m.goals} goals done · ${w.m.done}/${w.m.planned} tasks · ${w.status === "reviewed" ? "reviewed" : daysLeft ? `${daysLeft} day${daysLeft > 1 ? "s" : ""} left` : "last day"}</div>`;
    h += goalRows(d, w, { compact: true });
  } else h += `<div class="pt-empty">No plan for this week yet — hit <b>Plan week</b>.</div>`;
  h += `</div>`;
  if (opts.tasks) h += renderTaskWidgets(d, opts.tasks);
  h += `<div class="pt-grid3">`;
  h += `<div class="pt-card"><div class="pt-h">Inbox</div><div class="pt-big">${d.inbox.open}</div><div class="pt-muted">${d.inbox.open ? `${d.inbox.classified} classified · ` : ""}${link(d.inbox.path, "open inbox")}</div></div>`;
  const ids = timeline(d, 8);
  const lw = lastClosedWeek(d);
  h += `<div class="pt-card"><div class="pt-h">Momentum · 8 weeks</div>${sparkline(d, ids)}<div class="pt-muted">${lw ? `last week ${lw.m.avg}% avg goal score` : "no history yet"}</div></div>`;
  const att = [];
  const unrev = d.weeks.filter((x) => x.id < d.curId && x.status !== "reviewed" && x.goals.length);
  for (const x of unrev.slice(-2)) att.push(`${link(x.path, x.id)} not reviewed`);
  for (const p of neglected(d).slice(0, 5)) att.push(`${link(p.path, p.name)} <span class="pt-muted">${p.weeksSince === null ? "never focused" : `${p.weeksSince}w without focus`}</span>`);
  h += `<div class="pt-card"><div class="pt-h">Needs attention</div>${att.length ? `<ul class="pt-list">${att.map((a) => `<li>${a}</li>`).join("")}</ul>` : `<div class="pt-muted">Nothing — nice.</div>`}</div>`;
  h += `</div>`;
  const act = d.projects.filter((p) => p.status === "active").length, back = d.projects.filter((p) => p.status === "backlog").length;
  h += `<div class="pt-foot pt-muted">${act} active · ${back} backlog projects · ${link("Tracker/Analytics.md", "Analytics →")}</div>`;
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
  h += `<div class="pt-kpis">${kpi("Goals achieved", `${w.m.achieved}<span class="pt-of">/${w.m.goals}</span>`)}${kpi("Avg goal progress", w.m.avg === null ? "–" : `${w.m.avg}%`)}${kpi("Tasks done", `${w.m.done}<span class="pt-of">/${w.m.planned}</span>`)}${outside === null ? "" : kpi("Done outside goals", outside, "✅ elsewhere in the vault")}${kpi("Status", esc(state))}</div>`;
  const btn = [];
  if (w.status !== "reviewed" && (isCur || past)) btn.push(["Weekly review", "Weekly review", true]);
  if (!past) btn.push(["Plan / add goals", "Plan week"], ["Plan a project", "Plan project"]);
  if (btn.length) h += buttons(btn);
  h += weekTaskList(d, w);
  return h + `</div>`;
}
/** All tasks picked for the week, grouped by goal (project), with live progress. Tick / edit right here. */
function weekTaskList(d, w) {
  const groups = [];
  for (const g of w.goals) groups.push({ projectPath: g.projectPath, name: g.projectName, goal: g, here: g.tasks, carried: g.carriedOut, score: g.score, counted: g.counted.length, done: g.doneCount });
  for (const x of w.extra) groups.push({ projectPath: x.projectPath, name: x.projectName, goal: null, here: x.here, carried: x.carriedOut, score: x.counted.length ? Math.round((100 * x.doneCount) / x.counted.length) : 0, counted: x.counted.length, done: x.doneCount });
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
      <div class="pt-goal-bar">${bar(gr.score)}<span class="pt-goal-num">${gr.score}%</span><span class="pt-goal-tasks">${gr.done}/${gr.counted} tasks</span></div>`;
    const items = gr.here.filter((t) => t.status !== "-").map((t) => Object.assign(toTaskItem(d, t), { project: p, group: gr.name, isDone: isDone(t) }));
    const open = items.filter((t) => !t.isDone).sort((a, b) => (!!b.due - !!a.due) || String(a.due || "").localeCompare(String(b.due || "")) || String(a.scheduled || "9").localeCompare(String(b.scheduled || "9")) || PRIO_RANK[a.prio] - PRIO_RANK[b.prio]);
    const done = items.filter((t) => t.isDone);
    h += open.map((t) => taskRow(d, t, { showProject: false, keep: true })).join("");
    if (done.length) h += `<details class="pt-anytime"><summary class="pt-sub">Done <span class="pt-count">${done.length}</span></summary>${done.map((t) => taskRow(d, t, { showProject: false, done: true })).join("")}</details>`;
    if (gr.carried.length) h += `<div class="pt-muted pt-hint">${gr.carried.length} task(s) moved on to a later week or the backlog</div>`;
    if (!items.length && !gr.carried.length) h += `<div class="pt-empty">No tasks picked — use <b>Plan a project</b>.</div>`;
    h += `</div>`;
  }
  return h;
}

function renderProject(d, path) {
  const p = d.byPath.get(path);
  if (!p) return `<div class="pt pt-empty">Not a tracked project — add <code>type: project</code> to the frontmatter (or run <b>Register projects</b>).</div>`;
  const ids = timeline(d, 16);
  let h = `<div class="pt">`;
  if (p.objective) h += `<div class="pt-objective">🎯 ${esc(p.objective)}</div>`;
  h += `<div class="pt-kpis">${kpi("Status", esc(p.status))}${kpi("Weeks in focus", p.focusWeeks)}${kpi("Avg goal score", p.avg === null ? "–" : `${p.avg}%`)}${kpi("Tasks done", p.tasksDone)}${kpi("Backlog", p.backlog.length)}</div>`;
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
    return { wid, label, open: here.filter(isOpen).length, done: here.filter(isDone).length, moved: b ? b.carried.length : 0, goal, w };
  });
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Planned</span><span class="pt-muted">tasks are in the “${PLANNED_SEC}” section below</span></div><div class="pt-plan">`;
  for (const x of planned) {
    const total = x.open + x.done + x.moved;
    h += `<div class="pt-plan-row"><span class="pt-plan-week">${x.w && !x.w.virtual ? link(x.w.path, `${x.label} · ${shortWeek(x.wid)}`) : `${x.label} · ${shortWeek(x.wid)}`}</span>
      <span class="pt-plan-goal">${x.goal ? `🎯 ${esc(x.goal.text)}` : `<span class="pt-muted">no goal</span>`}</span>
      <span class="pt-num">${total ? `${x.done}/${total} done${x.moved ? ` <span class="pt-muted">· ${x.moved} moved on</span>` : ""}` : `<span class="pt-muted">no tasks</span>`}</span></div>`;
  }
  h += `</div>${buttons([["Pick tasks for this / next week", "Plan project", true]])}</div>`;
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

function renderAnalytics(d, opts = {}) {
  const n = opts.weeks || 12;
  const ids = timeline(d, n, { trim: true });
  let h = `<div class="pt">`;
  if (!d.weeks.some((w) => w.goals.length)) return h + `<div class="pt-empty">No weekly goals yet. Plan your first week and come back after the review.</div></div>`;
  const lw = lastClosedWeek(d);
  if (lw) {
    const rate = Math.round((100 * lw.m.achieved) / lw.m.goals);
    h += `<div class="pt-h">Last week · ${link(lw.path, lw.id)}</div><div class="pt-kpis">`;
    h += kpi("Goals achieved", `${lw.m.achieved}<span class="pt-of">/${lw.m.goals} · ${rate}%</span>`, delta(rate, baseline(d, lw.id, "rate"), " pts"));
    h += kpi("Avg goal score", `${lw.m.avg}%`, delta(lw.m.avg, baseline(d, lw.id, "avg"), " pts"));
    h += kpi("Tasks done", `${lw.m.done}<span class="pt-of">/${lw.m.planned}</span>`, delta(lw.m.done, baseline(d, lw.id, "done")));
    h += kpi("Carried in", lw.m.carriedIn, lw.m.carriedIn ? "goals rolled over" : "");
    if (opts.completions) h += kpi("Done outside goals", opts.completions[lw.id] || 0, "✅ elsewhere in the vault");
    h += `</div>`;
  }
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Average goal score per week</span><span class="pt-legend"><i class="pt-lg-bar"></i>week <i class="pt-lg-line"></i>4-week trend</span></div>${chartScores(d, ids)}</div>`;
  h += `<div class="pt-card"><div class="pt-card-head"><span class="pt-h">Tasks done vs planned</span><span class="pt-legend"><i class="pt-lg-done"></i>done <i class="pt-lg-planned"></i>planned</span></div>${chartTasks(d, ids)}</div>`;

  const rows = d.projects.filter((p) => p.history.some((x) => ids.includes(x.week)) || p.status === "active");
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

  h += `<div class="pt-card"><div class="pt-h">Projects</div><table class="pt-table"><thead><tr><th>Project</th><th class="pt-num">Focus wks</th><th class="pt-num">Avg</th><th class="pt-num">Last 4</th><th class="pt-num">Tasks done</th><th class="pt-num">Backlog</th><th>Last focus</th></tr></thead><tbody>`;
  for (const p of [...d.projects].filter((p) => p.status === "active" || p.focusWeeks).sort((a, b) => (b.focusWeeks - a.focusWeeks) || a.name.localeCompare(b.name))) {
    const trend = p.avg !== null && p.recentAvg !== null && p.focusWeeks > 4 ? (p.recentAvg - p.avg >= 5 ? ` <span class="pt-up">▲</span>` : p.avg - p.recentAvg >= 5 ? ` <span class="pt-down">▼</span>` : "") : "";
    const stale = p.status === "active" && (p.weeksSince === null || p.weeksSince >= d.cfg.neglect_weeks);
    h += `<tr><td>${link(p.path, p.name)}${p.status !== "active" ? ` <span class="pt-muted">${esc(p.status)}</span>` : ""}</td><td class="pt-num">${p.focusWeeks}</td><td class="pt-num">${p.avg === null ? "–" : p.avg + "%"}</td><td class="pt-num">${p.recentAvg === null ? "–" : p.recentAvg + "%"}${trend}</td><td class="pt-num">${p.tasksDone}</td><td class="pt-num">${p.backlog.length}</td><td class="${stale ? "pt-warn" : ""}">${p.lastFocus ? (p.weeksSince <= 0 ? "this week" : `${p.weeksSince}w ago`) : "never"}</td></tr>`;
  }
  h += `</tbody></table></div>`;

  const reasons = Object.entries(d.reasons).sort((a, b) => b[1] - a[1]);
  h += `<div class="pt-grid2"><div class="pt-card"><div class="pt-h">Why goals fell short</div>`;
  if (reasons.length) {
    const max = reasons[0][1];
    h += reasons.map(([k, v]) => `<div class="pt-hbar"><span class="pt-hbar-label">${esc(reasonLabel(k))}</span><div class="pt-hbar-track"><div class="pt-hbar-fill" style="width:${(100 * v) / max}%"></div></div><span class="pt-num">${v}</span></div>`).join("");
  } else h += `<div class="pt-muted">No reasons recorded yet — they come from the weekly review.</div>`;
  h += `</div><div class="pt-card"><div class="pt-h">Active but out of focus (${d.cfg.neglect_weeks}+ weeks)</div>`;
  const ng = neglected(d);
  h += ng.length ? `<ul class="pt-list">${ng.map((p) => `<li>${link(p.path, p.name)} <span class="pt-muted">${p.weeksSince === null ? "never focused" : `${p.weeksSince}w`}</span></li>`).join("")}</ul><div class="pt-muted pt-hint">Pick one next week — or move it to backlog so your active list stays honest.</div>` : `<div class="pt-muted">None.</div>`;
  h += `</div></div>`;

  const reviewed = d.weeks.filter((w) => w.review && (w.review.energy || w.review.summary || w.review.wins)).slice(-6).reverse();
  if (reviewed.length) {
    h += `<div class="pt-card"><div class="pt-h">Review notes</div><table class="pt-table"><thead><tr><th>Week</th><th class="pt-num">Energy</th><th>Notes</th></tr></thead><tbody>`;
    for (const w of reviewed) h += `<tr><td>${link(w.path, w.id)}</td><td class="pt-num">${esc(w.review.energy || "–")}</td><td>${w.review.summary ? `<div>${esc(w.review.summary)}</div>` : ""}${w.review.wins ? `<div class="pt-muted">Wins: ${esc(w.review.wins)}</div>` : ""}${w.review.lessons ? `<div class="pt-muted">Lessons: ${esc(w.review.lessons)}</div>` : ""}</td></tr>`;
    h += `</tbody></table></div>`;
  }
  return h + `</div>`;
}

async function render(app, mode, path, opts = {}) {
  const d = await loadAll(app);
  if (mode === "home") return renderHome(d, opts);
  if (mode === "week") return renderWeek(d, path, opts);
  if (mode === "project") return renderProject(d, path);
  if (mode === "analytics") return renderAnalytics(d, opts);
  return `<div class="pt-empty">Unknown mode: ${esc(mode)}</div>`;
}

/* ------------------------------------------------------------------ entry */

const COMMANDS = { capture: cmdCapture, process: cmdProcess, classify: cmdClassify, plan: cmdPlan, planProject: cmdPlanProject, review: cmdReview, newProject: cmdNewProject, register: cmdRegister };

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
  getConfig, loadAll, render, run, Cancelled, Handoff, classifyTasks, toggleDoneLine, AI_REQ, AI_RES, SHORTCUT_SEP, splitMeta, getDate, setDate, prioOf, setPrio, newTask, isMoved,
  parseWeek, parseItems, parseFields, setField, setStatus, findSection, insertIntoSection, scoreGoal, inboxItems, backlogItems,
  weekId, weekStart, shiftWeek, weeksBetween, weekRange, weekNote, projectNote, classifyMessages, extractJson, stripThink,
};
