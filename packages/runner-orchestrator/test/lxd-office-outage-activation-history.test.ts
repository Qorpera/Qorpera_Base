import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "../../runtime/test/fixtures/company-computer-boot-configuration.ts";
import { companyComputerOutageFixture } from "../../runtime/test/fixtures/company-computer-outage.ts";
import { readLxdOfficeInitialActivationHistory } from "../src/lxd-office-activation-history.ts";
import { LxdOfficeControlJournal } from "../src/lxd-office-control-journal.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import {
	type LxdOfficeOutageActivationHistoryClient,
	readLxdOfficeOutageActivationHistory,
} from "../src/lxd-office-outage-activation-history.ts";
import { readLxdOfficeOutageVmLineage } from "../src/lxd-office-outage-history.ts";

vi.mock("../src/lxd-office-activation-history.ts", () => ({ readLxdOfficeInitialActivationHistory: vi.fn() }));
vi.mock("../src/lxd-office-outage-history.ts", () => ({ readLxdOfficeOutageVmLineage: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	vi.clearAllMocks();
});

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-outage-history-")));
	roots.push(root);
	const bridge = { retained: "external stop" },
		f = companyComputerOutageFixture({ requestSha256: officeDigest(bridge) }),
		{ startup, providerId, providerPolicySha256 } = f.recovery.predecessor,
		binding = lxdOfficeGuestPlan({
			schema: "qorpera.lxd-office-guest/v2",
			providerId,
			providerPolicySha256,
			...startup.scope,
			computerGeneration: 1,
			allocationId: startup.allocationId,
			project: "offices",
			imageFingerprint: startup.imageSha256,
			bootstrapSha256: startup.bootstrapSha256,
			storagePool: "office-vms",
			rootDiskBytes: 64 * 1024 ** 3,
			workbenchSource: "/mnt/nas/office",
			network: "office-net",
			cpus: 2,
			memoryBytes: 4 * 1024 ** 3,
		}).binding,
		intentId = f.observation.intentId,
		allocationId = binding.allocationId,
		activationId = f.request.activationId,
		recoveryId = f.request.recoveryId,
		suffix = `${allocationId}-${activationId}`,
		recoverySuffix = `${allocationId}-${recoveryId}`,
		bootId = f.observation.bootId,
		bootObservationSha256 = f.completion.bootObservationSha256,
		configOperationId = id(920),
		startOperationId = id(921),
		configuration = f.completion,
		serviceBootstrapSha256 = "8".repeat(64),
		values = new Map<string, unknown>();
	const configured = {
			schema: "qorpera.lxd-office-outage-configuration-observation/v1",
			intentId,
			allocationId,
			recoveryId,
			activationId,
			bootId,
			resumeStartCommandId: f.observation.startCommandId,
			bootObservationSha256,
			commandId: configuration.command.commandId,
			requestSha256: configuration.command.requestSha256,
			operationId: configOperationId,
			serviceBootstrapSha256,
			completionSha256: f.start.configurationCompletionSha256,
			completion: configuration,
		},
		configurationObservationSha256 = officeDigest(configured),
		request = {
			...f.start,
			successor: {
				...f.successor,
				request: {
					...f.successorRequest,
					attestation: { ...f.successorRequest.attestation, configurationObservationSha256 },
				},
			},
		},
		command = { ...f.startCommand, requestSha256: hash(officeCanonical(request)) },
		completion = { ...f.started, command },
		packet = { schema: "qorpera.lxd-office-outage-service-start-request/v1", intentId, binding, command, request },
		identity = {
			intentId,
			binding,
			bootObservationSha256,
			configurationObservationSha256,
			recoveryId,
			activationId,
			command,
		},
		marker = {
			schema: "qorpera.lxd-office-outage-service-start-completion/v1",
			intentId,
			allocationId,
			recoveryId,
			activationId,
			bootId,
			commandId: command.commandId,
			configurationObservationSha256,
			predecessorActivationId: f.recovery.predecessor.activationId,
			operationId: startOperationId,
			completion,
			requestSha256: command.requestSha256,
		},
		activation = {
			...request.successor,
			state: "active",
			serviceInvocationId: completion.serviceInvocationId,
			readinessFresh: true,
		};
	values.set(`outage-service-start-request-${suffix}.json`, packet);
	values.set(`outage-successor-request-${suffix}.json`, {
		schema: "qorpera.lxd-office-outage-successor-request/v1",
		intentId,
		binding,
		request: request.successor.request,
		configurationObservationSha256,
	});
	values.set(`outage-successor-prepared-${suffix}.json`, request.successor);
	values.set(`outage-prepared-${recoverySuffix}.json`, f.recovery);
	values.set(`outage-observation-${recoverySuffix}.json`, f.observation);
	values.set(`outage-termination-acknowledgement-${recoverySuffix}.json`, f.termination);
	values.set(`intent-${intentId}.json`, {
		schema: "qorpera.lxd-office-creation/v1",
		intentId,
		binding,
		createCommandId: id(922),
	});
	values.set(`outage-configuration-intent-${suffix}.json`, {
		schema: "qorpera.lxd-office-outage-configuration-intent/v1",
		intentId,
		allocationId,
		recoveryId,
		activationId,
		bootId,
		bootObservationSha256,
		originPreparationSha256: configuration.originPreparationSha256,
		serviceBootstrapSha256,
		serviceBootstrapPath: "/protected/plan.json",
		requestSha256: configuration.command.requestSha256,
		requestBytes: 12345,
		commandId: configuration.command.commandId,
	});
	values.set(`outage-configuration-observation-${suffix}.json`, configured);
	values.set(`outage-configuration-completed-${suffix}.json`, {
		schema: "qorpera.lxd-office-outage-configuration-completion/v1",
		intentId,
		allocationId,
		recoveryId,
		activationId,
		commandId: configuration.command.commandId,
		observationSha256: configurationObservationSha256,
	});
	values.set(`outage-service-start-intent-${suffix}.json`, {
		schema: "qorpera.lxd-office-outage-service-start-intent/v1",
		requestSha256: officeDigest(packet),
		identity,
	});
	values.set(`outage-service-start-completed-${suffix}.json`, marker);
	values.set(`outage-activation-completed-${suffix}.json`, {
		schema: "qorpera.lxd-office-outage-activation-completion/v1",
		intentId,
		allocationId,
		recoveryId,
		activationId,
		startCommandId: command.commandId,
		startObservationSha256: officeDigest(marker),
		activation,
	});
	const read = vi.fn(async (name: string) => {
		if (!values.has(name)) throw new Error(`missing ${name}`);
		return { value: values.get(name), bytes: encode(values.get(name)) };
	});
	const submit = vi.fn(async () => ({
			project: binding.project,
			instanceName: lxdOfficeGuestPlan(binding).request.name,
			operationId: startOperationId,
		})),
		inspect = vi.fn(async () => "succeeded" as const),
		client = {
			submitOfficeOutageConfiguration: submit,
			inspectOfficeOutageConfiguration: inspect,
			submitOfficeOutageServiceStart: submit,
			inspectOfficeOutageServiceStart: inspect,
		} as unknown as LxdOfficeOutageActivationHistoryClient;
	await (
		await LxdOfficeControlJournal.open(
			root,
			{
				intentId,
				binding,
				recoveryId,
				activationId,
				originPreparationSha256: configuration.originPreparationSha256,
				bootObservationSha256,
				command: configuration.command,
			},
			{
				submit: async () => ({
					project: binding.project,
					instanceName: lxdOfficeGuestPlan(binding).request.name,
					operationId: configOperationId,
				}),
				inspect,
			},
			false,
			"outage-configuration",
		)
	).reconcile(new AbortController().signal);
	await (
		await LxdOfficeControlJournal.open(root, identity, { submit, inspect }, false, "outage-service-start")
	).reconcile(new AbortController().signal);
	submit.mockClear();
	inspect.mockClear();
	vi.mocked(readLxdOfficeInitialActivationHistory).mockResolvedValue({
		request: {
			configuration: { preparation: { requestSha256: configuration.originPreparationSha256, commandId: id(923) } },
		},
	} as Awaited<ReturnType<typeof readLxdOfficeInitialActivationHistory>>);
	const proof = {
		stopReceipt: { closedHostBootId: f.observation.hostBootId },
		physicalInstanceId: f.observation.physicalInstanceId,
	};
	// The lineage implementation has independent disk-chain regressions. This
	// seam verifies its nested physical stop proof is bound to this observation.
	const lineage = {
		segments: [
			{
				bridge: { bridge, request: f.request, predecessor: f.recovery.predecessor, proof },
				history: { events: [{}, {}, { operationId: f.observation.operationId, state: "succeeded" }] },
			},
		],
	};
	vi.mocked(readLxdOfficeOutageVmLineage).mockResolvedValue(
		lineage as unknown as Awaited<ReturnType<typeof readLxdOfficeOutageVmLineage>>,
	);
	return {
		root,
		f,
		values,
		suffix,
		proof,
		submit,
		inspect,
		read,
		bridge,
		check: () =>
			readLxdOfficeOutageActivationHistory(
				root,
				intentId,
				binding,
				activationId,
				read,
				client,
				new AbortController().signal,
			),
	};
}

