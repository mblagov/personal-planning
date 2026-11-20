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

/** Confirm a cancellation, with an optional reason. Resolves the reason ("" = none), or null when the user keeps the task. */
function cancelDialog(title) {
  return new Promise((resolve) => {
    if (!obsidian || !obsidian.Modal) { resolve(window.confirm(`Cancel “${title}”?`) ? "" : null); return; }
    const modal = new obsidian.Modal(obsApp);
    let result = null;
    modal.titleEl.setText(`✖ Cancel “${title}”?`);
    const el = modal.contentEl;
    el.addClass("pt-time-modal");
    el.innerHTML = `<div class="pt-muted pt-hint">It won't count as done or as planned, leaves your lists and moves to “Done” as cancelled. Analytics counts it as cancelled.</div>
      <div class="pt-time-field"><label><b>Reason</b><span class="pt-muted">optional</span></label><div class="pt-time-input"><input type="text" data-k="reason" placeholder="e.g. not needed any more"></div></div>
      <div class="pt-actions"><button class="mod-warning" data-ok="1">Cancel task</button><button data-keep="1">Keep it</button></div>`;
    const inp = el.querySelector("input");
    const ok = () => { result = inp.value.trim(); modal.close(); };
    el.querySelector("[data-ok]").addEventListener("click", ok);
    el.querySelector("[data-keep]").addEventListener("click", () => modal.close());
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ok(); } });
    modal.onClose = () => resolve(result);
    modal.open();
    setTimeout(() => inp.focus(), 30);
  });
}
/** Ask for a time of day. Resolves "14:30" / "14:30-15:30", "" for any time, or null when cancelled. */
function clockDialog(core, title, cur) {
  return new Promise((resolve) => {
    if (!obsidian || !obsidian.Modal) { const v = window.prompt(`Time for “${title}” (e.g. 14:30 or 14:30-15:30, empty = any time)`, cur || ""); resolve(v === null ? null : v.trim()); return; }
    const modal = new obsidian.Modal(obsApp);
    let result = null;
    modal.titleEl.setText(`🕒 ${title}`);
    const el = modal.contentEl;
    el.addClass("pt-time-modal");
    el.innerHTML = `<div class="pt-muted pt-hint">A task with a set time goes to Google Calendar. Without one it can be done any time that day.</div>
      <div class="pt-time-field"><label><b>Time</b><span class="pt-muted">e.g. 9:00, 14:30 or 14:30-15:30</span></label><div class="pt-time-input"><input type="text" placeholder="14:30" value="${(cur || "").replace(/"/g, "&quot;")}"></div></div>
      <div class="pt-actions"><button class="mod-cta" data-ok="1">Save</button><button data-any="1">Any time</button><button data-x="1">Cancel</button></div>`;
    const inp = el.querySelector("input");
    const ok = () => {
      const v = inp.value.trim();
      if (v && !core.parseClockRange(v)) { inp.addClass("pt-bad"); inp.focus(); return; }
      result = v; modal.close();
    };
    el.querySelector("[data-ok]").addEventListener("click", ok);
    el.querySelector("[data-any]").addEventListener("click", () => { result = ""; modal.close(); });
    el.querySelector("[data-x]").addEventListener("click", () => modal.close());
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ok(); } });
    modal.onClose = () => resolve(result);
    modal.open();
    setTimeout(() => inp.focus(), 30);
  });
}

/** A small form. fields: [{k, label, sub, value, placeholder, type ("text" | "date" | "textarea" | "number"), quick: [[label, value]], required}].
 *  Resolves {k: value} (trimmed strings), or null when cancelled. extra: [[label, values]] buttons that save with those values set. */
