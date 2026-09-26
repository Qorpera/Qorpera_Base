import assert from "node:assert/strict";
import test from "node:test";
import { foundingNativeNetworkRules, assertFoundingNativeHost } from "./founding-native-network.mjs";

const configuration = {
	table: "qorpera_founding_012345abcdef",
	bridge: "qf012345abcd",
	hostAddress: "10.77.1.1",
	guestAddress: "10.77.1.2",
	dnsPort: 15353,
	tlsPort: 15443,
	platformPorts: [15444],
};

test("network plan restricts its dedicated bridge and blocks all external IPv4/IPv6 routing", () => {
	const source = foundingNativeNetworkRules(configuration);
	assert(!source.includes("flush"));
	assert(source.includes('iifname "qf012345abcd" counter drop'));
	assert(source.includes('iifname "qf012345abcd" meta nfproto ipv6 counter drop'));
	assert(source.includes("93.184.215.14 tcp dport 443 dnat ip to 10.77.1.1:15443"));
	assert(source.includes("ip daddr 10.77.1.1 udp dport 53 dnat ip to 10.77.1.1:15353"));
	assert(!source.includes("masquerade"));
	assert(
		source.includes("ip saddr 10.77.1.2 ip daddr 10.77.1.1 ct state established,related accept"),
		"Assignment replies must return only to the isolated host",
	);
});

test("network plan refuses shared bridge, injection, public host, port aliases and insufficient physical host", () => {
	for (const change of [
		{ bridge: "lxdbr0" },
		{ table: "filter" },
		{ hostAddress: "1.2.3.4" },
		{ guestAddress: "10.78.1.2" },
		{ platformPorts: [22] },
		{ platformPorts: [15443] },
		{ tlsPort: "443; accept" },
	]) {
		assert.throws(() => foundingNativeNetworkRules({ ...configuration, ...change }));
	}
	const host = {
		platform: "linux",
		uid: 0,
		cpuCount: 6,
		memoryBytes: 12 * 1024 ** 3,
		kvm: true,
		emptyBridge: true,
	};
	assertFoundingNativeHost(host);
	for (const change of [
		{ cpuCount: 4 },
		{ memoryBytes: 8 * 1024 ** 3 },
		{ kvm: false },
		{ emptyBridge: false },
	]) {
		assert.throws(() => assertFoundingNativeHost({ ...host, ...change }));
	}
});
