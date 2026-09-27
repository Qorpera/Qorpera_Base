import { describe, expect, it } from "vitest";
import { officeInstallHash } from "../src/lxd-office-installation.ts";
import {
	deriveNodeUpdateLauncher,
	dispatchNodeUpdateForUnchangedInvocation,
	nodeUpdateHealthSocket,
	parseNodeUpdateHostEnrollment,
} from "../src/runtime-node-update-host.ts";

function host(overrides: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.node-update-host/v1",
		machineIdSha256: "a".repeat(64),
		journalRoot: "/var/lib/qorpera-node-updater/provider",
		lockPath: "/var/lib/qorpera-node-updater/provider/update.lock",
		artifactBaseUrl: "https://updates.example.test/artifacts/",
		service: "qorpera-lxd-provider.service",
		unitPath: "/etc/systemd/system/qorpera-lxd-provider.service",
		unitSha256: "b".repeat(64),
		dropIns: [],
		launcher: null,
		runtimePath: "/usr/bin/node",
		runtimeSha256: "c".repeat(64),
		installedPath: "/opt/qorpera/runner-provider/qorpera-lxd-provider.mjs",
		installedMode: 0o755,
		serviceUser: "qorpera-provider",
		serviceGroup: "qorpera-provider",
		serviceUid: 1001,
		configuration: [{ path: "/etc/qorpera/lxd-provider.env", sha256: "d".repeat(64) }],
		healthUrls: ["http://127.0.0.1:18081/healthz", "http://127.0.0.1:18082/healthz"],
		lxdSocket: "/var/snap/lxd/common/lxd/unix.socket",
		lxdProject: "qorpera-runners",
		...overrides,
	};
}
describe("fixed host update enrollment", () => {
	it("accepts the existing provider's exact single-binary service layout", () => {
		expect(parseNodeUpdateHostEnrollment(host())).toEqual(host());
	});
	it.each([
		{ installedPath: "/etc/sudoers" },
		{ installedPath: "/opt/qorpera/runner-provider/../../bin/evil.mjs" },
		{ unitPath: "/etc/systemd/system/other.service" },
		{ service: "qorpera-provider.service;reboot" },
		{ runtimePath: "/usr/bin/bash" },
		{ lockPath: "/tmp/update.lock" },
		{ journalRoot: "/tmp/journal" },
		{ serviceUid: 0 },
		{ installedMode: 0o777 },
		{ command: "curl | sh" },
		{ artifactBaseUrl: "http://updates.example.test/artifacts/" },
		{ artifactBaseUrl: "https://user:secret@updates.example.test/artifacts/" },
		{ healthUrls: ["https://external.example.test/healthz"] },
		{ healthUrls: ["http://127.0.0.1:80/admin"] },
		{ configuration: [{ path: "/tmp/config", sha256: "d".repeat(64) }] },
	])("refuses unreviewed executable or authority fields %#", (override) => {
		expect(() => parseNodeUpdateHostEnrollment(host(override))).toThrow();
	});
});

const baselineDigest = "a".repeat(64),
	nextDigest = "b".repeat(64);
