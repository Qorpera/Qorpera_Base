import { isIP } from "node:net";
import type { LxdInstanceRecord, LxdInstanceStateRecord } from "./lxd-client.ts";

export function lxdMacAddress(value: unknown): string | undefined {
	return typeof value === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)
		? value.toLowerCase()
		: undefined;
}

function deviceMac(instance: LxdInstanceRecord, name: string): string | undefined {
	const device = instance.expandedDevices[name];
	if (device?.type !== "nic") return undefined;
	const values = [device.hwaddr, instance.config[`volatile.${name}.hwaddr`]].filter((value) => value !== undefined);
	if (values.length === 0) return undefined;
	const mac = lxdMacAddress(values[0]);
	if (!mac || mac === "00:00:00:00:00:00" || (Number.parseInt(mac.slice(0, 2), 16) & 1) !== 0) return undefined;
	return values.every((value) => lxdMacAddress(value) === mac) ? mac : undefined;
}

/** LXD device names and predictable guest interface names can differ; bind them by MAC, never by name alone. */
export function lxdGuestIpv4(
	instance: LxdInstanceRecord,
	state: LxdInstanceStateRecord,
	configuredDevice: string,
): string | undefined {
	const mac = deviceMac(instance, configuredDevice);
	if (!mac || state.status !== "Running") return undefined;
	if (
		Object.entries(instance.expandedDevices).some(
			([name, device]) =>
				name !== configuredDevice &&
				device.type === "nic" &&
				[device.hwaddr, instance.config[`volatile.${name}.hwaddr`]].some((value) => lxdMacAddress(value) === mac),
		)
	)
		return undefined;
	const interfaces = Object.values(state.network).filter((network) => lxdMacAddress(network.hwaddr) === mac);
	if (interfaces.length !== 1) return undefined;
	const addresses = interfaces[0].addresses.filter(
		(address) => address.family === "inet" && address.scope === "global",
	);
	if (addresses.length !== 1) return undefined;
	const address = addresses[0].address;
	const firstOctet = Number(address.split(".")[0]);
	return isIP(address) === 4 &&
		firstOctet !== 0 &&
		firstOctet !== 127 &&
		firstOctet < 224 &&
		!address.startsWith("169.254.")
		? address
		: undefined;
}
