// Dataview view: await dv.view("Tracker/Views/tracker", {mode: "home" | "week" | "project" | "analytics"})
const CORE_PATH = "Tracker/Scripts/ptrack.js";
const WEEKS_PREFIX = "Tracker/Weeks/";
const obsApp = dv.app || window.app;

async function loadCore() {
  const file = obsApp.vault.getAbstractFileByPath(CORE_PATH);
  if (!file) throw new Error(`Can't find ${CORE_PATH}. The Tracker folder must be at the root of your vault.`);
  const key = `${file.path}:${file.stat.mtime}`;
  if (window.__ptrackCore && window.__ptrackCore.key === key) return window.__ptrackCore.core;
  const src = await obsApp.vault.read(file);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  window.__ptrackCore = { key, core: mod.exports.core };
  return mod.exports.core;
}

/** Tasks completed (✅ date) outside the week notes, per ISO week — "done outside goals". */
function completionsByWeek() {
  const out = {};
  try {
    for (const t of dv.pages().file.tasks) {
      if (!t.completed || !t.completion || String(t.path).startsWith(WEEKS_PREFIX)) continue;
      if (/\[week::/.test(String(t.text || ""))) continue; // picked for a week → counted under its goal
      const iso = typeof t.completion.toISODate === "function" ? t.completion.toISODate() : String(t.completion).slice(0, 10);
      const id = window.moment(iso, "YYYY-MM-DD").format("GGGG-[W]WW");
      out[id] = (out[id] || 0) + 1;
    }
  } catch (e) { return null; }
  return out;
}
/** All open tasks in the vault, from Dataview's index. */
function openTasks() {
  const out = [];
  for (const t of dv.pages().file.tasks) {
    if (t.status !== " " && t.status !== "/") continue;
    out.push({ path: String(t.path), line: t.line, text: String(t.text || "").split("\n")[0], status: t.status });
  }
  return out;
}

function tasksApi() {
  const p = obsApp.plugins && obsApp.plugins.plugins && obsApp.plugins.plugins["obsidian-tasks-plugin"];
  return p && p.apiV1 ? p.apiV1 : null;
}
function notify(msg) {
  try { const { Notice } = require("obsidian"); new Notice(msg, 6000); }
  catch (e) { root.insertAdjacentHTML("afterbegin", `<div class="pt-error">${msg}</div>`); }
}
/** Find the task's line again (the file may have changed since Dataview indexed it). */
function locate(lines, line, text) {
  const key = text.length > 40 ? text.slice(0, 40) : text;
  const has = (l) => l !== undefined && /^\s*(?:[-*+]|\d+[.)])\s+\[.\]/.test(l) && (l.includes(text) || (key.length >= 8 && l.includes(key)));
  if (has(lines[line])) return line;
  for (let d = 1; d < 50; d++) { if (has(lines[line - d])) return line - d; if (has(lines[line + d])) return line + d; }
  return lines.findIndex(has);
}
async function changeLine(row, fn) {
  const path = row.dataset.path, line = Number(row.dataset.line), text = row.dataset.text;
  const file = obsApp.vault.getAbstractFileByPath(path);
  if (!file) return false;
  const lines = (await obsApp.vault.read(file)).split("\n");
  const i = locate(lines, line, text);
  if (i < 0) { notify("Couldn't find that task any more — it may have been edited."); return false; }
  const next = await fn(lines[i], path);
  if (next === null || next === undefined || next === lines[i]) return false;
  await obsApp.vault.process(file, (c) => {
    const ls = c.split("\n");
    const j = locate(ls, i, text);
    if (j >= 0) ls.splice(j, 1, ...String(next).split("\n"));
    return ls.join("\n");
  });
  return true;
}

const root = dv.el("div", "", { cls: "pt-root" });
try {
  const core = await loadCore();
  const opts = Object.assign({}, (typeof input === "object" && input) || {});
  if (opts.mode === "week" || opts.mode === "analytics") opts.completions = completionsByWeek();
  if ((opts.mode || "home") === "home") opts.tasks = openTasks();
  root.innerHTML = await core.render(obsApp, opts.mode || "home", dv.currentFilePath, opts);

  root.querySelectorAll("a.pt-link").forEach((a) => a.addEventListener("click", (ev) => {
    ev.preventDefault();
    obsApp.workspace.openLinkText(a.dataset.href, dv.currentFilePath, ev.ctrlKey || ev.metaKey);
  }));
  root.querySelectorAll("button[data-cmd]").forEach((b) => b.addEventListener("click", () => {
    const id = "templater-obsidian:" + b.dataset.cmd;
    if (obsApp.commands.commands[id]) obsApp.commands.executeCommandById(id);
    else notify(`Add “${b.dataset.cmd}” under Settings → Templater → Template hotkeys, then this button works.`);
  }));

  // Task rows: tick (through the Tasks plugin, so ✅ dates and 🔁 recurrence work), edit, open
  root.querySelectorAll(".pt-task").forEach((row) => {
    const check = row.querySelector(".pt-task-check");
    check.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      check.disabled = true;
      const api = tasksApi();
      const ok = await changeLine(row, async (line, path) => (api && api.executeToggleTaskDoneCommand
        ? await api.executeToggleTaskDoneCommand(line, path)
        : core.toggleDoneLine(line, window.moment().format("YYYY-MM-DD"))));
      if (ok && row.dataset.keep) { row.classList.toggle("is-done"); check.disabled = false; }
      else if (ok) { row.classList.add("is-done"); setTimeout(() => row.remove(), 700); }
      else { check.checked = !check.checked; check.disabled = false; }
    });
    row.querySelector('[data-act="edit"]').addEventListener("click", async () => {
      const api = tasksApi();
      if (api && api.editTaskLineModal) {
        const ok = await changeLine(row, async (line) => { const r = await api.editTaskLineModal(line); return r ? r : null; });
        if (ok) row.style.opacity = "0.5";
      } else {
        await obsApp.workspace.openLinkText(row.dataset.path, "", false, { eState: { line: Number(row.dataset.line) } });
        notify("Put the cursor on the task and run “Tasks: Create or edit task”.");
      }
    });
    row.querySelector('[data-act="open"]').addEventListener("click", () => {
      obsApp.workspace.openLinkText(row.dataset.path, "", false, { eState: { line: Number(row.dataset.line) } });
    });
  });
} catch (e) {
  console.error("[tracker]", e);
  root.innerHTML = `<div class="pt-error">Tracker view error: ${String(e.message || e).replace(/</g, "&lt;")}</div>`;
}
