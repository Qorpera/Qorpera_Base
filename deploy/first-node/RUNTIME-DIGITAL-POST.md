# Digital Post in the company folder and the Mailbox

Founder request, 22 October 2026: "add the E-boks/institutional mail to the inbox … the agents will need to be able to
read that mail." Read only first; answering an authority comes later.

## What it covers

Danish public post to a company (Skattestyrelsen, Erhvervsstyrelsen, the municipality, courts, Udbetaling Danmark) is
Digital Post. e-Boks, mit.dk and Virk are only places to read it. Post from private senders in e-Boks (banks, insurers,
pension and payroll companies) is not Digital Post and has no official way in; it is not covered here.

## The official way in

Digital Post lets a business connect one system of its own to receive its post instead of the Virk mailbox (Technical
Integration v1.51, sections 2.4.1, 2.6.1, 10.6.2, 10.11 and 12.4; the Administrativ Adgang guide, sections 5.1.2, 5.4
and 15). Qorpera is that system for every company, as the company's system supplier:

- **Once, for Qorpera.** Qorpera ApS's MitID Erhverv administrator issues an OCES3 organisation or system certificate
  (a test one for Digital Post's test environment, then a production one). It goes into the vault's systemd credential
  as `digitalPost {environment, certificatePem, privateKeyPem}` in the connector service configuration, never through
  a chat or a file. Every call to Digital Post presents it (mutual TLS).
- **Once per company, by a member** who has Digital Post's system administrator right (granted in Rettighedsportalen):
  in Administrativ Adgang, Systemtilslutning → Opret system → Opsæt et nyt system → name "Qorpera" → Modtagersystem →
  protocol REST PULL → the vault's public IP addresses → "Giv din systemleverandør fuldmagt" = Qorpera's CVR →
  activate now → a contact email → Tilslut. The receipt shows the system's API key; the member pastes it into
  Qorpera's Settings, which sends it straight to the company vault (the vault's capture, connector `digital_post`,
  field `api_key`).
- Digital Post finds the company's system by that key, checks that the certificate's CVR is the system's supplier and
  that the call comes from a listed address. So the vault, which runs on the nodes with fixed addresses, makes every
  call; Supabase Edge functions never do.

**What the member must know** (the Settings card says it): once the system is active, new post no longer shows in
e-Boks, mit.dk or Virk; Qorpera is the company's mailbox. A letter Qorpera cannot take within seven days goes to Virk
instead, and Digital Post switches off a system that took nothing for seven days. Old post can be moved over with
Administrativ Adgang's "Flyt post", which deletes it there.

## The path of a letter

1. **Fetch (vault).** The company's vault claims the company's Digital Post sync when it is due, opens the key in
   memory, and lists the letters waiting (`GET /apis/v1/memos/`, at most 50 a call). For each it fetches the MeMo XML
   (`GET /apis/v1/memos/{id}`, at most 32 MiB), reads it (`readDigitalPostLetter`) and lays it out for the folder
   (`layOutDigitalPostLetter`).
2. **Keep (database).** The vault records the letter and stages its files in the database. A letter whose message id
   the company already keeps is a duplicate: Digital Post delivers at least once.
3. **Receipt (vault).** Only after the letter is kept does the vault send the business receipt
   (`POST /apis/v1/memos/{id}/receipt`). Digital Post deletes the letter then: from here the company folder holds the
   only copy. A duplicate is receipted again, as Digital Post requires.
4. **Write (object gateway).** The folder writer commits the letter's folder as the platform and rewrites the index
   `digital-post/letters.json`, then clears the staged bytes. The vault never commits to the folder
   (RUNTIME-COMPANY-FOLDER-CORE.md, "The vault never calls the commit").

A letter the vault cannot read (malformed, too large, not a MeMo letter) is held: not receipted, so Digital Post keeps
it and moves it to Virk after seven days. The sync records it so it is not fetched again on every pass, and Settings
says how many letters went that way.

**The sync (part 2, migration `20260930529000`).** One row a company in `qorpera_digital_post_syncs`, following its
`digital_post` secret: a connect or a new key is due at once (`waiting`); a pass that took every letter listed is
`current` and due again in ten minutes; a full list (50) from which it took a letter is due again in thirty seconds;
a failure is tried again after five minutes, doubling to two hours, with a fixed phrase for Settings; a key Digital
Post refuses (401) is `refused` and nothing is due until the member saves a key again; a Disconnect (the secret's
revoke) is `disconnected`. A pass holds a fifteen-minute lease; a late answer from an earlier claim is refused.
Letters are kept in `qorpera_digital_post_letters` by message id (unique per company, as is the folder by its key):
`staging`, then `kept` once every file's staged chunks give its size and SHA-256 (`qorpera_seal_digital_post_letter`),
then `written` (part 3). The staged bytes sit in `qorpera_digital_post_chunks`, 1 MiB each, until the folder writer
has them; a letter left `staging` by a pass that stopped starts again when it is next delivered. Held letters are in
`qorpera_digital_post_held` and forgotten after eight days. Since held letters stay on Digital Post's list, the sync
remembers where a pass stopped (`scan_page`): a pass reads at most 20 pages from there, and stops after a page where it
receipted something (the next pass reads that page again) or at the end of the list (the next starts from the first
page), so every letter is reached however many are held before it. `qorpera_digital_post_settings` is the platform's
one row that operators set: the Digital Post environment, Qorpera's CVR and the vault's public addresses, which the
setup steps show. `qorpera_member_digital_post` gives any member the connection's state (supabase/CLIENT-CONTRACT.md,
"Digital Post").

