# Tracker — start here

Weekly goals for many projects: pick 5–7 projects a week, set one goal each, plan dated tasks under each goal (Tasks plugin), sort an inbox with a local LLM (Ollama on the Mac, Apple's on-device model on the iPhone), and review progress every week.

Everything lives in this `Tracker` folder. Your project folders stay where they are.

---

## 1. Put the folder in your vault (Mac)

1. Unzip `obsidian-tracker.zip`. You get one folder: `Tracker`.
2. Move `Tracker` into the **top level of your vault** — the folder that also contains your other top-level folders (and the hidden `.obsidian` folder). Not inside another folder.
   - Easy way to find the vault in Finder: in Obsidian, right-click any note at the top of the file list → **Reveal in Finder**.
   - An iCloud vault on the Mac is under *iCloud Drive → Obsidian → (your vault)*.
3. Check: in Obsidian you should now see `Tracker/Home.md`, `Tracker/Config.md`, `Tracker/Commands/…`. If you see `Tracker/Tracker/…`, move the inner folder up one level.

## 2. Plugins (Mac — they sync to the iPhone)

Settings → Community plugins → Browse. Install and enable:

**Dataview**
- Settings → Dataview → turn on **Enable JavaScript queries**.

**Templater**
- Settings → Templater → **Template hotkeys** → add these seven files, one per row:
  `Tracker/Commands/Capture.md`, `Process inbox.md`, `Plan week.md`, `Plan project.md`, `Weekly review.md`, `New project.md`, `Register projects.md`
- That's all. You do **not** need to set a template folder or a script folder.
- Optional: Settings → Hotkeys → search "Tracker/Commands" to give them keyboard shortcuts.

**Tasks**
- Defaults are fine. Keep **Set done date on every completed task** on — the analytics use the ✅ date.
- If you set a *Global task filter* (e.g. `#task`), put the same tag in `task_tag` in `Tracker/Config`.

## 3. First run (Mac)

1. Open `Tracker/Home`. The buttons at the top run the commands. (Commands need an open note — Home is the natural place. You can also use Cmd+P and type the command name.)
2. Click **Register projects** (or Cmd+P → "Register projects").
   - It asks **which folders hold your project folders** — pick e.g. your personal projects folder, then your common projects folder, then *Done*. It saves this in Config, so you never type a path.
   - Then for each project folder: *Active*, *Backlog*, *Not a project*, or *Stop for now*.
   - **Root note**: a note with the same name as the folder (e.g. `Sailing/Sailing.md`) is used automatically. Otherwise you choose: **create a new note** named after the folder, **create a new note with another name**, or use one of the notes already in the folder. Empty folders get a new note named after the folder.
   - The root note gets the tracker properties, a small dashboard, and `## Planned` / `## Backlog` / `## Notes & ideas` sections. Your other notes in the folder aren't touched. The project is always named after its folder.
   - Projects that are already registered get any missing section (and the dashboard) added — no questions. Run Register once after updating the tracker to add `## Planned` everywhere.
   - Folders you mark *Not a project* are remembered (`ignored_folders` in Config) and not asked about again.
   - Safe to run again later — it only asks about new folders.
3. Give each active project a one-line **description** (note properties). The inbox classifier reads these; good descriptions matter more than the model.
4. Click **Plan week**.

## 4. Local LLM on the Mac (Ollama)

1. Download Ollama from ollama.com and open it. It runs in the menu bar.
2. In Terminal:
   ```
   ollama pull qwen2.5:7b-instruct
   ```
   About 5 GB. With 32 GB of RAM or more, `qwen2.5:14b-instruct` sorts a bit better; put the name you pulled in `llm_model` in `Tracker/Config`.
3. Check it's running: open http://localhost:11434 in a browser — it says "Ollama is running".
4. In Obsidian, put something in the inbox and run **Process inbox**.

LM Studio works too: start its local server, set `llm_provider: openai` and `llm_url: http://localhost:1234/v1`.

## 5. iPhone

### Sync
- **iCloud vault**: nothing to do. The `Tracker` folder, the plugins and their settings (including the Templater hotkeys) sync with the vault. Give iCloud a few minutes after the first copy.
- **Obsidian Sync**: on both devices, Settings → Sync → turn on *Installed community plugins*, *Active community plugin list* and *Community plugin settings*.
- On the iPhone, open Settings → Community plugins and check that Dataview, Templater and Tasks are **on**. If restricted mode is on there, turn it off and enable them.

### Running commands on the iPhone
- Open `Tracker/Home` and tap the buttons, or
- Pull down for the command palette and type "Capture" / "Plan week", or
- Put them on the toolbar: Settings → Toolbar (Mobile) → add *Templater: Insert Tracker/Commands/Capture.md* (and any others you use often).
- Tip: pin `Tracker/Home` or bookmark it so it's one tap away.

Everything works on the iPhone — capture, planning with dates, review, all dashboards and Tasks queries. For inbox **classification** on the phone, set up Apple's on-device model below.

### The local LLM on the iPhone (Apple's on-device model)

The iPhone uses Apple's own on-device model (Apple Intelligence). It runs entirely on the phone, works offline, and costs nothing. Obsidian can't run a model itself, so it hands the work to the **Shortcuts** app and gets the answers back through a file in your vault.

**You need:** an iPhone 15 Pro / 15 Pro Max, or any iPhone 16 or newer, on a current iOS, with Apple Intelligence turned on (Settings → Apple Intelligence & Siri). The model downloads by itself after you turn it on. On other iPhones, or to choose your own model, see *No Apple Intelligence* below.

**Build the shortcut once (about 5 minutes).** Shortcuts app → **+** → name it exactly **Tracker Classify**. Add these actions in order (search for each name):

1. **Get File from Folder**
   - Folder: tap it and choose your vault folder (iCloud Drive → Obsidian → *your vault*, or On My iPhone → Obsidian → *your vault*).
   - File path: `Tracker/AI/request.json`
2. **Get Dictionary from Input**. Its input is the *File* from step 1.
3. **Get Dictionary Value**: Get *Value* for `prompts` in *Dictionary*.
4. **Repeat with Each** item in *Dictionary Value*.
5. Inside the repeat: **Use Model**
   - Model: **On-Device**
   - Prompt: tap and insert the *Repeat Item* variable — nothing else.
   - Tap the ⌄ arrow: **Follow Up** off; **Output**: Text.
6. After **End Repeat**: **Combine Text**
   - Combine *Repeat Results* with **Custom** separator: `#####`
7. **Save File**
   - Save *Combined Text*. Tap ⌄: **Ask Where to Save** off.
   - Destination: your vault folder (same as step 1). Subpath: `Tracker/AI/response.txt`
   - **Overwrite If File Exists**: on.
8. **Open App**: Obsidian.

**No Apple Intelligence, or prefer your own model?** Use an app that runs open models (Qwen, Gemma, Llama…) on the iPhone and adds a Shortcuts action. Build the same shortcut, but in step 5 use that app's action instead of **Use Model**:
- **Locally AI** (free, by LM Studio, iOS 18.1+). In the app, download a model first:
  - iPhones with 6 GB of RAM (e.g. 14 Pro): a ~1.7B model such as Qwen 3 1.7B.
  - iPhones with 8 GB or more (15 Pro and newer): a 3–4B model such as Qwen 3 4B or Gemma.
  - Then add its Shortcuts action (search "Locally" in the action list), choose that model, and pass *Repeat Item* as the prompt.
- **Private LLM** ($4.99, iOS 17+) works the same way with its own Shortcuts action.
- If the app offers a "thinking" or reasoning mode, turn it off. It only slows things down. (The tracker ignores `<think>` text anyway.)

Everything else stays the same: the request and response files, the `#####` separator, and `llm_mobile: shortcut`.

**Turn it on:** in `Tracker/Config`, set `llm_mobile` to `shortcut`.

**Use it:**
1. On the iPhone, tap **Process inbox**. Obsidian writes the items to `Tracker/AI/request.json` and opens the shortcut.
2. The model sorts each item, taking a few seconds per item. Then the shortcut switches back to Obsidian.
3. Tap **Process inbox** again. It applies the answers and walks you through filing, exactly as on the Mac. Items it's very sure about are filed automatically.

The first run asks for a few permissions. Allow each one, choosing *Always Allow* where offered:
- Obsidian opening Shortcuts
- the shortcut reading and saving files in your vault folder

Good to know:
- Apple's on-device model is smaller than the one on your Mac, so short, clear project **descriptions** matter even more here.
- The Mac keeps using Ollama (`llm_url`). The two devices don't talk to each other.
- The weekly review's optional AI summary is offered only on the Mac. Apple's model isn't wired to it.
- If you'd rather not use AI on the phone, leave `llm_mobile: off`. Process inbox then lets you file items by hand.

## 6. Planning with dates (Tasks plugin)

Tasks use the Tasks plugin's emoji format: `📅` due · `⏳` scheduled · `🛫` start · `➕` created · `✅` done · `⏫ 🔼 🔽` priority · `🔁` repeat.

- **Where planned tasks live**: in their **project note**, in the `## Planned` section, marked with the week: `- [ ] Call marina [week:: 2026-W46] ⏳ 2026-11-10`. Nothing is copied into the week note.
- **Plan project** (button on every project page, or the command): choose **this week** or **next week**, optionally write the project's goal for that week, then pick tasks from its `## Backlog` or type new ones. Picked tasks move from Backlog to Planned. For each task you choose a day (Mon–Sun, or no date) — that sets the **⏳ scheduled** date. Existing due dates are kept.
- **Plan week** does the same for several projects in one go: pick a project → write the goal → pick its tasks → next project.
- **The week note** is the common view: under each goal it lists every task picked for that week in that project, with progress, and you can tick (☐), edit (✎) and open (↗) them there. Projects with picked tasks but no goal are listed too, marked *no goal*.
- **Any other dates**: put the cursor on a task and run **Tasks: Create or edit task** (Cmd+P, or the command palette on iPhone). It opens a form for due, scheduled and start dates, priority and recurrence. You can also type the emojis directly, including in Capture.
- **Home** shows only tasks from the projects you picked for this week (*Focus tasks*): **Today**, **Next 7 days** by day, and **Any day this week** (undated tasks under your goals).
  - Both dates count: a task is in *Today* if it is scheduled **or** due today (or earlier, i.e. overdue), and in *Next 7 days* if it is scheduled **or** due within the next 7 days. It's listed under its earliest date. Change the number with `upcoming_days` in Config.
  - The 7 days roll past Sunday. *Today* uses this week's focus. *Next 7 days* uses this week's focus **plus** next week's focus once you've planned next week (shown as “+ next week: …” in the header).
  - Order: tasks **with a deadline (📅) come first**, earliest deadline first, then by priority, then by scheduled date.
- Tasks from **other projects** (or other notes, or the inbox) that are due or scheduled in the next 7 days appear in a separate orange **Outside this week's focus** box, grouped by project, with overdue ones in red. Do them, move the date, or make room for them next week.
- You can tick, edit (✎ opens the Tasks edit form) and open (↗) tasks right on Home. Ticking goes through the Tasks plugin, so ✅ dates and 🔁 repeats work as usual.
- Each week note also has a foldable **This week by day** list (all projects).
- **Tick tasks** anywhere (Home, week note, project note). Tasks adds the ✅ date.
- The week dashboard and Analytics also count **Done outside goals**: tasks completed that week anywhere in the vault that weren't part of a goal.
- Inbox items keep any dates you typed; the classifier adds ⏫/🔽 for clearly high/low priority, and filed tasks get a ➕ created date.

## 7. The weekly loop

**Any time — Capture.** One item per line → `Tracker/Inbox.md`. Or type `- [ ] something` there directly.

**When convenient — Process inbox.** The model suggests a project, a type (task / idea / reference) and a confidence. Confident items are filed automatically (`llm_auto_file_confidence`). For the rest you confirm or choose: file to a project, **plan it for this week** (goes straight to that project's `## Planned`), keep, or delete. Tasks go to the project's `## Backlog`; ideas 💡 and references 📎 to `## Notes & ideas`.

**During the week.** Work from Home → Today. A goal's progress = share of its tasks done.

**Sunday — Weekly review.** For each goal: achieved / partly (%) / missed, and the main reason it fell short. Unfinished tasks: **plan them for next week** (their week marker changes; the goal is carried too), **return them to the backlog**, or **drop** them. Projects with picked tasks but no goal are asked about the same way. Finished tasks move from `## Planned` to a `## Done` section in each project note. Then wins, lessons, energy 1–5, and an optional short summary from the local model. It ends by offering to plan next week.

## 8. What you see

- **Home**: buttons, this week's goals with progress, focus tasks (today / later this week / any day), the *Outside this week's focus* box, inbox count, 8-week momentum, what needs attention.
- **Week note**: goals achieved, average progress, tasks done, done outside goals; then every goal with its bar and all the tasks picked for it (tick / edit / open right there).
- **Project note**: objective, weeks in focus, average goal score, a 16-week focus strip, a **Planned** card (this week / next week: goal and tasks done) with a *Pick tasks* button, recent goals with scores and reasons. The tasks themselves are in the note's `## Planned` section.
- **Analytics**: last week vs your 4-week average, score per week with trend, tasks done vs planned, which projects got your weeks (heatmap), project table, why goals fell short, active projects you keep skipping, review notes.

## 9. The format (plain Markdown — edit by hand any time)

Project note (`Sailing/Sailing.md`):
```
## Planned
- [x] Call the marina [week:: 2026-W46] ⏳ 2026-11-10 ✅ 2026-11-10
- [ ] Compare 3 yards [week:: 2026-W47] [from:: 2026-W46] 📅 2026-11-19

## Backlog
- [ ] Service the winch ⏫

## Done
- [x] Order antifouling [week:: 2026-W45] ✅ 2026-11-05
```
Week note (`Tracker/Weeks/2026-W46.md`) — only goals; the tasks show up under them automatically:
```
## Goals
- 🎯 Book winter berth [project:: [[Sailing]]]
- 🎯 Publish post [project:: [[Blog]]] [result:: 40] [miss:: no-time] [from:: [[2026-W45]]]
```
- `[week:: …]` = the week a task is planned for. You can also add it by hand to any task in the project's folder (sub-notes included).
- `[from:: …]` = weeks it was planned for before and moved on from. Those weeks count it as *planned, not done*, so your history stays honest.
- `🎯` lines are goals (not tasks, so they don't show up in Tasks lists). `result` and `miss` are written by the review.
- A `[-]` task = dropped; it doesn't count. Week notes from older versions with tasks nested under goals still work.
- Project properties: `type: project`, `status: active | backlog | done`, `scope`, `description`, `objective`, `keywords`.

## 10. If something doesn't work

| What you see | Fix |
|---|---|
| A grey code block instead of the dashboard | Dataview → Enable JavaScript queries. |
| "Can't find Tracker/Scripts/ptrack.js" | The Tracker folder isn't at the top level of the vault. |
| A button says "Add … under Template hotkeys" | Add that file in Settings → Templater → Template hotkeys. |
| Templater: "No active editor" | Open a note (e.g. Home) first, then run the command. |
| iPhone: "no local model set up for this iPhone" | Set `llm_mobile: shortcut` in Config after building the shortcut (section 5). |
| iPhone: Shortcuts doesn't open | Open the Shortcuts app and run **Tracker Classify** yourself, then come back and tap Process inbox. |
| iPhone: "No answers from the shortcut yet" | The shortcut stopped. Run it from the Shortcuts app to see the error — usually folder permission, the shortcut's name not matching `llm_shortcut`, or Apple Intelligence still downloading. |
| Shortcuts: "Use Model" not available | Your iPhone model or iOS version doesn't support Apple Intelligence, or it's turned off in Settings. |
| Tasks query shows an error | Update the Tasks plugin. |

All settings are in `Tracker/Config`. The look is in `Tracker/Views/tracker/view.css` and uses your theme's colours.
