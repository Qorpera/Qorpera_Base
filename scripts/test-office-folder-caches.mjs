import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGuest, guestProbeSource } from "./test-office-folder-remount.mjs";

// This launcher NEVER creates an instance, installs packages, changes a host's kernel settings or accepts a remote
// LXD. The VM, its restart and its FUSE come from prove-office-folder-caches-vm.sh. See
// deploy/test-machine/OFFICE-FOLDER-CACHES.md.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = "office-folder-caches";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Each phase's guest proof may run this long; the revocation rows wait out the desktop's 60 s grace twice. */
export const PHASE_SECONDS = { first: 900, second: 300 };

export function parseArgs(args) {
	const out = { execute: false, unpinned: false };
	const names = ["project", "vm", "uuid", "image", "folder-binary", "folder-sha256", "record", "fuse", "phase", "first"];
	for (let i = 0; i < args.length; i++) {
		const key = args[i].replace(/^--/, "");
		if (args[i] === "--execute" && !out.execute) out.execute = true;
		else if (args[i] === "--unpinned-program" && !out.unpinned) out.unpinned = true;
		else if (names.includes(key) && args[i].startsWith("--") && !Object.hasOwn(out, key) && args[i + 1] && !args[i + 1].startsWith("--")) out[key] = args[++i];
		else throw new Error(`Unknown, duplicate or incomplete option: ${args[i]}`);
	}
	for (const key of names.filter((name) => name !== "first")) if (!out[key]) throw new Error(`Required: --${key}`);
	if (!["first", "second"].includes(out.phase)) throw new Error("The phase is first or second");
	if ((out.phase === "second") !== Object.hasOwn(out, "first")) throw new Error("--first names the first phase's record, and only for the second");
	if (!["present", "loaded"].includes(out.fuse)) throw new Error("FUSE must be present or loaded");
	if (!/^qorpera-caches-[a-z0-9-]{1,40}$/.test(out.vm)) throw new Error("VM must have the disposable qorpera-caches- prefix");
	if (!/^[a-z][a-z0-9-]{0,62}$/.test(out.project)) throw new Error("Invalid project");
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(out.uuid)) throw new Error("Expected physical UUID required");
	for (const key of ["image", "folder-sha256"]) if (!/^[a-f0-9]{64}$/.test(out[key])) throw new Error(`Full digest required: ${key}`);
	return out;
}

export function assertTarget(instance, options) {
	if (instance.name !== options.vm || instance.type !== "virtual-machine" || instance.status !== "Running") throw new Error("Expected running virtual machine");
	if (instance.config?.["user.qorpera.acceptance"] !== marker) throw new Error("Missing disposable acceptance marker");
	if (instance.config?.["volatile.uuid"] !== options.uuid) throw new Error("Physical UUID differs");
	if (instance.config?.["volatile.base_image"] !== options.image) throw new Error("Image fingerprint differs");
}

/** The second phase runs only after a first that passed, on the same VM and program, in a new boot of the guest. */
export function assertAfterFirst(first, options, guestBoot) {
	if (first?.schema !== "qorpera.office-folder-caches/v1" || first.phase !== "first" || first.executed !== true || first.result !== "passed") throw new Error("The first phase did not pass");
	for (const [key, value] of [["project", options.project], ["vm", options.vm], ["uuid", options.uuid], ["image", options.image], ["folderSha256", options["folder-sha256"]]])
		if (first[key] !== value) throw new Error(`The first phase ran with another ${key}`);
	if (!first.guestBoot || first.guestBoot === guestBoot) throw new Error("The guest did not restart after the first phase");
}

/** Guest file name → its source in this tree; the helper is bundled beside the run. */
export const PUSHED = {
	"office-folder-substrate.py": "scripts/fixtures/office-folder-substrate.py",
	"office-folder-remount.py": "scripts/fixtures/office-folder-remount.py",
	"office-folder-caches.py": "scripts/fixtures/office-folder-caches.py",
	"mount.service": "deploy/lxd-company-computer-guest/qorpera-office-folder-mount@.service.in",
};

/** The office's folder helper from this tree, bundled for the guest's node as the company computer package bundles
 * the runtime (scripts/package-company-computer.mjs). */
export async function bundleHelper(outfile) {
	const { build } = await import("esbuild");
	await build({
		absWorkingDir: root,
		entryPoints: ["scripts/fixtures/office-folder-caches-helper.mjs"],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		legalComments: "none",
		logLevel: "silent",
		banner: { js: 'import { createRequire as __qorperaCreateRequire } from "node:module"; const require = __qorperaCreateRequire(import.meta.url);' },
	});
}

/** What the launcher itself vouches for: the run's target, the program and the pushed files' digests. */
export function evidenceOf(options, guest, digests) {
	return {
		schema: "qorpera.office-folder-caches/v1",
		scope: "the office folder mounts' caches on the machine's disk through master's folder helper and mount unit, and a closed view's end; synthetic folder node",
		phase: options.phase,
		project: options.project,
		vm: options.vm,
		uuid: options.uuid,
		image: options.image,
		fuse: options.fuse,
		folderSha256: options["folder-sha256"],
		// A dry run against a program that is not the checked-in record's is never the proof.
		programPinned: !options.unpinned,
		digests,
		guestBoot: guest.boot,
		guestOfficeUnitSha256: guest.unitSha256,
		executed: false,
	};
}

/** The phase's record: the launcher's evidence, then the guest's record for every key the evidence does not hold (the
 * guest's own schema is kept as `guestSchema`), so the second phase finds the first's schema, target and program. A
 * second phase passes only with its first. */
