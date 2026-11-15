# Interface apps

Status: built 5 November 2026 (§7), not deployed.

Jonas, 5 November 2026: "We need to use the interfaces for more custom tests/artifacts the agent wants you to see.
The interfaces is where you see the company, not just talk to its workers. Where Claude has artifacts that sit in the
chat and pop out in a sidepanel, we should let the agent build interface apps into the company file that are posted as
an interface. That's where they share everything with you."

This overrides the 17 October scope reset (RUNTIME-INTERFACES.md banner, §1 and §7) **for agent-built apps only**.
The platform pages (Mailbox, Members, Bank) stay as they are: TOML under `QorperaOS/interfaces/`, drawn from the
blocks the web ships, never agent-made. An app is a different thing: the agent's own HTML, run in the locked frame the
Company File preview already uses (`packages/web/src/ui/page-frame.ts`).

## 1. What an app is

A small web page an agent makes so that members can see and handle one thing of the company. It lives in the Company
File as ordinary files. A member opens it as a page of its own, `#/c/<profileId>/a/<name>`, from a card
in the agent's message or from the apps drawer once it is posted (Jonas, 8 November 2026: an app is a whole product
prototype, so it gets the page, not a side panel).

Jonas, 13 November 2026, on a new company whose seven apps were each an employee's document made short: "They are
HORRIBLE. the goal is to let you interact with the company more directly through them, but they are just long text
documents... there is currently no real difference between the interfaces and just reading the company's files
directly." And the split he means: "Agents: carry the intelligence to work on the company and drive it fourth.
Company folder/files: carry all the information about the company. Interfaces: shows you the company and it's state so
it becomes tangible and something you can understand. [...] they are supposed to be objects, models, apps and videos
that are visual-first to let you see the company." So an app is one of four forms, and never a page to read:

| Form | What a member does with it | Made with |
| --- | --- | --- |
| an object | turns it and looks at its parts | the `object` kit (§3b) |
| a model | changes it and sees what follows | the `model`, `board` and `path` kits (§3b) |
| an app | uses it: the product itself, or a working tool | a page written by hand (§2) |
| a video | watches an explanation that moves and speaks | the `explainer` kit (§3a) |

An app is made for a thing (the product, its business model, its market, its customers, its look), one app a thing,
not for an area and not for an agent. The state of an agent's work is not an app: members read it in the agent's
thread and in its questions (until 14 November 2026 also on its wall, which the web no longer shows).

## 2. Format

```
apps/
  <name>/            named like an agent's folder: a–z, 0–9 and hyphens, at most 64 characters
    app.toml         the manifest
    index.html       the entry (or what `entry` names)
    style.css        any other files the entry uses, in this folder or folders below it
    app.js
    data.json
    logo.png
```

Apps live in `apps/` at the top of the Company File, not in `QorperaOS/interfaces/`. That folder's placement rules and
its no-agent-writes rule are the folder core's (SQL), and apps are the agents' own work: they go where agents already
write, with the tools they already have, and need no migration.

`app.toml` (parsed by `@qorpera/cloud-client/interface-apps`, at most 4 KiB):

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | text, 1–60 chars | required | the title on the card, the panel and the drawer |
| `about` | text, ≤ 200 chars | none | one plain line under the title |
| `emblem` | one of the 24 interface emblems | `page` | the drawer icon; a member may pick another, or one of the app's own icons, for their own drawer |
| `colour` | one of the agent colours | none | the emblem's colour |
| `entry` | relative path to an `.html` file | `index.html` | the page that opens |
| `owner` | agent handle | the creating agent | who made it; the app's header names it |
| `posted` | true or false | false | shown in every member's apps drawer |
| `reads` | list of `files`, `tables`, `todos`, `agents`, `questions` | `[]` | the live sources the app may read (§5) |
| `writes` | list of `answers` and `table:<name>`, at most 16 | `[]` | what the app may ask a member to change (§5 "Changes"); `<name>` is a company table's folder name, never `areas` |
| `concept` | true or false | false | a concept of the company's product: it opens in the Concepts viewer (`#/c/<id>/concepts/<name>`, full screen, a side panel to pick a concept), and the drawer shows one Concepts entry for all of them, posted or not |
| `cover` | relative path to a `.png`, `.jpg` or `.webp` in the app's folder | none | the picture of a concept in the viewer's side panel; without one, its emblem |
| `kit` | `explainer` | none | the kit the app is made from (§3a): `save_app` writes the kit's own files, the agent the rest. A kit's page is `index.html`, so `entry` beside it is a problem |

Unknown keys, bad types and bad values are problems; an app whose manifest has problems is not shown (its card says
so and links the file).

**Files.** Kinds: `.html .htm .css .js .mjs .json .txt .md .csv .svg .png .jpg .jpeg .gif .webp`. Each file at most
512 KiB (the write tools' bound), at most 64 files, at most 4 MiB in all. Other kinds may sit in the folder (an agent's
notes) but are never loaded into the page.
**Videos** (Jonas, 7 November 2026: demo videos of design ideas): `.mp4 .webm`, each at most 12 MiB and 48 MiB in all, on
top of the limits above. An agent writes them from a machine or moves them in; no text tool writes one.
**Icons** (Jonas, 12 November 2026: "change the icons of the interfaces and have a generate icon button too for them to
create a new custom one based on it's name or contents"): an app's own icons are `icons/<id>.svg` in its folder, an id
of lowercase letters, digits and hyphens (`compass`, `trail-sign`), at most 12 an app. Each is drawn as the built-in
emblems are, one shape on a 48 by 48 grid, black where the app's colour goes and white where it is cut out, in the
fixed SVG subset that `parseAppIcon` (`@qorpera/cloud-client/app-icons`) reads: only `path`, `circle`, `rect`,
`ellipse`, `line`, `polyline` and `polygon`, fill and stroke black, white or none, no transform, style, text or group,
at most 8 KiB. The web and `save_app` read a file alike, so what the web could not draw is never saved. A member picks
one, or another emblem, under Icon and colour in the app's menu in the drawer; Generate icon there asks the app's maker
(its `owner`, else the Co-Founder) in the chat to draw 3 more.

**How a page is put together.** The frame has no origin and no network, so the host (the web app, with the member's
own read authority) reads the entry and the files it names and hands the frame one self-contained page:
- `<link rel="stylesheet" href="x.css">` becomes `<style>` with the file's text;
- `<script src="x.js">` becomes an inline `<script>` (its `type` kept);
- `src` of `img`, `source`, `audio`, `video` and `url(...)` in styles become `data:` URLs;
- only relative paths inside the app's folder are resolved; anything else (`https:`, `/abs`, `..` out of the folder)
  is left as written, and the frame's policy blocks it.
Module scripts may not `import` other files in v1 (inline them or use classic scripts). The page then goes through
`framePage` exactly as a Company File page does.

**The base style** (10 November 2026; `packages/web/src/app/interface-app-style.ts`). The host gives every app's page
one small stylesheet to start from. Before it, the host gave a page no style at all, so each agent made up a look: six
of the seven apps in the reviewed company were the same generic green report. With it, an app that says nothing about
its look already reads well at 1280 and at 390 px, and a company's apps look like one company.

- **Injected, not only offered as variables.** When the host puts the page together it puts the stylesheet first in
  the page's `<head>`. Offering only variables was the other choice: variables style nothing, so a page with no CSS of
  its own would stay the browser's bare default. The frame document does not inject it: it is one fixed file that also
  shows Company File pages, which stay exactly as written, and it knows neither the company's colours nor the app's
  scheme. The host knows both, and already rewrites the page.
- **In a cascade layer.** All of it sits in `@layer qorpera-base`. A page's own styles are in no layer, so any rule a
  page writes wins over it, whatever its selector and wherever it stands. An agent overrides a default by setting the
  property; nothing has to be undone.
- **What it sets:** the system font, the text and page colours, the page's margin, heading sizes, links, tables (ruled
  rows, padded cells, the full width), code, pictures no wider than the page, and a focus ring. The body's margin alone
  holds the text to a centred column at most 800 px wide (16 px at the sides on a phone), so a page that sets its own
  `body { margin }` takes the whole width back with that one rule. It uses no `!important`, loads nothing, and leaves
  what a page says in its markup (`<table width>`, `<th align>`) alone.
- **Its variables:** `--q-bg` (the page), `--q-text`, `--q-muted` (quiet text), `--q-line` (rules and borders),
  `--q-surface` (cards and panels), `--q-accent` (the company's colour), `--q-on-accent` (text on it),
  `--q-accent-soft`, `--q-good`, `--q-warn`, `--q-bad`, `--q-font`, `--q-mono`, `--q-radius`.
- **The company's colours** come from `QorperaOS/brand/brand.toml`, beside the logo. A page cannot read `QorperaOS/`
  itself (§5), so the host reads the file with the member's own read, when the app opens and on Reload:

  ```toml
  accent = "#1f6f5b"        # links, marks, key figures
  background = "#f5f6ef"    # the page
  text = "#1d2b24"

  [dark]                    # the same three, for a dark page
  background = "#141a17"
  text = "#e8efe9"
  ```

  Only `#rgb` and `#rrggbb` are taken, so nothing but a colour reaches the stylesheet; other keys are left alone, and a
  file that is not TOML gives no colours. Background and text count together, and only when the text reads on the
  background (4.5 to 1). The accent counts only when it shows on the background (3 to 1): in a dark page the dark one
  first, then the light one. Whatever is left out is Qorpera's own (the web app's page, text and link colours), and
  without the file all of it is. No tool checks the file when it is written.
- **Light and dark.** A page is shown in the app's own scheme only when it says it supports both, the web's own way:
  `<meta name="color-scheme" content="light dark">`. A page that does not say is shown light, as a browser shows such
  a page. Following the scheme by default was the other choice; an app with colours of its own that assumed a light
  page would then get light text on its own light cards. A page that follows the scheme is put together again, and
  shown afresh, when the member's theme changes.
- **Not for a concept** (`concept = true`), whose design is the product's own, and not for a Company File page.

## 3. Agent tools

