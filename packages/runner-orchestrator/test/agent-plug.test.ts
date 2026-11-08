import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_BRIDGE,
	type AgentPlugClaim,
	agentPlugCard,
	createAgentPlug,
	isAgentPlugCard,
	isAgentPlugMac,
	PLUG_REFUSALS,
	parseAgentPlugAnswer,
	withAgentPlug,
} from "../src/agent-plug.ts";
import type { LxdCreateInstanceRequest } from "../src/lxd-client.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const claim: AgentPlugClaim = {
	kind: "coding",
	companyId: id(1),
	machineId: id(2),
	memberUserId: id(3),
	project: "coding",
	instance: "qorpera-coding-machine-0000000000004000800000000002",
};
const request: LxdCreateInstanceRequest = {
	name: "m",
	type: "virtual-machine",
	profiles: [],
	source: { type: "image", fingerprint: "b".repeat(64) },
	config: {},
	devices: { root: { type: "disk", path: "/", pool: "p" }, network: agentPlugCard("eth0") },
};

describe("the agent card", () => {
	it("is the card the node's reconciler checks, on the agents' bridge", async () => {
		// The plug tool's PLUG_NIC (deploy/agent-exit/qorpera-agent-plug.py) plus the card's own name.
		const tool = await readFile(new URL("../../../deploy/agent-exit/qorpera-agent-plug.py", import.meta.url), "utf8");
		const block = /PLUG_NIC = \{([\s\S]*?)\n\}/.exec(tool)?.[1] ?? "";
		const wanted = Object.fromEntries(
			[...block.matchAll(/"([^"]+)": ("[^"]*"|BRIDGE)/g)].map(([, key, value]) => [
				key,
				value === "BRIDGE" ? AGENT_BRIDGE : value.slice(1, -1),
			]),
		);
		expect(Object.keys(wanted).length).toBeGreaterThan(5);
		expect(agentPlugCard("eth0")).toEqual({ ...wanted, name: "eth0" });
		expect(agentPlugCard("eth0")).not.toHaveProperty("ipv4.address");
		expect(agentPlugCard("eth0")).not.toHaveProperty("security.ipv4_filtering");
	});
	it("carries only a plug MAC: an address in 10.210.0.0/16 outside its first /24, no .0 or .255 host", () => {
		for (const mac of ["0e:51:0a:d2:01:01", "0e:51:0a:d2:ff:fe", "0e:51:0a:d2:10:80"])
			expect(isAgentPlugMac(mac)).toBe(true);
		for (const mac of [
			"0e:51:0a:d2:00:05",
			"0e:51:0a:d2:01:00",
			"0e:51:0a:d2:01:ff",
			"0E:51:0A:D2:01:01",
			"00:16:3e:01:01:01",
			"0e:51:0a:d3:01:01",
			" 0e:51:0a:d2:01:01",
			7,
		])
			expect(isAgentPlugMac(mac)).toBe(false);
	});
	it("carries a MAC the plug tool gives some address, and no other MAC of the agents' /16", () => {
		// Every address of 10.210.0.0/16 through the tool's own hwaddr_for, and whether its candidates() gives it out.
		const tool = fileURLToPath(new URL("../../../deploy/agent-exit/qorpera-agent-plug.py", import.meta.url));
		const script = [
			"import importlib.util, ipaddress, json, sys",
			'spec = importlib.util.spec_from_file_location("plug", sys.argv[1])',
			"plug = importlib.util.module_from_spec(spec)",
			"spec.loader.exec_module(plug)",
			"given = set(plug.candidates())",
			'print(json.dumps([[plug.hwaddr_for(str(a)), str(a) in given] for a in ipaddress.ip_network("10.210.0.0/16")]))',
		].join("\n");
		const macs = JSON.parse(
			execFileSync("/usr/bin/python3", ["-I", "-c", script, tool], { encoding: "utf8", maxBuffer: 16 << 20 }),
		) as [string, boolean][];
		expect(macs).toHaveLength(65536);
		expect(macs.filter(([, given]) => given).length).toBe(255 * 254);
		expect(macs.filter(([mac, given]) => isAgentPlugMac(mac) !== given)).toEqual([]);
	});
	it("gets the plug's MAC only on an agent card that has none yet", () => {
		const plugged = withAgentPlug(request, "network", "0e:51:0a:d2:01:01");
		expect(plugged.devices.network).toEqual({ ...agentPlugCard("eth0"), hwaddr: "0e:51:0a:d2:01:01" });
		expect(plugged.devices.root).toBe(request.devices.root);
		expect(request.devices.network).not.toHaveProperty("hwaddr");
		expect(isAgentPlugCard(plugged.devices.network, agentPlugCard("eth0"))).toBe(true);
		expect(() => withAgentPlug(request, "network", "00:16:3e:01:01:01")).toThrow("AGENT_PLUG_INVALID");
		expect(() => withAgentPlug(request, "root", "0e:51:0a:d2:01:01")).toThrow("AGENT_PLUG_INVALID");
		expect(() => withAgentPlug(plugged, "network", "0e:51:0a:d2:01:02")).toThrow("AGENT_PLUG_INVALID");
	});
	it("is recognised only exactly: the card's keys and a plug MAC, nothing more or less", () => {
		const template = agentPlugCard("eth0");
		const card = { ...template, hwaddr: "0e:51:0a:d2:01:01" };
		expect(isAgentPlugCard(card, template)).toBe(true);
		for (const other of [
			template,
			{ ...card, hwaddr: "0e:51:0a:d2:00:01" },
			{ ...card, extra: "x" },
			{ ...card, parent: "lxdbr0" },
			{ ...card, name: "eth1" },
			null,
			[card],
		])
			expect(isAgentPlugCard(other, template)).toBe(false);
	});
});

