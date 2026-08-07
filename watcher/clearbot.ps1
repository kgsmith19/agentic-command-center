# ACC clear-watcher ("clearbot") - the outside process that physically types
# /clear into the Claude Code terminal when a session is over its context budget.
#
# WHY THIS EXISTS: hooks cannot clear context. Verified against claude.exe 2.1.220 -
# the only clearContext path is plan-mode internal, and no hook event can run a
# slash command. So the clear has to come from outside the process, as real
# keystrokes. This is that outside process.
#
# WHY IT FIRES ON A REQUEST FILE, NOT A TIMER: budget.mjs writes a request at the
# Stop hook, which is a TURN BOUNDARY - the session is idle and the prompt is
# empty. Typing on a wall-clock timer could land mid-turn and inject "/clear" into
# the middle of a tool call or a half-written file.
#
# SAFETY INVARIANTS (all enforced below, every cycle):
#   1. The typeable set is closed and auditable:
#        a. "/clear" - a constant.
#        b. "/cd <path>" where <path> is byte-identical to a route listed in
#           ROUTING.md AND exists on disk. Not "a path the caller asked for" -
#           a path from the route table. ROUTING.md is not in the protected list
#           (may be edited by agents), but it is read fresh each cycle so a
#           tampered request cannot bypass this check. Anything else is refused.
#        c. Replay text: caller-chosen, single-line, ≤2000 chars, printable-only,
#           passed via req.replay after a cd. Design intent is to replay the
#           session's own prompt (captured by budget.mjs and passed in the
#           request), but the code allows any printable text matching those
#           constraints.
#        d. "$KICK" - a constant. It restarts an active directive after a clear. The
#           DIRECTIVE TEXT IS NEVER TYPED: it reaches the model through SessionStart
#           context, so a multi-line directive is safe by construction (OI-004).
#        e. Esc - a single constant key event, sent ONLY in the escalation path
#           when a typed /clear did not land (the over-budget turn refuses to
#           end, OI-011); at most once per session per 10 minutes. It interrupts
#           the turn; it cannot type, submit, or delete anything.
#      The replay path (c) accepts caller-chosen text subject to content filtering.
#   2. It types only into the exact console PID the session recorded for itself
#      via winfind.ps1. It never searches by window title and never guesses.
#      VERIFIED, not trusted: Test-Binding re-reads runner/state/<sid>.window
#      and refuses any request whose consolePid disagrees with it, so a request
#      file cannot aim keystrokes at a console that is not its own session's.
#   3. Injection is WriteConsoleInput, addressed by PID, so it needs no focus:
#      there is no "whatever has focus" to type into by mistake, and it cannot
#      steal focus from what Kyle is doing. Missing/dead PID => skip, never guess.
#   4. Requests older than 15 minutes are discarded, not executed.
#   5. Live context is re-checked before typing; if the session already shrank
#      (someone cleared manually) the request is dropped.
#   6. Kill switch: watcher/clearbot.stop present => does nothing at all.
#   7. One clear per session per 60s, tracked in-process.
#
# OI-010: Send-MultilineKeys (below) adds a pty-transport primitive that can
# carry a multi-line payload -- the wire framing (TEXTB64 in PtyHost.cs) that
# invariant 1c's "single-line" constraint exists because of is no longer an
# absolute limit. It has NO caller in the cycle loop below, so it changes
# nothing about what is typed automatically today; invariant 1's closed set
# is unchanged until something calls it.
param(
    [int]$IntervalMs = 2000,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$Root     = Split-Path $PSScriptRoot -Parent
$ReqDir   = Join-Path $Root 'runner\clear-requests'
$StopFile = Join-Path $PSScriptRoot 'clearbot.stop'
$LogFile  = Join-Path $PSScriptRoot 'clearbot.log'
# Liveness signal for the statusline and the SessionStart warning. The MTIME is
# the signal; the content is for a human who opens the file. Written every Step,
# so "older than ~30s" means this process is gone or wedged - which used to be
# invisible, and silently ends ALL autonomy (no clears, no resumes).
$HeartbeatFile = Join-Path $PSScriptRoot 'clearbot.heartbeat'
$SendConsole = Join-Path $PSScriptRoot 'sendconsole.ps1'
$StateDir = Join-Path $Root 'runner\state'
$MaxAgeSec = 900
$KEYS = '/clear'          # invariant 1a.
$KICK = 'Continue the active ACC directive.'   # invariant 1d.
$QUEUEKICK = 'Run the queued prompt.'     # invariant 1d: never the prompt itself.
# ACC_ROUTING_MD mirrors route.mjs's own override (hooks/route.mjs) -- same
# reason: a sandboxed test's $Root has no real repo-tree parent to find a real
# ROUTING.md above, so without this override every /cd in a test is refused
# as off-table regardless of the path given, and the /cd path can never be
# exercised end to end.
$RoutingMd = if ($env:ACC_ROUTING_MD) { $env:ACC_ROUTING_MD } else { Join-Path (Split-Path $Root -Parent) 'ROUTING.md' }

# invariant 1b: the set of directories this program may ever type is exactly the
# route list in ROUTING.md. Read fresh each time so an edit there takes effect
# without a restart, and so a tampered request file cannot widen the set.
function Get-AllowedPaths {
    try {
        $md = Get-Content $RoutingMd -Raw -ErrorAction Stop
        $m = [regex]::Match($md, '(?s)```json\s*(.*?)```')
        if (-not $m.Success) { return @() }
        return @(($m.Groups[1].Value | ConvertFrom-Json).routes | ForEach-Object { $_.path })
    } catch { return @() }
}

# invariant 1c: re-derive replay safety here rather than trusting the request.
function Test-Replayable([string]$s) {
    if ([string]::IsNullOrEmpty($s)) { return $false }
    if ($s.Length -gt 2000) { return $false }
    return ($s -notmatch '[\x00-\x1f\x7f]')
}

# invariant 2, ENFORCED rather than trusted (guards OI-004): a request names the
# console to type into, but the SESSION recorded its own console in
# runner/state/<sid>.window. If those disagree, the request did not come from
# that session - refuse, do not type. No window record = cannot verify = refuse.
function Test-Binding($req) {
    $sid = [string]$req.sessionId
    if (-not $sid) { return $false }
    $wf = Join-Path $Root ("runner\state\{0}.window" -f $sid)
    if (-not (Test-Path -LiteralPath $wf)) { return $false }
    try { $win = Get-Content $wf -Raw | ConvertFrom-Json } catch { return $false }
    return ([int]$win.consolePid -ne 0 -and [int]$win.consolePid -eq [int]$req.consolePid)
}

# The escalation threshold must not come from the request file - that would let
# whoever writes one choose when Esc gets pressed. policy.json is the authority.
function Get-HardK {
    try {
        $pol = Get-Content (Join-Path $Root 'policy.json') -Raw | ConvertFrom-Json
        $v = [int]$pol.context.hardK
        if ($v -gt 0) { return $v }
    } catch {}
    return 600
}

# guards OI-003: how long a just-started (or just-turned) session's TUI needs
# before injected input actually lands. Single source of truth shared with
# hooks/directive.mjs's kick delay (policy.json tui.readySettleMs) -- see that
# dial's _note for why clearbot no longer guesses its own number here.
function Get-TuiReadyMs {
    try {
        $pol = Get-Content (Join-Path $Root 'policy.json') -Raw | ConvertFrom-Json
        $v = [int]$pol.tui.readySettleMs
        if ($v -gt 0) { return $v }
    } catch {}
    return 4000
}

# --- pty transport (spec 2026-07-31) --------------------------------------
# A session ACC hosts on a pseudoconsole records transport:"pty" plus its pipe
# name in runner/state/<sid>.window (hooks/budget.mjs). For those, writing the
# pipe protocol IS pressing the keys - a lone \r on a pty is a real Enter,
# where an injected text+CR batch reads as a paste and the CR is absorbed
# (the bug that left every kick sitting unsubmitted). Everything else keeps
# keystroke injection, and a dead pipe degrades to it too, so a GUI failure
# never stalls the loop.
function Get-TermPipe([int]$ConsolePid) {
    # No enumeration-based liveness check here: \\.\pipe\ enumeration is not a
    # reliable liveness signal for a .NET NamedPipeServerStream on a synchronous
    # handle - BeginWaitForConnection's compat shim makes a correctly-listening,
    # never-touched pipe intermittently vanish from the enumeration (observed
    # 2026-07-31: a known-live pipe toggled found/not-found roughly every 300ms
    # with zero connections made). Gating transport choice on that flickered the
    # feature straight back into keystroke injection - the bug pty transport
    # exists to avoid. The real liveness check is Send-Pipe's own Connect(2000),
    # which already falls back to keystroke injection on failure.
    foreach ($f in (Get-ChildItem -Path (Join-Path $Root 'runner\state') -Filter '*.window' -ErrorAction SilentlyContinue)) {
        try { $w = Get-Content -Raw $f.FullName | ConvertFrom-Json } catch { continue }
        if ($w.transport -eq 'pty' -and [int]$w.consolePid -eq $ConsolePid -and $w.pipe) {
            return [string]$w.pipe
        }
    }
    return $null
}

# Ops entries: 'ESC', 'SUBMIT', 'TEXT <payload>', or 'TEXTB64 <payload>'. One
# op per connection, matching the server. The server enforces the same
# refusals as sendconsole.ps1 (control chars, length); content policy stays
# here.
function Send-Pipe([string]$PipeName, [string[]]$Ops) {
    foreach ($op in $Ops) {
        try {
            $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
            $c.Connect(2000)
            $w = New-Object System.IO.StreamWriter($c); $w.AutoFlush = $true
            $r = New-Object System.IO.StreamReader($c)
            $w.WriteLine($op)
            $resp = $r.ReadLine()
            $c.Dispose()
            if ($resp -ne 'OK') { return @{ ok = $false; out = "$op -> $resp" } }
        } catch { return @{ ok = $false; out = "$op -> $($_.Exception.Message)" } }
        # The paste heuristic is exactly what broke injection: give the TUI a
        # beat between the text and the Enter so the CR is its own keypress.
        # 'TEXT*' (not 'TEXT *') deliberately also matches 'TEXTB64 ...' -- OI-010's
        # multi-line op needs the exact same settle before SUBMIT that TEXT gets.
        if ($op -like 'TEXT*') { Start-Sleep -Milliseconds 80 }
    }
    return @{ ok = $true; out = 'OK' }
}

function Send-Keys($cpid, [string]$text, [switch]$ClearLineFirst) {
    $pipe = Get-TermPipe $cpid
    if ($pipe) {
        $ops = @()
        if ($ClearLineFirst) { $ops += 'ESC' }
        $ops += ('TEXT ' + $text)
        $ops += 'SUBMIT'
        $r = Send-Pipe $pipe $ops
        if ($r.ok) { return @{ ok = $true; out = "pty OK pipe=$pipe" } }
        Log "WARN pty pipe '$pipe' failed ($($r.out)) - falling back to keystroke injection"
    }
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$SendConsole,'-TargetPid',$cpid,'-Text',$text)
    if ($ClearLineFirst) { $a += '-ClearLineFirst' }
    $out = & powershell @a 2>&1 | Out-String
    return @{ ok = ($out -match 'OK wrote='); out = $out.Trim() }
}

