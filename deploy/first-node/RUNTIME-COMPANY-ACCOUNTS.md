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
  `two_step` and `opened_for`; folder-v2 companies are refused until then.

## A1-1: the vault's records (migration `20260928419970`, SQL tests 794 and 797)

Switched off: `qorpera_company_account_settings.enabled` (single row, false). The coordinator turns it on with
`update public.qorpera_company_account_settings set enabled = true;` once the broker (A1-2) and the computer
(A1-3) can use it.

### Broker calls (login `qorpera_secret_broker` only)

Every call is bound to the agent's tool call: the run binding (the native lease, validated by
`qorpera_native_tool_locked_run`, job first) and the run's `executing` effect receipt, whose logical operation
key must be `company_account:open:<key>` for an opening and `company_account:<action>:<account id>:<key>` for
the other actions (the receipt names the account, as a connector receipt names its grant). Shared checks in
`qorpera_company_account_call`, in lock order: the switch (0A000 when off), the folder kind (0A000 for
folder-v2), the broker authority by plain read (42501 unless active with this capability), the run's job by
plain read (42501 unless it is the authority's company: another company's run is refused before any of its rows
is locked), the run, the authority's company equals the run's (42501), then the receipt `FOR UPDATE` (42501
unless executing, cloud_tool, same input and downstream digests, this action and account). Every check is
null-safe: a missing capability, digest or (for use, version and state) account id refuses (42501), never
passes as unknown.

| Function | Action | What it does |
| --- | --- | --- |
| `qorpera_open_company_account(authority, capability, binding, receipt, input, downstream, secret_id, company_id, environment_id, site, sign_in_hosts, login, purpose, todo, key_id, envelope, envelope_sha256)` | `open` | The broker chooses the account's id and seals it, with the run's company and environment, into the envelope's associated data; all three come in, the company and environment must be the run's (42501) and the id unused (42501 'company account id is taken': a broker fault, never a refusal the agent reads; the next attempt draws a new id). Refuses (22023) unless `todo` is an open or blocked, unretired todo of the run's own agent in the same company and environment. Refuses a malformed site, hosts, login or reason (22023; a host is lowercase DNS labels of 1–63 characters, at most 253 in all, and the sign-in hosts a flat list of at most 4) and an open account with the same site and login, case-insensitive (23505, "use it"). Creates the secret with that id (vault name from the site, `-2`, `-3` … for more accounts there), version 1 under the authority's key (the digest is checked), the account row (`pending`), and an `account_opened` audit event. A repeat with the same receipt returns the same account. |
| `qorpera_describe_company_account_open(authority, capability, binding, receipt, input, downstream)` | `open` | What the broker needs before it seals version 1: the run's company and environment and the company's key id, after the same checks as the opening (no write). |
| `qorpera_use_company_account(…, account)` | `use` | Returns the current version's envelope with its associated data (company, environment, account id, version, key id), and the site, sign-in hosts, login and two-step, to the broker, for a fill, a code or a password change. Refuses a closed or revoked account (22023). Records `last_used_at`/agent and an `account_used` event. |
| `qorpera_add_company_account_version(…, account, base_version, two_step, key_id, envelope, envelope_sha256)` | `version` | Compare-and-swap over `base_version` (55000 "read it again" when it moved; never 40001). A repeat finds its own version by digest. May set `two_step`. `account_version_added` event. |
| `qorpera_set_company_account_state(…, account, status)` | `state` | `connected`, `needs_person` or `closed`; `connected_at` once, `closed_at` on close. Closing revokes the vault row, which wipes every envelope (20260928429975); a repeat close answers the closed account. A closed account is never used again and frees its login for a new account. `account_state_changed` event (`operation_id` = the new status). |

The account row and its secret are locked `FOR UPDATE` (secret first) only by the version, state and use calls,
after the receipt, and only when the secret is this company's `website` secret: any other id (another company's
account, a Gmail secret) is refused without being locked. The opening call inserts, taking the foreign keys'
key-share locks. The 5 s `lock_timeout` covers the vault rows; the lease validator's company fence keeps its own
wait (up to 25 s), as for every native tool call. Through the vault the database pool cancels a statement after
4 s, so a longer wait ends as "outcome unconfirmed" and rolls back; the tool call's next attempt repeats it.

