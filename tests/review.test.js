// Weekly review: ← Back everywhere, nothing written before Save, Cancel changes nothing.
suite("review", async ({ core, check, fresh, BUNDLE }) => {
  globalThis.TODAY = "2026-11-15";
  const W = "Tracker/Weeks/2026-W46.md";
  const same = (files) => Object.keys(BUNDLE).every((k) => !k.endsWith(".md") || /routines/.test(k) || files[k] === BUNDLE[k]);
  let files = fresh(), app = makeApp(files);
  let env = makeEnv(app, [[/Sailing.*tasks done/, "Achieved"], [/Sailing: \d+ unfinished/, "Leave"], [/Blog.*tasks done/, "Achieved"], [/Blog: \d+ unfinished/, "Leave"], [/Home renovation.*tasks done/, "Achieved"], [/Home renovation: \d+ unfinished/, "Leave"], [/Wins/, ""], [/got in the way/, ""], [/Energy/, "Skip"], [/Summary/, "No summary"], [/save\?/, "Cancel"]]);
  await core.run(env, "review", "2026-W46", { thenPlan: false });
  check("Cancel at the end → nothing changed", same(files) && !env.log.some((l) => /Tracker:/.test(l)), env.log.join("\n"));
  files = fresh(); app = makeApp(files);
  let snap = null;
  env = makeEnv(app, [
    [/1\/3 · Sailing.*tasks done/, "Partly"], [/Sailing: how far/, null], [/1\/3 · Sailing.*now: Partly/, "Missed"],
    [/Sailing: main reason/, "Blocked"], [/Sailing: \d+ unfinished/, "← Back"], [/Sailing: main reason.*now: Blocked/, "No time"], [/Sailing: \d+ unfinished/, "Return"],
    [/Blog.*tasks done/, "Achieved"], [/Blog: \d+ unfinished/, "Leave"],
    [/Home renovation.*tasks done/, "Partly"], [/Home renovation: how far/, "60"], [/Home renovation: main reason/, "Other"], [/Home renovation: reason/, "contractor sick"], [/Home renovation: \d+ unfinished/, "Plan"],
    [/Wins/, "w1"], [/got in the way/, null], [/Wins/, "w2"], [/got in the way/, "lessons"], [/Energy/, "4"], [/Summary/, "No summary"],
    [/save\?/, "← Back"], [/Summary/, "No summary"], [/save\?/, "Save"]]);
  const sug = env.suggest; env.suggest = async (l, v, q) => { if (/save\?/.test(q) && !snap) snap = Object.assign({}, files); return sug(l, v, q); };
  await core.run(env, "review", "2026-W46", { thenPlan: false });
  check("no errors", !env.log.some((l) => /Tracker:|unexpected/.test(l)), env.log.join("\n"));
  check("nothing written before Save", snap && same(snap), "");
  const goal = (n) => files[W].split("\n").find((l) => l.includes(`[[${n}]]`) && l.includes("🎯"));
  check("answers after Back are the ones saved", /\[result:: 0\].*\[miss:: no-time\]/.test(goal("Sailing")) && /\[result:: 100\]/.test(goal("Blog")) && /\[result:: 60\]/.test(goal("Home renovation")) && /- Wins:: w2/.test(files[W]), goal("Sailing"));
});
