# Idea Bridge

A private app for two people: one has ideas all day and records them by voice; the other turns them into clear, organized, actionable plans.

- **He** opens the app, taps one big button and talks. Nothing to type, name or organize.
- **The AI** transcribes the recording and splits it into separate thoughts. It connects each thought to ideas he has mentioned before and writes a clear explanation of what he means. When it isn't sure, it asks instead of guessing.
- **You** go through new material in batches in a review queue. You read structured reports instead of listening to audio, ask him clarifying questions with one tap, and approve the ideas worth committing to. Approved ideas become projects with step-by-step plans.

Nothing is ever lost. Original recordings are kept, every idea keeps its full version history, "merging" never deletes anything, and deleted items go to a trash you can restore from.

## Roles

| | Admin (you) | Idea contributor (him) |
|---|---|---|
| Record ideas by voice or text | ✓ | ✓ |
| See the ideas his own recordings became, and his own recordings | ✓ | ✓ (read-only) |
| Delete his own recordings | ✓ | ✓ (they go to the trash; ideas are not affected) |
| Review queue, library, reports, evaluations, connections | ✓ | – |
| Edit, merge, approve, archive ideas; tags and themes | ✓ | – |
| Projects, plans, tasks, documents, Ask, Insights | ✓ | – |
| Settings, people, passwords, AI teaching, exports, trash | ✓ | – |

The limits are enforced by the server, not just hidden in the interface. Every request from the contributor's account is checked against a short allowlist, and he can only ever see or delete his own recordings.

## Deleting and restoring

- **Deleting a recording** (by either of you) moves it to **Trash**. The ideas, reports, projects and tasks built from it stay exactly as they are; his quoted words remain in the ideas. When he deletes one, you get an item in the review queue and can restore it with one click.
- **Deleted tasks, files, documents and notes** also go to Trash and can be restored exactly as they were.
- **Ideas are never deleted**, only archived (and can be brought back any time).
- **Removing something permanently** is possible only for the admin, from Trash, one item at a time, after typing `DELETE`.
- A nightly database backup (kept 30 days) sits on top of all this.

---

---

## Contents

