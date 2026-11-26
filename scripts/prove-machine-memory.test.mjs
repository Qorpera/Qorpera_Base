import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import verdicts from "./machine-memory-proof/verdicts.cjs";

// The memory proof (scripts/prove-machine-memory.sh and scripts/machine-memory-proof/) passes on nothing that was not
// really answered. Review round 1 of #1692 found two ways it did: a look of the guest helper that timed out or
// answered nothing counted as answered (F1), and a browser phase that failed, or the whole browser being ended, only
// printed a number (F2). Round 2 found a third: the parts ran where bash's errexit does not reach, so a machine that
// could not be deleted, made or started was stepped over and the next part's checks ran on the machine left behind.
// Round 3: the probe beside a leg could end half way unseen. Round 4: the probe read the machine's memory numbers in
// its own loop, so a stall that fell into that reading was neither a slow click nor a look that was not answered.
// Round 5: only the time between two clicks was looked at, so a loop that stood still over a leg's end went unseen.
const { tabsVerdict, whatEnded } = verdicts;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const guest = join(repositoryRoot, "scripts/machine-memory-proof/guest.sh");
/** A script's lines that are not comments. */
const code = (text) =>
	text
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
// guest.sh runs inside a machine: Linux, with jq and timeout. The tests that run it need the same.
const linux =
	process.platform === "linux" && ["jq", "timeout"].every((tool) => spawnSync(tool, ["--version"]).status === 0);
const needsLinux = linux ? false : "runs guest.sh, which needs Linux with jq and timeout";
/** Runs guest.sh with the tests' own places and stand-ins. */
const run = (temporary, words, env, input = "") =>
	spawnSync("bash", [guest, ...words], {
		encoding: "utf8",
		timeout: 60_000,
		input,
		env: {
			PATH: process.env.PATH,
			MEMORY_PROOF_STATE: join(temporary, "state"),
			MEMORY_PROOF_REPLIES: join(temporary, "replies"),
			MEMORY_PROOF_NODE: process.execPath,
			...env,
		},
	});

test("a look is answered only when the helper itself ended well and answered an observation (review r1 F1)", { skip: needsLinux }, async () => {
	// A stand-in for the guest helper. As the real one, it takes a nonce and writes its answer to the reply file of that
	// name; STUB says what it does this time.
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-memory-proof-look-"));
	try {
		await mkdir(join(temporary, "replies"));
		const helper = join(temporary, "helper.mjs");
		await writeFile(
			helper,
			[
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				'const reply = (text) => writeFileSync(join(process.env.MEMORY_PROOF_REPLIES, process.argv[2] + ".json"), text);',
				'const observation = JSON.stringify({ schema: "qorpera.machine-observation/v2", cpuUsec: 1, ioBytes: 2, ended: [] });',
				'if (process.argv[3] !== "observe") process.exit(9);',
				"switch (process.env.STUB) {",
				'	case "observation": reply(observation); break;',
				'	case "refusal": reply(JSON.stringify({ schema: "qorpera.machine-guest-refusal/v1", code: "MACHINE_GUEST_IDENTITY_INVALID" })); break;',
				'	case "older-observation": reply(JSON.stringify({ schema: "qorpera.machine-observation/v1" })); break;',
				'	case "nothing": break;',
				'	case "empty": reply(""); break;',
				'	case "not-json": reply("the helper fell over"); break;',
				'	case "answers-then-fails": reply(observation); process.exit(7); break;',
				'	case "answers-then-hangs": reply(observation); setInterval(() => {}, 1000); break;',
				'	case "hangs": setInterval(() => {}, 1000); break;',
				"	default: process.exit(8);",
				"}",
			].join("\n"),
		);
		const look = (stub, seconds = "20") =>
			run(temporary, ["look"], { MEMORY_PROOF_GUEST: helper, MEMORY_PROOF_HELPER_SECONDS: seconds, STUB: stub });
		// The one answer that counts: the helper ended well and wrote an observation.
		const answered = look("observation");
		assert.equal(answered.status, 0, answered.stderr);
		assert.equal(answered.stdout, "qorpera.machine-observation/v2\n");
		// A helper that times out, with no answer and with a perfectly good one already written: the look fails. The host
		// throws a look's output away and keeps its exit code, so the exit code alone must say so.
		for (const stub of ["hangs", "answers-then-hangs"]) {
			const started = Date.now();
			const cut = look(stub, "1");
			assert.notEqual(cut.status, 0, `${stub}: a look whose helper was cut off at its time limit must fail`);
			assert.ok(Date.now() - started < 20_000, `${stub}: the look waited ${Date.now() - started} ms`);
			assert.equal(cut.stdout, "", stub);
			assert.match(cut.stderr, /^look: the guest helper did not answer \(exit 124\)\n$/, stub);
		}
		// A helper that ends well and answers nothing, an empty answer, something that is no answer at all.
		for (const stub of ["nothing", "empty"]) {
			const silent = look(stub);
			assert.notEqual(silent.status, 0, `${stub}: a look without an answer must fail`);
			assert.equal(silent.stdout, "", stub);
			assert.match(silent.stderr, /^look: the guest helper did not answer \(exit 1\)\n$/, stub);
		}
		const garbled = look("not-json");
		assert.notEqual(garbled.status, 0);
		assert.match(garbled.stderr, /^look: the guest helper answered nothing readable, not an observation\n$/);
		// A wrong schema: a refusal (what an unprepared guest answers, which every earlier run counted as a look
		// answered) and another version of the observation.
		for (const [stub, schema] of [
			["refusal", "qorpera.machine-guest-refusal/v1"],
			["older-observation", "qorpera.machine-observation/v1"],
		]) {
			const other = look(stub);
			assert.notEqual(other.status, 0, `${stub}: a look answered with ${schema} must fail`);
			assert.equal(other.stdout, "", stub);
			assert.equal(other.stderr, `look: the guest helper answered ${schema}, not an observation\n`);
		}
		// A helper that failed, though it wrote an observation first: only what a helper that ended well wrote is an answer.
		const failed = look("answers-then-fails");
		assert.notEqual(failed.status, 0);
		assert.match(failed.stderr, /^look: the guest helper did not answer \(exit 7\)\n$/);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	const proof = read("scripts/prove-machine-memory.sh");
	// Inside the machine a look is asked by its exit code too, and no answer of the helper goes straight into jq, which
	// ends well on no input at all.
	const script = read("scripts/machine-memory-proof/guest.sh");
	assert.equal(script.split('check "the guest helper answers a look with an observation" bash "$HERE/guest.sh" look\n').length - 1, 2);
	assert.doesNotMatch(code(script), /\bhelper [^\n|;)]*\|\s*jq\b/);
	// A guest is prepared before the first look of a probed leg: an unprepared one answers a refusal.
	assert.match(script, /\nready\(\) \{ browser && prepared; \}\n/);
	assert.match(script, /\nbrowser\)\n\tcheck "the desktop runs, its browser's debugging port answers and the guest is prepared" ready\n/);
	for (const leg of ["checks", "edge", "small-past"]) {
		const part = proof.slice(proof.indexOf(`\t\t${leg})\n`), proof.indexOf("\t\t\t;;\n", proof.indexOf(`\t\t${leg})\n`)));
		for (const probed of part.match(/\n\t\t\tprobed [^\n]+/g)) {
			const before = part.slice(0, part.indexOf(probed)).trimEnd().split("\n").at(-1);
			assert.equal(before, "\t\t\tguest 180 browser", `${leg}: ${probed.trim()} starts on a prepared guest`);
		}
	}
});

