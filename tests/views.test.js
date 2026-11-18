// Every view renders on the sample vault; priorities; active projects; routine time.
suite("views", async ({ core, check, fresh }) => {
  globalThis.TODAY = "2026-11-09";
  const files = fresh(), app = makeApp(files);
  for (const [mode, path] of [["home", "Tracker/Home.md"], ["week", "Tracker/Weeks/2026-W46.md"], ["project", "Projects/personal/Blog/Blog.md"], ["project", "Projects/personal/Personal routines/Personal routines.md"], ["analytics", "Tracker/Analytics.md"], ["projects", "Tracker/Projects.md"], ["active", "Tracker/Active projects.md"], ["classified", "Tracker/Classified inbox.md"]]) {
    let h = "", err = "";
    try { h = await core.render(app, mode, path, { tasks: [] }); } catch (e) { err = String(e.stack || e); }
    check(`renders: ${mode} ${path.split("/").pop()}`, !err && h.length > 100 && !/undefined|NaN/.test(h.replace(/data-[\w-]+="[^"]*"/g, "")), err || (h.match(/.{60}(undefined|NaN).{60}/) || [h.slice(0, 200)])[0]);
  }
  const act = await core.render(app, "active", "Tracker/Active projects.md", {});
  const names = [...act.matchAll(/pt-proj-card[^>]*>\s*<div class="pt-card-head"><a[^>]*>([^<]+)</g)].map((m) => m[1]);
  check("Active projects by priority", JSON.stringify(names) === '["Sailing","Home renovation","Blog","Family trip"]', names);
  const pj = await core.render(app, "project", "Projects/personal/Blog/Blog.md", {});
  check("project page ← / →", /← Home renovation/.test(pj) && /Active projects · 3\/4/.test(pj) && /Family trip →/.test(pj), pj.slice(0, 500));
  const d = await core.loadAll(app);
  const w43 = d.routines.find((x) => x.name === "Inbox zero").weeks.get("2026-W43");
  check("routine time: logged, else the estimate", w43.mins === 35 + 20 * (w43.done - 1), JSON.stringify(w43));
  check("priorities: numbers and old words", core.normPriority("high") === 2 && core.normPriority(5) === 5 && core.normPriority("") === 3, "");
});
