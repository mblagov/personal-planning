#!/usr/bin/env python3
"""Update the Tracker system in an Obsidian vault from this repository, keeping your data.

What gets updated, and how:

  replaced   Tracker/Scripts/, Tracker/Views/, Tracker/Commands/,
             Tracker/Start here.md, Tracker/Home.md, Tracker/Analytics.md, Tracker/Projects.md
  merged     Tracker/Config.md: your values are kept; settings that are new in
             this version are added with their defaults; the help text is updated
  created    Tracker/Inbox.md, only if it doesn't exist (never overwritten)
  untouched  Tracker/Weeks/, Tracker/AI/, Tracker/Inbox archive.md, your project notes, everything else

Safety:
  - Every file that is overwritten or removed is first copied to a backup folder
    outside the vault (default: ~/ObsidianTrackerBackups/<vault>-<timestamp>/).
  - A manifest (Tracker/.update-manifest.json) remembers what was installed, so the
    script can tell when you edited a system file yourself (it warns and backs it
    up) and can remove files that a newer version no longer ships, but only if
    you haven't edited them.
  - It shows the plan and asks before changing anything. --dry-run only shows it.

Usage:
  scripts/update-vault.py "/path/to/vault"     # path is remembered in .vault-path
  scripts/update-vault.py                      # reuse the remembered path
  scripts/update-vault.py --dry-run
  OBSIDIAN_VAULT=/path/to/vault scripts/update-vault.py --yes
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "Tracker"
SAVED_PATH = REPO / ".vault-path"
MANIFEST = "Tracker/.update-manifest.json"

SYSTEM = ["Scripts", "Views", "Commands", "Start here.md", "Home.md", "Analytics.md", "Projects.md"]
CONFIG = "Tracker/Config.md"
INBOX = "Tracker/Inbox.md"
# On a fresh install these Config settings start empty instead of pointing at the repo's samples.
FRESH_CONFIG = {"project_roots": "project_roots: []", "ignored_folders": "ignored_folders: []"}
SKIP_NAMES = {".DS_Store"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def system_files() -> dict:
    """Vault-relative path -> bytes for every file the repo ships as 'system'."""
    out = {}
    for entry in SYSTEM:
        p = SRC / entry
        files = [p] if p.is_file() else sorted(f for f in p.rglob("*") if f.is_file())
        for f in files:
            if f.name in SKIP_NAMES:
                continue
            out["Tracker/" + f.relative_to(SRC).as_posix()] = f.read_bytes()
    return out


# ---------------------------------------------------------------- Config merge

def split_frontmatter(text: str):
    """-> (list of (key or None, [lines]), body). Returns (None, text) without frontmatter."""
    m = re.match(r"---\n(.*?\n)---\n", text, re.S)
    if not m:
        return None, text
    blocks = [(None, [])]
    for line in m.group(1).splitlines():
        km = re.match(r"([A-Za-z_][\w-]*)\s*:", line)
        if km and not line.startswith((" ", "\t")):
            blocks.append((km.group(1), [line]))
        else:
            blocks[-1][1].append(line)
    if not blocks[0][1]:
        blocks.pop(0)
    return blocks, text[m.end():]


def join_frontmatter(blocks, body: str) -> str:
    lines = [l for _, ls in blocks for l in ls]
    return "---\n" + "\n".join(lines) + "\n---\n" + body


def merged_config(repo_text: str, vault_text):
    """-> (new_text, added_keys). vault_text None = fresh install."""
    repo_blocks, repo_body = split_frontmatter(repo_text)
    if repo_blocks is None:
        raise SystemExit("Repository Tracker/Config.md has no frontmatter; refusing to merge.")
    if vault_text is None:
        blocks = [(k, [FRESH_CONFIG[k]] if k in FRESH_CONFIG else ls) for k, ls in repo_blocks]
        return join_frontmatter(blocks, repo_body), []
    vault_blocks, _ = split_frontmatter(vault_text)
    if vault_blocks is None:
        raise SystemExit(f"Your {CONFIG} has no frontmatter, so it can't be merged safely. Fix it by hand first.")
    have = {k for k, _ in vault_blocks}
    added = [(k, ls) for k, ls in repo_blocks if k and k not in have]
    return join_frontmatter(vault_blocks + added, repo_body), [k for k, _ in added]


def fresh_inbox(repo_text: str) -> str:
    """The repo's inbox without the sample content: frontmatter, title, the info callout and '## Queue'."""
    m = re.search(r"^## Queue[^\n]*\n", repo_text, re.M)
    if not m:
        return repo_text
    head, keep, in_fm = repo_text[: m.start()].splitlines(), [], False
    for i, line in enumerate(head):
        if i == 0 and line == "---":
            in_fm = True
        if in_fm or line.startswith("# ") or line.startswith(">") or not line.strip():
            keep.append(line)
        if in_fm and i > 0 and line == "---":
            in_fm = False
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(keep).strip("\n") + "\n\n")
    return text + m.group(0) + "\n"


# ---------------------------------------------------------------- plan / apply

def resolve_vault(arg):
    if arg:
        return Path(arg).expanduser(), True
    if os.environ.get("OBSIDIAN_VAULT"):
        return Path(os.environ["OBSIDIAN_VAULT"]).expanduser(), False
    if SAVED_PATH.exists():
        return Path(SAVED_PATH.read_text().strip()).expanduser(), False
    raise SystemExit("Which vault? Pass its folder: scripts/update-vault.py \"/path/to/vault\"")


