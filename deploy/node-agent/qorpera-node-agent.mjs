#!/usr/bin/env node
// Node agent (phase B of the node auto-update plan): installs a signed release in place of the running one and keeps
// exactly one earlier release to roll back to. Commands (root):
//   stage <folder>      verify release.json + release.sig and every file, then write /opt/qorpera-node/releases/<revision>
//   adopt <revision>    first release only (migration): point current and every role at it, restarting nothing
//   apply <revision>    quiet gate, swap current/previous, then per changed role: re-check quiet, point the role at the
//                       release, restart and verify it; a failed check rolls back by itself only when the release
//                       keeps the runtime bundle
//                       [--defer <role>]... leaves a role on its old release, even across a systemd restart, until
//                       `restart <role>`; a release with order "pause" must defer the node's pauseDeferredRoles
//                       [--wait <seconds>] waits for a quiet node instead of refusing at once
//   rollback [--defer <role>]...  swap back to the previous release and restart what differs
//   switch <role> <old unit>      migration: after the quiet gate, stop and disable the old unit, enable and start the
//                       role's new unit and verify it; a failed check switches back at once
//   unswitch <role> <old unit>    migration rollback: stop and disable the new unit, enable and start the old one
//   restart <role>      point the role at the current release, restart and verify it (a deferred role after resume)
//   status              JSON: current, previous, staged, each role's release, unit, process and health
//   gc                  delete releases no role, current or previous uses (staged newer ones stay), leftovers of
//                       interrupted operations, and journal records of deleted releases
// Each role runs the release its own link names: /opt/qorpera-node/roles/<role> -> ../releases/<n>.
// Mutating commands hold an flock on the root-owned /run/lock/qorpera-node-update.lock; a held lock refuses (exit 75).
// Every node interaction goes through `ports`, so the logic is tested without a node.

