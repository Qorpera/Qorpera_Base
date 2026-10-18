// C1-V's judgments (p3-c1v.mjs) pass a whole run's records and fail each of them broken: a busy window that proves
// nothing, an idle session counted busy, no question or another day's, an archive that leaves the loop or takes the
// sleeper, a machine that does not sleep once quiet. No run has read them yet, so the records are SQL's shapes with
// made-up values. The run-on-node plan's deploy-node step runs it, and prove-coding-session-vm.sh before it builds
// anything.
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeArchived, judgeAsked, judgeBusy, judgeC1V, judgeSlept } from "./p3-c1v.mjs";

const MACHINE = "6c1f0a52-8d3e-4b7a-9c21-5e0f4d7a3b19", OTHER = "6c1f0a52-0000-4000-8000-000000000000";
const S = "3b7e9d40-1c2a-4f6e-8b5d-9a0c7e2f4d61", S2 = "a8d2c6f1-5e3b-4a97-b0c4-2f1e8d7a6c35";
const SLEEPER = "01a1f2c4-6b0e-7d3a-9e51-4c8b2a7f0d13", LOOP = "01a1f2c9-0e4d-7a6b-8c27-d3f5b1e9a640";
const KEY = `coding-quiet:${S}:1760692323418:1`;
const stoppedEvent = (id, reason, text, stopped) => ({
	id, sequence: 11, kind: "text", actor: "executor", created_at: "2026-10-18T09:21:44.702113+00:00",
	body: { text: `${text}; 1 command was stopped`, reason, stopped },
});
const SLEPT = stoppedEvent(431, "SLEEP", "The machine went to sleep", [{ commandId: SLEEPER, turn: 7, command: "sleep 86400" }]);
const RECORD = {
	machineId: MACHINE, workerId: S, s2Id: S2, sleeper: SLEEPER, loop: LOOP, s2MachineId: MACHINE,
	busy: {
		since: "2026-10-18T09:13:05.418265+00:00",
		machine: { busyAfter: 71.20854, lastUsedAfter: -660 },
		s: { machineId: MACHINE, leaseAfter: 131.20871, observedAfter: 71.20854, busyAfter: -118.53017, running: [SLEEPER] },
		s2: { machineId: MACHINE, leaseAfter: 131.20871, observedAfter: 71.20854, busyAfter: 71.20854, running: [LOOP] },
		sleepEvents: [],
		entries: Array.from({ length: 6 }, () => ({ live: false, reserved: true, superseded: false, sleepDue: false, attached: [S, S2] })),
		sleeps: [],
		keeps: 7,
		lists: 9,
		vm: "RUNNING",
	},
	asked: {
		expected: KEY,
		wake: {
			occurrenceKey: KEY, status: "queued",
			summary: `This is not a new report. The coding session "P3 coding session" (repository qorpera-p3/proof, branch qorpera/coding/${S}) ` +
				"has had no turn for 1 day, with 1 command still running on its machine. Its last turn finished with a draft pull request.",
		},
	},
	archived: {
		event: stoppedEvent(412, "ARCHIVED", "Archived", [{ commandId: LOOP, turn: 1, command: "timeout 30m sh -c 'while :; do :; done'" }]),
		left: null,
		sleeperLeft: "4127 sleep 86400",
		s: { machineId: MACHINE, attached: true },
	},
	slept: { since: "2026-10-18T09:21:06.190288+00:00", event: SLEPT, after: 38.51182, suspendedAt: "2026-10-18T09:21:44.69804+00:00", vm: "STOPPED" },
};

test("C1-V judges a whole run's records a pass", () => {
	assert.deepEqual(judgeC1V(RECORD), { failures: [] });
	// S's busy clock never set at all is not a move either.
	assert.deepEqual(judgeBusy({ ...RECORD, busy: { ...RECORD.busy, s: { ...RECORD.busy.s, busyAfter: null } } }), []);
});

