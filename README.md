# personal-planning

An Obsidian-based personal planning system for juggling many projects at once.

Each week you pick **5–7 projects**, set **one goal** for each, and plan dated tasks under those goals. A **local LLM** sorts anything you capture into the right project. Every Sunday a **weekly review** scores each goal and records why it fell short. Each project has a **priority from 1 (top) to 5 (someday)**, and planning follows it: finish the top projects rather than move every project a little. Dashboards then show your momentum, top-priority projects missing from the plan, and where your weeks actually went.

Everything is plain Markdown. It runs on the Mac and on the iPhone.

## Repository layout

```
.
├── Tracker/                  # the planning system (copy this into your vault)
│   ├── Start here.md         # full setup guide and user manual
│   ├── Home.md               # main dashboard: today, this week, attention
│   ├── Analytics.md          # 12-week trends, heatmap, miss reasons
│   ├── Projects.md           # all projects: priority, status, description quality
│   ├── Active projects.md    # active projects as cards, by priority; ← / → on project pages
│   ├── Config.md             # all settings (frontmatter)
│   ├── Inbox.md              # capture: tasks or any free text
│   ├── Commands/             # Templater entry points (one per command)
│   ├── Scripts/ptrack.js     # all logic: planning, review, inbox, LLM calls
│   ├── Views/tracker/        # Dataview view + CSS for the dashboards
│   └── Weeks/                # week notes (sample: 2026-W45, 2026-W46)
├── scripts/update-vault.py   # install/update Tracker in your vault, keeping your data
├── References/               # sample reference notes (Travel, Home & tools)
└── Projects/                 # sample projects, one folder per project
    ├── personal/             # scope "personal"
    │   ├── Sailing/          # active
    │   ├── Blog/             # active
    │   ├── Spanish/          # backlog
    │   └── Personal routines/  # kind: routine — daily, weekly, monthly
    └── common/               # scope "common"
        ├── Home renovation/  # active
        ├── Family trip/      # active, nothing planned this week
        └── Common routines/  # kind: routine — household
```

## Requirements

