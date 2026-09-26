import assert from "node:assert/strict";
import { isIPv4 } from "node:net";
import { FOUNDING_MODEL_ADDRESS } from "./founding-native-model.mjs";

/** Isolated-host nft input, never a production firewall installer. The caller
 * must create a NEW private LXD bridge with DHCP/DNS advertising hostAddress,
 * install this table atomically BEFORE any guest starts, and destroy its guests
 * BEFORE removing the table. The table owns only packets from this bridge and
 * does not flush or alter other tables. A failed setup must not start a guest.
 *
 * All routed traffic is dropped. The synthetic public model address is DNATed
 * to local TLS; DNS goes only to the local authoritative fixture. Host access is
 * restricted to the explicit isolated platform ports and DHCP. */
export function foundingNativeNetworkRules({
	table,
	bridge,
	hostAddress,
	guestAddress,
	dnsPort,
	tlsPort,
	platformPorts,
}) {
	assert(/^qorpera_founding_[0-9a-f]{12}$/.test(table));
	assert(/^qf[0-9a-f]{10}$/.test(bridge));
	for (const address of [hostAddress, guestAddress]) assert(isIPv4(address) && address.startsWith("10."));
	assert.notEqual(hostAddress, guestAddress);
	assert.deepEqual(hostAddress.split(".").slice(0, 3), guestAddress.split(".").slice(0, 3));
	assert(Array.isArray(platformPorts) && platformPorts.length >= 1 && platformPorts.length <= 6);
	const ports = [dnsPort, tlsPort, ...platformPorts];
	assert(ports.every((port) => Number.isSafeInteger(port) && port >= 1024 && port <= 65535));
	assert.equal(new Set(ports).size, ports.length);
	const tcp = [tlsPort, ...platformPorts].sort((a, b) => a - b).join(", ");
	return `table inet ${table} {
 chain route_fixture {
  type nat hook prerouting priority dstnat; policy accept;
  iifname "${bridge}" ip saddr ${guestAddress} ip daddr ${FOUNDING_MODEL_ADDRESS} tcp dport 443 dnat ip to ${hostAddress}:${tlsPort}
  iifname "${bridge}" ip saddr ${guestAddress} ip daddr ${hostAddress} udp dport 53 dnat ip to ${hostAddress}:${dnsPort}
 }
 chain deny_external {
  type filter hook forward priority -300; policy accept;
  iifname "${bridge}" counter drop
 }
 chain local_services {
  type filter hook input priority -300; policy accept;
  iifname "${bridge}" meta nfproto ipv6 counter drop
  iifname "${bridge}" ip saddr ${guestAddress} ip daddr ${hostAddress} ct state established,related accept
  iifname "${bridge}" udp sport 68 udp dport 67 accept
  iifname "${bridge}" ip saddr ${guestAddress} ip daddr ${hostAddress} udp dport ${dnsPort} accept
  iifname "${bridge}" ip saddr ${guestAddress} ip daddr ${hostAddress} tcp dport { ${tcp} } accept
  iifname "${bridge}" counter drop
 }
}
`;
}

/** Required pre-start host check, independent from guest image/admission. */
export function assertFoundingNativeHost({ platform, uid, cpuCount, memoryBytes, kvm, emptyBridge }) {
	assert.equal(platform, "linux");
	assert.equal(uid, 0, "Firewall/image preparation needs the isolated host root process");
	assert(
		Number.isSafeInteger(cpuCount) && cpuCount >= 6,
		"Standard computer plus isolated platform needs at least 6 host CPUs",
	);
	assert(
		Number.isSafeInteger(memoryBytes) && memoryBytes >= 12 * 1024 ** 3,
		"Standard computer plus isolated platform needs at least 12 GiB host RAM",
	);
	assert.equal(kvm, true, "Actual KVM required");
	assert.equal(emptyBridge, true, "Dedicated new bridge must have no attached guests");
}
