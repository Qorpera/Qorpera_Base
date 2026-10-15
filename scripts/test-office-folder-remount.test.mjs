import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertGuest, assertTarget, checkPins, excerpt, officeNamesSource, PUSHED, parseArgs, processModule, RUNTIME_PINS, remountShapes, STANDINS } from "./test-office-folder-remount.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const digest = "a".repeat(64);
const argv = ["--project", "qrm-aaaaaaaa", "--vm", `qorpera-remount-${uuid}`, "--uuid", uuid, "--image", digest, "--folder-binary", "/tmp/pinned-folder", "--folder-sha256", digest, "--record", "/tmp/record.json", "--fuse", "present"];
const options = parseArgs(argv);
const instance = { name: options.vm, type: "virtual-machine", status: "Running", config: { "user.qorpera.acceptance": "office-folder-remount", "volatile.uuid": uuid, "volatile.base_image": digest } };
const guest = { boot: uuid, container: false, virtualization: "kvm", unitSha256: "b".repeat(64), officeState: "failed", credentialNames: [], bootNames: [] };
const outer = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";

test("preflight is the default; execution and the FUSE origin are explicit", () => {
	assert.equal(options.execute, false);
	assert.equal(options.fuse, "present");
	assert.equal(parseArgs([...argv.slice(0, -1), "loaded"]).fuse, "loaded");
	assert.equal(parseArgs([...argv, "--execute"]).execute, true);
	assert.doesNotThrow(() => assertTarget(instance, options));
	assert.doesNotThrow(() => assertGuest(guest, outer));
	// A1 predates folder-v2: its own office unit is recorded, not required to match this tree's.
	assert.doesNotThrow(() => assertGuest({ ...guest, unitSha256: null }, outer));
});

test("reject ambiguous, incomplete or unsafe CLI targets before LXD is called", () => {
	for (const extra of [["--execute", "--execute"], ["--unexpected"], ["--vm", "another"], ["--record"], ["--fuse", "loaded"], ["--owner-mode", "root-default"]]) assert.throws(() => parseArgs([...argv, ...extra]));
	for (const [flag, value] of [["--vm", "qorpera-substrate-x"], ["--vm", "production"], ["--project", "remote:project"], ["--uuid", "prefix"], ["--image", "short-digest"], ["--folder-sha256", "short-digest"], ["--fuse", "modprobe"], ["--folder-binary", "--execute"]]) {
		const changed = [...argv];
		changed[changed.indexOf(flag) + 1] = value;
		assert.throws(() => parseArgs(changed), flag);
	}
	assert.throws(() => parseArgs(argv.slice(0, -2)), /--fuse/);
});

test("refuse a container, a stopped VM, a missing marker or identity and image drift", () => {
	for (const field of [{ name: "other" }, { type: "container" }, { status: "Stopped" }, { config: {} }, { config: { ...instance.config, "user.qorpera.acceptance": "office-folder-substrate" } }, { config: { ...instance.config, "volatile.uuid": "different" } }, { config: { ...instance.config, "volatile.base_image": "b".repeat(64) } }]) assert.throws(() => assertTarget({ ...instance, ...field }, options));
});

test("refuse a shared kernel, unknown virtualization, an active office, credentials or boots", () => {
	assert.throws(() => assertGuest(guest, uuid));
	for (const field of [{ boot: "" }, { container: true }, { container: undefined }, { virtualization: "none" }, { officeState: "active" }, { officeState: "activating" }, { officeState: "deactivating" }, { officeState: undefined }, { credentialNames: ["config.json"] }, { bootNames: [uuid] }, { credentialNames: undefined }, { bootNames: "" }]) assert.throws(() => assertGuest({ ...guest, ...field }, outer));
});

