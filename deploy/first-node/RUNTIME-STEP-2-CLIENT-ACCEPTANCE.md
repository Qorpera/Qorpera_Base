# Step 2: packaged client and legacy-computer interlock

Date: 2026-08-28. **The packaged-client preview gate passed. The legacy-computer
cutover bypass is now blocked. Step 2 is not yet complete.** This interlock is
not shared-desktop path mediation, off-node identity recovery, or production
cutover approval. Step 3 remains paused and separately preserved.

## Scope and source

The active Step 2 checkout remains `/tmp/qorpera-step2-resume.rN3rbf/source`,
on `codex/runtime-step2-fenced-cloud` at
`b2b7215a660807dfbcde628cdfeca6b4d2423489`. This continuation adds uncommitted
preview isolation, its tests, the interlock migration/test, and this record.
It preserves the prior documentation changes. No commit, push, tag, public
release, production SQL change, NAS remount, provider-credential export, or
agent rerun occurred. No Step 3 source, SQL, wake policy or producer was imported.

## Isolated packaged-client acceptance

`--cloud-preview=/absolute/path/preview.json` is an explicit non-production
launch, not an outage fallback. A closed config selects a distinct Supabase
project and HTTPS services. The private state directory is pinned to those
endpoints, separate from the regular account, model store, company registry,
GitHub state and Chromium session. Endpoint changes require a fresh directory.
The app disables update checks and login-item changes in this mode. It does
not change OS `HOME`, copy regular model credentials, or weaken cloud authority.

The offline workspace build and normal shell packager produced an unpublished
macOS app using the current compiled source. The preview has a separate bundle
identifier, `com.qorpera.base.cloud-preview`, and no `qorpera://` registration.
The first packaging config inherited that protocol despite an empty override;
the final config is independent and the generated plist was checked before
launch. Ad-hoc signature verification passed. Seven relevant packaged modules
matched the compiled source byte-for-byte. This is not a notarized installer,
updater test, or public release. The packager reported a missing local Node
runtime; this preview does not establish local-agent startup or a full release.

Three separate preview state directories restored real, verified Supabase Auth
sessions for the existing synthetic owner, friend and unrelated user. No smoke
flag, fake IPC, mocked API, client service-role credential, or local company
argument was used. This verifies session restoration, not interactive OAuth login.
The company, permissions, objects, commands and publication remained in the
real managed preview `hurfdoempkqpzxggemhc` and cloud NAS gateway.

Observed in the actual packaged UI:

1. Owner opened the company from the company hub, then Settings → Company →
   Company File. The window identified the state as cloud-authoritative.
2. The previous real-GPT `docs/answer.txt` was readable and unchanged.
3. Owner created `docs/desktop-acceptance.txt` through the normal file editor.
4. A protected draft showed exact current/proposed contents. Choosing **Skip
   change** rejected it and reloaded the unchanged original file.
5. A second protected draft required the explicit **Apply exact change**
   confirmation, then published successfully.
6. A separately launched friend client opened the same company and read the
   owner's new file. Reading the owner's private canary path returned 403.
7. The unrelated user's hub showed only New company, not the test company.

A read-only cloud witness independently verified both member identities,
three identical file versions/hashes per member, non-member denial and private
path denial. It found exactly these durable human commands:

| Command | Outcome | Company revisions |
| --- | --- | --- |
| `1ff47447-f83b-437d-bdf5-0206413efa63` | New file applied | 1 |
| `b808fdd7-8d4a-4cfa-9061-bfb28ad887ad` | Protected draft skipped/rejected | 0 |
| `bf2bd237-864d-4dda-9e9e-da7f4ad6d6c8` | Exact protected edit approved/applied | 1 |

The resulting head is `3513e26b-9779-4896-8ec3-f84f3d23faf9`. The original GPT
answer retains version `0443cbcf-8a09-432e-a070-4f1960bd63b4` and SHA-256
`a1036db0548896bb380fdc2d6610d243dfb91efdaca32c5d088e38a2dc22c5e8`.
There were no duplicate revisions, new model calls, or active runner jobs.
All preview app processes were closed. The regular app's four recorded account,
model and registry files retained their original hashes. Display metadata is
local; the canonical `docs/` and private Company File trees were not checked out.

