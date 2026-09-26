import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert(process.argv.length === 4 && process.argv[2] === "--out", "Usage: node scripts/acceptance/office-image-prepare.mjs --out <evidence-directory>");
assert(process.platform === "linux" && process.getuid() === 0 && process.arch === "x64");
assert(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted", "Disposable GitHub-hosted runner required");
assert((await stat("/run/systemd/system")).isDirectory());
const out = resolve(process.argv[3]);
await mkdir(out, { recursive: true, mode: 0o755 });
const work = "/opt/qorpera-office-image-acceptance";
const vm = "qorpera-office-image-acceptance";
const alias = "qorpera-office-acceptance";
const evidence = { schema: "qorpera.office-image-physical-acceptance/v1", commit: process.env.GITHUB_SHA ?? null, passed: false, scope: "Real KVM VM, production office package/installer/dependency measurements, actual systemd/tmpfs/preparation inspection, and cold-boot credential selection using synthetic probe credentials. No SQL office admission, real company state, NFS durability, model work or production deployment." };
let created = false;
let context;
const forwardingRules = [];
function run(file, args, timeout = 60000) {
	const result = spawnSync(file, args, { cwd: repository, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`${file}: ${String(result.stderr || result.error || result.stdout).slice(-5000)}`);
	return result.stdout.trim();
}
function guest(args, timeout = 120000) { return run("lxc", ["exec", vm, "--", ...args], timeout); }
async function ready() {
	for (let i = 0; i < 90; i++) {
		try { if (guest(["cat", "/proc/1/comm"], 5000) === "systemd") return; } catch { /* The actual LXD agent comes up after cold boot. */ }
		await delay(1000);
	}
	throw new Error("OFFICE_IMAGE_GUEST_SYSTEMD_UNAVAILABLE");
}
try {
	evidence.kvm = JSON.parse(run("python3", ["scripts/acceptance/paid-lxd-kvm.py"]));
	assert.deepEqual(JSON.parse(run("lxc", ["list", "--all-projects", "--format=json"])), [], "Refuse host with existing VMs");
	assert.deepEqual(JSON.parse(run("lxc", ["storage", "list", "--format=json"])), [], "Fresh uninitialized LXD required");
	run("lxd", ["init", "--auto", "--storage-backend", "dir"], 120000);
	await mkdir(work, { mode: 0o755 });
	run(process.execPath, ["scripts/package-company-computer.mjs", "--out", `${work}/package`], 180000);
	await chmod(`${work}/package`, 0o755);
	const manifest = await readFile(`${work}/package/manifest.json`);
	const browsers = JSON.parse(await readFile("node_modules/playwright-core/browsers.json", "utf8"));
	const browser = browsers.browsers.find((value) => value.name === "chromium");
	assert.match(browser.browserVersion, /^\d+\.\d+\.\d+\.\d+$/);
	evidence.browserVersion = browser.browserVersion;
	evidence.nodeVersion = "22.19.0";
	await build({ absWorkingDir: repository, entryPoints: ["packages/runner-orchestrator/test/fixtures/office-image-systemd-consumer.ts"], outfile: `${work}/consumer.mjs`, bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" });
	run("lxc", ["init", "ubuntu:26.04", vm, "--vm", "--storage", "default", "-c", "limits.cpu=2", "-c", "limits.memory=4GiB", "-d", "root,size=30GiB"], 300000);
	created = true;
	const initial = JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}`]));
	assert.equal(initial.type, "virtual-machine");
	evidence.baseImageFingerprint = initial.config["volatile.base_image"];
	evidence.physicalInstanceId = initial.config["volatile.uuid"];
	run("lxc", ["start", vm], 60000); await ready();
	// LXD agent/PID1 readiness precedes cloud-init's network and resolver setup.
	// Do not classify an early boot DNS failure as a firewall failure.
	const cloudInit = spawnSync("lxc", ["exec", vm, "--", "cloud-init", "status", "--wait"], { encoding: "utf8", timeout: 120000, maxBuffer: 65536 });
	evidence.cloudInit = { status: cloudInit.status, stdout: (cloudInit.stdout ?? "").trim().slice(-2000), stderr: (cloudInit.stderr ?? "").trim().slice(-2000) };
	assert(cloudInit.status === 0 || cloudInit.status === 2, "Guest cloud-init did not finish within120 seconds");
	assert.equal(guest(["systemctl", "is-active", "systemd-resolved"]), "active");
	guest(["mkdir", "-p", work]);
	guest(["chmod", "0755", work]);
	run("lxc", ["file", "push", "scripts/acceptance/office-image-network-probe.py", `${vm}${work}/network-probe.py`]);
	const bridge = JSON.parse(run("lxc", ["query", "/1.0/networks/lxdbr0"]));
	assert(bridge.managed && bridge.type === "bridge" && bridge.config["ipv4.nat"] === "true");
	const guestAddresses = JSON.parse(guest(["ip", "-j", "-4", "address"]));
	const guestRoutes = JSON.parse(guest(["ip", "-j", "-4", "route"]));
	const guestDevice = guestRoutes.find((route) => route.dst === "default")?.dev;
	const address = guestAddresses.find((link) => link.ifname === guestDevice)?.addr_info.find((entry) => entry.family === "inet" && entry.scope === "global")?.local;
	const hostRoutes = JSON.parse(run("ip", ["-j", "-4", "route", "show", "default"]));
	const outward = hostRoutes[0]?.dev;
	assert.match(address ?? "", /^(?:\d{1,3}\.){3}\d{1,3}$/);
	assert.match(outward ?? "", /^[a-zA-Z0-9_.:-]{1,32}$/);
	const [bridgeIp, prefix] = bridge.config["ipv4.address"].split("/");
	const numeric = (ip) => ip.split(".").reduce((sum, byte) => sum * 256 + Number(byte), 0);
	assert(Number(prefix) >= 8 && Number(prefix) <= 30);
	assert.equal(Math.floor(numeric(address) / 2 ** (32 - Number(prefix))), Math.floor(numeric(bridgeIp) / 2 ** (32 - Number(prefix))), "Only the actual managed LXD subnet may receive a fixture exception");
	evidence.network = { bridge: { name: bridge.name, ipv4Address: bridge.config["ipv4.address"], nat: true }, guestAddresses, guestRoutes, hostRoutes, guestResolver: guest(["resolvectl", "status"]), guestResolvConf: guest(["cat", "/etc/resolv.conf"]), hostResolver: run("resolvectl", ["status"]), ipForward: run("sysctl", ["-n", "net.ipv4.ip_forward"]), beforeForwardRules: run("iptables", ["-S", "FORWARD"]), beforeInputRules: run("iptables", ["-S", "INPUT"]), beforeOutputRules: run("iptables", ["-S", "OUTPUT"]) };
	assert.equal(evidence.network.ipForward, "1");
	try { evidence.network.initialHttps = JSON.parse(guest(["python3", `${work}/network-probe.py`], 20000)); }
	catch (error) {
		evidence.network.initialHttpsError = String(error);
		// GitHub's preinstalled container firewall can leave FORWARD DROP even
		// without invoking Docker. Permit only this VM's web egress and replies;
		// retain all global policies, other guests and all unrelated traffic.
		for (const rule of [
			["FORWARD", "-i", "lxdbr0", "-s", `${address}/32`, "-o", outward, "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED", "-m", "comment", "--comment", "qorpera-office-image-acceptance", "-j", "ACCEPT"],
			["FORWARD", "-i", outward, "-o", "lxdbr0", "-d", `${address}/32`, "-p", "tcp", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-m", "comment", "--comment", "qorpera-office-image-acceptance", "-j", "ACCEPT"],
		]) { run("iptables", ["-I", rule[0], "1", ...rule.slice(1)]); forwardingRules.push(rule); }
		evidence.network.afterForwardRules = run("iptables", ["-S", "FORWARD"]);
		evidence.network.restoredHttps = JSON.parse(guest(["python3", `${work}/network-probe.py`], 20000));
		evidence.network.afterProbeCounters = run("iptables", ["-L", "FORWARD", "-n", "-v", "-x"]);
	}
	console.log("Actual guest IPv4/TLS archive reachability verified; scoped forwarding evidence retained.");
	run("lxc", ["file", "push", "scripts/acceptance/office-image-dependencies.sh", `${vm}${work}/dependencies.sh`]);
	console.log("Installing real office image dependencies through Ubuntu apt and version-pinned official archives.");
	guest(["bash", `${work}/dependencies.sh`, browser.browserVersion], 1200000);
	evidence.dependencyArchives = guest(["cat", "/root/office-dependency-downloads/archives.sha256"]);
	await writeFile(join(out, "dependency-versions.json"), `${JSON.stringify({ osRelease: guest(["cat", "/usr/lib/os-release"]), dpkgManifest: guest(["cat", "/root/office-dependency-downloads/dpkg-manifest.txt"]), node: guest(["/usr/bin/node", "--version"]), browser: guest(["/usr/lib/qorpera-chromium/chrome", "--version"]) }, null, 2)}\n`, { mode: 0o644 });
	evidence.guestKernel = guest(["uname", "-srmo"]);
	evidence.guestSystemd = guest(["systemctl", "--version"]);
	assert(Number(/^systemd (\d+)/.exec(evidence.guestSystemd)?.[1]) >= 258, "ProtectHostname=private requires systemd258 or newer");
	evidence.guestVirtualization = guest(["systemd-detect-virt"]);
	assert.equal(evidence.guestVirtualization, "kvm");
	run("tar", ["-C", work, "-cf", `${work}/package.tar`, "package"]);
	run("lxc", ["file", "push", `${work}/package.tar`, `${vm}${work}/package.tar`], 120000);
	guest(["tar", "-C", work, "-xf", `${work}/package.tar`]);
	for (const [source, target] of [["scripts/acceptance/office-image-guest.mjs", "guest.mjs"], ["scripts/acceptance/office-image-credential-child.mjs", "credential-child.mjs"], [`${work}/consumer.mjs`, "consumer.mjs"]]) run("lxc", ["file", "push", "--uid=0", "--gid=0", "--mode=0644", source, `${vm}${work}/${target}`]);
	guest(["chmod", "-R", "go-w", work]);
	console.log(guest(["/usr/bin/node", `${work}/guest.mjs`, "install"], 180000));
	evidence.installation = JSON.parse(guest(["cat", `${work}/install-proof.json`]));
	console.log(guest(["/usr/bin/node", `${work}/guest.mjs`, "credentials-before"]));
	evidence.credentialsBefore = JSON.parse(guest(["cat", `${work}/credentials-before.json`]));
	// Persist fixture setup before injecting abrupt power loss; the assertion
	// concerns new-boot credential selection, not unflushed fixture writes.
	guest(["sync"]);
	run("lxc", ["stop", vm, "--force"], 60000);
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}/state`])).status, "Stopped");
	run("lxc", ["start", vm], 60000); await ready();
	console.log(guest(["/usr/bin/node", `${work}/guest.mjs`, "credentials-after"]));
	evidence.credentialsAfter = JSON.parse(guest(["cat", `${work}/credentials-after.json`]));
	assert.notEqual(evidence.credentialsBefore.boot, evidence.credentialsAfter.boot);
	for (const name of Object.keys(evidence.credentialsBefore.hashes)) assert.notEqual(evidence.credentialsBefore.hashes[name], evidence.credentialsAfter.hashes[name]);
	console.log(guest(["/usr/bin/node", `${work}/guest.mjs`, "clean"]));
	assert.equal(guest(["find", "/etc/qorpera-office/boots", "/etc/qorpera-office/credentials", "-mindepth", "1", "-print"]), "");
	await writeFile(join(out, "dependency-pins.json"), `${JSON.stringify(evidence.installation.dependencies, null, 2)}\n`, { mode: 0o644 });
	await writeFile(join(out, "package-manifest.json"), manifest, { mode: 0o644 });
	guest(["rm", "-rf", work, "/root/office-dependency-downloads"]);
	guest(["cloud-init", "clean", "--logs", "--machine-id"]);
	run("lxc", ["stop", vm], 90000);
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}/state`])).status, "Stopped");
	run("lxc", ["publish", vm, "--alias", alias], 240000);
	const image = JSON.parse(run("lxc", ["query", `/1.0/images/aliases/${alias}`]));
	assert.match(image.target, /^[a-f0-9]{64}$/);
	evidence.publishedImageFingerprint = image.target;
	evidence.packageManifestSha256 = createHash("sha256").update(manifest).digest("hex");
	context = { schema: "qorpera.office-image-acceptance-context/v1", project: "default", alias, imageFingerprint: image.target, packageRoot: `${work}/package`, packageManifestSha256: evidence.packageManifestSha256, uid: 1100, gid: 1100, builderVmDeleted: true, imageRetainedForSameDisposableJob: true, provenanceSigned: false };
	evidence.passed = true;
} catch (error) { evidence.error = String(error); process.exitCode = 1; }
finally {
	for (const rule of forwardingRules.reverse()) { try { run("iptables", ["-D", ...rule]); } catch { evidence.firewallCleanupFailed = true; evidence.passed = false; process.exitCode = 1; } }
	if (created) {
		try { run("lxc", ["delete", vm, "--force"], 90000); } catch { evidence.cleanupFailed = true; evidence.passed = false; process.exitCode = 1; }
	}
	if (evidence.passed && context) await writeFile(join(out, "image-context.json"), `${JSON.stringify(context, null, 2)}\n`, { mode: 0o644 });
	await writeFile(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
	console.log(JSON.stringify(evidence));
}
