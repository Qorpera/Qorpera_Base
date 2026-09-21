import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import {
	type NodeUpdateDrain,
	type NodeUpdateIntent,
	type NodeUpdateReceipt,
	parseNodeUpdateRelease,
} from "../src/runtime-node-update.ts";
import { createNodeUpdateRegistryPorts } from "../src/runtime-node-update-ports.ts";
import { type NodeUpdateRegistryConfig, RuntimeNodeUpdateRegistry } from "../src/runtime-node-update-registry.ts";

function fixture() {
	const key = generateKeyPairSync("ed25519"),
		config: NodeUpdateRegistryConfig = {
			origin: "https://project.example.test",
			publicApiKey: `sb_publishable_${"p".repeat(32)}`,
			capability: "9".repeat(64),
			capabilityRevision: 1,
			enrollment: {
				nodeId: "30000000-0000-4000-8000-000000000001",
				machineIdSha256: "a".repeat(64),
				publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
				previousRevision: 4,
				previousReleaseSha256: "b".repeat(64),
				previousArtifactSha256: "c".repeat(64),
			},
		},
		release = {
			schema: "qorpera.runtime-node-update-release/v1",
			nodeId: config.enrollment.nodeId,
			machineIdSha256: config.enrollment.machineIdSha256,
			revision: 5,
			previous: { revision: 4, releaseSha256: "b".repeat(64), artifactSha256: "c".repeat(64) },
			artifact: { bytes: 12345, sha256: "d".repeat(64) },
			runtimeBundleSha256: "e".repeat(64),
			sourceCommit: "f".repeat(40),
			acceptanceEvidenceSha256: "1".repeat(64),
		},
		envelope = {
			release,
			signature: sign(null, Buffer.from(officeCanonical(release)), key.privateKey).toString("base64"),
		},
		observation = {
			nodeId: release.nodeId,
			machineIdSha256: release.machineIdSha256,
			desiredReleaseSha256: officeDigest(release),
			activeRuntimeBundleSha256: "2".repeat(64),
			admissionReleaseSha256: null,
			admissionEvidenceSha256: null,
			policyVersion: 1,
			policySha256: "3".repeat(64),
			enabled: true,
		},
		state = {
			schema: "qorpera.node-update-state/v1",
			envelope,
			observation,
			drain: null as NodeUpdateDrain | null,
			resumedVersion: null,
			intents: [] as NodeUpdateIntent[],
			receipts: [] as { intent: NodeUpdateIntent; receipt: NodeUpdateReceipt }[],
		},
		intent: NodeUpdateIntent = {
			schema: "qorpera.runtime-node-update-intent/v1",
			releaseSha256: officeDigest(release),
			phase: "stage",
			previousReceiptSha256: null,
			observation,
		},
		receipt: NodeUpdateReceipt = {
			schema: "qorpera.runtime-node-update-receipt/v1",
			intentSha256: officeDigest(intent),
			state: "succeeded",
			evidenceSha256: "4".repeat(64),
			drain: null,
		};
	const calls: { url: string; init: RequestInit }[] = [];
	let response: unknown = state,
		status = 200,
		transportError = false,
		handler: ((url: string, body: string) => Response) | undefined;
	const transport: typeof fetch = async (url, init) => {
		calls.push({ url: String(url), init: init! });
		if (transportError) throw new Error(`Proxy leaked ${config.capability}`);
		if (handler) return handler(String(url), init!.body as string);
		return Response.json(response, { status });
	};
	return {
		config,
		state,
		intent,
		receipt,
		calls,
		registry: new RuntimeNodeUpdateRegistry(config, transport),
		transport,
		setHandler: (value: (url: string, body: string) => Response) => {
			handler = value;
		},
		setResponse: (value: unknown) => {
			response = value;
		},
		setStatus: (value: number) => {
			status = value;
		},
		fail: () => {
			transportError = true;
		},
	};
}
const signal = () => new AbortController().signal;

