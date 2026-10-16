import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This launcher NEVER creates an instance, installs packages, changes a host's kernel settings or accepts a
// remote LXD. The VM comes from prove-office-folder-remount-vm.sh. See deploy/test-machine/OFFICE-FOLDER-REMOUNT.md.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = "office-folder-remount";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Shared verbatim with the unprivileged test. Names only, never contents: the run stops unless both are empty.
export const officeNamesSource = `def office_names(path):
 if path.is_symlink() or (path.exists() and not path.is_dir()):
  return ['(not a directory)']
 return sorted(p.name for p in path.iterdir()) if path.exists() else []`;

export function parseArgs(args) {
	const out = { execute: false };
	const names = ["project", "vm", "uuid", "image", "folder-binary", "folder-sha256", "record", "fuse"];
	for (let i = 0; i < args.length; i++) {
		const key = args[i].replace(/^--/, "");
		if (args[i] === "--execute" && !out.execute) out.execute = true;
		else if (names.includes(key) && args[i].startsWith("--") && !Object.hasOwn(out, key) && args[i + 1] && !args[i + 1].startsWith("--")) out[key] = args[++i];
		else throw new Error(`Unknown, duplicate or incomplete option: ${args[i]}`);
	}
	for (const key of names) if (!out[key]) throw new Error(`Required: --${key}`);
	if (!["present", "loaded"].includes(out.fuse)) throw new Error("FUSE must be present or loaded");
	if (!/^qorpera-remount-[a-z0-9-]{1,40}$/.test(out.vm)) throw new Error("VM must have the disposable qorpera-remount- prefix");
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

// The installed office unit may differ from this tree's (A1 predates folder-v2): the proof records the difference.
export function assertGuest(guest, outerBoot) {
	if (!/^[a-f0-9-]{36}$/.test(guest.boot ?? "") || guest.boot === outerBoot || guest.container !== false || guest.virtualization !== "kvm") throw new Error("A separate nested KVM kernel is required");
	if (!["inactive", "failed"].includes(guest.officeState)) throw new Error("Refusing an active or unknown office");
	if (!Array.isArray(guest.credentialNames) || !Array.isArray(guest.bootNames) || guest.credentialNames.length || guest.bootNames.length) throw new Error("Refusing an office with credentials or boots");
}

export const guestProbeSource = `import hashlib,json,pathlib,subprocess
${officeNamesSource}
p=pathlib.Path('/etc/systemd/system/qorpera-company-computer.service')
def cmd(a):
 r=subprocess.run(a,capture_output=True,text=True); return r.stdout.strip()
print(json.dumps({'boot':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'container':cmd(['systemd-detect-virt','--container']) not in ('','none'), 'virtualization':cmd(['systemd-detect-virt','--vm']), 'unitSha256':hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None, 'officeState':cmd(['systemctl','is-active','qorpera-company-computer.service']), 'credentialNames':office_names(pathlib.Path('/etc/qorpera-office/credentials')), 'bootNames':office_names(pathlib.Path('/etc/qorpera-office/boots'))}))`;

// The runtime lines the shapes below mirror. A change to any of them stops the launcher until the shapes follow.
export const RUNTIME_PINS = [
	{ file: "packages/runtime/src/cloud-company-computer-linux-host.ts", from: "export function companyComputerLinuxSandboxArgs(tmpBytes = 67108864): string[] {", to: "}", sha256: "39208f0c978cdd1be87ddf399819e8519d58a3f3546ee93f19fb729a6b17bef4" },
	{ file: "packages/runtime/src/cloud-company-computer-linux-desktop.ts", from: "files.push(await openCompanyComputerLinuxDirectory(layout.workbenchRoot, false));", to: 'stdin: "ignore",', sha256: "95f8f458866f3d1cb6ffb4ac5ee3db16cb3674519c7f10cfcbe14d6a40618396" },
	{ file: "packages/runtime/src/cloud-company-computer-linux-commands.ts", from: "const workbench = await openCompanyComputerLinuxDirectory(this.#layout.workbenchRoot, false);", to: 'stdin: "pipe",', sha256: "48ddc6b2a1d2a0b553f91535dbfb4ad7ca8917b694951794775845ee811c498f" },
	{ file: "packages/runtime/src/cloud-company-computer-linux-shell.ts", from: "export const COMPANY_COMPUTER_SHELL_TMP_BYTES = 512 * 1024 * 1024;", to: 'const SHELL_IMAGE_DIRECTORIES = ["/etc/ssl/certs", "/etc/alternatives", "/etc/fonts", "/etc/xdg", "/etc/libreoffice"];', sha256: "3a40c2ca43e9bde7c283eb2b55ab32461328a9dde1c5b7b14c893b9b7ddb51c3" },
	// The shell's shape without the company folder; with it (4d-4b), each command's mount is the folder helper's.
	{ file: "packages/runtime/src/cloud-company-computer-linux-shell.ts", from: "files.push(await openCompanyComputerLinuxDirectory(layout.workbenchRoot, false));", to: "pipeCount: 2,", sha256: "c1de8812c904af118ec6d908872bc977f89e92bbd7a0ae9aad7b3fc795640ada" },
	{ file: "packages/runtime/src/cloud-company-computer-linux-network.ts", from: 'export const COMPANY_COMPUTER_AGENT_EXIT_DNS = "10.210.0.1";', to: 'export const COMPANY_COMPUTER_HOSTS = "127.0.0.1\\tlocalhost\\n::1\\tlocalhost ip6-localhost ip6-loopback\\n";', sha256: "d59958ee52f793e2efdb12eac71e1344a7451bc6e3bf8842955a4228c2a9c5d3" },
	// The workbench every namespace binds and starts in.
	{ file: "deploy/lxd-company-computer-guest/qorpera-office-private.mount.in", from: "Where=/run/qorpera-office/private", to: "Where=/run/qorpera-office/private", sha256: "7f06bb7728270fef99dc5abd5fb0b9a5e25784cc6c3301685993f2cc85bbf6fd" },
];

/** The pinned lines: the one line equal to `from` (trimmed) through the first line after it equal to `to`. */
export function excerpt(text, from, to) {
	const lines = text.split("\n");
	const starts = lines.flatMap((line, index) => (line.trim() === from ? [index] : []));
	if (starts.length !== 1) throw new Error(`Pin start is not one line: ${from}`);
	const end = from === to ? starts[0] : lines.findIndex((line, index) => index > starts[0] && line.trim() === to);
	if (end < 0) throw new Error(`Pin end missing: ${to}`);
	return lines.slice(starts[0], end + 1).join("\n");
}

export function checkPins(read = (file) => readFileSync(resolve(root, file), "utf8")) {
	const changed = RUNTIME_PINS.filter((pin) => sha256(excerpt(read(pin.file), pin.from, pin.to)) !== pin.sha256);
	if (changed.length) throw new Error(`Runtime lines the proof mirrors changed; update its shapes: ${changed.map((pin) => `${pin.file}: ${pin.from}`).join("; ")}`);
}

const WORKBENCH = "/run/qorpera-office/private";
const HOME = "/home/qorpera";
const SCREEN = "q3-screen";
export const STANDINS = {
	hosts: "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n",
	"resolv.conf": "nameserver 10.210.0.1\noptions timeout:2 attempts:2\n",
};

function sandboxArgs(tmpBytes) {
	return ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--size", String(tmpBytes), "--tmpfs", "/tmp"];
}

const setenv = (values) => Object.entries(values).flatMap(([name, value]) => ["--setenv", name, value]);

/**
 * The runtime's three namespace shapes with the guest's own private surface replaced by stand-ins under `dir`
 * (pinned above). `{ folder: true }` marks where the folder goes: after the shape's last other mount, with only the
 * environment and the start after it. The desktop's is where 4d-2a puts it, before its environment, which names it in
 * `QORPERA_COMPANY_FOLDER`; the shell's and a command's are where 4d places them.
 */
export function remountShapes(dir) {
	const standin = (name, directory = true) => ({ path: `${dir}/standin/${name}`, directory });
	const network = ["--ro-bind", `${dir}/standin/hosts`, "/etc/hosts", "--ro-bind", `${dir}/standin/resolv.conf`, "/etc/resolv.conf"];
	const start = ["--chdir", WORKBENCH, "--remount-ro", "/"];
	const desktop = {
		files: [standin("workbench"), standin("home"), standin("screen"), standin("x11"), standin("session"), standin("machine-id", false)],
		args: [
			...sandboxArgs(67108864),
			...["--bind-fd", "3", WORKBENCH, "--bind-fd", "4", HOME, "--bind-fd", "5", `/screen-state/${SCREEN}`, "--bind-fd", "6", "/tmp/.X11-unix", "--bind-fd", "7", "/run/qorpera", "--ro-bind-fd", "8", "/etc/machine-id"],
			...["--size", "33554432", "--tmpfs", "/var/tmp", ...network],
			...[["/etc/passwd", false], ["/etc/group", false], ["/etc/nsswitch.conf", false], ["/etc/fonts", true], ["/etc/xdg", true], ["/etc/X11", true], ["/etc/dbus-1", true], ["/etc/ssl/certs", true]].map(([path, directory]) => ({ requiredRoBind: path, directory })),
			{ optionalRoBind: "/etc/libreoffice", directory: true },
			...["--symlink", "../usr/lib/os-release", "/etc/os-release"],
			{ folder: true },
			...setenv({ HOME, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", QORPERA_WORKBENCH_ROOT: WORKBENCH, QORPERA_DESKTOP_HOME: HOME, QORPERA_SCREEN_STATE_ROOT: "/screen-state", QORPERA_SCREEN_RUNTIME_ROOT: "/run/qorpera", QORPERA_SCREEN_WALLPAPER: `/screen-state/${SCREEN}/wallpaper.png`, QORPERA_COMPANY_FOLDER: "/company" }),
			...start,
		],
	};
	// A shell command's form (no display): the proof's program is python, which the runtime would give the screen.
	const command = {
		files: [standin("workbench"), standin("home")],
		args: [...sandboxArgs(67108864), "--bind-fd", "3", WORKBENCH, "--bind-fd", "4", HOME, ...setenv({ HOME, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }), { folder: true }, ...start],
	};
	const shell = {
		files: [standin("workbench"), standin("home")],
		pipeCount: 2,
		args: [
			...sandboxArgs(512 * 1024 * 1024),
			...["--bind-fd", "5", WORKBENCH, "--bind-fd", "6", HOME, ...network],
			...["/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/etc/ssl/openssl.cnf"].map((path) => ({ optionalRoBind: path, directory: false })),
			...["/etc/ssl/certs", "/etc/alternatives", "/etc/fonts", "/etc/xdg", "/etc/libreoffice"].map((path) => ({ optionalRoBind: path, directory: true })),
			...setenv({ HOME, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", SHELL: "/usr/bin/bash", TERM: "dumb" }),
			{ folder: true },
			...start,
		],
	};
	return { root: "/run/qorpera-folder", shapes: { desktop, command, shell }, standins: STANDINS };
}

/** Guest file name → its source in this tree; the two generated ones are written beside the run. */
export const PUSHED = {
	"office.mjs": "scripts/fixtures/office-folder-remount-office.mjs",
	"office-folder-remount-client.py": "scripts/fixtures/office-folder-remount-client.py",
	"office-folder-substrate.py": "scripts/fixtures/office-folder-substrate.py",
	"office-folder-remount.py": "scripts/fixtures/office-folder-remount.py",
	"office.service": "deploy/lxd-company-computer-guest/qorpera-company-computer.service",
	"mount.service": "deploy/lxd-company-computer-guest/qorpera-office-folder-mount@.service.in",
};

/** The runtime's own process gate, run unchanged in the guest's node: its types stripped, nothing else. */
export function processModule() {
	return stripTypeScriptTypes(readFileSync(resolve(root, "packages/runtime/src/cloud-company-computer-linux-process.ts"), "utf8"), { mode: "strip" });
}

export function main(args) {
	const options = parseArgs(args);
	if (process.platform !== "linux" || !existsSync("/etc/qorpera-test-machine-versions")) throw new Error("Run the launcher through run-on-node on a configured test machine");
	checkPins();
	const command = (args, extra = {}) => execFileSync("lxc", ["--force-local", "--project", options.project, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...extra });
	const instance = JSON.parse(command(["list", options.vm, "--format", "json"])).find((entry) => entry.name === options.vm);
	assertTarget(instance ?? {}, options);
	if (sha256(readFileSync(realpathSync(options["folder-binary"]))) !== options["folder-sha256"]) throw new Error("Folder binary digest differs");
	const guest = JSON.parse(command(["exec", options.vm, "--", "python3", "-c", guestProbeSource]));
	assertGuest(guest, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
	const local = mkdtempSync(join(tmpdir(), "qorpera-remount-"));
	const dir = `/run/qorpera-remount-${options.uuid}`;
	try {
		writeFileSync(join(local, "company-computer-process.mjs"), processModule());
		writeFileSync(join(local, "shapes.json"), `${JSON.stringify(remountShapes(dir), null, 2)}\n`);
		const sources = { ...Object.fromEntries(Object.entries(PUSHED).map(([name, path]) => [name, resolve(root, path)])), "company-computer-process.mjs": join(local, "company-computer-process.mjs"), "shapes.json": join(local, "shapes.json"), "qorpera-folder": realpathSync(options["folder-binary"]) };
		const digests = Object.fromEntries(Object.entries(sources).map(([name, path]) => [name, sha256(readFileSync(path))]));
		const evidence = { schema: "qorpera.office-folder-remount/v1", scope: "the folder mount's restart under the office's namespaces; synthetic folder node; master's office mount unit, rendered; copied office confinement", project: options.project, vm: options.vm, uuid: options.uuid, image: options.image, fuse: options.fuse, folderSha256: options["folder-sha256"], digests, runtimePins: RUNTIME_PINS.map(({ file, from, sha256 }) => ({ file, from, sha256 })), guestBoot: guest.boot, guestOfficeUnitSha256: guest.unitSha256, executed: false };
		if (!options.execute) {
			writeFileSync(options.record, `${JSON.stringify({ ...evidence, result: "plan", guestCommand: ["python3", `${dir}/office-folder-remount.py`, "proof", dir, options.fuse] }, null, 2)}\n`);
			console.log("Preflight passed. No guest files or units created.");
			return;
		}
		const result = execute(command, options, dir, sources, digests);
		const output = `${JSON.stringify({ ...evidence, executed: true, ...result }, null, 2)}\n`;
		writeFileSync(options.record, output);
		console.log(output);
		if (result.result !== "passed") process.exitCode = 1;
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
		command(["file", "push", sources["office-folder-remount.py"], `${options.vm}${dir}/office-folder-remount.py`]);
		fixtureInstalled = true;
		for (const [name, path] of Object.entries(sources)) if (name !== "office-folder-remount.py") command(["file", "push", path, `${options.vm}${dir}/${name}`], { timeout: 120_000 });
		const names = Object.keys(sources);
		const hashes = JSON.parse(command(["exec", options.vm, "--", "python3", "-c", "import hashlib,json,pathlib,sys; p=pathlib.Path(sys.argv[1]); print(json.dumps({n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in sys.argv[2:]}))", dir, ...names]));
		const differs = names.filter((name) => hashes[name] !== digests[name]);
		if (differs.length) throw new Error(`Copied artifact digest differs: ${differs.join(", ")}`);
		command(["exec", options.vm, "--", "chmod", "0644", ...names.map((name) => `${dir}/${name}`)]);
		// A timed-out or disconnected lxc client must not leave a root process, a relay or a mount running in the guest.
		const output = command(["exec", options.vm, "--", "systemd-run", "--quiet", "--wait", "--pipe", "--collect", "--unit", `qorpera-remount-${options.uuid}-proof`, "--property", "RuntimeMaxSec=540", "--property", "KillMode=control-group", "--", "python3", `${dir}/office-folder-remount.py`, "proof", dir, options.fuse], { timeout: 600_000 });
		result = JSON.parse(output.trim().split("\n").at(-1));
	} catch (error) {
		result = { result: "harness-error", error: error.message, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
	} finally {
		// Never delete a VM or an arbitrary path. The fixture stops its own units and mounts before this directory goes.
		try {
			if (fixtureInstalled) result = { ...result, cleanup: JSON.parse(command(["exec", options.vm, "--", "python3", `${dir}/office-folder-remount.py`, "cleanup", dir], { timeout: 120_000 }).trim().split("\n").at(-1)) };
			else if (created) command(["exec", options.vm, "--", "rmdir", dir]);
		} catch (error) {
			result = { ...result, result: "harness-error", cleanupError: error.message, cleanupStdout: String(error.stdout ?? ""), cleanupStderr: String(error.stderr ?? "") };
		}
	}
	return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
