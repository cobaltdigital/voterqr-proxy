# Cobalt Studio

Batch-shoot, clip, caption and schedule short-form video across TikTok, Instagram,
Facebook, LinkedIn and YouTube.

The operating idea: **one hour of shooting a week produces two weeks of posting.**
Everything here exists to protect that hour — scripts written in advance, a
teleprompter you read straight through, and a clipping pass that turns one long
recording into ten posts.

## Run it

```bash
cd studio
npm install          # also downloads a static ffmpeg binary
npm start            # http://localhost:3100
```

No environment variables are required. Add an Anthropic API key in **Settings** to
turn on script writing and caption generation; without one the app still works and
captions fall back to templates.

## Deploy to Railway

New Project → Deploy from GitHub → set **Root Directory** to `studio`. Railway
detects Node and runs `npm start`. Attach a volume mounted at `/app/data` so raw
footage and rendered clips survive redeploys, or set `STUDIO_DATA_DIR` to point at
a mounted path.

## The weekly loop

1. **Scripts** — 17 seeded scripts across six pillars, plus 25 ideas. Expand any
   idea into a full script with one tap (needs an API key).
2. **Shoot Day** — pick the batch, check the time estimate against your 60-minute
   budget, then run the teleprompter. Verticals are ordered first so the camera
   only moves once.
3. **Clips** — upload the raw file, mark in/out points in the browser, render.
   Output is 1080×1920 (or 1:1 / 16:9), H.264, with audio normalized to −14 LUFS
   so every platform stops re-leveling you.
4. **Calendar** — generate four weeks. Each rendered clip fans out across the
   platforms in its slot, matched to the slot's pillars.
5. **Publish Queue** — what's due today, with the video download and the
   per-platform caption ready to copy.

## Pillars

| Pillar | Share | Goes to |
|---|---|---|
| Digital Marketing & SEO | 30% | TikTok, IG, FB, Shorts, LinkedIn |
| Tech & AI for Small Business | 30% | TikTok, IG, FB, Shorts, LinkedIn |
| Entrepreneur Lessons | 15% | TikTok, IG, FB, Shorts, LinkedIn |
| 90s Nostalgia | 15% | TikTok, IG, FB, Shorts |
| RGV Dads | 10% | TikTok, IG, FB, Shorts |
| Professional | separate track | LinkedIn only |

Edit pillars, platform rules and the weekly posting slots in `content/seed.js`.
Scripts you create in the app live in `data/studio.json`; the seed file only
populates an empty database.

## Auto-posting status

The app prepares posts; it does not publish them yet. Publishing needs per-platform
developer approval, and the two that matter most take the longest:

| Platform | Status | Blocker |
|---|---|---|
| YouTube (Shorts + long) | ready to build | OAuth consent screen only |
| Facebook Page | ready to build | Business verification |
| Instagram Reels | ready to build | Business/Creator account + linked Page |
| TikTok | blocked | Content Posting API audit, 2–6 weeks; posts are `SELF_ONLY` until it passes |
| LinkedIn | blocked | Community Management API partner approval |

Until those land, the Publish Queue is the fast manual path — download, copy
caption, post, tap done.

## Layout

```
studio/
  server.js            Express API — scripts, shoots, uploads, ffmpeg, calendar
  lib/claude.js        Script + caption generation (falls back to templates)
  content/seed.js      Pillars, platform rules, posting slots, seeded scripts
  public/index.html    Single-page app (no build step)
  data/                Runtime state, raw footage, rendered clips — gitignored
```
