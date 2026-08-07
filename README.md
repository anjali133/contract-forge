# Multi-agent app builder

Turns a plain-English description of a data model into a working Express +
MongoDB-ready backend and a matching React frontend, using three coordinating
agents and a code-level validator.

## How it works

1. **Planner agent** turns your description into a structured API contract
   (data models + REST endpoints).
2. **Backend agent** and **frontend agent** generate code from that contract
   *in parallel* — they only depend on the contract, not on each other.
3. **Validator** (plain code, no LLM) runs three checks: it matches the
   generated frontend `fetch` calls and backend routes against the contract;
   it runs every generated file through esbuild to catch syntax errors; and
   — once the backend has no known structural problems — it boots the
   generated Express app for real against an in-memory MongoDB and drives
   every contract endpoint through it (create, list, get-one, update,
   delete), checking status codes and that data actually persists. On any
   mismatch, only the side with the problem is regenerated with the specific
   issue as feedback — up to 2 retries.
4. Generated files are written to `output/<app-name>/`. If this `appName` was
   already built before, the build is **incremental**: the new contract is
   diffed against the previous one model-by-model, and only models whose
   fields or endpoints actually changed get regenerated — everything else is
   reused from disk as-is (preferring whatever's actually in `output/`, so a
   hand-edit you made to previously-generated code survives a rebuild,
   falling back to history's saved copy only if the file's missing). A
   rebuild with no real changes costs zero agent calls.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and paste in your real OPENAI_API_KEY (and MONGODB_URI if you want history)
npm run dev
```

Then, in a second terminal, start the dashboard:

```bash
cd dashboard
npm install
npm run dev
```

Open **http://localhost:5174** — that's the primary interface now (Build tab to generate, History tab to browse past runs and re-download). A bare-bones fallback still lives at `http://localhost:4000/test.html` if you ever just want to hit the API directly without the UI.

## Try it

Type something like:

> A library system with books and members who can borrow and return books

Click **Generate contract**, then edit it right there if you want to — rename
a model, add or remove a field, tweak an endpoint's path, add a custom action
— before clicking **Build app from this contract**. This is your
human-approval checkpoint, and it's a real edit, not just approve-or-discard:
every change is re-checked live (no LLM call, just plain code) and Build
stays disabled while an edit leaves the contract broken (a dangling `ref`, a
duplicate model name, an empty field list). Generated files land in
`output/library-system/`.

Already built it once and want to add something? Use **"Add a feature to
this app"** instead of re-describing from scratch in the box above — that
box has no memory of your current contract, so a fresh description replaces
it rather than extending it. The feature box, by contrast, sends your
*existing* contract to the planner along with the new feature description,
and it comes back only changing what that feature actually needs — which is
what lets the next Build stay incremental instead of regenerating the whole
app for one new field.

## API

- `POST /api/plan` — `{ description }` → `{ contract, usage, generationId }`
- `POST /api/plan-extend` — `{ existingContract, description }` → same shape as `/plan` — plans a patch against an existing contract (add a feature) instead of starting fresh
- `POST /api/validate-contract` — `{ contract }` → `{ shapeErrors, contractWarnings }` (used by the dashboard on every edit; no LLM call)
- `POST /api/build` — `{ contract, generationId }` → `{ outputDir, fileList, validation, attempts, incremental, reusedModels, regeneratedModels, removedModels }`
- `GET /api/history` — last 20 generations (needs `MONGODB_URI` set)
- `GET /api/history/:id` — full detail of one, including the generated files
- `GET /api/download/:appName` — zips `output/<appName>` (minus `node_modules`) and streams it down

## Model relationships

A field can be `"type": "ObjectId"` with a `"ref"` naming another model in
the same contract (e.g. a Task belongs to a Project). The backend stores it
as a real Mongoose ref and `.populate()`s it on every read; the frontend
fetches the related model's list to render it as a picker on create, and
displays the populated record's name/title instead of a raw id.

Two checks back this up: `checkContractIntegrity()` catches a `ref` that's
missing or points at a model that doesn't exist, surfaced at the plan
approval step before any code is generated; the validator separately flags
a backend route that has a ref field but never calls `.populate()`, the
same "structurally fine, silently wrong" bug shape as the `_id` issue.

**Known boundary:** only one direction is supported (a record referencing
one other record, "belongs-to"). Many-to-many relationships or a parent
listing its children's ids aren't implemented — the planner has no way to
express that yet.

## What's not built yet (deliberately, to keep scope honest)

- **The static half of the validator is regex-based, not a full analyzer** —
  it catches path/method mismatches and the specific `.id` vs `._id` bug we
  hit. The runtime test suite (generated straight from the contract and run
  against a real in-memory MongoDB) does verify that CRUD actually behaves
  correctly end to end, but it still won't catch deeper business-logic bugs
  outside plain CRUD (e.g. whether "borrow" actually flips availability).
- **No live per-agent progress** — the dashboard's pipeline tracker updates
  based on the single `/plan` and `/build` responses, not real streaming, so
  Backend/Frontend show "running" together rather than independently. A
  WebSocket or SSE layer would be the next step for true live status.

## Cost

Roughly 10–15K tokens per full plan+build cycle on a mini-tier model — a few
cents at most. Check usage at platform.openai.com/usage. The runtime test
suite doesn't call the LLM at all (it's generated deterministically from the
contract), so retries triggered by a failing test don't cost extra tokens
beyond the one regeneration call.

**First build on a machine:** `mongodb-memory-server` downloads a real
`mongod` binary the first time it runs (needs network access). If that
download fails or is blocked, runtime tests are skipped for that build
(you'll see it called out in the dashboard) rather than failing the build.
