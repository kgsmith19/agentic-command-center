# 41: Security Review

**Read:** `rules/00-CORE.md`, `docs/DATA-FLOW-DIAGRAM.md`
**Skill:** `engineering:code-review` for the diff pass, optional
**Produces:** findings with a concrete exploitation path, each with a demonstrating test

You work from the **data flow diagram**, not from a generic checklist, because the boundaries in that diagram are where attacks live.

**"This could be vulnerable" is not a finding.** "An unauthenticated caller sends X to endpoint Y and reads another user's row" is.

## CONFIG

```yaml
SCOPE:        whole-repo | since-<slice>
DEPLOYED:     yes | no
HANDLES_PII:  yes | no
APPLY:        report-only | apply-safe
```

**Precondition:** the DFD exists and passes GATE-DFD. Without it, run `prompts/43-doc-refresh.md` first. A security review against an unknown data flow is theater.

## DO

### 1. Walk every trust boundary

| Boundary | Flow | Control claimed in DFD | Control found in code | Location | Verdict |
|---|---|---|---|---|---|

**A flow crossing a boundary with no control is P0. A control claimed but not found is also P0**, because documentation that lies is worse than silence.

### 2. STRIDE per boundary, concretely

**Spoofing.** Where exactly is identity verified? Can a token be replayed? Is expiry checked *before* the sensitive operation? Are signatures compared in constant time? Is the token's own `alg` field trusted? Can an internal service be impersonated from outside?

**Tampering.** Every query parameterized, or string-built? Show each. Every deserialization type-constrained? Every user-supplied file path traversal-safe? Any shell involved in command execution? Auto-escaping on in templates? Redirect targets allowlisted? **Can a client set a field it should not own (price, role, user id, quantity) by including it in a trusted payload?**

**Repudiation.** Is every security-relevant action logged with who, what, when? Can a user alter their own audit trail?

**Information disclosure.** Do errors leak stack traces, SQL, paths, hostnames? Do logs contain secrets or PII (search the actual field names from the DFD register)? **Does an object ID let one user reach another user's data? Test it against a real endpoint; do not reason about it.** IDOR is the most common real vulnerability in this class of application. Do timing differences reveal account existence? Are backups protected like the primary store?

**Denial of service.** Rate limits per identity and per IP, with numbers? Can one request cause unbounded work: unpaginated query, catastrophic regex backtracking, recursive structure, unbounded upload, zip bomb? Request size limit, query timeout, pool ceiling? Can one tenant exhaust a shared resource?

**Elevation of privilege.** Where is authorization checked: edge, handler, or data layer? **Only the data layer cannot be bypassed by a new caller.** Any path that skips it: admin endpoint, internal route, background job, webhook handler, debug flag? Is RLS **enabled**, not merely defined? Verify by querying as an unprivileged role. Can a user change their own role? What can a compromised service account reach?

### 3. Secrets

Working tree, **git history** (a rotated secret still in history is still leaked), client bundles, logs, error messages, CI config, image layers. Service keys used where an anon key would do. A documented rotation procedure, and whether it has ever been run.

🔴 **A service-role or admin key reachable from client-side code is P0 regardless of anything else.**

### 4. Dependencies

Run the ecosystem audit. **Report a vulnerability as actionable only when you can describe the path from attacker-controlled input to the vulnerable code.** Unreachable CVEs are P3, and saying so plainly saves real time. Also check: unpinned versions, unmaintained packages, install-time scripts, typosquat-adjacent names.

### 5. Data protection (`HANDLES_PII: yes` only)

Walk the DFD lifecycle table. Minimization (every PII field required by a `DR-`), encryption in transit and at rest, who can read raw data and is it logged, whether retention deletion actually runs, whether a delete request reaches backups, logs, caches, analytics, and third parties.

### 6. Deployment (`DEPLOYED: yes` only)

Debug off, defaults changed, admin not public, CORS not `*` with credentials, security headers present, TLS 1.2 floor, database not internet-reachable, backups encrypted and a restore actually tested, least-privilege IAM per service identity.

### 7. Prove it with a test

For every P0 and P1, write a failing test demonstrating it (`prompts/30-tests-red.md`). After the fix it becomes a `T-R-` regression test.

**A security finding without a demonstrating test is a hypothesis.** Findings that resist demonstration get downgraded and labeled as such.

## GATE-SECURITY

| # | Check |
|---|---|
| SC1 | Every boundary crossing has a control present in code, at a named location |
| SC2 | Every STRIDE cell answered concretely for every boundary |
| SC3 | Zero secrets in tree, history, bundles, or logs |
| SC4 | Every query parameterized |
| SC5 | Authorization enforced at the data layer |
| SC6 | RLS enabled and verified on every table with per-user data |
| SC7 | Rate limits present with stated numbers |
| SC8 | Zero unbounded operations reachable from user input |
| SC9 | Zero known-vulnerable dependencies with a reachable path |
| SC10 | Every P0 and P1 has a demonstrating test |
| SC11 | Every PII item has a verified deletion path |
| SC12 | Error responses leak nothing internal |

## OUTPUT

Run report, plus: findings (severity, STRIDE category, boundary, location, **concrete exploitation path**, demonstrating test, fix, effort); the boundary control matrix; the STRIDE coverage grid; secrets table; dependency table; **a "verified safe" section** listing what was checked and found genuinely fine, so the same ground is not re-covered next review; and proposed new `NFR-` rows.

## HALT

Core halts, plus: a P0 exists in deployed code (stop the review, report immediately, do not batch it); a live secret is in git history; a fix requires a breaking interface change; the DFD has diverged enough that boundaries are unknown; PII is handled in a way no `DR-` describes.
