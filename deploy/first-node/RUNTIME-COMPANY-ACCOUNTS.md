# Company accounts (A1)

Founder decisions: 29 September 2026 (Q1: agents create and use accounts on outside services under the
company's own email identity, reuse accounts a member hands over, may set up the GitHub organisation; no merge
gate by default) and 2 October 2026 (members never see a password; phone codes from a member's phone once, then
an authenticator; a person presses Create where a website's terms want one; accounts open only when an agent's
work needs one, never at founding and never unprompted). Plain design page:
https://claude.ai/artifact/GfmXyKyFSC4M5ULeTBC72e ("Company Accounts").

## The shape

- An account is a company-owned vault secret (`qorpera_cloud_secrets`, connector `website`, owner `company`)
  plus one `qorpera_company_accounts` row. The sealed envelope holds the password, and later the authenticator
  seed and the recovery codes; nothing outside the broker ever holds a value.
- The metadata row keeps what must not change by accident: the website the secrets may be filled into (`site`,
  plus up to four `sign_in_hosts` such as `accounts.google.com`), the login, two-step (`none|authenticator|email|
  sms`), the status (`pending|connected|needs_person|closed`), and for an agent's account the open todo that
  needed it (`opened_for_todo_id`), the agent and the opening receipt. A member's hand-over names no todo.
- The account file `connections/<stem>.md` (F2 format, written by the vault's writer, A1-7) shows `site`,
  `two_step` and `opened_for`. Since A1-7 (migration `20260930072000`, `RUNTIME-COMPANY-FOLDER-C1C.md` §6.23) accounts
  serve only companies on the company folder; any other company is refused (0A000 "Accounts need a company on the
  company folder").

## A1-1: the vault's records (migration `20260928419970`, SQL tests 794 and 797)

Switched off: `qorpera_company_account_settings.enabled` (single row, false). The coordinator turns it on with
`update public.qorpera_company_account_settings set enabled = true;` once the broker (A1-2) and the computer
(A1-3) can use it.

### Broker calls (login `qorpera_secret_broker` only)

Every call is bound to the agent's tool call: the run binding (the native lease, validated by
`qorpera_native_tool_locked_run`, job first) and the run's `executing` effect receipt, whose logical operation
key must be `company_account:open:<key>` for an opening and `company_account:<action>:<account id>:<key>` for
the other actions (the receipt names the account, as a connector receipt names its grant). Shared checks in
`qorpera_company_account_call`, in lock order: the switch (0A000 when off), the broker authority by plain read
(42501 unless active with this capability), the run's job by plain read (42501 unless it is the authority's
company: another company's run is refused before any of its rows is locked), the company's core through that job
(0A000 unless it is on the company folder, A1-7), the run (`qorpera_folder_tool_run`), the authority's company
equals the run's (42501), and the call's own arguments. The receipt `FOR UPDATE` (42501 unless executing,
cloud_tool, same input and downstream digests, this action and account) is `qorpera_company_account_receipt`'s,
taken after the account's vault rows since A1-7. Every check is null-safe: a missing capability, digest or (for
use, version and state) account id refuses (42501), never passes as unknown.

| Function | Action | What it does |
| --- | --- | --- |
| `qorpera_open_company_account(authority, capability, binding, receipt, input, downstream, secret_id, company_id, environment_id, site, sign_in_hosts, login, purpose, todo, key_id, envelope, envelope_sha256)` | `open` | The broker chooses the account's id and seals it, with the run's company and environment, into the envelope's associated data; all three come in, the company and environment must be the run's (42501) and the id unused (42501 'company account id is taken': a broker fault, never a refusal the agent reads; the next attempt draws a new id). Refuses (22023) unless `todo` is an open or blocked, unretired todo of the run's own agent in the same company and environment. Refuses a malformed site, hosts, login or reason (22023; a host is lowercase DNS labels of 1–63 characters, at most 253 in all, and the sign-in hosts a flat list of at most 4) and an open account with the same site and login, case-insensitive (23505, "use it"). Creates the secret with that id (vault name from the site, `-2`, `-3` … for more accounts there), version 1 under the authority's key (the digest is checked), the account row (`pending`), and an `account_opened` audit event. A repeat with the same receipt returns the same account. |
| `qorpera_describe_company_account_open(authority, capability, binding, receipt, input, downstream)` | `open` | What the broker needs before it seals version 1: the run's company and environment and the company's key id, after the same checks as the opening (no write). |
| `qorpera_use_company_account(…, account)` | `use` | Returns the current version's envelope with its associated data (company, environment, account id, version, key id), and the site, sign-in hosts, login and two-step, to the broker, for a fill, a code or a password change. Refuses a closed or revoked account (22023). Records `last_used_at`/agent and an `account_used` event. |
| `qorpera_add_company_account_version(…, account, base_version, two_step, key_id, envelope, envelope_sha256)` | `version` | Compare-and-swap over `base_version` (55000 "read it again" when it moved; never 40001). A repeat finds its own version by digest. May set `two_step`. `account_version_added` event. |
| `qorpera_set_company_account_state(…, account, status)` | `state` | `connected`, `needs_person` or `closed`; `connected_at` once, `closed_at` on close. Closing revokes the vault row, which wipes every envelope (20260928429975); a repeat close answers the closed account. A closed account is never used again and frees its login for a new account. `account_state_changed` event (`operation_id` = the new status). |