test("a browser phase that did not end well fails the proof, and a browser that is gone is told from an ended tab (review r1 F2)", { skip: needsLinux }, async () => {
	// A stand-in for pages.cjs: it ends as STUB says. guest.sh's `phase` is what every leg runs a browser phase through.
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-memory-proof-phase-"));
	try {
		const pages = join(temporary, "pages.cjs");
		await writeFile(
			pages,
			'console.log("M " + JSON.stringify({ t: "stand-in", words: process.argv.slice(2) }));\nif (process.env.STUB === "hangs") setInterval(() => {}, 1000);\nelse process.exit(Number(process.env.STUB));\n',
		);
		const phase = (stub, seconds = "20") => run(temporary, ["phase", seconds, "tabs", "72", "past"], { MEMORY_PROOF_PAGES: pages, STUB: stub });
		const lines = (result) => result.stdout.trim().split("\n");
		// The phase's own lines come through, then the check.
		const well = phase("0");
		assert.equal(well.status, 0, well.stderr);
		assert.deepEqual(lines(well), ['M {"t":"stand-in","words":["tabs","72","past"]}', "CHECK ok   the browser's phase [tabs 72 past] ended well"]);
		// The phase did not do what it is for (pages.cjs exits 1), the browser is gone (3), it was cut off at its limit
		// (timeout's 124), or it ended any other way: each is a failed check, which fails the proof. The leg itself still
		// runs to its end.
		for (const [stub, seconds, said] of [
			["1", "20", "CHECK FAIL the browser's phase [tabs 72 past] ended well: exit 1, its reason is in the line before"],
			["3", "20", "CHECK FAIL the browser's phase [tabs 72 past] ended well: the browser is gone (tabs may be ended, the browser may not)"],
			["hangs", "1", "CHECK FAIL the browser's phase [tabs 72 past] ended well: it was cut off after 1 s"],
			["137", "20", "CHECK FAIL the browser's phase [tabs 72 past] ended well: exit 137, its reason is in the line before"],
		]) {
			const bad = phase(stub, seconds);
			assert.equal(bad.status, 0, `${stub}: ${bad.stderr}`);
			assert.equal(lines(bad).at(-1), said, stub);
			assert.equal(lines(bad).filter((line) => line.startsWith("CHECK ok")).length, 0, stub);
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("every browser phase of the proof runs through that check, and after the edge the browser itself must be alive", () => {
	const script = read("scripts/machine-memory-proof/guest.sh");
	const lines = code(script);
	// The browser's program is started in one place, `phase`; the legs name their phases through it, with no status
	// of their own to print and forget.
	assert.equal(lines.match(/"\$PAGES"/g).length, 1);
	assert.doesNotMatch(lines, /pages\.cjs (mix|heavyapps|tabs|anim)/);
	assert.match(script, /\n\t\(cd "\$HERE" && timeout "\$seconds" "\$NODE" "\$PAGES" "\$@"\) \|\| status=\$\?\n\tcase \$status in\n\t0\) echo "CHECK ok   the browser's phase \[\$\*\] ended well" ;;\n/);
	for (const phase of ['\tphase 200 mix "$label"\n', "\tphase 240 heavyapps\n", '\tphase 900 tabs "$tabs" "$edge"\n', "\tphase 180 anim 5000 everything-open\n"])
		assert.ok(script.includes(phase), phase);
	assert.doesNotMatch(lines, /M "(tabs|anim) rc=/);
	// The clicks and screenshots a leg takes itself, and the agent's job it starts, are checks too.
	assert.match(script, /\n\tcheck "four clicks and four screenshots \(\$1\) each ended well" test "\$bad" = 0\n/);
	assert.match(script, /\n\t\tcheck "the agent's job started as a machine command" test "\$status" = 0\n/);
	assert.match(script, /\n\t\tcheck "the job runs and holds its \$job MB" test "\$holds" = yes\n/);
	// After the edge: the journal was really read; what the guard ended is only what it may end; and the browser's main
	// process, noted before the edge by its pid and its start, is alive, with its debugging port answering.
	const after = script.slice(script.indexOf("\nafter)\n"), script.indexOf("\nphase)\n"));
	for (const check of [
		'\tcheck "this boot\'s journal can be read: the guard\'s lines and the kernel\'s" \\\n\t\ttest "$guard_read" = 0 -a "$kernel_read" = 0 -a -s "$guard_log.raw" -a -s "$kernel_log" -a "$(wc -l <"$guard_log")" = "$(wc -l <"$guard_log.raw")"\n',
		'\t\ttest "$(( tabs + helpers + jobs + browsers + others ))" = "$ended" -a "$browsers" = 0 -a "$others" = 0\n',
		'\tcheck "the browser itself was not ended (tabs may be, the browser may not): its main process ${main:-unknown}, noted before the edge, is alive" \\\n\t\ttest -n "$main" -a -n "$main_started" -a "$(started_at "${main:-0}")" = "$main_started"\n',
		'\tcheck "the browser\'s debugging port answers" port_answers\n',
		'\t\t\ttest "$state" = running -o \\( "$state" = failed -a "$jobs" -ge 1 \\)\n',
	])
		assert.ok(after.includes(check), check);
	assert.doesNotMatch(code(after), /echo alive \|\| echo gone/);
	// The same is asked after a load that stopped before the edge (`after stop`), where nothing has to be ended: the
	// parts that only report numbers read the journal too.
	assert.match(after, /\n\tif \[\[ \$edge == past \]\]; then\n\t\tcheck "something was ended, [^\n]+\n\t\tcheck "the guard acted before the kernel's own killer had to" test "\$kernel" = 0\n\telse\n[^\n]+\n\t\tcheck "the kernel's own killer ended nothing" test "\$kernel" = 0\n\tfi\n/);
	const host = read("scripts/prove-machine-memory.sh");
	assert.equal(host.match(/\n\t\t\tguest 1500 load \d+ stop 24\n\t\t\tguest 180 after stop\n\t\t\tgone\n/g).length, 2);
	assert.equal(host.match(/\n\t\t\tprobed "past the edge[^\n]*" 60 1500 load \d+ past 72\n\t\t\tguest 180 after\n/g).length, 3);
	assert.match(script, /\n\t\techo "\$pid \$\(started_at "\$pid"\)" >"\$STATE\/browser-main"\n/);
	// What the guard ended is read from the command line in each of its lines, by the same `kinds` that finds the
	// browser's main process among the living (the test below runs it).
	assert.match(after, /\n\tkinds=\$\(sed -n '[^\n]+' "\$guard_log" \| kinds\)\n/);
	assert.match(script, /\n\t\t\[\[ \$\(kinds <<<"\$line"\) == browser && " \$line " == \*" --remote-debugging-port=9222 "\* \]\] \|\| continue\n/);
	// pages.cjs: 3 for a browser that is gone, 1 for a phase that did not do what it is for; it asks the browser's port
	// after every phase, and decides with verdicts.cjs.
	const pages = read("scripts/machine-memory-proof/pages.cjs");
	assert.match(pages, /\n\tif \(!\(await browserAnswers\(\)\)\) throw new BrowserGone\("the browser no longer answers on its debugging port"\);\n\tawait browser\.close\(\);\n/);
	assert.match(pages, /\n\tif \(error instanceof BrowserGone \|\| !\(await browserAnswers\(\)\)\) \{\n\t\tM\(\{ t: "browser-gone", [^\n]+\n\t\tprocess\.exit\(3\);\n\t\}\n\tM\(\{ t: "phase-failed", [^\n]+\n\tprocess\.exit\(1\);\n/);
	assert.match(pages, /\nconst \{ tabsVerdict, whatEnded \} = require\("\.\/verdicts\.cjs"\);\n/);
	assert.equal(pages.match(/if \(kind === "browser"\) throw new BrowserGone\(/g).length, 3);
	// The host puts verdicts.cjs into the machine with the rest, and passes only on checks that were made.
	const proof = read("scripts/prove-machine-memory.sh");
	assert.match(proof, /\nPIECES=\(guest\.sh pages\.cjs verdicts\.cjs job\.cjs app\.html video\.html pointer\.html\)\n/);
	assert.equal(proof.match(/for file in "\$\{PIECES\[@\]\}"; do/g).length, 2);
	assert.match(proof, /\nif \(\( parts_status == 0 && failed == 0 && passed >= 1 && ended == \$\{#PARTS\[@\]\} \)\); then echo "PROOF PASSED"; else echo "PROOF FAILED"; exit 1; fi\n/);
	for (const file of ["scripts/prove-machine-memory.sh", "scripts/machine-memory-proof/guest.sh"])
		assert.equal(spawnSync("bash", ["-n", join(repositoryRoot, file)], { encoding: "utf8" }).status, 0, file);
});

test("what the guard ended is read from each command line: a tab, a helper of Chromium, the browser itself, the job", { skip: needsLinux }, async () => {
	// Command lines as a machine shows them (12 Nov 2026). Chromium rewrites its command line into one string with
	// spaces between its words, for its main process too: the first proof that looked for the browser's main process
	// by splitting its command line at NUL bytes never found it.
	const chrome = "/usr/lib/qorpera-chromium/chrome";
	const main = `${chrome} --start-maximized --no-first-run --no-default-browser-check --password-store=basic --disable-infobars --enable-unsafe-swiftshader --remote-debugging-port=9222 --user-data-dir=/home/desktop/proof-profile about:blank `;
	const tab = `${chrome} --type=renderer --gpu-client-id=13 --crashpad-handler-pid=1813 --enable-crash-reporter=, --user-data-dir=/home/desktop/proof-profile --change-stack-guard-on-fork=enable --remote-debugging-port=9222 --ozone-platform=x11 --`;
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-memory-proof-kinds-"));
	try {
		const kinds = (lines) => {
			const result = run(temporary, ["kinds"], {}, `${lines.join("\n")}\n`);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim().split("\n");
		};
		assert.deepEqual(
			kinds([
				main,
				`${chrome}"`,
				tab,
				`${tab}"`,
				`${chrome} --type=renderer"`,
				`${chrome} --type=zygote --no-zygote-sandbox --crashpad-handler-pid=1799 --enable-crash-`,
				`${chrome} --type=gpu-process --ozone-platform=x11 --crashpad-handler-pid=1799"`,
				`${chrome} --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US"`,
				'node job.cjs 7666 50"',
				'node /srv/memory-proof/job.cjs 1500"',
				`${chrome}_crashpad_handler --monitor-self --database=/home/desktop/proof-profile/Crash Reports"`,
				'/usr/bin/python3 -m http.server 8700 --bind 127.0.0.1"',
				'Xvnc :1 -geometry 1600x1000 -depth 24"',
				'/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock"',
			]),
			["browser", "browser", "tab", "tab", "tab", "helper", "helper", "helper", "job", "job", "other", "other", "other", "other"],
		);
		// And from the guard's own journal lines, as `after` reads them: only the lines that name an end, each by the
		// command line it carries.
		const script = read("scripts/machine-memory-proof/guest.sh");
		const extract = script.match(/\n\tkinds=\$\((sed -n '[^\n]+' "\$guard_log") \| kinds\)\n/)[1];
		const journal = join(temporary, "guard");
		await writeFile(
			journal,
			[
				"11:17:40 earlyoom v1.9.0",
				"11:17:40 sending SIGTERM when mem avail <= 17.00% and swap free <= 10.00%,",
				"11:17:47 mem avail:   304 of  1851 MiB (16.46%), swap free:   74 of 3833 MiB ( 1.94%)",
				"11:17:47 low memory! at or below SIGKILL limits: mem 17.00%, swap 10.00%",
				`11:17:47 sending SIGKILL to process 3088 uid 1001 "chrome": oom_score 890, oom_score_adj 300, VmRSS 204 MiB, cmdline "${tab}"`,
				"11:17:47 process 3088 exited after 0.100 seconds",
				'11:31:10 sending SIGKILL to process 2097 uid 0 "MainThread": oom_score 1049, oom_score_adj 0, VmRSS 1465 MiB, cmdline "node job.cjs 7666 50"',
				`11:31:12 sending SIGKILL to process 1790 uid 1001 "chrome": oom_score 700, oom_score_adj 0, VmRSS 222 MiB, cmdline "${main.trim()}"`,
				"",
			].join("\n"),
		);
		const lines = spawnSync("bash", ["-c", `guard_log=$1; ${extract}`, "extract", journal], { encoding: "utf8" });
		assert.equal(lines.status, 0, lines.stderr);
		assert.deepEqual(lines.stdout.trim().split("\n"), [`${tab}"`, 'node job.cjs 7666 50"', `${main.trim()}"`]);
		assert.deepEqual(kinds(lines.stdout.trim().split("\n")), ["tab", "job", "browser"]);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("an ended tab is no failure, a browser that is gone always is, and the tabs phase says whether it did what it is for", () => {
	// What an error on a tab means. The browser's debugging port decides first: whatever the error says, a browser that
	// no longer answers is gone.
	for (const message of ["page.goto: Page crashed", "page.evaluate: Target crashed", "no answer in 30000 ms", undefined])
		for (const crashed of [true, false]) assert.equal(whatEnded({ crashed, message, browserAnswers: false }), "browser");
	// The browser answers: a page that crashed is a tab the guard ended, by Playwright's word or by its crash event.
	assert.equal(whatEnded({ crashed: false, message: "page.goto: Page crashed", browserAnswers: true }), "tab");
	assert.equal(whatEnded({ crashed: false, message: "page.evaluate: Target crashed ", browserAnswers: true }), "tab");
	assert.equal(whatEnded({ crashed: true, message: "no answer in 20000 ms", browserAnswers: true }), "tab");
	// Anything else is that tab's own failure: a load that never came, no answer in time, a page closed under it.
	for (const message of [
		"page.goto: Timeout 45000ms exceeded.",
		"no answer in 30000 ms",
		"page.goto: net::ERR_NAME_NOT_RESOLVED at https://en.wikipedia.org/wiki/Oslo",
		"page.goto: Target page, context or browser has been closed",
		undefined,
	])
		assert.equal(whatEnded({ crashed: false, message, browserAnswers: true }), "other", String(message));

	// Past the edge the phase is for ending three tabs: it did what it is for when it stopped there with no other failure.
	assert.equal(tabsVerdict({ past: true, stop: "ended", ended: 3, failures: [] }), undefined);
	assert.equal(tabsVerdict({ past: true, stop: "ended", ended: 5, failures: [] }), undefined);
	// Its limit of tabs without three ends: the edge was not reached.
	assert.match(tabsVerdict({ past: true, stop: "limit", ended: 1, failures: [] }), /^it stopped at "limit" with 1 tab\(s\) ended: past the edge three are to be ended$/);
	assert.match(tabsVerdict({ past: true, stop: "failing", ended: 0, failures: [] }), /^it stopped at "failing"/);
	// A tab that failed for another reason than being ended fails the phase, wherever it stopped.
	for (const past of [true, false])
		for (const stop of ["ended", "limit", "room"])
			assert.match(
				tabsVerdict({ past, stop, ended: 3, failures: ["tab 7: page.goto: Timeout 45000ms exceeded.", "back to tab 1: no answer in 20000 ms"] }),
				/^2 tab\(s\) failed for another reason than being ended; the first: tab 7: page\.goto: Timeout 45000ms exceeded\.$/,
			);
	// Before the edge it is over at its limit or when the machine is nearly full; a tab the guard ended on the way is
	// said in the numbers, not failed.
	assert.equal(tabsVerdict({ past: false, stop: "limit", ended: 0, failures: [] }), undefined);
	assert.equal(tabsVerdict({ past: false, stop: "room", ended: 0, failures: [] }), undefined);
	assert.equal(tabsVerdict({ past: false, stop: "room", ended: 1, failures: [] }), undefined);
	assert.match(tabsVerdict({ past: false, stop: "failing", ended: 0, failures: [] }), /^it stopped at "failing"$/);
});

// Review round 2 of #1692 (F1). The proof's host half, run whole against a stand-in for lxc
// (machine-memory-proof/stand-in-lxc.sh): no LXD, no machine. Every leg of the stand-in answers one passing check and
// notes the size of the machine it ran on, so what these cases judge is the host's own steps.
test("a part ends, and the proof fails, when its machine could not be deleted, made, started or restarted (review r2 F1)", { skip: needsLinux }, async () => {
	const temporary = await mkdtemp(join(tmpdir(), "memory-proof-host-"));
	try {
		const bin = join(temporary, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "lxc"), read("scripts/machine-memory-proof/stand-in-lxc.sh"), { mode: 0o755 });
		// The proof wants root; the stand-in needs none.
		await writeFile(join(bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
		let number = 0;
		const prove = async (parts, { fails = [], saysKb, legClicks, killProbeAt, stallAtReading, pauseProbeAt, pauseBesideAt, legEndsWhileStopped, pause = "0.01" } = {}) => {
			number += 1;
			const state = join(temporary, `state-${number}`);
			await mkdir(join(state, "machines"), { recursive: true });
			await writeFile(join(state, "fails"), fails.map((line) => `${line}\n`).join(""));
			if (saysKb) await writeFile(join(state, "says-kb"), `${saysKb}\n`);
			if (legClicks) await writeFile(join(state, "leg-clicks"), `${legClicks}\n`);
			if (killProbeAt) await writeFile(join(state, "kill-probe-at"), `${killProbeAt}\n`);
			if (stallAtReading) await writeFile(join(state, "stall-at-reading"), `${stallAtReading}\n`);
			if (pauseProbeAt) await writeFile(join(state, "pause-probe-at"), `${pauseProbeAt}\n`);
			if (pauseBesideAt) await writeFile(join(state, "pause-beside-at"), `${pauseBesideAt}\n`);
			if (legEndsWhileStopped) await writeFile(join(state, "leg-ends-while-stopped"), `${legEndsWhileStopped}\n`);
			const result = await new Promise((resolveRun, rejectRun) => {
				const child = spawn(
					"bash",
					[join(repositoryRoot, "scripts/prove-machine-memory.sh"), "0".repeat(64), "qorpera-build", "qorpera0", "qorpera-vm", ...parts],
					{ stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${bin}:${process.env.PATH}`, STUB: state, MEMORY_PROOF_PROBE_PAUSE: pause } },
				);
				const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8").on("data", (chunk) => {
					stdout += chunk;
				});
				child.stderr.setEncoding("utf8").on("data", (chunk) => {
					stderr += chunk;
				});
				child.on("error", (error) => {
					clearTimeout(timer);
					rejectRun(error);
				});
				child.on("close", (status) => {
					clearTimeout(timer);
					resolveRun({ status, stdout, stderr });
				});
			});
			let legs = "";
			try {
				legs = readFileSync(join(state, "legs"), "utf8");
			} catch {}
			return { status: result.status, out: result.stdout + result.stderr, legs, left: readdirSync(join(state, "machines")) };
		};
		const failed = (run, why) => {
			assert.equal(run.status, 1, run.out);
			assert.match(run.out, why);
			assert.doesNotMatch(run.out, /PROOF PASSED/);
			assert.deepEqual(run.left, [], run.out);
		};
		const clicksHole = (word) => new RegExp(`\\nCHECK ${word}past the edge there was no hole in the clicks from the leg's start to its end \\(the longest time with none in flight: (\\d+\\.\\d\\d) s; `);
		const besideHole = (word) => new RegExp(`\\nCHECK ${word}past the edge there was no hole in the readings and looks beside them from the leg's start to its end \\(the longest time with none in flight: (\\d+\\.\\d\\d) s; `);
		const ends = /\nCHECK ok {3}past the edge the clicks' loop and the loop beside it ran from the leg's start to its end \((?:clicks rounds=\d+ beside rounds=\d+|beside rounds=\d+ clicks rounds=\d+)\)\n/;
		const answered = /\nCHECK ok {3}past the edge the machine kept answering desktop clicks \(/;
		const looks = /\nCHECK ok {3}past the edge the guest helper answered every look with an observation \(\d+ looks\)\n/;
		const oneFailed = /\nchecks: 8 ok, 1 failed; parts ended: 1 of 1; the parts' own status: 0; [^\n]+\nPROOF FAILED\n/;

		const [
			healthy,
			leftBehind,
			init2,
			start2,
			filePush8,
			list3,
			restart,
			wrongSize,
			probedLeg,
			probeEnded,
			stalled,
			stoodStill,
			overTheEnd,
			besideStoodStill,
			unread,
		] = await Promise.all([
			prove(["numbers", "small"]),
			prove(["numbers", "small"], { fails: ["delete 1", "init 2", "start 2"] }),
			prove(["numbers", "small"], { fails: ["init 2"] }),
			prove(["numbers", "small"], { fails: ["start 2"] }),
			prove(["numbers", "small"], { fails: ["file-push 8"] }),
			prove(["numbers", "small"], { fails: ["list 3"] }),
			prove(["checks"], { fails: ["restart 1"] }),
			prove(["small"], { saysKb: 3925216 }),
			prove(["edge"], { legClicks: 70 }),
			prove(["edge"], { legClicks: 90, killProbeAt: 75 }),
			prove(["edge"], { legClicks: 70, stallAtReading: "30 4" }),
			prove(["edge"], { legClicks: 62, pauseProbeAt: "20 2.5", pause: "0.25" }),
			prove(["edge"], { legClicks: 500, pauseProbeAt: "65 4", legEndsWhileStopped: "2", pause: "0.25" }),
			prove(["edge"], { legClicks: 62, pauseBesideAt: "1 3", pause: "0.25" }),
			prove(["small"], { fails: ["list 1"] }),
		]);

		assert.equal(healthy.status, 0, healthy.out);
		assert.match(healthy.out, /\nchecks: 8 ok, 0 failed; parts ended: 2 of 2; the parts' own status: 0; [^\n]+\nPROOF PASSED\n/);
		assert.equal(healthy.out.match(/\nCHECK ok {3}the part's machine is the one it asked for: 2 processors, [24]GiB /g).length, 2);
		assert.equal(
			healthy.legs,
			"4GiB mix nothing-else-running\n4GiB mix all-processors-busy busy\n4GiB load 1500 stop 24\n4GiB after stop\n2GiB load 600 stop 24\n2GiB after stop\n",
		);
		assert.deepEqual(healthy.left, []);

		failed(leftBehind, /\nFAIL: the machine \S+ could not be deleted\n(?:[^]*\n)?checks: 5 ok, 0 failed; parts ended: 0 of 2; the parts' own status: 1; [^\n]+\nPROOF FAILED\n/);
		assert.equal(leftBehind.legs, "4GiB mix nothing-else-running\n4GiB mix all-processors-busy busy\n4GiB load 1500 stop 24\n4GiB after stop\n");

		for (const [run, failLabel, why] of [
			[init2, "init 2", /\nFAIL: the machine could not be made\n/],
			[start2, "start 2", /\nFAIL: the machine could not be started\n/],
			[filePush8, "file-push 8", /\nFAIL: guest\.sh could not be put into the machine\n/],
			[list3, "list 3", /\nFAIL: the build space qorpera-build could not be listed\n/],
		]) {
			failed(run, why);
			assert.match(run.out, /\nchecks: \d+ ok, 0 failed; parts ended: [01] of 2; the parts' own status: 1; [^\n]+\nPROOF FAILED\n/);
			assert.doesNotMatch(run.legs, /load 600/, failLabel);
		}

		failed(restart, /\nFAIL: the machine could not be restarted\n[^]*\nPROOF FAILED\n/);
		assert.equal(restart.legs, "4GiB boot\n4GiB quiet\n4GiB pointer\n4GiB hide\n");

		failed(wrongSize, /\nCHECK FAIL the part's machine is the one it asked for: 2 processors, 2GiB \(it has \[2\] processors, \[3925216\] kB\)\n/);
		assert.match(wrongSize.out, /\nchecks: 0 ok, 1 failed; parts ended: 0 of 1; the parts' own status: 1; /);
		assert.equal(wrongSize.legs, "");

		assert.equal(probedLeg.status, 0, probedLeg.out);
		assert.match(probedLeg.out, /\nM past the edge clicks=(?:[7-9]\d|\d{3,}) failed=0 at_or_over_1s=0 at_or_over_2s=0 at_or_over_3s=0 longest_without_a_click_s=0\.\d\d longest_without_a_reading_or_look_s=0\.\d\d /);
		for (const check of [ends, answered, clicksHole("ok {3}"), besideHole("ok {3}"), looks]) assert.match(probedLeg.out, check);
		assert.match(probedLeg.out, /\nchecks: 9 ok, 0 failed; parts ended: 1 of 1; the parts' own status: 0; [^\n]+\nPROOF PASSED\n/);

		failed(probeEnded, /\nCHECK FAIL past the edge the clicks' loop and the loop beside it ran from the leg's start to its end \(the clicks' loop ended with 137, the one beside it with 0; the last lines they left: \[P-END beside [^\n|]*\|\]\)\n/);
		assert.match(probeEnded.out, /\nM past the edge clicks=7[0-4] failed=0 /);
		for (const check of [answered, clicksHole("ok {3}"), besideHole("ok {3}"), looks, oneFailed]) assert.match(probeEnded.out, check);

		failed(stalled, /\nCHECK FAIL past the edge the machine kept answering desktop clicks \(\d+ clicks, at least 60 wanted: 0 failed, 1 took 3 s or more, 1 took 2 s or more where 1 may\)\n/);
		assert.match(stalled.out, /\nM past the edge clicks=(?:[7-9]\d|\d{3,}) failed=0 at_or_over_1s=1 at_or_over_2s=1 at_or_over_3s=1 /);
		for (const check of [ends, clicksHole("ok {3}"), besideHole("ok {3}"), looks, oneFailed]) assert.match(stalled.out, check);

		failed(stoodStill, clicksHole("FAIL "));
		assert.ok(Number(stoodStill.out.match(clicksHole("FAIL "))[1]) >= 2.5, stoodStill.out);
		assert.match(stoodStill.out, /\nM past the edge clicks=(?:6[2-9]|[7-9]\d|\d{3,}) failed=0 at_or_over_1s=0 at_or_over_2s=0 at_or_over_3s=0 /);
		for (const check of [ends, answered, besideHole("ok {3}"), looks, oneFailed]) assert.match(stoodStill.out, check);

		failed(overTheEnd, clicksHole("FAIL "));
		assert.ok(Number(overTheEnd.out.match(clicksHole("FAIL "))[1]) >= 2, overTheEnd.out);
		assert.match(overTheEnd.out, /\nM past the edge clicks=(?:6[5-9]|7\d) failed=0 at_or_over_1s=0 at_or_over_2s=0 at_or_over_3s=0 /);
		for (const check of [ends, answered, besideHole("ok {3}"), looks, oneFailed]) assert.match(overTheEnd.out, check);

		failed(besideStoodStill, besideHole("FAIL "));
		assert.ok(Number(besideStoodStill.out.match(besideHole("FAIL "))[1]) >= 3, besideStoodStill.out);
		for (const check of [ends, answered, clicksHole("ok {3}"), looks, oneFailed]) assert.match(besideStoodStill.out, check);

		assert.equal(unread.status, 1, unread.out);
		assert.match(unread.out, /^FAIL: the build space qorpera-build could not be listed\n/m);
		assert.doesNotMatch(unread.out, /PROOF-START|PROOF PASSED/);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

// Review round 5 of #1692 (F1): the arithmetic of a loop's longest hole, on lines as the two loops write them. The
// function is taken out of the proof as it stands and run alone.
test("a loop's longest hole counts the time before its first call, between two calls, and after its last", async () => {
	const proof = read("scripts/prove-machine-memory.sh");
	const from = proof.indexOf("\nlongest_hole() {");
	const longestHole = proof.slice(from + 1, proof.indexOf("\n}\n", from) + 3);
	assert.match(longestHole, /^longest_hole\(\) \{ # the lines' pattern, the leg's start, the leg's end\n/);
	const temporary = await mkdtemp(join(tmpdir(), "memory-proof-hole-"));
	try {
		await writeFile(
			join(temporary, "probe"),
			[
				// Two clicks: 1000.0 to 1000.5 and 1001.5 to 1001.75. A reading 1000.2 to 1000.3, a look 1003.0 to 1004.0.
				"P 00:00:00 click_s=0.50 rc=0 at=1000.000000",
				"C 00:00:00 read_s=0.10 at=1000.200000 MemAvailable:900 AnonPages:10 SwapFree:900 ",
				"P 00:00:01 click_s=0.25 rc=124 at=1001.500000",
				"P 00:00:04 look_s=1.00 at=1003.000000 rc=0",
				"P-END clicks 00:00:05 rounds=2",
				"P-END beside 00:00:05 rounds=1",
				"",
			].join("\n"),
		);
		const hole = (pattern, start, finish) => {
			const result = spawnSync("bash", ["-c", `set -euo pipefail\nwork=$1\n${longestHole}longest_hole "$2" "$3" "$4"\n`, "hole", temporary, pattern, start, finish], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return result.stdout;
		};
		const clicks = " click_s=";
		const beside = " (read|look)_s=";
		// Between two clicks: from the end of the first (1000.5) to the start of the second (1001.5).
		assert.equal(hole(clicks, "1000.000000", "1001.750000"), "1.00");
		// Before the first click: the leg began 2.5 s earlier.
		assert.equal(hole(clicks, "997.500000", "1001.750000"), "2.50");
		// After the last click (it ended at 1001.75, failed or not): the leg went on for 3.25 s.
		assert.equal(hole(clicks, "1000.000000", "1005.000000"), "3.25");
		// Only the leg counts. One that began and ended inside the first click has no hole (the second click and the
		// time before it lie after its end); one that began in the first click and ended in the second has the whole
		// time between them; one that ended half way between them has that half.
		assert.equal(hole(clicks, "1000.100000", "1000.400000"), "0.00");
		assert.equal(hole(clicks, "1000.200000", "1001.600000"), "1.00");
		assert.equal(hole(clicks, "1000.200000", "1001.000000"), "0.50");
		// A leg that lay wholly before the loop's first call, or wholly after its last, is one hole.
		assert.equal(hole(clicks, "990.000000", "993.000000"), "3.00");
		assert.equal(hole(clicks, "1002.000000", "1004.500000"), "2.50");
		// The loop beside: the reading and the look count alike; the time between them (1000.3 to 1003.0) is the hole.
		assert.equal(hole(beside, "1000.200000", "1004.000000"), "2.70");
		assert.equal(hole(beside, "1000.000000", "1009.000000"), "5.00");
		// A loop that asked nothing has one hole as long as the leg.
		assert.equal(hole(" nothing_s=", "1000.000000", "1012.340000"), "12.34");
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
