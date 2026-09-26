import {
	companyComputerBootDirectory,
	companyComputerOutageAdoptionReceiptCanonical,
	parseCompanyComputerLifecycleRequest,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	bootFixtureEncode as encode,
	bootFixtureId as id,
} from "../../runtime/test/fixtures/company-computer-boot-configuration.ts";
import { appendBootServiceRestartFixture } from "../../runtime/test/fixtures/company-computer-boot-service-restart.ts";
import { companyComputerOutageFixture } from "../../runtime/test/fixtures/company-computer-outage.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import type { LxdOfficeOutageRetainedHistoryClient } from "../src/lxd-office-outage-restart-history.ts";
import { readLxdOfficeOutageRetainedHistory } from "../src/lxd-office-outage-restart-history.ts";
import { readLxdOfficeOutageStopEvidence } from "../src/lxd-office-outage-stop-evidence.ts";

vi.mock("../src/lxd-office-outage-restart-history.ts", () => ({ readLxdOfficeOutageRetainedHistory: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

function fixture() {
	const f = companyComputerOutageFixture(),
		{ startup, providerId, providerPolicySha256 } = f.recovery.predecessor,
		binding = lxdOfficeGuestPlan({
			schema: "qorpera.lxd-office-guest/v2",
			providerId,
			providerPolicySha256,
			...startup.scope,
			computerGeneration: startup.computerGeneration,
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
		origin = {
			kind: "outage" as const,
			initial: false as const,
			request: f.start,
			command: f.startCommand,
			completion: f.started,
			marker: { retained: true },
			bootObservationSha256: f.completion.bootObservationSha256,
			hostBootId: f.observation.hostBootId,
			recovery: f.recovery,
			observation: f.observation,
			configurationCommandIds: [f.completion.command.commandId, f.observation.startCommandId],
		},
		history = { ...origin, origin },
		run = "/run/qorpera-office-preparation",
		directory = companyComputerBootDirectory(f.observation.bootId),
		files = new Map<string, { content: Buffer; mode: number; uid: number; gid: number }>();
	const put = (path: string, value: unknown, mode = 0o600) =>
		files.set(path, { content: encode(value), mode, uid: 0, gid: 0 });
	put(`${run}/outage-service-start-completion.json`, f.started);
	put(`${run}/outage-service-start-incoming-${f.startCommand.requestSha256}.json`, f.start, 0o400);
	put(`${directory}/configuration-completion.json`, f.completion);
	put(`${directory}/configuration-claim.json`, {
		schema: "qorpera.office-outage-configuration-claim/v1",
		command: f.completion.command,
		recoveryId: f.request.recoveryId,
		activationId: f.request.activationId,
	});
	put(`${run}/outage-service-start-claim.json`, {
		schema: "qorpera.office-outage-service-start-claim/v1",
		command: f.startCommand,
		recoveryId: f.request.recoveryId,
		activationId: f.request.activationId,
		configurationCompletionSha256: f.start.configurationCompletionSha256,
	});
	files.set(`${directory}/credentials/config.json`, {
		content: Buffer.from(f.configuration.material.configuration),
		mode: 0o400,
		uid: 0,
		gid: 0,
	});
	files.set(`${directory}/adoption.json`, {
		content: Buffer.from(`${companyComputerOutageAdoptionReceiptCanonical(f.receipt)}\n`),
		mode: 0o444,
		uid: 0,
		gid: 0,
	});
	put(
		`${run}/outage-termination-inspection-${f.termination.request.inspection.inspectionId}.json`,
		f.termination.request.inspection,
	);
	const recovery = parseCompanyComputerLifecycleRequest({
		schema: "qorpera.office-lifecycle-request/v1",
		action: "power_off",
		transitionId: id(999),
		activationId: f.started.activationId,
		providerId,
		providerPolicySha256,
		startup: {
			...startup,
			bootId: f.observation.bootId,
			configurationSha256: f.started.configurationSha256,
			serviceInvocationId: f.started.serviceInvocationId,
		},
	});
	vi.mocked(readLxdOfficeOutageRetainedHistory).mockResolvedValue(history);
	const readInstanceFile = vi.fn(async (_project: string, _name: string, path: string) => {
		const file = files.get(path);
		if (!file) throw new Error(`missing ${path}`);
		return { ...file, content: Buffer.from(file.content) };
	});
	const client = { readInstanceFile } as unknown as LxdOfficeOutageRetainedHistoryClient;
	const read = vi.fn(async () => {
		throw new Error("history reader is independently tested");
	});
	return {
		f,
		run,
		directory,
		files,
		recovery,
		history,
		put,
		readInstanceFile,
		check: (current = recovery) =>
			readLxdOfficeOutageStopEvidence(
				"/retained/provider",
				f.observation.intentId,
				binding,
				current,
				{},
				read,
				client,
				new AbortController().signal,
			),
	};
}

describe("outage-born service stop evidence", () => {
	it("preserves the exact outage origin through an ordinary same-boot service restart", async () => {
		const f = fixture(),
			files = new Map<string, { bytes: Buffer; mode: number }>(),
			stopRequest = parseCompanyComputerServiceStopRequest({
				schema: "qorpera.office-service-stop-request/v1",
				startCompletionSha256: "a".repeat(64),
				revocation: {
					schema: "qorpera.office-lifecycle-transition/v1",
					request: { ...f.recovery, action: "service_restart" },
					state: "draining",
					revocationRevision: 9,
					requestedAtMs: 3000,
					drains: [],
				},
			}),
			restart = appendBootServiceRestartFixture({
				files,
				stopRequest,
				request: f.f.start,
				startCompletion: f.f.started,
			});
		for (const [path, file] of files) f.files.set(path, { content: file.bytes, mode: file.mode, uid: 0, gid: 0 });
		vi.mocked(readLxdOfficeOutageRetainedHistory).mockResolvedValue({
			...f.history,
			request: restart.request,
			command: restart.command,
			completion: restart.completion,
		});
		const current = {
			...f.recovery,
			activationId: restart.completion.activationId,
			startup: { ...f.recovery.startup, serviceInvocationId: restart.completion.serviceInvocationId },
		};
		expect((await f.check(current)).origin.recovery.request.recoveryId).toBe(f.f.request.recoveryId);
		f.put(restart.claimPath, { schema: "qorpera.office-boot-service-successor-claim/v1", recoveryId: id(998) });
		await expect(f.check(current)).rejects.toThrow("successor root claims differ");
	});
	it("retains the explicit forced origin and validates compact public adoption and exact root claims", async () => {
		const f = fixture(),
			result = await f.check();
		expect(result.kind).toBe("outage");
		expect(result.origin.recovery).toEqual(f.f.recovery);
		expect(result.forbiddenCommandIds).toContain(f.f.observation.startCommandId);
		expect(Object.keys(result.installed)).toContain(`${f.directory}/adoption.json`);
		expect(f.readInstanceFile.mock.calls.every((call) => !call[2].includes("stop-history"))).toBe(true);
		expect(JSON.stringify(f.f.receipt)).not.toContain("privacyChallenge");
	});
	it.each(["adoption", "claim", "completion", "inspection", "configuration"])(
		"rejects changed %s without fabricating graceful evidence",
		async (fault) => {
			const f = fixture(),
				path =
					fault === "adoption"
						? `${f.directory}/adoption.json`
						: fault === "claim"
							? `${f.run}/outage-service-start-claim.json`
							: fault === "completion"
								? `${f.directory}/configuration-completion.json`
								: fault === "inspection"
									? `${f.run}/outage-termination-inspection-${f.f.termination.request.inspection.inspectionId}.json`
									: `${f.directory}/credentials/config.json`;
			f.files.get(path)!.content = encode({ changed: true });
			await expect(f.check()).rejects.toThrow();
		},
	);
	it.each(["uid", "gid", "mode"] as const)("rejects incorrect %s custody", async (key) => {
		const f = fixture();
		f.files.get(`${f.directory}/adoption.json`)![key] = 777;
		await expect(f.check()).rejects.toThrow("custody");
	});
	it("does not accept a different service invocation or predecessor", async () => {
		const f = fixture();
		await expect(
			f.check({ ...f.recovery, startup: { ...f.recovery.startup, serviceInvocationId: "f".repeat(32) } }),
		).rejects.toThrow("recovery activation differs");
	});
	it("does not discard corrupt provider history or fall back to initial activation", async () => {
		const f = fixture();
		vi.mocked(readLxdOfficeOutageRetainedHistory).mockRejectedValueOnce(new Error("outage VM lineage differs"));
		await expect(f.check()).rejects.toThrow("outage VM lineage differs");
		expect(f.readInstanceFile).not.toHaveBeenCalled();
	});
});