describe("the plug tool's answer", () => {
	it("is exactly an address in the machines' range and the MAC made from it", () => {
		expect(parseAgentPlugAnswer('{"address": "10.210.1.1", "hwaddr": "0e:51:0a:d2:01:01"}')).toBe(
			"0e:51:0a:d2:01:01",
		);
		expect(parseAgentPlugAnswer('{"hwaddr":"0e:51:0a:d2:2a:fe","address":"10.210.42.254"}\n')).toBe(
			"0e:51:0a:d2:2a:fe",
		);
		for (const text of [
			'{"address": "10.210.1.2", "hwaddr": "0e:51:0a:d2:01:01"}',
			'{"address": "10.211.1.1", "hwaddr": "0e:51:0a:d2:01:01"}',
			'{"address": "10.210.0.5", "hwaddr": "0e:51:0a:d2:00:05"}',
			'{"address": "10.210.01.1", "hwaddr": "0e:51:0a:d2:01:01"}',
			'{"address": "10.210.1.1", "hwaddr": "0e:51:0a:d2:01:01", "since": "now"}',
			'{"address": "10.210.1.1"}',
			"[]",
			"not json",
		])
			expect(() => parseAgentPlugAnswer(text), text).toThrow("AGENT_PLUG_ANSWER_INVALID");
	});
});