export function recordOf(evidence, guest, first) {
	const { schema: guestSchema, ...rest } = guest;
	const record = { ...evidence, executed: true, guestSchema, ...Object.fromEntries(Object.entries(rest).filter(([key]) => !Object.hasOwn(evidence, key))) };
	return first ? { ...record, first, result: guest.result === "passed" && first.result === "passed" ? "passed" : "failed" } : record;
}

export async function main(args) {
	const options = parseArgs(args);
	if (process.platform !== "linux" || !existsSync("/etc/qorpera-test-machine-versions")) throw new Error("Run the launcher through run-on-node on a configured test machine");
	const command = (args, extra = {}) => execFileSync("lxc", ["--force-local", "--project", options.project, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...extra });
	const instance = JSON.parse(command(["list", options.vm, "--format", "json"])).find((entry) => entry.name === options.vm);
	assertTarget(instance ?? {}, options);
	if (sha256(readFileSync(realpathSync(options["folder-binary"]))) !== options["folder-sha256"]) throw new Error("Folder binary digest differs");
	const guest = JSON.parse(command(["exec", options.vm, "--", "python3", "-c", guestProbeSource]));
	assertGuest(guest, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
	const first = options.phase === "second" ? JSON.parse(readFileSync(options.first, "utf8")) : undefined;
	if (first) assertAfterFirst(first, options, guest.boot);
	const local = mkdtempSync(join(tmpdir(), "qorpera-caches-"));
	const dir = `/run/qorpera-caches-${options.uuid}`;
	try {
		await bundleHelper(join(local, "helper.mjs"));
		const sources = { ...Object.fromEntries(Object.entries(PUSHED).map(([name, path]) => [name, resolve(root, path)])), "helper.mjs": join(local, "helper.mjs"), "qorpera-folder": realpathSync(options["folder-binary"]) };
		const digests = Object.fromEntries(Object.entries(sources).map(([name, path]) => [name, sha256(readFileSync(path))]));
		const evidence = evidenceOf(options, guest, digests);
		if (!options.execute) {
			writeFileSync(options.record, `${JSON.stringify({ ...evidence, result: "plan", guestCommand: ["python3", `${dir}/office-folder-caches.py`, "proof", dir, options.fuse, options.phase] }, null, 2)}\n`);
			console.log("Preflight passed. No guest files or units created.");
			return;
		}
		const record = recordOf(evidence, execute(command, options, dir, sources, digests), first);
		const output = `${JSON.stringify(record, null, 2)}\n`;
		writeFileSync(options.record, output);
		console.log(output);
		if (record.result !== "passed") process.exitCode = 1;
	} finally {
		rmSync(local, { recursive: true, force: true });
	}
}

function execute(command, options, dir, sources, digests) {
	let created = false;
	let fixtureInstalled = false;
	let result;
	try {
		command(["exec", options.vm, "--", "mkdir", "-m", "0755", dir]);
		created = true;
		command(["file", "push", sources["office-folder-caches.py"], `${options.vm}${dir}/office-folder-caches.py`]);
		fixtureInstalled = true;
		for (const [name, path] of Object.entries(sources)) if (name !== "office-folder-caches.py") command(["file", "push", path, `${options.vm}${dir}/${name}`], { timeout: 120_000 });
		const names = Object.keys(sources);
		const hashes = JSON.parse(command(["exec", options.vm, "--", "python3", "-c", "import hashlib,json,pathlib,sys; p=pathlib.Path(sys.argv[1]); print(json.dumps({n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in sys.argv[2:]}))", dir, ...names]));
		const differs = names.filter((name) => hashes[name] !== digests[name]);
		if (differs.length) throw new Error(`Copied artifact digest differs: ${differs.join(", ")}`);
		command(["exec", options.vm, "--", "chmod", "0644", ...names.map((name) => `${dir}/${name}`)]);
		// A timed-out or disconnected lxc client must not leave a root process or a mount running in the guest.
		const seconds = PHASE_SECONDS[options.phase];
		const output = command(["exec", options.vm, "--", "systemd-run", "--quiet", "--wait", "--pipe", "--collect", "--unit", `qorpera-caches-${options.uuid}-proof`, "--property", `RuntimeMaxSec=${seconds}`, "--property", "KillMode=control-group", "--", "python3", `${dir}/office-folder-caches.py`, "proof", dir, options.fuse, options.phase], { timeout: (seconds + 60) * 1000 });
		result = JSON.parse(output.trim().split("\n").at(-1));
	} catch (error) {
		result = { result: "harness-error", error: error.message, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
	} finally {
		// Never delete a VM or an arbitrary path. After a first phase that passed, the fixture keeps the caches on the
		// guest's disk for the second and takes away everything else; otherwise it removes all it claimed.
		const step = options.phase === "first" && result?.result === "passed" ? "pause" : "cleanup";
		try {
			if (fixtureInstalled) result = { ...result, [step]: JSON.parse(command(["exec", options.vm, "--", "python3", `${dir}/office-folder-caches.py`, step, dir], { timeout: 180_000 }).trim().split("\n").at(-1)) };
			else if (created) command(["exec", options.vm, "--", "rmdir", dir]);
		} catch (error) {
			result = { ...result, result: "harness-error", cleanupError: error.message, cleanupStdout: String(error.stdout ?? ""), cleanupStderr: String(error.stderr ?? "") };
		}
	}
	return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
