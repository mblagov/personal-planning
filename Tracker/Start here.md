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
- Settings → Templater → **Template hotkeys** → add these twelve files, one per row:
  `Tracker/Commands/Capture.md`, `Process inbox.md`, `Apply inbox.md`, `Plan week.md`, `Plan project.md`, `Add tasks.md`, `Log time.md`, `Cancel task.md`, `Sync calendar.md`, `Weekly review.md`, `New project.md`, `Register projects.md`
- That's all. You do **not** need to set a template folder or a script folder.
- Optional: Settings → Hotkeys → search "Tracker/Commands" to give them keyboard shortcuts.

**Tasks**
- Defaults are fine. Keep **Set done date on every completed task** on — the analytics use the ✅ date.
- Also turn on **Set created date on every added task**, so tasks you make with the Tasks form get a ➕ date too. (Tasks the tracker adds always get one.)
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
   Then open `Tracker/Projects` and set each project's **priority** (high / medium / low) and status with the dropdowns. Once the local model runs (next step), press **Check descriptions** there: the inbox model sorts notes by these descriptions, so weak ones are worth fixing (**✨ Write** drafts one from the project's folder).
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
3. Tap **Process inbox** again. It turns the answers into the **Classified inbox** note for you to check, exactly as on the Mac; then tap **Apply inbox**.

The first run asks for a few permissions. Allow each one, choosing *Always Allow* where offered:
- Obsidian opening Shortcuts
- the shortcut reading and saving files in your vault folder

Good to know:
- Apple's on-device model is smaller than the one on your Mac, so short, clear project **descriptions** matter even more here.
- The Mac keeps using Ollama (`llm_url`). The two devices don't talk to each other.
- The weekly review's optional AI summary is offered only on the Mac. Apple's model isn't wired to it.
- If you'd rather not use AI on the phone, leave `llm_mobile: off`. Process inbox then lists the items in the Classified inbox without destinations, and **Apply inbox** asks where each one goes.

## 6. Planning with dates (Tasks plugin)

Tasks use the Tasks plugin's emoji format: `📅` due · `⏳` scheduled · `🛫` start · `➕` created · `✅` done · `⏫ 🔼 🔽` priority · `🔁` repeat.

- **Where planned tasks live**: in their **project note**, in the `## Planned` section, marked with the week: `- [ ] Call marina [week:: 2026-W46] ⏳ 2026-11-10`. Nothing is copied into the week note.
- **Plan project** (button on every project page, or the command): choose **this week** or **next week**, optionally write the project's goal for that week, then pick tasks from its `## Backlog` or type new ones. First, it goes through the tasks still open in `## Planned` and asks whether each one is actually done (*Not yet* is the default; Esc stops asking), and moves every finished task in `## Planned` to `## Done`. Picked tasks move from Backlog to Planned. For each task you choose a day (Mon–Sun, or no date) — that sets the **⏳ scheduled** date — and then a deadline — that sets the **📅 due** date: *No deadline*, a day of that week from the scheduled day on, or *Other date…* (type `YYYY-MM-DD`) for deadlines further out. A due date the task already has is offered as *Keep* (the default), or you can remove it. Turn either question off with `plan_schedule_tasks` / `plan_due_dates` in Config.
- **Plan week** does the same for several projects in one go: pick a project → write the goal → (check open tasks, tidy finished ones) → pick its tasks → next project.
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
- **Created dates**: every task the tracker adds to a project gets ➕ — Capture stamps the day you captured it, and filing keeps that date (items typed straight into the inbox get the filing date). New tasks typed during planning get today. A ➕ you wrote yourself is never changed.

## 7. The weekly loop

**Any time — Capture.** One item per line → `Tracker/Inbox.md`. Or type `- [ ] something` there directly.

**When convenient — Process inbox, then Apply inbox.** Two steps, so nothing is filed before you've seen it:
1. **Process inbox** reads the **whole inbox note** — the `- [ ]` items and any free text (paragraphs, plain bullets, pasted notes and links; free text is split into separate items) — and writes the result to **`Tracker/Classified inbox`**. *The inbox itself isn't changed.* The note has four sections:
   - **Tasks** and **Ideas** → a project: `- ☐ Book the haul-out [to:: [[Sailing]]] 📅 2026-11-20`.
   - **References** → a reference note in `reference_folder` (default `References/`, one note per topic: Travel, Recipes, Home & tools…): `- 📎 Naschmarkt is best on Saturday mornings [to:: [[Travel]]]`. Places to visit, recommendations, how-tos and links **never go into projects** — a place to visit goes to Travel even if you have a trip project. When no note fits, the model proposes a new one (`[new:: reference note]`); it's created when you apply.
   - **Spendings** → `- 💶 Groceries at the market [amount:: 86.4] [currency:: EUR] [date:: 2026-11-08] [category:: groceries]`.
   Edit anything: change `[to:: …]` to another project or note, move a line to another section to change what it is, fix the text or the amount, delete lines. `[check:: unsure]` marks items the model wasn't sure about (`llm_flag_below`). Add `[week:: 2026-W46]` to a task to plan it for that week. The summary at the top counts what goes where.
