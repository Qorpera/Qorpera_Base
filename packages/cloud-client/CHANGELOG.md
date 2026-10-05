# Changelog

## [Unreleased]

### Removed

- `NativeSubscriptionControl.approveSessionTurnSponsorship` and its input type: a member can no longer ask another member to pay for a turn. `requestSessionTurn` refuses the `sponsorship_request` mode before any call; turn provenance still reads it on older requests.

### Added
- A coding session's brief (C3a, `deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md` §8 "Plan (C3)"): a worker brief with `species: coding` names `harness` (codex, claude-code), `repository` (`github.com/<owner>/<name>`) and `base_branch`, and its parse gives `harness` and `repository` (`{host, owner, name, baseBranch}`, as the coding tables hold it). An in-house brief names none of them. `writeWorkerBriefFile` writes them and `appendWorkerFollowUp` keeps them.
- Interfaces and tables in the state files (folder core P16b, `deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md` §8 "Plan (P16)"): `companyStatePath` names `interfaces/order.md`, `interfaces/<name>/interface.toml`, `tables/<name>/table.toml` and `tables/<name>/rows.csv` by their shape (kinds `interface-order`, `interface`, `table`, `table-rows`), so every writer sends them as structured entries; `companyStatePathProblems` checks their folder's name and asks no `.md` of them; `parseCompanyStateFile` answers with `parseInterfaceStateFile`. `companyStateSeedTree` seeds `interfaces/` and `tables/` with `interfaceLibraryFiles` (ids from the new `newId` option, random by default), and `COMPANY_STATE_SEEDED_PATHS` gains `interfaces`, `interfaces/order.md`, `tables` and `tables/areas` with its two files. Needs migration 20260930016000 (P16a) first.

- `cloud-routine-file`: a routine file's trigger as the routine list reads it (`cloudRoutineTriggerOfFile`, the twin of the index's `qorpera_company_state_routine_trigger`), the file's trigger for what a member's editor makes (`routineFileTrigger`: every N minutes, days at a time) and the settings an edit changes (`routineFileSettings`, for `setCompanyStateSettings`; when the zone changes, quiet hours without a zone of their own keep the one they went by in `quiet_timezone`). `CloudMemberFolderClient.stateFolders()` reads routines' files too (`routines`, null where the cloud does not list them yet). Folder core C4, slice P34r.

- `CloudMemberFolderClient.commit(operationKey, units)` sends a member's change set to the object gateway's member commit route and parses the core's answer unit by unit (`parseCloudMemberFolderCommit`); `stateFolders()` reads the live agents' and group chats' files the member may read (`parseCloudMemberCompanyStateFolders`). Folder core C4, slice P34a.

- The folder hook's entry point for interface files (folder core P16, with F2; `RUNTIME-INTERFACES.md` §6.1): `parseInterfaceStateFile(path, text)` answers in `parseCompanyStateFile`'s shape for `interfaces/order.md`, `interfaces/<name>/interface.toml`, `tables/<name>/table.toml` and `tables/<name>/rows.csv` (kinds `interface-order`, `interface`, `table`, `table-rows`), and null for every other path. The kind comes from the path's shape, so a badly named folder is refused, never saved plain. `parseTableRowsText` reads a rows file without its definition (`TableRowsFile`: the header and each row's raw fields), which the database types against the definition at commit. `test/fixtures/interface-state.json` pins the answers for the SQL side. A table's key can no longer be a number, money or percent column, and a link's length counts code points. `test/fixtures/table-rows-typed.json` pins how rows are typed. `InterfaceProblemCode` gains the save check's codes `placement`, `main`, `owners`, `write` and `areas`.

