# 015 — Publish: reach the app from another device's browser over the LAN
Status: Shipped (backend/infra only)
Iteration: 8

## Problem

`docs/FEATURES.md`'s "considered and rejected" section already states the deployment
target as "this app runs on a laptop in Docker on the LAN," but nothing had verified or
documented what that actually requires. The user's ask, verbatim: "the main goal is
defining how to publish this work, i.e the user must be able to access via their laptop
via browser if this app is running" — i.e. the app runs on one machine (a home
server/NAS/PC) and a *different* device's browser on the same network needs to reach the
full UI + API, not just `localhost` on the machine running it.

This is not a new-feature request in the usual sense — no new endpoint, no schema change,
no UI. It's "does the existing thing actually work when accessed from off-box, and if not,
what's the smallest fix," which is why this doc has no user story/spec section: there's no
UX surface to design, and the fix (if any) lives entirely in how the process is bound to
the network and documented, not in application code.

## Architecture

**No application code changes.** I read `backend/app/main.py`,
`backend/Dockerfile`, `docker-compose.yml`, and grepped `frontend/*.js` for hardcoded
hosts before assuming anything needed to change:

- `backend/app/main.py` mounts the entire `frontend/` directory as static files at `/`
  (`app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")`) on
  the *same* FastAPI app that serves `/api/*`. One process, one port, one origin — there
  is no separate frontend server, no CORS boundary, and nothing that assumes the browser
  and the server share a machine.
- `frontend/*.js` calls the API with relative paths (`/api/...`), confirmed by grep — the
  only `localhost` hit in the whole directory is a code comment in `transactions.js`
  ("sub-100ms on localhost"), not a URL. A browser loading `http://<LAN-IP>:8000/` will
  resolve `/api/...` against that same origin automatically, so no frontend change is
  needed to reach the API from a different device.
- `backend/Dockerfile`'s `CMD` already runs `uvicorn app.main:app --host 0.0.0.0 --port
  8000` — binds all interfaces inside the container. `docker-compose.yml` maps
  `8000:8000` host:container and mounts `./data:/srv/data`. **Docker was already correct**
  for LAN access; nothing here needed changing.
- The actual gap: `docs/DEV-RUNBOOK.md`'s documented dev-mode command was `uvicorn
  app.main:app --reload --port 8000`, with no `--host`. Uvicorn's default bind is
  `127.0.0.1` — loopback only. Anyone running the app the way the runbook says to run it
  (not via Docker) would have a server that answers on the host machine's own browser but
  refuses connections from any other device on the LAN. This is the one thing that was
  actually broken relative to the stated goal, and the fix is a one-flag change:
  `--host 0.0.0.0` added to the documented command in `DEV-RUNBOOK.md`, so dev mode and
  Docker now bind identically. See "Implementation notes" for the live before/after test.

**Why `0.0.0.0` and not the literal LAN IP.** Binding to the wildcard address means the
server accepts connections on every interface the machine has (LAN Ethernet/Wi-Fi,
loopback, and any Docker/WSL virtual adapters) without needing to know or hardcode the
machine's IP, which can change (DHCP lease renewal, switching from Ethernet to Wi-Fi,
moving the laptop to a different network). The IP the user browses to
(`http://<LAN-IP>:8000`) is a client-side concern — what address they type — not a
server-side bind decision.

**No data model, API contract, or migration changes.** This feature touches process
startup flags and documentation only. Nothing in `db.py`, `routes.py`, `insights.py`, or
any pipeline module changes.

**Risks / trade-offs, stated up front:**

- **No auth, no TLS.** `0.0.0.0` was already the Docker behavior, so this doesn't newly
  expose anything Docker didn't already expose — but it's worth stating plainly for a
  fintech app: anyone else on the same LAN/Wi-Fi (a roommate, a guest on the same
  network, a compromised IoT device) who knows or scans for the host's IP can reach the
  full API with zero authentication, including all mutation endpoints
  (upload/rules/pipeline trigger). This was already true for the Docker deployment before
  this feature; this feature makes dev mode consistent with that, not more or less
  exposed than the documented target already was. Out of scope to fix here — the runbook
  states the deployment target is a trusted home LAN, not the public internet, and adding
  auth is a real feature with its own design questions (who logs in, session storage,
  etc.), not a one-line flag change.