- [Obsidian](https://obsidian.md) with these community plugins:
  - **Dataview**, with *Enable JavaScript queries* turned on
  - **Templater**: add the twelve files in `Tracker/Commands/` under *Template hotkeys*
  - **Tasks**: keep *Set done date on every completed task* on
- Optional: a Google Cloud OAuth client (free) for the Google Calendar sync
- Optional: a local model for sorting the inbox
  - Mac: [Ollama](https://ollama.com) (`ollama pull qwen2.5:7b-instruct`) or LM Studio
  - iPhone: Apple's on-device model, run through a Shortcut

See [Tracker/Start here.md](Tracker/Start%20here.md) for step-by-step setup, the iPhone Shortcut, and troubleshooting.

## Quick start

**Try the samples.** Open this repository folder as an Obsidian vault and install the three plugins above. Then open `Tracker/Home`. `Tracker/Config` already points `project_roots` at `Projects/personal` and `Projects/common`, so the sample projects and weeks show up right away.

**Use it in your own vault:**

1. Run `scripts/update-vault.py "/path/to/your/vault"` (see [Updating your vault](#updating-your-vault)). It installs `Tracker/` without the sample data.
2. In Obsidian, run **Register projects**. It asks which folders hold your projects, and sets each project to active, backlog, or not a project.
3. Give each active project a one-line `description`. The inbox classifier relies on it.
4. Run **Plan week**.

## Updating your vault

`scripts/update-vault.py` installs or updates the tracker in your vault without touching your data. It needs only Python 3, which macOS already has.

```bash
scripts/update-vault.py --dry-run "/path/to/your/vault"
```

```bash
scripts/update-vault.py "/path/to/your/vault"
```

The script shows its plan and asks before changing anything. It remembers the vault path in `.vault-path` (ignored by git), so after the first run `scripts/update-vault.py` is enough. An iCloud vault lives under `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<vault>`.

| Files in the vault | What the script does |
|---|---|
| `Tracker/Scripts/`, `Views/`, `Commands/`, `Start here.md`, `Home.md`, `Analytics.md`, `Projects.md`, `Active projects.md` | Replaces them with the repo's version |
| `Tracker/Config.md` | Merges it. Your values stay, new settings are added with their defaults, and the help text is updated. |
| `Tracker/Inbox.md` | Creates it only if it's missing. It never overwrites it. |
| `Tracker/Weeks/`, `Tracker/AI/`, your projects, all other notes | Never touches them |

Every file it replaces or removes is first copied to `~/ObsidianTrackerBackups/<vault>-<timestamp>/`. You can change that folder with `--backup-dir`.

The script keeps a manifest in `Tracker/.update-manifest.json`. It uses it in two ways:

- If you edited a system file yourself, the script warns you before overwriting it.
- A file that a newer version no longer ships is removed, but only if you never edited it.

On a fresh install, `Config.md` starts with empty `project_roots`, and the sample weeks and inbox items are not copied. After an update, run **Register projects** once in Obsidian, so existing projects get any new sections.

## The weekly loop

| When | Command | What happens |
|---|---|---|
| Any time | **Capture** | Adds one item per line to `Tracker/Inbox.md` |
| When convenient | **Process inbox** | The local LLM reads the whole inbox note (items and free text) and writes `Tracker/Classified inbox` for you to check: tasks and ideas → projects, references (places to visit, tips, links) → reference notes in `References/`, spendings → the finance note. The inbox isn't changed. |
| After checking | **Apply inbox** | Files everything, asks about items without a destination (every menu has ← Back; ＋ New project creates one), adds one *Process new spendings* task, archives the inbox to `Inbox archive.md` and clears it. |
| Anytime | **Projects** note | Set each project's priority (1 = top … 5 = someday) and status. **Plan week** lists projects by priority, and within a priority the ones you're already working on and closest to done first. The local LLM can rate each description (the inbox sorter relies on them) and draft one from the project's folder. |
| Start of week | **Plan week** / **Plan project** | Asks which open tasks in `## Planned` are actually done and moves finished ones to `## Done`. Then you pick projects, write one goal each, and move tasks from `## Backlog` to `## Planned` with a day (⏳) and an optional deadline (📅). |
| Anytime | **Project note** → *Analyze* | The local LLM checks the open tasks against the objective and the week's goals: suggests missing tasks (add with one click) and merges duplicates. |
| During the week | **Home** | Shows today's tasks, today's routines (below the project work), the next 7 days, and tasks due *outside this week's focus* |
| During the week | **Add tasks** | Adds tasks that came up to this week, in the project's `## Unplanned` section. They count like planned ones; Analytics shows the planned/unplanned split. |
| During the week | **Log time** / ⏱ | Logs hands-on (`active`) and unattended (`passive`) time on a task. Planning asks for an estimate (`est`). Week notes, project pages and Analytics compare estimates with time spent. |
| During the week | **Sync calendar** / 🕒 | Tasks with a set time (`[time:: 14:30]`) become Google Calendar events; moving or deleting an event changes the task back. Tasks for any time of the day stay out. Home shows your calendar events among the day's tasks. |
| During the week | **Cancel task** / ✖ | Cancels a task that's no longer needed (optional reason). It moves to `## Done` as `[-]`, leaves every list, and is left out of goal progress — done ÷ (planned − cancelled). The week note, project page and Analytics count it as cancelled. |
| Sunday | **Weekly review** | Scores each goal (achieved, partly, or missed, with the reason). Carries, returns, or drops unfinished tasks, and records the week's routine score, wins, lessons, and energy. Every question has ← Back; nothing is saved until the final *Save the review*. |
| Anytime | **New project**, **Register projects** | Adds projects |

## Data format

Tasks stay in their project notes. A week note only holds the goals; tasks link to a week through an inline `[week:: …]` field.

**Project note** (`Projects/personal/Sailing/Sailing.md`):

```markdown
---
type: project
status: active            # active | backlog | done
scope: personal           # taken from the parent folder
description: "Owning and maintaining my sailboat…"
objective: "Boat safely laid up for winter…"
keywords: [boat, marina, berth]
---
## Planned
- [x] Call the marina [week:: 2026-W46] ⏳ 2026-11-09 ✅ 2026-11-09
- [ ] Compare quotes from 3 yards [week:: 2026-W46] [from:: 2026-W45] 📅 2026-11-13

## Backlog
- [ ] Service the primary winches ⏫

## Notes & ideas
## Done
```

**Week note** (`Tracker/Weeks/2026-W46.md`):

```markdown
## Goals
- 🎯 Book a winter berth and haul-out [project:: [[Sailing]]] [from:: [[2026-W45]]]
- 🎯 Publish the Obsidian planning post [project:: [[Blog]]]
```

- `[week:: …]` is the week a task is planned for.
- `[from:: …]` lists the earlier weeks a task or goal was carried over from. Those weeks count it as planned but not done.
- `[result:: 0–100]` and `[miss:: no-time | blocked | deprioritized | underestimated | motivation | unclear]` are written by the weekly review.
- `[-]` marks a cancelled task (✖, **Cancel task**, or dropped in the review), with an optional `[reason:: …]`. It's left out of progress and counted as cancelled. `[-]` with `⇢` means moved to another week or the backlog.
- `[est:: 2h]` is the estimate of hands-on time; `[active:: 1h30m]` and `[passive:: 3h]` are the time spent working on it and the time it took without you (waiting, drying). Durations: `45m`, `2h`, `1h30m`, `1:30`.
- `[time:: 14:30]` or `[time:: 14:30-15:30]` gives a task a set time, which puts it in Google Calendar; `[cal:: …]` links the event.
- Every task the tracker adds gets a ➕ created date: the capture date for inbox items, today for tasks typed while planning.
- Dates use the Tasks plugin's emoji: 📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done. Priorities use ⏫ 🔼 🔽.

## What's in the samples

| Project | Scope | Status | Shows |
|---|---|---|---|
| Sailing | personal | active | A goal carried over from W45, a mix of done and open tasks, and a filled `## Done` |
| Blog | personal | active | A four-task goal with a deadline at the end of the week; estimates and time spent on its tasks |
| Home renovation | common | active | A high-priority task due mid-week, and a second note in its folder for **✨ Write** to read |
| Family trip | common | active | Not in this week's focus. A backlog task due soon appears in the *Outside focus* box. |
| Spanish | personal | backlog | A parked project with only backlog items |
| Personal routines | personal | routine | Daily, weekly and monthly routines with three weeks of done and missed history |
| Common routines | common | routine | Household routines; *Pay the bills* has a deadline and ⏫, so it ranks with project tasks |

- **2026-W45** is a reviewed week: goals scored at 67%, 50%, 100%, and 0%, with miss reasons, wins, lessons, and energy.
- **2026-W46** is the current week, planned with three goals.
- `Tracker/Inbox.md` holds unsorted items and free text — a task, an idea, places to visit, a spending — to try **Process inbox** on.
- `References/` holds two reference notes (Travel, Home & tools) for references from the inbox.

## Routines

A project with `kind: routine` holds recurring tasks (🔁) and is always in focus: no weekly goal, and it doesn't count toward the 5–7 goals or the goal average.

- **Missed occurrences** are cancelled as `[-] … [missed:: yes]` and the next one is created, once per missed day, week or month. This happens when Home opens, and in planning and review.
- **Routine score:** a week's score is *done ÷ (done + missed)*, for all routines together and per routine. The routine average is reported separately on Home, the week note, the routine project page and Analytics.
- **Time:** give a routine an estimate (`[est:: 20m]`) and each done occurrence counts that much, unless you log the real time with ⏱. Analytics shows the time per routine project (area of your life) per week.
- **Priority:** routines without a 📅 or ⏫ are listed below project work on Home.

See *Routines* in [Tracker/Start here.md](Tracker/Start%20here.md).

## Upgrading an existing vault

1. **Preview, then update.** `scripts/update-vault.py --dry-run` shows what would change; `scripts/update-vault.py` does it (asks first, backs up every replaced file to `~/ObsidianTrackerBackups/`). Your projects, weeks, inbox and `Tracker/AI/` aren't touched; `Config.md` keeps your values and gets the new settings.
2. **Restart Obsidian on the Mac** (or reload it), so the new script and views are picked up.
3. **Template hotkeys** (Settings → Templater): make sure all twelve files in `Tracker/Commands/` are listed — newer ones are `Add tasks`, `Apply inbox`, `Log time`, `Cancel task`, `Sync calendar`.
4. **Run Register projects** once: it adds the `## Planned` / `## Unplanned` sections to older project notes and rewrites old priorities `high / medium / low` as `2 / 3 / 4`.
5. **Set priorities** in `Tracker/Projects`: 1 for the projects you want to finish first … 5 for the ones you're happy to leave alone. Plan week follows this order.
6. **Look through `Tracker/Config`**: delete `neglect_weeks` and `llm_auto_file_confidence` if they're still there (no longer used), and check the new settings — `focus_priority`, `plan_estimates`, `plan_times`, `log_time_on_done`, `llm_flag_below`, `reference_folder`, `finance_file`, `finance_project`, `currency`, `calendar_*`. The table under the settings explains each.
7. **Routines time** (optional): add an estimate to the open occurrence of each routine you want to track, e.g. `[est:: 20m]` — later occurrences copy it.
8. **Inbox note** (optional): `Tracker/Inbox.md` is never overwritten; if yours still has the old explanation at the top, copy the callout from the repo's `Tracker/Inbox.md`.
9. **Google Calendar** (optional): fill in `calendar_client_id` / `calendar_client_secret` and run **Sync calendar** on the Mac — see *Start here → Google Calendar*.
10. **iPhone**: nothing to install. Let the vault sync, then reopen Obsidian there.

## Settings

All settings are in the frontmatter of [Tracker/Config.md](Tracker/Config.md). They include the goal range, which priorities must be in every week's plan (`focus_priority`), the LLM provider, URL and model, and the confidence above which items are filed automatically. The note itself explains each setting.

## Privacy

While the local model works, a progress panel shows the step, the current item, the time left and the model's answer as it's written, with a **Stop** button. Inbox items are sorted several per request (`llm_batch`).

Nothing leaves your machine unless you point the LLM settings elsewhere or connect Google Calendar. The model URL in Config is `http://localhost:11434` (Ollama) by default. With the calendar connected, timed tasks (their text, time and a link to the note) are sent to Google Calendar, and your events for the next days are read back for Home. The Google sign-in is stored in `Tracker/AI/` inside your vault.

## Tests

`tests/run.sh` runs the tests with macOS's built-in JavaScriptCore against the sample vault (no Node needed; it looks for a `moment.min.js` on the Mac, or set `MOMENT=`).

## License

See [LICENSE](LICENSE).
