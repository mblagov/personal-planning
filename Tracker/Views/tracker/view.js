// Dataview view: await dv.view("Tracker/Views/tracker", {mode: "home" | "week" | "project" | "analytics" | "projects"})
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

/** Tasks completed (✅ date) outside the week notes, per ISO week — "done outside goals". Routines are scored on their own. */
function completionsByWeek(isRoutine) {
  const out = {};
  try {
    for (const t of dv.pages().file.tasks) {
      if (!t.completed || !t.completion || String(t.path).startsWith(WEEKS_PREFIX)) continue;
      if (isRoutine && isRoutine(String(t.path))) continue;
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
  // the row now points at the changed line (for a recurring task: the line that was ticked)
  const mine = String(next).split("\n").find((l) => !/^\s*[-*+]\s+\[[ /]\]/.test(l)) || String(next).split("\n")[0];
  row.dataset.text = mine.replace(/^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s*/, "");
  return true;
}

let obsidian = null;
try { obsidian = require("obsidian"); } catch (e) { /* outside Obsidian */ }
/** Dialog for the estimate and the time spent. Resolves {est, active, passive} in minutes (null = clear), or null when cancelled. */
function timeDialog(core, title, text, hint) {
  return new Promise((resolve) => {
    if (!obsidian || !obsidian.Modal) { resolve(null); return; }
    const cur = core.timeOf(text);
    const modal = new obsidian.Modal(obsApp);
    let result = null;
    modal.titleEl.setText(`⏱ ${title}`);
    const el = modal.contentEl;
    el.addClass("pt-time-modal");
    const field = (key, label, sub, quick) => `<div class="pt-time-field"><label><b>${label}</b><span class="pt-muted">${sub}</span></label>
      <div class="pt-time-input"><input type="text" data-k="${key}" placeholder="e.g. 45m, 1h30m" value="${core.fmtDur(cur[key])}">${quick ? ["15m", "30m", "1h", "2h"].map((q) => `<button class="pt-mini" data-add="${key}" data-q="${q}">+${q}</button>`).join("") : ""}</div></div>`;
    el.innerHTML = (hint ? `<div class="pt-muted pt-hint">${hint}</div>` : "")
      + field("est", "≈ Estimate", "hands-on time you expect", false)
      + field("active", "⏱ Active", "hands-on time spent", true)
      + field("passive", "⌛ Passive", "time it took without you: waiting, drying, uploading…", true)
      + `<div class="pt-actions"><button class="mod-cta" data-save="1">Save</button><button data-cancel="1">Cancel</button></div>`;
    const input = (k) => el.querySelector(`input[data-k="${k}"]`);
    el.querySelectorAll("button[data-add]").forEach((b) => b.addEventListener("click", () => {
      const inp = input(b.dataset.add);
      inp.value = core.fmtDur((core.parseDur(inp.value) || 0) + core.parseDur(b.dataset.q));
    }));
    const save = () => {
      const out = {};
      for (const k of ["est", "active", "passive"]) {
        const inp = input(k), v = inp.value.trim(), m = v ? core.parseDur(v) : null;
        if (v && m === null) { inp.addClass("pt-bad"); inp.focus(); return; }
        out[k] = m;
      }
      result = out; modal.close();
    };
    el.querySelector("[data-save]").addEventListener("click", save);
    el.querySelector("[data-cancel]").addEventListener("click", () => modal.close());
    el.querySelectorAll("input").forEach((inp) => inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); save(); } }));
    modal.onClose = () => resolve(result);
    modal.open();
    setTimeout(() => (input(cur.est ? "active" : "est") || {}).focus && input(cur.est ? "active" : "est").focus(), 30);
  });
}


