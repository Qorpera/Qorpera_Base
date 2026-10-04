import { spawn } from "node:child_process";
import { isUuid } from "@qorpera/contracts";
import type { LxdCreateInstanceRequest } from "./lxd-client.ts";

/** The agents' bridge on every node: an agent road machine's only network card is a port of it, and its traffic
 * leaves through the node's agent exit (deploy/agent-exit). Never a platform network. */
export const AGENT_BRIDGE = "qagent0";
/** The node's plug tool, installed by deploy/agent-exit/install-agent-exit.sh. Run as the creator's own user (a
 * member of the group qorpera-agent-plug); it gives the machine its address and the MAC that carries it. */
export const AGENT_PLUG_TOOL = "/usr/local/libexec/qorpera-agent-exit/qorpera-agent-plug.py";
const LXD_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

/** What a machine is, for the exit's client map: the plug tool records it, and its reconciler checks it against the
 * machine's own LXD config (user.qorpera.company_id, machine_id, member_user_id). */
export interface AgentPlugClaim {
	readonly kind: "machine" | "coding";
	readonly companyId: string;
	readonly machineId: string;
	/** A coding machine's member; null for every other kind. */
	readonly memberUserId: string | null;
	readonly project: string;
	readonly instance: string;
}
/** Plugs a machine in and returns the MAC its card must carry. Called right before each create, after the old
 * instance (if any) is gone; never a stored address. */
export type AgentPlug = (claim: AgentPlugClaim, signal: AbortSignal) => Promise<string>;

/** The card on the agents' bridge, but its MAC (plug gives it): no address of its own in LXD (LXD 6.9 refuses
 * ipv4.address on a bridge it does not manage unless its IPv4 filter is on, and that filter drops DHCP there), MAC
 * and IPv6 filtering and port isolation. The exit's bridge rules tie the MAC to the machine's address. */
export function agentPlugCard(name: string): Readonly<Record<string, string>> {
	return Object.freeze({
		type: "nic",
		nictype: "bridged",
		parent: AGENT_BRIDGE,
		name,
		"ipv6.address": "none",
		"security.mac_filtering": "true",
		"security.ipv6_filtering": "true",
		"security.port_isolation": "true",
	});
}

/** The MAC the plug tool derives from an agent address: 0e:51 (locally administered, unicast) and the address's
 * four bytes. Machines' addresses lie in 10.210.0.0/16 outside 10.210.0.0/24, never a .0 or .255 host. */
const PLUG_MAC = /^0e:51:0a:d2:([0-9a-f]{2}):([0-9a-f]{2})$/;
export function isAgentPlugMac(value: unknown): value is string {
	const match = typeof value === "string" ? PLUG_MAC.exec(value) : null;
	if (!match) return false;
	const third = Number.parseInt(match[1], 16);
	const fourth = Number.parseInt(match[2], 16);
	return third !== 0 && fourth !== 0 && fourth !== 255;
}

/** The create request with the plug's MAC on its agent card. */
export function withAgentPlug(
	request: LxdCreateInstanceRequest,
	device: string,
	hwaddr: string,
): LxdCreateInstanceRequest {
	const template = request.devices[device];
	if (!template || template.parent !== AGENT_BRIDGE || Object.hasOwn(template, "hwaddr") || !isAgentPlugMac(hwaddr))
		throw new Error("AGENT_PLUG_INVALID");
	return { ...request, devices: { ...request.devices, [device]: { ...template, hwaddr } } };
}

/** The device is the agent card of the template, with a plug MAC and nothing else. */
export function isAgentPlugCard(device: unknown, template: Readonly<Record<string, string>>): boolean {
	if (!device || typeof device !== "object" || Array.isArray(device)) return false;
	const card = device as Record<string, unknown>;
	const keys = Object.keys(card);
	return (
		keys.length === Object.keys(template).length + 1 &&
		isAgentPlugMac(card.hwaddr) &&
		Object.entries(template).every(([key, value]) => card[key] === value)
	);
}

