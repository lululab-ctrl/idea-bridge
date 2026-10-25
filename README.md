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
- Nightly backups keep 14 days of complete snapshots on top of all this.

---

## Contents

1. [What it does](#what-it-does)
2. [Setting it up (about 30 minutes, no coding)](#setting-it-up)
3. [Daily use](#daily-use)
4. [Costs](#costs)
5. [Privacy, security and backups](#privacy-security-and-backups)
6. [Troubleshooting](#troubleshooting)
7. [How it works (technical)](#how-it-works)
8. [Design decisions and research](#design-decisions-and-research)

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
| **Library** | Searches every idea, transcript and task by keyword *and* by meaning ("AI business" finds "a bot that sells stuff"). Filter by status, theme, tag, priority or commitment. |
| **Evaluation** | Transparent 1–5 scores on value, feasibility, cost, complexity, strategic fit and effort, each with its reason, plus "biggest unknown" and "cheapest test". You set the weights. |
| **Projects and tasks** | Approving an idea creates a project. The AI drafts milestones and tasks with instructions, expected outcomes, owners and due dates; you choose which tasks to create. Tasks have priorities, deadlines, assignees, notes and reminders. |
| **Insights** | A weekly scan for recurring patterns, the most promising ideas, conflicts, combinations, and automatic themes. Daily and weekly digests by email and push. |
| **Ask** | Ask anything about the library ("what did he say about pricing?"). Answers cite the ideas they come from. |
| **Documents** | Business concept, implementation plan, research brief, product requirements, one-page summary or anything you describe, generated from an idea and downloadable. |
| **Teaching** | Correct any field and the correction is kept, even when the AI later updates the idea. Add his vocabulary ("'the platform' means…") and your preferences; the AI uses them every time. |
| **Your data** | One-click export of everything: audio, transcripts, readable documents for every idea, and the database. Nightly backups, optionally copied off-site. |

---

## Setting it up

You'll create four accounts, paste four keys, and press deploy. Each step has a link.

### 1. Get the AI keys (15 minutes)

| Service | What it's for | Where | Notes |
|---|---|---|---|
| **Anthropic** (Claude) | Understanding, reports, plans | https://console.anthropic.com → Settings → API keys | Add a payment method and a monthly spending limit. |
| **ElevenLabs** | Transcription (best Hebrew quality, exact timestamps) | https://elevenlabs.io/app/settings/api-keys | Pay-as-you-go. Give the key access to Speech to Text. |
| **OpenAI** | Search by meaning, plus backup transcription | https://platform.openai.com/api-keys | Add a small prepaid balance (e.g. $10). |

Keep the keys somewhere safe. They're like passwords.

> You can start with only the Anthropic and OpenAI keys. OpenAI will then transcribe, but without exact timestamps, so "listen from here" is approximate.

### 2. Put the code on GitHub (5 minutes)

1. Create a free account at https://github.com.
2. Create a new **private** repository called `idea-bridge`.
3. Upload the contents of this folder (or ask Claude to push it for you).

### 3. Deploy on Railway (10 minutes, about $5–8/month)

Railway runs the app around the clock and gives it a secure web address.

1. Sign up at https://railway.com with your GitHub account and choose the Hobby plan.
2. **New Project → Deploy from GitHub repo →** pick `idea-bridge`. Railway finds the `Dockerfile` and builds it.
3. Open the service → **Settings → Networking → Generate Domain**. Copy the address (e.g. `https://idea-bridge-production.up.railway.app`).
4. **Add a volume** (this is where everything is stored): right-click the service → **Attach volume** → mount path **`/data`**.
5. Turn on volume backups: open the volume → **Backups** → enable the daily schedule.
6. Open **Variables** and add these (see `.env.example` for all options):

   | Variable | Value |
   |---|---|
   | `PUBLIC_URL` | the address from step 3 |
   | `ANTHROPIC_API_KEY` | your Anthropic key |
   | `ELEVENLABS_API_KEY` | your ElevenLabs key |
   | `OPENAI_API_KEY` | your OpenAI key |
   | `TZ` | your time zone, e.g. `Asia/Jerusalem` |
   | `VAPID_SUBJECT` | `mailto:` followed by your email (needed for iPhone notifications) |

7. Railway redeploys. Open the address. You'll see the welcome screen.

### 4. First run (5 minutes)

Do this right after the first deploy, before sharing the address: the first person to open the app creates the accounts.

1. Enter your name, an email (optional) and your password. You become the **admin**. Then enter his name and, if you like, a password for him (he becomes the **idea contributor**).
2. On the next screen, tap **Sign-in link** next to his name (or let him sign in with his name and password). Scan the QR code with his phone and tap **Continue**. The app opens on the record button, already signed in.
3. Put it on his home screen:
   - **iPhone (Safari):** Share → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ → **Install app**.
4. Do the same on your phone (sign in with your password), then turn on notifications in **Settings**. On iPhone this only works from the home-screen app.
5. Write a few lines under **Settings → Our goals**. The AI uses them to judge strategic fit.

Optional extras (all in `.env.example`):
- **Email digests:** set `SMTP_URL` (any email provider's SMTP, e.g. Gmail with an app password, Resend or Postmark).
- **Off-site backups:** create a free Cloudflare R2 bucket and set the `BACKUP_S3_*` variables.

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

## Costs

Everything runs on pay-as-you-go services, and **Settings → System** shows the exact spend each month. Rough estimates for **30 recordings a day, about 1.5 minutes each**:

| Service | Estimate per month |
|---|---|
| Railway (hosting + 5 GB storage) | $5–8 |
| ElevenLabs transcription (~22 hours of audio) | ~$5 |
| OpenAI search embeddings | under $1 |
| Claude, with Claude Opus 5.5 (the default) | roughly $100–200 |

These are estimates. Claude is the largest cost and grows with how much he records and how many reports and documents you generate. To spend roughly half as much on Claude, set the variable `CLAUDE_MODEL=claude-sonnet-5-5`. The quality of interpretation is somewhat lower, so try it on real recordings before deciding. Set a monthly spending limit in the Anthropic console either way.

---

## Privacy, security and backups

- **Who can see it:** only the two of you. Every page and file requires sign-in, sessions are stored as secure cookies, passwords use scrypt hashing, sign-in links work once and expire after 72 hours, and repeated wrong passwords are blocked for 15 minutes.
- **AI providers:** recordings and text are sent to Anthropic, ElevenLabs and OpenAI for processing through their business APIs. Anthropic's and OpenAI's API terms say API data isn't used to train their models by default. ElevenLabs documents zero data retention only for enterprise plans, so check their current terms if your ideas are especially sensitive.
- **Backups:** the app takes a snapshot every night (kept 14 days on the volume). Railway's volume backups add a second layer. With R2 configured, snapshots and every audio file are also copied off-site.
- **Export:** Settings → System → **Download everything** gives you a zip with all audio, transcripts, ideas as readable documents, files and the database.
- **Restoring:** each nightly snapshot is a complete SQLite database (`ideabridge-YYYY-MM-DD-HH-MM.db.gz`). To restore, stop the app, unzip a snapshot to `/data/ideabridge.db` and start it again.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| "AI understanding is not set up" | `ANTHROPIC_API_KEY` is missing or wrong. Recordings wait safely and are processed automatically after you fix the key and the app restarts. |
| A recording shows "Needs attention" | Open it to see why, then press **Try again**. The audio is never lost. |
| Microphone doesn't start | On iPhone, use Safari or the home-screen app, and allow the microphone under Settings → Safari → Microphone. On Android, check site permissions in Chrome. |
| No notifications on iPhone | They only work from the home-screen app (iOS 16.4 or later). Open it from the home screen, then Settings → **Turn on for this device**. |
| Sign-in link says expired | Links work once and expire after 72 hours. Make a new one in Settings → People. |
| Something else | **Settings → System** lists failed background jobs with their error and a **Retry** button. |

---

## How it works

```
Phone (PWA) ──► Node.js server (Fastify) ──► SQLite (WAL) + audio files on /data
                     │
                     ├─ Job queue (persistent, retries with backoff)
                     │    process_recording → transcribe → extract thoughts
                     │      → for each thought: find similar ideas (keywords + meaning)
                     │      → decide: new / add to idea / possible duplicate (+ connections)
                     │      → write or update the idea card (new version)
                     │    report · score · plan · deliverable · digests · insights · backups
                     │
                     ├─ ElevenLabs Scribe (OpenAI as fallback)  — transcription
                     ├─ Claude (structured outputs)              — understanding
                     └─ OpenAI embeddings                        — meaning search
```

**Data model:** recordings (never altered) → fragments (single thoughts, each with exact quote and timestamps) → ideas (living cards, versioned on every change) → projects → tasks. Links between ideas carry a type, confidence, reason and status (suggested / confirmed / dismissed). Everything that needs a person goes into `review_items`.

**Automatic vs. asked:** a thought is attached to an existing idea automatically only when the AI is at least 85% confident it's the same concept. Between 50% and 85% it becomes a separate idea plus a "possible duplicate" for you to decide. Thresholds are in `src/server/pipeline.ts`.

**Corrections stick:** fields you edit are marked as corrected, and later AI updates keep them.

**Project layout**

```
src/server/
  index.ts        start-up
  app.ts          web server, security headers, static files
  config.ts       environment variables
  db.ts           schema and migrations
  pipeline.ts     recording → thoughts → ideas
  ideas.ts        idea versions, merges, links, review items
  search.ts       full-text + meaning search
  assistant.ts    Q&A and document generation
  periodic.ts     digests, insights, reminders, backups
  notify.ts       in-app, push and email notifications
  jobs.ts         persistent job queue
  auth.ts         sessions, passwords, sign-in links
  ai/             Claude, transcription, embeddings, prompts, schemas, test doubles
  routes/         HTTP API
public/           the app (Preact + htm, no build step), service worker, icons
test/             end-to-end and unit tests (simulated AI)
```

**Development**

```bash
npm install
AI_MODE=mock npm run dev     # simulated AI, no keys needed, http://localhost:3000
npm test                     # end-to-end + unit tests
npm run build && npm start   # production build
```

---

## Design decisions and research

Researched on 25 October 2026. Prices change, so check the providers' pages.

**Hosting: Railway.** Fly.io, Render, DigitalOcean App Platform and a plain VPS were also considered.
- Railway runs an always-on container with a persistent volume.
- It has built-in scheduled volume backups and deploys from GitHub without command-line tools.
- It costs about $5–8 a month at this size.
- Fly.io's default scale-to-zero would stop the background worker. Render needs a paid plan for disks. App Platform has no persistent volumes. A VPS needs ongoing server administration.

**Database: SQLite.** One file, no separate database server, simple to back up. SQLite FTS5 handles keyword search. Meaning search compares vectors directly, which takes milliseconds at a few thousand ideas.

**Transcription: ElevenLabs Scribe v2, with OpenAI as fallback.**
- It is the only option that does all of the following in one synchronous call: Hebrew, automatic language detection, word-level timestamps (needed for "listen from his exact words"), the formats phones record in (webm, mp4/m4a, ogg), and long recordings. It costs about $0.22 per hour of audio.
- OpenAI's current transcription models return no timestamps, and its older timestamped model `whisper-1` is scheduled to shut down in February 2027.
- Deepgram supports Hebrew only on Nova-3 without code-switching. AssemblyAI supports Hebrew only on an older model and trains on data by default. Google Chirp's Hebrew is in preview and setup is heavy.

**Embeddings: OpenAI `text-embedding-3-large` at 1024 dimensions.** It has better multilingual retrieval than the small model, it costs pennies at this volume, and it reuses the OpenAI key that is already there for backup transcription. Voyage is a good alternative, but it would mean another account.

**Understanding: Claude with structured outputs.** Each step returns a strictly validated JSON shape: thoughts, linking decision, idea card, report, evaluation, plan, insights. Each prompt separates *what he said* from *interpretation* from *suggestion*. Server-side refusal fallback is enabled, so a false-positive safety refusal doesn't stall the pipeline.

**Frontend: an installable web app (PWA) instead of native apps.** One codebase works on iPhone, Android and desktop, with no app store. Recording, offline saving, home-screen install and push notifications are all supported. Push on iPhone requires iOS 16.4+ and the home-screen app.

**Reliability choices:**
- Recordings are saved on the phone before uploading.
- Uploads can be retried safely; the server ignores duplicates.
- Background jobs survive restarts and retry with backoff.
- Recordings are processed one at a time, so two thoughts can't create the same new idea at once.
- Sign-in links require a tap, so message link previews can't use them up.