- The member's file mode may be `folder`, a folder-v2 company (folder core C4, slice P33): `CloudMemberCompanyMode.mode` and `parseCloudMemberCompanyMode` take it. `CloudMemberFolderHints` follows a folder-v2 company's hint (`qorpera-folder-<environmentId>`, event `folder`; `cloudMemberFolderHintTopic`, `parseCloudMemberFolderHint`), joins again 10 s after a closed channel is removed, and calls back with each seq.
- Worker briefs and results with sections (F2's F2-5b-1, `deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md` §8 "Plan (F2-5b)"): a `brief.md` body is `## Goal`, `## Done when`, `## Context`, `## Sources` (`- <path>` items), the platform's `## Authority`, `## Output`, `## Cancellation` and `## Completion`, and `## Follow-up` (the latest), with the new settings `follow_ups` and `followed_up_at`; a `results.md` body is the summary, `## Needs` exactly when blocked, and `## Files`. Their parses give each section (`goal`, `doneWhen`, `context`, `sources`, …, `followUp`; `summary`, `needs`, `files`) in place of the whole body, within today's tool bounds. `writeWorkerBriefFile` and `writeWorkerResultsFile` write them and refuse model text that would start a section (`workerTextHeading`); `appendWorkerFollowUp` adds a follow-up; `workerStandingTexts` gives the platform's texts; `workerKeyProblem` holds a worker key to the folder naming rule. Nothing writes worker files yet.
- `CompanyComputerEffectContext.fill`: a company account fill's box, sealed to the computer's boot key, carried beside a `vault_fill` action (company accounts A1-3b); `CompanyComputerActionNotStartedError` takes `ACCOUNT_FILL_UNAVAILABLE`, `ACCOUNT_FILL_UNOPENED` and `ACCOUNT_FILL_EXPIRED`.
- Human tasks on the folder core, the TS side (F2's H2a, `deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md` §8 "Plan (H2)"): `companyStateSeedTree` seeds the fixed folders `human-tasks/` and `contacts/` (Jonas, 2 October; contract 5.6) and the company skill `skills/human-task/SKILL.md` (`COMPANY_STATE_HUMAN_TASK_SKILL`); `COMPANY_STATE_SEEDED_PATHS` names the two folders; `humanTaskFolder`, `humanTaskProofPath` and `humanTaskNotePath` name a task's folder, proof (`proof/<kind>-<n>.<ext>`) and note; `humanTaskPersonChange` makes the person's change (one tick, done or declined) as every writer must. Inert until the database knows the rules (H2b) and a writer uses them (H3, H5).
- Added `company-state-shared` (Interfaces step I2b, agreed with F2): `companyPathKey`, `AGENT_COLOURS` and `AgentColour`. `company-state-files` re-exports them unchanged and `interfaces` imports them from here, so the state-file parser can dispatch to the interface parser without an import cycle. `CompanyStateProblemCode` now also takes the interface codes (`row`, `claim`, …), so one dispatch reports both. `decodeInterfaceFile(bytes)` decodes strict UTF-8 that keeps a leading byte order mark, so a `rows.csv` exported from a spreadsheet still hashes to its saved bytes.
- Added `interfaces`, `interface-query`, `interface-library` and `toml-subset` (Interfaces step I2, `deploy/first-node/RUNTIME-INTERFACES.md`; inert, nothing calls them yet):
  - `parseInterfaceFile`, `parseTableFile`, `parseInterfaceOrderFile` and `parseTableRows` read `interfaces/<name>/interface.toml`, a table folder `tables/<name>/` (`table.toml` with `rows.csv`), and `interfaces/order.md`, with closed key sets and `{ line, key, code, message }` problems;
  - `tableClaimProblems` is the "nobody assigns anybody" rule for `needs_yes` columns (take, release, an accepted offer, agents acting for their supervisor);
  - `queryInterfaceRows`, `interfaceSeries`, `interfaceLookup` and `fillInterfaceText` read rows for a block;
  - `INTERFACE_LIBRARY` and `interfaceLibraryFiles` hold Pulse, Mailbox and Members with their tables;
  - `parseTomlSubset` is the strict TOML 1.0 subset these files use: linear time, line numbers per key, every key an own property. It adds no dependency.
- Connection files of a website account (`service: website`, A1) read `site` (the host, by the vault's rule), `two_step` (`none`, `authenticator`, `email`, `sms`) and optional `opened_for` (a todo id), and take the statuses `pending` and `needs_person`; `writeConnectionFile` writes them. The keys are refused on any other service, whose parse keeps its exact shape (F2's A1-7a, `deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md` §2). Inert until the database knows them (A1-7b) and A1's vault writer writes such files.
- Company state files read two more kinds (F2's H1, `deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md` §2): `human-tasks/<name>.md`, work an agent hands to a member or a contact (status, the person, the asking agent and its todo, due, minutes, proof, files, reason, the secret's label and state, and for a takeover the connection and step; the `## Steps` checklist parsed with its line numbers; `files` entries held to the folder's path rule), and `contacts/<name>.md`, an outside person or firm (name, organization, email, phone, asks; notes in the body). `writeHumanTaskFile` and `writeContactFile` write them; the path checks cover `human-tasks/<t>`, `human-tasks/<t>/proof` and the two top folders. Inert until the database knows the kinds (H1b) and keeps their index (H2).
- `CloudRunnerControlRequest` has a `start` action: an acceptance plus, in the same transaction, the broker description and (with `nativeLeaseSeconds`) the native authority.
- `CloudRoutineEventTrigger`: a routine listener on one of the company's hooks (`kind: "listener"`, `source: "event"`, `hookId`, optional `only` event types). `parseCloudRoutineTrigger` reads it with the cloud's rules and `describeCloudRoutineTrigger` words it ("When a hook receives an event", or the event types).
- Added `cloud-agent-folder`: `cloudAgentFolder(agent)`, the one resolver of an agent's folder in the company folder (contract 5.6), `agents/<staffAgentId>` until agents have named folders with an `agent.md` index.
- `CloudMemberCompanyAccessDenied`: the member Company File client's refusal (401/403) is now its own error class, with the same message, so a caller can tell a closed folder from an outage.
- Added `cloud-skill-file`: the one SKILL.md parser and writer (name rule, YAML front matter with `description`, body, line endings kept) shared by the runtime skill tools and the web client.
- Added `CloudMemberCompanyComputerClient.agentComputer()` (the computer that shows an agent's screen; `undefined` on a backend without it) and the `AGENT_ON_OTHER_COMPUTER` screen refusal.
- `SupabaseCloudPresenceTransport` takes any client with `channel`/`removeChannel` and just the three presence device calls (`PresenceDevices`), so the web app joins presence without the whole hosted primary.

- `CloudCompanyComputerStart.withdraw(generation, requestId, signal)` takes back the member's own idle wake request (`qorpera_withdraw_runtime_office_wake`). It never cancels the wake or a first start; it lets idle stop the computer one minute after it is up once every requester has withdrawn and nothing used it.

- Browser-safe member session-image upload and canonical-input download transport with Web Crypto integrity checks, immutable selections, bounded responses and no automatic mutation retries.

- Shared browser-profile and account-cleanup session controllers, reused by desktop and the independent member web application without Node crypto or runtime imports.

- Shared read-only native Company File activity display with current member authorization, bounded signed candidates, verified sequence tracking and clearing on selection, connection and account changes.

- Shared owner-only browser profile discovery, named registration, versioned consent and account-level cleanup discovery after company membership removal. Private reconnect waits for acknowledged drains and retains the exact owner challenge without requesting shared takeover.

- Shared explicit screen connection with fresh scope/generation checks, one takeover request and bounded waiting for physical acknowledgement. Reconnection does not restore control automatically; uncertain requests require status recovery.

- Shared member Company Computer discovery and authenticated adapters for start, access, sign-in and viewer APIs, with bounded agent pagination and exact company scope checks.

- Shared member export discovery and verified binary downloads selected by immutable asset ID and hash. Current membership and completed shared receipts are checked before and after reading; no office connection is required.

- Shared browser-safe member Company File editing, exact binary uploads up to 8 MiB, destination inspection and verified pending-file downloads. Source and chunk identities remain bound to the original command through protected human review and retries.

- Shared member Company File reads and explicit version-selected downloads across desktop and web. Native Web Crypto verifies closed manifests, every chunk and complete binary content; current path authority is checked again before returning bytes and immutable source hashes. No member filesystem or runtime credentials are exposed.

- Added closed Company File write selections for completed object-storage exports. The source uses an asset ID and hash; the destination remains a governed Company File path with an exact version and operation key.

- Added explicit Company File path/version selections for workbench imports, closed source metadata and historical receipts with retained manifest and content identity. No source path grants raw storage or member-device authority.

- Closed workbench import actions and historical transfer receipts that retain immutable source identity and explicit destination provenance. These schemas grant no source read permission.

- Shared member office capability administration with explicit desktop/shell grants, an observed version for each write, closed status recovery and no automatic mutation replay. Browser-profile consent remains separate.

- Shared closed file-export actions and immutable asset references with explicit source/destination realms, bounded relative workbench paths, byte counts and media types. Asset metadata grants no download authority.

- Added closed, browser-safe Company File presence schemas, signed payload encoding and object/subtree overlap matching. Native run registration and path authorization remain in the headless runtime and cloud.

- Shared signed member presence for desktop and web using Web Crypto with the existing Ed25519 wire format. Reconnection and shutdown discard obsolete publications and verification results.

- Shared browser-safe APIs for native sign-in, sponsored session turns, and exact run control.
- Shared Company File and computer representations, with explicit Node file and view transport subpaths.
- Browser protocol tests and dependency checks that reject imports of runtime authority.
- Shared sign-in intent, status recovery and private-access checks for desktop and web, with closed metadata schemas and no client-side execution or credential handling.
- Shared member screen discovery, explicit takeover intent, ticket recovery and exact cancellation APIs. The authenticated TLS WebSocket adapter provides a bounded noVNC raw channel without tickets in URLs or DOM attributes; reconnect never silently restores control.
- Shared office start, status recovery and exact cancellation APIs for desktop and web. Requests retain caller identity for reconciliation and expose no provider paths, credentials or guest execution. The common intent parser also validates native startup results.

- `company-state-files`: the shared reader and canonical writers for the company folder's structured files (contract 5.6; `deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md`): vision, agent, sections, group chat, connection, rule, routine, todo and worker brief and results. `parseCompanyStateFile` answers null for an ordinary file, the parse, or line-numbered problems, the same for the same bytes; `companyPathKey` classifies on the folder key; `companyStateName` and `freeCompanyStateName` make folder names; instants come back in one canonical form; `setCompanyStateSettings` changes typed settings and keeps every other byte. Nothing calls it yet.

- `companyStateSeedTree` lists a new company's seeded folder (vision, sections, the Co-Founder's `agent.md` with its first job, and the empty `agents/groups/`, `connections/`, `skills/`, `rules/`), with `COMPANY_STATE_SEEDED_PATHS`, `COMPANY_STATE_COFOUNDER_HANDLE` and `COMPANY_STATE_COFOUNDER_INSTRUCTIONS`. The founding table's `vision`, `founders` (a `- name: role` line each under "How we work") and `firstTodo` (at `COMPANY_STATE_FIRST_TODO_PATH`) go in too; it throws rather than seed a file that would not parse.
- An agent's instructions refuse control characters other than tab and line breaks.

- The interface parser refuses a `message` button that would fill in outside content it can't quote (`outside_value`; `RUNTIME-INTERFACES.md` §3.3, §4 and §6; Interfaces step I5d part 4a). `interfaceOutsideColumns(source)` gives a source's outside-content columns:
  - `mail`'s `from_name`, `from_address` and `subject`;
  - a `file:` source's `text` under `hooks/` or `human-tasks/`, by folder key.

  A button whose text names such a column of a source outside the quote list (`INTERFACE_QUOTE_SOURCES`: `mail`), or more than 16 of them, is refused, for every source a block reads. A client cuts each outside value to `INTERFACE_OUTSIDE_VALUE_MAX_CHARS` (2,000) before it fills it in. F2's I6 save check needs this before interface files are saved in the folder.
- `CloudMemberFolderClient`, a member's client for a folder-v2 company's folder (folder core C4, slice P27b; `deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md` §2): `read`, `list`, `pathHistory`, `history` and `changes` call the member functions (P27a), and `readFile` fetches a file's version-2 manifest and chunks through the object gateway's member folder route, each checked against its hash and the whole against the file's. Each answer is parsed with closed key sets (`parseCloudMemberFolderRead`, `…List`, `…PathHistory`, `…History`, `…Changes`, `…By`), the shapes SQL test 834 pins. Nothing uses it yet (P33). Its refusals (401, 403) are `CloudMemberFolderAccessDenied`, not an outage.

### Changed

- The seeded Co-Founder's `agent.md` has no colour (it was `blue`), so the web shows its native gold crown and a member can still pick blue for it.
- `parseTableFile` reads a choice as the folder hook checks it (RUNTIME-INTERFACES.md §6.1 rule 1; F2's P16a): 1–60 code points rather than UTF-16 units, and a choice holding a direction character (U+202A–U+202E, U+2066–U+2069) or a broken character is refused. Before, such a `table.toml` passed the client and was refused at commit.
- The worker brief and results parses (`WorkerBriefFile`, `WorkerResultsFile`) give their body's sections (F2-5b-1) in place of the whole body: `brief` and `report` are gone. Nothing wrote or read them yet.
- `CloudRunnerJob.substrateVersionId` is optional: a folder-v2 run has no Company File substrate (folder core C3, P23).
- `cloudAgentFolder(companyId, staffAgentId, place?)` takes where the company keeps its agents' folders (`CloudAgentFolderPlace`): `agents/<staffAgentId>` for a snapshot-v1 company (`CLOUD_AGENT_FOLDER_BY_ID`, the default) and `agents/<handle>` for a folder-v2 company, the handle checked against the company folder's naming rule. `isCloudAgentFolder(path)` tells such a folder from other paths.
