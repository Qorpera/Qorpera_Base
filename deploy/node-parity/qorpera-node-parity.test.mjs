import assert from "node:assert/strict";
import test from "node:test";
import { CLASS_SCHEMA, compareSetups, labelForms, neutral, normalizeSetup } from "./qorpera-node-parity.mjs";

function raw(label, n, change = () => {}) {
	const observed = {
		label,
		units: [
			{ unit: "qorpera-node-provider.service", active: "active" },
			{ unit: "qorpera-node-orchestrator.service", active: "active" },
			{ unit: `qorpera-office-fleet-x-node0${n}.service`, active: "active" },
			{ unit: "snap.lxd.daemon.service", active: "active" },
			{ unit: "cron.service", active: "active" },
		],
		unitFiles: [
			{ unit: "qorpera-node-provider.service", state: "enabled" },
			{ unit: "qorpera-node-orchestrator.service", state: "enabled" },
		],
		mounts: [
			{ target: "/", source: "/dev/sda2", fstype: "ext4", options: "rw,relatime" },
			{
				target: "/srv/qorpera/canonical",
				source: "192.168.1.40:/volume1/company41-data/qorpera-cloud/objects",
				fstype: "nfs4",
				options: "rw,relatime,vers=4.1,hard,proto=tcp,sec=sys",
			},
			{
				target: `/srv/qorpera/workbench-node0${n}`,
				source: `192.168.1.40:/volume1/office-fleet-a1-node0${n}`,
				fstype: "nfs4",
				options: "rw,vers=4.1,hard",
			},
		],
		projects: [{ name: "qn25b2", config: { "features.images": "false", "user.note": "x" } }],
		networks: [
			{ name: "qorpera0", type: "bridge", managed: true },
			{ name: "enp1s0", type: "physical", managed: false },
		],
		pools: [{ name: "qorpera-vm", driver: "zfs" }],
		instances: [
			{
				project: "qn25b2",
				name: `qorpera-exec-node0${n}`,
				type: "virtual-machine",
				status: "Running",
				config: { "limits.cpu": "8", "limits.memory": "16GiB" },
			},
			{
				project: "qn25b2",
				name: `qorpera-${n}aaaa`,
				type: "virtual-machine",
				status: "Running",
				config: { "user.qorpera.acquisition_id": "x" },
			},
		],
		roles: { provider: "26", orchestrator: "26" },
		nodeJson: { roles: { provider: { fixed: { QORPERA_A: "secret-free-but-unread" }, secretKeys: ["QORPERA_TOKEN"] } } },
	};
	change(observed);
	return normalizeSetup(observed);
}
const klass = { schema: CLASS_SCHEMA, mayDiffer: [], onlyOn: {} };

test("node label spellings: the full label and its node token", () => {
	assert.deepEqual(labelForms("company41-node-02").sort(), [
		"company41-node-02",
		"node-02",
		"node-2",
		"node02",
		"node2",
	]);
	assert.equal(labelForms("company41-node-02")[0], "company41-node-02");
	assert.throws(() => labelForms("../x"), /INVALID_NODE_LABEL/);
});

test("the README's full label neutralises the short names nodes use", () => {
	const forms = labelForms("company41-node-01");
	assert.equal(
		neutral("qorpera-exec-node01 coding-node-01 /srv/office-fleet-a1-node01 company41-node-01", forms),
		"qorpera-exec-<node> coding-<node> /srv/office-fleet-a1-<node> <node>",
	);
});

test("no match inside a longer name: node1 is not node10, subnode1 is not node1", () => {
	const forms = labelForms("node1");
	assert.equal(neutral("x-node12 y-node1 subnode1 node1-a", forms), "x-node12 y-<node> subnode1 <node>-a");
});

test("two names that become one refuse the collection", () => {
	assert.throws(
		() =>
			raw("node01", 1, (o) => {
				o.units.push({ unit: "qorpera-w-node1.service", active: "active" }, { unit: "qorpera-w-node01.service", active: "active" });
			}),
		/NODE_SETUP_NAME_COLLISION: unit qorpera-w-<node>.service/,
	);
});

test("two nodes set up the same way compare equal, their own names neutralised", () => {
	const a = raw("node01", 1),
		b = raw("node02", 2);
	assert.deepEqual(Object.keys(a.lxd.hosts), ["qn25b2/qorpera-exec-<node>"]);
	assert.deepEqual(Object.keys(a.nfs), ["/srv/qorpera/canonical", "/srv/qorpera/workbench-<node>"]);
	assert.deepEqual(compareSetups(klass, a, b), { identical: true, differences: [], unusedOnlyOn: [] });
});

test("values are never read: only the names of a role's settings", () => {
	const a = raw("node01", 1);
	assert.deepEqual(a.agent.settings, { provider: { fixed: ["QORPERA_A"], secretKeys: ["QORPERA_TOKEN"] } });
	assert.equal(JSON.stringify(a).includes("secret-free-but-unread"), false);
	assert.equal(JSON.stringify(a).includes("user.note"), false);
});

