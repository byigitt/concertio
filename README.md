# concertio

Match Last.fm taste against upcoming concerts in area. First target SF Bay Area, architecture open
to whole US. Design and research notes in `docs/` (gitignored, local).

- Event data: **Ticketmaster Discovery** (primary). Songkick out of scope, ToS — `docs/07` K-2.
- Taste data: **Last.fm** (primary, no OAuth). Spotify optional — `docs/07` K-1.
- Artist identity: **MusicBrainz** MBID + `url-rels` bridge — `docs/07` K-3.
- Crawl direction: **artist-first**, not metro scan — `docs/07` K-4.
- No notification, no email — `docs/07` K-8.
- Interface: **strict Web Brutalism** — browser defaults are design, CSS 690 bytes (below).

## Setup

```bash
pnpm install
cp .env.example .env.local        # then fill
createdb concertio                # or use Neon connection string
pnpm db:migrate
```

Fill in `.env.local`:

| Variable | Where from | Required |
|---|---|---|
| `DATABASE_URL` | local Postgres or Vercel Marketplace > Neon | yes |
| `LASTFM_API_KEY` | https://www.last.fm/api/account/create (free) | yes |
| `TICKETMASTER_API_KEY` | https://developer.ticketmaster.com (free, 5000 req/day) | yes |
| `MUSICBRAINZ_USER_AGENT` | `concertio/0.1 ( you@example.com )` — MusicBrainz demands meaningful UA | yes |
| `CONCERTIO_LASTFM_USER` | your own Last.fm username | for Phase 0 |
| `CRON_SECRET` | verify cron calls on Vercel | on deploy |
| `CONCERTIO_EDIT_SECRET` | `openssl rand -hex 24` — unlocks home location feature (≥16 chars) | for location |

## Commands

```bash
pnpm smoke          # NO API key — verifies ingest/dedup/matching/query chain with fixture
pnpm test:pipeline  # NO API key, NO network — paging cap + cancel gate tests
pnpm test:reach     # NO API key, NO network — distance + reach tier tests
pnpm test:strings   # NO API key, NO network — emitted UI strings english?
pnpm check:lastfm   # live Last.fm check: signal count + MBID fill rate
pnpm check:geocode  # live Nominatim check: address -> coordinates
pnpm faz0           # one user + one metro, end to end real data (needs both API keys)
pnpm dev            # http://localhost:3000
pnpm typecheck
pnpm build
```

`pnpm faz0` flags: `--user=<lastfm>`, `--metro=<slug>`, `--dry-run` (skips event fetch, no
Ticketmaster key needed). Tuning vars: `CONCERTIO_TOP_ARTISTS` (default 60),
`CONCERTIO_WINDOW_DAYS` (180), `CONCERTIO_METRO_RADIUS_KM` (80),
`CONCERTIO_METRO_TZ` (`America/Los_Angeles` — dates print in venue local time).

First real run (2026-08-09, user `yeterli`, SF Bay Area): 865 Last.fm signals → 490 artists scored
→ top 60 resolved via MusicBrainz (58 linked, 2 transient timeouts) → Ticketmaster attraction id
found for 47 artists → **13 matches**. MBID fill rate on Last.fm side 72%; remaining 28% need
MusicBrainz search, and 1 req/sec limit sets run duration (first run ~145 sec, later runs ~60 sec
because artists already in DB).

### Home location and reach filter

Enter home address on `/me`, then every match gets labelled by distance from home and can be
filtered. Tiers defined one place, `src/lib/reach.ts`:

| Tier | Rule | Note |
|---|---|---|
| walking | ≤ 2 km | ~25 min walk |
| transit | ≤ 15 km | city bus/metro |
| same city | city name match **or** ≤ 15 km | admin boundary, ignores distance |
| day trip | ≤ 150 km | calibrated so SF → Sacramento (120 km, train ~2 hr) fits |
| same country | country code match | different city, same country |
| anywhere | no filter | — |

