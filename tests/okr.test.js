// Project page: ＋ Add task, and objectives & key results (with the model's check).
suite("okr", async ({ core, check, fresh }) => {
  globalThis.TODAY = "2026-11-20";
  const B = "Projects/personal/Blog/Blog.md";
  const files = fresh();
  const app = makeApp(files);
  const env = makeEnv(app);
  const sec = (name) => (files[B].split(`## ${name}\n`)[1] || "").split(/\n## /)[0];

  // ---- add task
  let msg = await core.addProjectTask(env, B, "Write the about page", { due: "2026-12-15" });
  check("added to the backlog with created and deadline", /^- \[ \] Write the about page ➕ 2026-11-20 📅 2026-12-15$/m.test(sec("Backlog")), sec("Backlog"));
  check("message", /Added “Write the about page” to the backlog · 📅 2026-12-15/.test(msg), msg);
  await core.addProjectTask(env, B, "- Fix typos\nCheck the [[Spanish]] links", {});
  check("several lines → several tasks, no deadline, links kept", /^- \[ \] Fix typos ➕ 2026-11-20$/m.test(sec("Backlog")) && /^- \[ \] Check the \[\[Spanish\]\] links ➕ 2026-11-20$/m.test(sec("Backlog")), sec("Backlog"));
  await core.addProjectTask(env, B, "Post on Mastodon", { week: true });
  check("this week → Planned with [week::]", /^- \[ \] Post on Mastodon \[week:: 2026-W47\] ➕ 2026-11-20$/m.test(sec("Planned")), sec("Planned"));
  let d = await core.loadAll(app);
  check("tracked: in the backlog count", d.byPath.get(B).backlog.some((t) => t.desc === "Write the about page"), "");
  let err = ""; try { await core.addProjectTask(env, B, "x", { due: "next week" }); } catch (e) { err = e.message; }
  check("bad deadline refused", /deadline must be a date/.test(err), err);
  let page = await core.render(app, "project", B, {});
  check("Add task button on the page", /data-addtask="1"/.test(page), "");

  // ---- OKRs
  check("empty card offers ＋ Objective", /data-okr="add-o"/.test(page) && !/data-okr="check"/.test(page), "");
  await core.okrAction(env, "add-o", B, { text: "Become a known voice on local AI", by: "2027-03-31" });
  check("section created above the task sections", /## Objectives\n- 🎯 Become a known voice on local AI \[by:: 2027-03-31\]\n\n## Planned/.test(files[B]) || files[B].indexOf("## Objectives") < files[B].indexOf("## Planned") && files[B].indexOf("## Objectives") > 0, files[B]);
  let okr = core.parseOkr(files[B].split("\n"));
  await core.okrAction(env, "add-kr", B, { raw: okr[0].raw, text: "Monthly readers", start: "100", now: "250", target: "1100" });
  await core.okrAction(env, "add-kr", B, { raw: okr[0].raw, text: "Write posts", target: "" });
  okr = core.parseOkr(files[B].split("\n"));
  check("key results nested under the objective", /^\t- Monthly readers \[start:: 100\] \[now:: 250\] \[target:: 1100\]$/m.test(files[B]) && /^\t- Write posts$/m.test(files[B]), sec("Objectives"));
  check("progress: (250-100)/(1100-100) = 15%, KR without target has none", okr[0].krs[0].progress === 15 && okr[0].krs[1].progress === null && okr[0].progress === 15, JSON.stringify(okr));
  check("objectives are not tasks", !(await core.loadAll(app)).byPath.get(B).backlog.some((t) => /readers/.test(t.desc)), "");
  await core.okrAction(env, "edit-kr", B, { raw: okr[0].krs[0].raw, text: "Monthly readers", start: "100", now: "600", target: "1100" });
  okr = core.parseOkr(files[B].split("\n"));
  check("update now → 50%", okr[0].krs[0].progress === 50, JSON.stringify(okr[0].krs[0]));
  // lower is better
  await core.okrAction(env, "add-kr", B, { raw: okr[0].raw, text: "Bounce rate %", start: "80", now: "70", target: "60" });
  okr = core.parseOkr(files[B].split("\n"));
  check("decreasing target works (50%)", okr[0].krs[2].progress === 50, JSON.stringify(okr[0].krs[2]));
  err = ""; try { await core.okrAction(env, "edit-kr", B, { raw: "- nope", text: "x" }); } catch (e) { err = e.message; } check("changed line refused", /changed/.test(err), err);
  err = ""; try { await core.okrAction(env, "edit-kr", B, { raw: okr[0].krs[2].raw, text: "x", target: "lots" }); } catch (e) { err = e.message; } check("non-number refused", /number/.test(err), err);
  page = await core.render(app, "project", B, {});
  check("card shows objective, progress and KRs", /🎯 Become a known voice on local AI/.test(page) && /600 \/ 1100/.test(page) && /no target/.test(page) && /data-okr="check"/.test(page), "");
  const act = await core.render(app, "active", null, {});
  check("Active projects shows OKR progress", /pt-okr-mini[^]*Become a known voice/.test(act), "");

  // ---- the model's check
  let body = null;
  env.request = async (o) => { body = JSON.parse(o.body); return { status: 200, text: JSON.stringify({ message: { content: JSON.stringify({
    verdict: "needs work", summary: "Good direction; one KR is an activity.",
    items: [{ id: "K1.2", problems: ["An activity, not an outcome", "No target"], rewrite: "Publish posts that get 200+ reads" }, { id: "O1", problems: ["fine"], rewrite: "Become a known voice on local AI" }, { id: "K9.9", problems: ["x"], rewrite: "" }],
    add: [{ objective: "O1", text: "Newsletter subscribers", target: 300, why: "audience" }, { objective: "K1.1", text: "bad", target: null, why: "" }] }) } }) }; };
  msg = await core.okrAction(env, "check", B);
  const prompt = body.messages[1].content;
  check("prompt has ids, numbers, rules", /O1: Become a known voice on local AI \(by 2027-03-31\)/.test(prompt) && /K1\.1: Monthly readers — start 100, now 600, target 1100/.test(prompt) && /K1\.2: Write posts — no numbers set/.test(prompt) && /2 to 5 key results/.test(prompt), prompt);
  check("message", /needs work · 2 to fix · 1 key result/.test(msg), msg);
  const st = JSON.parse(files["Tracker/AI/analysis.json"])[`okr:${B}`];
  check("unknown ids dropped, same wording = no rewrite", st.items.length === 2 && st.items[1].rewrite === "" && st.add.length === 1, JSON.stringify(st));
  page = await core.render(app, "project", B, {});
  check("diff + Apply shown for the rewrite", /<ins>/.test(page) && /data-okr="check-apply"/.test(page) && /Newsletter subscribers/.test(page), "");
  await core.okrAction(env, "check-apply", B, {}, 0);
  check("rewrite applied", /^\t- Publish posts that get 200\+ reads$/m.test(files[B]), sec("Objectives"));
  await core.okrAction(env, "check-add", B, {}, 0);
  check("suggested KR added with numbers", /^\t- Newsletter subscribers \[start:: 0\] \[now:: 0\] \[target:: 300\]$/m.test(files[B]), sec("Objectives"));
  page = await core.render(app, "project", B, {});
  check("changed since flagged", /the objectives changed since/.test(page), "");
  await core.okrAction(env, "check-skip", B, {}, 0);
  check("all handled", /All suggestions handled/.test(await core.render(app, "project", B, {})), "");
  await core.okrAction(env, "check-clear", B, {}, 0);
  check("cleared", !JSON.parse(files["Tracker/AI/analysis.json"])[`okr:${B}`], "");

  // ---- tasks-vs-goals analysis sees the OKRs
  env.request = async (o) => { body = JSON.parse(o.body); return { status: 200, text: JSON.stringify({ message: { content: JSON.stringify({ summary: "ok", missing: [], duplicates: [] }) } }) }; };
  await core.projectAction(env, "analyze", B);
  check("analysis prompt includes objective and key results", /Become a known voice/.test(body.messages[1].content) && /Monthly readers \(now 600, target 1100\)/.test(body.messages[1].content), body.messages[1].content);

  // ---- delete
  okr = core.parseOkr(files[B].split("\n"));
  await core.okrAction(env, "del-kr", B, { raw: okr[0].krs[0].raw });
  check("KR removed", !/Monthly readers/.test(files[B]) && /Bounce rate/.test(files[B]), "");
  await core.okrAction(env, "del-o", B, { raw: okr[0].raw });
  check("objective removed with its KRs", core.parseOkr(files[B].split("\n")).length === 0 && !/Bounce rate/.test(files[B]), sec("Objectives"));
  check("new project notes have the section", /## Objectives\n\n## Planned/.test(core.projectNote({ name: "X", scope: "personal", status: "active", today: "2026-11-20" })), "");
});