describe("running the plug tool", () => {
	async function tool(body: string): Promise<{ path: string; root: string }> {
		const root = await mkdtemp(join(tmpdir(), "agent-plug-"));
		roots.push(root);
		const path = join(root, "plug.py");
		await writeFile(path, `import json, os, sys, time\nseen = ${JSON.stringify(join(root, "seen.json"))}\n${body}\n`);
		await chmod(path, 0o755);
		return { path, root };
	}
	it("runs it with the claim as arguments and an empty environment, and returns its MAC", async () => {
		const { path, root } = await tool(
			'json.dump({"argv": sys.argv[1:], "env": dict(os.environ), "isolated": sys.flags.isolated}, open(seen, "w"))\n' +
				'print(json.dumps({"address": "10.210.3.4", "hwaddr": "0e:51:0a:d2:03:04"}))',
		);
		const plug = createAgentPlug(path);
		expect(await plug(claim, new AbortController().signal)).toBe("0e:51:0a:d2:03:04");
		const seen = JSON.parse(await readFile(join(root, "seen.json"), "utf8"));
		expect(seen.argv).toEqual([
			"plug",
			"--kind",
			"coding",
			"--company",
			id(1),
			"--machine",
			id(2),
			"--member",
			id(3),
			"--project",
			"coding",
			"--instance",
			claim.instance,
		]);
		// Isolated (python3 -I), and Python adds nothing of ours: only what an empty environment leaves (a locale
		// variable at most).
		expect(seen.isolated).toBe(1);
		expect(Object.keys(seen.env).filter((key) => key !== "LC_CTYPE")).toEqual([]);
		const machine = { ...claim, kind: "machine" as const, memberUserId: null };
		await plug(machine, new AbortController().signal);
		expect(JSON.parse(await readFile(join(root, "seen.json"), "utf8")).argv).not.toContain("--member");
		// A Company Computer: its id is the machine, and it has no member.
		const office = { ...claim, kind: "office" as const, memberUserId: null, project: "office" };
		await plug(office, new AbortController().signal);
		expect(JSON.parse(await readFile(join(root, "seen.json"), "utf8")).argv).toEqual([
			"plug",
			"--kind",
			"office",
			"--company",
			id(1),
			"--machine",
			id(2),
			"--project",
			"office",
			"--instance",
			claim.instance,
		]);
	});
	it("refuses a claim that is not one, without running anything", async () => {
		const { path, root } = await tool('open(seen, "w").write("ran")');
		const plug = createAgentPlug(path);
		for (const bad of [
			{ ...claim, memberUserId: null },
			{ ...claim, kind: "machine" as const },
			{ ...claim, companyId: "../x" },
			{ ...claim, instance: "a_b" },
			{ ...claim, kind: "office" as const },
			{ ...claim, kind: "computer" as unknown as "coding" },
		])
			await expect(plug(bad, new AbortController().signal)).rejects.toThrow("AGENT_PLUG_CLAIM_INVALID");
		await expect(readFile(join(root, "seen.json"), "utf8")).rejects.toThrow();
	});
	it("passes the tool's own refusal on as a code, and refuses an answer that is not one", async () => {
		for (const [words, code] of [
			["no free address in the agents' range", "AGENT_PLUG_REFUSED:NO_FREE_ADDRESS"],
			[
				"coding/m is already plugged in for another machine (10.210.1.1)",
				"AGENT_PLUG_REFUSED:PLUGGED_IN_FOR_ANOTHER_MACHINE",
			],
			["coding/m's entry belongs to another creator", "AGENT_PLUG_REFUSED:ANOTHER_CREATORS_ENTRY"],
			["kind must be one of coding, machine, office", "AGENT_PLUG_REFUSED"],
		]) {
			const refusing = await tool(`sys.exit(${JSON.stringify(words)})`);
			const refused = await createAgentPlug(refusing.path)(claim, new AbortController().signal).catch(
				(error) => error,
			);
			expect(refused.message).toBe(code);
		}
		// A crash is a failure, not a refusal.
		const crashing = await tool('raise RuntimeError("no plug.lock")');
		await expect(createAgentPlug(crashing.path)(claim, new AbortController().signal)).rejects.toThrow(
			/^AGENT_PLUG_FAILED$/,
		);
		// The refusals are the tool's own words.
		const source = await readFile(
			new URL("../../../deploy/agent-exit/qorpera-agent-plug.py", import.meta.url),
			"utf8",
		);
		const raised = [...source.matchAll(/raise SystemExit\(f?"([^"]+)"\)/g)].map(([, words]) =>
			words.replace(/\{[^}]*\}/g, "x"),
		);
		for (const [words] of PLUG_REFUSALS) expect(raised.filter((text) => words.test(text))).toHaveLength(1);
		const lying = await tool('print(json.dumps({"address": "10.210.3.4", "hwaddr": "0e:51:0a:d2:03:05"}))');
		await expect(createAgentPlug(lying.path)(claim, new AbortController().signal)).rejects.toThrow(
			"AGENT_PLUG_ANSWER_INVALID",
		);
	});
	it("gives up on a tool that hangs, and on an aborted caller", async () => {
		const hanging = await tool("time.sleep(30)");
		const never = () => new AbortController().signal;
		const quick = createAgentPlug(hanging.path, "/usr/bin/python3", 300);
		await expect(quick(claim, never())).rejects.toThrow("AGENT_PLUG_TIMEOUT");
		const controller = new AbortController();
		const pending = createAgentPlug(hanging.path)(claim, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("AGENT_PLUG_ABORTED");
		const missing = createAgentPlug(join(hanging.root, "missing.py"));
		await expect(missing(claim, never())).rejects.toThrow(/^AGENT_PLUG_FAILED$/);
		const killed = await tool("os.kill(os.getpid(), 9)");
		await expect(createAgentPlug(killed.path)(claim, never())).rejects.toThrow(/^AGENT_PLUG_FAILED$/);
		const noPython = createAgentPlug(hanging.path, join(hanging.root, "no-python"));
		await expect(noPython(claim, never())).rejects.toThrow("AGENT_PLUG_UNAVAILABLE");
	});
});

describe("the coding executor's unit", () => {
	it("may plug machines in: the plug group, and write access to the client map and leases only", async () => {
		const unit = await readFile(
			new URL("../../../deploy/coding-worker/qorpera-coding-executor.service", import.meta.url),
			"utf8",
		);
		// LXD knows the executor by its own client certificate, never by the socket's group (V2-D1).
		expect(unit).toMatch(/^SupplementaryGroups=qorpera-agent-plug$/m);
		expect(unit).not.toMatch(/^SupplementaryGroups=.*\blxd\b/m);
		const writable = [...unit.matchAll(/^ReadWritePaths=(.+)$/gm)].flatMap(([, paths]) => paths.split(" "));
		expect(writable.sort()).toEqual([
			"/var/lib/qorpera-agent-exit/clients",
			"/var/lib/qorpera-agent-exit/dhcp-hosts",
		]);
	});
});
