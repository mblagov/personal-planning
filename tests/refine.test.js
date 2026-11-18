// Refine backlog: proposals shown as diffs, applied one by one only when confirmed.
suite("refine", async ({ core, check, fresh }) => {
  globalThis.TODAY = "2026-11-13";
  const B = "Projects/personal/Blog/Blog.md";
  const files = fresh();
  files[B] = files[B].replace("- [ ] Draft a post on local LLMs for note sorting", "- [ ] Draft a post on local LLMs for note sorting\n- [ ] write something about llms sorting notes ⏫\n\t- see the Ollama docs\n- [ ] site stuff #web 📅 2026-12-01");
  const app = makeApp(files);
  const before = files[B];
  const env = makeEnv(app); let body = null;
  env.request = async (o) => { body = JSON.parse(o.body); return { status: 200, text: JSON.stringify({ message: { content: JSON.stringify({
    duplicates: [{ tasks: ["T3", "T4"], merged: "Draft a post on sorting notes with local LLMs", why: "same post" }],
    rewrites: [{ task: "T5", text: "Fix the broken links on the site #web", why: "vague" }, { task: "T4", text: "ignored: in a merge", why: "" }, { task: "T1", text: "Update the site theme", why: "same" }] }) } }) }; };
  let msg = await core.projectAction(env, "refine", B);
  const prompt = body.messages[1].content;
  check("prompt lists the backlog only", /T1: Update the site theme/.test(prompt) && /T5: site stuff #web/.test(prompt) && !/Write the first draft/.test(prompt), prompt);
  check("proposal: 1 merge + 1 rewording (unchanged and merged ones dropped)", /1 rewording\(s\), 1 merge\(s\)/.test(msg), msg);
  check("nothing changed in the note yet", files[B] === before, "");
  let page = await core.render(app, "project", B, {});
  check("diff view: removed words struck, added words marked", /<div class="pt-diff-old">− site <del>stuff<\/del> #web<\/div>/.test(page) || /− <del>site stuff<\/del>/.test(page), (page.match(/<div class="pt-diff">[\s\S]*?<\/div><\/div>/) || [""])[0].slice(0, 900));
  check("each change has Apply and Skip", (page.match(/data-ai="refine-apply"/g) || []).length === 2 && (page.match(/data-ai="refine-skip"/g) || []).length === 2, "");
  check("word diff", JSON.stringify(core.wordDiff("site stuff #web", "Fix the links on the site #web")) === JSON.stringify(["site <del>stuff</del> #web", "<ins>Fix the links on the</ins> site #web"]), JSON.stringify(core.wordDiff("site stuff #web", "Fix the links on the site #web")));
  // apply the rewording (index of the rewrite)
  const st = JSON.parse(files["Tracker/AI/analysis.json"])[`refine:${B}`];
  const ri = st.changes.findIndex((c) => c.type === "rewrite"), mi = st.changes.findIndex((c) => c.type === "merge");
  msg = await core.projectAction(env, "refine-apply", B, ri);
  check("rewording applied, tag/due date kept", /^- \[ \] Fix the broken links on the site #web 📅 2026-12-01$/m.test(files[B]) && !/site stuff/.test(files[B]), files[B].split("## Backlog")[1]);
  // the merge is still pending (index shifted)
  const left = JSON.parse(files["Tracker/AI/analysis.json"])[`refine:${B}`].changes;
  check("other proposal still waiting", left.length === 1 && left[0].type === "merge", JSON.stringify(left));
  // edit one of the merge's lines → stale, apply refused
  const saved = files[B];
  files[B] = files[B].replace("- [ ] write something about llms sorting notes ⏫", "- [ ] write something about LLMs sorting notes ⏫");
  page = await core.render(app, "project", B, {});
  check("changed since → marked and Apply disabled", /changed since — skip or refine again/.test(page) && /data-ai="refine-apply"[^>]*disabled/.test(page), "");
  let err = ""; try { await core.projectAction(env, "refine-apply", B, 0); } catch (e) { err = e.message; }
  check("apply refused on changed lines", /changed since/.test(err), err);
  files[B] = saved;
  await core.projectAction(env, "refine-apply", B, 0);
  check("merge applied: one task, the other noted under it with its sub-item", /^- \[ \] Draft a post on sorting notes with local LLMs$/m.test(files[B]) && /^\t- \(merged\) write something about llms sorting notes$/m.test(files[B]) && /^\t\t- see the Ollama docs$/m.test(files[B]) && !/^- \[ \] write something/m.test(files[B]), files[B].split("## Backlog")[1]);
  check("all done → card back to its start", !JSON.parse(files["Tracker/AI/analysis.json"])[`refine:${B}`], "");
  // skip
  await core.projectAction(env, "refine", B);
  const n0 = JSON.parse(files["Tracker/AI/analysis.json"])[`refine:${B}`].changes.length;
  const snap = files[B];
  await core.projectAction(env, "refine-skip", B, 0);
  check("Skip changes nothing in the note", files[B] === snap && ((JSON.parse(files["Tracker/AI/analysis.json"])[`refine:${B}`] || { changes: [] }).changes.length === n0 - 1), "");
});
