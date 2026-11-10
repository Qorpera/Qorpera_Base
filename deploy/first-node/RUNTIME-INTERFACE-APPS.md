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
| `reads` | list of `files`, `tables`, `todos`, `agents`, `questions` | `[]` | the live sources the app may read (§5) |
| `writes` | list of `answers` and `table:<name>`, at most 16 | `[]` | what the app may ask a member to change (§5 "Changes"); `<name>` is a company table's folder name, never `areas` |
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

## 3. Agent tools

| Tool | What it does | Review class |
| --- | --- | --- |
| `save_app` | creates an app (its folder, `app.toml`, files) or changes its manifest and files, in one call | `internal`: applies at once |
| `post_app` | sets `posted` (shows it in every member's drawer, or takes it away) | `internal` for its own app (Jonas, 7 November 2026); `delegation` for another agent's or a member's |

- `save_app {name, operationKey, manifest?, files[{path, text}], remove?}` checks the name, the manifest, each file's
  kind and size and the totals before anything is written. On create it sets `owner` to the agent and `posted = false`;
  later it never changes `posted` or `owner`. A changed file that another call changed meanwhile is a conflict.
  When the call wrote the entry page, its answer carries `look`: what a quick read of that page found (links, which
  do not open inside an app; three or more `<details>`; more than 500 words; more than 150 words with no picture,
  chart, map or diagram). It is advice, never a refusal: the agent fixes it unless it does not fit the page. The
  tool's description also says what makes a page worth opening: what the first screen answers, what to show instead
  of write, the company's brand and phone width. How a page reads live data (§5) is said on the manifest's `reads`
  in the tool's schema, and how it lets a member act (§5 "Changes") on the manifest's `writes`, because a tool's own
  description holds 4096 bytes. `writes` is checked as `reads` is, by `save_app` and by `company_write` /
  `company_edit` of an `app.toml`; a manifest given without it keeps what the app has.
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
  Bank show (`AppPanel` placed as a page). It has **no header** (Jonas, 10 November 2026, on the page's slim header:
  "I would remove any headers as they add nothing but bad visual design"): the app is the whole page, as a concept is
  the whole stage. The rail beside it shows which app is open and leads everywhere else (at phone width, the top bar's
  menu); opening the app again reads it afresh, as Reload did. Qorpera draws only what is needed when it is needed,
  outside the frame: the bar of a request (§5 "Changes") above the page, and the questions dock over its corner. A
  deep link or reload opens the company, waits for its first read, then the app. When the app can't be shown, the line
  that says why ("This app isn't in the company anymore.", a manifest's problems, "This app reloaded itself…") has the
  ways on under it: the way back (to the company's last open conversation, else the company) when the app is gone,
  Reload, and Show in Storage when the app has a folder.
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
```

Wire, on the port: page → host `{type: "qorpera-app-call", id, method, params}`; host → page
`{type: "qorpera-app-answer", id, ok, value | error}` and `{type: "qorpera-app-change"}`.

Rules:
- **A page changes nothing by itself.** The last three calls only ask: see "Changes" below. Every other call reads.
- **Allowed sources** are the manifest's `reads`; a method outside them is refused. The app's own folder is always
  readable. With `files`, any company path outside the platform's folders: never `QorperaOS/`, `hooks/` (received
  mail), `bank/`, `digital-post/`, `members/` or `code/`. Paths are checked on the host: relative, no `..`, no `%`,
  no backslash. Tables come only through `table`. With `questions`, the question cards waiting for the member that
  point at this app (the rule the questions dock uses: an option previews `app:<name>` or a picture in `apps/<name>/`,
  or the body links `app:<name>`): each card's id, the asking agent's name, its title, body, options (label, value,
  description), whether it takes several answers, and when it was asked. Never the conversation it is in.
- **Never into the bridge:** the member's token, email, id or session, this app's own state, other members' settings,
  vault or login data, mail, billing.
- **The viewer's own authority**: every read is the member's own folder read.
- **Bounds**: at most 8 calls in flight and 120 a minute per app in a tab (kept across Reloads; `todos` counts as
  ten, since it reads every agent's todos, and a request for a change as five), a call's params at most 4 KiB (a
  row's cells 16 KiB), an answer at most 1 MiB. `questions` reads the cloud at most once in four seconds. A call over the
  budget is refused ("Too many calls") and spends nothing. Change notices come up to once a second, so a page that
  drew on every one would spend a minute's budget in seconds. `save_app` therefore tells agents the pace: draw when
  the page opens, after a change draw again once and no sooner than ten seconds after the last draw, each source
  called once per draw, and after a failed read keep what was shown and read again ten seconds later.
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
  with no bar, before anything is read.
- The bar stands above the frame and pushes the page down, in every placement (an app's page, the Concepts viewer):
  nothing of the page is ever under its buttons. The frame has no origin, so the page can neither draw the bar nor
  press it.
- The bar says what will be saved in Qorpera's words, with no text of the app's in its sentences: for an answer, the
  agent, the card's title and the labels of the options chosen, read from the card; for a row, the table's name, the
  row's key and each cell as it is and as it will be (an added row: each cell it sets).
- Every request is its own bar. There is no "always allow", and nothing is remembered.
- "Not now" has the focus. The yes button ("Send answer", "Change row", "Add row") wakes one second after the bar is
  on a visible screen, and takes only a press (pointer or key) that began on it after it woke: a click or a held key
  on its way when the bar came in does nothing, and Enter in the page stays in the page.
- One bar at a time: while one is open another request is refused at once. After three "Not now" in a row the app is
  refused without a bar until the member reloads it (Reload, or opening the app again); a yes starts the count again.
- While a bar is open the page's Escape is not passed on (`AppFrame.holdEscape`).
- A request whose page is put away (reloaded, changed, left) before the member chose is put away unsaved, and so is
  one whose app's manifest changed meanwhile. What a page may read and ask for follows the manifest as it is now,
  also under a page that stays as it is: `writes` taken away refuses the next request at once, `writes` added works
  without a Reload. A request still being checked when the page or the manifest changes is refused when its check
  ends, before anything is shown (`AppPanel` serves each frame and each version of the manifest with its own bridge).
- However much a request holds, the bar stays within the screen: its lines scroll inside it (at most 40% of the
  window's height) and both buttons stay in reach. Checked in a browser at 390 px wide with twelve cells of 500
  characters.
- The bar then says how it went: "Sent to <agent>", "Saved", or why not. The page's promise resolves `{saved: true}`
  or rejects with the reason: not now, another request waits, asked three times, or the refusal's own words.

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

Threat model: the app's author is an agent of the company, which already reads the company's own files and has the
internet (through the logged agent exit). The frame keeps the app from the member's session (cookies, storage, tokens,
this app's DOM), from acting as the member (a page only asks; the member's yes is given outside the frame), and from
reaching what the platform keeps out of it.
Two things the frame adds that the agent doesn't have are guarded: what the member types into the page (beside the
chat and in the Concepts viewer, Qorpera says whose page it is and that it never asks for passwords there; an app's
own page has said neither since it lost its header on 10 November 2026, §6 H2), and the member's authority
(reads only of the allowed sources; a change only of what `writes` names, one at a time, shown in full and allowed by
the member each time). What a prompt-injected agent can still do is ask: a member who allows a bar without reading it
makes that change, as theirs, to an answer the agent itself asked for or to a row of a table the app names; it can
never be a file, a member's or agent's place, a setting, or anything outside those two. A leak through a side channel
leaves from the member's browser, unlogged.

## 6. Security review

An independent Opus review of this design and the frame ran on 5 November 2026 before step 4 was built
(`~/work/interface-apps-security-review-r1.md`). Its findings and what was done:

| Finding | Done |
| --- | --- |
| H1 the bridge must not ride on window messages | one port per frame, handed over once; second "ready" or third load tears it down |
| H2 phishing inside the panel | host-drawn header: app name, "Made by <agent>", "Qorpera never asks for passwords here". **Since 10 November 2026 an app's own page has no header** (Jonas's decision, §4), so the line stands beside the chat and in the Concepts viewer's side panel only. On an app's own page nothing replaces it yet: a page that draws a sign-in there has the rail beside it and nothing else of Qorpera's. A guard that costs no header is a follow-up (§7): the line shown above the page only while the page has a password field on screen |
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
| H3 (4) Allow disabled about a second, not the default, no Enter from the frame, a fresh press, focus moved to the bar | the yes button wakes after 1 s on a visible screen and takes only a press that began on it after that; "Not now" takes the focus; a held key does not press "Not now" either |
| H3 (5) one pending bar; three "Not now" and no more bars until Reload | so, counted in a row (a yes starts it again) |
| H3 (6) the bar above the frame, pushing it down | so, in every placement |
| H2's last line: refuse long values unless shown in full | every value is shown in full |
| L3 ignore the page's Escape while a bar is open | `AppFrame.holdEscape` |
| (added) the row may change while the bar is open | the change is planned again at the write and saved only if it is the one shown |
| (added, review of the build) the manifest or the page may change while a request is checked or waits | each frame and each version of the manifest has its own bridge; a request of an earlier one is put away or refused before the bar |
| (added, review of the build) a request may be longer than the screen | the bar's lines scroll inside it; both buttons stay in reach |
| (added) a page must not move people or agents | `needs_yes`, `member`, `agent` and `agents` columns and the table `areas` are refused |

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

Follow-ups: the password line on an app's own page without a header (§6 H2: shown above the page only while the page
has a password field on screen, reported by the frame document); a member marks a human task done from an app (the asking agent's wake is built, but the object gateway
holds every member save under `QorperaOS/human-tasks/` until Qorpera has its own task screen, and a task that asks
for proof cannot be finished by one tap); a typed answer; removing a row; the folder-core rule that parks a
machine's change of `posted` (§3's known gap; the same gap lets a machine write `writes`, which gains it nothing
without the member's yes on the bar); browser-test variants for the frame (self-navigation to
`about:`/`javascript:`, speculation rules, a page that reloads itself) in `scripts/test-web-page-frame-browser.mjs`.
