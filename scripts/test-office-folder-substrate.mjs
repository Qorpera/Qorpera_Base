import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This launcher NEVER creates an instance, installs packages, changes a host's kernel settings or accepts a
// remote LXD. Provisioning a disposable nested VM is a separate, reviewed operator step. See the companion doc.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = "office-folder-substrate";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Shared verbatim with the unprivileged test: inspect both the boot-bound authority and the legacy location.
export const credentialProbeSource = `def has_credentials(root):
 def occupied(path):
  return path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir())))
 return occupied(root/'credentials') or any(occupied(p) for p in (root/'boots').glob('*/credentials'))`;

export function parseArgs(args) {
	const out = { execute: false };
	const names = ["project", "vm", "uuid", "image", "image-kind", "folder-binary", "folder-sha256", "record"];
	for (let i = 0; i < args.length; i++) {
		const key = args[i].replace(/^--/, "");
		if (args[i] === "--execute" && !out.execute) out.execute = true;
		else if ([...names, "owner-mode"].includes(key) && args[i].startsWith("--") && !Object.hasOwn(out, key) && args[i + 1] && !args[i + 1].startsWith("--")) out[key] = args[++i];
		else throw new Error(`Unknown, duplicate or incomplete option: ${args[i]}`);
	}
	for (const key of names) if (!out[key]) throw new Error(`Required: --${key}`);
	out["owner-mode"] ??= "root-default";
	if (!["root-default", "office-account"].includes(out["owner-mode"])) throw new Error("Owner mode must be root-default or office-account");
	if (!["office-image", "prepared-substrate"].includes(out["image-kind"])) throw new Error("Explicit image kind required: office-image or prepared-substrate");
	if (!/^qorpera-substrate-[a-z0-9-]{1,40}$/.test(out.vm)) throw new Error("VM must have the disposable qorpera-substrate- prefix");
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

export function assertGuest(guest, outerBoot, unitDigest) {
	if (!/^[a-f0-9-]{36}$/.test(guest.boot ?? "") || guest.boot === outerBoot || guest.container !== false || guest.virtualization !== "kvm") throw new Error("A separate nested KVM kernel is required");
	if (guest.unitSha256 !== unitDigest) throw new Error("Installed office unit differs from this source; review the image before running");
	if (!["inactive", "failed"].includes(guest.officeState) || guest.hasCredentials !== false) throw new Error("Refusing an active, unknown or credential-bearing office");
}

export function main(args) {
	const options = parseArgs(args);
	if (process.platform !== "linux" || !existsSync("/etc/qorpera-test-machine-versions")) throw new Error("Run the launcher through run-on-node on a configured test machine");
	const command = (args, extra = {}) => execFileSync("lxc", ["--force-local", "--project", options.project, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...extra });
	const instance = JSON.parse(command(["list", options.vm, "--format", "json"])).find((entry) => entry.name === options.vm);
	assertTarget(instance ?? {}, options);
	const unit = readFileSync(resolve(root, "deploy/lxd-company-computer-guest/qorpera-company-computer.service"));
	const binary = readFileSync(realpathSync(options["folder-binary"]));
	const fixturePath = resolve(root, "scripts/fixtures/office-folder-substrate.py");
	const fixtureDigest = sha256(readFileSync(fixturePath));
	if (sha256(binary) !== options["folder-sha256"]) throw new Error("Folder binary digest differs");
	const guest = JSON.parse(command(["exec", options.vm, "--", "python3", "-c", `import hashlib,json,pathlib,subprocess
${credentialProbeSource}
p=pathlib.Path('/etc/systemd/system/qorpera-company-computer.service')
def cmd(a):
 r=subprocess.run(a,capture_output=True,text=True); return r.stdout.strip()
print(json.dumps({'boot':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'container':cmd(['systemd-detect-virt','--container']) not in ('','none'), 'virtualization':cmd(['systemd-detect-virt','--vm']), 'unitSha256':hashlib.sha256(p.read_bytes()).hexdigest(), 'officeState':cmd(['systemctl','is-active','qorpera-company-computer.service']), 'hasCredentials':has_credentials(pathlib.Path('/etc/qorpera-office'))}))` ]));
	assertGuest(guest, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), sha256(unit));
	const dir = `/run/qorpera-substrate-${options.uuid}`;
	const evidence = { schema: "qorpera.office-folder-substrate/v1", scope: "candidate propagation and helper primitives; synthetic folder service; copied office confinement", imageKind: options["image-kind"], ownerMode: options["owner-mode"], officeIntegrationAccepted: false, project: options.project, vm: options.vm, uuid: options.uuid, image: options.image, folderSha256: options["folder-sha256"], fixtureSha256: fixtureDigest, officeUnitSha256: sha256(unit), guestBoot: guest.boot, executed: false };
	if (!options.execute) {
		writeFileSync(options.record, `${JSON.stringify({ ...evidence, result: "plan", guestCommand: ["python3", `${dir}/probe.py`, "probe", dir, options["owner-mode"]] }, null, 2)}\n`);
		console.log("Preflight passed. No guest files or units created. --execute requires the operator's reviewed provisioning path.");
		return;
	}
	let created = false;
	let fixtureInstalled = false;
	let result;
	try {
		command(["exec", options.vm, "--", "mkdir", "-m", "0755", dir]);
		created = true;
		command(["file", "push", fixturePath, `${options.vm}${dir}/probe.py`]);
		fixtureInstalled = true;
		for (const [source, name] of [[options["folder-binary"], "qorpera-folder"], [resolve(root, "deploy/lxd-company-computer-guest/qorpera-company-computer.service"), "office.service"]]) command(["file", "push", realpathSync(source), `${options.vm}${dir}/${name}`]);
		const hashes = JSON.parse(command(["exec", options.vm, "--", "python3", "-c", "import hashlib,json,pathlib,sys; p=pathlib.Path(sys.argv[1]); print(json.dumps({n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in ['probe.py','qorpera-folder','office.service']}))", dir]));
		if (hashes["probe.py"] !== fixtureDigest || hashes["qorpera-folder"] !== options["folder-sha256"] || hashes["office.service"] !== sha256(unit)) throw new Error("Copied artifact digest differs");
		command(["exec", options.vm, "--", "chmod", "0555", `${dir}/qorpera-folder`]);
		// A timed-out/disconnected lxc client must not leave a root daemon or helper running in the guest.
		const output = command(["exec", options.vm, "--", "systemd-run", "--quiet", "--wait", "--pipe", "--collect", "--unit", `qorpera-substrate-${options.uuid}-probe`, "--property", "RuntimeMaxSec=150", "--property", "KillMode=control-group", "--", "python3", `${dir}/probe.py`, "probe", dir, options["owner-mode"]], { timeout: 180_000 });
		result = JSON.parse(output);
	} catch (error) {
		result = { result: "harness-error", error: error.message, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
	} finally {
		// Never delete a VM or an arbitrary path. The fixture stops its own units and mounts before this directory goes.
		try {
			if (fixtureInstalled) command(["exec", options.vm, "--", "python3", `${dir}/probe.py`, "cleanup", dir], { timeout: 90_000 });
			else if (created) command(["exec", options.vm, "--", "rmdir", dir]);
		} catch (error) {
			result = { ...result, result: "harness-error", cleanupError: error.message };
		}
	}
	const output = `${JSON.stringify({ ...evidence, executed: true, ...result }, null, 2)}\n`;
	writeFileSync(options.record, output);
	console.log(output);
	if (result.result !== "passed") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
