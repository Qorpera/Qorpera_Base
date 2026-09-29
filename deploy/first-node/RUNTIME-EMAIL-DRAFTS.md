# Gmail draft cards

The draft widget is implemented and integration-tested, but its full live
acceptance requires the deployment below. A separate live test of the existing
Gmail connector on 25 September 2026 verified one self-addressed send and a
subsequent Gmail read with the INBOX label; that does not validate this new route.

When asked to draft an email, the agent reads the connected Gmail profile and
uses `ask_member` with `surface: "draft"`, `platform: "email"`, and
`connectorId: "gmail"`. The member sees the trusted connected sender and can
edit To, Cc, Subject, and body, send, discard, or save to Gmail. Merely displaying
the card does not create or send a Gmail message. The final interaction answer
contains the exact confirmed content, so the agent can report what happened.

The connector adds `get_profile`, `create_draft`, `update_draft`, `delete_draft`,
and `send_draft`. Existing operations keep their catalog version and hashes.
The new migration only backfills missing grants from eligible active shared
company connections; revoked grants stay revoked. Gmail draft operations need
`gmail.compose`. Older authorizations must reconnect to grant it; sending an
unsaved card continues to use the existing `gmail.send` operation.

## Member action contract

`qorpera_get_email_draft(session, interaction)` returns the trusted sender,
content, and durable state. `qorpera_prepare_email_draft_action` admits the
member's exact edited content and selected execution sponsor, with a client
action UUID and SHA-256 of a random 32-byte capability. The browser sends only
that capability to `POST /v1/email-drafts/<actionId>?company=<companyId>`.
Provider credentials remain in the broker. Authorization and operation grants
are checked again when the broker claims the action.

The broker claims before calling Gmail. Lost responses and reloads reuse the
same action; an ambiguous provider outcome stays unconfirmed and cannot start
a new send. Saving and sending an existing draft updates its MIME content
atomically with the provider call. Confirmed terminal results are persisted
before notifying the agent; notification recovery never sends another email.

## Rollout

1. This release uses v126, generated from the reviewed source tree on top of
   master v113. Versions v114–125 were reserved by other open PRs, not required
   predecessors. Verify `npm run check:runtime-bundle` on the exact release
   commit before deployment. If another runtime change lands first, regenerate
   from that combined tree in a new activation above the latest shipped version.
   Other queued PRs must likewise recut above v126 after this release; never
   apply their older provisional activations to roll the runtime backward.
2. Apply `20260925125900_gmail_draft_catalog.sql` and
   `20260925126000_member_email_drafts.sql` before activating that bundle.
3. Build and roll the broker and runtime from the reviewed source, then deploy
   the web app. Configure Gmail OAuth consent to include `gmail.compose` and
   reconnect existing Gmail accounts to enable provider draft operations.
4. Add this member route beside the capture/OAuth routes on the public broker
   nginx. It uses the existing company routing map and broker member-origin
   CORS configuration. Do not log bodies or cache responses.

   ```nginx
   location ~ "^/v1/email-drafts/[0-9a-fA-F-]{36}$" {
       limit_except POST OPTIONS { deny all; }
       if ($qorpera_capture_broker = "") { return 404; }
       proxy_pass http://$qorpera_capture_broker;
       proxy_read_timeout 70s;
       proxy_cache off;
   }
   ```

   Node 1's front (as found on 2026-09-29) routes this location with a `?company=` map of its own,
   `$qorpera_email_draft_broker`, in place of `$qorpera_capture_broker`; the shared vault's install adds
   its line there too (RUNTIME-LOGIN-VAULT.md, node 1 step 6).

   Validate `nginx -t` on the target before reloading; this new location has
   not been tested on the production proxy.
5. With a designated test mailbox, verify draft card rendering, edits, save,
   update, send, discard, lost-response recovery, contributor authorization,
   revoked grants, and exact final content returned to the agent. Also verify
   a new hire receives the new tools. Never count an unconfirmed send as sent.

## Local validation

Focused web and broker tests cover the card, transport recovery, and provider
request recipes. SQL test 620 covers authorization and durable action state;
SQL test 397 and `scripts/test-gmail-draft-catalog.mjs` cover catalog and grant
backfill behavior in disposable PostgreSQL. The browser preview uses mocked
delivery callbacks and sends no email.

`node scripts/test-email-draft-e2e.mjs` runs the production client through real
loopback HTTPS, the HTTP broker, the restricted PostgreSQL authority, all
migrations, and the Gmail adapters. It verifies save, edit/update, send,
replay without a duplicate send, reopening the card, and exactly one durable
answer containing the approved content. Only OAuth/Gmail responses are
simulated; it does not test a real LLM turn or deliver real mail. Its database,
certificate, and keys are disposable. Both this check and the lighter HTTP
integration tests run in CI.

Crash recovery is covered by SQL test 620: an execution that outlives its
deadline reports an unconfirmed outcome, retains its send lock, and can
still accept a late provider receipt.

An admitted action that expires before the broker claims it can be recovered
without its browser token: reading the card fails that pending action and
restores editing. An executing action is never unlocked by that recovery.
After any lost action response, the card requires Refresh before accepting a
different action or edits, so Send cannot silently retry an earlier Save.
