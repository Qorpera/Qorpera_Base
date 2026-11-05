# Interface apps

Status: design, 5 November 2026; built in steps (§7).

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

- **Side panel.** PR #1430's agent sheet, generalised: `SidePanel` stands beside the conversation inside
  `.thread-body` (not over it, no dim, not modal), the conversation stays mounted and usable. Header: emblem, title,
  the owner's name, Reload, Show in Storage, Close. Escape (in the panel or in the page) closes it. One panel per
  thread; opening another app replaces it. At phone width it covers the thread, with Close.
- **Chat card.** A link `app:<name>` in an agent's message draws as a card in the bubble (emblem, title, about,
  "Open"), which opens the panel. `folder:` links to `.html` files open in the panel too (a plain page, no manifest).
- **Apps drawer.** Posted apps join Mailbox, Members and Bank in #1430's drawer. A press opens the app in the panel
  beside the open chat; with no chat open it opens the owner's chat with the app beside it.
- **Changes.** The panel follows the folder's hints (`interface-folder.ts` pattern: hint, at most once a second, a
  minute's poll behind it). A change to one of the app's own files reloads the frame; a change to a source it reads
  tells the page (§5).

## 5. Live data: the bridge (step 4)

The page talks to the host only by `postMessage`; the host answers only the frame it made (by its `contentWindow`, as
`PageFrames` does). The host puts a small `qorpera` object into the page (an inline script before the page's own), a
convenience only: the host checks every request whatever sends it.

```js
await qorpera.read("apps/sales/data.json")      // a file's text (≤ 1 MiB)
await qorpera.list("reports")                    // a folder's entries: name, kind, size, updatedAt
await qorpera.table("tasks")                     // a table's columns and rows
await qorpera.todos()                            // open and blocked todos: title, agent, state
await qorpera.agents()                           // agents: name, role, working or not
await qorpera.writeRows("tasks", {set, remove})  // asks the member first (below)
qorpera.onChange(() => …)                        // a source the app read changed
```

Wire: page → host `{type: "qorpera-app-call", id, method, params}`; host → page `{type: "qorpera-app-answer", id, ok,
value | error}` and `{type: "qorpera-app-change"}`.

Rules:
- **Allowed sources** are the manifest's `reads`; a method outside them is refused. `read`/`list` take company-relative
  paths and refuse `QorperaOS/` (except tables through `table`) and `hooks/` (received mail): an app sees what its
  agent can already read in the Company File, no member-only state.
- **The viewer's own authority**: every read is the member's own folder read; nothing is cached across apps.
- **Writes** are rows only, through the member's table write path (the folder core checks `[write]` members and the
  claim rule). Each write first shows a host-drawn bar in the panel, outside the frame: "<App> wants to change 2 rows of
  tasks. Allow / Not now". The page can't press it.
- **Bounds**: at most 8 calls in flight and 60 a minute per frame; an answer at most 1 MiB; requests and answers are
  structured-clone plain data only.
- **No network of its own**: the frame keeps `sandbox="allow-scripts"`, no origin, the frame document's policy
  (`default-src 'none'`, no `connect-src`). The frame document also removes `dns-prefetch`/`preconnect` links the page
  adds while it runs (today they are removed only from the page as handed over).

Threat model: the app's author is an agent of the company, which already reads the whole Company File and has the
internet. The frame must keep the app from the member's session (cookies, storage, tokens, the app's own DOM), from
acting as the member without the member's say, and from reaching data the agent could not read. It does not try to
stop an agent from sending the company's data out: the agent can do that without an app.

## 6. Security review

An independent Opus review of §5 and the frame (page-frame.ts, public/page-preview/index.html) runs before step 4 is
built; its findings and fixes are listed in the PR.

## 7. Steps

1. Format + parser (`cloud-client/interface-apps.ts`) and the page assembler (web).
2. Agent tools `save_app`, `post_app`, the `company_write`/`company_edit` checks, prompt guidance, re-pinned prompt
   hashes.
3. Web: side panel, chat card, `folder:` `.html` in the panel, posted apps in the drawer.
4. The bridge.
