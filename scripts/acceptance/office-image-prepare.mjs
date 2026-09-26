import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert([4, 5].includes(process.argv.length) && process.argv[2] === "--out" && (process.argv.length === 4 || process.argv[4] === "--retain"), "Usage: node scripts/acceptance/office-image-prepare.mjs --out <evidence-directory> [--retain]");
const retained = process.argv[4] === "--retain";
assert(process.platform === "linux" && process.getuid() === 0 && process.arch === "x64");
assert(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted", "Disposable GitHub-hosted runner required");
assert((await stat("/run/systemd/system")).isDirectory());
const out = resolve(process.argv[3]);
await mkdir(out, { recursive: true, mode: 0o755 });
const work = "/opt/qorpera-office-image-acceptance";
const vm = "qorpera-office-image-acceptance";
const clone = "qorpera-office-image-final-proof";
let guestName = vm;
const alias = "qorpera-office-acceptance";
const evidence = { schema: "qorpera.office-image-physical-acceptance/v1", commit: process.env.GITHUB_SHA ?? null, passed: false, scope: "Real KVM VM, production office package/installer/dependency measurements, actual systemd/tmpfs/preparation inspection, and cold-boot credential selection using synthetic probe credentials. No SQL office admission, real company state, NFS durability, model work or production deployment." };
let created = false, cloneCreated = false;
let trustServer;
let context;
const forwardingRules = [];
function run(file, args, timeout = 60000) {
	const result = spawnSync(file, args, { cwd: repository, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`${file}: ${String(result.stderr || result.error || result.stdout).slice(-5000)}`);
	return result.stdout.trim();
}
function guest(args, timeout = 120000) { return run("lxc", ["exec", guestName, "--", ...args], timeout); }
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
	// Match the production office infrastructure policy before any guest exists.
	// LXD's auto initialization enables IPv6 by default on some releases.
	run("lxc", ["network", "set", "lxdbr0", "ipv6.address", "none"]);
	run("lxc", ["network", "set", "lxdbr0", "ipv4.nat", "true"]);
	const initializedNetwork = JSON.parse(run("lxc", ["query", "/1.0/networks/lxdbr0"]));
	evidence.initializedInfrastructure = {
		network: { name: initializedNetwork.name, type: initializedNetwork.type, managed: initializedNetwork.managed,
			status: initializedNetwork.status, ipv4Address: initializedNetwork.config["ipv4.address"],
			ipv4Nat: initializedNetwork.config["ipv4.nat"], ipv6Address: initializedNetwork.config["ipv6.address"] },
		storage: JSON.parse(run("lxc", ["storage", "list", "--format=json"])).map(({ name, driver, status }) => ({ name, driver, status })),
	};
	assert(initializedNetwork.managed && initializedNetwork.type === "bridge" && initializedNetwork.status === "Created");
	assert.equal(initializedNetwork.config["ipv6.address"], "none");
	assert.equal(initializedNetwork.config["ipv4.nat"], "true");
	await mkdir(work, { mode: 0o755 });
	assert.equal(run("git", ["status", "--porcelain", "--untracked-files=no"]), "", "Image provenance requires an unchanged checkout");
	assert.equal(run("git", ["rev-parse", "HEAD"]), process.env.GITHUB_SHA);
	run(process.execPath, ["scripts/package-company-computer.mjs", "--out", `${work}/package`], 180000);
	// Root owns this fresh staging tree; source-copy metadata can retain the
	// runner UID (observed on LICENSE). Establish host custody as well as guest custody.
	run("chown", ["-R", "0:0", `${work}/package`]);
	run("chmod", ["-R", "go-w", `${work}/package`]);
	await chmod(`${work}/package`, 0o755);
	const manifest = await readFile(`${work}/package/manifest.json`);
	for (const artifact of JSON.parse(manifest).artifacts) {
		const path = `${work}/package/${artifact.file}`, info = await lstat(path);
		assert(info.isFile() && info.uid === 0 && info.gid === 0 && info.nlink === 1 && (info.mode & 0o6022) === 0 && await realpath(path) === path);
		assert.equal(info.size, artifact.bytes);
		assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), artifact.sha256);
	}
	evidence.hostPackageRootCustody = true;
	const browsers = JSON.parse(await readFile("node_modules/playwright-core/browsers.json", "utf8"));
	const browser = browsers.browsers.find((value) => value.name === "chromium");
	assert.match(browser.browserVersion, /^\d+\.\d+\.\d+\.\d+$/);
	evidence.browserVersion = browser.browserVersion;
	evidence.nodeVersion = "22.19.0";
	await build({ absWorkingDir: repository, entryPoints: ["packages/runner-orchestrator/test/fixtures/office-image-systemd-consumer.ts"], outfile: `${work}/consumer.mjs`, bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" });
	await build({ absWorkingDir: repository, entryPoints: ["scripts/acceptance/office-image-inputs.ts"], outfile: `${work}/inputs.mjs`, bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" });
	await build({ absWorkingDir: repository, entryPoints: ["scripts/acceptance/office-image-provenance.ts"], outfile: `${work}/provenance.mjs`, bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" });
	run("lxc", ["init", "ubuntu:26.04", vm, "--vm", "--storage", "default", "-c", "boot.mode=uefi-secureboot", "-c", "limits.cpu=2", "-c", "limits.memory=4GiB", "-d", "root,size=30GiB"], 300000);
	created = true;
	const initial = JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}`]));
	assert.equal(initial.type, "virtual-machine");
	assert.equal(initial.expanded_config["boot.mode"], "uefi-secureboot");
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
	const trustRoot = `${work}/trust`;
	await mkdir(trustRoot, { mode: 0o700 });
	run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Qorpera disposable acceptance CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", `${trustRoot}/ca.key`, "-out", `${trustRoot}/ca.pem`]);
	run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Qorpera disposable acceptance endpoint", "-keyout", `${trustRoot}/server.key`, "-out", `${trustRoot}/server.csr`]);
	await writeFile(`${trustRoot}/server.ext`, `subjectAltName=IP:${bridgeIp}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
	run("openssl", ["x509", "-req", "-in", `${trustRoot}/server.csr`, "-CA", `${trustRoot}/ca.pem`, "-CAkey", `${trustRoot}/ca.key`, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", `${trustRoot}/server.ext`, "-out", `${trustRoot}/server.pem`]);
	trustServer = spawn(process.execPath, [join(repository, "scripts/acceptance/office-image-trust-server.mjs"), trustRoot, bridgeIp], { stdio: "ignore" });
	let trustServerFailed = false;
	trustServer.once("error", () => { trustServerFailed = true; });
	trustServer.unref();
	let listener;
	for (let i = 0; i < 100; i++) {
		assert(!trustServerFailed && trustServer.exitCode === null, "Fixture trust listener failed to start");
		try { listener = JSON.parse(await readFile(`${trustRoot}/listener.json`, "utf8")); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
		await delay(50);
	}
	assert(listener && listener.host === bridgeIp && Number.isInteger(listener.port));
	const endpoint = `https://${bridgeIp}:${listener.port}/trust-proof`;
	const caBytes = await readFile(`${trustRoot}/ca.pem`);
	const managerBytes = Buffer.from("[Manager]\nDefaultEnvironment=NODE_EXTRA_CA_CERTS=/usr/local/share/qorpera-acceptance/ca.pem\n");
	const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
	const caSha256 = hash(caBytes), managerSha256 = hash(managerBytes);
	await writeFile(`${trustRoot}/manager.conf`, managerBytes, { mode: 0o644 });
	const trustContext = { schema: "qorpera.office-image-trust-context/v1", root: trustRoot, caCertificatePath: `${trustRoot}/ca.pem`, caPrivateKeyPath: `${trustRoot}/ca.key`, serverCertificatePath: `${trustRoot}/server.pem`, serverPrivateKeyPath: `${trustRoot}/server.key`, host: bridgeIp, port: listener.port, listenerPid: trustServer.pid, caSha256, managerSha256, retained };
	await writeFile(`${trustRoot}/context.json`, `${JSON.stringify(trustContext)}\n`, { mode: 0o600, flag: "wx" });
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
	guest(["mkdir", "-p", "/usr/local/share/qorpera-acceptance", "/etc/systemd/system.conf.d"]);
	run("lxc", ["file", "push", "--uid=0", "--gid=0", "--mode=0444", `${trustRoot}/ca.pem`, `${vm}/usr/local/share/qorpera-acceptance/ca.pem`]);
	run("lxc", ["file", "push", "--uid=0", "--gid=0", "--mode=0444", `${trustRoot}/manager.conf`, `${vm}/etc/systemd/system.conf.d/90-qorpera-acceptance-ca.conf`]);
	run("tar", ["-C", work, "-cf", `${work}/package.tar`, "package"]);
	run("lxc", ["file", "push", `${work}/package.tar`, `${vm}${work}/package.tar`], 120000);
	// The reviewed package may carry the build runner's UID in its archive.
	// Root stages new local inputs; no source UID becomes guest authority.
	guest(["tar", "--no-same-owner", "-C", work, "-xf", `${work}/package.tar`]);
	for (const [source, target] of [["scripts/acceptance/office-image-guest.mjs", "guest.mjs"], ["scripts/acceptance/office-image-credential-child.mjs", "credential-child.mjs"], [`${work}/consumer.mjs`, "consumer.mjs"], [`${work}/inputs.mjs`, "inputs.mjs"]]) run("lxc", ["file", "push", "--uid=0", "--gid=0", "--mode=0644", source, `${vm}${work}/${target}`]);
	guest(["chmod", "-R", "go-w", work]);
	console.log(guest(["/usr/bin/node", `${work}/guest.mjs`, "install"], 180000));
	evidence.installation = JSON.parse(guest(["cat", `${work}/install-proof.json`]));
	// Retain exact measured installation bytes for the later signed reset lane.
	run("lxc", ["file", "pull", `${vm}/opt/qorpera-office/installation.json`, `${work}/base-installation-receipt.json`]);
	await chmod(`${work}/base-installation-receipt.json`, 0o444);
	assert.equal(hash(await readFile(`${work}/base-installation-receipt.json`)), evidence.installation.installationReceiptSha256);
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
	for (const [source, name] of [["office-image-trust-guest.mjs", "trust-guest.mjs"], ["office-image-trust-probe.mjs", "trust-probe.mjs"]]) run("lxc", ["file", "push", "--uid=0", "--gid=0", "--mode=0644", `scripts/acceptance/${source}`, `${vm}${work}/${name}`]);
	console.log(guest(["/usr/bin/node", `${work}/trust-guest.mjs`, endpoint, caSha256, managerSha256, evidence.installation.installationReceiptSha256]));
	evidence.builderTrust = JSON.parse(guest(["cat", `${work}/trust-proof.json`]));
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
	const published = JSON.parse(run("lxc", ["query", `/1.0/images/${image.target}`]));
	assert(published.type === "virtual-machine" && published.architecture === "x86_64" && Number.isSafeInteger(published.size) && published.size > 0);
	run("lxc", ["init", image.target, clone, "--vm", "--storage", "default", "-c", "boot.mode=uefi-secureboot", "-c", "limits.cpu=2", "-c", "limits.memory=4GiB", "-d", "root,size=30GiB"], 120000);
	cloneCreated = true;
	const cloneDefinition = JSON.parse(run("lxc", ["query", `/1.0/instances/${clone}`]));
	assert.equal(cloneDefinition.config["volatile.base_image"], image.target);
	assert.equal(cloneDefinition.expanded_config["boot.mode"], "uefi-secureboot");
	guestName = clone;
	run("lxc", ["start", clone], 60000); await ready();
	const cloneCloudInit = spawnSync("lxc", ["exec", clone, "--", "cloud-init", "status", "--wait"], { encoding: "utf8", timeout: 120000, maxBuffer: 65536 });
	assert(cloneCloudInit.status === 0 || cloneCloudInit.status === 2, "Published clone cloud-init must finish before trust verification");
	guest(["mkdir", "-p", work]); guest(["chmod", "0755", work]);
	for (const [source, name] of [["scripts/acceptance/office-image-trust-guest.mjs", "trust-guest.mjs"], ["scripts/acceptance/office-image-trust-probe.mjs", "trust-probe.mjs"], [`${work}/consumer.mjs`, "consumer.mjs"]]) run("lxc", ["file", "push", "--uid=0", "--gid=0", "--mode=0644", source, `${clone}${work}/${name}`]);
	console.log(guest(["/usr/bin/node", `${work}/trust-guest.mjs`, endpoint, caSha256, managerSha256, evidence.installation.installationReceiptSha256]));
	evidence.finalImageBoot = JSON.parse(guest(["cat", `${work}/trust-proof.json`]));
	assert.notEqual(evidence.finalImageBoot.bootId, evidence.builderTrust.bootId);
	assert.equal(run("git", ["status", "--porcelain", "--untracked-files=no"]), "");
	const recipe = {};
	for (const file of ["scripts/acceptance/office-image-prepare.mjs", "scripts/acceptance/office-image-dependencies.sh", "scripts/package-company-computer.mjs"]) recipe[file] = hash(await readFile(join(repository, file)));
	const bootstrapBytes = Buffer.from(`${JSON.stringify({ schema: "qorpera.office-image-acceptance-bootstrap/v1", baseImageFingerprint: evidence.baseImageFingerprint, packageManifestSha256: evidence.packageManifestSha256, dependencies: evidence.installation.dependencies, caSha256, managerSha256, bootMode: "uefi-secureboot", recipe }, null, 2)}\n`);
	await writeFile(join(out, "office-image-bootstrap.json"), bootstrapBytes, { mode: 0o644, flag: "wx" });
	// Reset provisioning pins the actual installed base receipt as bootstrap
	// identity. The build recipe remains separate provenance, not a substitute.
	const bootstrapSha256 = evidence.installation.installationReceiptSha256;
	const acceptanceBytes = Buffer.from(`${JSON.stringify({ schema: "qorpera.office-image-trust-acceptance/v1", imageFingerprint: image.target, baseImageFingerprint: evidence.baseImageFingerprint, imageBytes: published.size, bootstrapSha256, packageManifestSha256: evidence.packageManifestSha256, builder: evidence.builderTrust, finalImageBoot: evidence.finalImageBoot }, null, 2)}\n`);
	await writeFile(join(out, "image-trust-evidence.json"), acceptanceBytes, { mode: 0o644, flag: "wx" });
	const statement = { schema: "qorpera.lxd-office-image-provenance/v1", image: { fingerprint: image.target, baseFingerprint: evidence.baseImageFingerprint, architecture: "x86_64", bytes: published.size, guestPackageManifestSha256: evidence.packageManifestSha256, bootstrapSha256 }, source: { repository: "https://github.com/Qorpera/Qorpera_Base", commit: process.env.GITHUB_SHA, tree: "clean" }, acceptance: { testedAt: new Date().toISOString(), evidenceSha256: hash(acceptanceBytes), virtualization: "kvm", bootMode: "uefi-secureboot", secureBoot: true, credentials: "absent", computeIdentity: "absent", companyState: "absent", services: "fail-closed" } };
	await writeFile(`${work}/statement.json`, JSON.stringify(statement), { mode: 0o600, flag: "wx" });
	run(process.execPath, [`${work}/provenance.mjs`, `${work}/statement.json`, out, `${work}/reset-signing.key`]);
	const verification = JSON.parse(await readFile(join(out, "image-verification.json"), "utf8"));
	evidence.provenance = { statementSha256: verification.statementSha256, productionVerifierAccepted: verification.productionVerifierAccepted, alteredImageRejected: verification.alteredImageRejected };
	context = { schema: "qorpera.office-image-acceptance-context/v1", project: "default", alias, imageFingerprint: image.target, imageBytes: published.size, bootstrapSha256, packageRoot: `${work}/package`, packageManifestSha256: evidence.packageManifestSha256, uid: 1100, gid: 1100, builderVmDeleted: true, finalCloneDeleted: true, imageRetainedForSameDisposableJob: true, provenanceSigned: true, provenancePath: join(out, "image-provenance.json"), statementSha256: verification.statementSha256, verificationKeySpki: verification.verificationKeySpki, trustContextPath: `${trustRoot}/context.json`, trustListenerRetained: retained };
	evidence.passed = true;
} catch (error) { evidence.error = String(error); process.exitCode = 1; }
finally {
	for (const rule of forwardingRules.reverse()) { try { run("iptables", ["-D", ...rule]); } catch { evidence.firewallCleanupFailed = true; evidence.passed = false; process.exitCode = 1; } }
	if (cloneCreated) { try { run("lxc", ["delete", clone, "--force"], 90000); } catch { evidence.cloneCleanupFailed = true; evidence.passed = false; process.exitCode = 1; } }
	if (created) {
		try { run("lxc", ["delete", vm, "--force"], 90000); } catch { evidence.cleanupFailed = true; evidence.passed = false; process.exitCode = 1; }
	}
	if (trustServer && (!retained || !evidence.passed)) {
		trustServer.kill("SIGTERM");
		for (let i = 0; i < 100 && trustServer.exitCode === null && trustServer.signalCode === null; i++) await delay(50);
		if (trustServer.exitCode === null && trustServer.signalCode === null) { evidence.trustListenerCleanupFailed = true; evidence.passed = false; process.exitCode = 1; }
	}
	if (evidence.passed && context) await writeFile(join(out, "image-context.json"), `${JSON.stringify(context, null, 2)}\n`, { mode: 0o644 });
	await writeFile(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
	console.log(JSON.stringify(evidence));
}
