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

A small web page an agent makes to show members something: a result, a test, a prototype, a dashboard. It lives in
the Company File as ordinary files. A member opens it as a page of its own, `#/c/<profileId>/a/<name>`, from a card
in the agent's message or from the apps drawer once it is posted (Jonas, 8 November 2026: an app is a whole product
prototype, so it gets the page, not a side panel).

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
| `emblem` | one of the interface emblems | `board` | the drawer icon |
| `colour` | one of the agent colours | none | the emblem's colour |
| `entry` | relative path to an `.html` file | `index.html` | the page that opens |
| `owner` | agent handle | the creating agent | who made it; the app's header names it |
| `posted` | true or false | false | shown in every member's apps drawer |
| `reads` | list of `files`, `tables`, `todos`, `agents` | `[]` | the live sources the app may read (§5) |
| `concept` | true or false | false | a concept of the company's product: it opens in the Concepts viewer (`#/c/<id>/concepts/<name>`, full screen, a side panel to pick a concept), and the drawer shows one Concepts entry for all of them, posted or not |
| `cover` | relative path to a `.png`, `.jpg` or `.webp` in the app's folder | none | the picture of a concept in the viewer's side panel; without one, its emblem |

Unknown keys, bad types and bad values are problems; an app whose manifest has problems is not shown (its card says
so and links the file).

**Files.** Kinds: `.html .htm .css .js .mjs .json .txt .md .csv .svg .png .jpg .jpeg .gif .webp`. Each file at most
512 KiB (the write tools' bound), at most 64 files, at most 4 MiB in all. Other kinds may sit in the folder (an agent's
notes) but are never loaded into the page.
**Videos** (Jonas, 7 November 2026: demo videos of design ideas): `.mp4 .webm`, each at most 12 MiB and 48 MiB in all, on
top of the limits above. An agent writes them from a machine or moves them in; no text tool writes one.

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

- `save_app {name, operationKey, manifest?, files[{path, text}], remove?}` checks the name, the manifest, each file's
  kind and size and the totals before anything is written. On create it sets `owner` to the agent and `posted = false`;
  later it never changes `posted` or `owner`. A changed file that another call changed meanwhile is a conflict.
  When the call wrote the entry page, its answer carries `look`: what a quick read of that page found (links that
  open nothing, §4, the first three named; three or more `<details>`; more than 500 words; more than 150 words with
  no picture, chart, map or diagram). It is advice, never a refusal: the agent fixes it unless it does not fit the
  page. The tool's description also says what makes a page worth opening: what the first screen answers, what to show
  instead of write, which links open, the base style and phone width. How a page reads live data (§5) is said on the
  manifest's `reads`, and the base style's variables and the company's colours (§2) on `files`, both in the tool's
  schema, because a tool's own description holds 4096 bytes.
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

## 4. Web

- **App page.** `#/c/<profileId>/a/<name>` shows the app in the main area, at full width and height, as Mailbox and
  Bank show (`AppPanel` placed as a page). Slim header: the way back (to the company's last open conversation, else
  the company), emblem, title, "Made by <owner> · Qorpera never asks for passwords here", Reload, Show in Storage. A
  deep link or reload opens the company, waits for its first read, then the app; an app that is gone says "This app
  isn't in the company anymore."
- **Side panel.** PR #1430's agent sheet, generalised: `AppPanel` placed beside the conversation inside
  `.thread-body` (not over it, no dim, not modal), the conversation stays mounted and usable. It shows `folder:`
  links to `.html` files (a plain page, no manifest), never an app. Header as the app page's, with Close instead of
  the way back; Escape (in the panel or in the page) closes it. At phone width it covers the thread, with Close.
