import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";
import { LxdOfficePhysicalGate } from "../src/lxd-office-physical-gate.ts";
import * as host from "../src/lxd-office-physical-host.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

vi.mock("../src/lxd-office-physical-host.ts", () => ({
	readLxdOfficeProtectedFile: vi.fn(),
	inspectLxdOfficePhysicalHost: vi.fn(),
}));
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});
const observation = () => ({
	bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	namespace: "mnt:[100]",
	socket: { dev: 1, ino: 2, uid: 0, gid: 1001, mode: 0o140660, nlink: 1 },
	journal: { dev: 2, ino: 3, uid: 1000, gid: 1000, mode: 0o40700, nlink: 2 },
	workbench: { dev: 3, ino: 4, uid: 1000, gid: 1000, mode: 0o40700, nlink: 2 },
});
async function fixture() {
	const f = officePhysicalFixture();
	vi.mocked(host.readLxdOfficeProtectedFile).mockImplementation(async (path) =>
		Buffer.from(JSON.stringify(path === "/etc/office-policy.json" ? f.policy : f.envelope)),
	);
	const inspectHost = vi.mocked(host.inspectLxdOfficePhysicalHost).mockImplementation(async () => observation());
	const server = vi.spyOn(LxdUnixClient.prototype, "inspectOfficeServer").mockResolvedValue({
		project: f.policy.guest.project,
		certificateSha256: f.policy.host.certificateSha256,
		serverName: f.policy.host.serverName,
		serverVersion: f.policy.host.serverVersion,
		architecture: f.policy.host.architecture,
	});
	const image = vi.spyOn(LxdUnixClient.prototype, "inspectOfficeImage").mockResolvedValue({
		fingerprint: f.policy.guest.imageFingerprint,
		architecture: f.policy.host.architecture,
		size: f.policy.image.bytes,
	});
	const mutation = vi
		.spyOn(LxdUnixClient.prototype, "submitInstanceOperation")
		.mockRejectedValue(new Error("unexpected mutation"));
	const infrastructure = vi
		.spyOn(LxdUnixClient.prototype, "inspectOfficeInfrastructure")
		.mockResolvedValue(f.infrastructure);
	const gate = await LxdOfficePhysicalGate.open(
		"/etc/office-policy.json",
		"/etc/office-evidence.json",
		new AbortController().signal,
	);
	return { ...f, gate, inspectHost, server, image, mutation, infrastructure };
}
describe("physical preparation gate composition", () => {
	it.each(["project", "network", "storagePool"] as const)(
		"rejects changed %s configuration behind an unchanged resource name",
		async (section) => {
			const f = await fixture();
			const actual = officePhysicalFixture().infrastructure;
			actual[section].config.changed = "different";
			f.infrastructure.mockResolvedValue(actual);
			await expect(f.gate.check(f.binding, new AbortController().signal)).rejects.toThrow(
				"LXD_OFFICE_INFRASTRUCTURE_POLICY_MISMATCH",
			);
			expect(f.mutation).not.toHaveBeenCalled();
		},
	);
	it("compares two physical observations around exact daemon/image reads and returns only expiring preparation evidence", async () => {
		const f = await fixture();
		const result = await f.gate.check(f.binding, new AbortController().signal);
		expect(result.hostBootId).toBe(observation().bootId);
		expect(result.validForMs).toBeGreaterThan(0);
		expect(result.validForMs).toBeLessThanOrEqual(5000);
		expect(result.signal.aborted).toBe(false);
		expect(f.inspectHost).toHaveBeenCalledTimes(2);
		expect(f.server).toHaveBeenCalledWith("offices", expect.any(AbortSignal));
		expect(f.image).toHaveBeenCalledWith("offices", f.policy.guest.imageFingerprint, expect.any(AbortSignal));
		expect(f.mutation).not.toHaveBeenCalled();
	});
	it("denies mismatched enrollment before filesystem or LXD inspection", async () => {
		const f = await fixture();
		await expect(f.gate.check({ ...f.binding, cpus: 4 }, new AbortController().signal)).rejects.toThrow(
			"LXD_OFFICE_PHYSICAL_BINDING_MISMATCH",
		);
		expect(f.inspectHost).not.toHaveBeenCalled();
		expect(f.server).not.toHaveBeenCalled();
	});
	it.each(["certificateSha256", "serverName", "serverVersion", "architecture", "project"])(
		"rejects daemon drift in %s",
		async (field) => {
			const f = await fixture();
			f.server.mockResolvedValue({
				project: "offices",
				certificateSha256: f.policy.host.certificateSha256,
				serverName: f.policy.host.serverName,
				serverVersion: f.policy.host.serverVersion,
				architecture: f.policy.host.architecture,
				[field]: "different",
			});
			await expect(f.gate.check(f.binding, new AbortController().signal)).rejects.toThrow(
				"LXD_OFFICE_DAEMON_POLICY_MISMATCH",
			);
			expect(f.image).not.toHaveBeenCalled();
			expect(f.mutation).not.toHaveBeenCalled();
		},
	);
	it.each(["fingerprint", "architecture", "size"])("rejects local VM image drift in %s", async (field) => {
		const f = await fixture();
		f.image.mockResolvedValue({
			fingerprint: f.policy.guest.imageFingerprint,
			architecture: f.policy.host.architecture,
			size: f.policy.image.bytes,
			[field]: "different",
		});
		await expect(f.gate.check(f.binding, new AbortController().signal)).rejects.toThrow(
			"LXD_OFFICE_LOCAL_IMAGE_MISMATCH",
		);
		expect(f.inspectHost).toHaveBeenCalledTimes(1);
		expect(f.mutation).not.toHaveBeenCalled();
	});
	it.each(["bootId", "namespace", "socket", "journal", "workbench"])(
		"rejects a changed host %s between observations",
		async (field) => {
			const f = await fixture();
			f.inspectHost
				.mockResolvedValueOnce(observation())
				.mockResolvedValueOnce({ ...observation(), [field]: "changed" });
			await expect(f.gate.check(f.binding, new AbortController().signal)).rejects.toThrow(
				"LXD_OFFICE_PHYSICAL_HOST_CHANGED",
			);
		},
	);
	it("retains an aborted filesystem probe process-wide until actual settlement, including across replacement gate objects", async () => {
		const f = await fixture();
		let resolveHost!: (value: ReturnType<typeof observation>) => void;
		f.inspectHost.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveHost = resolve;
				}),
		);
		const stop = new AbortController();
		const result = f.gate.check(f.binding, stop.signal);
		await vi.waitFor(() => expect(f.inspectHost).toHaveBeenCalledTimes(1));
		stop.abort();
		await expect(result).rejects.toThrow("LXD_OFFICE_PHYSICAL_INSPECTION_ABORTED");
		await expect(f.gate.check(f.binding, new AbortController().signal)).rejects.toThrow(
			"LXD_OFFICE_PHYSICAL_INSPECTION_PENDING",
		);
		await expect(
			LxdOfficePhysicalGate.open("/etc/policy", "/etc/evidence", new AbortController().signal),
		).rejects.toThrow("LXD_OFFICE_PHYSICAL_INSPECTION_PENDING");
		expect(f.inspectHost).toHaveBeenCalledTimes(1);
		resolveHost(observation());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(f.server).not.toHaveBeenCalled();
		await expect(f.gate.check(f.binding, new AbortController().signal)).resolves.toHaveProperty("hostBootId");
	});
	it("expires an ignored deadline while retaining the pending probe", async () => {
		const f = await fixture();
		let resolveHost!: (value: ReturnType<typeof observation>) => void;
		f.inspectHost.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveHost = resolve;
				}),
		);
		try {
			await expect(f.gate.check(f.binding, new AbortController().signal)).rejects.toThrow(
				"LXD_OFFICE_PHYSICAL_INSPECTION_ABORTED",
			);
			await expect(f.gate.check(f.binding, new AbortController().signal)).rejects.toThrow(
				"LXD_OFFICE_PHYSICAL_INSPECTION_PENDING",
			);
		} finally {
			resolveHost(observation());
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(f.server).not.toHaveBeenCalled();
	}, 10000);
	it("rejects unprotected or unsigned configuration without contacting the daemon", async () => {
		const f = await fixture();
		vi.mocked(host.readLxdOfficeProtectedFile).mockRejectedValueOnce(new Error("unprotected file"));
		await expect(
			LxdOfficePhysicalGate.open("/etc/policy", "/etc/evidence", new AbortController().signal),
		).rejects.toThrow();
		f.envelope.signature.value = "a".repeat(88);
		await expect(
			LxdOfficePhysicalGate.open("/etc/office-policy.json", "/etc/evidence", new AbortController().signal),
		).rejects.toThrow("LXD_OFFICE_IMAGE_PROVENANCE_UNCONFIRMED");
		expect(f.server).not.toHaveBeenCalled();
	});
});