**Distance is straight line (great-circle), not road or transit route.** Real route needs GTFS/OTP,
so labels are guess not claim, and distance shows on every row too. Picking `same country` or
`anywhere` drops metro filter — else "different city" filter would sit trapped in one metro and
mean nothing. Address lookup via OSM Nominatim (1 req/sec, `User-Agent` mandatory); result written
to `app_user`, so one request per user.

**Access control — temporary.** No auth yet, and `?u=<lastfm>` proves no identity. Home address is
sensitive, so location feature demands `CONCERTIO_EDIT_SECRET` for both read and write; secret
unset = feature fully off (fail closed). sha256 of verified secret sits in httpOnly cookie.
Whitelisting username would not do: username public, secret not. Phase 1 brings Auth.js, then
`src/lib/edit-access.ts` dies and ownership comes from session.

### Incomplete set and window rules (for destructive work)

`markStaleCancelled` assumes "event missing this run = cancelled", so it runs under three guards:

**1. Set must be complete.** `EventSource.fetchEvents()` returns `EventFetchResult { events,
complete, totalAvailable }`. `complete=false` in two cases: Ticketmaster `size*page < 1000` paging
cap hit, or a record on page cannot convert to `RawEvent` (e.g. event with no date). Set
incomplete = cancel sweep **never runs** (`cancelled: null`) — else unfetched records look
"missing, so cancelled" and real events get marked cancelled.

**2. Sweep covers only fetched window.** `windowEnd` param mandatory on `markStaleCancelled`, and
`refreshMetro` hands it 90 days (3 × 30). `pnpm faz0` ingests 180 days by default, so events on day
91-180 sit in a range cron never queries; without window bound, first complete cron would cancel
them wholesale.

**3. One miss not enough.** `ingest_watermark.cursor.lastCompleteRunAt` holds previous **complete**
run time; cancel threshold is that time, not this run. Event cancels only when absent in two
consecutive complete snapshots. First complete run cancels nothing (`cancelled: null`), incomplete
run does not advance threshold. Also `unchanged` branch refreshes `fetched_at` (else never-changing
event would get cancelled), and a cancelled event returning with same payload flips back to
`confirmed` (`statusRestored`) — else it stays `cancelled` forever.

All three guards under `pnpm test:pipeline`: 33 checks, no network, no API key.

## Routes

| Route | Job |
|---|---|
| `/` | pitch + active areas |
| `/me?u=<lastfm>&metro=<slug>&reach=<tier>` | personal match list + reach filter |
| `/metro/[slug]` | upcoming concerts in area |
| `/api/health` | schema readiness check; post-deploy verification point |
| `/api/cron/ingest-events` | `vercel.json`: every 6 hours, 30-day chunks |
| `/api/cron/refresh-taste` | `vercel.json`: daily |

## Interface: strict Web Brutalism

Browser defaults are the design. Consequences:

- **No reset.** Tailwind removed; Preflight did exactly what directive forbids — soften UA
  defaults. `src/app/globals.css` ~70 lines, does two jobs only: readability (measure, density,
  focus) and table rules. Prod CSS **690 bytes**.
- **Material from browser.** Times/serif body, monospace for numbers and machine text,
  `rgb(0,0,238)` underlined links, UA heading sizes, UA form controls. 2px inset border on
  input/button kept on purpose: pulling it to 1px would mean *styling* the control.
- **Structure exposed.** `header` → `nav` → `main` → `footer` in source order, split by `hr`. Match
  and calendar lists are real tabular data, so `<table>`: `<caption>`, `<thead>`, `scope="col"`,
  every date a `<time datetime>`. Forms use `fieldset`/`legend` + `label[for]` +
  `aria-describedby`.
- **No decoration.** No shadow, gradient, rounded corner, border thicker than 1px — audited through
  computed styles in browser. To avoid drifting into Neobrutalism, also no saturated colour blocks,
  no thick "designed" borders, no offset shadows: nothing styled *to look* raw.
- **Accessibility kept.** One `h1` per page, first `Tab` lands on skip link and it becomes visible,
  focus gets `2px solid` outline (UA outline not removed, strengthened), 16px base text, links stay
  underlined.
