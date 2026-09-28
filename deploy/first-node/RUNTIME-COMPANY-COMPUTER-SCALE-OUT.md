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
migration `20260928237100` the computer table allowed one row per company
environment.

## What changed in SQL

`20260928237100_runtime_company_computer_sets.sql`

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

`20260928237200_runtime_company_computer_seats.sql`

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
- **No waiting for a seat** (Jonas, 28 September: "if a machine is full, the
  agent always should start a new one, not wait"; `20260928238000`). An agent
  waiting for a computer holds a seat on it: its start waiter on the
  computer's current generation, while it waits (its request's run did not
  fail) and, once woken, until its woken run ends (the clauses `has_demand`
  uses to keep the computer awake). Only for an employed agent with active
  access, once per agent, and not while it has a screen in use on a running
  computer. A computer is full when its screens in use and the seats other
  agents hold reach `max_screens`. Seats go first come: a holder counts only
  the seats held before its own, so a computer asked for by more agents than
  it has seats (starts in flight at the same moment) seats the earliest and
  the others are placed again. A start that no host has offered for 30
  minutes holds no waiting seats, so a broken setup does not add computer
  after computer. Held seats count only with the switch on.
- `computer_start` asks for its computer when the agent calls it, not when the
  run began (runtime), and a native start keeps the computer it names for its
  agent while that computer can be started (`qorpera.office_start_target`,
  set by `qorpera_native_office_start` around its descriptor read). So a start
  never moves under its agent, and a burst adds one computer for each
  `max_screens` agents without a seat.
- **Placement** (`qorpera_runtime_office_placement`), in order (switch on):
  1. `screen`: the agent's screen in use on a running computer;
  2. held: the computer the agent's start in progress names, while it can be
     started, then a running computer where the agent holds a seat (it was
     woken for it);
  3. `room`: a running computer with a seat nobody holds, the one the agent
     used last first, then the lowest number, so extra computers can go idle;
  3b. waited for: a computer not up yet where the agent holds a seat. A free
     seat on a running computer comes first; the wait's wake still comes when
     this computer is up;
  4. `stopped`: a computer that is off after its idle time, with a seat nobody
     holds, woken (agent's last first), only when its node would admit it now
     (switched on, seen ready with its inventory confirmed, its CPU by the
     node's budget and its memory fit what is left, counting other sleeping
     computers whose wake is requested). Waking it on another node is later
     work of the identical-nodes plan;
  5. `starting`: a computer already starting, waking, or back from a host
     reboot, with a seat nobody holds; a waking one only if its node takes it
     or no node has room for a new computer;
  6. `unstarted`: a computer that was added but never started;
  7. a sleeping computer whose node is full, woken anyway, only when no node
     has room for a new computer either (its wake waits for room, as before);
  8. `new`: no computer has a seat for the agent now or when it is up. A
     computer in maintenance for an update or reset, or whose start an owner
     cancelled, is passed over: never waited for, never replaced;
  9. `denied`: the agent's computer access is revoked on every computer; no
     computer is added around a revoked grant;
  10. `none`: no computer registered for the company (switched off, also a
     computer in maintenance for another reason, as before).
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
It stays off until all three hold:

- every runtime can reach any of a company's computers: an old runtime refuses
  a computer other than its one configured office and would fail the run
  (company native routes, configured);
- the company folder is mounted on company computers. Today it is not
  (`canonicalMount: false`): an agent's files sit in the computer's scratch
  area and reach the company folder only through `computer_transfer`, so a file
  made on computer 1 would not be visible on computer 2.
- a new computer is set up on a node with room without an operator (automatic
  setup, the identical-nodes session). Placement passes over computers that
  are updating, or cancelled, or asleep on a full node, and adds a new one
  (`20260928238000`); without automatic setup that new one would wait.

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
  the "Identical nodes and placement for every machine" session. Jonas (28
  September): automatic setup of a company's next computer is in scope now; it
  is built there, on any node with room, consuming the setup queue above.
  Copying another computer's node-specific setup is not the way.
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
`supabase/tests/628_runtime_company_computer_no_wait.test.sql`: a real native
start (authorize, receipt, begin, the check after completion) keeping its
computer while other agents' starts take its seats, first-come seats, a burst
adding computers, held seats (while waiting, until the woken run ends, once per
agent, not for archived agents, not on a stuck start, not with the switch off),
a sleeping computer passed over on a full, emptying or unconfirmed node only
while another node has room, a waking computer on a full node, and maintenance
or a cancelled start never waited for.