test("the office probe lists names only, and treats a file or a link as occupied", () => {
	const directory = mkdtempSync(join(tmpdir(), "qorpera-remount-names-"));
	const probe = (name) => JSON.parse(execFileSync("python3", ["-c", `import json,pathlib,sys\n${officeNamesSource}\nprint(json.dumps(office_names(pathlib.Path(sys.argv[1]))))`, join(directory, name)], { encoding: "utf8", timeout: 5000 }));
	try {
		assert.deepEqual(probe("missing"), []);
		mkdirSync(join(directory, "credentials"));
		assert.deepEqual(probe("credentials"), []);
		writeFileSync(join(directory, "credentials", "config.json"), "synthetic");
		mkdirSync(join(directory, "credentials", "native"));
		assert.deepEqual(probe("credentials"), ["config.json", "native"]);
		writeFileSync(join(directory, "boots"), "synthetic");
		assert.deepEqual(probe("boots"), ["(not a directory)"]);
		symlinkSync(join(directory, "credentials"), join(directory, "linked"));
		assert.deepEqual(probe("linked"), ["(not a directory)"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the runtime lines the shapes mirror are the pinned ones", () => {
	assert.doesNotThrow(() => checkPins());
	assert.throws(() => checkPins((file) => readFileSync(resolve(root, file), "utf8").replace('"--unshare-net",', '"--share-net",')), /cloud-company-computer-linux-host\.ts/);
	assert.throws(() => excerpt("a\nb\na\n", "a", "b"), /not one line/);
	assert.throws(() => excerpt("a\nb\n", "a", "c"), /end missing/);
	assert.equal(excerpt("x\n  a\n b\n c\n", "a", "c"), "  a\n b\n c");
	const network = RUNTIME_PINS.find((pin) => pin.file.endsWith("-network.ts"));
	const lines = excerpt(readFileSync(resolve(root, network.file), "utf8"), network.from, network.to);
	assert.ok(lines.includes(`export const COMPANY_COMPUTER_HOSTS = ${JSON.stringify(STANDINS.hosts)};`));
	assert.ok(lines.includes('export const COMPANY_COMPUTER_AGENT_EXIT_DNS = "10.210.0.1";'));
	assert.ok(lines.includes("export const COMPANY_COMPUTER_RESOLV_CONF = `nameserver ${COMPANY_COMPUTER_AGENT_EXIT_DNS}\\noptions timeout:2 attempts:2\\n`;"));
	assert.equal(STANDINS["resolv.conf"], "nameserver 10.210.0.1\noptions timeout:2 attempts:2\n");
});

/** The arguments with each `--setenv NAME VALUE` taken out. */
const withoutEnvironment = (args) => args.filter((_, index) => ![args[index], args[index - 1], args[index - 2]].includes("--setenv"));

test("each shape places the folder once, after its other mounts and before the start directory, on the descriptor after its own", () => {
	const shapes = remountShapes("/run/qorpera-remount-x");
	assert.equal(shapes.root, "/run/qorpera-folder");
	assert.deepEqual(shapes.standins, STANDINS);
	for (const [name, folderFd] of [["desktop", 9], ["command", 5], ["shell", 7]]) {
		const shape = shapes.shapes[name];
		const marks = shape.args.flatMap((arg, index) => (arg?.folder ? [index] : []));
		assert.equal(marks.length, 1, name);
		// Only the environment, then the start, after it: no mount over the folder or after it.
		assert.deepEqual(withoutEnvironment(shape.args.slice(marks[0] + 1)), ["--chdir", "/run/qorpera-office/private", "--remount-ro", "/"], name);
		// The relay's arithmetic: inherited descriptors start at 3, after the gate's pipes.
		assert.equal(3 + (shape.pipeCount ?? 0) + shape.files.length, folderFd, name);
		const bound = shape.args.flatMap((arg, index) => (arg === "--bind-fd" || arg === "--ro-bind-fd" ? [Number(shape.args[index + 1])] : []));
		assert.deepEqual(bound, Array.from({ length: shape.files.length }, (_, index) => 3 + (shape.pipeCount ?? 0) + index), name);
		for (const file of shape.files) assert.ok(file.path.startsWith("/run/qorpera-remount-x/standin/"), file.path);
		// The relay's form places the folder; a shape names `/company` only in the desktop's environment.
		const named = shape.args.flatMap((arg, index) => (typeof arg === "string" && arg.includes("/company") ? [shape.args.slice(index - 2, index + 1)] : []));
		assert.deepEqual(named, name === "desktop" ? [["--setenv", "QORPERA_COMPANY_FOLDER", "/company"]] : [], name);
		assert.ok(!JSON.stringify(shape.files).includes("/company"), name);
	}
	// 4d-2a's desktop: the folder after `/etc/os-release`, its environment after the folder.
	const desktop = shapes.shapes.desktop.args;
	const mark = desktop.findIndex((arg) => arg?.folder);
	assert.deepEqual(desktop.slice(mark - 3, mark), ["--symlink", "../usr/lib/os-release", "/etc/os-release"]);
	assert.equal(desktop[mark + 1], "--setenv");
	assert.deepEqual(shapes.shapes.desktop.args.slice(shapes.shapes.desktop.args.indexOf("--ro-bind-fd"), shapes.shapes.desktop.args.indexOf("--ro-bind-fd") + 3), ["--ro-bind-fd", "8", "/etc/machine-id"]);
	assert.equal(shapes.shapes.shell.args[shapes.shapes.shell.args.indexOf("--tmpfs") - 1], String(512 * 1024 * 1024));
	assert.equal(shapes.shapes.desktop.args.filter((arg) => arg?.requiredRoBind).length, 8);
	assert.equal(shapes.shapes.shell.args.filter((arg) => arg?.optionalRoBind).length, 9);
});

test("the runtime's process gate runs with its types stripped and nothing else changed", async () => {
	const directory = mkdtempSync(join(tmpdir(), "qorpera-remount-gate-"));
	try {
		const source = processModule();
		assert.ok(!/: (ChildProcess|FileHandle|Duplex)\b/.test(source));
		writeFileSync(join(directory, "company-computer-process.mjs"), source);
		const gate = await import(pathToFileURL(join(directory, "company-computer-process.mjs")).href);
		assert.equal(typeof gate.spawnCompanyComputerLinuxProcess, "function");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("every pushed source exists and the guest programs parse", () => {
	for (const path of Object.values(PUSHED)) assert.ok(existsSync(resolve(root, path)), path);
	execFileSync(process.execPath, ["--check", resolve(root, PUSHED["office.mjs"])], { timeout: 10_000 });
	execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", resolve(root, PUSHED["office-folder-remount-client.py"])], { timeout: 10_000 });
});

test("the unit rewrite, the office lines, mountinfo reading and the synthetic node's wire, without privilege", () => {
	const result = JSON.parse(execFileSync("python3", [resolve(root, PUSHED["office-folder-remount.py"]), "selftest", resolve(root, PUSHED["office.service"]), resolve(root, PUSHED["mount.service"])], { encoding: "utf8", timeout: 30_000 }));
	assert.deepEqual(result, { wireFixture: "passed", privilegedProof: "not-run" });
});
