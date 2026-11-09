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
neglect_weeks: 3
plan_next_week_from: 5
plan_schedule_tasks: true
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
llm_auto_file_confidence: 0.9
llm_examples_per_project: 3
---
# Tracker settings

Edit the values in the properties above. This note syncs, so both your Mac and your iPhone use the same settings.

| Setting | What it does |
|---|---|
| `project_roots` | Folders that hold your project folders (one sub-folder per project). Leave empty: **Register projects** asks you and fills this in. The last part of each folder name becomes the project's *scope* (e.g. personal / common). |
| `ignored_folders` | Folders you marked *Not a project* in **Register projects**. Remove a folder from this list to be asked about it again. |
| `weeks_folder`, `inbox` | Where week notes and the inbox live. |
| `goals_min`, `goals_max` | How many weekly goals you aim for. Planning nudges you toward this range. |
| `neglect_weeks` | An active project that hasn't been in focus for this many weeks is flagged. |
| `plan_next_week_from` | From this weekday (1 = Mon … 7 = Sun), **Plan week** suggests next week first. |
| `plan_schedule_tasks` | `true`: when you add a task to a goal, you choose the day (sets the Tasks ⏳ scheduled date). |
| `upcoming_days` | How many days ahead Home looks (after today) for *Next N days* and the *Outside focus* box. |
| `task_tag` | If you use a Tasks *global filter* tag (e.g. `#task`), put it here so new tasks get it. Otherwise leave `""`. |
| `llm_provider` | `ollama`, or `openai` for any OpenAI-compatible server (LM Studio, llama.cpp, Jan). |
| `llm_url` | The model's address on the Mac: `http://localhost:11434` (Ollama) or `http://localhost:1234/v1` (LM Studio). |
| `llm_mobile` | What the iPhone uses to sort the inbox: `off` (you file by hand), `shortcut` (Apple's on-device model through the Shortcuts app — see Start here → iPhone), or `url` (an API address in `llm_url_mobile`). |
| `llm_shortcut` | Name of the shortcut that runs the on-device model. Must match the shortcut's name exactly. |
| `llm_url_mobile`, `llm_provider_mobile`, `llm_model_mobile` | Only for `llm_mobile: url`. Leave empty otherwise. |
| `llm_model` | The model's name, e.g. `qwen2.5:7b-instruct`. |
| `llm_auto_file_confidence` | Items the model is at least this sure about are filed without asking. `1.1` = always ask. |
| `llm_examples_per_project` | How many recent tasks per project the model sees as examples. |