describe("node update scoped registry", () => {
	it("injects only enrolled node authority into the fixed HTTPS RPC", async () => {
		const f = fixture();
		expect((await f.registry.desired(signal()))?.envelope).toEqual(f.state.envelope);
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0].url).toBe(`${f.config.origin}/rest/v1/rpc/qorpera_desired_node_update`);
		expect(JSON.parse(f.calls[0].init.body as string)).toEqual({
			p_node_id: f.config.enrollment.nodeId,
			p_capability_revision: 1,
			p_capability: f.config.capability,
		});
		expect(f.calls[0].init).toMatchObject({
			redirect: "error",
			credentials: "omit",
			method: "POST",
			headers: { apikey: f.config.publicApiKey, "content-type": "application/json" },
		});
		expect(f.calls[0].init.headers).not.toHaveProperty("authorization");
		f.setResponse(null);
		expect(await f.registry.desired(signal())).toBeNull();
	});
	it.each([
		"http://project.example.test",
		"https://user:password@project.example.test",
		"https://project.example.test/",
		"https://project.example.test?q=1",
	])("refuses unpinned origin %s", (origin) => {
		const f = fixture();
		expect(() => new RuntimeNodeUpdateRegistry({ ...f.config, origin })).toThrow("ORIGIN_INVALID");
	});
	it("refuses privileged keys and accepts only a legacy anon role", async () => {
		const f = fixture(),
			jwt = (role: string) => `e30.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.c2ln`;
		for (const publicApiKey of ["sb_secret_abc", jwt("service_role"), jwt("authenticated"), "not-a-key"])
			expect(() => new RuntimeNodeUpdateRegistry({ ...f.config, publicApiKey })).toThrow(
				"PUBLIC_PROJECT_KEY_REQUIRED",
			);
		await new RuntimeNodeUpdateRegistry({ ...f.config, publicApiKey: jwt("anon") }, f.transport).desired(signal());
		expect(f.calls[0].init.headers).toMatchObject({ authorization: `Bearer ${jwt("anon")}` });
	});
	it("checks the independent signer and exact requested target", async () => {
		const f = fixture();
		await expect(f.registry.read("0".repeat(64), signal())).rejects.toThrow("TARGET_DIFFERS");
		f.state.envelope.release.sourceCommit = "0".repeat(40);
		await expect(f.registry.desired(signal())).rejects.toThrow("SIGNATURE_INVALID");
	});
	it("rejects foreign observations and unknown state keys", async () => {
		const f = fixture();
		f.setResponse({
			...f.state,
			observation: { ...f.state.observation, nodeId: "30000000-0000-4000-8000-000000000002" },
		});
		await expect(f.registry.desired(signal())).rejects.toThrow("OBSERVATION_DIFFERS");
		f.setResponse({ ...f.state, credential: "unexpected" });
		await expect(f.registry.desired(signal())).rejects.toThrow();
	});
	it("validates immutable phase evidence and predecessor chain on reads", async () => {
		const f = fixture();
		f.state.receipts.push({ intent: f.intent, receipt: f.receipt });
		f.state.intents.push(f.intent);
		expect((await f.registry.desired(signal()))?.receipts).toEqual(f.state.receipts);
		f.receipt.intentSha256 = "0".repeat(64);
		await expect(f.registry.desired(signal())).rejects.toThrow("RECEIPT_INVALID");
	});
	it("publishes the exact canonical receipt without a physical action or retry", async () => {
		const f = fixture();
		f.setResponse({ phase: "stage", receiptSha256: officeDigest(f.receipt) });
		await f.registry.record(f.intent, f.receipt, signal());
		expect(JSON.parse(f.calls[0].init.body as string)).toMatchObject({
			p_intent_text: officeCanonical(f.intent),
			p_receipt_text: officeCanonical(f.receipt),
		});
		f.fail();
		await expect(f.registry.record(f.intent, f.receipt, signal())).rejects.toThrow("REQUEST_UNCONFIRMED");
		expect(f.calls).toHaveLength(2);
	});
	it("retains the exact pre-effect intent separately from physical execution", async () => {
		const f = fixture();
		f.setResponse({ phase: "stage", intentSha256: officeDigest(f.intent) });
		await f.registry.prepare(f.intent, signal());
		expect(f.calls[0].url).toBe(`${f.config.origin}/rest/v1/rpc/qorpera_prepare_node_update_phase`);
		f.state.intents.push(f.intent);
		f.setResponse(f.state);
		expect((await f.registry.read(f.intent.releaseSha256, signal())).intents).toEqual([f.intent]);
		expect(f.calls).toHaveLength(2);
	});
	it("redacts echoed credentials on all HTTP failures", async () => {
		const f = fixture();
		f.setResponse({ message: f.config.capability });
		f.setStatus(403);
		await expect(f.registry.desired(signal())).rejects.toThrow(/^NODE_UPDATE_REGISTRY_REQUEST_UNCONFIRMED$/);
		expect(f.calls).toHaveLength(1);
	});
	it("bounds decoded response size", async () => {
		const f = fixture();
		f.setResponse("x".repeat(1024 * 1024));
		await expect(f.registry.desired(signal())).rejects.toThrow("REQUEST_UNCONFIRMED");
	});
	it("fences overlapping requests and honors cancellation before dispatch", async () => {
		const f = fixture();
		let finish: ((value: Response) => void) | undefined;
		const client = new RuntimeNodeUpdateRegistry(
			f.config,
			async () =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		const pending = client.desired(signal());
		await expect(client.desired(signal())).rejects.toThrow("REQUEST_PENDING");
		finish!(Response.json(null));
		expect(await pending).toBeNull();
		await expect(f.registry.desired(AbortSignal.abort())).rejects.toThrow();
		expect(f.calls).toHaveLength(0);
	});
});