## Legacy-computer cutover interlock

The old Company Computer gives its shell and desktop a raw NAS-backed company
tree. A disabled/retired label does not prove that mount or an old process is
gone. A caller-supplied `mediated` policy flag is not a security boundary.

Migration `20260828013500_legacy_company_computer_teardown.sql` installs an
immutable, service-only physical-teardown attestation before migration
`20260828014000_company_path_computer_interlock.sql` guards the core
logical-computer and Company File tables. Neither imports the older managed
computer registry or creates a second capability store. Registration,
attestation and enrollment use the same existing profile fence. The interlock
rejects:

- enrollment while any legacy Company Computer binding remains;
- Company Computer registration or sandbox conversion after enrollment;
- relabelling a legacy computer's company/class to hide its old binding; and
- migration over a governed/legacy combination without the exact teardown
  attestation.

Unenrolled companies and their current computers are unchanged. The migrations
do not stop, delete, detach, or claim to mediate any running desktop. Physical
unmount/teardown evidence is required before the cloud may register the exact
attestation; the retained legacy row then becomes immutable.

The current disposable database proof passes all 89 migrations and SQL suite
297. A production-schema compatibility proof also installed all 15 proposed
delta migrations and demonstrated that an unresolved synthetic overlap makes
`14000` roll back, while the exact pre-interlock `13500` attestation admits only
the retired historical row. The final fixture explicitly scopes its empty-tree
cache lookups to its own company, including when another company has identical
immutable bytes.

The exact `13500` and `14000` migration SHA-256 values are respectively
`5e26ac0d8e80e5b6015f6bdffb92664923d108d412a9320ef7049cec88d0d865`
and `dfe250f36e3db5712e978abf43cfdf6bbe06a2b023af9353df65cf1357dc6413`.
These current bytes have not been installed in the managed preview or
production. Production SQL and computers are unchanged.

## Checks and evidence

- `npm run check` passed with no diagnostics or formatting changes.
- All 44 focused preview/Auth/file-window tests passed, including 28 new
  preview isolation tests.
- Offline build, unpublished packaging and signature checks passed.
- Real UI, independent member transport and read-only database witnesses passed.
- Disposable SQL, both concurrency orders, unsafe-upgrade rollback and managed
  preview SQL passed. No full Vitest or full database suite is claimed.

The continuation evidence is retained under the workspace's
`.artifacts/runtime-step-separation-20260828/step2/verification` with exact source
and test hashes. It excludes real Auth tokens, provider credentials, private
canary bytes, private app logs and signing keys. The Computer Use skill was
used for actual UI verification; cumulative distinct-skill count is **8/10**.
The original Computer Use screenshots expired from temporary storage before
collection. The observed UI sequence above is retained with independent cloud
records; later read-only screenshots are labelled separately, not presented as
new approval, skip or non-member actions.

## Remaining gates — not silently reclassified

1. **Shared-computer path mediation.** The interlock closes unsafe admission;
   it does not make the old raw filesystem safe or supply governed shared
   desktop/shell access. That capability must remain unavailable for governed
   companies until its authority boundary and live tests exist.
2. **Off-node Compute Identity recovery and fencing.** The existing master key
   is on the per-identity LXD volume. The first-node recovery contract requires
   a company-signed, identity/policy/revision-bound sealed recovery object,
   rejection of replay/rollback/wrong identity, an authorized replacement
   login VM, and a durable recovery receipt. VM restart and same-node import
   do not prove this. Key custody/authority and replacement-node activation
   must be approved before moving or releasing real recovery material.
3. **Production cutover.** Recheck/reconcile the two missing NAS memory files
   without overwriting live state, retain the legacy workbench, and coordinate
   reviewed SQL/gateway/guest/client installation. Public release and production
   enrollment remain separately approval-gated.

The [v52 native acceptance](RUNTIME-STEP-2-V52-ACCEPTANCE.md) remains valid
historical evidence. Its jobs and credentials were not rerun or replaced by
this client test. Step 3 handoffs remain preserved for later review.
