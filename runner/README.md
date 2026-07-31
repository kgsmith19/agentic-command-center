# guards runner

External loop that relaunches `claude -p` headless, one board task per
session — fresh context per task by construction (a live session cannot
/clear itself; a new process needs no clearing). No daemon: run it by hand
or let Windows Task Scheduler own time.

    node C:\code\guards\runner\runner.mjs slice-runner            # loop now
    node C:\code\guards\runner\runner.mjs slice-runner --once     # one run (debug)
    node C:\code\guards\runner\runner.mjs slice-runner --install  # schtasks entry (needs job.schedule)
    node C:\code\guards\runner\runner.mjs slice-runner --status   # log tail + alerts

Job spec (`jobs/<name>.json`): `name`, `workdir`, `bootstrap` (the -p
prompt), `statusFile` (progress = its hash changes between runs),
`doneMarker` (a whole line in statusFile exactly equal to this ends the loop), optional
`maxStuck` (default 3 — consecutive no-progress runs before alert+stop),
`maxRuns` (100), `runTimeoutMin` (180), `schedule` ({"type":"daily",
"time":"HH:MM"}, only needed for --install).

Design constraints (deliberate):
- Sessions run WITHOUT --bare: the guard hook stack is the safety layer
  that makes headless bypassPermissions acceptable. Never add --bare.
- Stop conditions are the job's, not the model's: done-marker, stuck-N
  (alert file in alerts/), maxRuns, per-run timeout. Alerts + exit codes
  (2 stuck, 3 maxRuns, 4 graceful stop: create stop/<job>.stop, honored between runs) are the operator surface; logs rotate at 1 MiB.
- One loop instance per job at a time; nothing here mutates guards state
  (config/vault untouched) — the runner only reads its own folder and the
  job workdir's status file.

Next job candidates: doc-sync (audit docs vs reality across repos, open
docs-only PRs), weekly doctor pass.
