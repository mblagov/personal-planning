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
│   ├── Config.md             # all settings (frontmatter)
│   ├── Inbox.md              # capture queue
│   ├── Commands/             # Templater entry points (one per command)
│   ├── Scripts/ptrack.js     # all logic: planning, review, inbox, LLM calls
│   ├── Views/tracker/        # Dataview view + CSS for the dashboards
│   └── Weeks/                # week notes (sample: 2026-W45, 2026-W46)
└── Projects/                 # sample projects, one folder per project
    ├── personal/             # scope "personal"
    │   ├── Sailing/          # active
    │   ├── Blog/             # active
    │   └── Spanish/          # backlog
    └── common/               # scope "common"
        ├── Home renovation/  # active
        └── Family trip/      # active, nothing planned this week
```

## Requirements

- [Obsidian](https://obsidian.md) with these community plugins:
  - **Dataview**, with *Enable JavaScript queries* turned on
  - **Templater**: add the seven files in `Tracker/Commands/` under *Template hotkeys*
  - **Tasks**: keep *Set done date on every completed task* on
- Optional: a local model for sorting the inbox
  - Mac: [Ollama](https://ollama.com) (`ollama pull qwen2.5:7b-instruct`) or LM Studio
  - iPhone: Apple's on-device model, run through a Shortcut

See [Tracker/Start here.md](Tracker/Start%20here.md) for step-by-step setup, the iPhone Shortcut, and troubleshooting.

## Quick start

**Try the samples.** Open this repository folder as an Obsidian vault and install the three plugins above. Then open `Tracker/Home`. `Tracker/Config` already points `project_roots` at `Projects/personal` and `Projects/common`, so the sample projects and weeks show up right away.

**Use it in your own vault:**

1. Copy the `Tracker/` folder to the **top level** of your vault.
2. Delete `Tracker/Weeks/*`, and set `project_roots: []` in `Tracker/Config.md`.
3. Clear the sample items from `Tracker/Inbox.md`.
4. Run **Register projects**. It asks which folders hold your projects, and sets each project to active, backlog, or not a project.
5. Give each active project a one-line `description`. The inbox classifier relies on it.
6. Run **Plan week**.

## The weekly loop

| When | Command | What happens |
|---|---|---|
| Any time | **Capture** | Adds one item per line to `Tracker/Inbox.md` |
| When convenient | **Process inbox** | The local LLM suggests a project, a type (task / idea / reference), and a priority. Confident items are filed automatically. |
| Start of week | **Plan week** / **Plan project** | Pick projects, write one goal each, and move tasks from `## Backlog` to `## Planned` with a day |
| During the week | **Home** | Shows today's tasks, the next 7 days, and tasks due *outside this week's focus* |
| Sunday | **Weekly review** | Scores each goal (achieved, partly, or missed, with the reason). Carries, returns, or drops unfinished tasks, and records wins, lessons, and energy. |
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
- Dates use the Tasks plugin's emoji: 📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done. Priorities use ⏫ 🔼 🔽.

## What's in the samples

| Project | Scope | Status | Shows |
|---|---|---|---|
| Sailing | personal | active | A goal carried over from W45, a mix of done and open tasks, and a filled `## Done` |
| Blog | personal | active | A four-task goal with a deadline at the end of the week |
| Home renovation | common | active | A high-priority task due mid-week |
| Family trip | common | active | Not in this week's focus. A backlog task due soon appears in the *Outside focus* box. |
| Spanish | personal | backlog | A parked project with only backlog items |

- **2026-W45** is a reviewed week: goals scored at 67%, 50%, 100%, and 0%, with miss reasons, wins, lessons, and energy.
- **2026-W46** is the current week, planned with three goals.
- `Tracker/Inbox.md` holds four unsorted items to try **Process inbox** on.

## Settings

All settings are in the frontmatter of [Tracker/Config.md](Tracker/Config.md). They include the goal range, the neglect threshold, the LLM provider, URL and model, and the confidence above which items are filed automatically. The note itself explains each setting.

## Privacy

Nothing leaves your machine unless you point the LLM settings elsewhere. The only network call is to the model URL in Config, which is `http://localhost:11434` (Ollama) by default.

## License

See [LICENSE](LICENSE).
