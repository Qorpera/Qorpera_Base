#!/usr/bin/env node
// Identical nodes: shows every way two nodes differ in setup. Read-only.
//
//   qorpera-node-parity.mjs collect <node label>          on a node, as root: prints its setup as JSON
//   qorpera-node-parity.mjs compare <class.json> <a.json> <b.json>   anywhere: prints the differences
//
// A node's setup here is what the runtime depends on: the Qorpera and LXD systemd units and whether they
// run, the storage server (NFS) mounts and their options, the LXD projects, networks and storage pools,
// the non-managed LXD instances (fast host, company machines' hosts), and the node agent's roles and the
// NAMES of each role's fixed settings. It never reads a setting's value, a credential or an env file.
// The node's own label is replaced by "<node>" everywhere, so qorpera-exec-node01 and
// qorpera-exec-node02 compare equal. The class file lists what may differ on purpose.

import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const SETUP_SCHEMA = "qorpera.node-setup/v1";
export const CLASS_SCHEMA = "qorpera.node-parity-class/v1";
const LABEL = /^[a-z][a-z0-9-]{0,62}$/;
// Instances placed by the database (runs, sign-ins, company machines, coding and test machines) come and
// go and are covered by the node inventory check; only the rest is node setup.
const PLACED = /^user\.qorpera\.(schema|allocation_id|acquisition_id)$/;

/** Every spelling of a node label that names the node in paths and unit names: node02, node-02, node2. */
export function labelForms(label) {
	if (!LABEL.test(label)) throw new Error("INVALID_NODE_LABEL");
	const forms = new Set([label]);
	const match = /^(.*?node)-?0*([0-9]+)$/.exec(label);
	if (match) {
		const [, stem, number] = match;
		for (const width of [1, 2]) {
			const n = number.padStart(width, "0");
			forms.add(`${stem}${n}`);
			forms.add(`${stem}-${n}`);
		}
	}
	return [...forms].sort((a, b) => b.length - a.length);
}

export function neutral(text, forms) {
	let out = text;
	for (const form of forms) out = out.split(form).join("<node>");
	return out;
}

