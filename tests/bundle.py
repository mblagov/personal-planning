"""Bundle the repo's Tracker, Projects and References notes into one JSON file for the jsc tests."""
import json, os, sys
repo, out = sys.argv[1], sys.argv[2]
files = {}
for top in ("Tracker", "Projects", "References"):
    for d, _, fs in os.walk(os.path.join(repo, top)):
        for f in fs:
            if f.endswith((".md", ".js")):
                p = os.path.join(d, f)
                files[os.path.relpath(p, repo)] = open(p, encoding="utf-8").read()
json.dump(files, open(out, "w"))