- **Language and case.** All UI text english, fully lowercase. Source strings written lowercase;
  data-derived text (artist/venue names, date, weekday) lowercased by `text-transform: lowercase`
  on `body`. That is **presentation** only: DOM keeps original case, so copy-paste and screen reader
  stay intact (`textContent` `Ken Carson`, render `ken carson`). One exception, `code`/`kbd`/`samp`:
  names like `CONCERTIO_EDIT_SECRET` are case **sensitive**, showing them lowercase would push user
  to type something that will not work. `lang="en"`, dates `en-US`.
- **UX additions.** Filter labels carry counts ("walking (2)") — one SQL query, visible before you
  click an empty filter. Empty states say what to do and link to widen the filter. `role="status"`
  messages echo the resolved address back. On mobile page never overflows sideways, table scrolls
  inside itself.

## Layout

```
migrations/0001_init.sql    exact copy of docs/05 §1 DDL — update both together
migrations/0002_home_location.sql  home location columns + distance_m() + venue.country
src/lib/types.ts           shared contract (EventSource, TasteSource, RawEvent, ...)
src/lib/db/client.ts       pool/sql/sqlOne/tx — DB access only from here
src/lib/http.ts            fetchJson: rate limit from source_config, throttle, cooldown
src/lib/source-config.ts   rate limits not baked into code, read from table
src/lib/sources/           lastfm, ticketmaster, musicbrainz adapters
src/lib/matching.ts        5-tier artist identity resolution + review queue
src/lib/scoring.ts         taste scoring (log scale, recency decay, popularity penalty)
src/lib/ingest.ts          venue resolution, dedup_key, idempotent upsert
src/lib/pipeline.ts        refreshMetro: 30-day chunks + cancel gate on incomplete set
src/lib/reach.ts           reach tiers: thresholds, SQL fragments, classification
src/lib/geocode.ts         OSM Nominatim: address -> coordinates
src/lib/edit-access.ts     TEMPORARY: secret + httpOnly cookie for location feature
src/lib/queries.ts         read queries for pages (reach filter included)
scripts/                   migrate, faz0, smoke, test-pagination, test-reach, check-*
```

## Deploy (Vercel)

**Vercel build does NOT run migrations.** On purpose: build can run parallel and repeated, and
build environment reaching DB is no guarantee. So schema check sits as a gate **in front of** the
deploy command.

```bash
vercel link

# 1. Add Neon from Vercel Marketplace (DATABASE_URL arrives automatically), then rest of env
vercel env add LASTFM_API_KEY TICKETMASTER_API_KEY MUSICBRAINZ_USER_AGENT CRON_SECRET CONCERTIO_EDIT_SECRET
vercel env pull .env.production.local --environment=production

# 2. Gate + deploy: gate falls, deploy NEVER runs
pnpm deploy:prod
```

`pnpm deploy:prod` = `pnpm deploy:gate && vercel deploy --prod`. Gate (`scripts/predeploy.ts`)
applies migrations, then verifies schema: required 13 tables, `norm_name` + `distance_m`, 7
`home_*` columns on `app_user`, and that functions **return right answers**
(`distance_m` on known distance, `norm_name('The Sigur Rós') = 'sigur ros'`). Anything missing gets
listed by name and `exit 1`; `&&` chain breaks, so `vercel deploy` never runs. To stop you pointing
at local instead of prod by accident, `localhost` connection gets refused without `--allow-local`.

`GET /api/health` does not replace that, it **complements** it: gate prevents deploy, health
endpoint diagnoses an install already live (`200 {"ready":true}` or `503` + `missingTables`). On a
deploy with migrations skipped, `/me` throws opaque 500 while health endpoint names what is
missing.

Migrations run idempotent from zero (verified on empty DB: 14 tables, `norm_name` + `distance_m`,
8 `home_*` columns, seed metro). `pnpm db:reset` works only on `localhost` connection — dropping
prod schema is impossible.

Hobby plan closed to commercial use; going commercial needs Pro (`docs/09-free-tier.md` §D).

## Attribution

Every page showing Ticketmaster data carries "Event data by Ticketmaster" and ticket links go
straight to Ticketmaster. Taste signal credits Last.fm, identity resolution credits MusicBrainz.
Detail: `docs/06-legal-and-tos.md`.