describe("registry-connected node update ports", () => {
	it.each(["prepare", "publish"] as const)(
		"uses a read to settle the lost %s HTTP reply without a second write",
		async (boundary) => {
			const f = fixture();
			if (boundary === "publish") f.state.intents.push(f.intent);
			const ports = createNodeUpdateRegistryPorts(f.registry, {
				verifyAdmission: async () => {},
				execute: async () => {
					throw new Error("unexpected physical execution");
				},
				inspect: async () => null,
			});
			f.setHandler((url, body) => {
				if (url.endsWith("qorpera_read_node_update")) return Response.json(f.state);
				const args: Record<string, string> = JSON.parse(body);
				if (url.endsWith("qorpera_prepare_node_update_phase"))
					f.state.intents.push(JSON.parse(args.p_intent_text) as NodeUpdateIntent);
				else
					f.state.receipts.push({
						intent: JSON.parse(args.p_intent_text) as NodeUpdateIntent,
						receipt: JSON.parse(args.p_receipt_text) as NodeUpdateReceipt,
					});
				throw new Error("lost committed HTTP reply");
			});
			const invoke = () =>
				boundary === "prepare" ? ports.prepare(f.intent, signal()) : ports.publish(f.intent, f.receipt, signal());
			await expect(invoke()).rejects.toThrow("REQUEST_UNCONFIRMED");
			await invoke();
			expect(f.calls.map((call) => call.url.split("/").at(-1))).toEqual([
				"qorpera_read_node_update",
				boundary === "prepare" ? "qorpera_prepare_node_update_phase" : "qorpera_record_node_update_phase",
				"qorpera_read_node_update",
			]);
		},
	);
	it("reconstructs a lost SQL drain reply from retained authority without a second drain", async () => {
		const f = fixture(),
			intent: NodeUpdateIntent = {
				...structuredClone(f.intent),
				phase: "drain",
				previousReceiptSha256: officeDigest(f.receipt),
			},
			held: NodeUpdateDrain = {
				policySha256: intent.observation.policySha256,
				disabledPolicySha256: "8".repeat(64),
				previousVersion: 1,
				disabledVersion: 2,
				previousEnabled: true,
			};
		f.state.intents.push(structuredClone(f.intent), intent);
		f.state.receipts.push({ intent: structuredClone(f.intent), receipt: f.receipt });
		f.setHandler((url) => {
			if (url.endsWith("qorpera_read_node_update")) return Response.json(f.state);
			if (!url.endsWith("qorpera_drain_node_update")) throw new Error("unexpected RPC");
			f.state.drain = held;
			f.state.observation.policyVersion = 2;
			f.state.observation.policySha256 = held.disabledPolicySha256;
			f.state.observation.enabled = false;
			throw new Error("lost drain reply");
		});
		const ports = createNodeUpdateRegistryPorts(f.registry, {
				verifyAdmission: async () => {},
				execute: async () => {
					throw new Error("unexpected physical execution");
				},
				inspect: async () => null,
			}),
			release = parseNodeUpdateRelease(f.state.envelope.release);
		await expect(ports.execute(release, intent, null, signal())).rejects.toThrow("REQUEST_UNCONFIRMED");
		expect(await ports.inspect(release, intent, signal())).toMatchObject({
			intentSha256: officeDigest(intent),
			state: "succeeded",
			drain: held,
		});
		expect(f.calls.filter((call) => call.url.endsWith("qorpera_drain_node_update"))).toHaveLength(1);
	});
	it("requires retained preparation before any physical dispatch", async () => {
		const f = fixture();
		let executions = 0;
		const ports = createNodeUpdateRegistryPorts(f.registry, {
				verifyAdmission: async () => {},
				execute: async () => {
					executions++;
					return f.receipt;
				},
				inspect: async () => null,
			}),
			release = parseNodeUpdateRelease(f.state.envelope.release);
		await expect(ports.execute(release, f.intent, null, signal())).rejects.toThrow("RETAINED_INTENT_DIFFERS");
		expect(executions).toBe(0);
		f.state.intents.push(f.intent);
		expect(await ports.execute(release, f.intent, null, signal())).toEqual(f.receipt);
		expect(executions).toBe(1);
	});
});
