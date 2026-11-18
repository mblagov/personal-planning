// Minimal Obsidian stand-in for ptrack.js under jsc. Loaded after moment.min.js.
globalThis.console = { log: (...a) => print("log:", ...a), error: (...a) => print("error:", ...a.map(String)), warn: () => {} };
const realMoment = globalThis.moment;
globalThis.moment = Object.assign((...a) => (a.length ? realMoment(...a) : realMoment(globalThis.TODAY, "YYYY-MM-DD")), realMoment);
globalThis.window = { moment: globalThis.moment };
globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
function parseYaml(src) {
  const out = {}; let key = null;
  const val = (v) => {
    v = v.trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
    if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map((x) => val(x)).filter((x) => x !== "");
    if (v === "true") return true; if (v === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };
  for (const l of src.split("\n")) {
    let m;
    if ((m = l.match(/^\s+-\s+(.*)$/)) && key) { if (!Array.isArray(out[key])) out[key] = []; out[key].push(val(m[1])); continue; }
    if ((m = l.match(/^([\w-]+):\s*(.*)$/))) { key = m[1]; out[key] = m[2] === "" ? null : val(m[2]); }
  }
  return out;
}
function dumpYaml(o) { return Object.entries(o).map(([k, v]) => Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${v === null ? "" : typeof v === "string" && (v === "" || /[:#]/.test(v)) ? JSON.stringify(v) : v}`).join("\n"); }
function makeApp(files) {
  const folders = new Map(), tfiles = new Map();
  const folder = (p) => { if (!folders.has(p)) { const parts = p.split("/"); const f = { path: p, name: parts[parts.length - 1], children: [], parent: null }; folders.set(p, f); if (p) { f.parent = folder(parts.slice(0, -1).join("/")); f.parent.children.push(f); } } return folders.get(p); };
  folder("");
  const tf = (p) => { if (!tfiles.has(p)) { const parts = p.split("/"), name = parts[parts.length - 1]; const f = { path: p, name, basename: name.replace(/\.\w+$/, ""), extension: name.split(".").pop(), parent: folder(parts.slice(0, -1).join("/")), stat: { mtime: 1 } }; f.parent.children.push(f); tfiles.set(p, f); } return tfiles.get(p); };
  for (const p of Object.keys(files)) tf(p);
  const fm = (c) => { const m = String(c).match(/^---\n([\s\S]*?)\n---/); return m ? parseYaml(m[1]) : undefined; };
  const vault = {
    getName: () => "vault",
    getAbstractFileByPath: (p) => (files[p] !== undefined ? tf(p) : folders.get(p) || null),
    getMarkdownFiles: () => Object.keys(files).filter((p) => p.endsWith(".md")).map(tf),
    getRoot: () => folder(""),
    read: async (f) => files[f.path], cachedRead: async (f) => files[f.path],
    modify: async (f, c) => { files[f.path] = c; },
    create: async (p, c) => { files[p] = c; return tf(p); },
    createFolder: async (p) => folder(p),
    process: async (f, fn) => { files[f.path] = fn(files[f.path]); return files[f.path]; },
    delete: async (f) => { delete files[f.path]; },
    adapter: { read: async (p) => files[p], write: async (p, c) => { files[p] = c; tf(p); }, exists: async (p) => files[p] !== undefined || folders.has(p), mkdir: async (p) => folder(p), remove: async (p) => { delete files[p]; } },
  };
  return {
    vault,
    metadataCache: { getFileCache: (f) => ({ frontmatter: fm(files[f.path]) }), getFirstLinkpathDest: (l) => { const k = Object.keys(files).find((p) => p.endsWith("/" + l + ".md") || p === l + ".md"); return k ? tf(k) : null; }, fileToLinktext: (f) => f.basename },
    fileManager: {
      processFrontMatter: async (f, fn) => { const c = files[f.path]; const m = c.match(/^---\n([\s\S]*?)\n---\n?/); const o = m ? parseYaml(m[1]) : {}; fn(o); files[f.path] = `---\n${dumpYaml(o)}\n---\n` + (m ? c.slice(m[0].length) : c); },
      generateMarkdownLink: (f) => `[[${f.basename}]]`,
    },
    workspace: { activeEditor: null, getLeaf: () => ({ openFile: async () => {} }) },
    plugins: { plugins: {} },
  };
}
/** Env with scripted answers: a list of [regex on the question, answer]. Suggest answer = text in a label; null = Esc. */
function makeEnv(app, script = []) {
  const log = [];
  const take = (kind, q) => {
    const i = script.findIndex(([re]) => re.test(q));
    if (i < 0) throw new Error(`unexpected ${kind}: ${q}`);
    const a = script.splice(i, 1)[0][1]; log.push(`${kind}: ${q} → ${a === null ? "Esc" : a}`); return a;
  };
  return {
    app, isMobile: false, moment: globalThis.moment, log,
    prompt: async (q, def) => { const a = take("prompt", q); return a === "=" ? def : a; },
    suggest: async (labels, values, q) => { const a = take("suggest", q); if (a === null) return null; const i = labels.findIndex((l) => String(l).includes(a)); if (i < 0) throw new Error(`no "${a}" in ${labels.join(" | ")} (${q})`); return values[i]; },
    notice: (m) => log.push(`notice: ${m}`), request: async () => ({ status: 500, text: "" }), open: async () => {}, openUrl: () => {},
  };
}
function loadCore(BUNDLE) { const mod = { exports: {} }; new Function("module", "exports", BUNDLE["Tracker/Scripts/ptrack.js"])(mod, mod.exports); return mod.exports.core; }
function suite(name, fn) {
  const BUNDLE = JSON.parse(read(arguments_[0]));
  const core = loadCore(BUNDLE);
  const out = []; let failed = 0;
  const check = (n, c, d) => { out.push(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "\n      " + String(typeof d === "object" ? JSON.stringify(d) : d).split("\n").join("\n      ")}`); if (!c) failed++; };
  const fresh = () => { const f = {}; for (const k of Object.keys(BUNDLE)) if (k.endsWith(".md")) f[k] = BUNDLE[k]; return f; };
  fn({ core, check, fresh, BUNDLE }).then(() => { out.push("", failed ? `${failed} FAILED` : "ALL PASSED"); print(out.join("\n")); }, (e) => { out.push("CRASH: " + e + "\n" + e.stack); print(out.join("\n")); });
}
var arguments_ = typeof arguments !== "undefined" ? arguments : [];
