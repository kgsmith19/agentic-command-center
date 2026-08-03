# ROUTING.md — CI test fixture, NOT the real routing table

This file exists only so `hooks/route.test.mjs` has a table to score against on
CI (the real table lives one directory above the repo — see `hooks/route.mjs`'s
`TABLE` resolution — and is never checked in). Every path/label/signal below is
derived directly from `hooks/route.test.mjs`'s assertions; do not "clean it up"
without re-checking every test in that file, including the deliberate scoring
tie between `lifeos` and `lifeos-ui` (shared `fastapi` signal) that the
"exact tie across two repos" test depends on.

```json
{
  "routes": [
    { "path": "C:\\code", "label": "root", "signals": ["across all repos"] },
    { "path": "C:\\code\\guards", "label": "guards", "signals": ["budget hook", "command center", "guards hook"] },
    { "path": "C:\\code\\lifeos-ecosystem", "label": "lifeos-ecosystem", "signals": ["api contract", "types\\.gen\\.ts"] },
    { "path": "C:\\code\\lifeos-ecosystem\\lifeos", "label": "lifeos", "signals": ["supabase", "pytest", "fastapi"] },
    { "path": "C:\\code\\lifeos-ecosystem\\lifeos-ui", "label": "lifeos-ui", "signals": ["react", "tailwind", "playwright"] }
  ]
}
```