# OI-010: the pty-transport equivalent of Send-Keys for a MULTI-LINE payload.
# No keystroke-injection fallback -- sendconsole.ps1 refuses multi-line text
# outright (a newline there would submit a fragment, several prompts instead
# of one, exactly what OI-004 exists to prevent), so a dead/absent pty pipe
# means this fails rather than degrading. Dormant infrastructure as of
# OI-010's close: nothing in the cycle loop below calls it yet -- deciding
# whether clearbot should auto-replay a multi-line prompt is a separate,
# larger decision this fix does not make.
function Send-MultilineKeys($cpid, [string[]]$Lines, [switch]$ClearLineFirst) {
    $pipe = Get-TermPipe $cpid
    if (-not $pipe) { return @{ ok = $false; out = 'no pty pipe for this console' } }
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Lines -join "`r`n")))
    $ops = @()
    if ($ClearLineFirst) { $ops += 'ESC' }
    $ops += ('TEXTB64 ' + $b64)
    $ops += 'SUBMIT'
    $r = Send-Pipe $pipe $ops
    if ($r.ok) { return @{ ok = $true; out = "pty OK pipe=$pipe" } }
    return @{ ok = $false; out = "pty pipe '$pipe' failed ($($r.out))" }
}

# invariant 1e: the only non-text injection. One Esc, nothing else.
function Send-Esc($cpid) {
    $pipe = Get-TermPipe $cpid
    if ($pipe) {
        $r = Send-Pipe $pipe @('ESC')
        if ($r.ok) { return @{ ok = $true; out = "pty OK pipe=$pipe" } }
        Log "WARN pty pipe '$pipe' failed ($($r.out)) - falling back to keystroke injection"
    }
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $SendConsole `
                        -TargetPid $cpid -Esc 2>&1 | Out-String
    return @{ ok = ($out -match 'OK wrote='); out = $out.Trim() }
}

function Invoke-Cd($req) {
    # What may be typed is checked BEFORE whether there is anywhere to type it.
    # A dead pid is a boring skip; an off-table path is the thing that must never
    # pass, so it is never allowed to hide behind an earlier return.
    $dest = [string]$req.path
    $allowed = Get-AllowedPaths
    if ($allowed -notcontains $dest) {
        Log "REFUSE cd $($req.sessionId): '$dest' is not a route in ROUTING.md"; return $false
    }
    if (-not (Test-Path -LiteralPath $dest)) {
        Log "REFUSE cd $($req.sessionId): '$dest' does not exist"; return $false
    }
    if (-not (Test-Binding $req)) {
        Log "REFUSE cd $($req.sessionId): consolePid $($req.consolePid) does not match the session's own window record"
        return $false
    }

    $cpid = [int]$req.consolePid
    if (-not $cpid) { Log "SKIP cd $($req.sessionId): no consolePid"; return $false }
    if (-not (Get-Process -Id $cpid -ErrorAction SilentlyContinue)) {
        Log "SKIP cd $($req.sessionId): console pid $cpid is gone"; return $false
    }

    # Order matters: clear first (it resets the window, not the directory), then
    # cd so the new folder's CLAUDE.md loads into the fresh context, then replay.
    if ($req.clear) {
        $r = Send-Keys $cpid $KEYS -ClearLineFirst
        if (-not $r.ok) { Log "ABORT cd $($req.sessionId): clear failed -> $($r.out)"; return $false }
        Start-Sleep -Milliseconds 1200
    }

    # OI-003: the non-clear path used to send /cd with zero settle delay,
    # typing it before a just-started session's REPL was ready to receive it
    # (reproduced: two consecutive cd requests, both logged as sent, neither
    # took effect -- the second was clear=False). A first fix gave it a flat
    # 1200ms and that ALSO failed a real-token repro (2026-08-04): typed and
    # replayed exactly as logged, cwd never moved. 1200ms was a guess unrelated
    # to the one number in this codebase already proven for "is this session's
    # TUI ready for injected input" -- hooks/directive.mjs's kick delay, empirically
    # tuned to 4000ms and proven via OI-002. Get-TuiReadyMs now reads the same
    # policy.json dial (tui.readySettleMs) directive.mjs falls back to, so there is
    # exactly one number instead of two independently-guessed ones. NOT yet
    # re-verified against a real session -- that still needs a real-token
    # `node e2e/loop.e2e.mjs --only 4` run (Kyle's call on timing, same as
    # every other real-token proof in this repo).
    if (-not $req.clear) { Start-Sleep -Milliseconds (Get-TuiReadyMs) }

    $r = Send-Keys $cpid "/cd $dest" -ClearLineFirst
    if (-not $r.ok) { Log "ABORT cd $($req.sessionId): /cd failed -> $($r.out)"; return $false }
    Log "CD $($req.sessionId) -> $dest (clear=$($req.clear)) consolePid=$cpid"

    # invariant 1d again: an untypable prompt was written to runner/queued/ and
    # injected by the new session's SessionStart, so all that is typed here is a
    # constant. Nothing derived from the prompt ever becomes keystrokes.
    $replay = [string]$req.replay
    if ($req.queued) {
        Start-Sleep -Milliseconds 1200
        $r = Send-Keys $cpid $QUEUEKICK -ClearLineFirst
        if ($r.ok) { Log "QUEUEKICK $($req.sessionId): queued prompt handed over" }
        else       { Log "WARN $($req.sessionId): queue kick failed -> $($r.out)" }
    } elseif (Test-Replayable $replay) {
        Start-Sleep -Milliseconds 1200
        $r = Send-Keys $cpid $replay -ClearLineFirst
        if ($r.ok) { Log "REPLAY $($req.sessionId): $($replay.Length) chars" }
        else       { Log "WARN $($req.sessionId): replay failed -> $($r.out)" }
    } else {
        Log "NOREPLAY $($req.sessionId): prompt not single-line printable"
    }
    return $true
}

New-Item -ItemType Directory -Force -Path $ReqDir | Out-Null

# NOTE: the Win32 focus machinery that used to live here (SetForegroundWindow,
# AttachThreadInput, the ALT-press unlock) is GONE on purpose. Windows refuses
# foreground changes from a background process, so it never worked; injection via
# sendconsole.ps1 needs no focus at all. Do not reintroduce it.

function Log($m) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    # Write-Host, NOT Write-Output. Write-Output emits into the calling
    # function's OUTPUT stream, so every Log call inside Invoke-Clear /
    # Invoke-Cd was captured by `$did = Invoke-Clear $req` instead of reaching
    # the console - and worse, it made $did an ARRAY (@("...", $false)), which
    # PowerShell treats as TRUE. A failed clear therefore looked like a success
    # and armed the 60s throttle. Write-Host goes to the host (and so to
    # stdout under -File) without touching the pipeline.
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding ascii } catch {}
}

# Live context for a transcript, via the same ledger the hooks use.
function Get-Context($transcript) {
    try {
        $node = (Get-Command node -ErrorAction Stop).Source
        $expr = "import('file:///" + ($Root -replace '\\','/') + "/hooks/usage.mjs').then(m=>{console.log(m.contextOf(process.argv[1])||0)})"
        $v = & $node -e $expr $transcript 2>$null
        return [int]($v | Select-Object -Last 1)
    } catch { return -1 }
}

function Invoke-Clear($req) {
    # invariant 2: address the session's OWN console by PID. Never search by
    # title, never type into "whatever is in front" - and never take the
    # request's word for which console that is (guards OI-004).
    if (-not (Test-Binding $req)) {
        Log "REFUSE $($req.sessionId): consolePid $($req.consolePid) does not match the session's own window record"
        return $false
    }
    $cpid = [int]$req.consolePid
    if (-not $cpid) { Log "SKIP $($req.sessionId): no consolePid recorded"; return $false }
    if (-not (Get-Process -Id $cpid -ErrorAction SilentlyContinue)) {
        Log "SKIP $($req.sessionId): console pid $cpid is gone"; return $false
    }

    # invariant 3: injecting into that console's input buffer needs no focus, so
    # there is no "wrong window" to guard against and nothing is stolen from Kyle.
    # Send-Keys picks the transport: pty pipe for ACC-hosted sessions, keystroke
    # injection for everything else.
    $r = Send-Keys $cpid $KEYS -ClearLineFirst
    if (-not $r.ok) {
        Log "ABORT $($req.sessionId): injection failed -> $($r.out)"
        return $false
    }
    Log "CLEARED $($req.sessionId) ctx=$($req.ctx) consolePid=$cpid ($($r.out))"
    return $true
}

# --- directive resume ---------------------------------------------------------
# A clear with no follow-up leaves a fresh session sitting at an empty prompt,
# which is where the old chain ended and a human had to retype the task. This is
# the other half: if a directive owns that console and is still active, type one
# constant to restart it.
#
# EVERY condition that makes a kick unsafe is decided in directive.mjs (active? console
# alive? binding settled? cooldown expired?) so there is exactly one place to
# audit. This function stays a dumb executor on purpose.
function Invoke-Kicks {
    $raw = ''
    try { $raw = & node (Join-Path $Root 'hooks\directive.mjs') 'pending' 2>$null | Out-String } catch { return }
    $pend = $null
    try { $pend = $raw | ConvertFrom-Json } catch { return }
    if (-not $pend) { return }

    # A red week is a hard stop for anything that spends tokens without a human
    # asking. Checked only when there is actually something to fire, so the normal
    # idle loop stays free.
    try {
        $t = (& node (Join-Path $Root 'hooks\usage.mjs') 'check' 2>$null | Out-String | ConvertFrom-Json)
        if ($t -and $t.tier -eq 'red') { Log 'HOLD kicks: week usage is at the RED line'; return }
    } catch { }

    foreach ($g in @($pend)) {
        # #13: pendingKicks() reads consolePid out of the directive store, a
        # local, unsigned, agent-writable JSONL file -- unlike Invoke-Cd/
        # Invoke-Clear, this path had no check that the console it is about to
        # type into actually belongs to the session that owns this directive.
        # Same enforcement as invariant 2 (Test-Binding, guards OI-004):
        # re-read the session's OWN window record and refuse on disagreement.
        if (-not (Test-Binding $g)) {
            Log "REFUSE kick $($g.id): consolePid $($g.consolePid) does not match session $($g.sessionId)'s own window record"
            continue
        }
        $cpid = [int]$g.consolePid
        if (-not (Get-Process -Id $cpid -ErrorAction SilentlyContinue)) { continue }
        $r = Send-Keys $cpid $KICK -ClearLineFirst
        if ($r.ok) {
            & node (Join-Path $Root 'hooks\directive.mjs') 'kicked' $g.id 2>$null | Out-Null
            # $r.out names the transport ("pty OK" vs sendconsole output) - the
            # e2e proof tier greps this line for it.
            Log "RESUMED directive $($g.id) cycle $($g.cycles) consolePid=$cpid via $($r.out)"
        } else {
            Log "WARN resume $($g.id) failed -> $($r.out)"
        }
    }
}

# --- auto-approve ---------------------------------------------------------
# Kyle's call: the Command Center runs the scripts Claude leaves in the runbox
# instead of waiting for a human to press /approve. This is honest about what it
# is - it removes a gate. It costs little that was not already gone, because a
# session can write AND run a runbox script itself; the gate was friction, not a
# control. What still is a control, and is untouched: the secrets list
# (.env, *.pem, *.key, id_rsa*, vault.json) that guard.mjs protects.
#
# TWO THINGS MUST NOT LOOP, and both are handled here rather than trusted:
#   - a [keep] script stays in the runbox after running, so auto-running it would
#     re-run it every cycle forever. Standing scripts are never auto-run.
#   - a FAILED script also stays. It is attempted once per watcher lifetime and
#     then left alone with a log line, instead of retried into the ground.
$autoTried = @{}

function Invoke-AutoApprove {
    $pol = $null
    try { $pol = Get-Content (Join-Path $Root 'policy.json') -Raw | ConvertFrom-Json } catch { return }
    if (-not $pol.autoApprove -or -not $pol.autoApprove.enabled) { return }

    $items = $null
    try { $items = & node (Join-Path $Root 'hooks\engine.mjs') 'list' '--json' 2>$null | Out-String | ConvertFrom-Json } catch { return }
    if (-not $items) { return }

    foreach ($it in @($items)) {
        $ref = "$($it.label):$($it.name)"
        if ($it.keep) { continue }                       # standing script - deliberate only
        if ($autoTried.ContainsKey($ref)) { continue }   # attempted once, never hammered
        $autoTried[$ref] = Get-Date

        Log "AUTO-APPROVE running $ref - $($it.summary)"
        # A failing script must be a LOGGED failure, not an exception that
        # aborts the cycle. Under $ErrorActionPreference='Stop', redirecting a
        # native command's stderr (2>&1) turns each stderr line into a
        # terminating ErrorRecord, so one noisy script threw straight past the
        # FAILED logging below and out of Step - the failure vanished from
        # approvals.log and the rest of the cycle was skipped. Observed
        # 2026-07-31 with acc-watchdog-register.ps1.
        $out = ''
        $ok = $false
        $prevEap = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $out = & node (Join-Path $Root 'hooks\engine.mjs') 'run' $ref 2>&1 | Out-String
            $ok = ($LASTEXITCODE -eq 0)
        } catch {
            $out = $_.Exception.Message
            $ok = $false
        } finally {
            $ErrorActionPreference = $prevEap
        }
        Log "AUTO-APPROVE $ref -> $(if ($ok) { 'OK' } else { "FAILED (exit $LASTEXITCODE) - left in the runbox, not retried" })"
        try {
            Add-Content -Path (Join-Path $PSScriptRoot 'approvals.log') -Encoding ascii -Value (
                ("{0}  {1}  {2}`r`n{3}`r`n" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $(if ($ok) { 'OK  ' } else { 'FAIL' }), $ref, $out.Trim()))
        } catch {}
    }
}

$lastFire = @{}
# invariant 1e: one escalation per session per 10 minutes, tracked in-process.
$escalated = @{}

# OI-009: an ACC-hosted session's claude.exe lives inside the GUI's ConPTY, so
# a GUI crash silently kills the session too - no heartbeat, no surfacing.
# clearbot already runs continuously and independently of any one session's
# own hooks (unlike budget.mjs's reviveClearbotIfDead, which only fires from
# a Stop hook - useless if the hosted session IS the thing that just died), so
# it is the right place to notice. Liveness is tracked on disk, not in-process
# memory, the same way clearbot.heartbeat already is: a `-Once` test run (or a
# crash-and-restart of clearbot itself) must not lose "was this alive a moment
# ago", or a merely-old .window file from a long-finished session would look
# exactly like a live one that just died.
function Watch-HostedGui {
    foreach ($f in @(Get-ChildItem $StateDir -Filter *.window -ErrorAction SilentlyContinue)) {
        $sid = $f.BaseName
        $deadMarker = Join-Path $StateDir "$sid.gui-dead.json"
        if (Test-Path $deadMarker) { continue }   # already surfaced once - don't re-alert every cycle

        $w = $null
        try { $w = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch {}
        if (-not $w -or $w.transport -ne 'pty' -or -not $w.consolePid) { continue }

        $aliveMarker = Join-Path $StateDir "$sid.pty-alive"
        $alive = Get-Process -Id ([int]$w.consolePid) -ErrorAction SilentlyContinue
        if ($alive) {
            try { Set-Content -Path $aliveMarker -Value (Get-Date -Format 'o') -Encoding ascii } catch {}
            continue
        }
        if (-not (Test-Path $aliveMarker)) { continue }   # never confirmed alive - stale debris, not a crash

        $alert = @{ sessionId = $sid; consolePid = [int]$w.consolePid; detectedAt = (Get-Date -Format 'o') }
        try { Set-Content -Path $deadMarker -Value ($alert | ConvertTo-Json -Compress) -Encoding ascii } catch {}
        Log "GUI-DEAD $sid : hosting GUI (pid $($w.consolePid)) is gone - hosted session lost, alert written to $deadMarker"
    }
}

function Step {
    # Before the kill switch: a stopped-but-alive watcher is still alive, and
    # the difference matters when diagnosing why nothing is being typed.
    try { Set-Content -Path $HeartbeatFile -Value ("alive {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding ascii } catch {}
    if (Test-Path $StopFile) { return }                       # invariant 6
    foreach ($f in @(Get-ChildItem $ReqDir -Filter *.json -ErrorAction SilentlyContinue)) {
        $req = $null
        try { $req = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch {}
        if (-not $req) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue; continue }

        $age = ((Get-Date) - $f.LastWriteTime).TotalSeconds
        if ($age -gt $MaxAgeSec) {                            # invariant 4
            Log "STALE $($req.sessionId): ${age}s old, discarding"
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue; continue
        }

        $kind = [string]$req.kind
        if (-not $kind) { $kind = 'clear' }

        # invariant 7, per kind: a cd must not be throttled by a clear that just
        # fired, because the prompt that triggered it was blocked and is waiting
        # to be replayed. Repeat cds are bounded upstream (one per destination).
        $key = "$kind`:$($req.sessionId)"
        if ($lastFire.ContainsKey($key) -and ((Get-Date) - $lastFire[$key]).TotalSeconds -lt 60) {
            # Escalation (OI-011): a clear request RE-WRITTEN after our /clear,
            # with live context still pinned at the ceiling, means the turn is
            # not ending - a Stop hook keeps blocking it, so the typed /clear
            # never executed. Esc interrupts the turn for real; then clear
            # again. Sleep 1200ms between the two so the TUI cannot read the
            # interrupt Esc and the ClearLineFirst Esc as a double-press.
            if ($kind -ne 'clear') { continue }
            if ($f.LastWriteTime -le $lastFire[$key]) { continue }   # not fresh
            $live = -1
            if ($req.transcript -and (Test-Path $req.transcript)) { $live = Get-Context $req.transcript }
            if ($live -lt ((Get-HardK) * 1000 * 0.8)) { continue } # shrank or unknown
            $sid = [string]$req.sessionId
            if ($escalated.ContainsKey($sid) -and ((Get-Date) - $escalated[$sid]).TotalMinutes -lt 10) { continue }
            $escalated[$sid] = Get-Date
            $cpid = [int]$req.consolePid
            if (-not $cpid -or -not (Get-Process -Id $cpid -ErrorAction SilentlyContinue)) {
                Log "SKIP escalate $($req.sessionId): console pid $cpid is gone"
                Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue; continue
            }
            Log "ESCALATE $($req.sessionId): turn not ending, sending Esc + /clear"
            $r = Send-Esc $cpid
            if ($r.ok) {
                Start-Sleep -Milliseconds 1200
                if (Invoke-Clear $req) { $lastFire[$key] = Get-Date }
            } else {
                Log "WARN escalate $($req.sessionId): Esc failed -> $($r.out)"
            }
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
            continue
        }

        $did = $false
        if ($kind -eq 'cd') {
            $did = Invoke-Cd $req
        } else {
            if ($req.transcript -and (Test-Path $req.transcript)) {   # invariant 5
                $live = Get-Context $req.transcript
                if ($live -ge 0 -and $live -lt ($req.hardK * 1000 * 0.8)) {
                    Log "DROP $($req.sessionId): context already down to $live - someone cleared it"
                    Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue; continue
                }
            }
            $did = Invoke-Clear $req
        }

        if ($did) { $lastFire[$key] = Get-Date }
        Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
    }

    Invoke-Kicks
    Invoke-AutoApprove
    Watch-HostedGui
}

if ($Once) { Step; exit 0 }

Log "clearbot started (interval ${IntervalMs}ms, requests: $ReqDir)"
while ($true) {
    try { Step } catch { Log "ERROR $($_.Exception.Message)" }
    Start-Sleep -Milliseconds $IntervalMs
}
