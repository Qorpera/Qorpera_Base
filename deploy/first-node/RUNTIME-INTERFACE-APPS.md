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
the Company File as ordinary files. A member opens it in a side panel next to the chat, from a card in the agent's
message or from the apps drawer once it is posted.

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
| `owner` | agent handle | the creating agent | who made it; the drawer opens its chat |
| `posted` | true or false | false | shown in every member's apps drawer |
| `reads` | list of `files`, `tables`, `todos`, `agents` | `[]` | the live sources the app may read (§5) |

Unknown keys, bad types and bad values are problems; an app whose manifest has problems is not shown (its card says
so and links the file).

**Files.** Kinds: `.html .htm .css .js .mjs .json .txt .md .csv .svg .png .jpg .jpeg .gif .webp`. Each file at most
512 KiB (the write tools' bound), at most 64 files, at most 4 MiB in all. Other kinds may sit in the folder (an agent's
notes) but are never loaded into the page.

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
| `post_app` | sets `posted` (shows it in every member's drawer, or takes it away) | `delegation`: the automatic review |

- `save_app {name, operationKey, manifest?, files[{path, text}], remove?}` checks the name, the manifest, each file's
  kind and size and the totals before anything is written. On create it sets `owner` to the agent and `posted = false`;
  later it never changes `posted` or `owner`. A changed file that another call changed meanwhile is a conflict.
- `post_app {name, operationKey, posted}` rewrites `posted` in `app.toml`, every other byte as written.
- `company_write` / `company_edit` of an `apps/<name>/app.toml` check the manifest the same way and refuse a change of
  `posted` (pointing to `post_app`). `company_delete` / `company_move` of a posted app's folder is a deletion and is
  reviewed as one already is.
- **Known gap, accepted for v1:** a write from a machine's mounted folder (a shell, a coding session) is not checked
  here, so a machine could flip `posted` without the review. Closing it is a folder-core rule (park a view's change of
  `posted` as a proposal, P40a); it needs a migration and is a follow-up.

Prompt guidance (the agent's company context): when you have something to show (results, a test, a prototype, a
plan with numbers), make it an app and link it as `[Title](app:<name>)` instead of pasting long text. Keep apps small,
plain and readable by someone who is not an expert. Post an app when every member should keep seeing it.

## 4. Web

- **Side panel.** PR #1430's agent sheet, generalised: `AppPanel` stands beside the conversation inside
  `.thread-body` (not over it, no dim, not modal), the conversation stays mounted and usable. Header: emblem, title,
  "Made by <owner> · Qorpera never asks for passwords here", Reload, Show in Storage, Close. Escape (in the panel or
  in the page) closes it. One panel per thread; opening another app replaces it. At phone width it covers the thread,
  with Close.
- **Chat card.** A link `app:<name>` in an agent's message draws as a card in the bubble (emblem, title, about,
  "App · opens beside the chat"), which opens the panel; once the company's apps are read, the card shows the app's
  own emblem and line. `folder:` links to `.html` files open in the panel too (a plain page, no manifest).
- **Apps drawer.** Posted apps join Mailbox, Members and Bank in #1430's drawer. A press opens the app in the panel
  beside the open chat; with no chat open it opens the owner's chat with the app beside it.
- **Changes.** The panel follows the folder's hints (one channel shared with the pages' reader; at most once a second,
  a minute's poll behind it). After a change it puts the page together again: a changed page is shown afresh, an
  unchanged one is told `qorpera-app-change` (§5).

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
`{type: "qorpera-app-answer", id, ok, value | error}` and `{type: "qorpera-app-change"}`.

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
- **Bounds**: at most 8 calls in flight and 120 a minute per app in a tab (kept across Reloads), a call's params at
  most 4 KiB, an answer at most 1 MiB.
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

## 7. Steps

1. Format + parser (`cloud-client/interface-apps.ts`) and the page assembler (web `app/interface-apps.ts`).
2. Agent tools `save_app`, `post_app`, the `company_write`/`company_edit` checks, prompt guidance, re-pinned prompt
   hashes, migration 20260930566000 (the two tools in the observation list).
3. Web: side panel (`app/views/app-panel.ts`), chat card (`ui/markdown.ts`), `folder:` `.html` in the panel, posted
   apps in the drawer.
4. The bridge, read only (`ui/app-frame.ts`, `public/page-preview/index.html`, `AppBridge`).

Follow-ups: row writes behind the review's gate (H3); the folder-core rule that parks a machine's change of `posted`
(§3's known gap); browser-test variants for the frame (self-navigation to `about:`/`javascript:`, speculation rules,
a page that reloads itself) in `scripts/test-web-page-frame-browser.mjs`.