The account row and its secret are locked `FOR UPDATE` (secret first) only by the version, state, use and fill
calls, before the receipt (A1-7: vault rows at rank 8, then run-owned rows), and only when the secret is this
company's `website` secret: any other id (another company's account, a Gmail secret) is refused without being
locked. The opening call takes the company's account claim (a transaction advisory lock at rank 9), reads the
duplicate login and the vault name under it, takes the receipt, then inserts, taking the foreign keys' key-share
locks. The 5 s `lock_timeout` covers the vault rows and the claim. Through the vault the database pool cancels a
statement after 4 s, so a longer wait ends as "outcome unconfirmed" and rolls back; the tool call's next attempt
repeats it.

### Member calls

- `qorpera_list_company_accounts(profile, environment)`: any member of the company (42501 otherwise). The facts
  only: site, sign-in hosts, login, two-step, status (a secret revoked elsewhere reads `closed`), purpose, the
  todo it was opened for (id and title), who opened it (agent name or member), created, connected, last used and
  by whom, closed. No envelope, key id or value.
- `qorpera_remove_company_account(profile, account)`: owners and admins (42501 otherwise, checked by plain read
  before any lock; 0A000 for a company not on the company folder). Then, in lock order (A1-7):
  `qorpera_folder_company_enter` (a paused company refused with 55000, the folder fence `KEY SHARE` with the pause
  read again, the company row `KEY SHARE` at rank 0, which the audit row's key needs, the caller's member row
  `KEY SHARE` at rank 1), the deletion and the role read again, then the secret and the account. Revokes the secret
  (the trigger below wipes the envelopes and closes the account), records `removed_by_user_id`, and audits
  `account_removed` once; a repeat changes nothing. A broker call on the same account meets the removal at the
  secret, in the same order, and waits there holding neither the account nor its receipt (test 797). The account on
  the website stays open; no agent can use it any more.

### Elsewhere