/** Checks the plug tool's answer: exactly an address in the machines' range and the MAC derived from it. */
export function parseAgentPlugAnswer(text: string): string {
	let answer: unknown;
	try {
		answer = JSON.parse(text);
	} catch {
		throw new Error("AGENT_PLUG_ANSWER_INVALID");
	}
	const value = answer as Record<string, unknown>;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "address,hwaddr" ||
		typeof value.address !== "string" ||
		!isAgentPlugMac(value.hwaddr)
	)
		throw new Error("AGENT_PLUG_ANSWER_INVALID");
	const octets = value.address.split(".");
	const hex = octets.slice(2).map((octet) => Number(octet).toString(16).padStart(2, "0"));
	if (
		octets.length !== 4 ||
		octets.some((octet) => !/^(0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255) ||
		octets[0] !== "10" ||
		octets[1] !== "210" ||
		value.hwaddr !== `0e:51:0a:d2:${hex.join(":")}`
	)
		throw new Error("AGENT_PLUG_ANSWER_INVALID");
	return value.hwaddr;
}

/** A plug that runs the node's plug tool: no shell, an empty environment (it reads its folders from its own
 * defaults), a bounded answer and a hard timeout. Tests point it at a stand-in tool. */
export function createAgentPlug(tool = AGENT_PLUG_TOOL, python = "/usr/bin/python3", timeoutMs = 10_000): AgentPlug {
	return (claim, signal) => plugWith(tool, python, timeoutMs, claim, signal);
}
/** The node's plug tool. */
export const runAgentPlug: AgentPlug = createAgentPlug();

function plugWith(
	tool: string,
	python: string,
	timeoutMs: number,
	claim: AgentPlugClaim,
	signal: AbortSignal,
): Promise<string> {
	if (
		(claim.kind !== "machine" && claim.kind !== "coding") ||
		!isUuid(claim.companyId) ||
		!isUuid(claim.machineId) ||
		(claim.kind === "coding") !== (claim.memberUserId !== null) ||
		(claim.memberUserId !== null && !isUuid(claim.memberUserId)) ||
		!LXD_NAME.test(claim.project) ||
		!LXD_NAME.test(claim.instance)
	)
		return Promise.reject(new Error("AGENT_PLUG_CLAIM_INVALID"));
	const args = [
		tool,
		"plug",
		"--kind",
		claim.kind,
		"--company",
		claim.companyId,
		"--machine",
		claim.machineId,
		...(claim.memberUserId === null ? [] : ["--member", claim.memberUserId]),
		"--project",
		claim.project,
		"--instance",
		claim.instance,
	];
	return new Promise<string>((resolve, reject) => {
		const child = spawn(python, args, { env: {}, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let bytes = 0;
		let done = false;
		const finish = (error: Error | null, hwaddr?: string): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve(hwaddr as string);
		};
		const kill = (reason: string): void => {
			child.kill("SIGKILL");
			finish(new Error(reason));
		};
		const abort = (): void => kill("AGENT_PLUG_ABORTED");
		const timer = setTimeout(() => kill("AGENT_PLUG_TIMEOUT"), timeoutMs);
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		for (const [stream, chunks] of [
			[child.stdout, out],
			[child.stderr, err],
		] as const)
			stream.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > 65536) return kill("AGENT_PLUG_ANSWER_INVALID");
				chunks.push(chunk);
			});
		child.on("error", () => finish(new Error("AGENT_PLUG_UNAVAILABLE")));
		child.on("close", (status) => {
			if (status !== 0) {
				// The tool's own refusal ("no free address", "already plugged in for another machine") is one line.
				const why = Buffer.concat(err).toString("utf8").trim().split("\n").at(-1)?.slice(0, 200) ?? "";
				return finish(new Error(`AGENT_PLUG_REFUSED${why ? `: ${why}` : ""}`));
			}
			try {
				finish(null, parseAgentPlugAnswer(Buffer.concat(out).toString("utf8")));
			} catch (error) {
				finish(error as Error);
			}
		});
	});
}