describe("retained outage activation acknowledgements", () => {
	it("reads exact active history and nested stopped-host proof without re-dispatching", async () => {
		const f = await fixture(),
			result = await f.check();
		expect(result.kind).toBe("outage");
		expect(result.recovery).toEqual(f.f.recovery);
		expect(result.hostBootId).toBe(f.proof.stopReceipt.closedHostBootId);
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.inspect).not.toHaveBeenCalled();
	});
	it("rejects a foreign external-stop bridge before reading root configuration", async () => {
		const f = await fixture();
		f.bridge.retained = "substituted";
		await expect(f.check()).rejects.toThrow("outage VM lineage differs");
		expect(f.submit).not.toHaveBeenCalled();
	});
	it("rejects a different host in the exact guard stop receipt", async () => {
		const f = await fixture();
		f.proof.stopReceipt.closedHostBootId = id(999);
		await expect(f.check()).rejects.toThrow("outage VM lineage differs");
	});
	it.each(["outage-activation-completed", "outage-service-start-intent", "outage-configuration-completed"])(
		"rejects missing %s",
		async (prefix) => {
			const f = await fixture();
			f.values.delete(`${prefix}-${f.suffix}.json`);
			await expect(f.check()).rejects.toThrow();
			expect(f.submit).not.toHaveBeenCalled();
		},
	);
});