- **Chat card.** A link `app:<name>` in an agent's message draws as a card in the bubble (emblem, title, about,
  "App · opens on its own page"), which opens the app's page; once the company's apps are read, the card shows the
  app's own emblem and line. Wall posters and choice cards draw the same card.
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
  - `http:` and `https:`: a new tab, checked as a link in a message is (no name or password in the address), with no
    way back to the app and no referrer. The member's click was in the frame, so a browser may stop the tab as a
    pop-up. Then Qorpera offers the link in a line of its own under the app's header, named by its real host and path,
    and the member's click on that line opens it.

  Anything else opens nothing: a relative address (an app is one page, §2), `mailto:`, any other scheme, a platform
  folder. Three things are not touched: a jump inside the page (`#…`), any click the page's handlers took for
  themselves (`preventDefault`), and a `javascript:` address, which is left to the browser as before (Chromium runs
  none in this frame, so a page uses a button or a click handler instead). Only a click the member made is sent
  (`isTrusted`); a click a script made is stopped and leads nowhere. A Company File page beside a chat opens no links:
  its links are stopped too, and the host refuses them. In Storage's own preview a page is as before.

  How the frame document hears a click does not depend on what the page's own handlers do with it:
  - The link is noted on the click's way down, before any handler of the page has it: at the window, where the frame
    document listens before the page is written, and at the root of every shadow tree, where a closed tree's own nodes
    still show. It is the innermost link on the click's path, also one around a slot that the clicked node sits in.
  - The click is settled once the page's handlers have had it, with the link's address as it is then. A click a
    handler took (`preventDefault`, or a handler that returns false) is the page's. The listener that settles it is
    put last at the window again at every click, so a handler the page added later still comes before it.
  - A handler that stops the click from travelling on (`stopPropagation`, `stopImmediatePropagation`, `cancelBubble`)
    does not keep it from being settled: such a click is settled when that handler returns, which for a real click
    is before the browser acts on it.
  - A click a script made is stopped on its way down, whether or not it travels up to the window.

  One limit: a link inside a closed shadow tree is not seen when a handler of the page stops the click on its way
  down, before the click reaches that tree. Such a click does what it did before; the same holds for a page that
  puts its own function in place of `Event.prototype.stopPropagation`. A frame that leaves its page is ended by the
  host as before (§5), so this is a dead link, not a way out.