## In the company folder

```
digital-post/
  letters.json                       the index the Mailbox reads (platform-written; newest first)
  2026/
    2026-10-22 Skattestyrelsen - Årsopgørelse 2025 (6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a)/
      letter.md                      who, when, flags, deadlines, links, documents, the text
      letter.json                    every field Digital Post delivered (files by size and SHA-256)
      aarsopgoerelse.pdf             the documents, under the sender's names made safe
```

The day is the sender's (`createdDateTime`) in Danish time. `letters.json` is `{schema: "qorpera.digital-post-letters/v1",
letters}`, each letter the summary the vault kept (message id, folder, title, sender and its id, written and received,
the mandatory and legal-effect flags, the reply deadline, case id, file count, whether `letter.md` holds the text, and
a snippet), newest first, at most 200 and within 240 KiB.

**The writer (part 3, migration `20260930530000`).** The object gateway's `DigitalPostLetterWriter`
(`QORPERA_DIGITAL_POST_WRITER=1`) claims one kept letter of a folder-v2 company that is not being deleted, with its own
lease; reads each file's chunks back in pieces of at most 512 KiB and checks its size and SHA-256; and commits as the
platform, under `digital-post:<letter>:<attempt>`, one change set: `digital-post/` and `digital-post/<year>` when they
are missing, the letter's folder as one `new_folder` unit (in the folder whole or not at all), and the index at the
version the claim read. A letter's folder already there (an earlier commit whose finish was lost) gets only the files
it lacks; nothing in it is overwritten, and a path that holds something else (a folder or link where a file goes)
writes nothing and backs off. A company's letters are written one at a time, and the index lists what the folder holds:
every written letter and every kept one whose folder is already there, so a letter committed before its finish lands
is never left out. A unit not saved backs off (a minute, doubling to an hour) and the next claim
reads the folder again. A written letter's staged chunks are deleted. `letter.md` says the letter is outside content. The main
document's text comes from its text or HTML version; a letter that is only a PDF says so until PDF text is read (step
5).

## Agents

An agent wakes on new letters with an ordinary file-change routine: `when: file-change`, `watch: digital-post`,
`match: subtree`. Nothing new is needed for that. The member picks who reads Digital Post in the Mailbox (as with an
email address, the request goes to the Co-Founder, who sets the routine up). The agent reads `letter.md` and the
documents with the folder tools. Like event and file-change routines, such a routine is not paid by a ChatGPT plan.

## The Mailbox

The Mailbox lists letters from `digital-post/letters.json` in its Inbox among the email threads, newest first, with
the sender as the name and a Digital Post mark, and opens a letter from its `letter.md` with its documents. The
Addresses tab has a "Digital Post" row with the agents whose routines watch `digital-post`. It works whether company
email is switched on or not.

## Security

- The certificate's key is the vault's own credential; a company's key is sealed like any company credential and
  opened only for a pass, in the vault process. Neither reaches a log, a row in clear, a result or the folder.
- Unwrapping a company credential without a run is the bank sync's exception, not yet worded in contract 11.5; this
  sync takes the same one and the same bounds: the vault unwraps only to call Digital Post's fixed origin, and only
  the reduced letter leaves the adapter.
- The XML reader refuses document types and unknown entities, bounds depth and size, and logs no content.
- Every member and agent of the company reads its Digital Post, as with company mail (company-first). Letters can
  name people (an employee's CPR number in a letter about them).

## Build steps

| Part | What |
| --- | --- |
| 1 | Runtime, inert: the MeMo reader, the folder layout and the Digital Post client (`digital-post-memo.ts`, `digital-post-letter-files.ts`, `cloud-connector-digital-post.ts`) |
| 2 | SQL and vault: the sync (claim, keep, stage, receipt, finish), the vault loop and configuration, the capture check for `digital_post` |
| 3 | Object gateway: the folder writer and `digital-post/letters.json` |
| 4 | Web: the Settings card (steps, the key, the state) and the Mailbox (letters in the Inbox, the letter view, the Addresses row) |
| 5 | PDF text: the main document's text read from a PDF in a bounded worker, into `letter.md` |

## To check in Digital Post's test environment

- Whether a business's only recipient system may use REST PULL: the guide lists it for businesses, while Technical
  Integration 12.4.3 says default recipient systems use REST PUBLISH/SUBSCRIBE. If pull is refused, a small endpoint
  that only wakes the sync is added; the letter is still fetched by the vault.
- The vault's public IP addresses as Digital Post sees them, for the setup steps.
- The receipt body Digital Post expects from a recipient system (`messageUUID`, `receiptStatus`, `timeStamp`).
