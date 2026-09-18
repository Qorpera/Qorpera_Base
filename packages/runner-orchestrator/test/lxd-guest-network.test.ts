import { describe, expect, it } from "vitest";
import type { LxdInstanceRecord, LxdInstanceStateRecord } from "../src/lxd-client.ts";
import { lxdGuestIpv4 } from "../src/lxd-guest-network.ts";

const mac = "00:16:3e:b9:c4:8c";
function instance(): LxdInstanceRecord {
	return {
		name: "guest",
		type: "virtual-machine",
		status: "Running",
		statusCode: 103,
		config: { "volatile.eth0.hwaddr": mac },
		profiles: [],
		devices: {},
		expandedConfig: {},
		expandedDevices: { eth0: { type: "nic", name: "eth0" } },
	};
}
function state(): LxdInstanceStateRecord {
	return {
		status: "Running",
		statusCode: 103,
		network: {
			enp5s0: { hwaddr: mac, addresses: [{ family: "inet", address: "10.41.0.3", scope: "global" }] },
			eth0: { hwaddr: "00:16:3e:01:02:03", addresses: [{ family: "inet", address: "10.42.0.99", scope: "global" }] },
		},
	};
}

describe("LXD guest interface identity", () => {
	it("resolves configured eth0 to enp5s0 by MAC, ignoring a same-named decoy", () => {
		expect(lxdGuestIpv4(instance(), state(), "eth0")).toBe("10.41.0.3");
	});
	it("accepts an explicit NIC MAC and agrees with case-normalized volatile evidence", () => {
		const vm = instance();
		vm.expandedDevices = { eth0: { type: "nic", hwaddr: mac.toUpperCase() } };
		expect(lxdGuestIpv4(vm, state(), "eth0")).toBe("10.41.0.3");
		vm.config = {};
		expect(lxdGuestIpv4(vm, state(), "eth0")).toBe("10.41.0.3");
	});
	it.each([undefined, "", "bad", "00:00:00:00:00:00", "01:16:3e:b9:c4:8c"])(
		"refuses missing or invalid configured MAC %s",
		(value) => {
			const vm = instance();
			vm.config = value === undefined ? {} : { "volatile.eth0.hwaddr": value };
			expect(lxdGuestIpv4(vm, state(), "eth0")).toBeUndefined();
		},
	);
	it("refuses absent/non-NIC devices and conflicting explicit/volatile identities", () => {
		const devices: Readonly<Record<string, string>>[] = [
			{ type: "disk" },
			{ type: "nic", hwaddr: "00:16:3e:01:02:03" },
		];
		for (const device of devices) {
			const vm = instance();
			vm.expandedDevices = { eth0: device };
			expect(lxdGuestIpv4(vm, state(), "eth0")).toBeUndefined();
		}
		expect(lxdGuestIpv4(instance(), state(), "missing")).toBeUndefined();
	});
	it("refuses duplicated MAC identity on either side of the mapping", () => {
		const vm = instance();
		vm.expandedDevices = { ...vm.expandedDevices, other: { type: "nic", hwaddr: mac } };
		expect(lxdGuestIpv4(vm, state(), "eth0")).toBeUndefined();
		const actual = state();
		actual.network = { ...actual.network, other: actual.network.enp5s0 };
		expect(lxdGuestIpv4(instance(), actual, "eth0")).toBeUndefined();
	});
	it("refuses another NIC claiming the selected MAC even when its own evidence conflicts", () => {
		const vm = instance();
		vm.expandedDevices = { ...vm.expandedDevices, other: { type: "nic", hwaddr: mac } };
		vm.config = { ...vm.config, "volatile.other.hwaddr": "00:16:3e:01:02:03" };
		expect(lxdGuestIpv4(vm, state(), "eth0")).toBeUndefined();
		vm.expandedDevices = { ...vm.expandedDevices, other: { type: "nic", hwaddr: "00:16:3e:01:02:03" } };
		vm.config = { ...vm.config, "volatile.other.hwaddr": mac };
		expect(lxdGuestIpv4(vm, state(), "eth0")).toBeUndefined();
	});
	it.each([undefined, "invalid", "00:16:3e:99:99:99"])(
		"never falls back to an interface name without matching guest MAC %s",
		(hwaddr) => {
			const actual = state();
			actual.network = { eth0: { ...actual.network.enp5s0, hwaddr } };
			expect(lxdGuestIpv4(instance(), actual, "eth0")).toBeUndefined();
		},
	);
	it.each(["invalid", "127.0.0.1", "0.0.0.0", "169.254.1.2", "224.0.0.1", "255.255.255.255"])(
		"refuses invalid/global-unusable addresses %s",
		(address) => {
			const actual = state();
			actual.network = { enp5s0: { hwaddr: mac, addresses: [{ family: "inet", scope: "global", address }] } };
			expect(lxdGuestIpv4(instance(), actual, "eth0")).toBeUndefined();
		},
	);
	it("requires exactly one global IPv4 on the matching NIC", () => {
		for (const addresses of [
			[],
			[{ family: "inet", scope: "link", address: "10.41.0.3" }],
			[
				{ family: "inet", scope: "global", address: "10.41.0.3" },
				{ family: "inet", scope: "global", address: "10.41.0.4" },
			],
		]) {
			const actual = state();
			actual.network = { enp5s0: { hwaddr: mac, addresses } };
			expect(lxdGuestIpv4(instance(), actual, "eth0")).toBeUndefined();
		}
	});
});
