# Changelog

## [Unreleased]

### Removed

- `NativeSubscriptionControl.approveSessionTurnSponsorship` and its input type: a member can no longer ask another member to pay for a turn. `requestSessionTurn` refuses the `sponsorship_request` mode before any call; turn provenance still reads it on older requests.

### Added

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

### Changed

- `cloudAgentFolder(companyId, staffAgentId, place?)` takes where the company keeps its agents' folders (`CloudAgentFolderPlace`): `agents/<staffAgentId>` for a snapshot-v1 company (`CLOUD_AGENT_FOLDER_BY_ID`, the default) and `agents/<handle>` for a folder-v2 company, the handle checked against the company folder's naming rule.