import { execFile, spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
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
const MAX_REVISION = 999_999_999;
const START_ATTEMPTS = 120; // 500 ms apart: a role has one minute to exec its program
const LOCK = "/run/lock/qorpera-node-update.lock";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => {
	if (!ok) throw new Error(message);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Validates a release manifest's structure. */
export function parseRelease(bytes) {
	const value = JSON.parse(bytes.toString("utf8"));
	const keys = ["schema", "revision", "previousRevision", "sourceCommit", "runtimeBundleSha256", "order", "files", "roles"];
	need(
		value && typeof value === "object" && Object.keys(value).sort().join() === [...keys].sort().join(),
		"RELEASE_FIELDS",
	);
	need(value.schema === RELEASE_SCHEMA, "RELEASE_SCHEMA");
	need(Number.isSafeInteger(value.revision) && value.revision >= 0 && value.revision <= MAX_REVISION, "RELEASE_REVISION");
	need(
		value.previousRevision === null ||
			(Number.isSafeInteger(value.previousRevision) &&
				value.previousRevision >= 0 &&
				value.previousRevision < value.revision),
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
export function roleChanged(before, after, role) {
	const digest = (release) => release.files.find((file) => file.name === release.roles[role].component)?.sha256;
	return !before?.roles[role] || digest(before) !== digest(after) || !same(before.roles[role].env, after.roles[role].env);
}

export function parseNodeConfig(bytes) {
	const value = JSON.parse(bytes.toString("utf8"));
	need(value.schema === NODE_SCHEMA && value.roles && typeof value.roles === "object", "NODE_CONFIG");
	for (const [role, settings] of Object.entries(value.roles)) {
		need(ROLE.test(role) && /^qorpera-[a-z0-9-]+\.service$/.test(settings.unit), `NODE_ROLE ${role}`);
		need(Array.isArray(settings.exec) && settings.exec[0]?.startsWith("/"), `NODE_ROLE_EXEC ${role}`);
		need(Array.isArray(settings.health), `NODE_ROLE_HEALTH ${role}`);
	}
	const roles = Object.keys(value.roles);
	need(
		Array.isArray(value.restartOrder) &&
			value.restartOrder.length === roles.length &&
			roles.every((role) => value.restartOrder.includes(role)),
		"NODE_RESTART_ORDER",
	);
	need(
		Array.isArray(value.pauseDeferredRoles) && value.pauseDeferredRoles.every((role) => value.roles[role]),
		"NODE_PAUSE_DEFERRED_ROLES",
	);
	return value;
}

export class NodeAgent {
	constructor({ root = "/", ports, owner = 0, now = () => new Date() }) {
		this.nodeRoot = join(root, "opt/qorpera-node");
		this.releases = join(this.nodeRoot, "releases");
		this.roles = join(this.nodeRoot, "roles");
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

	async readLink(path, prefix) {
		try {
			const target = await readlink(path);
			need(
				target.startsWith(prefix) && /^(0|[1-9][0-9]{0,8})$/.test(target.slice(prefix.length)),
				`NODE_LINK ${path}`,
			);
			return Number(target.slice(prefix.length));
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
	}

	revisionOf(link) {
		return this.readLink(join(this.nodeRoot, link), "releases/");
	}

	roleRevision(role) {
		return this.readLink(join(this.roles, role), "../releases/");
	}

	async release(revision) {
		return revision === null
			? null
			: parseRelease(await readFile(join(this.releases, String(revision), "release.json")));
	}

	releaseKeyPem() {
		return readFile(this.releaseKey, "utf8");
	}

	/** An fsynced, never overwritten record; `revision` ties it to a release so gc can prune it with the release. */
	async record(kind, revision, value) {
		await mkdir(this.journal, { recursive: true, mode: 0o700 });
		const at = this.now().toISOString();
		const name = `${at.replaceAll(":", "")}-${kind}-r${revision ?? "none"}-${randomUUID()}.json`;
		const handle = await open(join(this.journal, name), "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify({ kind, revision, at, ...value })}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await syncPath(this.journal);
	}

	async stage(source) {
		const key = await this.releaseKeyPem();
		const { release, bytes } = await verifyReleaseFolder(source, key);
		const current = await this.revisionOf("current");
		need(release.previousRevision === current, `STAGE_PREVIOUS expected ${current} got ${release.previousRevision}`);
		const target = join(this.releases, String(release.revision));
		try {
			await lstat(target);
			const existing = await verifyReleaseFolder(target, key);
			need(sha256(existing.bytes) === sha256(bytes), "STAGE_CONFLICT");
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
			// The copy must be the manifest verified above, not a second one swapped into the source meanwhile.
			const copied = await verifyReleaseFolder(temporary, key);
			need(sha256(copied.bytes) === sha256(bytes), "STAGE_SOURCE_CHANGED");
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
		await this.record("stage", release.revision, { sourceCommit: release.sourceCommit });
		return { staged: release.revision, already: false };
	}

	/** Points `link` (relative to the node root) at releases/<revision> atomically. The agent runs as root, so the
	 * link is root-owned (chown would follow it to the release folder). */
	async point(link, revision) {
		const inRoles = link.startsWith("roles/");
		const folder = inRoles ? this.roles : this.nodeRoot;
		if (inRoles) await mkdir(this.roles, { recursive: true, mode: 0o755 });
		const temporary = join(folder, `.link-${randomUUID()}`);
		await symlink(`${inRoles ? "../" : ""}releases/${revision}`, temporary);
		await rename(temporary, join(this.nodeRoot, link));
		await syncPath(folder);
	}

	async verifiedRelease(revision) {
		const { release } = await verifyReleaseFolder(join(this.releases, String(revision)), await this.releaseKeyPem());
		need(release.revision === revision, `RELEASE_FOLDER_HOLDS ${release.revision} NOT ${revision}`);
		return release;
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

	validDefer(config, defer) {
		const unknown = defer.filter((role) => !config.roles[role]);
		need(!unknown.length, `DEFER_UNKNOWN_ROLES ${unknown.join(",")}`);
	}

	/** Restarts one role on the release its link names, then verifies it: within a minute the unit's main process is
	 * exactly exec + that release's program (the launcher execs it after its checks), health answers, and the journal
	 * shows no launcher refusal. */
	async restartRole(config, role) {
		const settings = config.roles[role];
		const revision = await this.roleRevision(role);
		need(revision !== null, `ROLE_HAS_NO_RELEASE ${role}`);
		const release = await this.release(revision);
		const expected = [...settings.exec, join(this.releases, String(revision), release.roles[role].component)];
		const since = this.now();
		await this.ports.restart(settings.unit);
		let pid = 0;
		let command = [];
		for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
			pid = await this.ports.mainPid(settings.unit);
			command = pid > 0 ? await this.ports.cmdline(pid).catch(() => []) : [];
			if (same(command, expected)) break;
			await this.ports.sleep(500);
		}
		need(same(command, expected), `ROLE_COMMAND ${role} ${command.join(" ")}`);
		for (const url of settings.health) need(await this.ports.healthy(url), `ROLE_HEALTH ${role} ${url}`);
		need(!(await this.ports.journalSince(settings.unit, since)).includes(REFUSAL), `ROLE_REFUSED ${role}`);
		return { role, revision, pid };
	}

	/** Moves roles to `revision` one at a time, re-checking quiet right before each restart. */
	async moveRoles(config, roles, revision) {
		const moved = [];
		for (const role of roles) {
			await this.quiet(0);
			const from = await this.roleRevision(role);
			await this.point(`roles/${role}`, revision);
			moved.push({ role, from });
			await this.restartRole(config, role);
		}
		return moved;
	}

	async adopt(revision) {
		need((await this.revisionOf("current")) === null, "ADOPT_ONLY_WITHOUT_CURRENT");
		const release = await this.verifiedRelease(revision);
		need(release.previousRevision === null, "ADOPT_NEEDS_A_FIRST_RELEASE");
		const config = await this.config();
		const missing = Object.keys(config.roles).filter((role) => !release.roles[role]);
		need(!missing.length, `ADOPT_RELEASE_LACKS_ROLES ${missing.join(",")}`);
		for (const role of Object.keys(config.roles)) await this.point(`roles/${role}`, revision);
		await this.point("current", revision);
		await this.record("adopt", revision, {});
		return { adopted: revision };
	}

	async apply(revision, { defer = [], waitSeconds = 0 } = {}) {
		const config = await this.config();
		this.validDefer(config, defer);
		const current = await this.revisionOf("current");
		const after = await this.verifiedRelease(revision);
		need(after.previousRevision === current, `APPLY_PREVIOUS expected ${current} got ${after.previousRevision}`);
		const roles = config.restartOrder;
		const missing = roles.filter((role) => !after.roles[role]);
		need(!missing.length, `APPLY_RELEASE_LACKS_ROLES ${missing.join(",")}`);
		// A role's link may stay on an older release whose program and values for that role equal current's (it did
		// not change); only a role that differs from current is still deferred. What changes is decided per role,
		// against the release that role runs.
		const before = await this.release(current);
		const running = {};
		for (const role of roles) running[role] = await this.release(await this.roleRevision(role));
		const lagging = roles.filter((role) => before && roleChanged(running[role], before, role));
		need(!lagging.length, `APPLY_ROLES_STILL_DEFERRED ${lagging.join(",")}`);
		const changed = roles.filter((role) => roleChanged(running[role], after, role));
		if (after.order === "pause") {
			const undeferred = config.pauseDeferredRoles.filter((role) => changed.includes(role) && !defer.includes(role));
			need(!undeferred.length, `APPLY_PAUSE_REQUIRES_DEFER ${undeferred.join(",")}`);
		}
		await this.quiet(waitSeconds);
		const previous = await this.revisionOf("previous");
		const intent = { from: current, changed, defer };
		await this.record("apply-intent", revision, intent);
		if (current !== null) await this.point("previous", current);
		await this.point("current", revision);
		let moved = [];
		try {
			moved = await this.moveRoles(
				config,
				changed.filter((role) => !defer.includes(role)),
				revision,
			);
		} catch (error) {
			const bundleKept = before && before.runtimeBundleSha256 === after.runtimeBundleSha256;
			if (!bundleKept) {
				await this.record("apply-receipt", revision, {
					...intent,
					state: "failed",
					error: error.message,
					rolledBack: false,
				});
				throw new Error(`APPLY_FAILED_NO_AUTOMATIC_ROLLBACK ${error.message}`);
			}
			// Every role pointed at the new release goes back to the release it ran, including the one whose check failed.
			const touched = moved.length ? moved : [];
			for (const role of roles)
				if ((await this.roleRevision(role)) === revision && !touched.some((entry) => entry.role === role))
					touched.push({ role, from: running[role].revision });
			for (const { role, from } of touched) await this.point(`roles/${role}`, from);
			await this.point("current", current);
			if (previous !== null) await this.point("previous", previous);
			for (const { role } of touched) await this.restartRole(config, role);
			await this.record("apply-receipt", revision, {
				...intent,
				state: "rolled-back",
				error: error.message,
				rolledBack: true,
			});
			throw new Error(`APPLY_ROLLED_BACK ${error.message}`);
		}
		const deferred = changed.filter((role) => defer.includes(role));
		await this.record("apply-receipt", revision, { ...intent, state: "applied", moved, deferred });
		return { applied: revision, restarted: moved.map((entry) => entry.role), deferred };
	}

	async rollback({ defer = [] } = {}) {
		const config = await this.config();
		this.validDefer(config, defer);
		const current = await this.revisionOf("current");
		const previous = await this.revisionOf("previous");
		need(previous !== null && previous !== current, "ROLLBACK_NO_PREVIOUS");
		const target = await this.verifiedRelease(previous);
		const changed = [];
		for (const role of config.restartOrder) {
			const running = await this.release(await this.roleRevision(role));
			if (roleChanged(running, target, role)) changed.push(role);
		}
		await this.quiet(0);
		await this.record("rollback-intent", previous, { from: current, changed, defer });
		try {
			await this.point("current", previous);
			await this.point("previous", current);
			const moved = await this.moveRoles(
				config,
				changed.filter((role) => !defer.includes(role)),
				previous,
			);
			await this.record("rollback-receipt", previous, { from: current, state: "rolled-back", moved });
			return {
				rolledBackTo: previous,
				restarted: moved.map((entry) => entry.role),
				deferred: changed.filter((role) => defer.includes(role)),
			};
		} catch (error) {
			await this.record("rollback-receipt", previous, { from: current, state: "failed", error: error.message });
			throw new Error(`ROLLBACK_FAILED ${error.message}`);
		}
	}

	/** Migration: moves a role from its old unit (versioned launcher, stacked drop-ins) to its new unit. */
	async switch(role, fromUnit) {
		const config = await this.config();
		const settings = config.roles[role];
		need(settings, `NODE_ROLE_UNKNOWN ${role}`);
		need(/^qorpera-[a-z0-9-]+\.service$/.test(fromUnit) && fromUnit !== settings.unit, "SWITCH_OLD_UNIT");
		const revision = await this.roleRevision(role);
		need(revision !== null, "SWITCH_NEEDS_AN_ADOPTED_RELEASE");
		await this.quiet(0);
		const oldPid = await this.ports.mainPid(fromUnit);
		const before = oldPid > 0 ? await this.ports.cmdline(oldPid) : [];
		await this.record("switch-intent", revision, { role, from: fromUnit, to: settings.unit, before });
		await this.ports.disable(fromUnit, true);
		try {
			await this.ports.enable(settings.unit, false);
			const result = await this.restartRole(config, role);
			const after = await this.ports.cmdline(result.pid);
			await this.record("switch-receipt", revision, {
				role,
				from: fromUnit,
				to: settings.unit,
				state: "switched",
				before,
				after,
			});
			return { switched: role, from: fromUnit, to: settings.unit, before, after };
		} catch (error) {
			await this.ports.disable(settings.unit, true).catch(() => undefined);
			await this.ports.enable(fromUnit, true);
			need((await this.ports.mainPid(fromUnit)) > 0, `SWITCH_BACK_FAILED ${error.message}`);
			await this.record("switch-receipt", revision, {
				role,
				from: fromUnit,
				to: settings.unit,
				state: "switched-back",
				error: error.message,
			});
			throw new Error(`SWITCH_REVERTED ${error.message}`);
		}
	}

	async unswitch(role, toUnit) {
		const config = await this.config();
		const settings = config.roles[role];
		need(settings && /^qorpera-[a-z0-9-]+\.service$/.test(toUnit) && toUnit !== settings.unit, "UNSWITCH_UNITS");
		await this.quiet(0);
		await this.ports.disable(settings.unit, true);
		await this.ports.enable(toUnit, true);
		const pid = await this.ports.mainPid(toUnit);
		need(pid > 0, `UNSWITCH_OLD_UNIT_NOT_RUNNING ${toUnit}`);
		await this.record("unswitch-receipt", await this.roleRevision(role), { role, from: settings.unit, to: toUnit, pid });
		return { unswitched: role, to: toUnit, pid };
	}

	/** Points a role at the current release and restarts it: a deferred role after resume. */
	async restart(role) {
		const config = await this.config();
		need(config.roles[role], `NODE_ROLE_UNKNOWN ${role}`);
		const current = await this.revisionOf("current");
		need(current !== null, "RESTART_NO_CURRENT");
		const [moved] = await this.moveRoles(config, [role], current);
		await this.record("restart-receipt", current, { role, from: moved.from });
		return { restarted: role, revision: current, from: moved.from };
	}

	async status() {
		const config = await this.config();
		const staged = (await readdir(this.releases).catch(() => []))
			.filter((name) => /^(0|[1-9][0-9]*)$/.test(name))
			.map(Number)
			.sort((a, b) => a - b);
		const roles = {};
		for (const [role, settings] of Object.entries(config.roles)) {
			const pid = await this.ports.mainPid(settings.unit);
			roles[role] = {
				release: await this.roleRevision(role),
				unit: settings.unit,
				pid,
				command: pid > 0 ? await this.ports.cmdline(pid) : [],
				healthy: await Promise.all(settings.health.map((url) => this.ports.healthy(url))),
			};
		}
		return { current: await this.revisionOf("current"), previous: await this.revisionOf("previous"), staged, roles };
	}

	async gc() {
		const config = await this.config();
		const current = await this.revisionOf("current");
		need(current !== null, "GC_NO_CURRENT");
		const keep = new Set([current, await this.revisionOf("previous")]);
		for (const role of Object.keys(config.roles)) keep.add(await this.roleRevision(role));
		const removed = [];
		for (const name of await readdir(this.releases)) {
			const folder = join(this.releases, name);
			if (name.startsWith(".stage-")) {
				await chmod(folder, 0o700).catch(() => undefined);
				await rm(folder, { recursive: true, force: true });
				continue;
			}
			if (!/^(0|[1-9][0-9]*)$/.test(name)) continue;
			const revision = Number(name);
			if (keep.has(revision) || revision > current) continue;
			await chmod(folder, 0o700);
			await rm(folder, { recursive: true, force: true });
			removed.push(revision);
		}
		for (const folder of [this.nodeRoot, this.roles])
			for (const name of await readdir(folder).catch(() => []))
				if (name.startsWith(".link-")) await rm(join(folder, name), { force: true });
		await syncPath(this.releases);
		let pruned = 0;
		for (const name of await readdir(this.journal).catch(() => [])) {
			const revision = /-r(\d+)-[0-9a-f-]{36}\.json$/.exec(name)?.[1];
			if (revision !== undefined && removed.includes(Number(revision))) {
				await rm(join(this.journal, name), { force: true });
				pruned++;
			}
		}
		if (removed.length) await this.record("gc", current, { removed, prunedRecords: pruned });
		return { removed, prunedRecords: pruned };
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

/** Runs `action` holding the node update lock. /run/lock is world-writable, so the lock file must be root-owned and
 * writable only by root; a file another user created first is refused, never trusted. */
export async function withNodeLock(action, lockPath = LOCK) {
	const handle = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
	try {
		const info = await handle.stat();
		need(info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0 && info.nlink === 1, "NODE_LOCK_UNSAFE");
		// flock(1) locks the inherited descriptor: the lock belongs to this open file until this process closes it.
		const locked = spawnSync("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "75", "3"], {
			stdio: ["ignore", "inherit", "inherit", handle.fd],
		});
		if (locked.status === 75) return { refused: "NODE_LOCK_HELD" };
		need(locked.status === 0, "NODE_LOCK_FAILED");
		return await action();
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
		async enable(unit, now) {
			await run("/usr/bin/systemctl", ["enable", ...(now ? ["--now"] : []), unit], { timeout: 180_000 });
		},
		async disable(unit, now) {
			await run("/usr/bin/systemctl", ["disable", ...(now ? ["--now"] : []), unit], { timeout: 180_000 });
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
	need(process.getuid?.() === 0, "NODE_AGENT_REQUIRES_ROOT");
	const agent = new NodeAgent({ ports: nodePorts() });
	const values = (name) => {
		const found = [];
		for (let index = 0; index < rest.length; index++) if (rest[index] === name) found.push(rest[index + 1]);
		return found;
	};
	const actions = {
		stage: () => agent.stage(rest[0]),
		adopt: () => agent.adopt(Number(rest[0])),
		apply: () =>
			agent.apply(Number(rest[0]), { defer: values("--defer"), waitSeconds: Number(values("--wait")[0] ?? 0) }),
		rollback: () => agent.rollback({ defer: values("--defer") }),
		switch: () => agent.switch(rest[0], rest[1]),
		unswitch: () => agent.unswitch(rest[0], rest[1]),
		restart: () => agent.restart(rest[0]),
		gc: () => agent.gc(),
	};
	let result;
	if (command === "status") result = await agent.status();
	else if (actions[command]) result = await withNodeLock(actions[command]);
	else throw new Error("usage: qorpera-node-agent stage|adopt|apply|rollback|switch|unswitch|restart|status|gc");
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return result?.refused ? 75 : 0;
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