1. [What it costs: nothing](#what-it-costs-nothing)
2. [What it does](#what-it-does)
3. [Setting it up (about 15 minutes, no coding)](#setting-it-up)
4. [Daily use](#daily-use)
5. [Free-plan limits and what happens when you reach them](#free-plan-limits)
6. [Privacy, security and backups](#privacy-security-and-backups)
7. [Troubleshooting](#troubleshooting)
8. [How it works (technical)](#how-it-works)
9. [Design decisions and research](#design-decisions-and-research)

---

## What it costs: nothing

Every service runs on a free plan that needs **no credit card**, so nothing can ever be charged by surprise. When a free limit is reached, the affected work waits and continues later. Nothing is lost.

| Part | Service | Why it's free |
|---|---|---|
| Understanding (Claude) | Anthropic API, paid from the **monthly API credits included in your Claude Team plan** | Team plans include API credits each month ($20 per Standard seat). No payment method is attached, so when the credits run out requests simply stop until next month. The app also has its own monthly cap (default $18), so it never uses everything. |
| Transcription | **Groq** free plan (Whisper large-v3) | Free with no card. Hebrew, English and mixed speech. |
| Database, file storage, server | **Supabase** (your existing paid subscription) | Already paid for: database, 100 GB of files, server functions and a scheduler. Nothing extra for this app. The app also works on Supabase's free plan (see the note in `.github/workflows/deploy.yml`). |
| Web app | **GitHub Pages** | Free for this repository. No card. |
| Deploys and nightly backups | **GitHub Actions** | Free for public repositories. |
| Email digests (optional) | **Resend** free plan | 3,000 emails a month. Push notifications work without it. |

Daily work uses Claude Haiku (fast and cheap); reports, evaluations, plans, insights and documents use Claude Sonnet. At a few recordings a day this is typically a few dollars of credits a month. **Settings → System** shows exactly how much has been used.

---

## What it does

| Part | What you get |
|---|---|
| **Capture** | One-tap recording on his phone (installs like an app). Works with bad signal: recordings are saved on the phone first and uploaded automatically. He can also type, or upload a voice memo. |
| **Understanding** | Transcription (Hebrew, English and mixed). Each recording is split into separate thoughts. For each thought the AI writes a plain-language summary, what he likely means, how clear it is, what's missing, and whether it's a brainstorm, an intention or a decision. |
| **Connecting** | Every new thought is compared with existing ideas by meaning, not just by words. When it's clearly the same idea, the thought is added and the idea is updated (you see it in the review queue and can undo it). When it's uncertain, the thought becomes its own idea and the AI asks you whether to merge. Related, conflicting and combinable ideas are suggested as connections. |
| **Reports** | A full report per idea covering summary, underlying vision, problem, how it might work, audience, business model, feasibility, next steps and open questions. Every point is labeled **He said** / **Interpretation** / **AI suggestion**, with a tap-to-listen link to his exact words. |
| **Review queue** | Everything that needs a decision, one item at a time, with keyboard shortcuts. Updates you only need to see can be acknowledged in one click. |
| **Questions for him** | The AI drafts clarifying questions. You send the good ones with one tap; he sees them on his record screen and answers by voice. The answer updates the idea automatically. |
| **Library** | Searches every idea, transcript and task by keyword *and* by meaning: the AI expands your search into related words in English and Hebrew, so "AI business" also finds "a bot that sells stuff". Filter by status, theme, tag, priority or commitment. |
| **Evaluation** | Transparent 1–5 scores on value, feasibility, cost, complexity, strategic fit and effort, each with its reason, plus "biggest unknown" and "cheapest test". You set the weights. |
| **Projects and tasks** | Approving an idea creates a project. The AI drafts milestones and tasks with instructions, expected outcomes, owners and due dates; you choose which tasks to create. Tasks have priorities, deadlines, assignees, notes and reminders. |
| **Insights** | A weekly scan for recurring patterns, the most promising ideas, conflicts, combinations, and automatic themes. Daily and weekly digests by email and push. |
| **Ask** | Ask anything about the library ("what did he say about pricing?"). Answers cite the ideas they come from. |
| **Documents** | Business concept, implementation plan, research brief, product requirements, one-page summary or anything you describe, generated from an idea and downloadable. |
| **Teaching** | Correct any field and the correction is kept, even when the AI later updates the idea. Add his vocabulary ("'the platform' means…") and your preferences; the AI uses them every time. |
| **Your data** | One-click export of every idea as a readable document, every transcript and a full data file. Each recording's audio can be played and downloaded. Nightly database backups. |

---

---

## Setting it up

The app lives at **https://lululab-ctrl.github.io/idea-bridge/** and talks to the Supabase project `mhfiboimwscurahprugu`. GitHub builds and deploys everything by itself on every change; it only needs one key from you.

### 1. Let GitHub deploy to Supabase (2 minutes, once)

1. Open **https://supabase.com/dashboard/account/tokens** → *Generate new token*, name it `github-deploy`, and copy it.
2. Open **https://github.com/lululab-ctrl/idea-bridge/settings/secrets/actions/new**. Name: `SUPABASE_ACCESS_TOKEN`. Secret: paste the token. *Add secret*.
3. **Actions → Deploy → Run workflow** (or wait for the next change). It tests, sets up the database, deploys the server and publishes the app, in about 3 minutes.

If the app address shows "404" after a green deploy: **Settings → Pages** → *Source: Deploy from a branch* → branch `gh-pages`, folder `/ (root)` → *Save*. It's live a minute later.

### 2. First run (5 minutes, do it right away)

1. Open **https://lululab-ctrl.github.io/idea-bridge/**. The first person to open it creates the space, so do this right after the first deploy.
2. Fill in **you** (name `Lulu`) as Admin and **Matan** as Idea contributor, each with your own password. Passwords are never stored in the code; only a secure hash is kept.
3. Add the app to your home screen: iPhone: Share → *Add to Home Screen*; Android: menu → *Install app*.
4. For Matan's phone: **Settings → People → Sign-in link for a phone** shows a QR code. He scans it, taps *Continue* and is signed in. Then he adds it to his home screen.

### 3. Add the AI keys (10 minutes, in the app)

In the app: **Settings → AI keys**. Each key is checked when you save it and is never shown again.

- **Groq** (transcription, free): sign in at **https://console.groq.com/keys**, *Create API Key*, paste it.
- **Claude** (understanding): done by the **Owner** of your Claude Team plan. On claude.ai → **Settings → Organization → Billing**, claim the monthly API credits (this links a Claude Console organization; no payment method needed). Then at **https://console.anthropic.com/settings/keys** → *Create Key*, paste it. Recommended: set a monthly spend limit under *Limits* in the Console as a second safety net.
- **Resend** (optional, email digests): only if you want emails; push notifications work without it.

Recordings made before the keys are added are kept and processed automatically once they are.

Optional: fill in **Our goals** and a few words of **his vocabulary** under Settings. The AI uses both every time.

---

## Daily use

### For him

- Open the app, tap the button, talk, tap again. That's it. Half-finished thoughts, several ideas in one go, jumping between topics: all fine.
- If a question appears, tap **Answer by voice**.
- "Your recent recordings" shows each one being understood and which ideas it became.
- **Your ideas** (top left) lists everything his recordings turned into, with their status. **Recordings** (top right) lists his recordings; he can delete any of them there. Everything else is managed by the admin.

### For you

A rhythm that works well:

1. **Once or twice a day, open Review.** Go through the queue:
   - *New idea* → **Look into it** (prepares a full report and evaluation), **Keep as idea** (stays as a brainstorm), **Later** or **Archive**. Send any useful question to him with one tap.
   - *Added to an existing idea* → **Looks right**, or **Wrong idea, separate it**.
   - *Possible duplicate* → **Same idea, merge**, **Related, keep both** or **Different ideas**.
   - *Possible connection or conflict* → confirm or dismiss.

   On a computer, each button shows its keyboard shortcut.
2. **Read reports for ideas under review.** Correct anything the AI got wrong by clicking it. Add a lesson if it's a pattern.
3. **Approve** the ideas you're committing to. Review the drafted plan and create the tasks you want.
4. **Check Today** for due tasks, answers from him and the bigger picture.
5. **Monday:** read the weekly digest and the pattern scan under **Insights**.

Brainstorms never turn into obligations by themselves. Only **Approve** creates a project and tasks.

---

---

## Free-plan limits

| Limit | What happens | What you can do |
|---|---|---|
| **Claude credits / the app's monthly budget** (default $18) | New recordings are saved and transcribed; understanding waits until the 1st of next month. A banner shows on Today. | Raise **Settings → Preferences → Monthly AI budget** if the Team plan has credits left. |
| **Groq daily transcription limit** (free plan, roughly hours of audio per day) | Recordings wait and are transcribed automatically when the limit resets. | Nothing; it catches up by itself. |
| **File storage** (set to 90 GB, within the 100 GB your Supabase plan includes) | At 90% full, the audio of the oldest processed recordings is removed (down to 75%). Transcripts, quotes, ideas and reports are always kept. | Download recordings you want to keep forever from their page. |
| **500 MB database** | Text is small; this is many years of ideas. | – |
| **Server functions run at most 150 seconds per call** | Work is split into small steps, so long recordings are fine (up to 25 MB, about 2 hours at the app's recording quality). | – |

**Settings → System** shows Claude usage, storage use, when the background worker last ran and anything waiting to retry.

---

## Privacy, security and backups

- **Your data isn't used for training.** Anthropic's API (including Team plan credits) doesn't train on your content. For Groq, read its current privacy policy and terms at groq.com before the first recording; I couldn't fully confirm how its free plan treats audio. Google's free Gemini tier was rejected for this reason (it may use content for training and human review).
- **Everything is private.** Storage buckets are private; audio and files are reached through links that expire. The database is only reachable by the server (row-level security blocks the public keys).
- **Sign-in:** passwords are hashed with scrypt; repeated wrong passwords are slowed down; sessions can be ended by changing a password. Sign-in links are single-use and expire.
- **Permissions are enforced on the server**, not only hidden in the app.
- **Backups:** every night GitHub saves every table of the database (kept 30 days; *Actions → Nightly backup → the run → Artifacts*). Audio isn't in the backup; it stays in Supabase storage. **Settings → Download everything** makes a readable copy any time.
- **Restoring a backup:** download the artifact and unzip it. With [Deno](https://deno.com) installed, from this repository's folder (this **replaces** the current data with the backup):
  ```bash
  SUPABASE_ACCESS_TOKEN=<token> SUPABASE_PROJECT_REF=mhfiboimwscurahprugu \
    deno run -A --node-modules-dir=none scripts/ops.ts restore idea-bridge-backup.json
  ```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| The app says it can't reach the server | Check that the last **Deploy** run on GitHub is green. If the *api* step says the token is missing or rejected, make a new token (step 1) and replace the secret. |
| Recordings stay "Waiting" | **Settings → System**: check "last ran". If it never runs, open the Supabase dashboard → **Integrations → Cron** and confirm the job `idea-bridge-worker` exists. Any use of the app also starts the worker, so work still moves while someone is using it. |
| "This month's budget is used up" | See [Free-plan limits](#free-plan-limits). |
| Transcription errors mention a limit | Groq's free daily limit; it continues by itself after the reset. |
| Forgot the admin password | If you're still signed in anywhere, use **Settings → People → Change your password**. Otherwise make a one-time sign-in link: in Supabase → **SQL editor**, replace `PICK-A-LONG-RANDOM-WORD` with your own random text and run the SQL below, then open `<APP_URL>/#/signin/PICK-A-LONG-RANDOM-WORD`, tap *Continue* and change your password in Settings. The link works once, for one hour. |
| Push notifications don't arrive on iPhone | They need iOS 16.4+ and the app opened from the home screen. |

One-time admin sign-in link (for a forgotten password):

```sql
INSERT INTO login_links (token_hash, user_id, expires_at)
SELECT encode(sha256('PICK-A-LONG-RANDOM-WORD'::bytea), 'hex'), id, ago_text(-3600)
FROM users WHERE role = 'organizer';
```

---

## How it works

```
Phone / computer (PWA on GitHub Pages)
   │  audio goes straight to Supabase Storage (signed upload link)
   ▼
Supabase Edge Function "api" (Deno) ──► Postgres (all data, job queue, full-text search)
   ▲                     │
   │ every minute        ├─ Groq Whisper large-v3   — transcription (with timestamps)
pg_cron + pg_net         └─ Claude Haiku / Sonnet   — understanding, structured JSON outputs
   (background worker)
```

Recording pipeline, one small step per job (each fits within the free plan's time limit):
`process_recording` (transcribe) → `analyze_recording` (split into thoughts, with search words in English and Hebrew) → `handle_fragment` for each thought (find similar ideas; decide new / add to idea / possible duplicate; connections) → `finish`. Reports, evaluations, plans, documents, digests and insights are jobs too. Jobs retry with backoff, survive restarts, and wait (without using up retries) when a monthly budget or rate limit is reached.

**Data model:** recordings (never altered) → fragments (single thoughts, each with exact quote and timestamps) → ideas (living cards, versioned on every change) → projects → tasks. Links between ideas carry a type, confidence, reason and status. Everything that needs a person goes into `review_items`.

**Automatic vs. asked:** a thought is attached to an existing idea automatically only when the AI is at least 85% confident it's the same concept. Between 50% and 85% it becomes a separate idea plus a "possible duplicate" for you to decide. Thresholds are in `supabase/functions/api/lib/pipeline.ts`.

**Search:** Postgres full-text search over ideas, transcripts and tasks, combined with "meaning" search: Claude turns the question into related words and phrases in both languages, and each thought is stored with its own search words. This replaces vector embeddings, which would need another paid service.

**Project layout**

```
supabase/
  migrations/             database schema, storage buckets, scheduler
  functions/api/
    index.ts              request handling, CORS, worker entry point
    lib/                  pipeline, ideas, search, jobs, periodic, trash, auth, storage, notify
    lib/ai/               Claude, Groq, prompts, schemas, test doubles
    lib/routes/           HTTP API
    tests/                end-to-end tests against a real Postgres (simulated AI)
public/                   the app (Preact + htm, no build step), service worker, icons
scripts/build-web.mjs     builds dist/ (the web app)
scripts/ops.ts            database changes, server settings, backup and restore
.github/workflows/        deploy and nightly backup
```

**Development** (needs Deno 2, Node 20+, and a local Postgres on port 54329, user `postgres`)

```bash
npm install
cd supabase/functions/api
deno task test            # end-to-end tests
deno task check           # type check
# run locally with simulated AI:
DATABASE_URL=postgres://postgres@localhost:54329/ideabridge AI_MODE=mock STORAGE_MODE=local \
  LOCAL_STORAGE_DIR=/tmp/ib APP_URL=http://localhost:8080 deno run -A index.ts
# in another terminal, from the repository root:
IDEA_BRIDGE_API_URL=http://localhost:8000 npm run build:web && npx serve dist -l 8080
```

---

## Design decisions and research

Researched on 25 October 2026. Free plans change, so check the providers' pages once a year.

**Goal: genuinely free, no card, maintainable.** Options were rejected when they need a payment method, are trials, sleep in a way that stops background work, or need a computer that's always on.

- **Supabase** (chosen): database, file storage, server functions and a scheduler in one service. You already pay for it; it also runs on the free plan (1 GB of files, no automatic backups, pauses after a week unused, all handled by the app and the nightly backup).
- **Keys entered in the app** rather than on GitHub, so setup needs only one token on GitHub. They're stored in the database, which only the server can read, and are never sent back to the browser or included in exports.
- **GitHub Pages** (chosen) for the web app: free for a public repository, no extra account. (Supabase can't serve web pages on its free domain.) The code is public; your data is not, it lives only in Supabase.
- Rejected for hosting: Oracle Cloud free tier (needs a card), Northflank (needs a payment method), Render / Koyeb / Fly.io / Railway / Hugging Face Spaces (sleep, no persistent disk, or not free).
- **Claude via Team plan API credits** (chosen): your team already pays for the plan, the credits need no payment method, and running out simply pauses requests. Haiku does daily work cheaply; Sonnet writes the documents that need depth.
- **Gemini** (rejected even though Matan subscribes): the free API tier may use your content for training and human review, and the subscription's API credits need a billing account.
- **Groq Whisper large-v3** (chosen) for transcription: free, no card, good Hebrew, returns timestamps for "listen to his exact words". Cerebras was a trial; GitHub Models no longer offers this.
- **No vector embeddings:** every embedding service with good Hebrew either needs a card or a separate account with limits. AI-expanded full-text search gives similar results at this size.

**Reliability choices:**
- Recordings are saved on the phone before uploading.
- Uploads can be retried safely; the server ignores duplicates.
- Background jobs survive restarts and retry with backoff.
- Recordings are processed one at a time, so two thoughts can't create the same new idea at once.
- Sign-in links require a tap, so message link previews can't use them up.