def build_plan(vault: Path):
    """-> list of actions: dict(op, rel, data, note, backup)."""
    manifest = {}
    mp = vault / MANIFEST
    if mp.exists():
        try:
            manifest = json.loads(mp.read_text()).get("files", {})
        except (ValueError, OSError):
            print(f"warning: couldn't read {MANIFEST}; treating every changed system file as edited by you")

    plan = []
    shipped = system_files()
    for rel, data in shipped.items():
        dst = vault / rel
        if not dst.exists():
            plan.append(dict(op="add", rel=rel, data=data, note="", backup=False))
            continue
        cur = dst.read_bytes()
        if cur == data:
            continue
        edited = rel not in manifest or manifest[rel] != sha(cur)
        note = "you edited this file; your version goes to the backup" if edited and rel in manifest else (
            "differs from this version; current file goes to the backup" if edited else "")
        plan.append(dict(op="update", rel=rel, data=data, note=note, backup=True))

    for rel, h in manifest.items():
        dst = vault / rel
        if rel in shipped or not dst.exists():
            continue
        if sha(dst.read_bytes()) == h:
            plan.append(dict(op="remove", rel=rel, data=None, note="no longer part of the tracker", backup=True))
        else:
            plan.append(dict(op="keep", rel=rel, data=None, note="no longer shipped, but you edited it; left alone", backup=False))

    cfg = vault / CONFIG
    cur_cfg = cfg.read_text() if cfg.exists() else None
    new_cfg, added = merged_config((REPO / CONFIG).read_text(), cur_cfg)
    if cur_cfg is None:
        plan.append(dict(op="add", rel=CONFIG, data=new_cfg.encode(), note="with empty project_roots", backup=False))
    elif new_cfg != cur_cfg:
        note = "your settings kept" + (f"; new settings added: {', '.join(added)}" if added else "; help text updated")
        plan.append(dict(op="merge", rel=CONFIG, data=new_cfg.encode(), note=note, backup=True))

    if not (vault / INBOX).exists():
        plan.append(dict(op="add", rel=INBOX, data=fresh_inbox((REPO / INBOX).read_text()).encode(), note="empty queue", backup=False))
    return plan, shipped


def apply(vault: Path, plan, shipped, backup_root: Path):
    backup = None
    for a in plan:
        if a["backup"]:
            if backup is None:
                stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
                backup, n = backup_root / f"{vault.name}-{stamp}", 1
                while backup.exists():  # never mix two runs' backups
                    n += 1
                    backup = backup_root / f"{vault.name}-{stamp}-{n}"
            dst = backup / a["rel"]
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(vault / a["rel"], dst)
    for a in plan:
        p = vault / a["rel"]
        if a["op"] in ("add", "update", "merge"):
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".tracker-tmp")
            tmp.write_bytes(a["data"])
            os.replace(tmp, p)
        elif a["op"] == "remove":
            p.unlink()
            d = p.parent
            while d != vault / "Tracker" and d.is_dir() and not any(d.iterdir()):
                d.rmdir()
                d = d.parent
    files = {rel: sha(data) for rel, data in shipped.items()}
    (vault / MANIFEST).write_text(json.dumps({
        "updated": datetime.datetime.now().isoformat(timespec="seconds"),
        "files": files,
    }, indent=2) + "\n")
    return backup


def main():
    ap = argparse.ArgumentParser(description="Update the Tracker in an Obsidian vault without losing your data.")
    ap.add_argument("vault", nargs="?", help="vault folder (remembered for next time)")
    ap.add_argument("-n", "--dry-run", action="store_true", help="show what would change, change nothing")
    ap.add_argument("-y", "--yes", action="store_true", help="don't ask for confirmation")
    ap.add_argument("--backup-dir", default="~/ObsidianTrackerBackups", help="where backups go (default: %(default)s)")
    args = ap.parse_args()

    vault, from_arg = resolve_vault(args.vault)
    vault = vault.resolve()
    if not vault.is_dir():
        raise SystemExit(f"Not a folder: {vault}")
    if not (vault / ".obsidian").is_dir():
        raise SystemExit(f"{vault} doesn't look like an Obsidian vault (no .obsidian folder).")
    if vault == REPO or SRC.resolve() == (vault / "Tracker").resolve():
        raise SystemExit("That's this repository itself. Point the script at your real vault.")
    fresh = not (vault / "Tracker").exists()

    print(f"Vault: {vault}" + ("  (Tracker not installed yet: fresh install)" if fresh else ""))
    plan, shipped = build_plan(vault)
    if not plan:
        print("Already up to date.")
        if from_arg and not args.dry_run:
            SAVED_PATH.write_text(str(vault) + "\n")
        return
    width = max(len(a["op"]) for a in plan)
    for a in plan:
        print(f"  {a['op']:<{width}}  {a['rel']}" + (f"   ({a['note']})" if a["note"] else ""))
    print("Not touched: Tracker/Weeks, Tracker/AI, your projects and all other notes.")

    if args.dry_run:
        print("Dry run: nothing changed.")
        return
    if not args.yes:
        if not sys.stdin.isatty():
            raise SystemExit("Not a terminal, so I can't ask. Re-run with --yes to apply.")
        if input("Apply these changes? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Cancelled: nothing changed.")
            return

    backup = apply(vault, plan, shipped, Path(args.backup_dir).expanduser())
    if from_arg:
        SAVED_PATH.write_text(str(vault) + "\n")
    print(f"Done: {sum(a['op'] != 'keep' for a in plan)} change(s).")
    if backup:
        print(f"Backup of replaced files: {backup}")
    if fresh:
        print("Next: in Obsidian, install Dataview, Templater and Tasks, then open Tracker/Start here.")
    else:
        print("Tip: run 'Register projects' once in Obsidian so existing projects get any new sections.")


if __name__ == "__main__":
    main()
