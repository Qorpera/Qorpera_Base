# Several Company Computers per company

**Words.** In product text (contract amendment 2026-09-28, "compute for
agents"), a *computer* is what an agent opens (a screen here) and a *machine*
is the VM that hosts up to six of them (a Company Computer, `office` in code).
This page uses the code's words: "computer" is the machine, "screen" is the
computer.

A company can run more than one Company Computer. An agent gets a screen on
whichever computer has room; when every running computer is full, the company
gets another one. Contract section 12 and the 2026-09-16 amendment already
said so ("six desktop screens per Company Computer ... an additional Company
Computer for the same company starts when all screens are occupied"); until
migration `20260929010000` the computer table allowed one row per company
environment.

## What changed in SQL

`20260929010000_runtime_company_computer_sets.sql`

- `qorpera_runtime_offices.environment_id` is no longer unique. Computers of
  one environment are numbered from 1 (`computer_number`, unique per
  environment, never reused).
- Everything below the company was already keyed by computer: generation,
  start intent, allocation, provider, activation, idle cycle, screens, access,
  browser profiles and grants. Each computer keeps its own lifecycle.
- `qorpera_add_runtime_office_computer` (internal) adds the next computer. It
  copies the image, bootstrap and screen count of the company's newest
  computer, so any host prepared for this company can run it. The existing
  insert triggers give every active agent default access and a company browser
  profile on it. `qorpera_runtime_office_additions` records who asked
  (an agent's run, or an owner or admin opening an agent's computer) and which
  computer was copied.
- `qorpera_register_runtime_office` and `qorpera_member_office_catalog` keep
  meaning "computer 1". Clients that predate several computers see computer 1.

`20260929010100_runtime_company_computer_seats.sql`

- **Screens are seats.** A screen is in use while an agent holds its lease, a
  member watches or drives it, a drain or takeover is pending, agent resources
  on it have not drained, or it was opened in the last two minutes. A computer
  is full when `max_screens` of its screens are in use. Before, an agent that
  had ever used a computer kept a screen row there for good and rows were
  capped at `max_screens`, so a computer was full after six different agents
  had ever used it. Rows stay capped at `max_screens` (the guest keeps a
  desktop for every open row); once every display number has a row, the screen
  unused for longest changes hands, closed with a new generation and epoch, so
  the guest closes the previous agent's desktop.
- **One computer per agent at a time.** Taking a seat on one computer while
  the agent's screen on another running computer is in use is refused
  (`SCREEN_OCCUPIED` for runs, `AGENT_ON_OTHER_COMPUTER` for members).
- **Placement** (`qorpera_runtime_office_placement`), in order:
  1. `screen`: the agent's screen in use on a running computer;
  2. `room`: a running computer with a free seat, the one the agent used last
     first, then the lowest number, so extra computers can go idle;
  3. `stopped`: a computer that is off after its idle time, woken (agent's
     last first);
  4. `starting`: a computer already starting, waking, or back from a host
     reboot. A burst of demand never adds two computers;
  5. `unstarted`: a computer that was added but never started;
  6. `new`: every computer is running and full;
  7. `denied`: the agent's computer access is revoked on every computer; no
     computer is added around a revoked grant;
  8. `none`: no computer the agent can use (none registered, or one is in
     maintenance for another reason, which waits for its owner as today).
- Computer access is company-wide: changing an agent's grant (state or
  capabilities) on one computer changes it on all the company's computers, and
  a grant created on a computer (a new computer, or an agent hired again)
  takes the agent's grant on the others, so a revocation is never lost.
- A computer already waking counts first among stopped ones (labelled
  `starting`), so repeated asks wake no second computer.
- The native tool descriptor offers screen tools on `screen`/`room`. The start
  descriptor offers `computer_start` for `starting`/`stopped`/`unstarted`, and
  on `new` adds the next computer under the company fence and the seat lock.
  `qorpera_native_office_start` locks every computer of the company in one
  order before reading the descriptor.
- **Idle.** A computer stays on only for its own leases, viewers, resources,
  start waiters and activation wakes, and the runs of agents placed on it
  (patched in place, so other patches of the idle check commute). With one
  computer, or the switch off, every run is placed on computer 1, as before.
  Stopped computers already give their node CPU and memory back
  (`20260923060000`, bundle v82).
- `qorpera_runtime_office_setup_queue()` (service role) lists computers that
  need a host: started ones waiting for `setup` or `room`, and added ones not
  started yet (`unstarted`), with the image, bootstrap and screen count each
  needs. It names no node: which node runs a computer is the fleet placement's
  decision (Stateless Compute, 28 September: any node with room).
- `qorpera_member_agent_office(environment, agent)` tells the web which
  computer shows an agent's screen, its number, how many computers the company
  has, and why a started computer is not up yet (`setup`: no prepared host has
  offered it; `room`: prepared hosts have no room). An owner or admin opening an
  agent's computer when every one is full adds the next one, as an agent can.

**Switch.** `qorpera_runtime_office_scale_out` (one row, off by default) keeps
placement on each company's first computer, exactly as before (with seats).
It stays off until both hold:

- every runtime can reach any of a company's computers: an old runtime refuses
  a computer other than its one configured office and would fail the run
  (company native routes, configured);
- the company folder is mounted on company computers. Today it is not
  (`canonicalMount: false`): an agent's files sit in the computer's scratch
  area and reach the company folder only through `computer_transfer`, so a file
  made on computer 1 would not be visible on computer 2.

Then:
`update public.qorpera_runtime_office_scale_out set enabled = true, changed_at = clock_timestamp();`

The new helpers are granted to the owners of the functions that call them
(runtime authority functions have private owners in production).

Lock order: company GC fence, then the environment's seat lock
(`qorpera_lock_runtime_office_seats`, a transaction advisory lock), then
computer rows. Taking a seat takes the seat lock before the computer row;
adding a computer takes the fence first.

## Scratch area and company files

Each computer has its own scratch area on the NAS (the contract's
workbench): tool settings, caches, browser history and temporary files, never
company files, one writer each. Company files live only in the one company
folder on the NAS, which every computer reads and writes directly (contract
5.6; 2026-09-27 amendment: the workbench holds no work files). Browser sign-ins
are secrets: they never enter the company folder.

## What it does not do yet

- **Hosts.** Adding a computer records demand; a node must still offer it
  (see `deploy/office-fleet/README.md`). Until then its start waits
  (`waiting: setup`). Nodes are to be identical and a computer is to start on
  any node with room (Stateless Compute, 28 September); that work belongs to
  the "Identical nodes and placement for every machine" session. Copying another
  computer's node-specific setup is not the way.
- **Runs reaching computer 2.** A native job reaches one configured office URL.
  Company routes (`/office/{companyComputerId}/native`) are a separate runtime
  change; the switch above stays off until it is live.
- **Continuing elsewhere.** An agent waiting for a new computer continues when
  that computer activates, not when a seat frees on another computer
  meanwhile. A new message to the agent places it again at once.
- **Browser sign-ins across computers.** The sign-in store is kept per
  computer today. Computers share no directory (each has only its scratch
  area) and sign-ins must not enter the company folder, so keeping them in
  step across a company's computers needs a vault-backed store; that belongs
  with the "logins into the vault" work.

## Tests

`supabase/tests/627_runtime_company_computer_seats.test.sql` runs the real
registry, access, native authority and member RPCs (guest readiness is
synthetic): seats and the lifetime-cap fix, adding computer 2 once, the wait
reason, one computer per agent for members and runs, idle demand per computer,
the start descriptor adding computer 3, the switch, revoked access, and seat hand-over.
