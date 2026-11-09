# personal-planning

An Obsidian-based personal planning system for juggling many projects at once.

Each week you pick **5–7 projects**, set **one goal** for each, and plan dated tasks under those goals. A **local LLM** sorts anything you capture into the right project. Every Sunday a **weekly review** scores each goal and records why it fell short. Dashboards then show your momentum, the projects you've been neglecting, and where your weeks actually went.

Everything is plain Markdown. It runs on the Mac and on the iPhone.

## Repository layout

```
.
├── Tracker/                  # the planning system (copy this into your vault)
│   ├── Start here.md         # full setup guide and user manual
│   ├── Home.md               # main dashboard: today, this week, attention
│   ├── Analytics.md          # 12-week trends, heatmap, miss reasons
│   ├── Projects.md           # all projects: priority, status, description quality
│   ├── Config.md             # all settings (frontmatter)
│   ├── Inbox.md              # capture: tasks or any free text
│   ├── Commands/             # Templater entry points (one per command)
│   ├── Scripts/ptrack.js     # all logic: planning, review, inbox, LLM calls
│   ├── Views/tracker/        # Dataview view + CSS for the dashboards
│   └── Weeks/                # week notes (sample: 2026-W45, 2026-W46)
├── scripts/update-vault.py   # install/update Tracker in your vault, keeping your data
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
  - **Templater**: add the nine files in `Tracker/Commands/` under *Template hotkeys*
  - **Tasks**: keep *Set done date on every completed task* on
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
| `Tracker/Scripts/`, `Views/`, `Commands/`, `Start here.md`, `Home.md`, `Analytics.md`, `Projects.md` | Replaces them with the repo's version |
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
| When convenient | **Process inbox** | The local LLM reads the whole inbox note. It splits free text (notes, ideas, links) into separate items and keeps the original in `Inbox archive.md`. It then suggests a project, a type (task / idea / reference), and a priority for each item. Confident items are filed automatically. |
| Anytime | **Projects** note | Set each project's priority (high / medium / low) and status. **Plan week** lists projects by priority. The local LLM can rate each description (the inbox sorter relies on them) and draft one from the project's folder. |
| Start of week | **Plan week** / **Plan project** | Asks which open tasks in `## Planned` are actually done and moves finished ones to `## Done`. Then you pick projects, write one goal each, and move tasks from `## Backlog` to `## Planned` with a day (⏳) and an optional deadline (📅). |
| During the week | **Home** | Shows today's tasks, today's routines (below the project work), the next 7 days, and tasks due *outside this week's focus* |
| During the week | **Add tasks** | Adds tasks that came up to this week, in the project's `## Unplanned` section. They count like planned ones; Analytics shows the planned/unplanned split. |
| During the week | **Log time** / ⏱ | Logs hands-on (`active`) and unattended (`passive`) time on a task. Planning asks for an estimate (`est`). Week notes, project pages and Analytics compare estimates with time spent. |
| Sunday | **Weekly review** | Scores each goal (achieved, partly, or missed, with the reason). Carries, returns, or drops unfinished tasks, and records the week's routine score, wins, lessons, and energy. |
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
- `[-]` marks a dropped task, which doesn't count toward any score.
- `[est:: 2h]` is the estimate of hands-on time; `[active:: 1h30m]` and `[passive:: 3h]` are the time spent working on it and the time it took without you (waiting, drying). Durations: `45m`, `2h`, `1h30m`, `1:30`.
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
- `Tracker/Inbox.md` holds four unsorted items to try **Process inbox** on.

## Routines

A project with `kind: routine` holds recurring tasks (🔁) and is always in focus: no weekly goal, and it doesn't count toward the 5–7 goals or the goal average.

- **Missed occurrences** are cancelled as `[-] … [missed:: yes]` and the next one is created, once per missed day, week or month. This happens when Home opens, and in planning and review.
- **Routine score:** a week's score is *done ÷ (done + missed)*, for all routines together and per routine. The routine average is reported separately on Home, the week note, the routine project page and Analytics.
- **Priority:** routines without a 📅 or ⏫ are listed below project work on Home.

See *Routines* in [Tracker/Start here.md](Tracker/Start%20here.md).

## Settings

All settings are in the frontmatter of [Tracker/Config.md](Tracker/Config.md). They include the goal range, the neglect threshold, the LLM provider, URL and model, and the confidence above which items are filed automatically. The note itself explains each setting.

## Privacy

Nothing leaves your machine unless you point the LLM settings elsewhere. The only network call is to the model URL in Config, which is `http://localhost:11434` (Ollama) by default.

## License

See [LICENSE](LICENSE).
