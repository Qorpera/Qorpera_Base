# Several Company Computers per company

A company can run more than one Company Computer. An agent gets a screen on
whichever computer has room; when every running computer is full, the company
gets another one. Contract section 12 and the 2026-09-16 amendment already
said so ("six desktop screens per Company Computer ... an additional Company
Computer for the same company starts when all screens are occupied"); until
migration `20260928100000` the computer table allowed one row per company
environment.

## What changed in SQL

`20260928100000_runtime_company_computer_sets.sql`

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

`20260928100100_runtime_company_computer_seats.sql`

- **Screens are seats.** A screen is in use while an agent holds its lease, a
  member watches or drives it, a drain or takeover is pending, agent resources
  on it have not drained, or it was opened in the last two minutes. A computer
  is full when `max_screens` of its screens are in use. Before, an agent that
  had ever used a computer kept a screen row there for good and rows were
  capped at `max_screens`, so a computer was full after six different agents
  had ever used it. Rows now go up to display 32; past that the screen unused
  for longest changes hands with a new generation and epoch.
- **One computer per agent at a time.** Taking a seat on one computer while
  the agent's screen on another running computer is in use is refused
  (`SCREEN_OCCUPIED` for runs, `AGENT_ON_OTHER_COMPUTER` for members).
- **Placement** (`qorpera_runtime_office_placement`), in order:
  1. `screen`: the agent's screen in use on a running computer;
  2. `room`: a running computer with a free seat, the one the agent used last
     first, then the lowest number, so extra computers can go idle;
  3. `starting`: a computer already starting, waking, or back from a host
     reboot. A burst of demand never starts two computers;
  4. `stopped`: a computer that is off after its idle time (agent's last first);
  5. `unstarted`: a computer that was added but never started;
  6. `new`: every computer is running and full;
  7. `none`: no computer the agent can use (none registered, or one is in
     maintenance for another reason, which waits for its owner as today).
- The native tool descriptor offers screen tools on `screen`/`room`. The start
  descriptor offers `computer_start` for `starting`/`stopped`/`unstarted`, and
  on `new` adds the next computer under the company fence and the seat lock.
  `qorpera_native_office_start` locks every computer of the company in one
  order before reading the descriptor.
- **Idle.** Computer 1 keeps today's rule: every authorized run of the company
  keeps it on. Another computer stays on only for runs of agents placed on it,
  besides its own leases, viewers, resources, start waiters and activation
  wakes. Stopped computers already give their node CPU and memory back
  (`20260923060000`, bundle v82).
- `qorpera_member_agent_office(environment, agent)` tells the web which
  computer shows an agent's screen, its number, how many computers the company
  has, and why a started computer is not up yet (`setup`: no prepared host has
  offered it; `room`: prepared hosts have no room). An owner or admin opening an
  agent's computer when every one is full adds the next one, as an agent can.

Lock order: company GC fence, then the environment's seat lock
(`qorpera_lock_runtime_office_seats`, a transaction advisory lock), then
computer rows. Taking a seat takes the seat lock before the computer row;
adding a computer takes the fence first.

## What it does not do yet

- **Hosts.** Adding a computer records demand; a host must still be prepared
  for it (see `deploy/office-fleet/README.md`). Until then its start waits
  (`waiting: setup`). The one-command setup for a company's next computer is a
  separate change.
- **Runs reaching computer 2.** A native job reaches one configured office URL
  and the routes file allows one route per company environment. Several routes
  per company are a separate runtime change; until it lands, only computer 1
  can serve agent runs.
- **Continuing elsewhere.** An agent waiting for a new computer continues when
  that computer activates, not when a seat frees on another computer
  meanwhile. A new message to the agent places it again at once.
- **Browser sign-ins across computers.** The sign-in store is kept per
  computer today; keeping it in step across the company's computers is a
  separate change.

## Tests

`supabase/tests/627_runtime_company_computer_seats.test.sql` runs the real
registry, access, native authority and member RPCs (guest readiness is
synthetic): seats and the lifetime-cap fix, adding computer 2 once, the wait
reason, one computer per agent for members and runs, idle demand per computer,
the start descriptor adding computer 3, and seat hand-over past display 32.
