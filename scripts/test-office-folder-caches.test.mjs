import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertAfterFirst, assertTarget, bundleHelper, PHASE_SECONDS, PUSHED, parseArgs } from "./test-office-folder-caches.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const digest = "a".repeat(64);
const argv = ["--project", "qfc-aaaaaaaa", "--vm", "qorpera-caches-aaaaaaaa", "--uuid", uuid, "--image", digest, "--folder-binary", "/tmp/folder", "--folder-sha256", digest, "--record", "/tmp/record.json", "--fuse", "present", "--phase", "first"];
const second = [...argv.slice(0, -1), "second", "--first", "/tmp/first.json"];
const options = parseArgs(argv);
const instance = { name: options.vm, type: "virtual-machine", status: "Running", config: { "user.qorpera.acceptance": "office-folder-caches", "volatile.uuid": uuid, "volatile.base_image": digest } };
const first = { schema: "qorpera.office-folder-caches/v1", phase: "first", executed: true, result: "passed", project: options.project, vm: options.vm, uuid, image: digest, folderSha256: digest, guestBoot: "boot-1" };

test("preflight is the default; the phase, the first phase's record and a dry run are explicit", () => {
	assert.equal(options.execute, false);
	assert.equal(options.unpinned, false);
	assert.equal(options.phase, "first");
	assert.equal(parseArgs([...argv, "--execute", "--unpinned-program"]).unpinned, true);
	assert.equal(parseArgs(second).first, "/tmp/first.json");
	assert.equal(parseArgs([...argv.slice(0, -3), "loaded", "--phase", "first"]).fuse, "loaded");
	assert.doesNotThrow(() => assertTarget(instance, options));
	// The revocation rows wait out the desktop's 60 s grace; the second phase only mounts and reads.
	assert.deepEqual(PHASE_SECONDS, { first: 900, second: 300 });
});

test("reject ambiguous, incomplete or unsafe CLI targets before LXD is called", () => {
	for (const extra of [["--execute", "--execute"], ["--unpinned-program", "--unpinned-program"], ["--unexpected"], ["--vm", "another"], ["--record"], ["--first", "/tmp/first.json"]]) assert.throws(() => parseArgs([...argv, ...extra]));
	assert.throws(() => parseArgs(second.slice(0, -2)), /--first/);
	for (const [flag, value] of [["--vm", "qorpera-remount-x"], ["--vm", "production"], ["--project", "remote:project"], ["--uuid", "prefix"], ["--image", "short-digest"], ["--folder-sha256", "short-digest"], ["--fuse", "modprobe"], ["--phase", "third"], ["--folder-binary", "--execute"]]) {
		const changed = [...argv];
		changed[changed.indexOf(flag) + 1] = value;
		assert.throws(() => parseArgs(changed), flag);
	}
	assert.throws(() => parseArgs(argv.slice(0, -2)), /--phase/);
});

test("refuse a container, a stopped VM, another proof's marker, identity or image drift", () => {
	for (const field of [{ name: "other" }, { type: "container" }, { status: "Stopped" }, { config: {} }, { config: { ...instance.config, "user.qorpera.acceptance": "office-folder-remount" } }, { config: { ...instance.config, "volatile.uuid": "different" } }, { config: { ...instance.config, "volatile.base_image": "b".repeat(64) } }]) assert.throws(() => assertTarget({ ...instance, ...field }, options));
});

test("the second phase runs only after a first that passed, on the same VM and program, in a new boot", () => {
	const after = parseArgs(second);
	assert.doesNotThrow(() => assertAfterFirst(first, after, "boot-2"));
	assert.throws(() => assertAfterFirst(first, after, "boot-1"), /did not restart/);
	assert.throws(() => assertAfterFirst(undefined, after, "boot-2"), /did not pass/);
	for (const field of [{ schema: "qorpera.office-folder-remount/v1" }, { phase: "second" }, { executed: false }, { result: "failed" }, { project: "qfc-bbbbbbbb" }, { vm: "qorpera-caches-bbbbbbbb" }, { uuid: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }, { image: "b".repeat(64) }, { folderSha256: "b".repeat(64) }, { guestBoot: undefined }]) assert.throws(() => assertAfterFirst({ ...first, ...field }, after, "boot-2"), JSON.stringify(field));
});

test("every pushed source exists and the guest programs parse", () => {
	for (const path of Object.values(PUSHED)) assert.ok(existsSync(resolve(root, path)), path);
	for (const name of ["office-folder-caches.py", "office-folder-remount.py", "office-folder-substrate.py"]) execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", resolve(root, PUSHED[name])], { timeout: 10_000 });
});

test("the bound and its must-fails, the synthetic node's wire, the office client and the unit's cache line, without privilege", () => {
	const result = JSON.parse(execFileSync("python3", [resolve(root, PUSHED["office-folder-caches.py"]), "selftest", resolve(root, PUSHED["mount.service"])], { encoding: "utf8", timeout: 60_000 }));
	assert.deepEqual(result, { wireFixture: "passed", privilegedProof: "not-run" });
});

test("the bundled helper drives only the proof's mount units, and never publishes, launches or relays", async () => {
	const directory = mkdtempSync(join(tmpdir(), "qorpera-caches-helper-"));
	try {
		await bundleHelper(join(directory, "helper.mjs"));
		const { PROOF_UNIT, proofSystem } = await import(pathToFileURL(join(directory, "helper.mjs")).href);
		assert.equal(PROOF_UNIT, "qorpera-caches-folder-mount");
		const calls = [];
		const fake = Object.fromEntries(["inspect", "start", "stop", "resetFailed", "publish", "launch", "relay", "share"].map((method) => [method, (...args) => (calls.push([method, ...args]), method)]));
		const system = proofSystem(fake);
		for (const kind of ["desktop", "command"]) {
			calls.length = 0;
			for (const method of ["inspect", "start", "stop", "resetFailed"]) assert.equal(system[method](`qorpera-office-folder-mount@${kind}-${uuid}.service`), method);
			assert.deepEqual(calls, ["inspect", "start", "stop", "resetFailed"].map((method) => [method, `qorpera-caches-folder-mount@${kind}-${uuid}.service`]));
		}
		// What is not a unit passes through unchanged.
		assert.equal(system.share("/run/qorpera-folder/mounts/x"), "share");
		calls.length = 0;
		for (const unit of ["qorpera-company-computer.service", `qorpera-office-folder-mount@shell-${uuid}.service`, `qorpera-caches-folder-mount@command-${uuid}.service`, `qorpera-office-folder-mount@command-${uuid}.service.d`]) assert.throws(() => system.start(unit), /Not a folder mount unit/, unit);
		for (const method of ["publish", "launch", "relay"]) assert.throws(() => system[method]([]), /never/, method);
		assert.deepEqual(calls, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
