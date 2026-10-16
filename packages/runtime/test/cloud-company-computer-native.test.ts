import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type {
	CompanyComputerEffectContext,
	CompanyComputerOperation,
	CompanyComputerToolContent,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { JsonValue } from "@qorpera/contracts";
import { CompanyComputerGuestEndpoint } from "@qorpera/runtime/cloud-company-computer-endpoint";
import { CompanyComputerScreenActionGate } from "@qorpera/runtime/cloud-company-computer-leases";
import {
	COMPANY_COMPUTER_NATIVE_SCHEMA,
	type CompanyComputerAccountFills,
	type CompanyComputerHookFills,
	createHttpCompanyComputerSessionFactory,
	HttpCompanyComputerNativeEndpoint,
	parseCompanyComputerNativeDescriptor,
	parseCompanyComputerNativeRoute,
	parseCompanyComputerNativeUrl,
} from "@qorpera/runtime/cloud-company-computer-native-client";
import {
	CompanyComputerGuestSessionRefusedError,
	CompanyComputerNativeGateway,
	startCompanyComputerNativeGateway,
} from "@qorpera/runtime/cloud-company-computer-native-gateway";
import { HttpCloudCompanyComputerRegistry } from "@qorpera/runtime/cloud-company-computer-registry-http";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudToolAuthorizeRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
	cloudNativeToolOperationEnvelope,
} from "@qorpera/runtime/cloud-native-tool-operations";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerDeferred,
	computerLease,
	computerOperation,
	computerScope,
} from "./fixtures/company-computer.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

let directory: string;
let cert: Buffer;
let key: Buffer;
let originalCAs: string[];
const cleanups: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "qorpera-native-office-tls-"));
	const generated = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(directory, "key.pem"),
			"-out",
			join(directory, "cert.pem"),
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ timeout: 15000, encoding: "utf8" },
	);
	if (generated.status !== 0) throw new Error("Disposable TLS certificate creation failed");
	cert = await readFile(join(directory, "cert.pem"));
	key = await readFile(join(directory, "key.pem"));
	originalCAs = getCACertificates("default");
	setDefaultCACertificates([...originalCAs, cert]);
});
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
afterAll(async () => {
	setDefaultCACertificates(originalCAs);
	await rm(directory, { recursive: true, force: true });
});

async function fixture(
	options: {
		unavailable?: boolean;
		admitWork?: () => void;
		capabilities?: ("shell" | "browser")[];
		accountFills?: CompanyComputerAccountFills;
		hookFills?: CompanyComputerHookFills;
		/** The database refuses a screenshot at its authorize with these words (folder-v2, C1c-3l part 3). */
		refuseScreenshots?: string;
		/** The guest's screenshots published without storage (folder-v2, P06d), by receipt. */
		screenshots?: Map<string, Uint8Array>;
		/** The capture the database reads back for the run. */
		capture?: () => unknown;
		/** The boxes the guest's vault_captures sealed (E3c-3), by receipt. */
		hookBoxes?: Map<string, Readonly<Record<string, string>>>;
	} = {},
) {
	const source = nativeToolAuthorityFixture();
	const scope = {
		...computerScope(),
		companyId: source.authority.identity.companyId,
		environmentId: source.authority.identity.environmentId,
	};
	const lease = {
		...computerLease(),
		binding: { ...computerBinding(), ...scope, staffAgentId: source.authority.identity.staffAgentId },
		driver: {
			kind: "agent" as const,
			runId: source.binding.runId,
			staffAgentId: source.authority.identity.staffAgentId,
		},
	};
	const descriptor = {
		state: "available" as const,
		scope,
		capabilities: options.capabilities ?? ["shell" as const],
		resources: {
			officeGrantId: randomUUID(),
			officeGrantVersion: 1,
			officePrivacyVersion: 0,
			// A browser computer also names its browser grant.
			...(options.capabilities?.includes("browser")
				? { browserGrantId: randomUUID(), browserGrantVersion: 1, browserProfileId: randomUUID() }
				: {}),
		},
	};
	const operation: CompanyComputerOperation = {
		...computerOperation(),
		tool: "computer_shell",
		arguments: { kind: "shell", command: "printf test", timeoutMs: 1000 },
		target: { realm: "company_computer", binding: lease.binding, resources: descriptor.resources },
	};
	const order: string[] = [];
	// G2-6c: the database's lease proof stands in here (its own test is 986): only the run's own lease token, as
	// `job.<the binding's job>.<lease token>`, proves its binding. Each proof notes how many other calls came before it.
	const leaseToken = randomBytes(32).toString("base64url");
	const holder = `job.${source.binding.jobId.toLowerCase()}.${leaseToken}`;
	const proofs: { holder: unknown; binding: unknown; at: number }[] = [];
	const consumed = new Map<string, string>();
	let revoked = false;
	let released = false;
	let expectedDrainFailure = false;
	const sql = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const method = String(input).split("/").at(-1);
		const body = JSON.parse(String(init?.body));
		if (method === "qorpera_native_binding_proven") {
			proofs.push({ holder: body.p_holder, binding: body.p_binding, at: order.length });
			return body.p_holder === `job.${String(body.p_binding?.jobId).toLowerCase()}.${leaseToken}` &&
				body.p_binding?.jobId === source.binding.jobId
				? Response.json(true)
				: Response.json({ code: "42501", message: "native binding proof is refused" }, { status: 403 });
		}
		order.push(`${method}:${body.p_action ?? "read"}`);
		if (method === "qorpera_describe_native_tool_authority") return Response.json(revoked ? {} : source.authority);
		if (method === "qorpera_native_office_descriptor")
			return Response.json(options.unavailable ? { state: "unavailable" } : descriptor);
		if (method === "qorpera_native_office_start_descriptor") return Response.json({ state: "unavailable" });
		if (method === "qorpera_read_native_office_capture") return Response.json(options.capture?.());
		if (method === "qorpera_native_office_screen" && body.p_action === "release") {
			released = true;
			return Response.json({ state: "released" });
		}
		if (method === "qorpera_native_office_screen") return Response.json({ state: "admitted", lease });
		if (method === "qorpera_native_office_operation") {
			if (body.p_action === "finish") return Response.json({ state: "drained" });
			if (released || revoked) return new Response("private SQL diagnostic", { status: 403 });
			if (body.p_action === "authorize")
				return Response.json(
					options.refuseScreenshots && JSON.parse(body.p_envelope).operation.tool === "computer_screenshot"
						? { state: "refused", message: options.refuseScreenshots }
						: { state: "authorized" },
				);
			if (body.p_action === "begin") {
				if (consumed.has(body.p_receipt_id)) return new Response("already consumed", { status: 403 });
				consumed.set(body.p_receipt_id, randomUUID());
			}
			return Response.json({
				state: "admitted",
				resourceLeaseId: consumed.get(body.p_receipt_id),
				validForMs: 30000,
			});
		}
		throw new Error(`Unexpected RPC ${method}`);
	});
	const registry = new HttpCloudCompanyComputerRegistry({
		supabaseUrl: "https://registry.qorpera.test",
		serviceRoleKey: "synthetic-service-key",
		fetch: sql,
	});
	const run = await CloudNativeToolRun.open(
		source.binding,
		{ describeToolAuthority: async () => (revoked ? {} : source.authority) },
		new AbortController().signal,
	);
	cleanups.push(async () => run.close());
	const perform = vi.fn(
		async (
			_action: unknown,
			_lease: unknown,
			_context: CompanyComputerEffectContext,
		): Promise<CompanyComputerToolContent> => {
			order.push("guest:perform");
			return { kind: "text" as const, value: "test" };
		},
	);
	const physicalClose = vi.fn(async () => {
		order.push("guest:close");
	});
	const stopBrowser = vi.fn(async () => {
		order.push("guest:stop-browser");
	});
	const gate = new CompanyComputerScreenActionGate();
	/** Whether the guest itself ended each session it handed out, in order. */
	const guests: { ended: boolean }[] = [];
	const createSession = vi.fn(
		async ({
			run: bound,
			descriptor: admitted,
			lease: screen,
			effects,
		}: Parameters<ConstructorParameters<typeof CompanyComputerNativeGateway>[0]["createSession"]>[0]) => {
			expect(bound.identity).toEqual(run.identity);
			const guest = { ended: false };
			guests.push(guest);
			return {
				endpoint: new CompanyComputerGuestEndpoint({
					binding: screen.binding,
					capabilities: admitted.capabilities,
					resourceTarget: admitted.resources,
					effects,
					gate,
					automation: { perform, stopBrowser },
					assertScreenAdmitted: async () => undefined,
					prepareScreen: async () => undefined,
				}),
				close: physicalClose,
				ended: () => guest.ended,
				...(options.screenshots
					? {
							screenshot: (receiptId: string) => {
								const bytes = options.screenshots?.get(receiptId);
								options.screenshots?.delete(receiptId);
								return bytes;
							},
						}
					: {}),
				...(options.hookBoxes
					? {
							capture: (receiptId: string) => {
								const box = options.hookBoxes?.get(receiptId);
								options.hookBoxes?.delete(receiptId);
								return box;
							},
						}
					: {}),
			};
		},
	);
	const token = randomBytes(32).toString("base64url");
	const gateway = new CompanyComputerNativeGateway({
		scope,
		computerGeneration: 1,
		token,
		registry,
		createSession,
		admitWork: options.admitWork,
	});
	const listener = await startCompanyComputerNativeGateway({
		host: "127.0.0.1",
		port: 0,
		tls: { cert, key },
		gateway,
	});
	cleanups.push(async () => {
		if (expectedDrainFailure) await expect(listener.close()).rejects.toThrow("OFFICE_NATIVE_DRAIN_UNCONFIRMED");
		else await listener.close();
	});
	const url = `https://127.0.0.1:${listener.port}/office/${scope.companyComputerId}/native`;
	const endpoint = new HttpCompanyComputerNativeEndpoint({
		run,
		descriptor,
		url,
		token,
		holder: () => holder,
		registry,
		...(options.accountFills ? { accountFills: options.accountFills } : {}),
		...(options.hookFills ? { hookFills: options.hookFills } : {}),
	});
	const context = {
		identity: run.identity,
		receiptId: randomUUID(),
		idempotencyKey: "a".repeat(64),
		signal: run.signal,
	};
	const body = () => ({
		schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
		nativeBinding: source.binding,
		action: "perform",
		operation,
		lease,
		receipt: { receiptId: context.receiptId, idempotencyKey: context.idempotencyKey },
	});
	// `identity: null` sends no holder; by default a post carries the run's own.
	const post = (
		value: unknown,
		options: { token?: string; origin?: string; suffix?: string; identity?: string | null } = {},
	) =>
		fetch(url + (options.suffix ?? ""), {
			method: "POST",
			headers: {
				authorization: `Bearer ${options.token ?? token}`,
				"content-type": "application/json",
				...(options.origin ? { origin: options.origin } : {}),
				...(options.identity === null ? {} : { "x-qorpera-identity": options.identity ?? holder }),
			},
			body: JSON.stringify(value),
		});
	return {
		source,
		scope,
		lease,
		descriptor,
		operation,
		order,
		sql,
		registry,
		run,
		perform,
		physicalClose,
		stopBrowser,
		createSession,
		guests,
		endpoint,
		context,
		body,
		post,
		url,
		token,
		leaseToken,
		holder,
		proofs,
		revoke: () => {
			revoked = true;
		},
		expectDrainFailure: () => {
			expectedDrainFailure = true;
		},
	};
}

