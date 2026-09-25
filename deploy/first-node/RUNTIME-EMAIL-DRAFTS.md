# Gmail draft cards

Implemented locally; not deployed or accepted against a live Gmail mailbox.

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

1. Coordinate the next runtime bundle number with the merge queue. The branch
   uses provisional v126 after v125; recut from the final merged tree.
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
   }
   ```

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
