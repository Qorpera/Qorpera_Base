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
import { readdir, readFile, readlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const SETUP_SCHEMA = "qorpera.node-setup/v1";
export const CLASS_SCHEMA = "qorpera.node-parity-class/v1";
const LABEL = /^[a-z][a-z0-9-]{0,62}$/;
// Instances placed by the database (runs, sign-ins, company machines, coding and test machines) come and
// go and are covered by the node inventory check; only the rest is node setup.
const PLACED = /^user\.qorpera\.(schema|allocation_id|acquisition_id)$/;

/** Every spelling of a node label that names the node in paths and unit names, longest first: the full
 * label (company41-node-02) and its node token (node02, node-02, node2, node-2), as names use both. */
export function labelForms(label) {
	if (!LABEL.test(label)) throw new Error("INVALID_NODE_LABEL");
	const forms = new Set([label]);
	const match = /(?:^|-)(node)-?0*([0-9]+)$/.exec(label);
	if (match) {
		const [, stem, number] = match;
		for (const width of [1, 2]) {
			const n = number.padStart(width, "0");
			forms.add(`${stem}${n}`);
			forms.add(`${stem}-${n}`);
		}
	}
	return [...forms].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** Replace the node's own spellings with <node>, only where no letter or digit continues the name on
 * either side: node1 never matches inside node10 or subnode1. */
export function neutral(text, forms) {
	let out = text;
	for (const form of forms) {
		const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"), "<node>");
	}
	return out;
}

/** Build a map from entries, refusing two names that become one after neutralisation. */
function uniqueMap(entries, what) {
	const map = new Map();
	for (const [key, value] of entries) {
		if (map.has(key)) throw new Error(`NODE_SETUP_NAME_COLLISION: ${what} ${key}`);
		map.set(key, value);
	}
	return Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
}

/** Turns raw observations into a comparable, value-free setup. Pure. */
export function normalizeSetup({ label, units, unitFiles, mounts, projects, networks, pools, instances, roles, nodeJson }) {
	const forms = labelForms(label);
	const n = (text) => neutral(String(text), forms);
	const enabled = new Map(unitFiles.map((file) => [file.unit, file.state]));
	const services = uniqueMap(
		units
			.filter((unit) => /^(qorpera|lxd|snap\.lxd)/.test(unit.unit))
			.map((unit) => [n(unit.unit), { active: unit.active, enabled: enabled.get(unit.unit) ?? "unknown" }]),
		"unit",
	);
	const nfs = uniqueMap(
		mounts
			.filter((mount) => /^nfs/.test(mount.fstype))
			.map((mount) => {
				const options = mount.options
					.split(",")
					.filter((option) => /^(ro|rw|noexec|exec|nosuid|suid|nodev|vers=.*|hard|soft|sec=.*|proto=.*)$/.test(option))
					.sort();
				return [n(mount.target), { source: n(mount.source), fstype: mount.fstype, options }];
			}),
		"mount",
	);
	// `exists` keeps a project with none of the compared keys visible.
	const lxdProjects = uniqueMap(
		projects.map((project) => [
			n(project.name),
			{
				exists: true,
				...Object.fromEntries(
					Object.entries(project.config ?? {})
						.filter(([key]) => /^(features\.|restricted|limits\.)/.test(key))
						.sort(([a], [b]) => a.localeCompare(b)),
				),
			},
		]),
		"project",
	);
	const lxdNetworks = uniqueMap(
		networks.filter((network) => network.managed).map((network) => [n(network.name), { type: network.type }]),
		"network",
	);
	const lxdPools = uniqueMap(
		pools.map((pool) => [n(pool.name), { driver: pool.driver }]),
		"pool",
	);
	// Setup hosts only: runs, sign-ins and machines the database places carry their allocation markers,
	// and image build machines come and go in the build space.
	const hosts = uniqueMap(
		instances
			.filter(
				(instance) =>
					!Object.keys(instance.config ?? {}).some((key) => PLACED.test(key)) &&
					instance.config?.["user.qorpera.image_builder"] !== "true",
			)
			.map((instance) => {
				const config = instance.expanded_config ?? instance.expandedConfig ?? instance.config ?? {};
				return [
					`${n(instance.project)}/${n(instance.name)}`,
					{
						type: instance.type,
						status: instance.status,
						cpu: config["limits.cpu"] ?? null,
						memory: config["limits.memory"] ?? null,
					},
				];
			}),
		"instance",
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
	const onlyOn = value.onlyOn ?? {};
	if (
		typeof onlyOn !== "object" ||
		Array.isArray(onlyOn) ||
		Object.values(onlyOn).some((items) => !Array.isArray(items) || items.some((item) => typeof item !== "string"))
	)
		throw new Error("INVALID_PARITY_CLASS");
	return { mayDiffer: list("mayDiffer"), onlyOn };
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
 * missing on the other node and present on it. `unusedOnlyOn` lists entries of the two nodes that
 * excused nothing, so a gap that has closed is noticed and its entry removed. */
export function compareSetups(klass, a, b) {
	for (const setup of [a, b]) if (setup?.schema !== SETUP_SCHEMA) throw new Error("INVALID_NODE_SETUP");
	if (a.label === b.label) throw new Error("SAME_NODE_TWICE");
	const c = parseClass(klass);
	const left = flatten({ services: a.services, nfs: a.nfs, lxd: a.lxd, agent: a.agent }, [], new Map());
	const right = flatten({ services: b.services, nfs: b.nfs, lxd: b.lxd, agent: b.agent }, [], new Map());
	const allowed = (path) => c.mayDiffer.some((prefix) => path === prefix || path.startsWith(`${prefix} › `));
	const used = new Set();
	const only = (label, path) =>
		(c.onlyOn[label] ?? []).some((prefix) => {
			const match = path === prefix || path.startsWith(`${prefix} › `);
			if (match) used.add(JSON.stringify([label, prefix]));
			return match;
		});
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
		unusedOnlyOn: [a.label, b.label].flatMap((label) =>
			(c.onlyOn[label] ?? [])
				.filter((prefix) => !used.has(JSON.stringify([label, prefix])))
				.map((prefix) => ({ label, prefix })),
		),
	};
}

const exec = promisify(execFile);
// Every command is read-only and quick; one that hangs (a stuck NFS mount under findmnt) is stopped.
const run = (command, args, options) => exec(command, args, { ...options, timeout: 60000 });
// A JSON.parse error quotes part of its input, so it is replaced by a fixed message.
function parse(text, what) {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`INVALID_JSON: ${what}`);
	}
}
async function json(command, args) {
	return parse((await run(command, args, { maxBuffer: 64 * 1024 * 1024 })).stdout, `${command} ${args[0]}`);
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
	let roleNames = [];
	try {
		roleNames = await readdir("/opt/qorpera-node/roles");
	} catch {
		/* node without the agent */
	}
	for (const role of roleNames.sort()) roles[role] = (await readlink(`/opt/qorpera-node/roles/${role}`)).split("/").pop();
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
		const [klass, a, b] = await Promise.all(rest.map(async (file) => parse(await readFile(file, "utf8"), file)));
		const result = compareSetups(klass, a, b);
		for (const difference of result.differences)
			process.stdout.write(
				`${difference.allowed ? "allowed " : "DIFFERS "} ${difference.path}\n    ${a.label}: ${difference[a.label]}\n    ${b.label}: ${difference[b.label]}\n`,
			);
		for (const { label, prefix } of result.unusedOnlyOn)
			process.stdout.write(`note     onlyOn ${label}: "${prefix}" excuses nothing; remove it from the class.\n`);
		process.stdout.write(result.identical ? "Same setup (allowed differences only).\n" : "Setups differ.\n");
		return result.identical ? 0 : 1;
	}
	process.stderr.write("usage: qorpera-node-parity.mjs collect <node label> | compare <class.json> <a.json> <b.json>\n");
	return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// 0: same setup; 1: setups differ; 2: usage or an error. An error prints only its message, never a
	// failed command's output (an instance listing carries every instance's configuration).
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
		process.stderr.write(`qorpera-node-parity: ${message.slice(0, 300)}\n`);
		process.exitCode = 2;
	}
}