test("reports a missing service, a mount option and a missing fast host", () => {
	const a = raw("node01", 1, (o) => {
		o.mounts[1].options = "rw,noexec,vers=4.1,hard";
		o.instances.shift();
	});
	const b = raw("node02", 2, (o) => {
		o.units.push({ unit: "qorpera-gateway-phql-a3.service", active: "active" });
	});
	const result = compareSetups(klass, a, b);
	assert.equal(result.identical, false);
	assert.deepEqual(
		result.differences.map((d) => d.path),
		[
			"lxd › hosts › qn25b2/qorpera-exec-<node> › cpu",
			"lxd › hosts › qn25b2/qorpera-exec-<node> › memory",
			"lxd › hosts › qn25b2/qorpera-exec-<node> › status",
			"lxd › hosts › qn25b2/qorpera-exec-<node> › type",
			"nfs › /srv/qorpera/canonical › options",
			"services › qorpera-gateway-phql-a3.service › active",
			"services › qorpera-gateway-phql-a3.service › enabled",
		],
	);
	const options = result.differences.find((d) => d.path === "nfs › /srv/qorpera/canonical › options");
	assert.deepEqual(options, {
		path: "nfs › /srv/qorpera/canonical › options",
		node01: JSON.stringify(["hard", "noexec", "rw", "vers=4.1"]),
		node02: JSON.stringify(["hard", "proto=tcp", "rw", "sec=sys", "vers=4.1"]),
		allowed: false,
	});
});

test("the class allows planned differences and node-only items", () => {
	const a = raw("node01", 1, (o) => {
		o.units.push({ unit: "qorpera-office-prod.service", active: "active" });
	});
	const b = raw("node02", 2, (o) => {
		o.roles.provider = "27";
	});
	const result = compareSetups(
		{
			schema: CLASS_SCHEMA,
			mayDiffer: ["agent › roles"],
			onlyOn: { node01: ["services › qorpera-office-prod.service"] },
		},
		a,
		b,
	);
	assert.equal(result.identical, true);
	assert.deepEqual(
		result.differences.map((d) => [d.path, d.allowed]),
		[["agent › roles › provider › release", true]],
	);
	// The same node-only item on the wrong node is a difference.
	const flipped = compareSetups({ schema: CLASS_SCHEMA, onlyOn: { node02: ["services › qorpera-office-prod.service"] } }, a, b);
	assert.equal(flipped.identical, false);
});

test("build machines are left out; sizes come from the expanded configuration", () => {
	const b = raw("node02", 2, (o) => {
		o.instances.push({
			project: "qn25b2",
			name: "qorpera-image-build-1",
			type: "virtual-machine",
			status: "Running",
			config: { "user.qorpera.image_builder": "true" },
		});
		o.instances[0].config = {};
		o.instances[0].expanded_config = { "limits.cpu": "8", "limits.memory": "16GiB" };
	});
	assert.deepEqual(compareSetups(klass, raw("node01", 1), b).differences, []);
});

test("an onlyOn entry that excuses nothing is listed, without changing the verdict", () => {
	const onlyOn = { schema: CLASS_SCHEMA, mayDiffer: [], onlyOn: { node01: ["lxd › projects › gone"] } };
	const result = compareSetups(onlyOn, raw("node01", 1), raw("node02", 2));
	assert.equal(result.identical, true);
	assert.deepEqual(result.unusedOnlyOn, [{ label: "node01", prefix: "lxd › projects › gone", compared: true }]);
	const a = raw("node01", 1, (o) => o.projects.push({ name: "gone", config: {} }));
	assert.deepEqual(compareSetups(onlyOn, a, raw("node02", 2)).unusedOnlyOn, []);
	const typo = { ...onlyOn, onlyOn: { "company41-node-01": ["lxd"] } };
	assert.deepEqual(compareSetups(typo, raw("node01", 1), raw("node02", 2)).unusedOnlyOn, [
		{ label: "company41-node-01", prefix: "lxd", compared: false },
	]);
});

test("refuses malformed input", () => {
	assert.throws(() => compareSetups({ schema: "x" }, raw("node01", 1), raw("node02", 2)), /INVALID_PARITY_CLASS/);
	assert.throws(() => compareSetups({ schema: CLASS_SCHEMA, onlyOn: { node01: "x" } }, raw("node01", 1), raw("node02", 2)), /INVALID_PARITY_CLASS/);
	assert.throws(() => compareSetups(klass, { schema: "x" }, raw("node02", 2)), /INVALID_NODE_SETUP/);
	assert.throws(() => compareSetups(klass, raw("node01", 1), raw("node01", 1)), /SAME_NODE_TWICE/);
});

test("a project with none of the compared keys still shows", () => {
	const a = raw("node01", 1, (o) => o.projects.push({ name: "qorpera-build", config: {} }));
	const result = compareSetups(klass, a, raw("node02", 2));
	assert.deepEqual(result.differences.map((d) => d.path), ["lxd › projects › qorpera-build › exists"]);
});

test("the command line: 0 same, 1 differ, 2 error, and an error prints no command output", async () => {
	const { mkdtemp, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { spawnSync } = await import("node:child_process");
	const dir = await mkdtemp(join(tmpdir(), "parity-"));
	const write = async (name, value) => {
		await writeFile(join(dir, name), JSON.stringify(value));
		return join(dir, name);
	};
	const tool = new URL("./qorpera-node-parity.mjs", import.meta.url).pathname;
	const [c, a, b, d] = await Promise.all([
		write("class.json", klass),
		write("a.json", raw("node01", 1)),
		write("b.json", raw("node02", 2)),
		write("d.json", raw("node02", 2, (o) => o.units.shift())),
	]);
	assert.equal(spawnSync("node", [tool, "compare", c, a, b]).status, 0);
	assert.equal(spawnSync("node", [tool, "compare", c, a, d]).status, 1);
	const bad = spawnSync("node", [tool, "compare", await write("bad.json", { schema: "x" }), a, b], { encoding: "utf8" });
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /INVALID_PARITY_CLASS/);
	assert.equal(spawnSync("node", [tool, "compare", join(dir, "missing.json"), a, b]).status, 2);
});