function formDialog(title, hint, fields, okLabel = "Save", extra = []) {
  return new Promise((resolve) => {
    const escA = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    if (!obsidian || !obsidian.Modal) {
      const out = {};
      for (const f of fields) { const v = window.prompt(`${title} — ${f.label}${f.sub ? ` (${f.sub})` : ""}`, f.value || ""); if (v === null) { resolve(null); return; } out[f.k] = v.trim(); }
      resolve(out); return;
    }
    const modal = new obsidian.Modal(obsApp);
    let result = null;
    modal.titleEl.setText(title);
    const el = modal.contentEl;
    el.addClass("pt-time-modal");
    el.innerHTML = (hint ? `<div class="pt-muted pt-hint">${hint}</div>` : "")
      + fields.map((f) => `<div class="pt-time-field"><label><b>${f.label}</b>${f.sub ? `<span class="pt-muted">${f.sub}</span>` : ""}</label><div class="pt-time-input">`
        + (f.type === "textarea" ? `<textarea data-k="${f.k}" rows="3" placeholder="${escA(f.placeholder)}">${escA(f.value)}</textarea>` : `<input type="${f.type || "text"}" data-k="${f.k}" placeholder="${escA(f.placeholder)}" value="${escA(f.value)}"${f.type === "number" ? ` step="any"` : ""}>`)
        + (f.quick || []).map(([l, v], i) => `<button class="pt-mini" data-quick="${f.k}" data-v="${escA(v)}">${l}</button>`).join("")
        + `</div></div>`).join("")
      + `<div class="pt-actions"><button class="mod-cta" data-ok="1">${okLabel}</button>${extra.map(([l], i) => `<button data-extra="${i}">${l}</button>`).join("")}<button data-x="1">Cancel</button></div>`;
    const inp = (k) => el.querySelector(`[data-k="${k}"]`);
    el.querySelectorAll("button[data-quick]").forEach((b) => b.addEventListener("click", () => { inp(b.dataset.quick).value = b.dataset.v; }));
    const ok = (over = {}) => {
      const out = {};
      for (const f of fields) {
        const v = (inp(f.k).value || "").trim();
        if (f.required && !v) { inp(f.k).addClass("pt-bad"); inp(f.k).focus(); return; }
        out[f.k] = v;
      }
      result = Object.assign(out, over); modal.close();
    };
    el.querySelector("[data-ok]").addEventListener("click", () => ok());
    el.querySelectorAll("button[data-extra]").forEach((b) => b.addEventListener("click", () => ok(extra[Number(b.dataset.extra)][1])));
    el.querySelector("[data-x]").addEventListener("click", () => modal.close());
    el.querySelectorAll("input").forEach((x) => x.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ok(); } }));
    modal.onClose = () => resolve(result);
    modal.open();
    setTimeout(() => { const first = el.querySelector("[data-k]"); if (first) first.focus(); }, 30);
  });
}
function confirmDialog(title, text, okLabel) {
  return new Promise((resolve) => {
    if (!obsidian || !obsidian.Modal) { resolve(window.confirm(`${title}\n${text}`)); return; }
    const modal = new obsidian.Modal(obsApp);
    let result = false;
    modal.titleEl.setText(title);
    modal.contentEl.addClass("pt-time-modal");
    modal.contentEl.innerHTML = `<div class="pt-hint">${text}</div><div class="pt-actions"><button class="mod-warning" data-ok="1">${okLabel}</button><button data-x="1">Keep it</button></div>`;
    modal.contentEl.querySelector("[data-ok]").addEventListener("click", () => { result = true; modal.close(); });
    modal.contentEl.querySelector("[data-x]").addEventListener("click", () => modal.close());
    modal.onClose = () => resolve(result);
    modal.open();
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

  // Google Calendar: sync in the background (Home, when the last sync is old enough, and after a time is set)
  const calSync = async ({ quiet = true, force = false } = {}) => {
    if (!cfg.calendar_client_id || window.__ptrackCalBusy) return null;
    if (!force) {
      const mins = Number(cfg.calendar_sync_minutes) || 0;
      if (!mins || !(await core.gcalConnected(obsApp))) return null;
      const st = await core.gcalLoadState(obsApp);
      if (st.lastSync && Date.now() - new Date(st.lastSync).getTime() < mins * 60000) return null;
    }
    window.__ptrackCalBusy = true;
    try { const r = await core.syncCalendar(env, { quiet }); if (r && !quiet) notify(core.syncSummary(r)); return r; }
    catch (e) { console.error("[tracker] calendar", e); if (!quiet || /sign-in|connect/i.test(String(e.message))) notify(`Calendar: ${e.message || e}`); return null; } // offline: stay quiet
    finally { window.__ptrackCalBusy = false; }
  };
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
      try { await obsApp.fileManager.processFrontMatter(file, (f) => { f[sel.dataset.key] = /^\d+$/.test(sel.value) ? Number(sel.value) : sel.value; }); }
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

    root.querySelectorAll("button[data-cal]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "Syncing…";
      await calSync({ quiet: false, force: true });
      await draw();
    }));

    // Active projects: filter the cards as you type
    const filter = root.querySelector("input.pt-filter");
    if (filter) filter.addEventListener("input", () => {
      const q = filter.value.trim().toLowerCase();
      root.querySelectorAll(".pt-proj-card").forEach((c) => { c.style.display = !q || c.dataset.name.includes(q) || c.textContent.toLowerCase().includes(q) ? "" : "none"; });
    });

    // Home: reorder this week's projects (moves the goal lines in the week note)
    root.querySelectorAll("button[data-move]").forEach((b) => b.addEventListener("click", async () => {
      root.querySelectorAll("button[data-move]").forEach((x) => { x.disabled = true; });
      try { if (!(await core.moveGoal(obsApp, b.dataset.week, b.dataset.raw, Number(b.dataset.move)))) notify("Couldn't move it — the week note changed. Try again."); }
      catch (e) { console.error("[tracker]", e); notify(`Tracker: ${e.message || e}`); }
      await draw();
    }));

    // Project page: ＋ Add task (➕ created date, optional 📅 deadline)
    root.querySelectorAll("button[data-addtask]").forEach((b) => b.addEventListener("click", async () => {
      const m = window.moment, iso = (x) => x.format("YYYY-MM-DD");
      const v = await formDialog("＋ Add task", "Goes to the project's backlog with today's ➕ created date. One task per line.", [
        { k: "text", label: "Task", sub: "start with a verb", type: "textarea", placeholder: "Book the haul-out", required: true },
        { k: "due", label: "📅 Deadline", sub: "optional — leave empty for none", type: "date", quick: [["None", ""], ["Sunday", iso(m().endOf("isoWeek"))], ["Next Sunday", iso(m().add(1, "week").endOf("isoWeek"))], ["End of month", iso(m().endOf("month"))]] },
      ], "Add to backlog", [["Add to this week", { week: true }]]);
      if (!v) return;
      try { notify(await core.addProjectTask(env, b.dataset.path, v.text, { due: v.due, week: !!v.week })); }
      catch (e) { console.error("[tracker]", e); notify(`Tracker: ${e.message || e}`); }
      await draw();
    }));

    // Project page: objectives & key results
    root.querySelectorAll("button[data-okr]").forEach((b) => b.addEventListener("click", async () => {
      const act = b.dataset.okr, ds = b.dataset;
      let a = { raw: ds.raw };
      if (act === "add-o" || act === "edit-o") {
        const v = await formDialog(act === "add-o" ? "🎯 New objective" : "🎯 Edit objective", "Where do you want to be? Qualitative and motivating, one sentence — not a task, not a number.", [
          { k: "text", label: "Objective", value: ds.text || "", placeholder: "Sail confidently single-handed", required: true },
          { k: "by", label: "By", sub: "optional date", type: "date", value: ds.by || "" },
        ]);
        if (!v) return;
        Object.assign(a, v);
      } else if (act === "add-kr" || act === "edit-kr") {
        const v = await formDialog(act === "add-kr" ? "＋ Key result" : "Key result", "A number that shows the objective is reached — an outcome, not a task. Progress = (now − start) ÷ (target − start), so a target below the start works too.", [
          { k: "text", label: "Key result", value: ds.text || "", placeholder: "Solo outings", required: true },
          { k: "start", label: "Start", sub: "where you began (empty = 0)", type: "number", value: ds.start || "" },
          { k: "now", label: "Now", sub: "current value", type: "number", value: ds.now || "" },
          { k: "target", label: "Target", type: "number", value: ds.target || "" },
        ]);
        if (!v) return;
        Object.assign(a, v);
      } else if (act === "del-o" || act === "del-kr") {
        if (!(await confirmDialog(act === "del-o" ? "Remove objective?" : "Remove key result?", `“${(ds.text || "").replace(/</g, "&lt;")}”${act === "del-o" ? " and its key results" : ""} will be deleted from the note.`, "Remove"))) return;
      }
      root.querySelectorAll("button[data-okr]").forEach((x) => { x.disabled = true; });
      if (act === "check") b.textContent = "Checking…";
      try { const msg = await core.okrAction(env, act, ds.path, a, ds.i); if (msg) notify(msg); }
      catch (e) { console.error("[tracker]", e); notify(`Tracker: ${e.message || e}`); }
      await draw();
    }));

    // Project page: tasks vs goals, duplicates (local model)
    root.querySelectorAll("button[data-ai]").forEach((b) => b.addEventListener("click", async () => {
      root.querySelectorAll("button[data-ai]").forEach((x) => { x.disabled = true; });
      if (b.dataset.ai === "analyze") b.textContent = "Analyzing…";
      if (b.dataset.ai === "refine") b.textContent = "Refining…";
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
      const clock = row.querySelector('[data-act="clock"]');
      if (clock) clock.addEventListener("click", async () => {
        const title = (row.querySelector(".pt-task-text") || {}).textContent || "Task";
        const v = await clockDialog(core, title, clock.dataset.clock);
        if (v === null) return;
        const ok = await changeLine(row, async (line) => core.setClock(line, v));
        if (!ok) return;
        if (await core.gcalConnected(obsApp)) await calSync({ force: true });
        await draw();
      });
      const cancel = row.querySelector('[data-act="cancel"]');
      if (cancel) cancel.addEventListener("click", async () => {
        const title = (row.querySelector(".pt-task-text") || {}).textContent || "Task";
        const reason = await cancelDialog(title);
        if (reason === null) return;
        const file = obsApp.vault.getAbstractFileByPath(row.dataset.path);
        if (!file) { notify("Couldn't find that note any more."); return; }
        const lines = (await obsApp.vault.read(file)).split("\n");
        const i = locate(lines, Number(row.dataset.line), row.dataset.text);
        if (i < 0) { notify("Couldn't find that task any more — it may have been edited."); return; }
        try {
          const r = await core.cancelTask(obsApp, row.dataset.path, lines[i], i, window.moment().format("YYYY-MM-DD"), reason);
          if (!r.ok) { notify("That task isn't open any more."); return; }
          if (r.next) notify("Cancelled — the next occurrence is scheduled.");
          row.classList.add("is-cancelled");
          if (mode === "home") setTimeout(() => row.remove(), 500); else await draw();
        } catch (e) { console.error("[tracker]", e); notify(`Tracker: ${e.message || e}`); }
      });
      row.querySelector('[data-act="open"]').addEventListener("click", () => {
        obsApp.workspace.openLinkText(row.dataset.path, "", false, { eState: { line: Number(row.dataset.line) } });
      });
    });
  }
  await draw();
  if (mode === "home") { const r = await calSync(); if (r) await draw(); }
} catch (e) {
  console.error("[tracker]", e);
  root.innerHTML = `<div class="pt-error">Tracker view error: ${String(e.message || e).replace(/</g, "&lt;")}</div>`;
}
