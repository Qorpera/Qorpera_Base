import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildClearCaretakerCloseSshArgs,
	buildCloseForSleepSshArgs,
	buildJumpClearMarkerSshArgs,
	buildJumpQuerySshArgs,
	buildJumpStopScript,
	buildJumpStopSshArgs,
	buildTelemetryPrompt,
	buildTelemetrySshArgs,
	buildTidyScript,
	buildTidySshArgs,
	enforceSafetyGuards,
	fallbackDecision,
	isMachineBusy,
	parseCaretakerDecision,
	parseCliArgs,
	parseTelemetryOutput,
	reconcileStrandedCaretakerState,
	shouldConsultLlm,
	telemetryScript,
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

const sampleMachine = { name: "node02", host: "tester@10.201.0.2", jump: "company41-node-02" };

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

test("SSH command builders properly shell-quote remote bash -c scripts so login shells parse them intact", () => {
	const builders = [
		buildTelemetrySshArgs(sampleMachine, "/tmp/test-key"),
		buildTidySshArgs(sampleMachine, "/tmp/test-key"),
		buildCloseForSleepSshArgs(sampleMachine, "/tmp/test-key"),
		buildClearCaretakerCloseSshArgs(sampleMachine, "/tmp/test-key"),
		buildJumpQuerySshArgs(sampleMachine),
		buildJumpClearMarkerSshArgs(sampleMachine),
		buildJumpStopSshArgs(sampleMachine),
	];
	for (const argv of builders) {
		const bashIdx = argv.indexOf("bash");
		assert.ok(bashIdx > 0, `expected bash in ${JSON.stringify(argv)}`);
		assert.equal(argv[bashIdx + 1], "-c");
		const remoteCmd = argv.slice(bashIdx).join(" ");
		const check = spawnSync("sh", ["-c", `bash -n -c ${argv[bashIdx + 2]}`], { encoding: "utf8" });
		assert.equal(check.status, 0, `remote login shell failed to parse: ${remoteCmd}\n${check.stderr}`);
	}
	assert.equal(spawnSync("bash", ["-n", "-c", buildTidyScript()]).status, 0);
	const stopScript = buildJumpStopScript("qorpera-testvm-node02");
	assert.equal(spawnSync("bash", ["-n", "-c", stopScript]).status, 0);
	assert.doesNotMatch(stopScript, /lxc config set/);
	assert.ok(
		stopScript.indexOf('printf \'%s\\n\' "$last_used" > "$marker"') < stopScript.indexOf("lxc stop"),
		"sleep marker must be written before lxc stop and removed on stop failure",
	);
	assert.match(stopScript, /if ! lxc stop .* then rm -f -- "\$marker"; exit 1; fi/);
});