- The audit's event types gain `account_opened`, `account_used`, `account_version_added`,
  `account_state_changed`, `account_removed` (the constraint is replaced under the migration's 3 s lock timeout).
- Company delete: `qorpera_purge_company` removes the rows with the company (both tables carry `profile_id`).
- `qorpera_list_cloud_secret_connections` lists `website` secrets too; the web's services view shows only its
  hosted connectors.
- Trigger `qorpera_company_account_secret_revoked` (after a `website` secret goes from active to revoked, by any
  path, including the generic `qorpera_revoke_cloud_secret` an owner or admin may call on any company secret):
  deletes the secret's envelope versions and closes its account (`removed_by_user_id` from the revoker), so
  nothing is left half open and the login is free for a new account.

## A1-3a: filling in the database (migration `20260928429975`, SQL test 807)

The office never talks to the vault. The office service makes an X25519 key pair in memory when it starts and
reports the public half with its readiness; the native host already carries every computer action to the office,
so for a fill it asks the vault (its existing runtime route), the vault seals the value to that key, and the host
carries only the sealed box beside the action. Plaintext exists only in the vault and inside that office service.

- `qorpera_runtime_office_activations.fill_public_key`: the boot's key, 32 bytes in one base64url spelling
  (`qorpera_company_computer_fill_key_valid`: 43 characters whose last carries 4 bits; never a low-order point:
  libsodium's seven, with the unused top bit ignored). Null for a boot from an older image: it gets no fill.
- `qorpera_report_runtime_office_ready(startup, activation, native port, viewer port, fill key default null)`
  (service role, as before; replaces the four-argument function, whose callers still resolve to it): the key is
  checked before any lock (22023) and kept on that activation only, once, while it is not active; the same key
  again (the office repeats its report until it is active) is accepted, another key, or one after activation, is
  refused (42501). A service successor is a new activation and reports its own key.
- `qorpera_valid_office_browser_action`: `vault_fill {role: textbox|spinbutton, name, account, field:
  login|password|code}`. The value never appears in the action, its receipt or a transcript.
- `qorpera_fill_company_account(authority, capability, binding, receipt, envelope, downstream)` (broker only):
  the checks of the account calls in the same order and null-safe (switch, authority by plain read, job by plain
  read, the core: 0A000 unless the company is on the company folder, the run, the company), the call's operation
  envelope read before any lock (a `vault_fill` of `computer_browser`, 22023 otherwise). Then, by plain read: the
  computer the envelope names is the run's company's, at its current generation, and the
  run's own unexpired screen lease is on it (42501 'company computer lease is unavailable'); its current active,
  not superseded activation has a key (0A000 otherwise: the agent is told the computer cannot type account values
  right now, because it is still starting or needs a restart on a newer version). Then the account as `use` locks it
  (this company's open website account, the secret then the row; 22023 'no such open account'), and only then (A1-7)
  the receipt `FOR UPDATE`: executing, `cloud_tool`, input digest = SHA-256 of that envelope, the downstream digest,
  logical key `computer_browser:<the envelope's key>` (42501); its current version, last use and an `account_used`
  event. Answers
  `qorpera.company-account-fill-context/v1`: the account's facts, the envelope with its associated data, and what
  the box is bound to (receipt, field, computer, generation, the key).
- Neither function is on the native host's call list (`qorpera_native_host_calls`, test 807), so once G2-2's switch
  takes the service-role key off the native host it cannot reach the key's registration or the fill. The office's
  ready report still uses its service-role registry key until G2's office step moves it; the key moves with it.
- Closing an account (`qorpera_set_company_account_state(…, 'closed')`) revokes its vault row at once, and the revoke
  trigger wipes its envelopes in the same statement: nothing keeps a closed account's password or authenticator, and
  its connection file is removed at close (A1-7). A repeat close answers the closed account. There is no 30-day wipe
  any more, so closing is a "deleting things outside" step the company's review rules check (A1-4); after it only the
  website's own account recovery gets back in. Accounts closed before this migration are revoked by it.

## A1-4c: the computer stops at a page that asks for a person (office guest code, with an office image)

Jonas, 2 October: on a block, CAPTCHA or "unusual activity" page, stop at once, mark the account `needs_person`,
never retry. The office enforces the stop and the never for the browser and the desktop; the agent marks the
account (A1-4b's words). Nothing tries to pass such a check.

- `cloud-company-computer-site-stops.ts` reads a tab. First the frames inside it (a list the browser keeps, so a
  page that does not answer still shows them): a shown frame of a CAPTCHA or human check service (reCAPTCHA,
  hCaptcha, Cloudflare's challenges, Arkose and GitHub's octocaptcha, DataDome, HUMAN, AWS WAF). Never the page
  itself (a service's own website), never reCAPTCHA's invisible badge (`size=invisible`), never a hidden frame; a
  frame whose visibility cannot be read within 1 s counts. Then, within 2 s, its title and the top 4,000 characters
  of its text: an interstitial's whole title counts on any page ("Just a moment...", "Attention Required! |
  Cloudflare", "Pardon Our Interruption", "Access to this page has been denied", "Robot Check"; "Access Denied" only
  on a short page, since a long one is an application's own permission page);
  words ("not a robot", "verify you are human", "checking your browser", "unusual activity", "you have been
  blocked", "request is blocked", …) count only when the whole text is at most 3,000 characters, so an ordinary page
  that mentions them (a question about "access denied" errors, an article about CAPTCHAs) is not taken for one.
  Curly apostrophes and the ellipsis character read as plain ones. English only; frames catch widget checks in any
  language.
- Before every page action (navigate, click, fill, press, vault_fill) the office reads the page first. A page that
  shows such a check now gets nothing clicked or typed, whatever its address; its site is recorded. A page action
  on a recorded site (the site, a name under it or a parent of it, `www.` and a trailing dot aside) is refused before
  it starts. A navigation is checked by its destination, so going to another site stays open.
- After the action, a page that now shows such a check, or lands on a recorded site (a link or a redirect), records
  the site it shows, nothing else: never the site a navigation or a link left (a search page or a mail page), nor an
  address the agent asked for that redirected elsewhere (a link tracker such as `www.google.com/url`).
- The answers are the call's results, not errors (an error reaches the agent only as an unconfirmed outcome, and
  leaves its receipt executing): a refusal is `{completed: false, refused: {code: "SITE_STOPPED", message}}`, an
  action that landed on such a page is `{completed: true, stop: "SITE_STOP_<REASON>", message}`, and a snapshot
  still shows the page with `stop` and `message`. The message tells the agent to stop, never retry, mark the account
  `needs_person` and tell a member. The receipt completes, so the agent's next call (company_account state) runs.
- Desktop click, scroll, press and type are refused the same way while a shown tab of the screen's browser is on a
  recorded site or shows such a check (a tab whose visibility cannot be read counts as shown); moving the pointer
  and screenshots stay allowed. Members are not affected: their input never goes through the agent's actions. A
  shell can still send input to the display; the agent's words (A1-4b) cover it.
- Known limits: a visible Cloudflare Turnstile box on an ordinary contact or sign-up form counts as a stop (a person
  continues there); a page still building itself by script right after a navigation is read early, so its title
  alone decides, and a short page that mentions "suspicious activity" or "automated traffic" (a login notice, a
  cookie page) counts, as does a short page that uses CAPTCHA words (a short reCAPTCHA admin page).
- The record is the office service's, for all the computer's screens, while it runs; a restart clears it, and the
  account's `needs_person` stays in the database (it does not stop a vault fill by itself: a person's step may
  clear it). Read actions (snapshot, list_tabs, select_tab, screenshots) stay allowed, so the agent can describe the
  page and a member can take over.

## A1-5a: which mail is an account's own (migration `20260928439960`, SQL test 809)

Members read the company's mail (Interfaces I5, Q1's member read), but an account's sign-up and sign-in mail carries
codes and reset links, so it is shown only as "<site> · sign-in mail · used by <agent> <time>".

- An account's mail is marked by its login: a tagged address, `<handle>+<tag>@<mail domain>` (find_mail's tags).
  Only a tagged login marks mail. A bare mailbox address or a username never does, so no account can hide a whole
  mailbox (closed accounts count, and a closed row is kept until its company or environment goes). What makes
  every account's login such an address is A1-4's job (see "Notes for later steps").
- `qorpera_company_account_mail(profile, environment, addresses text[])`: the newest of the company's accounts
  (closed ones included: a closed account's late mail is still a code or a link) whose login carries a tag and
  equals one of the addresses, whole, in any letter case, spaces around it ignored; `{accountId, site, lastUsedBy,
  lastUsedAt}` or SQL NULL. Accounts opened at the same moment answer by the lower id. SECURITY DEFINER, stable, no
  grants to any API role or the broker: Q1's postgres-owned member read calls it (and guards on its absence) with
  the delivery's own company and environment, never ids a caller chose. A plain read; its cost is bounded by one
  company's accounts (the planner uses the company index, or `qorpera_company_accounts_login` (profile,
  environment, lower(login)) when companies hold many accounts on average).

## A1-4a: the account tool's database side (migration `20260928439965`, SQL test 813)

The agent's account tool (A1-4b) needs three things the vault's calls do not give it. Inert until that tool is
offered and accounts are switched on.

- `qorpera_find_company_accounts(p_binding, p_request)`: one read for the running agent, a native host call bound
  to its run (G2-1 scope `binding`, budget standard; listed in `NATIVE_HOST_CALLS` and the path control). The
  request is `{todo?, site?}`:
  - the company's accounts that are not closed, newest first, at most 20 with `more` when there are others; on
    one website when `site` is named, as the account's site or one of its sign-in hosts, in any letter case;
  - each account's id, site, sign-in hosts, login, two-step, status, whether this agent opened it, and when it
    was last used, never a value, envelope or key id;
  - the company's mailbox addresses (removed ones left out), for the tagged login;
  - with `todo` (a todo key), that todo's id, when it is this agent's own open or blocked todo (22023 otherwise):
    agents know a todo by its key, and the opening names it by id.
  It answers `refused` 0A000 while accounts are switched off and for a company not on the company folder (since
  A1-7, 20260930072000), and 22023 for any other request
  shape. Granted to the service role only.
- An agent's account signs up with a tagged address of one of the company's mailboxes. A trigger on
  `qorpera_company_accounts` (before insert, for an agent's opening only) refuses any other login with 22023,
  which the vault passes to the agent as a refusal it can act on: `<mailbox>+<tag>@<mail domain>`, the mailbox
  the company's and not removed, the tag 1 to 64 of `[a-z0-9._-]`, the domain the platform's mail domain, ASCII
  only (checked before lowering: under a Unicode collation `lower()` turns look-alikes into ASCII letters) in any
  letter case. A member's hand-over (A1-6) keeps any login. With no mail domain or no mailbox, no agent opens an
  account: an owner adds a mailbox first.
- Observations name the tool `company_account` (`qorpera_record_runtime_observation`, an exact-text patch after
  `'find_mail','save_attachment',`, which later patches anchored there still find), as the runtime's list does
  (`scripts/check-runtime-observation-vocabulary.test.mjs` checks both).

## A1-4b: the agent's tool (`company_account`, runtime only)

Offered to a company run's agent (not a worker; since A1-7 only on the company folder) when the host has the vault
(`QORPERA_CLOUD_SECRET_BROKER_URL` and token): the same broker client serves connectors and accounts. Inert while
accounts are switched off (the read answers "switched off"). `cloud-company-account-tools.ts`:

- `find {site?}`: the read of A1-4a (the company's accounts and mailboxes); its refusals reach the agent as
  `REFUSED: <message>`.
- `open {site, signInHosts?, mailbox?, todo, purpose, password?, operationKey}`, in this order:
  1. Which way in (Jonas, 2 October), as the arguments are read, before any review, so no member is ever asked to
     approve such an opening: a service with an official connection is refused with "use it" (GitHub, Google: the
     connector catalog's) or "the company cannot add it yet" (Microsoft, Slack); a site with strict bot checks
     (Apple, LinkedIn, X, Meta, Amazon and its regional stores) and a payment provider (PayPal, Stripe) are refused as a person's task in
     their own browser. Matched on the site and its sign-in hosts, the domain or any name under it. Banks are in the
     words only.
  2. The read with the todo key and the site: the todo's id, the mailboxes, the site's accounts.
  3. The mailbox: none is a refusal; else the one named (one of the company's), else the company's only one;
     several unnamed is a refusal that lists them.
  4. The login, made by the tool: `<mailbox>+<site>@<mail domain>`; when the part before the @ would pass 64
     characters the tag is cut and ends in `-` and 8 hex characters of the site's SHA-256; a mailbox that leaves
     under 12 characters for a long site carries no tag (refused: name another mailbox).
  5. Reuse first: an account on the same website (the site, a name under it or above it, or a sign-in host, `www.`
     aside; among the site's accounts and the company's newest 20) under another address is refused with its id
     ("use it"); one under this address is this opening repeated (the receipt answers) or the vault's 23505.
  6. The effect: receipt `company_account:open:<operationKey>` (arguments: site, sign-in hosts, login, purpose, the
     todo's id, the password rules), then the vault's `POST /v1/company-accounts`; its answer (the account, or its
     refusal in its own words) completes the receipt and is the call's result.
- `state {account, status, operationKey}`: receipt `company_account:state:<account>:<operationKey>`, then the vault.
- Review: `find` is a read; `open` acts outside; `connected` and `needs_person` are the company's bookkeeping;
  `closed` is destructive, and its card says it deletes the password and authenticator for good (the "deleting
  things outside" check). A `vault_fill` card names the account and the field, never a value.
- `computer_browser` now offers `vault_fill {role, name, account, field}`; the computer tools' words say a company
  account's values are typed only by the vault, and a CAPTCHA, bot check, unusual activity warning or block page
  ends the attempt at once, never retried, the account marked `needs_person`. The agents' instructions gain
  "Accounts on websites" with the same rules.
- Rollout: the vault's nginx needs `location = /v1/company-accounts` and `location = /v1/company-account-fills`
  (to `$qorpera_operations_broker`, as `/v1/operations`), then the coordinator switches accounts on. #682 (fill
  hardening) must be in the office image before agents get `vault_fill`, and accounts stay switched off until an
  office image with A1-4c is live: until then the stop at a block page is only the agent's words.

## Machines: signing in from a company machine (migration `20260930781000`, SQL test 1279)

Jonas, 10 November 2026: "Build machine sign-ins", "they should be able to use the vault too". Production has no offices
since 3 October, so `vault_fill` types nothing; agents work on their own company machines, whose desktop runs Chromium
(`deploy/machine/README.md`, "The desktop"). This is save_coding_value's (20260930705000) opposite direction, built the
same way: a fixed helper in the machine image, run by the machine's coding executor over LXD exec for one executing
receipt, with the vault's box bound to the machine, its placement and its boot.

### The agent's side

- `fill_company_account {operationKey, machine, account, field: login|password|code}` (machine tools, toolVersion
  `qorpera.machine-tools/v1`, receipt key `fill_company_account:<operationKey>`), offered with the machine tools to a
  company agent's own run (never a worker's) on a host that has the vault's company accounts (the same condition as
  `company_account`). The model passes no value and the answer holds none: `{filled: {machine, account, field}}` or
  `{filled: false, refused: {reason, message}}`. Review: external (its card names the machine, the account and the
  field). Each call types once, so each needs a new operationKey; a repeat after an uncertain result types again into the
  same box (the helper empties the box first, so the value replaces what is there).
- The words (the tool's description, `company_account`'s and "Accounts on websites"): `desktop start`, `desktop open`
  the sign-in or sign-up page, `desktop shot` to see it, `desktop click` into the field, call the tool, click into the
  next field and call again, press the site's own button. Never type, paste, read aloud, write down or screenshot a
  password. A `desktop shot` of a page only before the vault types into it: once the tool was called on a page, no
  `desktop shot` and no `--shot` until its tab is closed or has gone to another page (sent the form, or opened again
  with `desktop open`), since a page can copy a value anywhere at any time and shots are kept in the company folder; the
  next field is reached with `desktop key Tab` or a click where the earlier shot showed it (review round 3 of #1644). No
  result of the tool suggests a shot: every one, `filled` (its `next`) and each refusal, ends "Take no screenshot of
  this tab until it is closed (desktop key ctrl+w) or has gone to another page: a page can copy a value the vault typed
  into it at any time, and screenshots are kept in the company folder.". On a CAPTCHA, bot check, unusual activity warning
  or block page: stop, never retry, `company_account state needs_person`, tell a member. As on the office (A1-4c), the
  agent marks the account: the helper's refusal (`SITE_STOP_*`) carries A1-4c's message, which says to.
- Opening on a machine needs nothing new: `company_account open` has served folder-v2 companies since A1-7 and never
  needed an office (test 1279 opens one on a company with a machine and no computer). Agents asked to sign up today got
  "Company accounts are switched off": the switch is the only refusal. Every A1 rule stays (one tagged login
  `<mailbox>+<site>@<mail domain>` per site, an open todo of the agent's own, the refused sites, reuse first). The agent
  opens the account first, then fills its login and password into the sign-up form with the tool.
- Codes by mail: `find_mail` (to the account's tagged login, `since` the moment it acted, `waitSeconds` up to 120) and
  `read_event` exist for agents (M2b, A1-5a; members see such mail only as "<site> · sign-in mail"). The agent reads a
  mailed code or link and types it itself (`desktop type`, or opens the link with `desktop open`): such a code is in its
  context already. `field: code` is the authenticator's code from the vault, for an account whose two-step is
  `authenticator` (none is set up by any agent path yet).

### The transport

1. The runtime begins the receipt and sends `/v1/machine-commands/account-fill {commandId, envelope, idempotencyKey}`
   through the coding executor's gateway, with the run's holder (G2-6b proves it at the ingress).
2. The executor asks SQL, `qorpera_authorize_machine_account_fill(binding, scope, receipt, envelope)` (service role,
   plain reads, writes nothing): the run's live tool authority in a company conversation on the company folder; the
   call's own executing receipt (envelope digest, key); a company agent's run, not a worker's, of a company neither paused
   nor being deleted. It answers, not raises, what the agent acts on: `ACCOUNTS_SWITCHED_OFF`, `MACHINE_NOT_RUNNING`,
   `ACCOUNT_NOT_OPEN`, and `DESKTOP_MEMBER_IN_CONTROL` while a member holds the machine's desktop (20260930713000). Accounts are the company's: as for the office's fill and `company_account open`, no requester role
   is asked (an agent working for a contributor may open an account, so it fills it too); a requester who is no longer a
   member is refused by the run check. Otherwise where the machine runs
   (placement, boot, executor), the desktop's lease generation it saw (`desktopGeneration`), and the helper's target:
   what the box is bound to and the account's site and sign-in hosts. Another node's executor gets the request once and
   reads SQL again.
   The executor then takes the desktop as an action does (one actor at a time; a member's action never interleaves),
   waiting up to 6 s while an agent's action holds it, and refused at once while a member's does. Before the helper starts
   it asks `qorpera_machine_desktop_picture_check` with that generation and no looker, as `save_coding_value` does
   (CLIENT-CONTRACT.md): a member who took the desktop over since the read means `DESKTOP_MEMBER_IN_CONTROL`, and nothing
   runs on the machine.
3. On the machine's node the executor runs `/usr/bin/node /opt/qorpera-machine/cloud-machine-account-fill.mjs` as root
   in one LXD exec (only on the boot SQL named: exit 97; only where the image has it: exit 98,
   `MACHINE_IMAGE_WITHOUT_ACCOUNT_FILLS`), stdin and stdout open for the exchange, stdout at most 4 KiB and read as it
   comes (`onStdout`), stderr dropped, nothing recorded by LXD, the whole exec ended at 24 s.
4. The helper reads the target, checks the focused tab against the account's hosts (below), makes an X25519 key pair in
   memory and prints `{schema: qorpera.machine-account-fill-ready/v1, publicKey}`, or a code (the vault is then never
   asked).
5. The executor asks the broker with its own executor token (`POST /v1/machine-account-fills?company=<id>`; the runtime
   token every guest holds never opens it): the run's call, its own owner name, the placement, the boot and the helper's
   key. The broker calls `qorpera_fill_company_account_on_machine` (broker only): the office fill's checks in its order
   (switch, broker authority and job by plain read, company folder, envelope before any lock, the run check), then the
   run's kind by plain read, the machine by plain reads (running on its current placement, reserved,
   a known boot, and exactly the placement, boot and executor the executor named), the key's shape
   (`qorpera_company_computer_fill_key_valid`), the account's secret then row (rank 8), and last the receipt `FOR UPDATE`
   (executing, `cloud_tool`, envelope digest, downstream digest, key). It records `last_used` and an `account_used` event
   and answers `qorpera.company-account-machine-fill-context/v1`. The broker opens the envelope, takes the login, the
   password or the authenticator's code now, and seals `{value, hosts: [site, ...signInHosts]}` to the helper's key with
   the associated data `{companyId, companyMachineId, placementId, bootId, receiptId, accountId, field}`
   (`cloud-company-account-fill-box.ts`; an office's box names a computer and a generation instead, so neither opens as
   the other). A refusal comes back in the database's own words (`VAULT_REFUSED`).
6. Before the box goes to the helper the executor asks the same check again: a take-over since the read ends stdin
   instead (the helper prints `FILL_NO_BOX`) and the agent hears `DESKTOP_MEMBER_IN_CONTROL`, with nothing typed; a check
   that fails ends stdin too and fails the call. Otherwise the executor writes the box as the helper's second stdin line,
   or ends stdin (refused: the helper prints `FILL_NO_BOX`). The helper opens it in memory for exactly its identity, on its own boot (from `/proc`), within the box's
   90 s; checks the tab again against the hosts sealed in the box; types; prints one code; reads stdin to its end and
   exits. The plaintext buffer is zeroed when opened; the value is a JavaScript string from then on, which the process
   drops and exits with (strings cannot be zeroed).

### The page check, and what it protects against

The desktop's browser (`desktop open`, `desktop start TARGET`: its `browser()` flags) starts with its own profile
(`/home/desktop/.config/qorpera-chromium`) and `--remote-debugging-port=0`: Chromium listens on 127.0.0.1 at a port the kernel picks. The helper reads that port off the
kernel, never off a file a program could write (the profile's `DevToolsActivePort` names a dead port after a second
`desktop open`, whose own short-lived process writes it before it hands its address to the running browser and exits):
the browser process (no `--type=`) running `/usr/lib/qorpera-chromium/chrome` as the account `desktop` with that profile,
the oldest if two, and the TCP socket it holds listening on 127.0.0.1 (`/proc/<pid>/fd` against `/proc/net/tcp`); then
the port's `/json/version` must name `ws://127.0.0.1:<port>/devtools/browser/<id>`. No such browser: `BROWSER_NOT_OPEN`
("open it with desktop open"); one with no loopback port (started another way) or another answer: `BROWSER_UNVERIFIED`.
It never enables the Runtime domain on a page (which sites can notice); it reads pages in an isolated world of its own.
The focused tab's checks and the typing are bound to the one document it shows at the first look (review round 1 of
#1644): the helper enables the Page domain on that tab only (its navigation events), reads its main frame's loader id,
and makes its world in that document, with the same loader read before and after and no navigation heard between. From
then on every read runs in that world alone (never made again in another document), and the loader is read again at
each step: any navigation of the main frame (requested, started, committed, within the document, `document.open`), a
reload, a closed or crashed tab, or a world that is gone refuses with `FILL_PAGE_CHANGED`, nothing typed. Before, a
redirect between the address read and the typing let the helper make its world again in the new document and type into
an autofocused box there. Then, before the vault is asked and again after the box is open:

- exactly one tab is shown with its window focused (`document.hasFocus()`), and the same tab both times;
- its main frame's address, as the browser keeps it, is https, with no user, password or port, on the account's site or
  one of its sign-in hosts exactly (`companyAccountFillHost`, the office's); after the box, the hosts sealed in it decide;
- no CAPTCHA or human check frame is shown and the title and text are not a block, check or unusual activity page (A1-4c's
  `companyComputerCheckFrame` and `companyComputerSiteStop`, frames from the browser's frame tree with their owners'
  visibility, and the page's own iframes);
- the focused element (through open shadow roots) is in the page's own document, not a frame, and is an enabled, writable
  `input` of the field's kind: text, email or tel for a login; password for a password; text, tel, number or password
  for a code.

Then it puts the value on the page without typing at the tab (review round 2 of #1644): CDP `Input.insertText` goes to
whatever document the tab shows when it lands, so a redirect that completed while that command was in flight would have
given the value to the new document's autofocused box. Right before, it checks again that the tab is on the bound
document at an address the box's hosts allow, with no navigation heard. Then one `Runtime.callFunctionOn` on the box it
checked (an object of its own world in that document; if the document is gone the browser refuses the call and nothing
runs anywhere) checks, inside that same call, the stamp it left in that world at the first look, the address against
the hosts (https, no user, password or port), and that the box is connected and has the focus; only then sets the value
with the native `HTMLInputElement.prototype` value setter (so a framework that tracks the box's value sees it change) and
fires `input` and `change`. After 200 ms for the page's own reactions it looks where the value is, again 200 ms later,
then checks the document and address once more. The outcomes once the value may have reached the page are only two
(review round 3 of #1644: a page can copy a value at any time, and a cleanup's own events can start a copy later, so no
outcome says the page is clean):

- `FILLED` only when, at both looks, that same box, connected and with the focus, holds the value exactly and a
  complete scan finds no copy in any other input or text area. The scan is iterative with no depth limit: the document,
  every open shadow root, and the document of every frame of its own origin (iframe, frame, object), at most 250 000
  elements; past that, or when a frame whose window is of this origin has no readable document, it is incomplete;
- `FILL_LOST` otherwise: the box did not keep the value or lost the focus, a copy was found, the scan was incomplete,
  the box left the document, the tab navigated once the value was in, the browser stopped answering, or the helper's
  deadline passed once the value was handed over (before that it is `FILL_EXPIRED`, nothing set). The box and every copy
  found are emptied (native setter, then an `input` event so the page's own state follows), but the answer stays lost.
  The tool says the value may still be on the page: close the tab with `desktop key ctrl+w` without sending the form,
  or `desktop stop`; start over; and set the account `needs_person` if unsure or if the tab had gone to another site.

Refusals before anything was set (`FILL_WRONG_SITE`, `FILL_IN_FRAME`, `FILL_WRONG_BOX`, `FILL_PAGE_CHANGED`, the site
stops, `FILL_EXPIRED`, `BROWSER_NOT_ANSWERING` and the rest) say nothing was typed; theirs too end with the
no-screenshot sentence, since a value from an earlier call may still be on the page. `FILL_UNCONFIRMED` is gone.

The events the helper fires are not trusted ones (`isTrusted` is false); a page that ignores untrusted input events
keeps its own state empty although the box shows the value, and its sign-in may then fail.
A sign-in page that sends its form or leaves on its own as the value goes in answers `FILL_LOST` too (the helper cannot
tell that from a redirect). The browser proof: `node scripts/run-on-node.mjs --machine node02 -- node
scripts/test-machine-account-fill-browser.mjs` (Docker on a test machine: the image's pinned Chrome for Testing on a
TigerVNC display with openbox; redirects between the helper's steps and one that lands while the call that sets the value
is in flight, the focus moved with text as long as the value in the box, a page that moves or copies the value to another
box, into a frame of its own origin or into a text box nine open shadow roots deep, a copy queued by the cleanup's own
input event, a page that leaves or stops answering as the value goes in, and the deadline after it went in).

The agent is root on its machine. It can reach the DevTools port itself, read the page (and so a typed password) through
it, read Chromium's memory, run its own Chromium with that profile, or replace this helper, `node` or Chromium on its disk
before the next fill. So this protects against mistakes and pages, not against an agent set on reading the password: a
value typed into a look-alike or redirected site, a frame of another site, a page asking for a person, a box of the wrong
kind; and the value reaching any tool input or output, receipt, chat, run history, company file, log or screenshot the
platform makes. The office kept the browser out of the agent's reach; a machine cannot.

### Image and release

- `scripts/package-machine-guest.mjs` builds `cloud-machine-account-fill.mjs` as its own file after the guest helper, so
  the guest helper's pin (`helperSha256`, the manifest's first artifact, `fee9f69…`) does not move; no
  `previousHelperSha256s` step is needed. `desktop` changes (`open`'s flags), so the bootstrap digest moves.
- `deploy/machine/build-machine-image.sh` installs it and checks it on the builder's desktop: a local https page (a
  throwaway name mapped to 127.0.0.1:443 for that Chromium only) gets a made-up password whole in its password box, the
  helper prints only its key and `FILLED`, never the value; it refuses another site, another boot and a "Just a
  moment..." page by code; and `desktop open`'s DevTools port listens on 127.0.0.1 only, held by Chromium.

Rollout, in order: the migration; the vault (broker) with `/v1/machine-account-fills` and the vault's nginx
`location = /v1/machine-account-fills` (POST only, through `$qorpera_operations_broker`, as `/v1/coding-environment`),
with `/v1/company-accounts` (and `/v1/company-account-fills`) from A1-4b if not there yet; the coding executors (they
need `broker` in their config, which coding nodes have; without it a fill answers `MACHINE_COMMAND_WRONG_EXECUTOR`); the
runtime bundle (the coordinator's release); the machine image, built and set as the nodes' machine policy (machines on
an earlier image answer `MACHINE_IMAGE_WITHOUT_ACCOUNT_FILLS` until they sleep and wake on it); and only then the switch,
`update public.qorpera_company_account_settings set enabled = true;`, by the coordinator. Never before the image is
live.

## Notes for later steps

- A1-4 must make every account's mail markable (A1-5a). The database enforces the tagged address (A1-4a); the
  rest is the tool's:
  - The account tool makes the login itself, `<mailbox>+<tag>@<mail domain>` from one of the company's mailboxes
    and the site; the agent never picks it, and no account is opened on the bare mailbox address.
  - The tag is at most 64 characters of `[a-z0-9._-]` (Q1's limit), while a site name can be 253: a long site
    gets a shortened tag (for example its first 55 characters, `-` and 8 hex characters of its hash).
  - The account row is opened before the address is typed into any form, also for sign-ups that start with the
    address alone or send a link, so the first code is already marked (the lookup runs when a member reads it).
  - A site that signs in with a username keeps the tagged address as the account's login; the username is kept
    beside it, never instead of it, or the account's codes would show to members.
  - The mail wait asks find_mail for the tagged address only (`to:`), so a site that accepts the tag but mails
    the bare address is noticed (no code arrives): the account goes `needs_person`, and the bare mailbox is never
    searched for its code.
- Folder-v2 (A1-7, done: migration `20260930072000`, test 925; `RUNTIME-COMPANY-FOLDER-C1C.md` §6.23). The calls
  locked the receipt before the vault rows, the reverse of the folder core's ranks, and the old lease validator's
  exclusive company fence serialised them, which also kept the duplicate check and the vault-name loop free of
  races. Folder-v2 has no such fence, so the calls now take core §3's order: the run check (the company row only
  `KEY SHARE`), the account's secret and then its row (rank 8), and only then the receipt (a run-owned row,
  `qorpera_company_account_receipt`); an opening takes the company's account claim
  (`qorpera.company-accounts:<company>`, a transaction advisory lock at rank 9, built as E1's
  `qorpera.event-hooks:<company>`), reads the duplicate login and the vault name under it, then takes the receipt and
  inserts. The unique indexes stay the final guard: a 23505 on either answers "The company already has this account;
  use it". A removal enters the company (the pause, the folder fence, the company row and the member, all
  `KEY SHARE`) before the secret and the account. Companies that are not on the company folder are refused.
- A repeated version save is recognised only while it is still the newest version.

## Next steps

- A1-2 broker: the `/v1/company-accounts/*` routes, password generation, authenticator codes, QR and recovery-code
  capture, sealing a value for one computer.
- A1-3b Company Computer and vault: the office's key and ready report, the vault's fill route and sealed box, the
  `vault_fill` action from the agent's tool to the office, the page and box checks, CDP `Input.insertText`, masks
  for filled boxes and authenticator QR codes, and #644's two test nits (the shell's X access went with #411).
- A1-4 agent tools and words; A1-5 mail (Q1's `find_mail` and `local+tag` addresses); A1-6 Settings; A1-7 the
  account files.