describe("native runtime to office transport (real TLS, synthetic SQL and guest effects)", () => {
	it("connects shell through the service factory, native ledger and TLS guest boundary", async () => {
		const f = await fixture();
		const control: CloudNativeToolOperationControlPlane = {
			beginToolOperation: vi.fn(async (binding, input) => ({
				run_id: binding.runId,
				receipt_id: input.receiptId,
				state: "executing",
				result: null,
				output_snapshot_id: null,
				proposal_id: null,
			})),
			completeToolOperation: vi.fn(async (binding, input) => {
				f.order.push("native:complete");
				return { run_id: binding.runId, receipt_id: input.receiptId, state: "completed", result: input.result };
			}),
		};
		const operations = new CloudNativeToolOperations(f.run, control);
		const factory = createHttpCompanyComputerSessionFactory({
			url: f.url,
			token: f.token,
			holder: () => f.holder,
			registry: f.registry,
		});
		const session = await factory(f.run, operations);
		if (!session) throw new Error("Missing admitted office session");
		cleanups.push(session.close);
		expect(session.tools.map((tool) => tool.name)).toEqual([
			"computer_screen",
			"computer_shell",
			"computer_transfer",
		]);
		const tool = session.tools.find((tool) => tool.name === "computer_shell")!;
		const context = { companyId: f.run.identity.companyId, runId: f.run.identity.runId, signal: f.run.signal };
		const action = f.operation.arguments;
		const args = { operationKey: "native-office:1", action };
		expect(await tool.execute(args, context)).toEqual({ kind: "text", value: "test" });
		expect(await tool.execute(args, context)).toEqual({ kind: "text", value: "test" });
		expect(f.perform).toHaveBeenCalledOnce();
		expect(f.perform.mock.calls[0][0]).toEqual(action);
		expect(control.beginToolOperation).toHaveBeenCalledOnce();
		expect(control.completeToolOperation).toHaveBeenCalledOnce();
		expect(f.order.indexOf("qorpera_native_office_operation:finish")).toBeLessThan(
			f.order.indexOf("native:complete"),
		);
		f.run.close();
		await session.close();
		expect(f.physicalClose).toHaveBeenCalledOnce();
	});
	// Company objects carried a transfer's bytes and are gone (legacy removal, step C): the tool's answer is a refusal.
	const transfers: { [key: string]: JsonValue }[] = [
		{
			kind: "transfer",
			action: "export",
			source: { realm: "company_computer", path: "reports/$(literal).bin" },
			destination: { realm: "object_storage" },
			mediaType: "application/octet-stream",
		},
		{
			kind: "transfer",
			action: "import",
			source: { realm: "object_storage", assetId: "6f1d2c3b-4a59-4e8f-9b7a-1c2d3e4f5a6b", sha256: "a".repeat(64) },
			destination: { realm: "company_computer", path: "inbox/report.bin" },
		},
	];
	it.each(transfers)("refuses a file transfer ($action) before the database and any receipt", async (action) => {
		const f = await fixture();
		const control = { beginToolOperation: vi.fn(), completeToolOperation: vi.fn() };
		const factory = createHttpCompanyComputerSessionFactory({
			url: f.url,
			token: f.token,
			holder: () => f.holder,
			registry: f.registry,
		});
		const session = await factory(f.run, new CloudNativeToolOperations(f.run, control));
		if (!session) throw new Error("Missing admitted office session");
		cleanups.push(session.close);
		const tool = session.tools.find((tool) => tool.name === "computer_transfer")!;
		const refused = tool.execute(
			{ operationKey: "native-office:transfer", action },
			{ companyId: f.run.identity.companyId, runId: f.run.identity.runId, signal: f.run.signal },
		);
		await expect(refused).rejects.toBeInstanceOf(CloudToolAuthorizeRefusal);
		await expect(refused).rejects.toThrow("File transfer is not available on this computer yet.");
		expect(control.beginToolOperation).not.toHaveBeenCalled();
		expect(f.createSession).not.toHaveBeenCalled();
		expect(f.perform).not.toHaveBeenCalled();
		expect(f.order).not.toContain("qorpera_native_office_operation:authorize");
		expect(f.order).not.toContain("qorpera_native_office_operation:begin");
	});
	it("tells the model why the database refused a screenshot at its authorize, before any receipt or office work", async () => {
		const message =
			"Screenshots are not available on this computer yet. For a web page, use a browser snapshot instead.";
		const f = await fixture({ capabilities: ["shell", "browser"], refuseScreenshots: message });
		const control = { beginToolOperation: vi.fn(), completeToolOperation: vi.fn() };
		const factory = createHttpCompanyComputerSessionFactory({
			url: f.url,
			token: f.token,
			holder: () => f.holder,
			registry: f.registry,
		});
		const session = await factory(f.run, new CloudNativeToolOperations(f.run, control));
		if (!session) throw new Error("Missing admitted office session");
		cleanups.push(session.close);
		const tool = session.tools.find((tool) => tool.name === "computer_screenshot")!;
		const refused = tool.execute(
			{ operationKey: "native-office:shot", action: { kind: "screenshot", surface: "browser" } },
			{ companyId: f.run.identity.companyId, runId: f.run.identity.runId, signal: f.run.signal },
		);
		await expect(refused).rejects.toBeInstanceOf(CloudToolAuthorizeRefusal);
		await expect(refused).rejects.toThrow(message);
		expect(control.beginToolOperation).not.toHaveBeenCalled();
		expect(f.createSession).not.toHaveBeenCalled();
		expect(f.perform).not.toHaveBeenCalled();
		expect(f.order).not.toContain("qorpera_native_office_operation:begin");
	});
	it("carries a screenshot stored nowhere from the office to the model in its perform answer, past the JSON bound", async () => {
		// A 1 x 1 page capture's PNG header, padded well past the 48 KiB answer bound (only the header is read).
		const png = Buffer.alloc(256 * 1024, 7);
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=",
			"base64",
		).copy(png);
		const screenshots = new Map<string, Uint8Array>();
		let asset: Record<string, unknown> | undefined;
		const f = await fixture({ capabilities: ["shell", "browser"], screenshots, capture: () => asset });
		f.perform.mockImplementation(async (_action, lease, context) => {
			f.order.push("guest:perform");
			// The guest's publisher: nothing stored, the receipt names the capture, the pixels wait for the answer.
			asset = {
				assetId: context.receiptId,
				sha256: createHash("sha256").update(png).digest("hex"),
				bytes: png.length,
				mediaType: "image/png",
				screenId: (lease as typeof f.lease).binding.screenId,
				surface: "browser",
				width: 1,
				height: 1,
			};
			screenshots.set(context.receiptId, Uint8Array.from(png));
			return { kind: "json", value: asset as never };
		});
		const control: CloudNativeToolOperationControlPlane = {
			beginToolOperation: vi.fn(async (binding, input) => ({
				run_id: binding.runId,
				receipt_id: input.receiptId,
				state: "executing",
				result: null,
				output_snapshot_id: null,
				proposal_id: null,
			})),
			completeToolOperation: vi.fn(async (binding, input) => ({
				run_id: binding.runId,
				receipt_id: input.receiptId,
				state: "completed",
				result: input.result,
			})),
		};
		const factory = createHttpCompanyComputerSessionFactory({
			url: f.url,
			token: f.token,
			holder: () => f.holder,
			registry: f.registry,
		});
		const session = await factory(f.run, new CloudNativeToolOperations(f.run, control));
		if (!session?.captures) throw new Error("Missing admitted office session with captures");
		cleanups.push(session.close);
		const tool = session.tools.find((tool) => tool.name === "computer_screenshot")!;
		const content = await tool.execute(
			{ operationKey: "native-office:shot", action: { kind: "screenshot", surface: "browser" } },
			{ companyId: f.run.identity.companyId, runId: f.run.identity.runId, signal: f.run.signal },
		);
		// The model's text is the capture's identity; the receipt keeps only that.
		expect(content).toEqual({ kind: "json", value: asset });
		expect(JSON.stringify(vi.mocked(control.completeToolOperation).mock.calls[0][1].result)).not.toContain(
			png.toString("base64").slice(0, 64),
		);
		expect(screenshots.size).toBe(0);
		await expect(session.captures.issue("call-1", "envelope", content, f.run.signal)).resolves.toBe(
			`data:image/png;base64,${png.toString("base64")}`,
		);
		expect(f.order.filter((step) => step.startsWith("qorpera_read_native_office_capture"))).toHaveLength(2);
	});
	it("takes pixels only in a screenshot's answer, and only exactly the published capture's under its receipt", async () => {
		const f = await fixture();
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=",
			"base64",
		);
		const shot: CompanyComputerOperation = {
			...f.operation,
			tool: "computer_screenshot",
			arguments: { kind: "screenshot", surface: "browser" },
		};
		const asset = {
			assetId: f.context.receiptId,
			sha256: createHash("sha256").update(png).digest("hex"),
			bytes: png.length,
			mediaType: "image/png",
			screenId: f.lease.binding.screenId,
			surface: "browser",
			width: 1,
			height: 1,
		};
		const answer = (content: unknown, image: unknown) => ({
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			receiptId: f.context.receiptId,
			idempotencyKey: f.context.idempotencyKey,
			content,
			image,
		});
		const holdInline = vi.fn();
		const endpoint = (body: unknown) =>
			new HttpCompanyComputerNativeEndpoint({
				run: f.run,
				descriptor: f.descriptor,
				url: f.url,
				token: f.token,
				holder: () => f.holder,
				registry: f.registry,
				fetch: vi.fn(async () => Response.json(body)),
				screenshots: { holdInline },
			});
		const image = png.toString("base64");
		// Any other operation's answer carries no pixels.
		await expect(
			endpoint(answer({ kind: "text", value: "test" }, image)).perform(f.operation, f.lease, f.context),
		).rejects.toThrow("INVALID_OFFICE_NATIVE_MESSAGE");
		for (const [content, pixels] of [
			[{ kind: "json", value: { ...asset, assetId: randomUUID() } }, image],
			[{ kind: "text", value: JSON.stringify(asset) }, image],
			[{ kind: "json", value: asset }, `${image}!`],
			[{ kind: "json", value: asset }, image.slice(1)],
			[{ kind: "json", value: asset }, 7],
		] as const)
			await expect(endpoint(answer(content, pixels)).perform(shot, f.lease, f.context)).rejects.toThrow(
				"INVALID_OFFICE_NATIVE_RESULT",
			);
		expect(holdInline).not.toHaveBeenCalled();
		await expect(
			endpoint(answer({ kind: "json", value: asset }, image)).perform(shot, f.lease, f.context),
		).resolves.toEqual({ kind: "json", value: asset });
		expect(holdInline).toHaveBeenCalledWith(asset, png);
	});
	it("reaches the computer the run is placed on through a company route", async () => {
		const f = await fixture();
		const route = f.url.replace(f.scope.companyComputerId, "{companyComputerId}");
		expect(route).not.toBe(f.url);
		const control = { beginToolOperation: vi.fn(), completeToolOperation: vi.fn() };
		const factory = createHttpCompanyComputerSessionFactory({
			url: route,
			token: f.token,
			holder: () => f.holder,
			registry: f.registry,
		});
		const session = await factory(f.run, new CloudNativeToolOperations(f.run, control));
		if (!session) throw new Error("Missing admitted office session");
		cleanups.push(session.close);
		expect(session.tools.map((tool) => tool.name)).toContain("computer_screen");
		await session.close();
		// A one-computer route never reaches another computer: the run gets no computer tools.
		const other = f.url.replace(f.scope.companyComputerId, randomUUID());
		const pinned = createHttpCompanyComputerSessionFactory({
			url: other,
			token: f.token,
			holder: () => f.holder,
			registry: f.registry,
		});
		expect(await pinned(f.run, new CloudNativeToolOperations(f.run, control))).toBeUndefined();
	});
	it("omits office tools for unavailable offices and never queries office metadata for private runs", async () => {
		const f = await fixture({ unavailable: true });
		const control = { beginToolOperation: vi.fn(), completeToolOperation: vi.fn() };
		const factory = createHttpCompanyComputerSessionFactory({
			url: f.url,
			token: f.token,
			holder: () => f.holder,
			registry: f.registry,
		});
		expect(await factory(f.run, new CloudNativeToolOperations(f.run, control))).toBeUndefined();
		const source = nativeToolAuthorityFixture();
		const privateAuthority = {
			...source.authority,
			identity: {
				...source.authority.identity,
				audienceKind: "member_private" as const,
				audienceUserId: source.authority.identity.requesterUserId,
			},
		};
		const run = await CloudNativeToolRun.open(
			source.binding,
			{ describeToolAuthority: async () => privateAuthority },
			new AbortController().signal,
		);
		cleanups.push(async () => run.close());
		f.sql.mockClear();
		expect(await factory(run, new CloudNativeToolOperations(run, control))).toBeUndefined();
		expect(f.sql).not.toHaveBeenCalled();
		expect(f.createSession).not.toHaveBeenCalled();
	});
	it("does not exhaust session capacity after repeated pre-guest authority rejection", async () => {
		const f = await fixture();
		for (let index = 0; index < 65; index++) {
			const response = await f.post({
				...f.body(),
				lease: { ...f.lease, leaseId: randomUUID(), binding: { ...f.lease.binding, computerGeneration: 2 } },
			});
			expect(response.status).toBe(503);
		}
		expect(f.createSession).not.toHaveBeenCalled();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		await f.endpoint.close();
		expect(f.perform).toHaveBeenCalledOnce();
	});
	it("asks the vault for a vault_fill and carries only its sealed box to the office, beside the action", async () => {
		const box = {
			schema: "qorpera.company-account-fill-box/v1",
			ephemeralPublicKey: "e",
			iv: "i",
			tag: "t",
			ciphertext: "c",
		};
		const fills = {
			companyAccountFill: vi.fn<CompanyComputerAccountFills["companyAccountFill"]>(async () => ({
				schema: "qorpera.company-account-fill-answer/v1",
				box,
			})),
		};
		const f = await fixture({ capabilities: ["browser"], accountFills: fills });
		const operation: CompanyComputerOperation = {
			...f.operation,
			tool: "computer_browser",
			arguments: {
				kind: "browser",
				action: "vault_fill",
				role: "textbox",
				name: "Password",
				account: randomUUID(),
				field: "password",
			},
		};
		expect(await f.endpoint.perform(operation, f.lease, f.context)).toEqual({ kind: "text", value: "test" });
		// The vault reads exactly this call: the envelope whose digest the receipt holds.
		expect(fills.companyAccountFill).toHaveBeenCalledOnce();
		const [request] = fills.companyAccountFill.mock.calls[0]!;
		expect(request).toEqual({
			binding: f.source.binding,
			receiptId: f.context.receiptId,
			idempotencyKey: f.context.idempotencyKey,
			envelope: cloudNativeToolOperationEnvelope(f.run.identity, operation),
		});
		// The office gets the box beside the action; its own effect check sees the action alone.
		expect(f.perform.mock.calls[0]![2].fill).toEqual(box);
		const begin = f.sql.mock.calls
			.map(([, init]) => JSON.parse(String(init?.body)))
			.find((body) => body.p_action === "begin");
		expect(JSON.stringify(begin)).not.toContain("ciphertext");
		// Nothing else carries a box, and a vault_fill never goes without one.
		const shell = await f.post({ ...f.body(), fill: box });
		expect(shell.ok).toBe(false);
		const bare = await f.post({
			...f.body(),
			operation,
			receipt: { receiptId: randomUUID(), idempotencyKey: "b".repeat(64) },
		});
		expect(bare.ok).toBe(false);
		expect(f.perform).toHaveBeenCalledOnce();
	});

	it("answers the vault's refusal without reaching the office, and refuses a fill without a vault", async () => {
		const fills = {
			companyAccountFill: vi.fn<CompanyComputerAccountFills["companyAccountFill"]>(async () => ({
				schema: "qorpera.company-account-refusal/v1",
				code: "0A000",
				message: "This computer cannot type account values until it restarts on a newer image",
			})),
		};
		const f = await fixture({ capabilities: ["browser"], accountFills: fills });
		const operation: CompanyComputerOperation = {
			...f.operation,
			tool: "computer_browser",
			arguments: {
				kind: "browser",
				action: "vault_fill",
				role: "textbox",
				name: "Password",
				account: randomUUID(),
				field: "password",
			},
		};
		expect(await f.endpoint.perform(operation, f.lease, f.context)).toEqual({
			kind: "json",
			value: {
				action: "vault_fill",
				completed: false,
				refused: {
					code: "0A000",
					message: "This computer cannot type account values until it restarts on a newer image",
				},
			},
		});
		expect(f.perform).not.toHaveBeenCalled();
		expect(f.order).not.toContain("qorpera_native_office_operation:begin");
		// A host without the vault refuses the same way: nothing started, nothing sent to the office.
		const g = await fixture({ capabilities: ["browser"] });
		expect(await g.endpoint.perform({ ...operation, target: g.operation.target }, g.lease, g.context)).toEqual({
			kind: "json",
			value: {
				action: "vault_fill",
				completed: false,
				refused: { code: "0A000", message: "Company accounts are not set up for this company's computers" },
			},
		});
		expect(g.perform).not.toHaveBeenCalled();
	});

	it("asks the vault's hook route for a signed hook's secret, and the account route for an account's (E3b-3)", async () => {
		const box = {
			schema: "qorpera.company-account-fill-box/v1",
			ephemeralPublicKey: "e",
			iv: "i",
			tag: "t",
			ciphertext: "c",
		};
		const accountFills = {
			companyAccountFill: vi.fn<CompanyComputerAccountFills["companyAccountFill"]>(async () => ({
				schema: "qorpera.company-account-fill-answer/v1",
				box,
			})),
		};
		const hookFills = {
			eventHookFill: vi.fn<CompanyComputerHookFills["eventHookFill"]>(async () => ({
				schema: "qorpera.event-hook-fill-answer/v1",
				box,
			})),
			eventHook: vi.fn<CompanyComputerHookFills["eventHook"]>(),
			eventHookCapture: vi.fn<CompanyComputerHookFills["eventHookCapture"]>(),
		};
		const f = await fixture({ capabilities: ["browser"], accountFills, hookFills });
		const operation: CompanyComputerOperation = {
			...f.operation,
			tool: "computer_browser",
			arguments: {
				kind: "browser",
				action: "vault_fill",
				role: "textbox",
				name: "Signing secret",
				hook: randomUUID(),
				field: "signing_secret",
			},
		};
		expect(await f.endpoint.perform(operation, f.lease, f.context)).toEqual({ kind: "text", value: "test" });
		expect(hookFills.eventHookFill).toHaveBeenCalledOnce();
		expect(hookFills.eventHookFill.mock.calls[0]![0]).toEqual({
			binding: f.source.binding,
			receiptId: f.context.receiptId,
			idempotencyKey: f.context.idempotencyKey,
			envelope: cloudNativeToolOperationEnvelope(f.run.identity, operation),
		});
		expect(accountFills.companyAccountFill).not.toHaveBeenCalled();
		expect(f.perform.mock.calls[0]![2].fill).toEqual(box);
		// An account's fill on the same host still goes to the account route.
		const g = await fixture({ capabilities: ["browser"], accountFills, hookFills });
		const login: CompanyComputerOperation = {
			...g.operation,
			tool: "computer_browser",
			arguments: {
				kind: "browser",
				action: "vault_fill",
				role: "textbox",
				name: "Password",
				account: randomUUID(),
				field: "password",
			},
		};
		await g.endpoint.perform(login, g.lease, g.context);
		expect(accountFills.companyAccountFill).toHaveBeenCalledOnce();
		expect(hookFills.eventHookFill).toHaveBeenCalledOnce();
		// The vault's refusal is the call's answer, and a host without the hook route refuses before the office.
		hookFills.eventHookFill.mockResolvedValueOnce({
			schema: "qorpera.event-hook-refusal/v1",
			code: "55000",
			message: "This hook was removed",
		});
		const h = await fixture({ capabilities: ["browser"], hookFills });
		expect(await h.endpoint.perform({ ...operation, target: h.operation.target }, h.lease, h.context)).toEqual({
			kind: "json",
			value: {
				action: "vault_fill",
				completed: false,
				refused: { code: "55000", message: "This hook was removed" },
			},
		});
		expect(h.perform).not.toHaveBeenCalled();
		const bare = await fixture({ capabilities: ["browser"], accountFills });
		expect(
			await bare.endpoint.perform({ ...operation, target: bare.operation.target }, bare.lease, bare.context),
		).toEqual({
			kind: "json",
			value: {
				action: "vault_fill",
				completed: false,
				refused: { code: "0A000", message: "Signed hooks are not set up for this company's computers" },
			},
		});
		expect(bare.perform).not.toHaveBeenCalled();
		expect(accountFills.companyAccountFill).toHaveBeenCalledOnce();
		expect(hookFills.eventHook).not.toHaveBeenCalled();
		expect(hookFills.eventHookCapture).not.toHaveBeenCalled();
	});

	it("makes a Stripe hook's capture key current, then carries the office's box to the vault (E3c-2)", async () => {
		const f = await fixture({ capabilities: ["browser"] });
		const hook = randomUUID();
		const operation: CompanyComputerOperation = {
			...f.operation,
			tool: "computer_browser",
			arguments: {
				kind: "browser",
				action: "vault_capture",
				role: "button",
				name: "Reveal",
				hook,
				field: "signing_secret",
			},
		};
		const box = {
			schema: "qorpera.event-hook-capture-box/v1",
			ephemeralPublicKey: "e",
			iv: "i",
			tag: "t",
			ciphertext: "c",
		};
		const read = { kind: "json", value: { action: "vault_capture", tabId: randomUUID(), completed: true } };
		const answer = (rest: Record<string, unknown> = { content: read, box }) => ({
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			receiptId: f.context.receiptId,
			idempotencyKey: f.context.idempotencyKey,
			...rest,
		});
		const vault = () => ({
			eventHookFill: vi.fn<CompanyComputerHookFills["eventHookFill"]>(),
			eventHook: vi.fn<CompanyComputerHookFills["eventHook"]>(async () => ({
				schema: "qorpera.event-hook-rekey-answer/v1",
				hook,
				replaced: false,
			})),
			eventHookCapture: vi.fn<CompanyComputerHookFills["eventHookCapture"]>(async () => ({
				schema: "qorpera.event-hook-capture-answer/v1",
				hook,
				version: 2,
				unchanged: false,
			})),
		});
		const endpoint = (body: unknown, hookFills?: CompanyComputerHookFills) => {
			const fetch = vi.fn(async () => Response.json(body));
			return {
				fetch,
				endpoint: new HttpCompanyComputerNativeEndpoint({
					run: f.run,
					descriptor: f.descriptor,
					url: f.url,
					token: f.token,
					holder: () => f.holder,
					registry: f.registry,
					fetch,
					...(hookFills ? { hookFills } : {}),
				}),
			};
		};
		const v = vault();
		const ok = endpoint(answer(), v);
		const result = await ok.endpoint.perform(operation, f.lease, f.context);
		expect(result).toEqual({
			kind: "json",
			value: {
				action: "vault_capture",
				completed: true,
				captured: { hook, field: "signing_secret", version: 2, unchanged: false },
			},
		});
		expect(JSON.stringify(result)).not.toContain("ciphertext");
		expect(v.eventHook).toHaveBeenCalledWith(
			{ binding: f.source.binding, request: { action: "rekey", hook } },
			expect.any(AbortSignal),
		);
		expect(v.eventHookCapture).toHaveBeenCalledWith(
			{
				binding: f.source.binding,
				receiptId: f.context.receiptId,
				idempotencyKey: f.context.idempotencyKey,
				envelope: cloudNativeToolOperationEnvelope(f.run.identity, operation),
				box,
			},
			expect.any(AbortSignal),
		);
		// The key is current before the office reads it, and the box reaches the vault after.
		expect(v.eventHook.mock.invocationCallOrder[0]).toBeLessThan(ok.fetch.mock.invocationCallOrder[0]!);
		expect(ok.fetch.mock.invocationCallOrder[0]).toBeLessThan(v.eventHookCapture.mock.invocationCallOrder[0]!);
		expect(v.eventHookFill).not.toHaveBeenCalled();
		// The rekey's refusal is the call's answer and the office is never asked; nor is it on a host without the route.
		const refusing = vault();
		refusing.eventHook.mockResolvedValueOnce({
			schema: "qorpera.event-hook-refusal/v1",
			code: "55000",
			message: "This hook was removed",
		});
		const refused = endpoint(answer(), refusing);
		expect(await refused.endpoint.perform(operation, f.lease, f.context)).toEqual({
			kind: "json",
			value: {
				action: "vault_capture",
				completed: false,
				refused: { code: "55000", message: "This hook was removed" },
			},
		});
		const bare = endpoint(answer());
		expect(await bare.endpoint.perform(operation, f.lease, f.context)).toEqual({
			kind: "json",
			value: {
				action: "vault_capture",
				completed: false,
				refused: { code: "0A000", message: "Signed hooks are not set up for this company's computers" },
			},
		});
		expect(refused.fetch).not.toHaveBeenCalled();
		expect(bare.fetch).not.toHaveBeenCalled();
		expect(refusing.eventHookCapture).not.toHaveBeenCalled();
		// The store's refusal is the call's answer too.
		const store = vault();
		store.eventHookCapture.mockResolvedValueOnce({
			schema: "qorpera.event-hook-refusal/v1",
			code: "22023",
			message: "A Stripe hook's secret is taken from dashboard.stripe.com",
		});
		expect(await endpoint(answer(), store).endpoint.perform(operation, f.lease, f.context)).toEqual({
			kind: "json",
			value: {
				action: "vault_capture",
				completed: false,
				refused: { code: "22023", message: "A Stripe hook's secret is taken from dashboard.stripe.com" },
			},
		});
		// The vault answering for another hook is no answer.
		const otherRekey = vault();
		otherRekey.eventHook.mockResolvedValueOnce({
			schema: "qorpera.event-hook-rekey-answer/v1",
			hook: randomUUID(),
			replaced: true,
		});
		const otherStore = vault();
		otherStore.eventHookCapture.mockResolvedValueOnce({
			schema: "qorpera.event-hook-capture-answer/v1",
			hook: randomUUID(),
			version: 1,
			unchanged: true,
		});
		for (const other of [otherRekey, otherStore])
			await expect(endpoint(answer(), other).endpoint.perform(operation, f.lease, f.context)).rejects.toThrow(
				"OFFICE_NATIVE_UNCONFIRMED",
			);
		// Only a vault_capture's answer carries a box, exactly a box, beside the office's own completed read.
		await expect(endpoint(answer(), vault()).endpoint.perform(f.operation, f.lease, f.context)).rejects.toThrow(
			"INVALID_OFFICE_NATIVE_MESSAGE",
		);
		for (const [content, sealed, error] of [
			[read, { ...box, extra: "x" }, "INVALID_OFFICE_NATIVE_MESSAGE"],
			[read, { ...box, iv: 7 }, "INVALID_OFFICE_NATIVE_RESULT"],
			[{ kind: "json", value: { ...read.value, completed: false } }, box, "INVALID_OFFICE_NATIVE_RESULT"],
			[{ kind: "json", value: { ...read.value, action: "click" } }, box, "INVALID_OFFICE_NATIVE_RESULT"],
			[{ kind: "text", value: "read" }, box, "INVALID_OFFICE_NATIVE_RESULT"],
		] as const) {
			const x = vault();
			await expect(
				endpoint(answer({ content, box: sealed }), x).endpoint.perform(operation, f.lease, f.context),
			).rejects.toThrow(error);
			expect(x.eventHookCapture).not.toHaveBeenCalled();
		}
		// An answer without a box (the page stopped the agent) is the call's as the office gave it; nothing is stored.
		const stop = {
			kind: "json",
			value: { action: "vault_capture", tabId: randomUUID(), completed: true, stop: "captcha", message: "Stop" },
		};
		const s = vault();
		expect(await endpoint(answer({ content: stop }), s).endpoint.perform(operation, f.lease, f.context)).toEqual(
			stop,
		);
		expect(s.eventHookCapture).not.toHaveBeenCalled();
	});

	it("carries the box a guest's vault_capture sealed in that call's answer only, and never a done read without one (E3c-3)", async () => {
		const hook = randomUUID();
		const box = {
			schema: "qorpera.event-hook-capture-box/v1",
			ephemeralPublicKey: "e",
			iv: "i",
			tag: "t",
			ciphertext: "c",
		};
		const hookFills = {
			eventHookFill: vi.fn<CompanyComputerHookFills["eventHookFill"]>(),
			eventHook: vi.fn<CompanyComputerHookFills["eventHook"]>(async () => ({
				schema: "qorpera.event-hook-rekey-answer/v1",
				hook,
				replaced: false,
			})),
			eventHookCapture: vi.fn<CompanyComputerHookFills["eventHookCapture"]>(async () => ({
				schema: "qorpera.event-hook-capture-answer/v1",
				hook,
				version: 2,
				unchanged: false,
			})),
		};
		const hookBoxes = new Map<string, Readonly<Record<string, string>>>();
		const f = await fixture({ capabilities: ["browser"], hookFills, hookBoxes });
		const operation: CompanyComputerOperation = {
			...f.operation,
			tool: "computer_browser",
			arguments: {
				kind: "browser",
				action: "vault_capture",
				role: "button",
				name: "Reveal",
				hook,
				field: "signing_secret",
			},
		};
		const read = (extra: Record<string, unknown> = {}) => ({
			kind: "json" as const,
			value: { action: "vault_capture", tabId: randomUUID(), completed: true, ...extra },
		});
		f.perform.mockImplementationOnce(async (_action, _lease, context) => {
			hookBoxes.set(context.receiptId, box);
			return read();
		});
		expect(await f.endpoint.perform(operation, f.lease, f.context)).toEqual({
			kind: "json",
			value: {
				action: "vault_capture",
				completed: true,
				captured: { hook, field: "signing_secret", version: 2, unchanged: false },
			},
		});
		expect(hookFills.eventHookCapture).toHaveBeenCalledOnce();
		expect(hookFills.eventHookCapture.mock.calls[0]![0]).toMatchObject({ receiptId: f.context.receiptId, box });
		expect(hookBoxes.size).toBe(0);
		// The receipt keeps the read, never the box.
		expect(JSON.stringify(f.sql.mock.calls)).not.toContain("ciphertext");
		// The page stopped the agent after the click: the stop is the answer, with no box, and nothing is stored.
		const stop = read({ stop: "SITE_STOP_HUMAN_CHECK", message: "Stop" });
		f.perform.mockResolvedValueOnce(stop);
		expect(await f.endpoint.perform(operation, f.lease, { ...f.context, receiptId: randomUUID() })).toEqual(stop);
		// A done read whose box is gone (the session ended under it) is no answer.
		f.perform.mockResolvedValueOnce(read());
		await expect(f.endpoint.perform(operation, f.lease, { ...f.context, receiptId: randomUUID() })).rejects.toThrow();
		expect(hookFills.eventHookCapture).toHaveBeenCalledOnce();
	});

	it("re-derives the native principal, consumes the original receipt and physically closes before releasing occupancy", async () => {
		const f = await fixture();
		await f.endpoint.authorize(f.operation, f.run.identity, f.lease, f.run.signal);
		expect(await f.endpoint.perform(f.operation, f.lease, f.context)).toEqual({ kind: "text", value: "test" });
		expect(f.perform).toHaveBeenCalledOnce();
		expect(f.order.indexOf("qorpera_native_office_operation:begin")).toBeLessThan(f.order.indexOf("guest:perform"));
		expect(f.order).toContain("qorpera_native_office_operation:finish");
		const begin = f.sql.mock.calls
			.map(([, init]) => JSON.parse(String(init?.body)))
			.find((body) => body.p_action === "begin");
		expect(begin).toMatchObject({
			p_binding: f.source.binding,
			p_lease: f.lease,
			p_receipt_id: f.context.receiptId,
			p_idempotency_sha256: createHash("sha256").update(f.context.idempotencyKey).digest("hex"),
		});
		expect(JSON.stringify(begin)).not.toContain(f.token);
		await f.endpoint.close();
		await f.endpoint.close();
		expect(f.physicalClose).toHaveBeenCalledOnce();
		expect(f.order.indexOf("guest:close")).toBeLessThan(f.order.indexOf("qorpera_native_office_screen:release"));
	});
	it("opens a fresh guest session under the same lease after the guest ended the old one", async () => {
		const f = await fixture();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		// The screen was drained mid-run (for example after a lost authority grace).
		f.guests[0].ended = true;
		const next = { ...f.context, receiptId: randomUUID() };
		expect(await f.endpoint.perform(f.operation, f.lease, next)).toEqual({ kind: "text", value: "test" });
		expect(f.createSession).toHaveBeenCalledTimes(2);
		expect(f.perform).toHaveBeenCalledTimes(2);
		// A changed configuration still takes the old session's place, so the run's
		// close reaps it, but its endpoint refuses what the run was admitted with.
		f.guests[1].ended = true;
		const original = f.sql.getMockImplementation()!;
		f.sql.mockImplementation(async (input, init) =>
			String(input).endsWith("/qorpera_native_office_descriptor")
				? Response.json({ ...f.descriptor, resources: { ...f.descriptor.resources, officeGrantVersion: 2 } })
				: original(input, init),
		);
		await expect(
			f.endpoint.perform(f.operation, f.lease, { ...f.context, receiptId: randomUUID() }),
		).rejects.toThrow();
		await expect(
			f.endpoint.perform(f.operation, f.lease, { ...f.context, receiptId: randomUUID() }),
		).rejects.toThrow();
		expect(f.createSession).toHaveBeenCalledTimes(3);
		expect(f.perform).toHaveBeenCalledTimes(2);
		expect(f.physicalClose).not.toHaveBeenCalled();
		await f.endpoint.close();
		expect(f.physicalClose).toHaveBeenCalledOnce();
	});
	it("backs off after a refused reopen, then reopens", async () => {
		const f = await fixture();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		f.guests[0].ended = true;
		f.createSession.mockRejectedValueOnce(new CompanyComputerGuestSessionRefusedError("OFFICE_PRIVACY_FENCED"));
		await expect(
			f.endpoint.perform(f.operation, f.lease, { ...f.context, receiptId: randomUUID() }),
		).rejects.toThrow();
		expect(f.createSession).toHaveBeenCalledTimes(2);
		// Within the back-off the action fails at once, without another attempt.
		await expect(
			f.endpoint.perform(f.operation, f.lease, { ...f.context, receiptId: randomUUID() }),
		).rejects.toThrow();
		expect(f.createSession).toHaveBeenCalledTimes(2);
		await new Promise((resolve) => setTimeout(resolve, 3100));
		expect(await f.endpoint.perform(f.operation, f.lease, { ...f.context, receiptId: randomUUID() })).toEqual({
			kind: "text",
			value: "test",
		});
		expect(f.createSession).toHaveBeenCalledTimes(3);
		expect(f.perform).toHaveBeenCalledTimes(2);
	}, 15000);
	it("keeps no capacity for a session the guest refused to create", async () => {
		const f = await fixture();
		f.createSession.mockRejectedValueOnce(new CompanyComputerGuestSessionRefusedError("OFFICE_PRIVACY_FENCED"));
		await expect(f.endpoint.perform(f.operation, f.lease, f.context)).rejects.toThrow();
		expect(await f.endpoint.perform(f.operation, f.lease, { ...f.context, receiptId: randomUUID() })).toEqual({
			kind: "text",
			value: "test",
		});
		expect(f.createSession).toHaveBeenCalledTimes(2);
	});
	it("releases only the exact existing session while stale status blocks all new work", async () => {
		let stale = false;
		const admitWork = vi.fn(() => {
			if (stale) throw new Error("OFFICE_SUPERVISOR_STATUS_STALE");
		});
		const f = await fixture({ admitWork });
		await f.endpoint.perform(f.operation, f.lease, f.context);
		stale = true;
		f.sql.mockClear();
		const next = { ...f.body(), receipt: { receiptId: randomUUID(), idempotencyKey: "b".repeat(64) } };
		expect((await f.post(next)).status).toBe(503);
		expect((await f.post({ ...next, lease: { ...f.lease, leaseId: randomUUID() } })).status).toBe(503);
		expect(f.sql).not.toHaveBeenCalled();
		expect(f.perform).toHaveBeenCalledOnce();
		const release = {
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			action: "release",
			nativeBinding: f.source.binding,
			lease: f.lease,
		};
		for (const invalid of [
			{ ...release, lease: { ...f.lease, epoch: f.lease.epoch + 1 } },
			{ ...release, lease: { ...f.lease, leaseId: randomUUID() } },
			{ ...release, operation: f.operation },
		])
			expect((await f.post(invalid)).status).toBe(503);
		expect((await f.post(release, { token: randomBytes(32).toString("base64url") })).status).toBe(403);
		expect(f.physicalClose).not.toHaveBeenCalled();
		// A well-formed release proves the run's lease before anything else (G2-6c); nothing else was asked.
		const proven = "qorpera_native_binding_proven";
		const asked = () => f.sql.mock.calls.map(([input]) => String(input).split("/").at(-1));
		expect(asked()).toEqual([proven, proven]);
		expect((await f.post(release)).status).toBe(200);
		expect((await f.post(release)).status).toBe(200);
		expect(f.physicalClose).toHaveBeenCalledOnce();
		expect(f.order.indexOf("guest:close")).toBeLessThan(f.order.indexOf("qorpera_native_office_screen:release"));
		expect(asked()).toEqual([proven, proven, proven, "qorpera_native_office_screen", proven]);
		expect(f.createSession).toHaveBeenCalledOnce();
	});
	it("never dispatches a receipt twice and never reopens a released session", async () => {
		const f = await fixture();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		await expect(f.endpoint.perform(f.operation, f.lease, f.context)).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		expect(f.perform).toHaveBeenCalledOnce();
		await f.endpoint.close();
		const response = await f.post({
			...f.body(),
			receipt: { receiptId: randomUUID(), idempotencyKey: "b".repeat(64) },
		});
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("");
		expect(f.createSession).toHaveBeenCalledOnce();
	});
	it("retains cleanup and never retries when the completed HTTP response is lost", async () => {
		const f = await fixture();
		const transport = vi.fn<typeof fetch>(async (url, init) => {
			const response = await fetch(url, init);
			if (JSON.parse(String(init?.body)).action === "perform") {
				expect(response.status).toBe(200);
				await response.arrayBuffer();
				throw new Error("private transport diagnostic");
			}
			return response;
		});
		const endpoint = new HttpCompanyComputerNativeEndpoint({
			run: f.run,
			descriptor: f.descriptor,
			registry: f.registry,
			url: f.url,
			token: f.token,
			holder: () => f.holder,
			fetch: transport,
		});
		await expect(endpoint.perform(f.operation, f.lease, f.context)).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		expect(transport).toHaveBeenCalledOnce();
		expect(f.perform).toHaveBeenCalledOnce();
		await endpoint.close();
		expect(transport).toHaveBeenCalledTimes(2);
		expect(f.physicalClose).toHaveBeenCalledOnce();
	});
	it("quarantines an uncertain guest factory failure and reports shutdown as unconfirmed", async () => {
		const f = await fixture();
		f.createSession.mockRejectedValueOnce(new Error("unknown guest ownership"));
		f.expectDrainFailure();
		const response = await f.post(f.body());
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("");
		const retry = await f.post(f.body());
		expect(retry.status).toBe(503);
		expect(f.createSession).toHaveBeenCalledOnce();
		expect(f.perform).not.toHaveBeenCalled();
		expect(f.order).not.toContain("qorpera_native_office_screen:release");
	});
	it("proves the run's lease before a session opens, on every perform and on every release (G2-6c)", async () => {
		const f = await fixture();
		// No holder, a malformed one, another run's, or another lease token for this run's job: refused before the run's
		// authority, the descriptor or the guest is asked anything, and the answer carries nothing of the holder.
		for (const identity of [
			null,
			"",
			f.leaseToken,
			`identity.${f.leaseToken}`,
			`${f.holder}x`,
			`job.${f.source.binding.jobId.toUpperCase()}.${f.leaseToken}`,
			`job.${randomUUID()}.${f.leaseToken}`,
			`job.${f.source.binding.jobId}.${"W".repeat(43)}`,
		]) {
			const refused = await f.post(f.body(), { identity });
			expect(refused.status).toBe(503);
			expect(await refused.text()).not.toContain(f.leaseToken);
		}
		expect(f.order).toEqual([]);
		expect(f.createSession).not.toHaveBeenCalled();
		// Only the two well-formed holders reached the proof, each with the request's own binding.
		expect(f.proofs.map((proof) => proof.binding)).toEqual([f.source.binding, f.source.binding]);
		// The run's own lease opens the session, its proof before anything else; a second perform proves it again.
		f.proofs.splice(0);
		expect(await f.endpoint.perform(f.operation, f.lease, f.context)).toEqual({ kind: "text", value: "test" });
		expect(f.proofs).toEqual([{ holder: f.holder, binding: f.source.binding, at: 0 }]);
		const before = f.order.length;
		await f.endpoint.perform(f.operation, f.lease, {
			...f.context,
			receiptId: randomUUID(),
			idempotencyKey: "c".repeat(64),
		});
		expect(f.proofs).toHaveLength(2);
		expect(f.proofs[1]).toEqual({ holder: f.holder, binding: f.source.binding, at: before });
		expect(f.perform).toHaveBeenCalledTimes(2);
		// A release ends the session and records its screen lease's release, so it proves the lease too: without the
		// run's own holder it closes nothing, and the answer carries nothing of the holder.
		const release = {
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			action: "release",
			nativeBinding: f.source.binding,
			lease: f.lease,
		};
		for (const identity of [null, `identity.${f.leaseToken}`, `job.${f.source.binding.jobId}.${"W".repeat(43)}`]) {
			const refused = await f.post(release, { identity });
			expect(refused.status).toBe(503);
			expect(await refused.text()).not.toContain(f.leaseToken);
		}
		expect(f.physicalClose).not.toHaveBeenCalled();
		expect(f.order).not.toContain("qorpera_native_office_screen:release");
		expect(f.proofs).toHaveLength(3);
		const beforeRelease = f.order.length;
		expect((await f.post(release)).status).toBe(200);
		expect(f.proofs[3]).toEqual({ holder: f.holder, binding: f.source.binding, at: beforeRelease });
		expect(f.physicalClose).toHaveBeenCalledOnce();
		expect(f.order).toContain("qorpera_native_office_screen:release");
	});
	it("sends only the job's own holder, with every perform and release (G2-6c)", async () => {
		const f = await fixture();
		const sent: (string | null)[] = [];
		let current = f.holder;
		const transport = vi.fn<typeof fetch>(async (input, init) => {
			sent.push(new Headers(init?.headers).get("x-qorpera-identity"));
			return fetch(input, init);
		});
		const endpoint = new HttpCompanyComputerNativeEndpoint({
			run: f.run,
			descriptor: f.descriptor,
			registry: f.registry,
			url: f.url,
			token: f.token,
			holder: () => current,
			fetch: transport,
		});
		await endpoint.perform(f.operation, f.lease, f.context);
		// Between jobs the dispatch gives the holder's identity credential: it never goes to the computer.
		current = `identity.${f.leaseToken}`;
		await expect(
			endpoint.perform(f.operation, f.lease, {
				...f.context,
				receiptId: randomUUID(),
				idempotencyKey: "d".repeat(64),
			}),
		).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		// Nor with a release, so the computer keeps the session.
		await expect(endpoint.close()).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		expect(f.physicalClose).not.toHaveBeenCalled();
		// The run's close releases inside its job, with the job's own holder.
		current = f.holder;
		await endpoint.close();
		expect(f.physicalClose).toHaveBeenCalledOnce();
		expect(sent).toEqual([f.holder, null, null, f.holder]);
	});
	it("rejects browser origins, incorrect host credentials and query-bearing paths before authority or guest work", async () => {
		const f = await fixture();
		for (const options of [{ token: "wrong" }, { origin: "https://app.qorpera.test" }, { suffix: "?token=secret" }]) {
			const response = await f.post(f.body(), options);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe("");
		}
		expect(f.sql).not.toHaveBeenCalled();
		expect(f.createSession).not.toHaveBeenCalled();
	});
	it("rejects changed identity and operation resources locally", async () => {
		const f = await fixture();
		await expect(
			f.endpoint.perform(f.operation, f.lease, {
				...f.context,
				identity: { ...f.context.identity, companyId: randomUUID() },
			}),
		).rejects.toThrow("OFFICE_NATIVE_IDENTITY_CHANGED");
		await expect(
			f.endpoint.perform({ ...f.operation, target: { ...f.operation.target, resources: {} } }, f.lease, f.context),
		).rejects.toThrow("OFFICE_NATIVE_RESOURCES_CHANGED");
		expect(f.createSession).not.toHaveBeenCalled();
	});
	it("rejects changed epochs at the receiver and accepts reordered exact leases on cleanup", async () => {
		const f = await fixture();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		const changed = await f.post({ ...f.body(), lease: { ...f.lease, epoch: 2 } });
		expect(changed.status).toBe(503);
		const reordered = Object.fromEntries(Object.entries(f.lease).reverse());
		reordered.validForMs = 12000;
		const released = await f.post({
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			nativeBinding: f.source.binding,
			action: "release",
			lease: reordered,
		});
		expect(released.status).toBe(200);
		expect(f.perform).toHaveBeenCalledOnce();
		await f.endpoint.close();
	});
	it("withholds a result after revocation and permits exact cleanup with a fresh signal", async () => {
		const f = await fixture();
		f.perform.mockImplementationOnce(async () => {
			f.revoke();
			return { kind: "text", value: "must not escape" };
		});
		await expect(f.endpoint.perform(f.operation, f.lease, f.context)).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		f.run.close();
		await f.endpoint.close();
		expect(f.stopBrowser).toHaveBeenCalled();
		expect(f.physicalClose).toHaveBeenCalledOnce();
		expect(f.order).not.toContain("qorpera_native_office_operation:finish");
	});
	it("cancels in-flight guest work and retains remote cleanup after a lost response", async () => {
		const f = await fixture();
		const entered = computerDeferred<void>();
		f.perform.mockImplementationOnce(async (_action, _lease, context) => {
			entered.resolve();
			await new Promise<void>((resolve) =>
				context.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			context.signal.throwIfAborted();
			return { kind: "text", value: "unreachable" };
		});
		const abort = new AbortController();
		const result = f.endpoint.perform(f.operation, f.lease, { ...f.context, signal: abort.signal });
		const assertion = expect(result).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		await entered.promise;
		abort.abort();
		await assertion;
		await f.endpoint.close();
		expect(f.perform).toHaveBeenCalledOnce();
		expect(f.stopBrowser).toHaveBeenCalledOnce();
		expect(f.physicalClose).toHaveBeenCalledOnce();
	});
	it("does not release occupancy or acknowledge shutdown when physical cleanup fails", async () => {
		const f = await fixture();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		f.physicalClose.mockRejectedValue(new Error("private guest diagnostic"));
		f.expectDrainFailure();
		await expect(f.endpoint.close()).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		await expect(f.endpoint.close()).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		expect(f.order).not.toContain("qorpera_native_office_screen:release");
		expect(f.physicalClose).toHaveBeenCalledOnce();
	});
	it("does not claim cleanup of unknown sessions or accept extra wire fields", async () => {
		const f = await fixture();
		const unknown = await f.post({
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			nativeBinding: f.source.binding,
			action: "release",
			lease: f.lease,
		});
		expect(unknown.status).toBe(503);
		const extra = await f.post({ ...f.body(), command: "ignored bypass" });
		expect(extra.status).toBe(503);
		expect(f.createSession).not.toHaveBeenCalled();
		// Only the release's lease proof was asked (G2-6c).
		expect(f.sql).toHaveBeenCalledOnce();
		expect(f.proofs).toHaveLength(1);
	});
	it("parses only scoped descriptors and fixed configured HTTPS routes", async () => {
		const f = await fixture();
		expect(parseCompanyComputerNativeDescriptor(f.descriptor, f.run)).toEqual(f.descriptor);
		expect(parseCompanyComputerNativeDescriptor({ state: "unavailable" }, f.run)).toBeUndefined();
		for (const value of [
			{ ...f.descriptor, url: "https://foreign.test" },
			{ ...f.descriptor, resources: { ...f.descriptor.resources, guestPath: "/private" } },
			{ ...f.descriptor, scope: { ...f.scope, companyId: randomUUID() } },
			{ ...f.descriptor, capabilities: ["browser"] },
		])
			expect(() => parseCompanyComputerNativeDescriptor(value, f.run)).toThrow();
		for (const value of [
			f.url.replace("https:", "http:"),
			`${f.url}?token=bad`,
			`${f.url}#fragment`,
			f.url.replace("/native", "/other"),
		])
			expect(() => parseCompanyComputerNativeUrl(value)).toThrow();
		const route = f.url.replace(f.scope.companyComputerId, "{companyComputerId}");
		expect(parseCompanyComputerNativeRoute(route).companyComputerId).toBeNull();
		expect(parseCompanyComputerNativeRoute(route).urlFor(f.scope.companyComputerId)).toBe(f.url);
		expect(() => parseCompanyComputerNativeRoute(route).urlFor("../../admin")).toThrow();
		expect(parseCompanyComputerNativeRoute(f.url).companyComputerId).toBe(f.scope.companyComputerId);
		for (const value of [
			route.replace("https:", "http:"),
			`${route}?token=bad`,
			route.replace("/native", "/other"),
			`${route}/{companyComputerId}`,
			route.replace("/office/{companyComputerId}", "/{companyComputerId}"),
			route.replace("{companyComputerId}", "x{companyComputerId}"),
		])
			expect(() => parseCompanyComputerNativeRoute(value)).toThrow();
	});
});