const root = dv.el("div", "", { cls: "pt-root" });
try {
  const core = await loadCore();
  const env = core.makeEnv(obsApp, {});
  const cfg = core.getConfig(obsApp);
  const opts = Object.assign({}, (typeof input === "object" && input) || {});
  const mode = opts.mode || "home";
  if (mode === "week" || mode === "analytics") opts.completions = completionsByWeek(core.routinePathTest(obsApp));
  if (mode === "home") {
    // Missed routine occurrences are cancelled (and the next ones created) when Home opens.
    // Dataview re-renders Home after the files change, with the fresh tasks.
    try {
      const r = await core.rollRoutines(obsApp, window.moment().format("YYYY-MM-DD"));
      if (r.missed) notify(`Routines: ${r.missed} missed occurrence(s) recorded; the next ones are scheduled.`);
      if (r.stuck.length) notify(`Routines: couldn't work out the next date for ${r.stuck.join("; ")}.`);
    } catch (e) { console.error("[tracker] routines", e); }
    opts.tasks = openTasks();
  }

  const draw = async () => { root.innerHTML = await core.render(obsApp, mode, dv.currentFilePath, opts); bind(); };
  const logTime = async (row, hint) => {
    const title = (row.querySelector(".pt-task-text") || {}).textContent || "Task";
    const v = await timeDialog(core, title, row.dataset.text, hint);
    if (!v) return false;
    const ok = await changeLine(row, async (line) => core.setTimes(line, v));
    if (ok) row.style.opacity = "0.6";
    return ok;
  };

  function bind() {
    root.querySelectorAll("a.pt-link").forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault();
      obsApp.workspace.openLinkText(a.dataset.href, dv.currentFilePath, ev.ctrlKey || ev.metaKey);
    }));
    root.querySelectorAll("button[data-cmd]").forEach((b) => b.addEventListener("click", () => {
      const id = "templater-obsidian:" + b.dataset.cmd;
      if (obsApp.commands.commands[id]) obsApp.commands.executeCommandById(id);
      else notify(`Add “${b.dataset.cmd}” under Settings → Templater → Template hotkeys, then this button works.`);
    }));

    // Projects note: priority / status dropdowns write the project's properties (Dataview then re-renders)
    root.querySelectorAll("select.pt-select").forEach((sel) => sel.addEventListener("change", async () => {
      const file = obsApp.vault.getAbstractFileByPath(sel.dataset.path);
      if (!file) { notify("Couldn't find that project note any more."); return; }
      sel.disabled = true;
      try { await obsApp.fileManager.processFrontMatter(file, (f) => { f[sel.dataset.key] = sel.value; }); }
      catch (e) { notify(`Couldn't save: ${e.message || e}`); sel.disabled = false; }
    }));
    // Projects note: rate / write descriptions with the local model
    root.querySelectorAll("button[data-desc]").forEach((b) => b.addEventListener("click", async () => {
      root.querySelectorAll("button[data-desc]").forEach((x) => { x.disabled = true; });
      b.textContent = b.dataset.desc === "generate" ? "✨ Writing…" : b.dataset.desc.includes("check") ? "Checking…" : "Saving…";
      try { const msg = await core.descAction(env, b.dataset.desc, b.dataset.path); if (msg) notify(msg); }
      catch (e) { console.error("[tracker]", e); notify(`Tracker: ${e.message || e}`); }
      await draw();
    }));

    // Project page: tasks vs goals, duplicates (local model)
    root.querySelectorAll("button[data-ai]").forEach((b) => b.addEventListener("click", async () => {
      root.querySelectorAll("button[data-ai]").forEach((x) => { x.disabled = true; });
      if (b.dataset.ai === "analyze") b.textContent = "Analyzing…";
      try { const msg = await core.projectAction(env, b.dataset.ai, b.dataset.path, b.dataset.i); if (msg) notify(msg); }
      catch (e) { console.error("[tracker]", e); notify(`Tracker: ${e.message || e}`); }
      await draw();
    }));

    // Task rows: tick (through the Tasks plugin, so ✅ dates and 🔁 recurrence work), time, edit, open
    root.querySelectorAll(".pt-task").forEach((row) => {
      const check = row.querySelector(".pt-task-check");
      check.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        check.disabled = true;
        const wasDone = row.classList.contains("is-done");
        const api = tasksApi();
        const ok = await changeLine(row, async (line, path) => core.cleanRecurrence(api && api.executeToggleTaskDoneCommand
          ? await api.executeToggleTaskDoneCommand(line, path)
          : core.toggleDoneLine(line, window.moment().format("YYYY-MM-DD"))));
        if (ok && row.dataset.keep) { row.classList.toggle("is-done"); check.disabled = false; }
        else if (ok) { row.classList.add("is-done"); setTimeout(() => row.remove(), 700); }
        else { check.checked = !check.checked; check.disabled = false; }
        // done a task that had an estimate: how long did it take?
        if (ok && !wasDone && cfg.log_time_on_done && row.dataset.est && !row.dataset.active && !row.dataset.recurring)
          await logTime(row, "Done! How long did it take? (Cancel to skip.)");
      });
      row.querySelector('[data-act="time"]').addEventListener("click", () => logTime(row));
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
  }
  await draw();
} catch (e) {
  console.error("[tracker]", e);
  root.innerHTML = `<div class="pt-error">Tracker view error: ${String(e.message || e).replace(/</g, "&lt;")}</div>`;
}
