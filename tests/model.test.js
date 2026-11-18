// Local model: streaming into the progress panel, timing, batching, Stop.
suite("model", async ({ core, check, fresh }) => {
  globalThis.TODAY = "2026-11-13";
  const itemAns = (extra) => Object.assign({ kind: "task", project: "P1", topic: "none", new_topic: "", amount: 0, currency: "", date: "", category: "", priority: "medium", confidence: 0.9, due: "" }, extra || {});
  const answerFor = (body) => {
    const u = body.messages[1].content;
    if (/^Items:/m.test(u)) { const n = (u.match(/^\d+\. "/gm) || []).length; return { items: Array.from({ length: n }, (_, i) => itemAns({ n: i + 1 })) }; }
    if (/^Notes:/m.test(u)) return { items: [Object.assign({ text: "Visit the Naschmarkt", details: "" }, itemAns({ kind: "reference", project: "none", topic: "new", new_topic: "Travel" }))] };
    return itemAns();
  };
  // parsing streams
  const st = { buf: "", content: "", thinking: "", stats: null };
  const lines = [{ message: { thinking: "Hmm, " } }, { message: { thinking: "a boat task." } }, { message: { content: '{"kind":' } }, { message: { content: '"task"}' } }, { done: true, prompt_eval_count: 3100, prompt_eval_duration: 12e9, eval_count: 85, eval_duration: 3e9, load_duration: 4e9 }].map((o) => JSON.stringify(o) + "\n").join("");
  core.feedStream(st, lines.slice(0, 37), true); core.feedStream(st, lines.slice(37), true);
  check("stream: content, thinking and stats across chunk borders", st.content === '{"kind":"task"}' && st.thinking === "Hmm, a boat task." && st.stats.promptTok === 3100, JSON.stringify(st));
  check("stats text", core.statsText(st.stats) === "prompt 3.1k tok 12s · answer 85 tok 3.0s · loading the model 4.0s", core.statsText(st.stats));
  const sse = { buf: "", content: "", thinking: "", stats: null };
  core.feedStream(sse, 'data: {"choices":[{"delta":{"content":"{\\"a\\""}}]}\n\ndata: {"choices":[{"delta":{"content":":1}"}}]}\n\ndata: [DONE]\n', false);
  check("stream: OpenAI-style server-sent events", sse.content === '{"a":1}', sse.content);
  check("panel text: count, elapsed, time left", JSON.stringify(core.jobText({ title: "T", total: 4, i: 3, label: "x", t0: 0, tDone: 20000 }, 25000)) === '{"title":"T","count":"3/4","label":"x","time":"⏱ 25s · about 15s left","pct":50}', "");

  // a whole inbox run, streamed (Mac), batched
  let files = fresh(), app = makeApp(files);
  const env = makeEnv(app); const bodies = []; let panel = null;
  env.progressUI = (job) => { panel = { job, outs: [], update() {}, output() { panel.outs.push(job.output); }, close() { panel.closed = true; } }; return panel; };
  env.streamPost = async (url, body, onData) => {
    const b = JSON.parse(body); bodies.push(b);
    const text = JSON.stringify(answerFor(b)), half = Math.floor(text.length / 2);
    onData(JSON.stringify({ message: { content: text.slice(0, half) } }) + "\n");
    onData(JSON.stringify({ message: { content: text.slice(half) } }) + "\n" + JSON.stringify({ done: true, prompt_eval_count: 2000, prompt_eval_duration: 5e9, eval_count: 100, eval_duration: 2e9 }) + "\n");
    return { status: 200, text: "" };
  };
  await core.run(env, "classify");
  check("inbox: no errors", !env.log.some((l) => /Tracker:/.test(l)), env.log.join("\n"));
  const items = bodies.filter((b) => /^Items:/m.test(b.messages[1].content));
  check("the 5 inbox tasks went in one request", items.length === 1 && (items[0].messages[1].content.match(/^\d+\. "/gm) || []).length === 5, bodies.length);
  check("request: stream, think off, keep_alive, num_ctx", bodies.every((b) => b.stream === true && b.think === false && b.keep_alive === "30m" && b.options.num_ctx === 8192), JSON.stringify(bodies[0]).slice(0, 300));
  check("panel shows the text while it arrives, then whole", panel.outs.some((o) => /^\{"items":\[\{/.test(o) && !/\]\}$/.test(o)) && panel.outs.some((o) => /\]\}$/.test(o)) && panel.closed, panel.outs.slice(0, 2).join("\n"));
  check("panel results: a line per item + the request's timing", panel.job.results.filter((x) => /^✓ .* → task · /.test(x)).length >= 5 && panel.job.results.some((x) => /5 items in one request · prompt 2.0k tok 5.0s/.test(x)), panel.job.results.join("\n"));
  check("summary notice: requests and time per item", env.log.some((l) => /Model: \d+ request\(s\) for \d+ item\(s\)/.test(l)), env.log.join("\n"));
  check("all tasks sorted", (files["Tracker/Classified inbox.md"].split("## Tasks")[1].split("## Ideas")[0].match(/\[to:: \[\[\w+\]\]\]/g) || []).length === 5, files["Tracker/Classified inbox.md"]);

  // iPhone-like (no streaming): a batch answer that skips an item → that item alone
  files = fresh(); app = makeApp(files);
  const env2 = makeEnv(app); const b2 = [];
  env2.request = async (o) => { const b = JSON.parse(o.body); b2.push(b); const a = answerFor(b); if (a.items && a.items[0] && a.items[0].n) a.items.pop(); return { status: 200, text: JSON.stringify({ message: { content: JSON.stringify(a) }, prompt_eval_count: 10 }) }; };
  await core.run(env2, "classify");
  check("a skipped item is asked about on its own", b2.filter((b) => /^Item: /m.test(b.messages[1].content)).length === 1 && !env2.log.some((l) => /Tracker:/.test(l)), env2.log.join("\n"));
  // older Ollama: no "think"
  files = fresh(); app = makeApp(files);
  const env3 = makeEnv(app); const b3 = [];
  env3.request = async (o) => { const b = JSON.parse(o.body); b3.push(b); if (b.think !== undefined) return { status: 400, text: "invalid think" }; return { status: 200, text: JSON.stringify({ message: { content: JSON.stringify(answerFor(b)) } }) }; };
  await core.run(env3, "classify");
  check("server without 'think': retried without it", b3.some((b) => b.think === undefined) && !env3.log.some((l) => /Tracker:/.test(l)), env3.log.join("\n"));

  // Stop while the model works: request cut off, nothing more asked, rest listed unsorted
  files = fresh(); app = makeApp(files);
  const env4 = makeEnv(app); let calls = 0, aborted = false, pj = null;
  env4.progressUI = (job) => { pj = job; return { update() {}, output() {}, close() {} }; };
  env4.streamPost = (url, body, onData, onAbort) => { calls++; if (calls === 1) { const t = JSON.stringify(answerFor(JSON.parse(body))); onData(JSON.stringify({ message: { content: t } }) + "\n"); return Promise.resolve({ status: 200 }); } onAbort(() => { aborted = true; }); Promise.resolve().then(() => pj.stop()); return new Promise(() => {}); };
  await core.run(env4, "classify");
  check("Stop: request aborted, no more calls, no error", aborted && calls === 2 && !env4.log.some((l) => /Tracker:/.test(l)), `${aborted} ${calls}\n${env4.log.join("\n")}`);
  check("Stop: what was sorted is kept, the rest listed unsorted", /\[to:: \[\[\w+\]\]\]/.test(files["Tracker/Classified inbox.md"]) && /\[to:: none\]/.test(files["Tracker/Classified inbox.md"]) && env4.log.some((l) => /Stopped — \d+ item/.test(l)), env4.log.join("\n"));
  check("env.job cleared", !env4.job, "");
});