### Member calls

- `qorpera_list_company_accounts(profile, environment)`: any member of the company (42501 otherwise). The facts
  only: site, sign-in hosts, login, two-step, status (a secret revoked elsewhere reads `closed`), purpose, the
  todo it was opened for (id and title), who opened it (agent name or member), created, connected, last used and
  by whom, closed. No envelope, key id or value.
- `qorpera_remove_company_account(profile, account)`: owners and admins (42501 otherwise, checked by plain read
  before any lock). Then, in lock order: the company row `FOR KEY SHARE` (rank 0, which the audit row's key needs
  anyway), the member row, the secret, the account. Revokes the secret (the trigger below wipes the envelopes and
  closes the account), records `removed_by_user_id`, and audits `account_removed` once; a repeat changes nothing.
  Taking the company row's key share first means a broker call that holds the company row through its lease
  waits for the removal instead of deadlocking with it (test 797). The account on the website stays open; no
  agent can use it any more.

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
  the checks of the account calls in the same order and null-safe (switch, folder kind, authority by plain read,
  job by plain read, the run, the company), the call's operation envelope read before any lock (a `vault_fill` of
  `computer_browser`, 22023 otherwise), then the receipt `FOR UPDATE`: executing, `cloud_tool`, input digest =
  SHA-256 of that envelope, the downstream digest, logical key `computer_browser:<the envelope's key>` (42501).
  Then, by plain read: the computer the envelope names is the run's company's, at its current generation, and the
  run's own unexpired screen lease is on it (42501 'company computer lease is unavailable'); its current active,
  not superseded activation has a key (0A000 otherwise: the agent is told the computer cannot type account values
  right now, because it is still starting or needs a restart on a newer version). Then the account as `use` reads it (this company's open website account,
  locked; 22023 'no such open account'), its current version, last use and an `account_used` event. Answers
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

## A1-5a: which mail is an account's own (migration `20260929999960`, SQL test 809)

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

## Notes for later steps

- A1-4 must make every account's mail markable (A1-5a), since nothing in the database enforces it:
  - The account tool makes the login itself, `<handle>+<tag>@<mail domain>` from the agent's mailbox and the
    site; the agent never picks it, and no account is opened on the bare mailbox address.
  - The tag is at most 64 characters of `[a-z0-9._-]` (Q1's limit), while a site name can be 253: a long site
    gets a shortened tag (for example its first 55 characters, `-` and 8 hex characters of its hash).
  - The account row is opened before the address is typed into any form, also for sign-ups that start with the
    address alone or send a link, so the first code is already marked (the lookup runs when a member reads it).
  - A site that signs in with a username keeps the tagged address as the account's login; the username is kept
    beside it, never instead of it, or the account's codes would show to members.
  - The mail wait asks find_mail for the tagged address only (`to:`), so a site that accepts the tag but mails
    the bare address is noticed (no code arrives): the account goes `needs_person`, and the bare mailbox is never
    searched for its code.
- Folder-v2 (A1-7): these calls lock the receipt before vault rows, the reverse of the folder core's ranks. On
  today's companies the lease validator's exclusive company fence serialises them, which also keeps the
  duplicate check and the vault-name loop free of races; folder-v2 has no such fence, so A1-7 must order them
  by rank and take the unique checks under it.
- A repeated version save is recognised only while it is still the newest version.

## Next steps

- A1-2 broker: the `/v1/company-accounts/*` routes, password generation, authenticator codes, QR and recovery-code
  capture, sealing a value for one computer.
- A1-3b Company Computer and vault: the office's key and ready report, the vault's fill route and sealed box, the
  `vault_fill` action from the agent's tool to the office, the page and box checks, CDP `Input.insertText`, masks
  for filled boxes and authenticator QR codes, and #644's two test nits (the shell's X access went with #411).
- A1-4 agent tools and words; A1-5 mail (Q1's `find_mail` and `local+tag` addresses); A1-6 Settings; A1-7 the
  account files.
