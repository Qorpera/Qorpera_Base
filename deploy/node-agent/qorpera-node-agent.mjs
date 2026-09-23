#!/usr/bin/env node
// Node agent (phase B of the node auto-update plan): installs a signed release in place of the running one and keeps
// exactly one earlier release to roll back to. Commands (root):
//   stage <folder>      verify release.json + release.sig and every file, then write /opt/qorpera-node/releases/<revision>
//   adopt <revision>    first release only (migration): point current at it without restarting anything
//   apply <revision>    quiet gate, swap current/previous, restart the roles whose program or values changed, verify
//                       each; a failed verify rolls back by itself only when the release keeps the runtime bundle
//                       [--defer <role>]... leaves a role on its old process (restart it later with `restart <role>`)
//                       [--wait <seconds>] waits for a quiet node instead of refusing at once
//   rollback            swap back to the previous release and restart what differs
//   restart <role>      restart one role on the current release and verify it
//   status              JSON: current, previous, staged, each role's unit, process and health
//   gc                  delete releases older than previous (staged newer ones stay)
// Mutating commands run under `flock --nonblock /run/lock/qorpera-node-update.lock`; a held lock refuses (exit 75).
// Every node interaction goes through `ports`, so the logic is tested without a node.

import { execFile, spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
	chmod,
	chown,
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const RELEASE_SCHEMA = "qorpera.node-release/v1";
const NODE_SCHEMA = "qorpera.node/v1";
const ORDERS = ["code-first", "schema-first", "either", "pause"];
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROLE = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const RUN_MACHINE = /^qorpera-(login-|refresh-)?[0-9a-f]{32}$/;
const REFUSAL = "QORPERA_NODE_ROLE_START_REFUSED";
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => {
	if (!ok) throw new Error(message);
};

/** Validates a release manifest's structure. */
export function parseRelease(bytes) {
	const value = JSON.parse(bytes.toString("utf8"));
	const keys = ["schema", "revision", "previousRevision", "sourceCommit", "runtimeBundleSha256", "order", "files", "roles"];
	need(value && typeof value === "object" && Object.keys(value).sort().join() === [...keys].sort().join(), "RELEASE_FIELDS");
	need(value.schema === RELEASE_SCHEMA, "RELEASE_SCHEMA");
	need(Number.isSafeInteger(value.revision) && value.revision >= 0, "RELEASE_REVISION");
	need(
		value.previousRevision === null ||
			(Number.isSafeInteger(value.previousRevision) && value.previousRevision < value.revision),
		"RELEASE_PREVIOUS",
	);
	need(/^[0-9a-f]{40}$/.test(value.sourceCommit) && /^[0-9a-f]{64}$/.test(value.runtimeBundleSha256), "RELEASE_SOURCE");
	need(ORDERS.includes(value.order), "RELEASE_ORDER");
	need(Array.isArray(value.files) && value.files.length > 0, "RELEASE_FILES");
	const names = new Set();
	for (const file of value.files) {
		need(Object.keys(file).sort().join() === "bytes,name,sha256", "RELEASE_FILE_FIELDS");
		need(FILE_NAME.test(file.name) && !["release.json", "release.sig"].includes(file.name), "RELEASE_FILE_NAME");
		need(/^[0-9a-f]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes > 0, "RELEASE_FILE_DIGEST");
		need(file.bytes <= MAX_FILE_BYTES && !names.has(file.name), "RELEASE_FILE_UNIQUE");
		names.add(file.name);
	}
	need(value.roles && typeof value.roles === "object" && Object.keys(value.roles).length > 0, "RELEASE_ROLES");
	for (const [role, entry] of Object.entries(value.roles)) {
		need(ROLE.test(role) && Object.keys(entry).sort().join() === "component,env", "RELEASE_ROLE");
		need(names.has(entry.component), "RELEASE_ROLE_COMPONENT");
		need(entry.env && typeof entry.env === "object", "RELEASE_ROLE_ENV");
		for (const [key, text] of Object.entries(entry.env))
			need(ENV_KEY.test(key) && typeof text === "string" && text && !/[\0\n]/.test(text), "RELEASE_ROLE_VALUE");
	}
	return value;
}

/** Reads and verifies a release folder: the signature over release.json and every listed file. */
export async function verifyReleaseFolder(folder, publicKeyPem) {
	const bytes = await readFile(join(folder, "release.json"));
	const signature = Buffer.from((await readFile(join(folder, "release.sig"), "utf8")).trim(), "base64");
	need(verify(null, bytes, createPublicKey(publicKeyPem), signature), "RELEASE_SIGNATURE");
	const release = parseRelease(bytes);
	for (const file of release.files) {
		const content = await readFile(join(folder, file.name));
		need(content.length === file.bytes && sha256(content) === file.sha256, `RELEASE_FILE_MISMATCH ${file.name}`);
	}
	return { release, bytes };
}

/** A role changes when its program or its release values change. */
export function changedRoles(before, after, roles) {
	const digest = (release, role) => release.files.find((file) => file.name === release.roles[role].component)?.sha256;
	return roles.filter(
		(role) =>
			!before?.roles[role] ||
			digest(before, role) !== digest(after, role) ||
			JSON.stringify(before.roles[role].env) !== JSON.stringify(after.roles[role].env),
	);
}

export function parseNodeConfig(bytes) {
	const value = JSON.parse(bytes.toString("utf8"));
	need(value.schema === NODE_SCHEMA && value.roles && typeof value.roles === "object", "NODE_CONFIG");
	for (const [role, settings] of Object.entries(value.roles)) {
		need(ROLE.test(role) && /^qorpera-[a-z0-9-]+\.service$/.test(settings.unit), `NODE_ROLE ${role}`);
		need(Array.isArray(settings.exec) && settings.exec[0]?.startsWith("/"), `NODE_ROLE_EXEC ${role}`);
		need(Array.isArray(settings.health ?? []), `NODE_ROLE_HEALTH ${role}`);
	}
	need(Array.isArray(value.restartOrder) && value.restartOrder.every((role) => value.roles[role]), "NODE_RESTART_ORDER");
	return value;
}

export class NodeAgent {
	constructor({ root = "/", ports, owner = 0, now = () => new Date() }) {
		this.nodeRoot = join(root, "opt/qorpera-node");
		this.releases = join(this.nodeRoot, "releases");
		this.nodeConfig = join(root, "etc/qorpera-node/node.json");
		this.releaseKey = join(root, "etc/qorpera-node/keys/release.pem");
		this.journal = join(root, "var/lib/qorpera-node-agent/journal");
		this.ports = ports;
		this.owner = owner;
		this.now = now;
	}

	async config() {
		return parseNodeConfig(await readFile(this.nodeConfig));
	}

	async revisionOf(link) {
		try {
			const target = await readlink(join(this.nodeRoot, link));
			need(/^releases\/(0|[1-9][0-9]{0,8})$/.test(target), `NODE_LINK ${link}`);
			return Number(target.slice("releases/".length));
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
	}

	async release(revision) {
		return revision === null
			? null
			: parseRelease(await readFile(join(this.releases, String(revision), "release.json")));
	}

	async record(kind, value) {
		await mkdir(this.journal, { recursive: true, mode: 0o700 });
		const path = join(this.journal, `${this.now().toISOString().replaceAll(":", "")}-${kind}-${randomUUID()}.json`);
		await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
		return path;
	}

	async stage(source) {
		const { release } = await verifyReleaseFolder(source, await readFile(this.releaseKey, "utf8"));
		const current = await this.revisionOf("current");
		need(release.previousRevision === current, `STAGE_PREVIOUS expected ${current} got ${release.previousRevision}`);
		const target = join(this.releases, String(release.revision));
		try {
			await lstat(target);
			const existing = await verifyReleaseFolder(target, await readFile(this.releaseKey, "utf8"));
			need(sha256(existing.bytes) === sha256(await readFile(join(source, "release.json"))), "STAGE_CONFLICT");
			// A crash between rename and chmod leaves the folder writable; the launcher refuses it until this repairs it.
			await chmod(target, 0o555);
			return { staged: release.revision, already: true };
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		await mkdir(this.releases, { recursive: true, mode: 0o755 });
		const temporary = join(this.releases, `.stage-${release.revision}-${randomUUID()}`);
		await mkdir(temporary, { mode: 0o700 });
		try {
			for (const name of ["release.json", "release.sig", ...release.files.map((file) => file.name)]) {
				await copyFile(join(source, name), join(temporary, name));
				if (this.owner !== null) await chown(join(temporary, name), this.owner, this.owner);
				await chmod(join(temporary, name), 0o444);
				await syncPath(join(temporary, name));
			}
			await verifyReleaseFolder(temporary, await readFile(this.releaseKey, "utf8"));
			if (this.owner !== null) await chown(temporary, this.owner, this.owner);
			await syncPath(temporary);
			await rename(temporary, target);
			await chmod(target, 0o555);
			await syncPath(target);
			await syncPath(this.releases);
		} catch (error) {
			await chmod(temporary, 0o700).catch(() => undefined);
			await rm(temporary, { recursive: true, force: true });
			throw error;
		}
		await this.record("stage", { revision: release.revision, sourceCommit: release.sourceCommit });
		return { staged: release.revision, already: false };
	}

	/** Points `link` at releases/<revision> atomically. */
	async point(link, revision) {
		const temporary = join(this.nodeRoot, `.${link}-${randomUUID()}`);
		await symlink(`releases/${revision}`, temporary);
		if (this.owner !== null) await chown(temporary, this.owner, this.owner).catch(() => undefined);
		await rename(temporary, join(this.nodeRoot, link));
		await syncPath(this.nodeRoot);
	}

	async quiet(waitSeconds) {
		const deadline = Date.now() + waitSeconds * 1000;
		for (;;) {
			const busy = (await this.ports.instances())
				.filter((instance) => instance.status === "Running" && RUN_MACHINE.test(instance.name))
				.map((instance) => instance.name);
			if (!busy.length) return;
			need(Date.now() < deadline, `NODE_NOT_QUIET ${busy.join(",")}`);
			this.ports.log?.(`waiting for a quiet node: ${busy.join(",")}`);
			await this.ports.sleep(10_000);
		}
	}

	/** Restarts one role and verifies its unit, its process (exactly exec + the current program) and health. */
	async restartRole(config, role) {
		const settings = config.roles[role];
		const release = await this.release(await this.revisionOf("current"));
		const program = join(this.releases, String(release.revision), release.roles[role].component);
		const since = this.now();
		await this.ports.restart(settings.unit);
		const pid = await this.ports.mainPid(settings.unit);
		need(pid > 0, `ROLE_NOT_RUNNING ${role}`);
		const command = await this.ports.cmdline(pid);
		need(JSON.stringify(command) === JSON.stringify([...settings.exec, program]), `ROLE_COMMAND ${role} ${command.join(" ")}`);
		for (const url of settings.health ?? []) need(await this.ports.healthy(url), `ROLE_HEALTH ${role} ${url}`);
		need(!(await this.ports.journalSince(settings.unit, since)).includes(REFUSAL), `ROLE_REFUSED ${role}`);
		return { role, pid };
	}

	async apply(revision, { defer = [], waitSeconds = 0 } = {}) {
		const config = await this.config();
		const current = await this.revisionOf("current");
		const before = await this.release(current);
		const { release: after } = await verifyReleaseFolder(
			join(this.releases, String(revision)),
			await readFile(this.releaseKey, "utf8"),
		);
		need(after.previousRevision === current, `APPLY_PREVIOUS expected ${current} got ${after.previousRevision}`);
		const missing = Object.keys(config.roles).filter((role) => !after.roles[role]);
		need(!missing.length, `APPLY_RELEASE_LACKS_ROLES ${missing.join(",")}`);
		const roles = config.restartOrder.filter((role) => after.roles[role]);
		const changed = changedRoles(before, after, roles);
		await this.quiet(waitSeconds);
		const previous = await this.revisionOf("previous");
		const intent = { revision, from: current, changed, defer };
		await this.record("apply-intent", intent);
		if (current !== null) await this.point("previous", current);
		await this.point("current", revision);
		const restarted = [];
		try {
			for (const role of changed.filter((role) => !defer.includes(role)))
				restarted.push(await this.restartRole(config, role));
		} catch (error) {
			const bundleKept = before && before.runtimeBundleSha256 === after.runtimeBundleSha256;
			if (!bundleKept || current === null) {
				await this.record("apply-receipt", { ...intent, state: "failed", error: error.message, rolledBack: false });
				throw new Error(`APPLY_FAILED_NO_AUTOMATIC_ROLLBACK ${error.message}`);
			}
			await this.point("current", current);
			if (previous !== null) await this.point("previous", previous);
			for (const role of changed.filter((role) => !defer.includes(role))) await this.restartRole(config, role);
			await this.record("apply-receipt", { ...intent, state: "rolled-back", error: error.message, rolledBack: true });
			throw new Error(`APPLY_ROLLED_BACK ${error.message}`);
		}
		const deferred = changed.filter((role) => defer.includes(role));
		await this.record("apply-receipt", { ...intent, state: "applied", restarted, deferred });
		return { applied: revision, restarted, deferred };
	}

	/** Migration only: the first release describes what already runs; the unit switch starts it. */
	async adopt(revision) {
		need((await this.revisionOf("current")) === null, "ADOPT_ONLY_WITHOUT_CURRENT");
		const { release } = await verifyReleaseFolder(
			join(this.releases, String(revision)),
			await readFile(this.releaseKey, "utf8"),
		);
		need(release.previousRevision === null, "ADOPT_NEEDS_A_FIRST_RELEASE");
		const missing = Object.keys((await this.config()).roles).filter((role) => !release.roles[role]);
		need(!missing.length, `ADOPT_RELEASE_LACKS_ROLES ${missing.join(",")}`);
		await this.point("current", revision);
		await this.record("adopt", { revision });
		return { adopted: revision };
	}

	async rollback() {
		const config = await this.config();
		const current = await this.revisionOf("current");
		const previous = await this.revisionOf("previous");
		need(previous !== null && previous !== current, "ROLLBACK_NO_PREVIOUS");
		const before = await this.release(current);
		const after = await this.release(previous);
		const changed = changedRoles(before, after, config.restartOrder.filter((role) => after.roles[role]));
		await this.quiet(0);
		await this.record("rollback-intent", { from: current, to: previous, changed });
		await this.point("current", previous);
		await this.point("previous", current);
		const restarted = [];
		for (const role of changed) restarted.push(await this.restartRole(config, role));
		await this.record("rollback-receipt", { from: current, to: previous, restarted });
		return { rolledBackTo: previous, restarted };
	}

	async restart(role) {
		const config = await this.config();
		need(config.roles[role], `NODE_ROLE_UNKNOWN ${role}`);
		const result = await this.restartRole(config, role);
		await this.record("restart-receipt", result);
		return result;
	}

	async status() {
		const config = await this.config();
		const current = await this.revisionOf("current");
		const previous = await this.revisionOf("previous");
		const staged = (await readdir(this.releases).catch(() => []))
			.filter((name) => /^(0|[1-9][0-9]*)$/.test(name))
			.map(Number)
			.sort((a, b) => a - b);
		const roles = {};
		for (const [role, settings] of Object.entries(config.roles)) {
			const pid = await this.ports.mainPid(settings.unit);
			roles[role] = {
				unit: settings.unit,
				pid,
				command: pid > 0 ? await this.ports.cmdline(pid) : [],
				healthy: await Promise.all((settings.health ?? []).map((url) => this.ports.healthy(url))),
			};
		}
		return { current, previous, staged, roles };
	}

	async gc() {
		const current = await this.revisionOf("current");
		const previous = await this.revisionOf("previous");
		need(current !== null, "GC_NO_CURRENT");
		const removed = [];
		for (const name of await readdir(this.releases)) {
			if (!/^(0|[1-9][0-9]*)$/.test(name)) continue;
			const revision = Number(name);
			if (revision === current || revision === previous || revision > current) continue;
			const folder = join(this.releases, name);
			await chmod(folder, 0o700);
			await rm(folder, { recursive: true, force: true });
			removed.push(revision);
		}
		await syncPath(this.releases);
		if (removed.length) await this.record("gc", { removed });
		return { removed };
	}
}

async function syncPath(path) {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

const run = promisify(execFile);

/** The real node: systemd, /proc, the LXD socket and the health ports. */
export function nodePorts(lxdSocket = "/var/snap/lxd/common/lxd/unix.socket") {
	const lxdGet = (path) =>
		new Promise((resolve, reject) => {
			const req = request({ socketPath: lxdSocket, path, headers: { host: "lxd" }, timeout: 30_000 }, (response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch (error) {
						reject(error);
					}
				});
			});
			req.on("timeout", () => req.destroy(new Error("LXD request timed out")));
			req.on("error", reject);
			req.end();
		});
	return {
		async instances() {
			const body = await lxdGet("/1.0/instances?recursion=1&all-projects=true");
			return body.metadata.map((instance) => ({ name: instance.name, status: instance.status }));
		},
		async restart(unit) {
			await run("/usr/bin/systemctl", ["restart", unit], { timeout: 180_000 });
		},
		async mainPid(unit) {
			const { stdout } = await run("/usr/bin/systemctl", ["show", unit, "-p", "MainPID", "--value"]);
			return Number(stdout.trim());
		},
		async cmdline(pid) {
			return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
		},
		async healthy(url) {
			for (let attempt = 0; attempt < 60; attempt++) {
				const ok = await fetch(url, { signal: AbortSignal.timeout(3000) }).then(
					(response) => response.ok,
					() => false,
				);
				if (ok) return true;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			return false;
		},
		async journalSince(unit, since) {
			const { stdout } = await run("/usr/bin/journalctl", [
				"-u",
				unit,
				"--since",
				`@${Math.floor(since.getTime() / 1000)}`,
				"--no-pager",
				"-o",
				"cat",
			]);
			return stdout;
		},
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		log: (line) => process.stderr.write(`${line}\n`),
	};
}

async function main(argv) {
	const [command, ...rest] = argv;
	const mutating = ["stage", "adopt", "apply", "rollback", "restart", "gc"].includes(command);
	if (mutating && process.env.QORPERA_NODE_LOCK_HELD !== "1") {
		const child = spawnSync(
			"/usr/bin/flock",
			[
				"--nonblock",
				"--conflict-exit-code",
				"75",
				"/run/lock/qorpera-node-update.lock",
				process.execPath,
				process.argv[1],
				...argv,
			],
			{ stdio: "inherit", env: { ...process.env, QORPERA_NODE_LOCK_HELD: "1" } },
		);
		return child.status ?? 1;
	}
	need(process.getuid?.() === 0, "NODE_AGENT_REQUIRES_ROOT");
	const agent = new NodeAgent({ ports: nodePorts() });
	const option = (name) => {
		const values = [];
		for (let index = 0; index < rest.length; index++) if (rest[index] === name) values.push(rest[index + 1]);
		return values;
	};
	let result;
	if (command === "stage") result = await agent.stage(rest[0]);
	else if (command === "apply")
		result = await agent.apply(Number(rest[0]), {
			defer: option("--defer"),
			waitSeconds: Number(option("--wait")[0] ?? 0),
		});
	else if (command === "adopt") result = await agent.adopt(Number(rest[0]));
	else if (command === "rollback") result = await agent.rollback();
	else if (command === "restart") result = await agent.restart(rest[0]);
	else if (command === "status") result = await agent.status();
	else if (command === "gc") result = await agent.gc();
	else throw new Error("usage: qorpera-node-agent stage|adopt|apply|rollback|restart|status|gc");
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			process.stderr.write(`qorpera-node-agent: ${error.message}\n`);
			process.exit(1);
		},
	);
}
