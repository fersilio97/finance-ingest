# Finance Ingestion App

Drop bank-exported CSVs in the web UI, hit **Run Pipeline**, and get back a
clean `account_paula.xlsx` (Transactions / Global / Calculator tabs) —
replacing manual entry into a spreadsheet. SQLite is the source of truth;
`transactions.csv` and `account_paula.xlsx` are regenerated on every run.

Background/design decisions: see the plan at
`C:\Users\nano_\.claude\plans\hazy-imagining-hamming.md`.

## Run locally with Docker (recommended)

```
docker compose up --build
```

Open http://localhost:8000. Uploaded files, the SQLite DB, and the
generated exports all live under `./data`, which is mounted as a volume —
nothing is lost on container restart.

## Run locally without Docker (dev)

```
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000. Data is written to `../data` (repo root),
same as the Docker setup.

## Using it

1. **Upload** — drop each source's CSV(s) into its box (BoA Checking, BoA
   Credit Card, Fidelity Credit Card, Fidelity Savings, HSA, 401k). Files are
   staged under `data/incoming/<source>/`.
2. **Run Pipeline** — normalizes new files, dedupes against everything
   already in the DB, runs the rule engine (seeded with a starter set — see
   the plan), and regenerates `transactions.csv` + `account_paula.xlsx`
   under `data/exports/`.
3. **Needs Review** — anything no rule matched. Classify it and optionally
   save the pattern as a new rule so similar transactions auto-classify
   from then on.
4. **Manual EOM Balances** — only needed for accounts whose source files
   don't carry a running balance (BoA/Fidelity credit cards, HSA, 401k).
   BoA Checking and Fidelity Savings auto-derive their EOM balance from the
   transaction data itself.
5. **Insights** — category totals by month, balance trend, and Calculator
   mismatch flags, without opening the xlsx.

Re-dropping the same file is safe — dedup means re-running the pipeline on
it is a no-op.

## Deploying to the laptop (Linux, Docker)

1. Install Docker + the Compose plugin on the laptop.
2. Copy this repo over (`git clone` once it's pushed, see below — or `scp`/
   USB drive for a one-off).
3. From the repo root: `docker compose up -d --build`.
4. Reach it from other devices on the LAN at `http://<laptop-ip>:8000`.
5. `data/` on the host is the only thing that needs backing up/persisting
   across redeploys — it holds the DB and every export.

## Pushing to GitLab

This repo is git-initialized locally but has no remote configured (no
GitLab credentials/MCP available when it was scaffolded). Once the GitLab
project exists:

```
git remote add origin <your-gitlab-url>
git push -u origin main
```

## Notes

- `data/` is gitignored — it holds real transaction data and is never
  committed.
- `accounts.xlsx` (the old manual spreadsheet) is unrelated to
  `account_paula.xlsx` (this app's output) — no migration between them is
  planned.
- The classifier's ML stub (`backend/app/classifier/model_stub.py`) is a
  no-op today; the rule engine handles classification for now.
