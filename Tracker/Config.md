---
type: config
project_roots:
  - Projects/personal
  - Projects/common
ignored_folders: []
weeks_folder: Tracker/Weeks
inbox: Tracker/Inbox.md
goals_min: 5
goals_max: 7
focus_priority: 2
plan_next_week_from: 5
plan_schedule_tasks: true
plan_due_dates: true
plan_estimates: true
plan_times: true
log_time_on_done: true
upcoming_days: 7
task_tag: ""
llm_provider: ollama
llm_url: http://localhost:11434
llm_mobile: "off"
llm_shortcut: Tracker Classify
llm_url_mobile: ""
llm_provider_mobile: ""
llm_model_mobile: ""
llm_model: qwen2.5:7b-instruct
llm_flag_below: 0.6
reference_folder: References
finance_file: Finance/Spendings.md
finance_project: ""
currency: EUR
llm_examples_per_project: 3
llm_batch: 6
llm_context: 8192
llm_keep_alive: 30m
llm_think: false
calendar_client_id: ""
calendar_client_secret: ""
calendar_id: primary
calendar_show: ""
calendar_timezone: ""
calendar_default_minutes: 30
calendar_sync_minutes: 15
---
# Tracker settings

Edit the values in the properties above. This note syncs, so both your Mac and your iPhone use the same settings.

| Setting | What it does |
|---|---|
| `project_roots` | Folders that hold your project folders (one sub-folder per project). Leave empty: **Register projects** asks you and fills this in. The last part of each folder name becomes the project's *scope* (e.g. personal / common). |
| `ignored_folders` | Folders you marked *Not a project* in **Register projects**. Remove a folder from this list to be asked about it again. |
| `weeks_folder`, `inbox` | Where week notes and the inbox live. |
| `goals_min`, `goals_max` | How many weekly goals you aim for. Planning nudges you toward this range. |
| `focus_priority` | Active projects with this priority or higher (1 = top, so `2` means P1 and P2) are flagged on Home and in Analytics when they aren't in this week's plan. Lower priorities are never flagged: leaving them alone while you finish the top ones is the point. `0` = flag nothing. |
| `plan_next_week_from` | From this weekday (1 = Mon … 7 = Sun), **Plan week** suggests next week first. |
| `plan_schedule_tasks` | `true`: when you add a task to a goal, you choose the day (sets the Tasks ⏳ scheduled date). |
| `plan_due_dates` | `true`: when you add a task to a goal, you can also set a deadline (the Tasks 📅 due date): a day of that week, or any other date. |
| `plan_estimates` | `true`: when you plan a task, you're also asked how long it will take (hands-on). Saved as `[est:: 2h]`. |
| `plan_times` | `true`: when you plan a task with a day, you're asked whether it has a set time. A time (`[time:: 14:30]` or `[time:: 14:30-15:30]`) puts it in Google Calendar; *any time that day* keeps it out. |
| `log_time_on_done` | `true`: ticking a task that has an estimate in a Tracker view asks how long it actually took (active and passive time). Cancel to skip. |
| `upcoming_days` | How many days ahead Home looks (after today) for *Next N days* and the *Outside focus* box. |
| `task_tag` | If you use a Tasks *global filter* tag (e.g. `#task`), put it here so new tasks get it. Otherwise leave `""`. |
| `llm_provider` | `ollama`, or `openai` for any OpenAI-compatible server (LM Studio, llama.cpp, Jan). |
| `llm_url` | The model's address on the Mac: `http://localhost:11434` (Ollama) or `http://localhost:1234/v1` (LM Studio). |
| `llm_mobile` | What the iPhone uses to sort the inbox: `off` (you file by hand), `shortcut` (Apple's on-device model through the Shortcuts app — see Start here → iPhone), or `url` (an API address in `llm_url_mobile`). |
| `llm_shortcut` | Name of the shortcut that runs the on-device model. Must match the shortcut's name exactly. |
| `llm_url_mobile`, `llm_provider_mobile`, `llm_model_mobile` | Only for `llm_mobile: url`. Leave empty otherwise. |
| `llm_model` | The model's name, e.g. `qwen2.5:7b-instruct`. |
| `llm_flag_below` | In the Classified inbox, items the model is less sure about than this are marked `[check:: unsure]`. |
| `reference_folder` | Your reference notes (one per topic, e.g. `Travel`, `Recipes`). References from the inbox — places to visit, recommendations, how-tos, links — go there, never into projects. A topic that doesn't exist yet becomes a new note here. Give each note a `description` so the model can pick it. |
| `finance_file` | Spendings from the inbox are collected in this note under *Unprocessed*, with one *Process N new spending(s)* task. |
| `finance_project` | A project for that task (e.g. `"[[Finance]]"`). Empty = the task sits in the finance note itself. |
| `currency` | Currency for spendings that don't name one, e.g. `EUR`. |
| `llm_examples_per_project` | How many recent tasks per project the model sees as examples. Fewer = a shorter prompt = faster. |
| `llm_batch` | How many inbox items are sorted in one request. Every request carries your whole project list, so sorting 6 at a time reads it 6× less often. `1` = one at a time (slowest, sometimes slightly more careful). |
| `llm_context` | Ollama only: the context window in tokens. The project list, the rules and the items must fit, or the start gets cut off. 8192 is plenty for ~40 projects; larger needs more memory. |
| `llm_keep_alive` | Ollama only: how long the model stays loaded after a request (`30m`). Loading it again takes seconds to a minute. |
| `llm_think` | `false`: thinking models (qwen3, deepseek-r1, gpt-oss…) answer without writing their reasoning first — usually many times faster, and enough for sorting. `true` lets them think. |
| `calendar_client_id`, `calendar_client_secret` | Your Google OAuth client for the calendar sync (type *Desktop app*). Empty = no calendar. See *Start here → Google Calendar*. |
| `calendar_id` | The calendar timed tasks go to: `primary` (your main calendar) or a calendar's id from Google Calendar → Settings → *Integrate calendar*. A separate “Tasks” calendar keeps them apart. |
| `calendar_show` | More calendars whose events are shown on Home (ids, comma-separated), e.g. a family calendar. |
| `calendar_timezone` | Time zone for events, e.g. `Europe/Vienna`. Empty = this device's. |
| `calendar_default_minutes` | How long an event is when the task has only a start time and no estimate. With an estimate, the event lasts that long. |
| `calendar_sync_minutes` | Home syncs with the calendar when it opens and the last sync is older than this. `0` = only when you press *Sync* or run **Sync calendar**. |
