import assert from "node:assert/strict";
import test from "node:test";
import { CLASS_SCHEMA, compareSetups, labelForms, normalizeSetup } from "./qorpera-node-parity.mjs";

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

test("node label spellings", () => {
	assert.deepEqual(labelForms("company41-node-02").sort(), ["company41-node-02", "company41-node-2", "company41-node02", "company41-node2"]);
	// Longest first, so a longer spelling is never half-replaced by a shorter one.
	assert.equal(labelForms("company41-node-02")[0].length, "company41-node-02".length);
	assert.deepEqual(labelForms("node02").sort(), ["node-02", "node-2", "node02", "node2"]);
	assert.throws(() => labelForms("../x"), /INVALID_NODE_LABEL/);
});

test("two nodes set up the same way compare equal, their own names neutralised", () => {
	const a = raw("node01", 1),
		b = raw("node02", 2);
	assert.deepEqual(Object.keys(a.lxd.hosts), ["qn25b2/qorpera-exec-<node>"]);
	assert.deepEqual(Object.keys(a.nfs), ["/srv/qorpera/canonical", "/srv/qorpera/workbench-<node>"]);
	assert.deepEqual(compareSetups(klass, a, b), { identical: true, differences: [] });
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

test("refuses malformed input", () => {
	assert.throws(() => compareSetups({ schema: "x" }, raw("node01", 1), raw("node02", 2)), /INVALID_PARITY_CLASS/);
	assert.throws(() => compareSetups(klass, { schema: "x" }, raw("node02", 2)), /INVALID_NODE_SETUP/);
});