## 5. Live data: the bridge (step 4)

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
qorpera.onChange(() => …)                     // the company's folder changed: read again
```

Wire, on the port: page → host `{type: "qorpera-app-call", id, method, params}`; host → page
`{type: "qorpera-app-answer", id, ok, value | error}` and `{type: "qorpera-app-change"}`. A link the member clicked
(§4) goes the same way, as the call `open` with `params: {href}`. The frame document alone sends it: the `qorpera`
object has no call for it, so a page's script cannot.

Rules:
- **Read only in v1.** There is no write call. Writes with the member's authority need the gate the security review
  described (a `writes` key, a host-drawn bar showing each row, a delayed Allow, one bar at a time); that is a
  follow-up. Today an app that should change rows asks its agent, in the chat.
- **Allowed sources** are the manifest's `reads`; a method outside them is refused. The app's own folder is always
  readable. With `files`, any company path outside the platform's folders: never `QorperaOS/`, `hooks/` (received
  mail), `bank/`, `digital-post/`, `members/` or `code/`. Paths are checked on the host: relative, no `..`, no `%`,
  no backslash. Tables come only through `table`.
- **Never into the bridge:** the member's token, email, id or session, this app's own state, other members' settings,
  vault or login data, mail, billing.
- **The viewer's own authority**: every read is the member's own folder read.
- **Bounds**: at most 8 calls in flight and 120 a minute per app in a tab (kept across Reloads; `todos` counts as
  ten, since it reads every agent's todos), a call's params at most 4 KiB, an answer at most 1 MiB. A call over the
  budget is refused ("Too many calls") and spends nothing. Change notices come up to once a second, so a page that
  drew on every one would spend a minute's budget in seconds. `save_app` therefore tells agents the pace: draw when
  the page opens, after a change draw again once and no sooner than ten seconds after the last draw, each source
  called once per draw, and after a failed read keep what was shown and read again ten seconds later.
- **Links are calls**: an `open` is checked on the host (`appLink`, with the path rules of a read) and spends one call
  of the budget; a refused one counts with the refused calls, and 300 of those stop the frame. It needs nothing in
  `reads`, because nothing is read for it. The answer is the same whether or not what the link names is there, and the
  frame document drops it, so a page learns nothing from a link.
- **No requests of its own**: the frame keeps `sandbox="allow-scripts"`, no origin, the frame document's policy
  (`default-src 'none'`, no `connect-src`), and this app's `frame-src 'self'`. Some side channels remain (a
  `dns-prefetch`/`preconnect` link the page's script adds is acted on before anything can take it out): blocking them is
  best effort, not a boundary.

Threat model: the app's author is an agent of the company, which already reads the company's own files and has the
internet (through the logged agent exit). The frame keeps the app from the member's session (cookies, storage, tokens,
this app's DOM), from acting as the member (no writes in v1), and from reaching what the platform keeps out of it.
Two things the frame adds that the agent doesn't have are guarded: what the member types into the page (the host-drawn
header always says whose app it is and that Qorpera never asks for passwords there), and the member's authority (read
only, and only the allowed sources). A leak through a side channel leaves from the member's browser, unlogged.
Links add one way out: a page can put what it read into a web address, as an agent can in a message. It leaves only
when the member clicks it, in a tab of the member's own browser, unlogged like the side channels.

## 6. Security review

An independent Opus review of this design and the frame ran on 5 November 2026 before step 4 was built
(`~/work/interface-apps-security-review-r1.md`). Its findings and what was done:

| Finding | Done |
| --- | --- |
| H1 the bridge must not ride on window messages | one port per frame, handed over once; second "ready" or third load tears it down |
| H2 phishing inside the panel | host-drawn header: app name, "Made by <agent>", "Qorpera never asks for passwords here" |
| H3 the Allow bar is too weak | no writes in v1; the review's gate is the design for the follow-up |
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

Links and the base style (10 November 2026) were read by the pull request's exact-head review, not by a security review
of their own:

| Concern | Done |
| --- | --- |
| a page could move the member without a click | only a click the member made is sent (`isTrusted`), by the frame document, on the port the page cannot reach; the `qorpera` object has no call for it |
| an address is anything a page can write | checked on the host (`appLink`): `app:` only with an app's name; `folder:` only a path a read may name (relative, no `..`, no `%`, no backslash, no platform folder); `http(s)` as a link in a message; everything else refused |
| a flood of links | each is one call of the app's budget (120 a minute); refused ones count toward the 300 that stop the frame |
| a link as a probe (is this file there?) | nothing is read for a link; the answer is the same either way, and the frame document drops it |
| the frame leaving its page | every click on a link that the page left alone is stopped, whoever made it; `#…` stays in the page, and `javascript:` is left to the browser as before |
| the page's own handlers deciding what the frame hears | the link is noted before any handler of the page (on the click's way down, listened for before the page is written) and settled after them (a listener put last at every click); a click a handler stops from travelling on is settled when that handler returns; one named limit, in §4 |
| a new tab reaching back into the app | opened with its opener cut before it loads, and no referrer (the site sends none); the offered line is `rel="noopener noreferrer"` |
| what a page read, carried out in an address | as a link in a message: only on the member's click; accepted, in the threat model above |
| the company's colours as a way to inject styles | only hex colours parsed from `brand.toml` reach the stylesheet; every other byte of it is fixed |
| the base style overriding an app | one cascade layer under the page's own styles, no `!important` |
| a dark base under an app that assumed a light page | dark only for a page that declares `color-scheme` light and dark |

## 7. Steps

1. Format + parser (`cloud-client/interface-apps.ts`) and the page assembler (web `app/interface-apps.ts`).
2. Agent tools `save_app`, `post_app`, the `company_write`/`company_edit` checks, prompt guidance, re-pinned prompt
   hashes, migration 20260930572000 (the two tools in the observation list).
3. Web: side panel (`app/views/app-panel.ts`), chat card (`ui/markdown.ts`), `folder:` `.html` in the panel, posted
   apps in the drawer.
4. The bridge, read only (`ui/app-frame.ts`, `public/page-preview/index.html`, `AppBridge`).
5. Links through the bridge (§4) and the base style (§2), with `save_app` saying both (10 November 2026).

Follow-ups: row writes behind the review's gate (H3); the folder-core rule that parks a machine's change of `posted`
(§3's known gap); browser-test variants for the frame (self-navigation to `about:`/`javascript:`, speculation rules,
a page that reloads itself) in `scripts/test-web-page-frame-browser.mjs`. From step 5: links from a Company File page
beside a chat; `mailto:` links; the brand's fonts, and its logo as part of the base style; a check of `brand.toml` when
an agent writes it, and its name in the Branding agent's job (the hire overlay says only "colours" today); a Chromium on
the test machines, so `scripts/test-web-app-frame-browser.mjs` (real clicks in a real frame) runs with `changed`.