- **Windows Firewall can silently block inbound connections even when the bind is
  correct.** A correct `0.0.0.0` bind does not guarantee LAN reachability if Windows
  Firewall's inbound rules block the port/binary. On this test machine there was already
  an existing "python.exe" inbound-allow rule (likely accepted via a past Windows firewall
  prompt), so the test passed without any firewall change — but that is machine-specific,
  prior state, not something this feature created or can guarantee is present on a
  different machine. **This cannot be fully scripted/guaranteed** — Windows may prompt
  the user the first time uvicorn/python.exe binds to a non-loopback address ("Allow this
  app to communicate on public/private networks?"), and if that prompt is dismissed/denied
  the process will bind successfully but remain unreachable from other devices with no
  error in the server logs (the connection is refused/timed out at the firewall, not the
  app). Documented explicitly as a known limitation with manual remediation steps below,
  not glossed over.
- **DHCP means the LAN IP is not stable long-term.** `http://<LAN-IP>:8000` will need to
  be re-checked (`ipconfig`) if the host machine's IP lease changes; this doc doesn't set
  up a static IP or a `.local` mDNS name (both real options, both out of scope for a
  one-flag fix — flagging as a possible future improvement, not doing it silently).
- **Docker Desktop's networking on Windows differs from raw `--host 0.0.0.0` uvicorn.**
  Docker port-mapping (`8000:8000` in `docker-compose.yml`) routes host-machine traffic
  through Docker's own virtual network (Docker Desktop uses a WSL2 backend on Windows by
  default). I did not test the Docker path against a real LAN IP this session (see
  "What was NOT tested" below) — only the equivalent raw-uvicorn `0.0.0.0` bind, which
  proves the *application* has no loopback-only assumption. Whether Docker Desktop's WSL2
  networking on this specific machine forwards LAN-origin traffic identically is inferred
  from the container's own `--host 0.0.0.0` CMD and the port mapping being a standard
  Docker Desktop pattern, not independently verified end-to-end this session.

## Implementation notes

**Files changed:**

- `docs/DEV-RUNBOOK.md` — dev-run command changed from
  `uvicorn app.main:app --reload --port 8000` to
  `uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`, with a short note pointing
  to this doc and clarifying the existing "is it already up?" `127.0.0.1` check is
  unaffected (checking your own box still legitimately uses loopback).
- `docs/features/015-publish-lan-access.md` — this file.
- `docs/FEATURES.md` — row added for 015.

No changes to any file under `backend/app/` or `frontend/` — confirmed by `git status`
before writing this doc; the only backend-adjacent artifact touched by testing was a
throwaway `uvicorn.log` under `backend/`, from this session's test process, not from any
code change.

### How to access this app from another device's browser (Windows host)

1. **Find the host machine's LAN IP.** Open Command Prompt or PowerShell on the machine
   running the app and run:
   ```
   ipconfig
   ```
   Look under the adapter actually connected to your network — "Ethernet adapter
   Ethernet" or "Wireless LAN adapter Wi-Fi" — for `IPv4 Address`. Example observed on
   the test machine this session: `192.168.1.242`. Ignore adapters named
   `vEthernet (WSL)`, `VirtualBox`, or similar virtual adapters unless you specifically
   know that's the one routing your LAN traffic.

2. **Start the app bound to all interfaces**, either:
   - Docker (already correct, no flag needed): `docker compose up`
   - Dev mode: `cd backend && ./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`
     (per the updated `DEV-RUNBOOK.md` command — the `--host 0.0.0.0` is the part that
     matters; without it the server only answers `127.0.0.1`/`localhost` on the host
     machine itself).

3. **From the other device's browser**, go to:
   ```
   http://<LAN-IP>:8000
   ```
   e.g. `http://192.168.1.242:8000` — same UI, same API, one origin, exactly as it
   behaves on `localhost` on the host machine.

4. **If the connection times out or is refused from the other device** (but works fine
   via `127.0.0.1` on the host itself), the most likely cause is Windows Firewall
   blocking the inbound connection. To allow it:
   - **GUI**: Windows Security → Firewall & network protection → Advanced settings →
     Inbound Rules → New Rule... → Port → TCP → Specific local port `8000` → Allow the
     connection → apply to the profile you're on (Private, if this is a home network) →
     name it (e.g. "Finance app LAN access").
   - **Command line** (run as Administrator):
     ```
     netsh advfirewall firewall add rule name="Finance app (port 8000)" dir=in action=allow protocol=TCP localport=8000
     ```
   - Windows may also prompt "Windows Defender Firewall has blocked some features of
     this app" the first time `python.exe` (or `docker` / `com.docker.backend.exe`)
     binds to a non-loopback address — if that dialog appears, click **Allow access**
     (choosing "Private networks" is enough for a home LAN; "Public networks" is not
     needed and not recommended).
   - Confirming a rule exists: `netsh advfirewall firewall show rule name=all | findstr /i "8000"` (or search by rule/binary name in the GUI).

**Deviation from plan / thing found along the way:** the same stale-`--reload`-worker
process-tree issue documented in feature 006 recurred again during this session's own
test — a throwaway `uvicorn --host 0.0.0.0 --port 8001` process spawned a `--reload`
watcher (venv Python) whose actual serving worker ran under a *different* interpreter
(`...\Python39\python.exe`). This didn't affect the test's validity (both loopback and
LAN-IP curls hit the same live worker either way), but it's worth flagging again since
it's now the third session to independently observe it — a future session might consider
whether that Python39 interpreter should be removed from PATH to stop `--reload` from
finding it, though that's out of scope here.