| Tool | What it does | Review class |
| --- | --- | --- |
| `save_app` | creates an app (its folder, `app.toml`, files) or changes its manifest and files, in one call | `internal`: applies at once |
| `post_app` | sets `posted` (shows it in every member's drawer, or takes it away) | `internal` for its own app (Jonas, 7 November 2026); `delegation` for another agent's or a member's |
| `make_picture` | makes one picture and saves it as a PNG, such as an app's picture before the save_app that shows it (§3c) | `internal`; `delegation` into another agent's or a member's app |
| `app_guide` | answers how one part of an app is made: the look every app is held to, a kit's file, a hand-written page's base style, live data and changes, an app's icons (§3d) | `read` |

- `save_app {name, operationKey, manifest?, files[{path, text}], remove?}` checks the name, the manifest, each file's
  kind and size and the totals before anything is written. On create it sets `owner` to the agent and `posted = false`;
  later it never changes `posted` or `owner`. A changed file that another call changed meanwhile is a conflict.
  When the call wrote the entry page, its answer carries `look`: what a quick read of that page found (links that
  open nothing, §4, the first three named; three or more `<details>`; more than 500 words; more than 150 words with
  no picture, chart, map or diagram). It is advice, never a refusal: the agent fixes it unless it does not fit the
  page. The tool's description also says what makes a page worth opening: what the first screen answers, what to show
  instead of write, which links open, the base style and phone width. How a page reads live data (§5), how it lets a
  member act (§5 "Changes") and the base style's variables and the company's colours (§2) are guides of `app_guide`
  (§3d: `reads`, `writes`, `style`), because a tool's own description holds 4096 bytes and its schema, as the model
  receives it, under 5,000. `writes` is checked as `reads` is, by `save_app` and by `company_write` / `company_edit` of an
  `app.toml`; a manifest given without it keeps what the app has. `kit` makes the app from a kit (§3a).
  A file under `icons/` must be `icons/<id>.svg` and read as an icon (§2 "Icons"), or the call is refused naming the
  file and what to change; a save that adds icons past 12 is refused (`APP_ICONS_FULL`, naming the oldest: a new icon
  takes an old one's id, or `company_delete` removes one first). How to draw them, and that an ask for icons is one
  call of files alone that never changes `manifest.emblem`, is the guide `icons` (§3d); a save of icons alone answers where the
  member picks one. The emblems are listed on `manifest.emblem` only: 24 names would put the description past 4096
  bytes.
- `post_app {name, operationKey, posted}` rewrites `posted` in `app.toml`, every other byte as written.
- `company_write` / `company_edit` of an `apps/<name>/app.toml` check the manifest the same way and refuse a change of
  `posted` (pointing to `post_app`) or of `owner`. An app's files are its owner's: another agent changes them with
  `save_app`, reviewed as delegation (review r2, H-1). `company_move` brings no folder or manifest into `apps/`. `company_delete` / `company_move` of a posted app's folder is a deletion and is
  reviewed as one already is.
- **Known gap, accepted for v1:** a write from a machine's mounted folder (a shell, a coding session) is not checked
  here, so a machine could flip `posted` without the review. Closing it is a folder-core rule (park a view's change of
  `posted` as a proposal, P40a); it needs a migration and is a follow-up.

Prompt guidance (the agent's company context): when you have something to show (results, a test, a prototype, a
plan with numbers), make it an app and link it as `[Title](app:<name>)` instead of pasting long text. Keep apps small,
plain and readable by someone who is not an expert. Post an app when every member should keep seeing it.

Since 10 November 2026 (Jonas: "agents lets you interact with your employees — interfaces let's you interact with
your company directly") the guidance also says what an app is for. In conversations members talk with the agents; in
apps they look at the company itself, as it stands now. So an app is not a report of what was done and not a short
version of a document. Each agent that owns an area keeps one posted app that shows the state of that area, and
changes it in the run that changes the state (hire overlay v13). The Co-Founder checks those apps in its planning
runs and keeps one for the company as a whole (`company`), drawn from the team's todos and agents. Before an agent
links or posts an app it looks at it: the entry opened in a browser on a machine at 1280 and at 390 px wide, a
screenshot of each read back with `company_read`, the weakest thing fixed, and again.

**Patch notes before changes go live** (Jonas, 10 November 2026: "I would also like some version of an update
list/patch notes for changes before they go live, if agents have worked on several changes it could just post all of
them as a patchnote rundown with visuals and very brief and easy to digest text - or a video"; asked whether changes
should wait for his yes on that page: "Yes, wait for me"). Since own code storage step 4 (migration
`20260930729000_code_releases.sql`), What's new is Qorpera's own page in the apps drawer (drawer key `whats-new`, the
bare word; `app:whats-new` is an agent's app, which the drawer hides while the page shows), and agents no longer keep
an app of that name. The company context tells every agent:
- A change goes live when people outside the team meet it: an update to a published site, a new version of the
  product, a new price, a mail or post that goes out to many. Until then it is ready.
- A website made from a repository kept in Qorpera goes live only through Qorpera: each change whose checks pass shows
  on What's new with its notice and picture, and a member puts it live there. The agent never publishes it
  (`publish_site` refuses a source under `code/` before any card) and never asks about it in a question card; it tells
  the member in one line that the change waits in What's new.
- Anything else that goes live gets one question card that shows what changes, options "Put it live" and "Not yet":
  on yes it goes live in that run; on not yet the agent asks what to change.
- One exception: a fix for something broken for customers right now goes live at once, and the members hear the same
  day what changed. A repository's website still waits for a member, who can press Go back in What's new.
For a repository's website the platform holds the rule: only an owner's or admin's press on What's new changes the
live version. For anything else it is a rule of the agents' instructions: `publish_site` of a plain folder on a live
site is still reviewed as any outside effect (cloud-action-review.ts).

## 3a. The explainer kit (10 November 2026)

Jonas, 10 November 2026: "I think in general I would like to see if there are some interfaces that pressent better
through a 3B1B style video, explaining concepts and ideas clearly but without needing to pin down an exact UI or
design yet"; and, asked whether agents should get that format: "yes, I do. they need to be created with a voice over
too though, they can't be mute". A trial the same day (one app as a two-minute video) gave the rule of thumb: good
for a mechanism or a decision with numbers, bad for the state of an area.

An explainer is an ordinary app (`kit = "explainer"`): the same folder, the same frame, the same limits, no call the
web does not already answer. What the kit adds is that the agent writes one file.

| File | Whose | What it is |
| --- | --- | --- |
| `scenes.js` | the agent's | the video: chapters (`V.part`), scenes (`V.scene`), and in each scene the captions (`s.say`) with what moves under them |
| `engine.js` | Qorpera's | the animation engine and its player (play and pause, a scrub bar, chapters, captions, the voice). Its source is `packages/runtime/kits/explainer/engine.js`; the runtime holds its text (`cloud-app-kit-explainer-engine.generated.ts`, written by `npm run generate:app-kits`, held to the source by a test) |
| `index.html` | Qorpera's | the page: it makes the video `V`, runs `scenes.js`, starts the video, and names the voice clips |
| `voice/<hash>.mp4` or `.webm`, `voice/clips.json` | written from a machine | the voice: one clip a caption, and the list of them |

- **`save_app` writes the two that are Qorpera's.** With `manifest.kit = "explainer"` a new app needs only
  `scenes.js` among its files (`APP_SCENES_MISSING` without it); the engine and the page go into the same change. A
  call that names `engine.js` or `index.html` of such an app is refused (`APP_KIT_FILE`), and so is a page of its own
  (`APP_KIT_ENTRY`). On a later save they are written again only where the folder holds none or other text (by
  hash): a new title, new clips, or the engine of a newer runtime. A save of `scenes.js` alone changes that one file.
  An existing app takes the kit the same way, keeping its owner and `posted`.
- **Each explainer carries its engine.** The engine is copied into the app, not put in by the web when the page
  opens. So an explainer plays the same in a year as on the day it was checked, and the agent can open it on a
  machine (`/company/apps/<name>/index.html`) to look at it, as it looks at any app. The cost is that an engine fix
  reaches an explainer only when it is saved again.
- **The page makes and starts the video**, so a `scenes.js` holds only parts and scenes. One that makes and starts
  its own still plays: the engine starts once. Everything of the engine is inside one function; a `scenes.js` gets
  `Video`, `C` (the colours) and `captionHash`, and may name its own things as it likes. With no scene, or with a
  mistake in `scenes.js`, the page says so in words where the video would be (the line too), which is what the agent
  sees when it looks.
- **Captions are the narration.** Each `s.say` is one caption, shown under the stage. Silent, a caption lasts its
  words at three a second and half a second more, or as long as what moves under it. Every frame is computed from
  the time alone, so the video pauses, scrubs and jumps anywhere (`index.html?t=95` opens it paused at 1:35, for a
  look on a machine; the frame has no query).
- **The voice.** A caption has a clip when the page holds
  `<audio data-caption="HASH" data-seconds="5.42" preload="none"><source src="voice/HASH.mp4"></audio>`, where
  `HASH` is FNV-1a 32-bit over the caption's UTF-8 text as 8 hex digits (`captionHash`, the same in the engine and the
  runtime, held together by a test). Changing one word of a caption gives it a new name, so that caption alone
  falls silent until it is recorded again. `save_app` writes those elements from `voice/clips.json`
  (`{"clips": [{"caption": "3f0a9c1e", "file": "3f0a9c1e.mp4", "seconds": 5.42}]}`): one clip a caption, the file
  the caption's hash with `.mp4` or `.webm`, at most 60 seconds, at most 56 clips (an app's 64 files less the rest),
  and only clips whose file is in `voice/`. A list that does not read costs the video its voice, never the save.
  The web's page builder puts each clip into the page as it puts a video in (§2: `source[src]`), so the web knows
  nothing of the kit. A spoken caption lasts as long as its clip and half a second. The player speaks the clip of
  the caption on screen through one audio element, with the timeline as the clock: pause, scrub and jump are the
  timeline's alone. A browser plays sound only from a member's press, and some hold every later clip to that too, so
  the element is started inside each press that plays the video or switches the voice on (muted, and stopped again
  unless a clip is due). A page that is hidden stops, video and voice: it draws no frames while its sound would
  play on. A clip that stopped while its caption still has some of it to say (the picture stood still and the clip
  ran out) is taken up again from where the timeline is, at most once a second (review r1 of #1659). Voice on/off
  is a button (and M), shown only when the video has clips; the captions always stay, for a silent phone.
- **The machine's part of making the clips** (10 November 2026) is three scripts the runtime holds as text
  (`packages/runtime/kits/explainer/voice-*.cjs`, in `cloud-app-kit-explainer-voice.generated.ts`), each small
  enough to travel in one machine command, each printing lines marked `QORPERA-VOICE ` with one JSON object:
  - `voice-captions.cjs` opens the explainer's page in the machine's browser and prints the captions the running
    video speaks, with each caption's clip name. The engine decides what a caption is; a read of `scenes.js` only
    guesses. A page that says its video is broken gives no captions, though a `scenes.js` that stopped halfway
    leaves the ones it got to in the video.
  - `voice-peer.cjs` is the other end of the voice call: a headless browser makes the WebRTC offer (one silent
    track out, the call's events channel), waits for the answer as a file in its work folder, and records what the
    voice says, one file a turn. A turn is the call's own (`turn.created` to `turn.done`, then 0.7 s of quiet), so
    the two ends need no shared clock. It is handed no sign-in and reads none: the call is placed where the sign-in
    is, and only the offer and the answer pass between the two. A `stop` file ends it; so does its time (at most
    290 s). A turn whose end has come is finished first, whatever ends the recording: its file is written and its
    line printed. A turn that cannot be written, or is still not written 40 s after the recording was told to
    end, ends the recording as a failure (reviews r1 to r3 of #1660).
  - `voice-encode.cjs` writes the turns that were kept as clips into the app's `voice/` folder: silence cut from
    both ends, AAC in `.mp4`, mono, 72 kbit/s, each written beside its place and moved in.
  A clip is kept only when the voice said its caption (`explainerSpokenMatches`): every run of letters in the
  caption is in the call's transcript, in order (the letters around a digit too: "B2B" is not "B2C"), and the
  transcript has no more other words than six for each run of digits in the caption (a number is said in words no
  rule lists for every language). That passes "596"
  said in English or Danish and drops the caption that came back with two sentences of the voice's own.
  Run together on a Mac with the official Codex placing the call (10 November): six captions read from the page,
  spoken, checked and written as clips, with no turn started on the call's thread.
- **The tool that drives them is the next step** (§7): the kit, the engine, the page and the scripts are ready. The plan is
  ChatGPT's own voice through the Codex the agent already runs on, one caption at a time, each clip checked against
  its caption by the call's transcript (Jonas, 10 November 2026: "if it can just be ChatGPT's AI voice driven on
  your subscription it would be ideal probably"; a trial on his Mac that day read 28 captions, and one of them came
  back with sentences of the voice's own). Until then an explainer plays with captions alone.
- **What an agent is told** is the guide `explainer` (§3d; on `kit` in `save_app`'s schema until 14 November 2026,
  where no model received it): when a video is the right form
  and when not, the calls of a scene, how to write captions for the ear, how to pace and lay out a stage, that every
  number comes from the company's files, and to look at more than the first frame before showing it. A test holds
  every call, icon and colour it names to the engine. After a save, `look` names what a read of `scenes.js` found:
  no scene, a video made in the file itself, more than 56 captions, captions over 18 words, more than three minutes.
- **Security:** nothing new. The engine is Qorpera's text, but it runs where the agent's own script runs, inside
  the app's frame, with exactly a page's reach (§6); the page reads no live data unless its manifest says so, and an
  explainer needs none. A clip is a file of the app under the app's limits.
- **The call** (10 November 2026; `cloud-voice-channel.ts`, and the voice lane in `cloud-codex-tool-session.ts`).
  The voice is ChatGPT's own, reached through the Codex app-server the agent's run already has, on the run's own
  sign-in: a side thread, as auto-review's and the memory compactor's are, with a realtime session on it
  (`thread/realtime/start`: WebRTC, version v3, `clientManagedHandoffs`, no startup context). The lane takes a
  WebRTC offer and hands back the provider's answer; the sound itself flows between OpenAI and whoever made the
  offer, never through the runtime. Then one line at a time (`thread/realtime/appendSpeech`), each answered with
  what the provider says was spoken (`thread/realtime/transcript/done`, at most 4 KiB), until the call is closed,
  its caller's signal aborts, or the provider ends it.
  - The voice only reads. Its thread has no tools, a read-only sandbox and the reader rule as its instructions;
    every request Codex makes on it is refused. If the voice hands over to a model turn anyway (it did once on
    10 November, before the rule), the turn is interrupted and the call ends ("Native voice tried to act").
  - Nothing a call does fails the agent's run: a refused request, the provider's error and a malformed answer end
    only the call, and a model request on the voice's thread (a prewarm, or such a turn) passes the result fence on
    a lane of its own with nothing released. The one exception is the 120 seconds every side thread has to start.
  - One call at a time, and none in a run on a member's ChatGPT plan (its Codex reaches OpenAI's API with the plan's
    token). The run's end ends the call. A call that ends keeps its place until Codex confirms its stop (a successful
    answer to the stop, or the session's close; a refused stop confirms nothing), and the next call waits for that,
    so nothing the old session still says reaches the new one; a stop not confirmed within 10 seconds ends the run's
    voice, and the run goes on without it.
  - The call's control connection needs one host beyond the run's own: Codex makes the call at `chatgpt.com`, then
    joins it over a websocket at `api.openai.com`. The run's relay lets `api.openai.com:443` through only while a
    call is open, from just before `thread/realtime/start` until the call's stop is confirmed or given up on, or
    the run's process ends; then it refuses new connections to it and cuts the ones open
    (`NATIVE_CODEX_REALTIME_EGRESS_HOSTS`, `allowRealtime` in `cloud-native-egress.ts`). Only a Codex login's relay
    can be widened so; a ChatGPT plan's and a Claude sign-in's cannot. The call's sound never passes the relay.
  - Nothing opens a call yet: the tool that does is the next step. Until then the host is never let through.

## 3b. The data kits (13 November 2026)

The agents' apps of 13 November kept every rule of 10 November (a first screen that says how the area stands, about
300 words, a diagram instead of a paragraph) and were still documents in boxes: rules about how a page should look do
not make a researcher a designer. A data kit takes the drawing out of the agent's hands. The agent writes one data
file, the facts and the names of its pictures; an engine Qorpera wrote draws one visual form from it, the same engine
in every app of the kit.

| Kit | The question it answers | What it draws from the data |
| --- | --- | --- |
| `model` | does it make money, and what moves it? | sliders for the numbers, one large figure, a waterfall from what a customer pays to what is left, and a curve against volume with its break-even; a number nobody knows yet is a hatched slider a member drags, or sets with "Try an example" |
| `board` | what is out there, and which one? | `scale`: real things as pictures standing on one true scale, each opening a sheet of facts; `choose`: two to four directions as worlds to step into, with a button that answers the agent's open question; `wall`: reference pictures with a note each |
| `path` | how does it go, and where is the hole? | one to three lanes through the same steps, the evidence as marks under the step it supports, a step nobody has shown as fog with a question mark, and a flag for what will fill it; with numbers on the steps it is a funnel |
| `object` | what is the thing? | a turntable of the thing a member turns by hand, its parts pointed out on it with a leader to each name, and its figures under it |
| `curve` | where is it going? | one value over time, big: the past as a filled area, what is expected as a dotted line inside a band as wide as it is unsure, a "now" line, a dashed safe level, up to three marked points, and the value that matters large at the top, which follows a finger, the pointer or the arrow keys along the curve; a future nobody has said anything about is fog (14 November 2026) |
| `stack` | what wants my yes? | the things that wait on a member, one big card at a time (a soft colour field or a picture, one number, one line, the asking agent's figure; or a paper, for a bill), the open question's options as buttons under it, progress as dots, a stamp when it is answered and a page that says so when nothing is left (14 November 2026) |
| `shelf` | how do our things stand? | the company's own things side by side on one shelf, each a big picture with a soft colour block behind it as high as its level and its number under it, a low one warm, an agent's one-line note with its figure; without levels a gallery of finished things with the maker's figure (14 November 2026) |

An app made from one (`kit = "model"`, …) is an ordinary app: the same folder, the same frame, the same limits, no
call the web does not already answer.

| File | Whose | What it is |
| --- | --- | --- |
| `<kit>.json` | the agent's | the data. Each kit's guide (`packages/runtime/kits/<kit>/KIT.md`) says what it holds; `app_guide` answers with it (§3d) |
| pictures and videos | the agent's, written from a machine | named in the data by their path in the app's folder |
| `engine.js` | Qorpera's | the kit's engine (`packages/runtime/kits/<kit>/engine.js`). The runtime holds each engine's and guide's text (`cloud-app-kit-engines.generated.ts`, written by `npm run generate:app-kits`, held to the sources by a test) |
| `index.html` | Qorpera's | the page (`kitPage` in `cloud-app-kits.ts`) |

- **`save_app` writes the two that are Qorpera's.** With `manifest.kit` a data kit, a new app needs its data file
  among its files (`APP_DATA_MISSING` without it), and the data must read as the kit's (`APP_DATA_INVALID`, with why:
  not JSON, not one object, larger than 256 KiB, or without what the kit cannot draw without). A call that names
  `engine.js` or `index.html` of such an app is refused (`APP_KIT_FILE`), and so is a page of its own
  (`APP_KIT_ENTRY`). On a later save the two are written again only where the folder holds none or other text (by
  hash): new data, a new title, a picture that has arrived, or the engine of a newer runtime. An existing app takes
  a kit the same way, keeping its owner and `posted`.
- **The page names the pictures.** A page in the frame gets its pictures and videos only where it names them when it
  opens (§2), so the page lists, hidden, every picture and video the data names that the app's folder holds at the
  save (`kitMedia`: any text in the data that ends in a picture's or video's extension and is a plain path inside the
  folder), and the engine takes each from there by its path. One the folder lacks is left out, the engine draws a
  quiet placeholder for it, and the save's `look` says which. So an agent writes its pictures first, from a machine,
  or saves the data again after: a save with the data in the folder and none in the call reads the folder's.
- **The engine reads the data through the bridge**, as it stands when the page opens, and again after a change
  notice, no sooner than ten seconds after its last draw (§5). So the app's own folder is the one source: a change of
  `<kit>.json` shows without a new page. The page also holds the data as it was saved, for one case: opened where
  there is no `qorpera` object (an agent looking at `/company/apps/<name>/index.html` on a machine before it shows
  the app), the page answers the engine's read from that copy, lists no questions and refuses every change. In
  Qorpera the frame defines `qorpera` before any script of the page runs, so the copy is never used there.
- **Each app carries its engine**, as an explainer does (§3a), for the same reasons and at the same cost.
- **One look.** Every engine builds its page from the base style's variables (§2) and follows light and dark; none
  holds a colour of its own (a picture's and a direction's own palette are content). A kit's page that the web gives
  no base style, because the app is a concept, carries Qorpera's plain look itself: the same variables, in the base
  style's own layer and with no specificity, so the web's wins wherever it is there. Common to the four: the title
  and at most one line, then the thing; labels, numbers and notes of one line, each field cut at its bound; `known`
  drawn solid, `assumed` dashed and tagged, `unknown` hatched with a question mark; a source as one small link; the
  page's few own words in English unless the data's `words` give them in its language.
- **What a member does** goes through the bar (§5), from a button that says what it does: `board`'s `choose` answers
  the agent's open question that points at the app (`answers`), and `model`'s `save` keeps a member's numbers in a
  company table (`table:<name>`). The manifest's `writes` and `reads` say so as for any app. A `stack` is all
  answers: each card's buttons are the options of the open question whose title is the card's (or whose id its
  `question` names), a press is `qorpera.answer(id, value)`, an open question no card names is drawn as a plain card,
  and a card whose question closed elsewhere counts as answered. So `save_app` adds `questions` to a stack's reads and
  `answers` to its writes (never takes them away), as it adds `data` where the data names a database's question.
  A card is matched by its whole title, also one longer than the card shows; a card already answered (its `answer`, or
  pressed on the page) takes no open question, so the same title asked again is a card of its own, and a question
  answered on the page stays gone even when a read that began before the answer still lists it. When `writes`
  already holds 16 entries without `answers`, `save_app` adds only `questions`, and its look says one entry must give
  way to `answers`.
- **The agents' figures.** A field `figure` whose text is a figure's id (`crown`, `rocket`, …) puts that figure in the
  page (`kitFigures`): a small WebP of the web's artwork as a data: URL, under `#kit-media` as
  `data-kit-src="figure:<id>"`, since a page has no network and the figures are not the app's files. The pictures are
  `packages/runtime/kits/figures/<id>.webp`, and `npm run generate:app-kits` writes them into
  `cloud-app-kit-figures.generated.ts`. `stack` and `shelf` draw the asking agent or the maker by it; with none, the
  name's first letter in a soft circle.
- **A note to the app's owner** (`tell`, §5; Jonas, 13 November 2026: "you can't act very much inside of the
  interfaces"). The detail a tap opens has one quiet button at its foot, never on the stage: `board`'s item sheet
  (and in `choose` a direction's world, in `wall` the picture's lightbox), `path`'s step sheet, `object`'s part note,
  `model`'s note under an input's label (with `tell` every label opens one), `shelf`'s opened thing, and the card in
  front of a `stack` (there only where `words.tell` names it). A press asks
  `tell({about, at, text})`: `about` is the thing's name (`path`: "step · lane", the lane left out on a path with no
  lanes; `object`: the part, and the variant shown when there are several; `model`: "label · the value as shown"),
  one line cut at a word to 60 characters; `at` its id (`path`: `lane:step`, or the step's id on a path with no lanes),
  sent only where it fits the call's pattern; `text` the thing's `ask` (a draft, at most 40 characters). The data's
  `words.tell` is the button's label, written by the agent naming itself ("Spørg Luna"), and `words.told` what it
  says once the note went or waits in the thread; without `tell` the button is a speech-bubble mark with an English
  name for screen readers. A refusal (most often the member's own "Not now") shows the bridge's sentence quietly
  beside the button, read out and moving nothing, for six seconds, or until the next press or the detail closes; the
  button stays. The button is drawn only where the page's `qorpera` has `tell`: an older web, and the page opened
  outside Qorpera, show none.
- **`look`** is what a read of the data finds (`kitNotes`): pictures the folder lacks, and texts longer than a kit
  shows. How the page looks stays the agent's to check on a machine.

Not built: the Co-Founder's `company` page has no kit of its own; a helper that renders an object's turntable and
its parts' tracks in Blender on a machine (an agent writes that script itself today, from the guide); and a look at an
app's screenshot by someone other than its maker. Pictures an agent generates are §3c.

A model whose groups hold no input is refused as one without groups is (`APP_DATA_INVALID`): the engine would draw
one line that says there is nothing to show.

## 3c. Pictures: make_picture (13 November 2026)

Jonas, 13 November 2026, after the interfaces preview: "I would also turn on agents generating images of course."
His rule for such a capability (10 November, for the voice): one Qorpera tool, so the engine behind it can change.

`make_picture {operationKey, path, prompt, expectedVersion?}` makes one picture and saves it as a PNG file in the
company folder (`cloud-folder-picture-tool.ts`; the lane in `cloud-picture-channel.ts` and `cloud-codex-tool-session.ts`;
migration `20260930746000`, which only names the tool among a run's observations).

- **Who has it.** A run on a Codex login (the run's identity root has no `chatgpt-plan/`); a run on a member's ChatGPT
  plan has neither the tool nor the lane, and a Claude sign-in never reaches this runtime. A read-only worker does not
  have it (`cloudWorkerToolFilter`). No count of pictures per run: the member's plan is the limit.
- **Arguments.** `path` is a company path ending in `.png`, not under an app's `icons/` (save_app's SVGs). `prompt` is
  plain text, 1 to 4096 bytes, line breaks allowed. `expectedVersion` is company_write's: left out or null for a new
  file, the version company_read reported to replace one.
- **Where it may be saved** is company_write's rule, decided by the folder core at the commit: a protected path parks
  the change for review (the answer's `state` is `proposed`), a missing folder is refused, a stale or present file is a
  conflict. Before the picture is made, the tool refuses a path whose folder is not there and a path that is a folder or
  a link: each picture costs the member's plan. Exists and version are checked at the commit only, as company_write's.
- **An app's room.** For a path under `apps/<name>/`, before the picture is made the tool lists the app as save_app
  does (`appFileSizes`, `APP_LIST_LIMIT`) and refuses (`APP_TOO_LARGE`) when one more file would pass 64, or when less
  than 4 MiB of the 48 MiB of pictures and videos is left (the file the call replaces not counted). Once the picture is
  made, the app is listed again and counted the same way with the picture's real bytes, since another run may have
  filled it during the generation (`APP_TOO_LARGE`: made, not saved). The commit checks the target's version only (the
  folder core has no precondition on a folder's listing for a write), so the moment between that listing and the commit
  stays open, as between save_app's own listing and commit: the bound is held at each save and by the page's reader,
  not by the commit.
- **A repeat costs no picture within the run.** The tool keeps, for the run's life, what it answered per
  `operationKey` (the newest 256 calls, with the picture itself for the newest 4). A repeat of the same call is answered
  from there before anything is made: the same answer, the picture again when it is kept; a call whose outcome stayed
  unconfirmed past its receipt stays unconfirmed (`TOOL_OUTCOME_UNCONFIRMED`); the same `operationKey` with other
  arguments is refused (`OPERATION_KEY_USED`). A refused call (nothing began) is not kept: its repeat may make a picture.
  A repeat in a later attempt of the run (after it was cut off and resumed, a new process) is not in that memory: it
  makes one picture, which the receipt's replay then throws away and does not show. The ledger has no read of a
  completed operation by key that starts nothing (the begin is the only lookup, and it opens a receipt where none is);
  closing that gap needs one SQL function (below, "Not done"). A repeat of a call whose picture went among the company's
  pages or tables (under `QorperaOS/interfaces/` or `QorperaOS/tables/`) notes the change in the conversation again, as
  a repeat of company_write's does, so a note that failed the first time is made.
- **An app's owner.** Under `apps/<name>/`, a manifest that names another owner makes the call delegation (`prepare`
  adds `foreignOwner`), as for save_app; its own app's, and any other path's, is `internal`. The card: "Put a picture
  into another agent's app" (or "Make a picture"), the path, the prompt quoted.
- **The side thread.** A fresh thread of the run's own app-server, as auto-review's, the compactor's and the voice's:
  the run's model, `environments: []`, no workspace roots, read-only, ephemeral, no dynamic tools,
  `CLOUD_PICTURE_MAKER_RULE` as its instructions, and the only thread config the runtime ever sends,
  `{"features.image_generation": true, "features.omit_app_server_notification_media": true}` (Codex merges a thread's
  config after the command line's; the field is not experimental). The agent's thread is started with none: the
  process's configuration keeps `image_generation` false, and `verifyConfiguration` still holds every disabled feature
  to false. One turn, effort low, whose input is the prompt; its model calls Codex's `image_gen.imagegen` once.
- **A Codex pin past 0.155 must keep tools direct for this lane.** The pinned patch makes every tool direct
  (`governed_tool_mode`). On the Mac trial of 13 November 2026 (lane make-picture-20261113, `mac-trial/RESULT.md`),
  unpatched Codex 0.160.0 with every `DISABLED_FEATURES` entry off made no picture: its image tool call went through
  code mode, which fails closed while `code_mode_host` is off. With code mode at its default, the per-thread config
  beat the process's `image_generation=false`, `thread/start` took every parameter above, and the item's keys,
  `savedPath` and the empty `result` were as described here; the picture (1536×1024, 1.87 MB) took 18.1 s.
- **The picture's bytes** come from the file Codex saves, never from the notification: with the media switch on,
  `item/completed` of type `imageGeneration` carries `savedPath` and an empty `result` (without it, the base64 picture
  would be one stdout line past the bound that fails the run). The file must be
  `<CODEX_HOME>/generated_images/<thread>/<item>.png` (each id with what is not a letter, digit, `-` or `_` made `_`),
  that path once links are resolved, a regular file of one link, opened without following a link, 12 MiB at most,
  starting as a PNG does. It is then removed, and its two folders when empty, each only after `lstat` shows a real
  folder; nothing else is read or removed. A picture saved after its call ended is removed the same way.
- **The lane is quiet.** Every request on the picture's thread is refused; its model requests (prewarm, the turn's
  first, and the one after the picture) bind to a lane that never throws, are never composed from the agent's run, and
  get nothing of the agent's (each output `{"available":false}`). The request after the picture carries Codex's own
  tool output, `[image, hint]`, which the pinned fence refuses inside Codex (an image is taken only behind a host
  envelope): the picture's turn ends there, or at the interrupt the lane sends once the picture is in. Its words,
  usage and errors reach no one. The one exception to "never fails the run" is the 120 seconds every side thread has to
  start. One picture at a time; the run's end ends a call.
- **The relay** of a Codex login lets every connection be silent for 5 minutes instead of 30 s while a picture call
  lasts (`allowLongWaits`, nested windows as `allowRealtime`'s): the images request answers only once the picture
  exists, and Codex keeps no ping on it. It widens no host.
- **Failures** are refusals, nothing saved and no receipt taken (the picture is made before the receipt: one left
  executing would stop the run's later changes): the member's picture limit (`usageLimitExceeded`, `limitId`
  `image_gen`: "the member's ChatGPT has no pictures left for now", with when it resets), the member's usage limit,
  the generator refused or failed after the image tool was called (`PICTURE_REFUSED`), the image tool never called
  (`NO_PICTURE`), none within 4 minutes, not a usable PNG, over 12 MiB, the login cannot make pictures.
- **When the image tool was never called** Codex may have withheld it (a Free plan, a model without image input, a
  provider or sign-in that does not qualify, a thread config not applied) or the model declined the prompt in words.
  When Codex named the member's plan as Free (`account/updated` or `account/rateLimits/updated`, `planType: "free"`,
  read as a fixed word and kept for nothing else), the answer says so (`NO_PICTURE_FREE_PLAN`): the plan makes no
  pictures, and the agent goes on without one and tells the member in one line. Otherwise why is not known
  (`NO_PICTURE`): the agent changes the prompt and tries once more, then goes on without one and tells the member.
  Codex 0.155.1 has both notifications with `planType` (a Free plan is `"free"`), but sends `account/updated` only on a
  sign-in or sign-out, and a rate-limit update's plan only when the backend gives one: on a node the plan is often not
  known. Codex 0.160.0 sent `account/updated` about a second after a thread started (the Mac trial). The sign-in's
  token is never read for it.
- **The answer** is company_write's (`state`, `version`, `receiptId`, `outcome`, `next`) with `kind: "picture"`,
  `mediaType`, `bytes`, `fileSha256`, the picture's and the shown size, `imageSha256` of the shown PNG, `transparent`
  when the generator said, and `revisedPrompt` when the model gave the generator other words. That is the picture
  model's own prompt argument, which nothing in Codex bounds: the lane keeps 4096 bytes of it at most, cut at a
  character's end, and the answer leaves it out, saying `revisedPromptCut`, when it was cut or would keep the answer from
  reaching the model whole (an envelope past its bound is cut, and its picture's hash with it; a stored result past
  48 KiB fails its receipt). The picture follows it,
  fitted as company_read fits an image (`folderImageView`: at most 1920×1200 and 1 MiB), when it was saved or parked,
  is the one made now, and its answer fits one result whole. The context view takes it as machine_screen's screen: this run's own answer, source
  `runtime`, no read, naming the picture's hash (`kind: "picture"`).
- **What the agent is told** is the tool's description alone: what pictures are for (what does not exist yet), that a
  real thing is shown by its real picture and a generated one is never passed off as a photo (an app says drawn or
  illustration), one picture per call, how to write the prompt, to look at the picture and try again, and that an
  app's pictures go into its folder before save_app.
- **The run's log** keeps a call as it keeps company_write's: its arguments, the prompt's text among them (cut at the
  log's 8 KiB a field, as a file's text is), and the answer's envelope (path, version, sizes and hashes, a revised
  prompt). The picture itself is never in the log or the context view: only its hash.
- **Not done: a read of the run's receipt by key.** A repeat in a later attempt would cost nothing with one
  service-role function, such as `qorpera_read_native_tool_operation(p_binding, p_logical_operation_key,
  p_input_sha256)`: under the same binding and lease check as `qorpera_begin_native_tool_operation`, it answers the
  run's own receipt under that key without creating or locking one (`completed` with its stored result and folder
  commit; `executing`, `ambiguous`, `cancelled` or `outcome_unknown` alone; nothing when there is none; a refusal when
  the key is bound to another input), with its SQL test, and a `CloudNativeToolOperations` method that asks it with
  the same envelope digest before the tool makes the picture.

## 3d. Guides: app_guide (14 November 2026)

What an agent must know to make a part of an app is long: a data kit's guide is about 5 KB, the explainer's 6 KB,
a page's live data and changes 6 KB together. Until 14 November 2026 all of it, about 40 KB, stood on the fields of
`save_app`'s schema (§3, §3a, §3b), on the reasoning that a description holds 4096 bytes and a schema 64 KiB.
**No model ever received it.** The patched Codex sends no field description of a tool whose schema is 5,000 bytes
or more as it sends it (probed that day with tools of rising size: 4,991 bytes kept every description, 5,000 lost
them all; it also never sends `minimum`, `maximum`, `minLength`, `maxLength`, `maxItems`, `pattern` or `format`).
`save_app`'s schema reached the model as 1,291 bytes of bare shape. The kits, live since v243, were filled from
their names and one paragraph of the instructions: on production the one model app held `{"groups":[]}`, an
agent's answer to the refusal "model.json has no groups".

So a guide is a tool's answer, read when the part is made:

- `app_guide {about}` answers one guide's text (`cloud-app-guides.ts`), with `about` one of `look` (below), `model`,
  `board`, `path`, `object`, `explainer` (a kit: what its one file holds, field by field, with an example; a data kit's
  guide starts with what the four share), `style` (the base style, §2), `reads` and `writes` (§5) and `icons` (§2). It
  reads nothing of the company and changes nothing: review class `read`, no receipt, no operationKey. Its one
  database change is its name in the closed list of a run's observations (20260930762000).
- **`save_app` saves a kit's own file (`<kit>.json`, `scenes.js`) only in a run that has read the kit's guide**:
  otherwise `APP_GUIDE_UNREAD`, before anything is written, naming the guide to read. Which guides were read is held
  by the app tools of the run's attempt: a run that goes on in a new attempt reads the guide again. A description that
  says "read the guide first" is a request; this is the rule, since the failure it answers was silent for as long as
  nobody read a request as the model received it. A save that leaves the kit's file alone (pictures, the manifest, a
  concept's cover) needs no guide. The guides of a hand-written page are not held to a read: its page still opens
  without them.
- `save_app`'s fields say a line each: which kit draws which thing stays on `kit`, where the agent chooses; the
  rest point at their guide. A test holds the schema under 4,600 bytes, so its descriptions arrive.

**The look (14 November 2026, company views plan §3 "Taste").** `look` is the bar every app is held to, from Jonas's
reactions to 44 sketched screens of a company: Qorpera's own plain look (the base style's page, `--q-bg`, and the
system font; no scenes, skies or themed backdrops), the company's real things (products, shop, money, dates, customers' words), one big shape
a screen with colour as large soft fields and very few words, never grids of small controls, chip rows, scattered dots,
text cards or labelled diagram lines, and **copy the quality, not the layout**. A kit keeps its own form (the model
kit's sliders and chips, the explainer's arrows): for a kit, the look decides what goes in it; for a page written by
hand, the page too. It tells seven screens he liked and
three he did not in a line each. `app_guide`'s description and `save_app`'s `kit` say to read it before the first
app; no save is held to it, since a page is still a page without it. The pictures of those screens are in no
company's folder: every way to put them there (a seed at creation and a backfill, a platform writer, the machine
image, an image answer of `app_guide`) is a mechanism of its own, so the guide tells them in words until one is chosen.