test("telemetryScript runs locally under bash -c without self-matching sshd or using gawk-only syntax", () => {
	const tmp = mkdtempSync(join(tmpdir(), "caretaker-telemetry-"));
	try {
		const locksDir = join(tmp, "locks");
		const homeDir = join(tmp, "home");
		const historyDir = join(homeDir, "run-history");
		mkdirSync(locksDir, { recursive: true });
		mkdirSync(historyDir, { recursive: true });
		const nowSec = Math.floor(Date.now() / 1000);
		const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
		writeFileSync(
			join(historyDir, `${today}.jsonl`),
			[
				JSON.stringify({ run: "r1", endedAt: nowSec - 120 }),
				JSON.stringify({ run: "r2", endedAt: nowSec - 600 }),
				JSON.stringify({ run: "r3", endedAt: nowSec - 7200 }),
			].join("\n") + "\n",
		);
		const defaultScript = telemetryScript({ locksDir, homeDir, historyDir });
		const defaultRun = spawnSync("bash", ["-c", defaultScript], { encoding: "utf8" });
		assert.equal(defaultRun.status, 0, defaultRun.stderr);
		const parsedDefault = parseTelemetryOutput(defaultRun.stdout, sampleMachine, {
			vmName: "qorpera-testvm-node02",
			wakeable: true,
		});
		assert.equal(parsedDefault.runsLast60m, 2);
		assert.equal(typeof parsedDefault.otherSshSessions, "number");

		const selfCheckScript = telemetryScript({
			locksDir,
			homeDir,
			historyDir,
			psArgsCmd: "ps -eo args= | grep -v '^sshd'",
		});
		const selfRun = spawnSync("bash", ["-c", selfCheckScript], { encoding: "utf8" });
		assert.equal(selfRun.status, 0, selfRun.stderr);
		assert.match(selfRun.stdout, /^ssh_sessions=0$/m);
		const parsedSelf = parseTelemetryOutput(selfRun.stdout, sampleMachine, {
			vmName: "qorpera-testvm-node02",
			wakeable: true,
		});
		assert.equal(parsedSelf.otherSshSessions, 0);

		const fakePsScript = telemetryScript({
			locksDir,
			homeDir,
			historyDir,
			psArgsCmd:
				"printf '%s\\n' 'sshd-session: tester@notty' 'bash -c sshd-session: tester@notty' 'sshd: tester@pts/0'",
			psUserCmd: "printf '%s\\n' 'root' 'ci01' 'ci02' 'tester'",
		});
		const fakeRun = spawnSync("bash", ["-c", fakePsScript], { encoding: "utf8" });
		assert.equal(fakeRun.status, 0, fakeRun.stderr);
		assert.match(fakeRun.stdout, /^ssh_sessions=2$/m);
		const parsedFake = parseTelemetryOutput(fakeRun.stdout, sampleMachine, {
			vmName: "qorpera-testvm-node02",
			wakeable: true,
		});
		assert.equal(parsedFake.otherSshSessions, 1);
		assert.equal(parsedFake.activeCiProcs, 2);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("parseTelemetryOutput treats missing or failed df/uptime values as null rather than zero", () => {
	const parsed = parseTelemetryOutput(
		"busy=0\nwaiting=0\nquick_busy=0\nquick_waiting=0\narriving=0\nci_procs=0\nssh_sessions=1\ndisk_mib=\ntmp_mib=err\nmem_mib=\nload=\nidle_min=\nruns_60m=0\nstale_ct=0\nvol_count=0\nrun_dirs=0\ntree_dirs=0\n",
		sampleMachine,
		{ vmName: "qorpera-testvm-node02", wakeable: true },
	);
	assert.equal(parsed.diskFreeGiB, null);
	assert.equal(parsed.tmpFreeGiB, null);
	assert.equal(parsed.memAvailGiB, null);
	assert.equal(parsed.idleMinutes, null);
	assert.equal(shouldConsultLlm(parsed), false);
	const guarded = enforceSafetyGuards({ action: "sleep_vm", reason: "test" }, parsed);
	assert.equal(guarded.action, "keep_awake");
});

test("running marker-less VM with a stranded caretaker-sleep close is detected and reopened while operator closes stay intact", () => {
	const tmp = mkdtempSync(join(tmpdir(), "caretaker-close-"));
	try {
		const locksDir = join(tmp, "locks");
		const homeDir = join(tmp, "home");
		const historyDir = join(homeDir, "run-history");
		const closedFile = join(tmp, "closed");
		mkdirSync(locksDir, { recursive: true });
		mkdirSync(historyDir, { recursive: true });

		writeFileSync(closedFile, "caretaker-sleep\n");
		const strandedRun = spawnSync(
			"bash",
			["-c", telemetryScript({ locksDir, homeDir, historyDir, closedFile, psArgsCmd: "true", psUserCmd: "true" })],
			{ encoding: "utf8" },
		);
		assert.equal(strandedRun.status, 0, strandedRun.stderr);
		const strandedState = parseTelemetryOutput(strandedRun.stdout, sampleMachine, {
			vmName: "qorpera-testvm-node02",
			wakeable: true,
		});
		assert.equal(strandedState.caretakerClosed, true);

		let clearedClose = 0;
		let clearedMarker = 0;
		const reopened = reconcileStrandedCaretakerState(strandedState, {
			sleepMarker: null,
			reconcileRunningClose: true,
			clearSleepMarker: () => {
				clearedMarker += 1;
				return true;
			},
			clearCaretakerClose: () => {
				clearedClose += 1;
				return true;
			},
		});
		assert.equal(clearedClose, 1);
		assert.equal(clearedMarker, 0);
		assert.equal(reopened.caretakerClosed, false);

		let recheckCleared = 0;
		const keptClosedDuringRecheck = reconcileStrandedCaretakerState(strandedState, {
			sleepMarker: null,
			reconcileRunningClose: false,
			clearCaretakerClose: () => {
				recheckCleared += 1;
				return true;
			},
		});
		assert.equal(recheckCleared, 0);
		assert.equal(keptClosedDuringRecheck.caretakerClosed, true);

		writeFileSync(closedFile, "operator maintenance\n");
		const operatorRun = spawnSync(
			"bash",
			["-c", telemetryScript({ locksDir, homeDir, historyDir, closedFile, psArgsCmd: "true", psUserCmd: "true" })],
			{ encoding: "utf8" },
		);
		assert.equal(operatorRun.status, 0, operatorRun.stderr);
		const operatorState = parseTelemetryOutput(operatorRun.stdout, sampleMachine, {
			vmName: "qorpera-testvm-node02",
			wakeable: true,
		});
		assert.equal(operatorState.caretakerClosed, false);
		let operatorCleared = 0;
		reconcileStrandedCaretakerState(operatorState, {
			sleepMarker: null,
			reconcileRunningClose: true,
			clearCaretakerClose: () => {
				operatorCleared += 1;
				return true;
			},
		});
		assert.equal(operatorCleared, 0);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