test("C1-V fails each broken record", () => {
	const shared = /^S2 does not share S's machine: /;
	const machineBusy = /^the machine's busy clock did not move after the backdate: /;
	const s2Busy = /^S2's loop did not keep S2 busy on the machine: /;
	const sleepEvent = /^S was put to sleep in the busy window: /;
	const kept = /^no keep after the backdate renewed S's attachment: /;
	const running = /^S's running commands are not its sleeper alone: /;
	const sBusy = /^S's own busy clock moved in the busy window: /;
	const entry = /^the executor's list did not show the machine reserved, with both sessions, no turn and not due to sleep: /;
	const sleepLine = /^the executor's housekeeping tried to sleep the machine in the busy window: /;
	const looked = /^the executor looked too seldom in 75 s: /;
	const awake = /^the VM is STOPPED after the busy window, not RUNNING$/;
	const noQuestion = /^no question for S's quiet day /;
	const notCounted = /^the quiet day's question does not say S has 1 command running: /;
	const archiveNames = /^S2's ARCHIVED event does not name its loop: /;
	const loopLeft = /^S2's loop still runs after its archive: /;
	const sleeperGone = /^S's sleeper does not run after S2's archive$/;
	const detached = /^S2's archive detached S: /;
	const noSleep = /^no SLEEP detach of S after S2's archive$/;
	const sleepNames = /^S's SLEEP does not name its sleeper: /;
	const late = /^S's SLEEP came .* s after the backdate, not within one housekeeping pass \(160 s\)$/;
	const asleep = /^the machine is not asleep: /;
	const cases = [
		// 1-3: the busy window.
		["S2 on another machine", (run) => { run.s2MachineId = OTHER; }, [shared]],
		["S2's keeps found nothing busy", (run) => { run.busy.machine.busyAfter = -570; run.busy.s2.busyAfter = -12.4; }, [machineBusy, s2Busy]],
		["the machine's busy clock not moved", (run) => { run.busy.machine.busyAfter = -570; }, [machineBusy]],
		["the machine's busy clock not set", (run) => { run.busy.machine.busyAfter = null; }, [machineBusy]],
		["S2 not busy itself", (run) => { run.busy.s2.busyAfter = -12.4; }, [s2Busy]],
		["S2's loop not seen running", (run) => { run.busy.s2.running = []; }, [s2Busy]],
		["S2 off the machine", (run) => { run.busy.s2.machineId = null; }, [s2Busy]],
		["a SLEEP detach of S in the busy window", (run) => { run.busy.sleepEvents = [SLEPT]; }, [sleepEvent]],
		["the machine slept in the busy window", (run) => {
			run.busy.sleepEvents = [SLEPT];
			run.busy.s = { machineId: null, leaseAfter: -2.1, observedAfter: 61.2, busyAfter: -118.53017, running: [SLEEPER] };
			run.busy.entries[5] = null;
			run.busy.sleeps = [{ event: "coding-machine", machineId: MACHINE, step: "sleep", state: "succeeded" }];
			run.busy.vm = "STOPPED";
		}, [sleepEvent, kept, entry, sleepLine, awake]],
		["S detached", (run) => { run.busy.s.machineId = null; }, [kept]],
		["S's attachment not renewed after the backdate", (run) => { run.busy.s.leaseAfter = 52.7; }, [kept]],
		["S's attachment cut to the backdate", (run) => { run.busy.s.leaseAfter = 0; }, [kept]],
		["S not observed after the backdate", (run) => { run.busy.s.observedAfter = -8.3; }, [kept]],
		["no session row for S", (run) => { run.busy.s = null; }, [kept, running, sBusy]],
		["S's sleeper not seen running", (run) => { run.busy.s.running = []; }, [running]],
		["a command of an earlier turn left running beside the sleeper", (run) => { run.busy.s.running.unshift(LOOP); }, [running]],
		["S counted busy", (run) => { run.busy.s.busyAfter = 71.20854; }, [sBusy]],
		["S counted busy once", (run) => { run.busy.s.busyAfter = 0.4; }, [sBusy]],
		["the list due to sleep", (run) => { run.busy.entries[3].sleepDue = true; }, [entry]],
		["a turn live in the window", (run) => { run.busy.entries[0].live = true; }, [entry]],
		["the machine not reserved", (run) => { run.busy.entries[2].reserved = false; }, [entry]],
		["the machine superseded", (run) => { run.busy.entries[2].superseded = true; }, [entry]],
		["the machine gone from the list", (run) => { run.busy.entries[1] = null; }, [entry]],
		["S2 not attached in the list", (run) => { run.busy.entries[4].attached = [S]; }, [entry]],
		["S not attached in the list", (run) => { run.busy.entries[4].attached = [S2]; }, [entry]],
		["the list never read", (run) => { run.busy.entries = []; }, [entry]],
		["a sleep tried", (run) => { run.busy.sleeps = [{ event: "coding-machine-error", machineId: MACHINE, step: "sleep", code: "CODING_HOST_BUSY" }]; }, [sleepLine]],
		["one keep", (run) => { run.busy.keeps = 1; }, [looked]],
		["three list reads", (run) => { run.busy.lists = 3; }, [looked]],
		["the VM stopped", (run) => { run.busy.vm = "STOPPED"; }, [awake]],
		// 4: the question.
		["no question", (run) => { run.asked.wake = null; }, [noQuestion]],
		["Order 9's question the newest", (run) => { run.asked.wake.occurrenceKey = `coding-quiet:${S}:1760605903211:1`; }, [noQuestion]],
		["a second day's question", (run) => { run.asked.wake.occurrenceKey = KEY.replace(/:1$/, ":2"); }, [noQuestion]],
		["the backdate not made", (run) => { run.asked.expected = null; }, [noQuestion]],
		["the sleeper not counted", (run) => {
			run.asked.wake.summary = run.asked.wake.summary.replace(", with 1 command still running on its machine", "");
		}, [notCounted]],
		["two commands counted", (run) => {
			run.asked.wake.summary = run.asked.wake.summary.replace("with 1 command still", "with 2 commands still");
		}, [notCounted]],
		// 5: the archive, then the sleep.
		["the archive names no command", (run) => { run.archived.event.body.stopped = []; }, [archiveNames]],
		["the archive names the sleeper", (run) => { run.archived.event.body.stopped[0].commandId = SLEEPER; }, [archiveNames]],
		["no archive event", (run) => { run.archived.event = null; }, [archiveNames]],
		["the loop left running", (run) => { run.archived.left = "4188 sh -c while :; do :; done"; }, [loopLeft]],
		["the sleeper killed with S2's programs", (run) => { run.archived.sleeperLeft = null; }, [sleeperGone]],
		["S detached by the archive", (run) => { run.archived.s = { machineId: null, attached: false }; }, [detached]],
		["S's attachment lapsed at the archive", (run) => { run.archived.s.attached = false; }, [detached]],
		["no SLEEP after the archive", (run) => {
			run.slept = { ...run.slept, event: null, after: null, suspendedAt: null, vm: "RUNNING" };
		}, [noSleep, asleep]],
		["the SLEEP names no command", (run) => { run.slept.event.body.stopped = []; }, [sleepNames]],
		["the SLEEP names another command", (run) => { run.slept.event.body.stopped[0].commandId = LOOP; }, [sleepNames]],
		["the SLEEP two passes late", (run) => { run.slept.after = 201.7; }, [late]],
		["the SLEEP before the backdate", (run) => { run.slept.after = -3.2; }, [late]],
		["the VM running after the SLEEP", (run) => { run.slept.vm = "RUNNING"; }, [asleep]],
		["the node demand not suspended", (run) => { run.slept.suspendedAt = null; }, [asleep]],
	];
	for (const [name, broken, expected] of cases) {
		const run = structuredClone(RECORD);
		broken(run);
		const { failures } = judgeC1V(run);
		assert.equal(failures.length, expected.length, `${name}: ${JSON.stringify(failures)}`);
		expected.forEach((pattern, index) => assert.match(failures[index], pattern, name));
	}
});

// run() judges each step as it ends, before the later steps' records are there.
test("each step's judgment reads only its own step's record", () => {
	const { busy, asked, archived, slept, ...run } = RECORD;
	assert.equal(judgeBusy({ ...run, busy }).length, 0);
	assert.equal(judgeAsked({ ...run, asked }).length, 0);
	assert.equal(judgeArchived({ ...run, archived }).length, 0);
	assert.equal(judgeSlept({ ...run, slept }).length, 0);
});
