import { describe, expect, it, vi } from "vitest";
import type { LxdInstanceRecord } from "../src/lxd-client.ts";
import {
	assertLxdOfficeGuestInstance,
	inspectLxdOfficeGuestBoot,
	type LxdOfficeGuestBinding,
	lxdOfficeGuestPlan,
} from "../src/lxd-office-guest.ts";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
function binding(): LxdOfficeGuestBinding {
	return {
		schema: "qorpera.lxd-office-guest/v2",
		providerId: id(7),
		providerPolicySha256: "f".repeat(64),
		companyId: id(1),
		environmentId: id(2),
		companyComputerId: id(3),
		logicalComputerId: id(4),
		computerGeneration: 1,
		allocationId: id(5),
		project: "qorpera-offices",
		imageFingerprint: "a".repeat(64),
		bootstrapSha256: "b".repeat(64),
		storagePool: "office-vms",
		rootDiskBytes: 64 * 1024 ** 3,
		workbenchSource: "/mnt/nas/company-office",
		network: "office-net",
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
	};
}
function fixture() {
	const config = binding();
	const plan = lxdOfficeGuestPlan(config);
	const instance: LxdInstanceRecord = {
		name: plan.request.name,
		type: "virtual-machine",
		profiles: [],
		status: "Running",
		statusCode: 103,
		config: { ...plan.request.config, "volatile.base_image": config.imageFingerprint, "image.os": "Ubuntu" },
		expandedConfig: { ...plan.request.config, "volatile.base_image": config.imageFingerprint },
		devices: structuredClone(plan.request.devices),
		expandedDevices: structuredClone(plan.request.devices),
	};
	const file = { content: Buffer.from(`${id(6)}\n`), uid: 0, gid: 0, mode: 0o444 };
	const client = {
		getInstance: vi.fn(async () => structuredClone(instance)),
		readInstanceFile: vi.fn(async () => ({ ...file })),
	};
	return {
		config,
		plan,
		instance,
		file,
		client,
		inspect: () => inspectLxdOfficeGuestBoot(client, config, new AbortController().signal),
	};
}
describe("separate persistent office VM plan and boot observation", () => {
	it("plans one VM with no runner identity, inherited profile or canonical tree", () => {
		const input = binding();
		const plan = lxdOfficeGuestPlan(input);
		expect(plan.request.type).toBe("virtual-machine");
		expect(plan.request.profiles).toEqual([]);
		expect(Object.keys(plan.request.devices).sort()).toEqual(["network", "root", "workbench"]);
		expect(plan.request.devices.workbench.path).toBe("/var/lib/qorpera-office");
		expect(plan.request.source).toEqual({ type: "image", fingerprint: input.imageFingerprint });
		expect(plan.request.config["boot.autostart"]).toBe("false");
		expect(JSON.stringify(plan.request)).not.toMatch(/compute.identity|company-live|provider.*credential|cloud-init/);
		input.companyId = id(30);
		expect(plan.binding.companyId).toBe(id(1));
		expect(lxdOfficeGuestPlan(input).instanceSha256).not.toBe(plan.instanceSha256);
		expect(lxdOfficeGuestPlan({ ...binding(), computerGeneration: 2 }).instanceSha256).not.toBe(plan.instanceSha256);
		expect(lxdOfficeGuestPlan({ ...binding(), providerId: id(8) }).instanceSha256).not.toBe(plan.instanceSha256);
		expect(lxdOfficeGuestPlan({ ...binding(), providerPolicySha256: "e".repeat(64) }).instanceSha256).not.toBe(
			plan.instanceSha256,
		);
	});
	it.each([
		["computeIdentityId", id(8)],
		["profiles", ["native-runner"]],
		["schema", "old"],
		["schema", "qorpera.lxd-office-guest/v1"],
		["providerId", "invalid"],
		["providerPolicySha256", "mutable"],
		["companyId", "invalid"],
		["cpus", 0],
		["cpus", 65],
		["memoryBytes", Infinity],
		["computerGeneration", 1.5],
		["workbenchSource", "/qorpera/company-live"],
		["workbenchSource", "/mnt/identity/company"],
		["workbenchSource", "/mnt/../nas"],
		["imageFingerprint", "mutable-image-alias"],
	])("rejects invalid provider binding %s", (key, value) => {
		expect(() => lxdOfficeGuestPlan({ ...binding(), [key]: value })).toThrow("INVALID_LXD_OFFICE_BINDING");
	});
	it("checks actual expanded devices and current boot twice without creating or activating anything", async () => {
		const f = fixture();
		await expect(f.inspect()).resolves.toEqual({ bootId: id(6), instanceSha256: f.plan.instanceSha256 });
		expect(f.client.getInstance).toHaveBeenCalledTimes(2);
		expect(f.client.readInstanceFile).toHaveBeenCalledTimes(2);
		expect(f.client.readInstanceFile).toHaveBeenLastCalledWith(
			"qorpera-offices",
			f.plan.request.name,
			"/proc/sys/kernel/random/boot_id",
			64,
			expect.any(AbortSignal),
		);
	});
	it.each(["extra disk", "profile", "raw qemu", "cloud init", "image", "metadata", "local config"])(
		"rejects %s drift before reading guest data",
		async (drift) => {
			const f = fixture();
			if (drift === "extra disk")
				f.instance.expandedDevices = {
					...f.instance.expandedDevices,
					extra: { type: "disk", source: "/secret", path: "/secret" },
				};
			if (drift === "profile") f.instance.profiles = ["native-runner"];
			if (drift === "raw qemu") f.instance.expandedConfig = { ...f.instance.expandedConfig, "raw.qemu": "unsafe" };
			if (drift === "cloud init") f.instance.config = { ...f.instance.config, "cloud-init.user-data": "unsafe" };
			if (drift === "image")
				f.instance.expandedConfig = { ...f.instance.expandedConfig, "volatile.base_image": "c".repeat(64) };
			if (drift === "metadata")
				f.instance.expandedConfig = { ...f.instance.expandedConfig, "user.qorpera.computer_generation": "2" };
			if (drift === "local config") f.instance.config = { ...f.instance.config, "limits.memory": "unlimited" };
			expect(() => assertLxdOfficeGuestInstance(f.config, f.instance)).toThrow("LXD_OFFICE_GUEST_DRIFTED");
			await expect(f.inspect()).rejects.toThrow("LXD_OFFICE_BOOT_UNCONFIRMED");
			expect(f.client.readInstanceFile).not.toHaveBeenCalled();
		},
	);
	it.each(["owner", "mode", "utf8", "uuid", "whitespace", "reboot", "stopped", "late drift"])(
		"does not confirm boot after %s",
		async (failure) => {
			const f = fixture();
			if (failure === "owner") f.file.uid = 1000;
			if (failure === "mode") f.file.mode = 0o644;
			if (failure === "utf8") f.file.content = Buffer.from([0xff]);
			if (failure === "uuid") f.file.content = Buffer.from("invalid");
			if (failure === "whitespace") f.file.content = Buffer.from(`${id(6)}\n\n`);
			if (failure === "reboot")
				f.client.readInstanceFile
					.mockResolvedValueOnce(f.file)
					.mockResolvedValue({ ...f.file, content: Buffer.from(id(7)) });
			if (failure === "stopped") f.instance.status = "Stopped";
			if (failure === "late drift")
				f.client.getInstance
					.mockResolvedValueOnce(f.instance)
					.mockResolvedValue({ ...f.instance, expandedDevices: {} });
			await expect(f.inspect()).rejects.toThrow("LXD_OFFICE_BOOT_UNCONFIRMED");
		},
	);
	it("stops before any inspection on cancelled admission", async () => {
		const f = fixture();
		const stop = new AbortController();
		stop.abort();
		await expect(inspectLxdOfficeGuestBoot(f.client, f.config, stop.signal)).rejects.toThrow(
			"LXD_OFFICE_BOOT_UNCONFIRMED",
		);
		expect(f.client.getInstance).not.toHaveBeenCalled();
	});
});