/** Turns raw observations into a comparable, value-free setup. Pure. */
export function normalizeSetup({ label, units, unitFiles, mounts, projects, networks, pools, instances, roles, nodeJson }) {
	const forms = labelForms(label);
	const n = (text) => neutral(String(text), forms);
	const enabled = new Map(unitFiles.map((file) => [file.unit, file.state]));
	const services = Object.fromEntries(
		units
			.filter((unit) => /^(qorpera|lxd|snap\.lxd)/.test(unit.unit))
			.map((unit) => [n(unit.unit), { active: unit.active, enabled: enabled.get(unit.unit) ?? "unknown" }])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const nfs = Object.fromEntries(
		mounts
			.filter((mount) => /^nfs/.test(mount.fstype))
			.map((mount) => {
				const options = mount.options
					.split(",")
					.filter((option) => /^(ro|rw|noexec|exec|nosuid|suid|nodev|vers=.*|hard|soft|sec=.*|proto=.*)$/.test(option))
					.sort();
				return [n(mount.target), { source: n(mount.source), fstype: mount.fstype, options }];
			})
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const lxdProjects = Object.fromEntries(
		projects
			.map((project) => [
				n(project.name),
				Object.fromEntries(
					Object.entries(project.config ?? {})
						.filter(([key]) => /^(features\.|restricted|limits\.)/.test(key))
						.sort(([a], [b]) => a.localeCompare(b)),
				),
			])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const lxdNetworks = Object.fromEntries(
		networks
			.filter((network) => network.managed)
			.map((network) => [n(network.name), { type: network.type }])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const lxdPools = Object.fromEntries(
		pools.map((pool) => [n(pool.name), { driver: pool.driver }]).sort(([a], [b]) => a.localeCompare(b)),
	);
	const hosts = Object.fromEntries(
		instances
			.filter((instance) => !Object.keys(instance.config ?? {}).some((key) => PLACED.test(key)))
			.map((instance) => [
				`${n(instance.project)}/${n(instance.name)}`,
				{
					type: instance.type,
					status: instance.status,
					cpu: instance.config?.["limits.cpu"] ?? null,
					memory: instance.config?.["limits.memory"] ?? null,
				},
			])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const agentRoles = Object.fromEntries(
		Object.entries(roles)
			.map(([role, release]) => [role, { release }])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const settings = Object.fromEntries(
		Object.entries(nodeJson?.roles ?? {})
			.map(([role, value]) => [
				role,
				{
					fixed: Object.keys(value?.fixed ?? {}).sort(),
					secretKeys: [...(Array.isArray(value?.secretKeys) ? value.secretKeys : Object.keys(value?.secretKeys ?? {}))]
						.map(String)
						.sort(),
				},
			])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	return {
		schema: SETUP_SCHEMA,
		label,
		services,
		nfs,
		lxd: { projects: lxdProjects, networks: lxdNetworks, pools: lxdPools, hosts },
		agent: { roles: agentRoles, settings },
	};
}

export function parseClass(value) {
	if (!value || value.schema !== CLASS_SCHEMA) throw new Error("INVALID_PARITY_CLASS");
	const list = (key) => {
		const items = value[key] ?? [];
		if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) throw new Error("INVALID_PARITY_CLASS");
		return items;
	};
	return { mayDiffer: list("mayDiffer"), onlyOn: value.onlyOn ?? {} };
}

function flatten(value, path, out) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, item] of Object.entries(value)) flatten(item, [...path, key], out);
	} else out.set(path.join(" › "), JSON.stringify(value));
	return out;
}

/** Differences between two nodes' setups, minus what the class allows. Pure.
 * A class entry in `mayDiffer` is a prefix of a difference path ("nfs › /srv/qorpera/coding",
 * "agent › roles"). `onlyOn: {"<label>": [prefix, …]}` names what only that node has: it must be
 * missing on the other node and present on it. */
export function compareSetups(klass, a, b) {
	for (const setup of [a, b]) if (setup?.schema !== SETUP_SCHEMA) throw new Error("INVALID_NODE_SETUP");
	const c = parseClass(klass);
	const left = flatten({ services: a.services, nfs: a.nfs, lxd: a.lxd, agent: a.agent }, [], new Map());
	const right = flatten({ services: b.services, nfs: b.nfs, lxd: b.lxd, agent: b.agent }, [], new Map());
	const allowed = (path) => c.mayDiffer.some((prefix) => path === prefix || path.startsWith(`${prefix} › `));
	const only = (label, path) =>
		(c.onlyOn[label] ?? []).some((prefix) => path === prefix || path.startsWith(`${prefix} › `));
	const differences = [];
	for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
		const x = left.get(path),
			y = right.get(path);
		if (x === y) continue;
		if (x !== undefined && y === undefined && only(a.label, path)) continue;
		if (y !== undefined && x === undefined && only(b.label, path)) continue;
		differences.push({ path, [a.label]: x ?? null, [b.label]: y ?? null, allowed: allowed(path) });
	}
	return {
		identical: differences.every((difference) => difference.allowed),
		differences,
	};
}

const run = promisify(execFile);
async function json(command, args) {
	return JSON.parse((await run(command, args, { maxBuffer: 64 * 1024 * 1024 })).stdout);
}
async function lines(command, args) {
	return (await run(command, args, { maxBuffer: 16 * 1024 * 1024 })).stdout.split("\n").filter(Boolean);
}

export async function collect(label) {
	const units = (await lines("systemctl", ["list-units", "--all", "--plain", "--no-legend", "--no-pager", "--type=service,timer,mount,socket"]))
		.map((line) => line.trim().split(/\s+/))
		.map(([unit, , active]) => ({ unit, active }));
	const unitFiles = (await lines("systemctl", ["list-unit-files", "--plain", "--no-legend", "--no-pager"]))
		.map((line) => line.trim().split(/\s+/))
		.map(([unit, state]) => ({ unit, state }));
	const mounts = ((await json("findmnt", ["-J", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"])).filesystems ?? []).flatMap(
		function walk(item) {
			return [item, ...(item.children ?? []).flatMap(walk)];
		},
	);
	const projects = await json("lxc", ["query", "/1.0/projects?recursion=1"]);
	const networks = await json("lxc", ["query", "/1.0/networks?recursion=1"]);
	const pools = await json("lxc", ["query", "/1.0/storage-pools?recursion=1"]);
	const instances = await json("lxc", ["query", "/1.0/instances?all-projects=true&recursion=1"]);
	const roles = {};
	for (const role of ["provider", "orchestrator", "observer"]) {
		try {
			roles[role] = (await readlink(`/opt/qorpera-node/roles/${role}`)).split("/").pop();
		} catch {
			/* role not on the node agent */
		}
	}
	let nodeJson = null;
	try {
		nodeJson = JSON.parse(await readFile("/etc/qorpera-node/node.json", "utf8"));
	} catch {
		/* node without the agent */
	}
	return normalizeSetup({ label, units, unitFiles, mounts, projects, networks, pools, instances, roles, nodeJson });
}

async function main(argv) {
	const [mode, ...rest] = argv;
	if (mode === "collect" && rest.length === 1) {
		process.stdout.write(`${JSON.stringify(await collect(rest[0]), null, 2)}\n`);
		return 0;
	}
	if (mode === "compare" && rest.length === 3) {
		const [klass, a, b] = await Promise.all(rest.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
		const result = compareSetups(klass, a, b);
		for (const difference of result.differences)
			process.stdout.write(
				`${difference.allowed ? "allowed " : "DIFFERS "} ${difference.path}\n    ${a.label}: ${difference[a.label]}\n    ${b.label}: ${difference[b.label]}\n`,
			);
		process.stdout.write(result.identical ? "Same setup (allowed differences only).\n" : "Setups differ.\n");
		return result.identical ? 0 : 1;
	}
	process.stderr.write("usage: qorpera-node-parity.mjs collect <node label> | compare <class.json> <a.json> <b.json>\n");
	return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2));
}