2. **Apply inbox** (the button in the Classified inbox, or run Process inbox again) files everything: tasks to the project's `## Backlog` (or `## Planned` with `[week::]`), ideas 💡 to `## Notes & ideas`, references 📎 to the end of their reference note, spendings to `finance_file` under *Unprocessed* — plus **one** task *Process N new spending(s)* (in that note, or in `finance_project`), which is updated rather than repeated next time. Items still at `[to:: none]` are asked about one by one: a project, a reference note, a new reference note, change the type, leave it in the inbox, or delete. **Every menu has ← Back**, and *← Back to the previous item* re-opens your last choice; nothing is written until the final *Apply* (which also has *← Back to the questions*; Esc cancels everything). Then the inbox is cleared — what it held is kept in `Tracker/Inbox archive.md` — except items you chose to leave, and anything you added to the inbox after classifying.

**During the week.** Work from Home → Today. A goal's progress = share of its tasks done.

**During the week — Add tasks.** Something came up? **Add tasks** (Home, the week note or the project page) works like Plan project for *this* week — type new tasks or pick them from the backlog, with ⏳ and 📅 — but they go to the project's `## Unplanned` section and get `[unplanned:: 2026-W46]`. Nothing is tidied first (open Planned tasks aren't asked about, done ones stay where they are). Unplanned tasks show up and count exactly like planned ones; only Analytics tells them apart: the week note and Analytics show how many tasks were unplanned, and the Projects table has a *Planned / unplanned* split per project. If the review carries an unplanned task to next week, it moves to `## Planned` (it's planned now); the marker stays, so the week it was added still counts it as unplanned.

**During the week — time.** Every task can carry an estimate and the time it really took:
- `[est:: 2h]` — how long you expect the hands-on work to take. Planning asks for it after the dates (turn off with `plan_estimates`); the task pickers show the running total, e.g. *✔ Done — 4 task(s) planned for W46 · ≈ 6h estimated*.
- `[active:: 1h30m]` — hands-on time you actually spent.
- `[passive:: 3h]` — time the task took without needing you: paint drying, waiting for a reply, a long upload. It's tracked apart so it doesn't spoil your estimates.
- To log time: the **⏱** button on any task row (Home, week note) opens a small form with *+15m / +30m / +1h / +2h* buttons; or put the cursor on a task and run **Log time** (without a task under the cursor it lets you pick one of this or last week's tasks). Ticking a task that has an estimate asks right away how long it took — Cancel skips it (`log_time_on_done`).
- To cancel a task that's no longer needed: the **✖** button on a task row (Home, week note), or put the cursor on it and run **Cancel task** (without a task under the cursor it lets you pick one of this or next week's). You can give a reason. The task becomes `- [-] … [reason:: …] ❌ <today>` and moves, with its sub-items, to `## Done`, so it leaves every list. It counts as neither done nor planned: goal progress is *done ÷ (planned − cancelled)*, and the week note, project page and Analytics show how many were cancelled. A repeating task gets its next occurrence. Dropping a task in the weekly review cancels it the same way.
- Durations: `45m`, `2h`, `1h30m`, `1.5h`, `1:30`; a plain number is minutes.
- The week note shows *Time* (active vs estimate, passive, and how close your estimates were on done tasks); each goal shows its own; the project page shows the last 16 weeks; Analytics has a **Time · estimates vs spent** table per week and per project. *Actual / est.* = hands-on time ÷ estimate on done tasks that have both: 100% is spot on, 150% means things take you 1.5× longer than you think.

**Sunday — Weekly review.** For each goal: achieved / partly (%) / missed, and the main reason it fell short. Unfinished tasks: **plan them for next week** (their week marker changes; the goal is carried too), **return them to the backlog**, or **drop** them. Projects with picked tasks but no goal are asked about the same way. Finished tasks move from `## Planned` to a `## Done` section in each project note. Then wins, lessons, energy 1–5, and an optional short summary from the local model. It ends by offering to plan next week.

## 8. Routines

Recurring routines live in **routine projects** — one per scope, e.g. `Projects/personal/Personal routines/Personal routines.md` and `Projects/common/Common routines/Common routines.md`. Mark the project note with `kind: routine` in its properties (next to `type: project`). Then write each routine as a recurring task, in any sections you like:

```
## Daily
- [ ] Inbox zero 🔁 every day ⏳ 2026-11-09
## Weekly
- [ ] Weekly review 🔁 every week on Sunday ⏳ 2026-11-15
## Monthly
- [ ] Pay the bills 🔁 every month on the 1st 📅 2026-12-01 ⏫
```

- **Always in focus.** Routine projects need no weekly goal, are part of every week automatically, don't count toward your 5–7 goals and are never flagged as neglected. Set `status: backlog` to pause one (its routines disappear from Home and missed ones aren't recorded).
- **Lower priority.** On Home, routines without a 📅 deadline or ⏫/🔺 are listed in a compact **Routines today** list below the focus tasks; on later days they come after project tasks, and daily ones aren't repeated under *Next 7 days*. Give a routine a 📅 or ⏫ and it ranks with project tasks. Routines never show in the *Outside focus* box.
- **Missed = cancelled.** When you open Home (and in Plan week, Plan project and the weekly review), every routine occurrence whose date has passed is marked `- [-] … [missed:: yes] … ❌ <today>`, and the next occurrence is created — once per missed day/week/month, so a 3-day gap records 3 misses. The tracker computes the next date for `every day`, `every N days`, `every weekday`, `every [N] week[s] [on Monday, Thursday]`, `every [N] month[s] [on the 15th / on the last]`, `every year`; other rules are handed to the Tasks plugin. Cancel an occurrence yourself (`[-]` without `missed`) to skip it without it counting.
- **Score.** Each occurrence counts in the week of its date (📅, else ⏳). A week's routine score is *done ÷ (done + missed)* — for all routines together and per routine. The **routine average** is kept separate from the goal average: the week note, Home (this week + 4-week average), the routine project's page and Analytics (*Routines*: last week, 4-week and all-weeks average, a chart per week, and a per-routine table) show it. The weekly review writes `Routines:: 80% (12/15 done, 3 missed)` into the week note and moves finished occurrences to `## Done`.
- Routine completions don't count as *Done outside goals*.

