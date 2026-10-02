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

## A1-1: the vault's records (migration `20260929999700`, SQL test 794)

Switched off: `qorpera_company_account_settings.enabled` (single row, false). The coordinator turns it on with
`update public.qorpera_company_account_settings set enabled = true;` once the broker (A1-2) and the computer
(A1-3) can use it.

### Broker calls (login `qorpera_secret_broker` only)

Every call is bound to the agent's tool call: the run binding (the native lease, validated by
`qorpera_native_tool_locked_run`, job first) and the run's `executing` effect receipt, whose logical operation
key must be `company_account:<action>:<key>` for exactly that action. Shared checks in
`qorpera_company_account_call`, in lock order: the switch (0A000 when off), the folder kind (0A000 for
folder-v2), the broker authority by plain read (42501 unless active with this capability), the run, the
authority's company equals the run's (42501), then the receipt `FOR UPDATE` (42501 unless executing, cloud_tool,
same input and downstream digests, this action).

| Function | Action | What it does |
| --- | --- | --- |
| `qorpera_open_company_account(authority, capability, binding, receipt, input, downstream, site, sign_in_hosts, login, purpose, todo, key_id, envelope, envelope_sha256)` | `open` | Refuses (22023) unless `todo` is an open or blocked, unretired todo of the run's own agent in the same company and environment. Refuses a malformed site, hosts, login or reason (22023) and an open account with the same site and login, case-insensitive (23505, "use it"). Creates the secret (vault name from the site, `-2`, `-3` … for more accounts there), version 1 under the authority's key (the digest is checked), the account row (`pending`), and an `account_opened` audit event. A repeat with the same receipt returns the same account. |
| `qorpera_use_company_account(…, account)` | `use` | Returns the current version's envelope, key id, site, sign-in hosts, login and two-step to the broker, for a fill, a code or a password change. Refuses a closed or revoked account (22023). Records `last_used_at`/agent and an `account_used` event. |
| `qorpera_add_company_account_version(…, account, base_version, two_step, key_id, envelope, envelope_sha256)` | `version` | Compare-and-swap over `base_version` (55000 "read it again" when it moved; never 40001). A repeat finds its own version by digest. May set `two_step`. `account_version_added` event. |
| `qorpera_set_company_account_state(…, account, status)` | `state` | `connected`, `needs_person` or `closed`; `connected_at` once, `closed_at` on close. A closed account is never used again and frees its login for a new account. `account_state_changed` event (`operation_id` = the new status). |

The account row and its secret are locked `FOR UPDATE` (secret first) only by the version, state and use calls,
after the receipt; the opening call inserts, taking the foreign keys' key-share locks.

### Member calls

- `qorpera_list_company_accounts(profile, environment)`: any member of the company (42501 otherwise). The facts
  only: site, sign-in hosts, login, two-step, status (a secret revoked elsewhere reads `closed`), purpose, the
  todo it was opened for (id and title), who opened it (agent name or member), created, connected, last used and
  by whom, closed. No envelope, key id or value.
- `qorpera_remove_company_account(profile, account)`: owners and admins (42501 otherwise, checked by plain read
  before any lock). Deletes every envelope version of the account, revokes the secret, closes the account
  (`removed_by_user_id`), and audits `account_removed` once; a repeat changes nothing. The account on the website
  stays open; no agent can use it any more.

### Elsewhere

- The audit's event types gain `account_opened`, `account_used`, `account_version_added`,
  `account_state_changed`, `account_removed` (constraint replaced `not valid`, then validated).
- Company delete: `qorpera_purge_company` removes the rows with the company (both tables carry `profile_id`).
- `qorpera_list_cloud_secret_connections` lists `website` secrets too; the web's services view shows only its
  hosted connectors. The generic `qorpera_revoke_cloud_secret` revokes a `website` secret without wiping its
  envelopes; use the account removal instead.

## Next steps

- A1-2 broker: the `/v1/company-accounts/*` routes, password generation, authenticator codes, QR and recovery-code
  capture, sealing a value for one computer.
- A1-3 Company Computer: the fill (CDP `Input.insertText`), the website and box checks, masks for filled boxes
  and authenticator QR codes, the shell's X access (with #411), and #644's two test nits.
- A1-4 agent tools and words; A1-5 mail (Q1's `find_mail` and `local+tag` addresses); A1-6 Settings; A1-7 the
  account files. A clean-up job wipes a closed account's envelopes 30 days after it closed.
