import assert from "node:assert/strict";
import test from "node:test";
import {
	buildTelemetryPrompt,
	enforceSafetyGuards,
	fallbackDecision,
	isMachineBusy,
	parseCaretakerDecision,
	parseCliArgs,
	shouldConsultLlm,
} from "./test-machine-caretaker.mjs";

const idleMachine = (overrides = {}) => ({
	name: "node02",
	vmName: "qorpera-testvm-node02",
	status: "RUNNING",
	wakeable: true,
	unreachable: false,
	busy: 0,
	waiting: 0,
	quickBusy: 0,
	quickWaiting: 0,
	arriving: 0,
	activeCiProcs: 0,
	otherSshSessions: 0,
	diskFreeGiB: 54,
	tmpFreeGiB: 7.5,
	memAvailGiB: 18,
	load: 0.2,
	idleMinutes: 12,
	runsLast60m: 2,
	...overrides,
});

test("shouldConsultLlm skips stopped, busy healthy, and freshly active machines to avoid wasted LLM tokens", () => {
	assert.equal(shouldConsultLlm(idleMachine({ status: "STOPPED" })), false);
	assert.equal(shouldConsultLlm(idleMachine({ unreachable: true })), false);
	assert.equal(shouldConsultLlm(idleMachine({ busy: 1 })), false);
	assert.equal(shouldConsultLlm(idleMachine({ activeCiProcs: 2 })), false);
	assert.equal(shouldConsultLlm(idleMachine({ otherSshSessions: 1 })), false);
	assert.equal(shouldConsultLlm(idleMachine({ idleMinutes: 4 })), false);
	assert.equal(shouldConsultLlm(idleMachine({ idleMinutes: 5 })), true);
	assert.equal(shouldConsultLlm(idleMachine({ busy: 2, diskFreeGiB: 18 })), true);
	assert.equal(shouldConsultLlm(idleMachine({ busy: 1, tmpFreeGiB: 1.2 })), true);
});

test("parseCaretakerDecision handles Claude CLI JSON envelopes, code fences, and rejects unknown actions", () => {
	const envelope = JSON.stringify({
		type: "result",
		result: '```json\n{"action":"sleep_vm","reason":"idle 20m with quiet queue"}\n```',
	});
	assert.deepEqual(parseCaretakerDecision(envelope), {
		action: "sleep_vm",
		reason: "idle 20m with quiet queue",
	});
	assert.deepEqual(parseCaretakerDecision('{"action":"tidy_disk","reason":"low disk"}'), {
		action: "tidy_disk",
		reason: "low disk",
	});
	assert.equal(parseCaretakerDecision('{"action":"rm_rf_root","reason":"bad"}'), null);
	assert.equal(parseCaretakerDecision("not json at all"), null);
});

test("enforceSafetyGuards never sleeps busy, <5m idle, or non-wakeable VMs, and forces tidy under critical disk", () => {
	const busyRes = enforceSafetyGuards(
		{ action: "sleep_vm", reason: "llm wanted sleep" },
		idleMachine({ activeCiProcs: 1 }),
	);
	assert.equal(busyRes.action, "keep_awake");

	const youngRes = enforceSafetyGuards(
		{ action: "tidy_and_sleep", reason: "llm wanted tidy+sleep" },
		idleMachine({ idleMinutes: 3 }),
	);
	assert.equal(youngRes.action, "tidy_disk");

	const nonWakeable = enforceSafetyGuards(
		{ action: "sleep_vm", reason: "llm wanted sleep" },
		idleMachine({ name: "node01", wakeable: false }),
	);
	assert.equal(nonWakeable.action, "keep_awake");
	assert.match(nonWakeable.reason, /lxc wake unavailable/);

	const criticalDisk = enforceSafetyGuards(
		{ action: "keep_awake", reason: "llm said wait" },
		idleMachine({ diskFreeGiB: 10 }),
	);
	assert.equal(criticalDisk.action, "tidy_disk");
	assert.match(criticalDisk.reason, /forced tidy/);

	const allowedSleep = enforceSafetyGuards({ action: "sleep_vm", reason: "quiet" }, idleMachine({ idleMinutes: 10 }));
	assert.equal(allowedSleep.action, "sleep_vm");
});

test("fallbackDecision tidies low disk and only sleeps wakeable VMs after long idle with empty PR queue", () => {
	assert.equal(fallbackDecision(idleMachine({ idleMinutes: 10 }), { readyPrs: 0, pendingCi: 0 }).action, "keep_awake");
	assert.equal(fallbackDecision(idleMachine({ idleMinutes: 50 }), { readyPrs: 1, pendingCi: 0 }).action, "keep_awake");
	assert.equal(fallbackDecision(idleMachine({ idleMinutes: 50 }), { readyPrs: 0, pendingCi: 0 }).action, "sleep_vm");
	assert.equal(
		fallbackDecision(idleMachine({ idleMinutes: 50, diskFreeGiB: 12 }), { readyPrs: 0, pendingCi: 0 }).action,
		"tidy_and_sleep",
	);
	assert.equal(
		fallbackDecision(idleMachine({ idleMinutes: 50, wakeable: false }), { readyPrs: 0, pendingCi: 0 }).action,
		"keep_awake",
	);
	assert.equal(isMachineBusy(idleMachine({ arriving: 1 })), true);
	assert.match(buildTelemetryPrompt({ machine: idleMachine() }), /tidy_and_sleep/);
	assert.deepEqual(parseCliArgs(["--dry-run", "--no-llm", "--model", "haiku", "--machine", "node02"]), {
		dryRun: true,
		noLlm: true,
		model: "haiku",
		machine: "node02",
	});
});