## 9. What you see

- **Projects** (`Tracker/Projects`): every project grouped by status and ordered by priority, with dropdowns to change **priority** and **status** (saved in the project's properties), whether it's in this / next week's plan, last focus, average score and backlog size; routine projects in their own table. **Plan week** lists projects by priority (then the longest without focus), and *Needs attention* puts high-priority projects first.
  - **Description quality** (needs the local model): **Check descriptions** has the model rate every new or changed description from 0 to 100 — is it clear, distinct from your other projects, concrete, short — and gives a badge (✓ good · ~ could be better · ! weak), the main problems and a better wording you can take with **Use this**. **Check** / **Re-check** rates one project. Edit a description and its badge turns to *changed* until you check it again.
  - **✨ Write** drafts a description (and keywords, if the project has none) from what's in the project's folder: the project note and the other notes and file names in its folder, about 6,000 characters. Nothing is saved until you press **Use it**; **Dismiss** throws it away, **↻ Again** writes another. Ratings and drafts are kept in `Tracker/AI/descriptions.json`.
- **Home**: buttons, this week's goals with progress (reorder the projects with the ↑ ↓ buttons on each row — it moves the goal lines in the week note, so the week note and the focus list follow the same order), focus tasks (today / later this week / any day), the *Outside this week's focus* box, inbox count, 8-week momentum, what needs attention.
- **Week note**: goals achieved, average progress, tasks done, done outside goals; then every goal with its bar and all the tasks picked for it (tick / edit / open right there).
- **Project note**: objective, weeks in focus, average goal score, a 16-week focus strip, a **Planned** card (this week / next week: goal and tasks done) with a *Pick tasks* button, recent goals with scores and reasons. The tasks themselves are in the note's `## Planned` section.
  - **🔍 Tasks vs goals** (needs the local model): **Analyze** sends the open tasks (Planned, Unplanned, Backlog) and the goals (the project's objective, this and next week's goal) to the model. It answers with a short summary, up to five **missing tasks** needed to reach a goal — add each to *This week* or the *Backlog* with one click — and groups of **possible duplicates** with a merged wording. **Merge** keeps one task (the one planned for a week, if any) with that text and its fields and dates; the others are removed and noted under it as `(merged) …` with their sub-items. ✕ dismisses a suggestion. The review is kept in `Tracker/AI/analysis.json`; when the tasks change it says so, and a merge whose tasks changed is refused — analyze again.
- **Analytics**: last week vs your 4-week average, score per week with trend, tasks done vs planned, which projects got your weeks (heatmap), project table, why goals fell short, active projects you keep skipping, review notes.

## 10. The format (plain Markdown — edit by hand any time)

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
- A `[-]` task = cancelled (✖ / **Cancel task**, or dropped in the review): it isn't done or planned, so it's left out of progress, and it's counted as cancelled. A `[-]` with `⇢` was moved to a later week or the backlog and still counts as planned-not-done in its old week. Week notes from older versions with tasks nested under goals still work.
- `[est:: 2h]`, `[active:: 1h30m]`, `[passive:: 3h]` = estimate, hands-on time spent, unattended time. Count for the week the task is planned for.
- `[time:: 14:30]` / `[time:: 14:30-15:30]` = a set time → Google Calendar; `[cal:: …]` = the linked event (written by the sync).
- `[unplanned:: 2026-W46]` = added during that week with **Add tasks** (lives in `## Unplanned` until the review moves it on).
- Routine occurrences: `[missed:: yes]` on a `[-]` line = missed (counts against the routine score); `[-]` without it = skipped.
- Project properties: `type: project`, `status: active | backlog | done`, `priority: high | medium | low` (unset = medium), `scope`, `description`, `objective`, `keywords`; `kind: routine` for a routine project.

## 11. Google Calendar

Some tasks happen at a set time (a call at 14:30, the dentist), others can be done any time that day. Give the first kind a time and it goes to your Google Calendar; the rest stay on Home only.

- **A set time**: `[time:: 14:30]` or `[time:: 14:30-15:30]` on a task that has a day (⏳ scheduled, or 📅 due). Without an end time the event lasts as long as the estimate (`[est::]`), or `calendar_default_minutes`. You can write `9`, `9:00`, `2pm`, `14:30 to 15:30`.
- **Setting it**: the **🕒** button on a task row (Home, week note) — *Any time* removes the time — or the extra question after the day and the deadline when you plan a task (*Any time that day* / *At a set time…*; turn it off with `plan_times`), or type the field yourself.
- **Sync** (**Sync calendar**, the *Sync* button next to *Today* on Home, or automatically when Home opens and the last sync is older than `calendar_sync_minutes`) works both ways:
  - a task with a time and a day gets an event in `calendar_id`, linked by `[cal:: …]` on the task line (leave that field alone);
  - change the task's time, day or wording → the event follows; tick it → the event becomes “✓ …”;
  - **move the event in Google Calendar** → the task's ⏳ day and `[time::]` follow; if both sides changed since the last sync, the task wins;
  - **delete the event**, or make it all-day → the task becomes an any-time task for that day (time and link removed);
  - cancel the task (✖), remove its time or its day, or delete the task → the event is deleted.
  - A repeating task gets a new event for each occurrence.
- **Home** shows your other calendar events (from `calendar_id` and the calendars in `calendar_show`) among the tasks: all-day events first, then timed tasks and events in time order, then *Any time today*. The same for each of the next days. Events open in Google Calendar.
- Events link back to the note (an `obsidian://` link in the event's description).

**Setup (once, about 10 minutes, on the Mac):**

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a project (any name, e.g. *Obsidian tracker*).
2. *APIs & Services → Library* → search **Google Calendar API** → **Enable**.
3. *APIs & Services → OAuth consent screen* (Google Auth Platform): user type **External**, app name and your email; under *Audience* add your own Google address as a **test user**. Under *Data access* you may add the scope `.../auth/calendar.events`.
4. *Credentials* (or *Clients*) → **Create OAuth client** → application type **Desktop app** → copy the **Client ID** and **Client secret** into `calendar_client_id` and `calendar_client_secret` in `Tracker/Config`.
5. Optional: create a separate calendar for your tasks in Google Calendar (e.g. *Tasks*), copy its id from its settings (*Integrate calendar → Calendar ID*) into `calendar_id`. Otherwise they go to your main calendar (`primary`).
6. In Obsidian on the Mac, run **Sync calendar**. Your browser opens Google's sign-in; allow access (Google warns that the app isn't verified — it's your own app, choose *Continue*). The tab says *connected*, and the first sync runs.

The sign-in is stored in `Tracker/AI/google-calendar-token.json` and syncs with the vault, so the iPhone uses it too — no sign-in needed there. Anyone with that file can edit your calendar events: keep the vault private. To disconnect, delete that file (and remove the app at myaccount.google.com → *Security → Third-party access*). While the consent screen is in *Testing*, Google expires the sign-in after 7 days — then run **Sync calendar** on the Mac again; publishing the app (*Audience → Publish app*, no review needed for your own use) avoids that.

## 12. If something doesn't work

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
| Calendar: “isn't connected — run Sync calendar on the Mac” | Run **Sync calendar** on the Mac once (section 11). The iPhone can't do the sign-in itself. |
| Calendar: “sign-in has expired or was revoked” | Run **Sync calendar** on the Mac again. With the consent screen in *Testing* this happens every 7 days — publish the app to stop it. |
| Calendar: “access_denied” in the browser | Add your Google address as a test user on the OAuth consent screen. |
| A timed task isn't in the calendar | It needs a day (⏳ or 📅) today or later, and must be open. Press *Sync* on Home. |

All settings are in `Tracker/Config`. The look is in `Tracker/Views/tracker/view.css` and uses your theme's colours.