For any tool: what a model must choose by goes in the description (4096 bytes) or in field descriptions of a schema
that stays under the bound; a bound on a number or a length is said in words; anything longer is an answer.

## 4. Web

- **App page.** `#/c/<profileId>/a/<name>` shows the app in the main area, at full width and height, as Mailbox and
  Bank show (`AppPanel` placed as a page). It has **no header** (Jonas, 10 November 2026, on the page's slim header:
  "I would remove any headers as they add nothing but bad visual design"): the app is the whole page, as a concept is
  the whole stage. The rail beside it shows which app is open and leads everywhere else (at phone width, the top bar's
  menu); a press on the open app's icon in the rail, or on its card in a message, reads it afresh, as Reload did
  (a modified click on the icon still opens a new tab). Qorpera draws only what is needed when it is needed,
  outside the frame: the bar of a request (§5 "Changes") above the page, and the questions dock over its corner. A
  deep link or reload opens the company, waits for its first read, then the app. When the app can't be shown, the line
  that says why ("This app isn't in the company anymore.", a manifest's problems, "This app reloaded itself…") has the
  ways on under it: the way back (to the company's last open conversation, else the company) when the app is gone,
  Reload, and Show in Storage when the app has a folder.
- **Side panel.** PR #1430's agent sheet, generalised: `AppPanel` placed beside the conversation inside
  `.thread-body` (not over it, no dim, not modal), the conversation stays mounted and usable. It shows `folder:`
  links to `.html` files (a plain page, no manifest), never an app. It keeps a header (the emblem, the name, who made
  it and the password line, Reload, Show in Storage, Close); Escape (in the panel or in the page) closes it. At phone
  width it covers the thread, with Close.
- **Chat card.** A link `app:<name>` in an agent's message draws as a card that opens the app's page. A message's
  cards stand in a row of their own under the words' bubble, on the thread and not in the bubble; a sentence that
  names an app keeps its words, with the name as a link in the words' colour, and gets one card for the app however
  often it names it. A card in a list's item or a table's cell stays where it is, in the bubble. The card shows an
  emblem, the title, one line under it and a chevron: drawn plain it has a page's emblem and "App"; once the
  company's apps are read it shows the app as the drawer does (the member's own icon and colour for it, or its
  group's colour; an app that is not in the drawer as its manifest says) and the app's `about` in one line, whole
  on a hover, or "App" where it has none. Choice cards draw the same card, and so does a member's
  note sent from an app's page (§5 "A note to the app's owner"), above the member's words, with the app's own name
  and what the note is about as its line.
- **Concepts viewer.** `#/c/<profileId>/concepts[/<name>]` shows the company's concepts (`concept = true`): the open
  one's frame fills the stage, edge to edge, with nothing of Qorpera's around it — no header, no border, no inset and
  no band (Jonas, 13 November 2026: "minimize the borders/framing around the visual we are just trying to show"). The
  only furniture is the side panel, which stands where the company rail stands and is the rail: the member's own
  width for the expanded rail (a compact rail's strip is no width for it: the rail's default stands in, and the
  panel's own fold stays its own), its surface, its rows, its hover and its selection (Jonas, 13 November 2026:
  "match the style and width of the regular sidepanel"). It holds the way back and each concept (cover or emblem,
  title, `about`, who made it), and it ends with its list (Jonas, 13 November 2026, on the controls and the strip
  under it: "get rid of this at the bottom of the concepts sidepanel"). A concept's row has the rail's menu (a
  right-click, a long press on a touch screen, or Shift+F10 or the menu key on the focused row): Show in Storage, and
  for the open concept Reload, which also lets a concept that was told "Not now" three times ask again. The strip
  that said whose the open concept is and that Qorpera never asks for passwords there was removed on 13 November 2026
  on the founder's word (§6 H2); who made each concept still stands in its row. With the line gone, nothing on screen
  tells a member that a sign-in a concept's page draws is not Qorpera's own; what they type into one can leave by a
  web link only after they have seen the link's whole address on Qorpera's bar and pressed Open (§4 "Links"; the
  founder's word, 13 November 2026: "Show the address first"). Its toggle is the sidebar's ("Hide
  sidebar", "Show sidebar"). It folds to the compact rail's strip; at phone width it is a top bar with a menu.
- **Questions dock.** The agents' open question cards stand over the corner of an app's page or the Concepts viewer's
  stage, outside the frame: one tap answers, as in the chat. The dock heads the card itself — the agent's figure
  waiting and "<Agent> asks you" — and the card below is the question alone: its title, body, app links, options and
  Skip, with nothing else over it (Jonas, 13 November 2026: "In the question box I would also simplify and remove
  'Open the chat, QUESTION, Co-Founder · 02:45 PM, Waiting for you'"). In the Concepts viewer a card shows on the
  page of the concept it asks about and on no other, also while it stands answered for a moment; one that points at
  no concept, or at one that is gone, shows on none and waits in its agent's thread.
- **Apps drawer.** Posted apps join Mailbox, Members and Bank in #1430's drawer, as links to their pages.
- **Changes.** The page or panel follows the folder's hints (one channel shared with the pages' reader; at most once a second,
  a minute's poll behind it). After a change it puts the page together again: a changed page is shown afresh, an
  unchanged one is told `qorpera-app-change` (§5).
- **Links** (10 November 2026; the seven apps of the reviewed company held 68 links, all dead). The frame follows no
  link itself. In an app's page the frame document stops a click on a link (`<a href>`, `<area href>`, an SVG `<a>`;
  also inside a shadow tree) and sends where it leads to the host over the port (§5). The host opens what it allows:
  - `app:<name>`: that app, where apps open (its own page, or the Concepts viewer for a concept), as an app's card in
    a message does;
  - `folder:<path>`: Storage at that file or folder, where a folder link in a message opens when no chat stands beside
    it. The path is under the rules of a read (§5): the company's own work, never a platform folder;
  - `http:` and `https:`: checked as a link in a message is (no name or password in the address), then put on
    Qorpera's bar above the page (§5 "Changes") as a request of its own, and opened only after the member has seen its
    whole address there and pressed Open (the founder's word, 13 November 2026: "Show the address first"), so what a
    page puts into an address is seen before it leaves. The bar shows the site first, on a line of its own (the host
    as the browser will reach it, punycode as punycode, its registered part in the bar's ink and any labels before it
    quieter, and a port when there is one), then the address in full, path, query and fragment, as text of the bar's
    own: it wraps, can be selected, and scrolls inside its own line past six lines, so it is never cut. The tab opens
    in that press, with no way back to the app and no referrer; Not now, Escape, a page put away, or another request
    waiting open nothing. The press is the member's own on Qorpera's button, so a browser lets the tab open; should it
    still stop one, Qorpera offers the link in a line of its own above the app's frame, named by its real host and
    path, and the member's click on that line opens it.

  Anything else opens nothing: a relative address (an app is one page, §2), `mailto:`, any other scheme, a platform
  folder. Three things are not touched: a jump inside the page (`#…`), any click the page's handlers took for
  themselves (`preventDefault`), and a `javascript:` address, which is left to the browser as before (Chromium runs
  none in this frame, so a page uses a button or a click handler instead). Only a click the member made is sent
  (`isTrusted`); a click a script made is stopped and leads nowhere. A Company File page beside a chat opens no links:
  its links are stopped too, and the host refuses them. In Storage's own preview a page is as before.

  How the frame document hears a click does not depend on what the page's own handlers do with it, and changes
  nothing of what the page reads or says of the click:
  - The link is noted on the click's way down, before any handler of the page has it: at the window, where the frame
    document listens before the page is written, and at the root of every shadow tree, where a closed tree's own nodes
    still show. It is the innermost link on the click's path, also one around a slot that the clicked node sits in.
  - The click is settled when the page's handlers are done with it, by what the browser itself then says of it. A
    click a handler took, in any way a handler can (`preventDefault`, `returnValue = false`, a handler that returns
    false), is the page's; a passive handler cannot take one, as in any page.
  - To be heard behind the page's handlers, the frame document listens last: at the window, for a click that travels
    all the way, and on every node of the click's path, each way, for a click a handler stops there
    (`stopPropagation`, `cancelBubble`): the other handlers on that node still run first. These listeners are put
    last again at every click, so a handler the page added since still comes before them.
  - Where no listener of the frame can come after the handler that stops the click, the click is settled when that
    handler returns, which for a real click is before the browser acts on it. That is so for
    `stopImmediatePropagation`, and in two places on the click's way down: at the window, and at the root of a closed
    shadow tree.
  - Settling a click the page left alone keeps the browser from following the link, and sends the link's address, as
    it is written then, to the host once the click is over. One click cannot be kept from the browser that way: a
    click settled while a passive handler has it (a passive handler that stopped it at once, or in one of the two
    places above), since nobody can take a click from a passive handler. There the link's address is taken out of
    the link for as long as the click lasts, and put back once it is over.
  - A click a script made is stopped on its way down, whether or not it travels up to the window, and is never sent.
    To the page's own handlers such a click reads as taken already.

  Limits, each a dead or a wrongly sent link in a page built to meet it, none a way out (a frame that leaves its
  page is ended by the host as before, §5, and what is sent is checked by the host like any link):
  - A link inside a closed shadow tree is not seen when a handler of the page stops the click on its way down,
    before the click reaches that tree. Such a click does what it did before.
  - In the two places named above (the window and a closed tree's root, on the way down), a second handler in the
    same place that takes the click after the first one stopped it is not waited for: the link is sent.
  - A handler the page adds to a node during the click itself comes after the frame's listener on that node.
  - A page that puts its own functions in place of `Event.prototype.stopImmediatePropagation` or `stopPropagation`
    loses the settling for the clicks those stop where no listener of the frame follows.

## 5. The bridge: live data (step 4) and changes the member allows (step 5)

The page talks to the host only over **one `MessageChannel` port**, handed to the frame with the page, once
(`ui/app-frame.ts`). The frame document keeps the port in a closure and gives the page a frozen `qorpera` object
(`public/page-preview/index.html`); the page never sees the port. Window messages carry only the frame's "ready" and
Escape, as for every Company File page. A frame that says "ready" again, or loads a third time (the frame document,
the page written into it, then anything else), has left the document it was handed: the host closes the port and the
panel says "This app reloaded itself. Press Reload". A new document in that frame has no port.

```js
await qorpera.read("apps/sales/data.json")   // a file's text (≤ 1 MiB)
await qorpera.list("reports")                 // a folder's entries: name, path, kind, bytes, updatedAt
await qorpera.table("tasks")                  // a table's name, columns and rows
await qorpera.todos()                         // each agent's todos: agent, title, status, updatedAt
await qorpera.agents()                        // agents: name, role, working
await qorpera.questions()                     // the agents' open questions that point at this app
qorpera.onChange(() => …)                     // the company's folder changed: read again

await qorpera.answer(id, value)               // ask the member to answer one of those questions
await qorpera.setRow("orders", key, cells)    // ask the member to change cells of one row
await qorpera.addRow("orders", cells)         // ask the member to add a row
await qorpera.tell({about, at, text})         // ask the member to send the app's owner a note about a thing in it
```

Wire, on the port: page → host `{type: "qorpera-app-call", id, method, params}`; host → page
`{type: "qorpera-app-answer", id, ok, value | error}` and `{type: "qorpera-app-change"}`. A link the member clicked
(§4) goes the same way, as the call `open` with `params: {href}`. The frame document alone sends it: the `qorpera`
object has no call for it, so a page's script cannot.

Rules:
- **A page changes nothing by itself, and sends nothing.** The last four calls only ask: see "Changes" and "A note to
  the app's owner" below. Every other call reads.
- **Allowed sources** are the manifest's `reads`; a method outside them is refused. The app's own folder is always
  readable. With `files`, any company path outside the platform's folders: never `QorperaOS/`, `hooks/` (received
  mail), `bank/`, `digital-post/`, `members/` or `code/`. Paths are checked on the host: relative, no `..`, no `%`,
  no backslash. Tables come only through `table`. With `questions`, the question cards waiting for the member that
  point at this app (the rule the questions dock uses: an option previews `app:<name>` or a picture in `apps/<name>/`,
  or the body links `app:<name>`): each card's id, the asking agent's name, its title, body, options (label, value,
  description), whether it takes several answers, and when it was asked. Never the conversation it is in.
  An option's `preview` is what the card shows above its label, in the chat and in the dock alike: a picture of the
  company's folder, or `app:<name>`, which shows that app's `cover`, or its own emblem beside its own title, never
  its folder name. An option with no preview, or whose picture cannot be read, draws no preview at all: an empty
  frame is no preview (Jonas, 13 November 2026, on his company's question: the previews "do not load their visual").
  A card drawn before the company's apps are read gets the app's preview once they are, and follows a change to the
  app, in place: a pick and an answer being typed stay.
- **Never into the bridge:** the member's token, email, id or session, this app's own state, other members' settings,
  vault or login data, mail, billing.
- **The viewer's own authority**: every read is the member's own folder read.
- **Bounds**: at most 8 calls in flight and 120 a minute per app in a tab (kept across Reloads; `todos` counts as
  ten, since it reads every agent's todos, and a request for a change, a note or a web page to open as five), a call's params at most
  4 KiB (a row's cells 16 KiB), an answer at most 1 MiB. `questions` reads the cloud at most once in four seconds. A
  call over the budget is refused ("Too many calls") and spends nothing. Change notices come up to once a second, so a page that
  drew on every one would spend a minute's budget in seconds. `save_app` therefore tells agents the pace: draw when
  the page opens, after a change draw again once and no sooner than ten seconds after the last draw, each source
  called once per draw, and after a failed read keep what was shown and read again ten seconds later.
- **Links are calls**: an `open` is checked on the host (`appLink`, with the path rules of a read) and spends one call
  of the budget; a web page's link, put on the bar, spends what a request does (five in all); a refused one counts
  with the refused calls, and 300 of those stop the frame. It needs nothing in
  `reads`, because nothing is read for it. The answer is the same whether or not what the link names is there, and the
  frame document drops it, so a page learns nothing from a link.
- **No requests of its own**: the frame keeps `sandbox="allow-scripts"`, no origin, the frame document's policy
  (`default-src 'none'`, no `connect-src`), and this app's `frame-src 'self'`. Some side channels remain (a
  `dns-prefetch`/`preconnect` link the page's script adds is acted on before anything can take it out): blocking them is
  best effort, not a boundary.

### Changes: what a member can do from an app (step 5)

Jonas, 10 November 2026: "agents lets you interact with your employees — interfaces let's you interact with your
company directly." Until step 5 an app could only be looked at: a member who saw something to decide went back to
the chat. Jonas picked the first two actions the same day (the proposal:
https://claude.ai/artifact/YRm5HVhRitjiEPmH189jVX): answer an agent's question, and change a row of a company table.

**The gate** is the one the security review asked for (§6, H3 and L3). The page asks through the bridge; the web
checks the request and puts it to the member on a **bar it draws outside the app's frame**
(`app/views/app-ask-bar.ts`), and the change is made only when the member allows it there, as the member's own save.
- The manifest's `writes` must name the action: `answers`, or `table:<name>` for that table. Anything else is refused
  with no bar, before anything is read. A note to the app's owner and a web page a link leads to need nothing in
  `writes`: the page chooses neither who hears a note nor its words, and a link only asks to open what the member
  sees in full.
- The bar stands above the frame and pushes the page down, in every placement (an app's page, the Concepts viewer):
  nothing of the page is ever under its buttons. The frame has no origin, so the page can neither draw the bar nor
  press it.
- The bar says what will be saved in Qorpera's words, with no text of the app's in its sentences: for an answer, the
  agent, the card's title and the labels of the options chosen, read from the card; for a row, the table's name, the
  row's key and each cell as it is and as it will be (an added row: each cell it sets); for a web page a link leads
  to, the site and the whole address (§4 "Links").
- Every request is its own bar. There is no "always allow", and nothing is remembered.
- "Not now" has the focus (for a note, the bar's field: §6 says why that is safe). The yes button ("Send answer",
  "Change row", "Add row", "Send note", "Open") wakes one second after the bar is on a visible screen, and takes only a press
  (pointer or key) that began on it after it woke: a click or a held key on its way when the bar came in does nothing,
  and Enter in the page stays in the page. Escape on the bar is "Not now".
- One bar at a time: while one is open another request is refused at once. After three "Not now" in a row the app is
  refused without a bar until the member reloads it (a press on the open app's icon in the rail or on its card in a message, the Concepts
  viewer's Reload, or the browser's own); a yes starts the count again.
- While a bar is open the page's Escape is not passed on (`AppFrame.holdEscape`).
- A request whose page is put away (reloaded, changed, left) before the member chose is put away unsaved, and so is
  one whose app's manifest changed meanwhile. What a page may read and ask for follows the manifest as it is now,
  also under a page that stays as it is: `writes` taken away refuses the next request at once, `writes` added works
  without a Reload. The page that stands follows the manifest from the moment it is read, before its files are read
  again, so a page that cannot be put together again does not keep what the manifest took away. A request still
  being checked when the page or the manifest changes is refused when its check ends, before anything is shown
  (`AppPanel` serves each frame and each version of the manifest with its own bridge).
- However much a request holds, the bar stays within the screen: its lines scroll inside it (at most 40% of the
  window's height) and both buttons stay in reach. Checked in a browser at 390 px wide with twelve cells of 500
  characters.
- The bar then says how it went: "Sent to <agent>", "Saved", "Your note waits in <agent>'s thread", or why not. The
  page's promise resolves `{saved: true}` (a note: `{sent: true}` or `{sent: false, waiting: true}`) or rejects with
  the reason: not now, another request waits, asked three times, or the refusal's own words.

**`answer(id, value)`** (`writes` has `answers`). `id` is a card `questions()` lists, so one that points at this app
and waits for this member; `value` is one of the card's own option values, or a list of them for a card that takes
several. A typed answer is not taken from a page. Allowed, it goes the way a tap on the card goes in the chat and in
the questions dock (`OpenQuestions.answer`: `qorpera_answer_interaction` with its checks, on the member's own model
account for that thread), and the asking agent's run goes on with it. The card leaves the dock on the same page at
once.

**`setRow(table, key, cells)` and `addRow(table, cells)`** (`writes` has `table:<table>`). One row a request.
`key` is the value of the table's key column, or column → value for a key of several columns; `cells` is column →
text, number, true or false, or null for an empty optional cell, at most 12 cells for `setRow` and 500 characters a
cell. The web reads the table's definition and rows with the member's own read, types each value as its column types
it (`tableFieldValue`), and refuses before any bar: a table that is not there or that members may not write, rows
that do not fit their definition (they would be lost by a rewrite), a column that is not the table's, a key cell, a
value that does not fit, a row that is not there (or, for `addRow`, a key that already is), and a change that changes
nothing. **A page never changes who holds, owns or does something**: a `needs_yes` column and every `member`,
`agent` and `agents` column are refused, and so is the table `areas`, which a manifest may not even name. No row is
removed from a page. Allowed, the rows file is rewritten through the member commit route with the version it read
(`rewriteStateFile`): only the named fields' text changes, every other byte stays. The change is planned again
against the file as it is at the write, and written only if it is still the change the bar showed (same row, same
values before and after); otherwise nothing is saved and the bar says the row changed. The folder core checks the
save as any other of the member's: the table's `[write]` rule, the rows against the definition, the claim rule.
An agent that must act on a member's change sets a `file_change` routine on the table's `rows.csv`
(`manage_routine`), which `save_app` tells it; otherwise it sees the rows at its next read.

### A note to the app's owner (`tell`, 13 November 2026)

Jonas, 13 November 2026: "you can't act very much inside of the interfaces". A member could look at an app, answer an
agent's question and change a row from it, but start nothing: to ask for something about what they saw, they went
back to the chat and said there what they had seen. With `tell` the member points at a thing in the app and says
something about it to the agent that owns the app ("get a quote from this one").

**`tell({about, at, text})`.** Any app may ask: `writes` has no word for it. The page chooses neither who hears the
note nor the words that go, nothing in the company changes, and the agent that writes the page writes its manifest
too, so a word there would be no barrier (H3 (1), §6, limits what a page may choose to change; here it chooses
nothing); `save_app`'s `writes` text is near its 4 KiB cap besides.
- `about`: what the note is about, 1 to 60 characters once made one line. `@`, `«` and `»` are taken out, so it names
  nobody and quotes nothing, and so are control marks and the marks that turn a text's direction; spaces and line
  breaks become one space (`appNoteAbout`, `cloud/wall-reply.ts`).
- `at`: optional, the thing's id in the app's data, `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`.
- `text`: optional, a draft of the member's words, at most 280 characters.

The frame document sends the three as plain values (`at` and `text` as text, or null) and nothing else of the object
the page passed. A note shaped otherwise is refused before any bar, in English, as the bridge's other refusals.

**Who hears it.** The agent that owns the app (the manifest's `owner`) while it is at work, in its shared thread. An
app with no owner, or whose owner is no longer at work: the Co-Founder, in its thread, and the bar names the
Co-Founder. With no Co-Founder either, or for a member who may not write in the company (a viewer, or access lost),
the page is refused before any bar ("Nobody can take a note from this app: …", "The member may not send messages in
this company").

**The bar** is the bar of every request, with one field. Its title is "This app wants to send your note to
<agent>", beside the agent's figure; its lines are About (the app's name and what the page says the note is about,
each a value) and Your note: a text field of Qorpera's, outside the frame, which starts with the page's draft and
which the member may change. "Send note" is off while the field is empty, and what goes is what the field holds when
the member presses it. The page's `about` is a value on the bar and never part of its sentences. The focus goes to
the field (§6: the exception, and why it is safe); "Not now" keeps its place, and Escape is "Not now". One request at
a time and the three "Not now" hold as for every request.

**The message** is the member's own, in that agent's thread, sent the way the composer sends one (`sendPrompt`: the
member's write right, the open conversation, the member's own model account for the thread, chosen as the thread
chooses it), so the agent's run starts as for any message:

```
> app:<name>#<at> · <about>

<the member's words>
```

without `#<at>` when the page named no thing. The web sends a member's message only while its thread is on screen
(the input writer's check of the route, `app/application.ts`); for a note on its way the member's press on the bar,
which named the agent, stands for that (`CompanyController.sendNote`), and every other check of a send holds. The
Mailbox's notes, and Generate icon in the apps drawer (`requestAppIcons`), met the same check before and so never
went from where the member pressed: they failed with "Company access is unavailable." They go now too. The line is
plain text, as a wall answer's quoted question was
(`cloud/wall-reply.ts`), so nothing in the cloud changes. The thread draws it as the app's card, standing above the
member's words as an agent's message has its cards, with what the note is about as the card's line; once the
company's apps are read the card has the app's own name, emblem and colour, and a press on it opens the app.

**When it waits.** A note goes from the bar only into a thread with nothing drafted in it (the member's draft in this
browser, and the room's shared draft as it is now). When something is drafted there, or when the send does not go (no
model account for the member, or the cloud refused it), the note waits in that thread's composer. Its first line is
never in the composer: the draft answers it (`answering`), and the composer shows
it above the field as the app (its emblem in its colour, its name) and what the note is about, with a way to leave it
out. Where the draft is saved and shared (the room's shared draft, `app/room-drafts.ts`), the line is the text's first
line (`> app:…`, then an empty line), put there and taken out again by the company's room hooks (`app/company.ts`), so
a reload, another tab or another member's client has it with the words, and leaving the app out takes it out of the
shared text too; the composer's caret and changes are counted after it, as the merge's own edit cut at the line
(`editAfter`), so a quote another tab changes stays whole, also under a send on its way. The note's words go after what is drafted
there, so the earlier draft and the note are one message under one card, which the send opens with the line
(`withReply`). Before anything is read or added, the thread's draft is taken from the room as it is now
(`RoomDrafts.follow`), also where no view of it is open. The bar then says "Your note waits in <agent>'s thread" with
Open, which goes there, and stays until the member opens or closes it.

One message answers one line: a thread whose draft answers something already (another app's note, here or in the
room's text; a line that names no app), or whose message is on its way or waits to be tried again, takes no note. The note
then stays on the bar with its words, a line says "<agent>'s thread has a message started. Send or clear it there,
then send this note." with Open, and Send tries again. It is kept for the app by the company, with the member's words
as they change them (`HeldNote`), so following Open loses nothing: whenever the app's page is shown again, or its
manifest changes under a page that stays, the note is on its bar with those words. While a send of it is on its way it
is kept as that and shows on no bar, so a member who leaves and comes back meanwhile can't send it twice; held again,
it is back on the bar of the app's page on screen, whichever page sent it; once it went or waits in the thread it is
let go, if it is still the note that was sent. The member saying not now to it lets it go too. **An app has at most
one note**, from the moment the member's words exist until they went, wait in the thread, or the member said not now.
While it has one, the page's next `tell` is refused before any bar, "A note from this app is on its way: ask again in
a moment" while it goes and "An earlier note from this app is still waiting above the page: send it or say not now
first" otherwise, and the kept note is on the bar again where no bar shows it. A kept note whose send fails (its
thread can't be opened) is still the app's note: its bar stays, says why, and keeps the member's words.

The Mailbox's notes to agents go through the same code (`CompanyMail.tell` is lifted into `app/tell-agent.ts`); they
have no line of their own, so they wait after a line being answered rather than be sent under it.

A line that names no app, being answered, is this browser's alone (`answering`, not in the shared text). Only the
agents' wall set one (its questions' Answer), and the web shows no wall since 14 November 2026 (Jonas: "rather drop the
wall - it's the wrong medium for activity"), so nothing sets one now; a message that opens with such a quoted line is
still drawn with the line above the member's words.

**The page's answer.** `{sent: true}` when the note went, `{sent: false, waiting: true}` when it waits in the
agent's thread; while the note stays on the bar the page waits on. The promise rejects with a plain reason when the
member says not now, when another request waits, when the app still has a note (on its way, or kept for the
member), when the app was told not now three times, when the page or its manifest went away first, and when the note
cannot be sent (the thread cannot be opened, or its agent left meanwhile). The page learns nothing of the thread.

**Budget.** A note costs five calls of the app's budget, as a change does. After a note was sent from an app (or left
waiting in the thread by the member's press), the app's next `tell` is refused for ten seconds ("A note was sent from
this app a moment ago: ask again in a few seconds"), kept per app per tab, across Reloads, as the budget is. The pause
is counted from when the note went or was left waiting, not from when the bar heard of it: a member who leaves the app
while the note goes (the bar is put away) finds the pause on coming back. A note kept on the bar starts no pause.

Threat model: the app's author is an agent of the company, which already reads the company's own files and has the
internet (through the logged agent exit). The frame keeps the app from the member's session (cookies, storage, tokens,
this app's DOM), from acting as the member (a page only asks; the member's yes is given outside the frame), and from
reaching what the platform keeps out of it.
Two things the frame adds that the agent doesn't have are guarded: what the member types into the page (beside the
chat, Qorpera says whose page it is and that it never asks for passwords there; an app's own page has said neither
since it lost its header on 10 November 2026, and a concept neither since 13 November 2026, §6 H2), and the member's
authority (reads only of the allowed sources; a change only of what `writes` names, one at a time, shown in full and allowed by
the member each time; a note only in the member's own words, to the app's owner or the Co-Founder). What a
prompt-injected agent can still do is ask: a member who allows a bar without reading it makes that change, as theirs,
to an answer the agent itself asked for or to a row of a table the app names, or sends the app's owner the page's
draft and its 60-character `about` (§6); it can never be a file, a member's or agent's place, a setting, or anything
outside those. A leak through a side channel leaves from the member's browser, unlogged.
Links add one way out: a page can put what it read, or what the member typed into it, into a web address, as an
agent can in a message. It leaves only after the member has seen the whole address on Qorpera's bar and pressed Open
there (the founder's word, 13 November 2026: "Show the address first"), in a tab of the member's own browser, unlogged
like the side channels.

## 6. Security review

An independent Opus review of this design and the frame ran on 5 November 2026 before step 4 was built
(`~/work/interface-apps-security-review-r1.md`). Its findings and what was done:

| Finding | Done |
| --- | --- |
| H1 the bridge must not ride on window messages | one port per frame, handed over once; second "ready" or third load tears it down |
| H2 phishing inside the panel | host-drawn header: app name, "Made by <agent>", "Qorpera never asks for passwords here". **Since 10 November 2026 an app's own page has no header** (Jonas's decision, §4), so the line stands beside the chat only. **Removed from the Concepts viewer on 13 November 2026 on the founder's word**: its side panel had carried the line in a strip of its own (#1539 round 1), and that strip is gone (§4). Who made a concept still stands in its row. What else guards a member is as it was, and it is this much: a change to the company and a note to an agent go only through Qorpera's own bar, with the member's yes, and a page has no network of its own and submits no form (the frame is sandboxed with scripts only, `default-src 'none'`, `form-action 'none'`). An `http:` or `https:` link the member clicks opens only after the member has seen its whole address on Qorpera's bar and pressed Open (the founder's word, 13 November 2026: "Show the address first"): one with a name or password in it is refused before any bar, and what a page puts into the path or query of one, what the member typed among it, is seen before it leaves (§4 "Links", §5's threat model). The side channels §5 names stand. Nothing replaces the line on a concept, and a detector for password fields would be defeated by a hostile page, so with the line gone nothing on screen tells a member that a sign-in a concept draws is not Qorpera's. On an app's own page nothing replaces it yet: a page that draws a sign-in there has the rail beside it and nothing else of Qorpera's. A guard that costs no header is a follow-up (§7): the line shown above the page only while the page has a password field on screen |
| H3 the Allow bar is too weak | no writes until step 5, which builds the review's gate: see the table below |
| M1 threat model | corrected above; side channels are best effort |
| M2 reads: allow list, path checks, never-in-bridge | platform folders refused, host path checks, the list above |
| M3 runtime prefetch hints can't be removed | dropped the plan; said so |
| M4 budgets survive Reload; request size; host-side limits | budget per app per tab; 4 KiB params; 64 files / 4 MiB enforced when the host reads |
| L1 path resolution, fixed data: types | URL-style resolution inside the app folder, escapes refused, type by extension |
| L2 freeze `qorpera` | frozen, with the frame document's own copies of the port methods |

A second independent Opus review read the built code (`~/work/interface-apps-security-review-r2.md`):

| Finding | Done |
| --- | --- |
| H-1 any agent could rewrite an app while the header names its owner | an app's files are its owner's: `company_write`/`company_edit` under another's app refuse (`APP_NOT_YOURS`), `owner` never changes (`APP_OWNER_FIXED`), and `save_app` on another's app is delegation (its prepare reads the owner before the review) |
| M-1 an app could be posted by moving a folder or manifest into `apps/` | `company_move` refuses a folder or an `app.toml` moved into `apps/` from elsewhere (`APP_MOVE_REFUSED`); a file moved into another's app is `APP_NOT_YOURS` |
| M-2 the panel's debounce never fired in a busy company | throttled: at most once each 1.5 s |
| M-3 load on the database | the panel uses the reader's just-read apps after a change; `todos` costs ten calls |
| M-4 the page could reach the port through a redefined `MessageEvent.data` | the frame document reads it with the browser's own getter |
| L-1 the load count depended on timing | the page is handed over only after "ready" and the frame's first load |
| L-2 a page could flood the tab with refused calls | after 300 refused calls the frame is stopped |

Step 5 builds the writes behind r1's gate. Each point of H3, and L3, as built (§5 "Changes"):

| The review asked | Built |
| --- | --- |
| H3 (1) a manifest key `writes`; a write to anything else is refused without a bar | `writes = ["answers", "table:<name>"]`, parsed by `parseAppWrites`; the bridge refuses before it reads |
| H3 (2) the bar shows the table, each row's key and the changed values | one row a request; the table, the key and every cell before and after, in full (a cell is at most 500 characters), so there is no "show all" to open; a value's line breaks are shown as a mark and its text direction is kept to itself, so a value draws no lines of its own on the bar |
| H3 (3) every request its own bar, no "always allow" | so; nothing is remembered between requests |
| H3 (4) Allow disabled about a second, not the default, no Enter from the frame, a fresh press, focus moved to the bar | the yes button wakes after 1 s on a visible screen and takes only a press that began on it after that; "Not now" takes the focus (a note's field takes it instead: see step 9 below); a held key does not press "Not now" either |
| H3 (5) one pending bar; three "Not now" and no more bars until Reload | so, counted in a row (a yes starts it again) |
| H3 (6) the bar above the frame, pushing it down | so, in every placement |
| H2's last line: refuse long values unless shown in full | every value is shown in full |
| L3 ignore the page's Escape while a bar is open | `AppFrame.holdEscape` |
| (added) the row may change while the bar is open | the change is planned again at the write and saved only if it is the one shown |
| (added, review of the build) the manifest or the page may change while a request is checked or waits | each frame and each version of the manifest has its own bridge; a request of an earlier one is put away or refused before the bar |
| (added, review of the build) a request may be longer than the screen | the bar's lines scroll inside it; both buttons stay in reach |
| (added) a page must not move people or agents | `needs_yes`, `member`, `agent` and `agents` columns and the table `areas` are refused |

Step 6, links and the base style (10 November 2026), was read by the pull request's exact-head review, not by a
security review of its own:

| Concern | Done |
| --- | --- |
| a page could move the member without a click | only a click the member made is sent (`isTrusted`), by the frame document, on the port the page cannot reach; the `qorpera` object has no call for it |
| an address is anything a page can write | checked on the host (`appLink`): `app:` only with an app's name; `folder:` only a path a read may name (relative, no `..`, no `%`, no backslash, no platform folder); `http(s)` as a link in a message; everything else refused |
| a flood of links | each is one call of the app's budget (120 a minute); refused ones count toward the 300 that stop the frame |
| a link as a probe (is this file there?) | nothing is read for a link; the answer is the same either way, and the frame document drops it |
| the frame leaving its page | every click on a link that the page left alone is stopped, whoever made it; `#…` stays in the page, and `javascript:` is left to the browser as before |
| the page's own handlers deciding what the frame hears | the link is noted before any handler of the page (on the click's way down, listened for before the page is written) and the click is settled behind them, by the browser's own account of whether a handler took it: at the window, or on the node where a handler stops it, by listeners put last at every click; where none can follow (a stop at once, and two places on the way down) when the stopping handler returns. Nothing the page reads or says of a click is changed. Named limits in §4 |
| a new tab reaching back into the app | opened with its opener cut before it loads, and no referrer (the site sends none); the offered line is `rel="noopener noreferrer"` |
| what a page read, carried out in an address | only after the member has seen the whole address on Qorpera's bar and pressed Open (13 November 2026: "Show the address first"); accepted, in the threat model above |
| the company's colours as a way to inject styles | only hex colours parsed from `brand.toml` reach the stylesheet; every other byte of it is fixed |
| the base style overriding an app | one cascade layer under the page's own styles, no `!important` |
| a dark base under an app that assumed a light page | dark only for a page that declares `color-scheme` light and dark |

Step 9, a note to the app's owner (`tell`, 13 November 2026, §5), is the first request that sends words rather than
changing a value, and the first that any app may make. What a page can and cannot make happen with it:

| Concern | Done |
| --- | --- |
| a page speaking as the member | the words that go are the member's: typed in a field of Qorpera's outside the frame, which the page can neither read nor fill after the bar opens; the page gives only a draft of at most 280 characters, shown in full in that field. "Send note" is off while the field is empty, and what goes is what the field holds at the press |
| a page choosing who hears it | never a parameter: the manifest's `owner` while it is at work, else the Co-Founder, whom the bar names. `about` names nobody (`@` taken out); the member's own words may, as anywhere they write |
| a page writing the bar's sentences | `about` is a value on the bar (the app's name, then the page's words), never part of a sentence; one line of at most 60 characters, with no `@`, `«`, `»`, control or direction marks, its direction kept to itself |
| a page sending without the member | there is no send without the bar's press: the same gate as a change (1 s wake, a press begun after it, one bar at a time, three "Not now" and quiet until Reload) |
| a page sending over and over | five calls of the budget each, and after a note went, the same app's next note is refused for ten seconds |
| a page learning about the thread | the answer is `{sent}` and `waiting` only: no message id, no text, nothing of the thread or the agent beyond the name the bar showed the member |
| a page changing something | nothing in the company changes: the note is a message in a thread the member could write in anyway, under the same send (write right, open conversation, the member's own model account) |
| a send from a page that is not the thread | the input writer's check that the thread is on screen lets a note (or Generate icon's ask) through only for its own conversation and only while it is on its way (`sendNote`, started by the member's press); the company still open, the same member, the write right, the open conversation and its room are checked as for any send |
| a page's line standing apart from the words it heads | a waiting note's line is its shared draft's first line, so it is saved, shared and restored with the words (a reload, another tab, another member's client); every check that a draft answers something reads the room's text as well as this browser's, so a second note never joins a first under its own line |
| a page losing the member's words | a note its thread can't take stays on the bar and is kept for the app, with the member's words as they change them, until it went or they said not now; the bar shows it again whenever the app's page is shown or a new bridge serves it; a send of it on its way shows on no bar (no second Send), and its end lets go only the entry it sent; an app has at most one note until it went, waits in the thread or the member let it go: a new ask meanwhile is refused and the kept note shown, and a kept note whose send fails keeps its bar, its reason and its words |
| quoted words losing their fence under the hidden line | the composer and a send on its way hear the merge's own quote-whole edit, cut at the line; a re-made edit is used only where the line changed across a kept span |
| a page faking quoted outside content | `«` and `»` are taken out of `about`, and a note carries no quote records, so nothing of it is ever drawn or sent as a quote (`cloud/quotes.ts`) |

**The focus exception.** H3 (4) put the focus on "Not now", so that no key could fall on the yes button. A note's bar
puts it in its field instead, at the end of the page's draft, because a note is something the member writes: with
"Not now" focused, every note would start with a press into the field, and that press is one more a page could try to
time. The field keeps H3 (4)'s point, that yes is never the default:
- the field cannot send: no key in it reaches "Send note", Enter in it is a new line, and the bar has no form;
- "Send note" wakes one second after the bar is on a visible screen and takes only a press (pointer, or Enter or
  Space on the button itself) that began after it woke, as on every bar;
- a key held down since before the bar came in types nothing in the field (its repeats are dropped until that key is
  pressed afresh there), so a key the member was holding in the page does not fill or empty the field;
- "Not now" keeps its place before "Send note", and Escape on the bar is "Not now" (a held Escape is not);
- the page's Escape is still not passed on while the bar is open (L3).
The page can still place a draft the member may send without reading. That is the draft's purpose, it is shown in
full where it will be sent from, and it goes only to the app's own agent.

**The remaining risk, accepted.** The 60-character `about` goes in the member's message, on its first line, as the
member's words: the agent reads it as theirs, and so does the action review, which leaves out quoted words but not
this line (`cloud-action-review.ts`). So a page can put up to 60 characters of its own into a message the member
sends. That is the standing a wall headline had: an agent wrote it, and a member's answer carried it as a
quoted first line (`cloud/wall-reply.ts`). It is accepted because the member sees it on the bar before the press, it is
one line that names nobody and quotes nothing, and it reaches only the agent that owns the app, which wrote the page,
or the Co-Founder. The upgrade path, if it should be fenced: a quote source `app` (its ref the app's name and the
thing's id), so that the agent and the review read the line as outside content, as they read an email's words. That
costs a migration (the source check of `20260928459100`) and web changes (`REFS` in `cloud/quotes.ts`, and the
thread's "Quoted from an email" title).

## 7. Steps

1. Format + parser (`cloud-client/interface-apps.ts`) and the page assembler (web `app/interface-apps.ts`).
2. Agent tools `save_app`, `post_app`, the `company_write`/`company_edit` checks, prompt guidance, re-pinned prompt
   hashes, migration 20260930572000 (the two tools in the observation list).
3. Web: side panel (`app/views/app-panel.ts`), chat card (`ui/markdown.ts`), `folder:` `.html` in the panel, posted
   apps in the drawer.
4. The bridge, read only (`ui/app-frame.ts`, `public/page-preview/index.html`, `AppBridge`).
5. Changes the member allows (10 November 2026): the manifest's `writes` and the `questions` source
   (`cloud-client/interface-apps.ts`), `save_app`'s `writes` with how to use it on the schema field, the requests'
   checks and saves (web `app/app-actions.ts`), the bar (`app/views/app-ask-bar.ts`), and the three calls and
   `questions` in the bridge and the frame document. No migration and no node change: both saves are ones a member
   already makes.
6. Links through the bridge (§4) and the base style (§2), with `save_app` saying both (10 November 2026).
7. The explainer kit (§3a, 10 November 2026): the manifest's `kit` (`cloud-client/interface-apps.ts`), the engine
   (`packages/runtime/kits/explainer/engine.js`), the page and the clips' list (`cloud-app-kit-explainer.ts`), and
   `save_app` writing both with how to make a video on the schema field. No migration, no node change and no change
   to the web's own code: an explainer is put together as any app. Next: the tool that records the clips.
8. An app's own icons (§2 "Icons", 12 November 2026): the format and the 24 emblems (`cloud-client/app-icons.ts`,
   `interfaces.ts`), `save_app`'s checks and how to draw them on `files`, and the web's Icon and colour and Generate
   icon in the drawer.
9. A note to the app's owner (§5 "A note to the app's owner", 13 November 2026), the web's part: `qorpera.tell` in
   the frame document, `prepareTell` and the request kind `tell` (`app/app-actions.ts`), the bridge's `tell` with its
   cost and its ten seconds (`app/interface-apps.ts`), the bar's field (`app/views/app-ask-bar.ts`), who hears it and
   the send, lifted with the Mailbox's from `CompanyMail.tell` into `app/tell-agent.ts` with the wall-answer check,
   `CompanyController.sendNote` so that a note (and Generate icon's ask) goes from where the member sent it, a waiting
   note's first line as what its draft answers, shown above the composer as the app, and that line drawn as the app's
   card in the thread (`views/conversation.ts`). No migration and no node change. Next, in a change of its own that rides a runtime cut: the prompt line that tells an agent what the first
   line means (sent from that app's page, about that thing), and the kits' buttons and guides that ask for a note.
10. The data kits (§3b, 13 November 2026): four more names for the manifest's `kit`
    (`cloud-client/interface-apps.ts`), the engines and their guides (`packages/runtime/kits/<kit>/`),
    the page, the pictures it names and the read of the data (`cloud-app-kits.ts`), `save_app` writing engine and page
    with the guides on the schema field (where no model received them: step 11), and the agents' instructions: an app is an object, a model, an app or a
    video, one app a thing, never a document or the state of someone's work (hire overlay v16). No migration, no node
    change and no change to the web's own code.
11. Guides an agent receives (§3d, 14 November 2026): `app_guide`, the guides' text in `cloud-app-guides.ts`,
    `save_app`'s fields a line each and its rule that a kit's file needs its guide read, and a model of no input
    refused. One migration (20260930762000: the tool's name in the observations' list); no node change and no change
    to the web.

Follow-ups: the password line on an app's own page without a header (§6 H2: shown above the page only while the page
has a password field on screen, reported by the frame document); a member marks a human task done from an app (the asking agent's wake is built, but the object gateway
holds every member save under `QorperaOS/human-tasks/` until Qorpera has its own task screen, and a task that asks
for proof cannot be finished by one tap); a typed answer; removing a row; the folder-core rule that parks a
machine's change of `posted` (§3's known gap; the same gap lets a machine write `writes`, which gains it nothing
without the member's yes on the bar); browser-test variants for the frame (self-navigation to
`about:`/`javascript:`, speculation rules, a page that reloads itself) in `scripts/test-web-page-frame-browser.mjs`.
From step 6: links from a Company File page beside a chat; `mailto:` links; the brand's fonts, and its logo as part of
the base style; a check of `brand.toml` when an agent writes it, and its name in the Branding agent's job (the hire
overlay says only "colours" today); a Chromium on the test machines, so `scripts/test-web-app-frame-browser.mjs` (real
clicks in a real frame) runs with `changed`.