function launcherTemplate(digest = baselineDigest) {
	return Buffer.from(
		`# retained comment\n need(hashlib.sha256(read(BUNDLE,0o444,1024*1024)).hexdigest()=='${digest}')\n os.execve(node,args,env)\n`,
	);
}
describe("retained native launcher digest", () => {
	it("preserves every other byte and derives multiple revisions from the enrolled original", () => {
		const template = launcherTemplate(),
			digest = officeInstallHash(template);
		expect(deriveNodeUpdateLauncher(template, digest, baselineDigest, nextDigest)).toEqual(
			launcherTemplate(nextDigest),
		);
		expect(deriveNodeUpdateLauncher(template, digest, baselineDigest, "c".repeat(64))).toEqual(
			launcherTemplate("c".repeat(64)),
		);
	});
	it("rejects template drift against the enrolled hash", () => {
		expect(() =>
			deriveNodeUpdateLauncher(
				Buffer.concat([launcherTemplate(), Buffer.from("# drift")]),
				officeInstallHash(launcherTemplate()),
				baselineDigest,
				nextDigest,
			),
		).toThrow("TEMPLATE_CHANGED");
	});
	it.each([
		Buffer.concat([launcherTemplate(), Buffer.from(baselineDigest)]),
		Buffer.from(`unchecked='${baselineDigest}'`),
		Buffer.from(launcherTemplate().toString().replace("0o444", "0o644")),
		Buffer.from(launcherTemplate().toString().replace("need(", "ignored_need(")),
	])("refuses ambiguous or changed digest checks %#", (template) => {
		expect(() => deriveNodeUpdateLauncher(template, officeInstallHash(template), baselineDigest, nextDigest)).toThrow(
			"DIGEST_NOT_UNIQUE",
		);
	});
	it("accepts only the exact deployed launcher and pinned local drop-in directory", () => {
		const native = host({
			installedPath: "/opt/qorpera-native25-phql-a1/qorpera-lxd-provider-v52-a1.mjs",
			installedMode: 0o444,
			launcher: {
				path: "/opt/qorpera-native25-phql-a1/provider-launch-node02-v52.py",
				templatePath: "/etc/qorpera/node-updater/launcher-template.py",
				sha256: "e".repeat(64),
				artifactSha256: baselineDigest,
			},
			dropIns: [
				{ path: "/etc/systemd/system/qorpera-lxd-provider.service.d/10-native.conf", sha256: "f".repeat(64) },
			],
			configuration: [
				{ path: "/etc/qorpera-native25-phql-a1/provider-env-node02-v43.json", sha256: "d".repeat(64) },
			],
		});
		expect(parseNodeUpdateHostEnrollment(native)).toEqual(native);
		expect(() => parseNodeUpdateHostEnrollment({ ...native, launcher: null })).toThrow();
		expect(() =>
			parseNodeUpdateHostEnrollment({
				...native,
				dropIns: [{ path: "/etc/systemd/system/service.d/10-all.conf", sha256: "f".repeat(64) }],
			}),
		).toThrow();
		expect(() =>
			parseNodeUpdateHostEnrollment({ ...native, dropIns: [...native.dropIns, ...native.dropIns] }),
		).toThrow();
	});
});
describe("last invocation fence", () => {
	it("refuses a restart during asynchronous authority or drain checks before dispatch", async () => {
		let dispatched = false;
		await expect(
			dispatchNodeUpdateForUnchangedInvocation(
				{ invocation: "before" },
				async () => ({ invocation: "after" }),
				async () => {
					dispatched = true;
				},
			),
		).rejects.toThrow("INVOCATION_CHANGED");
		expect(dispatched).toBe(false);
	});
	it("dispatches immediately after the final matching observation", async () => {
		const events: string[] = [];
		await dispatchNodeUpdateForUnchangedInvocation(
			{ invocation: "same" },
			async () => {
				events.push("observe");
				return { invocation: "same" };
			},
			async () => {
				events.push("dispatch");
			},
		);
		expect(events).toEqual(["observe", "dispatch"]);
	});
});

describe("provider-owned loopback health", () => {
	const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n";
	const tcp = `${header} 0: 0100007F:4812 00000000:0000 0A 00000000:00000000 00:00000000 00000000 992 0 6441550 1\n`;
	it("binds the exact port to a listening inode held by MainPID", () => {
		expect(nodeUpdateHealthSocket(tcp, ["socket:[6441550]"], 18450)).toBe("6441550");
	});
	it.each([
		[tcp, ["socket:[99]"], 18450],
		[tcp, ["socket:[6441550]"], 18451],
		[tcp.replace("0100007F", "00000000"), ["socket:[6441550]"], 18450],
		[tcp.replace(" 0A ", " 01 "), ["socket:[6441550]"], 18450],
		[tcp + tcp.split("\n")[1], ["socket:[6441550]"], 18450],
	] as const)("refuses unrelated, wildcard, connected or ambiguous sockets %#", (table, descriptors, port) => {
		expect(() => nodeUpdateHealthSocket(table, descriptors, port)).toThrow("LISTENER_NOT_OWNED");
	});
});