## Verification evidence

All testing used a **throwaway** `uvicorn` instance on port **8001** (never the real
dev server on 8000, which was already running and was never restarted or disrupted) and
never touched `data/finance.db`.

**1. Confirmed the actual gap first — default (no `--host`) bind is loopback-only**, by
probing the already-running real dev server (port 8000, started per the *old* runbook
command) from its own LAN IP:

```
$ curl -s -o /dev/null -w "http_code=%{http_code}\n" http://127.0.0.1:8000/
http_code=200
$ curl -s -o /dev/null -w "http_code=%{http_code}\n" --max-time 5 http://192.168.1.242:8000/
http_code=000   (curl exit 7 — connection refused)
```

This confirms, live, that the old documented command is not LAN-reachable even though it
answers fine on `127.0.0.1` on the same machine.

**2. Started a throwaway instance with `--host 0.0.0.0` on port 8001** (separate port
specifically to avoid touching the real dev server) and re-tested from the same box
against its own real LAN IP (`192.168.1.242`, from `ipconfig`):

```
$ curl -s -o /dev/null -w "loopback http_code=%{http_code}\n" http://127.0.0.1:8001/
loopback http_code=200
$ curl -s -o /dev/null -w "LAN-IP http_code=%{http_code}\n" --max-time 5 http://192.168.1.242:8001/
LAN-IP http_code=200
$ curl -s -o /dev/null -w "localhost http_code=%{http_code}\n" http://localhost:8001/
localhost http_code=200
```

**3. Confirmed the API (not just the static frontend) answers over the LAN IP**, not
only `/`:

```
$ curl -s --max-time 5 http://192.168.1.242:8001/api/categories
["Salary","Housing","Eat Out","Entertainment","Health","Trips","Car","Transport","Paula",
 "Family","Technology","Culture","Clothes","Formation","Others","Taxes","Fines","Cash",
 "Transfer","Investments","Banking"]
```

**4. Checked Windows Firewall state** — an inbound-allow rule already existed for
`python.exe` on this machine (`netsh advfirewall firewall show rule name=all`, filtered
for `python`), pre-dating this session, which is why step 2/3 above worked without any
firewall change from me. Current profile: `Public Profile` policy is
`BlockInbound,AllowOutbound` with the pre-existing `python.exe` rule as the allow
exception. This is machine-specific prior state, not something this feature installed —
documented as a manual step for other machines in "Implementation notes" above, since I
have no way to verify whether a fresh Windows machine prompts, silently blocks, or
silently allows on first bind.

**5. Cleaned up.** Killed the throwaway process tree (the `--reload` watcher spawned a
separate worker under a different interpreter, same pattern as feature 006 — killed by
PID with `taskkill //F //T //PID <watcher-pid>`), confirmed port 8001 stopped responding,
and confirmed the real dev server on port 8000 was still up and untouched throughout:

```
$ curl -s -o /dev/null -w "post-kill port8001 http_code=%{http_code}\n" --max-time 3 http://127.0.0.1:8001/
post-kill port8001 http_code=000
$ curl -s -o /dev/null -w "orig-dev-server port8000 http_code=%{http_code}\n" http://127.0.0.1:8000/
orig-dev-server port8000 http_code=200
```

**What was NOT tested (be honest about this):**

- **No second physical/virtual device was used to browse in from off-box.** All
  "LAN-IP" tests above were run *from the same machine*, targeting its own LAN IP address
  rather than `127.0.0.1` — this is a real, meaningful test of the socket bind (a
  loopback-only bind refuses connections to the machine's own LAN IP too, which is
  exactly what step 1 demonstrated), but it is not identical to confirming a *different*
  device's browser, on a *different* NIC/ARP path, can complete the TCP handshake and
  render the page. I do not have a second device available in this environment to
  complete that last-mile check.
- **`docker compose up` was not run this session.** The already-running dev server
  occupies port 8000, and starting Docker on a different host port
  (e.g. `-p 8080:8000`) to test around that conflict was judged not worth doing, since
  `backend/Dockerfile`'s `--host 0.0.0.0` bind was unchanged by this feature (already
  correct before this session) and the LAN-bind mechanism it uses is the same one
  verified directly against raw uvicorn above. Docker Desktop's WSL2 network-forwarding
  behavior on this specific Windows machine is therefore **inferred from the Dockerfile
  and compose file contents, not independently re-verified end-to-end**.
- **Firewall behavior on a machine without a pre-existing `python.exe` allow rule** —
  untested; the manual remediation steps in "Implementation notes" are standard Windows
  Firewall procedure, not something exercised against a fresh/blocked state in this
  session.
