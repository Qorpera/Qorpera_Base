import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, writeFile } from "node:fs/promises";
import type {
	CompanyComputerOperation,
	CompanyComputerScreenLease,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import { nativeToolAuthorityFixture } from "../../../shell/test/fixtures/native-tool-authority-fixture.ts";
import { CompanyComputerDrainSupervisor } from "../../src/cloud-company-computer-drain.ts";
import { CloudCompanyComputerEffectControl } from "../../src/cloud-company-computer-effect-control.ts";
import { CompanyComputerScreenActionGate } from "../../src/cloud-company-computer-leases.ts";
import { CompanyComputerLinuxGuest } from "../../src/cloud-company-computer-linux-guest.ts";
import { CompanyComputerPrivacySupervisor } from "../../src/cloud-company-computer-privacy.ts";
import {
	type CompanyComputerScreenEvent,
	CompanyComputerScreenLifecyclePublisher,
	type CompanyComputerScreenLifecycleRegistry,
} from "../../src/cloud-company-computer-screen-lifecycle.ts";
import { CompanyComputerScreenOutbox } from "../../src/cloud-company-computer-screen-outbox.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import { CloudNativeToolRun } from "../../src/cloud-native-tool-authority.ts";
import { computerBinding, computerId, computerLease, computerOperation, computerScope } from "./company-computer.ts";
import { screenReceipt, screenStartup } from "./screen-lifecycle.ts";

// Actual whole-guest adapters and privacy/drain supervisors. SQL/native ledger,
// VM adoption, readiness and asset publication are fixture services; no provider
// or production authority is claimed by this disposable physical integration.
const signal = AbortSignal.timeout(120000);
const adopted = `/srv/.qorpera-adopted-${computerId(72)}`;
const layout = {
	workbenchRoot: `${adopted}/workbench`,
	desktopHome: `${adopted}/desktop`,
	screenStateRoot: `${adopted}/screens`,
	browserProfilesRoot: `${adopted}/profiles`,
};
async function mount(path: string) {
	const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		return parseRecoveryDirectoryMount(
			await readFile("/proc/self/mountinfo", "utf8"),
			await readFile(`/proc/self/fdinfo/${fd.fd}`, "utf8"),
		);
	} finally {
		await fd.close();
	}
}
const source = nativeToolAuthorityFixture();
const secondSource = nativeToolAuthorityFixture();
const scope = {
	...computerScope(),
	companyId: source.authority.identity.companyId,
	environmentId: source.authority.identity.environmentId,
};
const second = {
	...secondSource,
	authority: {
		...secondSource.authority,
		identity: { ...secondSource.authority.identity, companyId: scope.companyId, environmentId: scope.environmentId },
	},
};
const sources = [source, second];
const bindings = sources.map((item, index) => ({
	...computerBinding(),
	...scope,
	screenId: computerId(100 + index),
	screenOrdinal: index + 1,
	staffAgentId: item.authority.identity.staffAgentId,
}));
const runs = await Promise.all(
	sources.map((item) =>
		CloudNativeToolRun.open(item.binding, { describeToolAuthority: async () => item.authority }, signal),
	),
);
let privacyState = "shared";
let privacyVersion = 0;
let epoch = 1;
let challenge: CompanyComputerPrivacyChallenge | undefined;
let png: Uint8Array | undefined;
const failures: string[] = [];
const receipts = new Map<string, string>();
const acknowledged = new Set<string>();
const screenEvents = new Map<string, { args: Record<string, unknown>; event: CompanyComputerScreenEvent }[]>();
const screenReceipts = new Map<string, { args: Record<string, unknown>; receipt: ReturnType<typeof screenReceipt> }>();
let lostScreenClosingReply = false;
let exportAvailable = false;
let offlineExportAttempts = 0;
const screenRegistry: CompanyComputerScreenLifecycleRegistry = {
	async call(_method, args) {
		if (!exportAvailable) {
			offlineExportAttempts++;
			throw new Error("fixture screen export unavailable");
		}
		const event = args.p_event as { lifetimeId: string; eventId: string; sequence: number; state: string };
		const previous = screenReceipts.get(event.eventId);
		if (previous) {
			assert.deepEqual(args, previous.args);
			return previous.receipt;
		}
		const delivered = [...screenReceipts.values()].filter((r) => r.receipt.lifetimeId === event.lifetimeId);
		assert.equal(event.sequence, delivered.length + 1);
		const recorded = { args: structuredClone(args), receipt: screenReceipt(args) };
		screenReceipts.set(event.eventId, recorded);
		if (event.state === "closing" && !lostScreenClosingReply) {
			lostScreenClosingReply = true;
			throw new Error("fixture discarded committed physical closing reply");
		}
		return recorded.receipt;
	},
};
const outboxRoot = "/var/lib/qorpera-office-events";
let screenOutbox = await CompanyComputerScreenOutbox.open(
	outboxRoot,
	scope,
	[
		...Object.values(layout),
		"/run/office-screens",
		"/run/office-browser",
		"/run/office-captures",
		"/run/office-private-workbench",
	],
	screenRegistry,
);
const screenLifecycle = new CompanyComputerScreenLifecyclePublisher({ ...screenStartup(), scope }, screenRegistry, {
	canHeartbeat: (lifetimeId) => screenOutbox.canHeartbeat(lifetimeId),
	async retain(observation, checked) {
		const { binding, privacy, event } = observation;
		const prefix = privacy === null ? `screen-${binding.screenOrdinal}-` : "private-";
		const physical = (await readdir("/run/office-screens")).filter((name) => name.startsWith(prefix));
		if (event.state === "ready") assert.equal(physical.length, 1, "readiness follows the actual launcher");
		if (event.state === "requested" || event.state === "closed")
			assert.equal(physical.length, 0, "launch has not started or reaping is confirmed");
		await screenOutbox.retain(observation, checked).catch((error) => {
			console.error("FIXTURE_SCREEN_CUSTODY_FAILED", error);
			throw error;
		});
		const history = screenEvents.get(event.lifetimeId) ?? [];
		assert.equal(event.sequence, history.length + 1);
		assert.notEqual(history.at(-1)?.event.state, "closed");
		history.push({
			event: structuredClone(event),
			args: structuredClone({
				p_startup: observation.startup,
				p_binding: binding,
				p_privacy: privacy,
				p_event: event,
			}),
		});
		screenEvents.set(event.lifetimeId, history);
	},
});
const control = {
	async call(method: string, args: Record<string, unknown>) {
		if (method === "qorpera_check_runtime_office_shared_surface") {
			assert.equal(privacyState, "shared");
			assert.ok(bindings.some((binding) => JSON.stringify(binding) === JSON.stringify(args.p_binding)));
			return { state: "authorized", privacyVersion, epoch, validForMs: 5000 };
		}
		if (method === "qorpera_check_runtime_office_private_surface") {
			assert.ok(["entering", "private"].includes(privacyState));
			assert.deepEqual(args.p_challenge, challenge);
			assert.equal(acknowledged.size, 2);
			return { state: "authorized", privacyState, version: privacyVersion, validForMs: 5000 };
		}
		if (method === "qorpera_native_office_browser_grant") {
			assert.equal(privacyState, "shared");
			return { state: "authorized" };
		}
		if (method === "qorpera_runtime_office_screen_appearance") {
			assert.equal(privacyState, "shared");
			return { creature: null, templateId: null };
		}
		if (method === "qorpera_office_screen_browser_grant") {
			// The screen's browser authority; this probe opens it through agent runs only.
			assert.equal(privacyState, "shared");
			assert.ok(args.p_opener === null || args.p_opener === "agent");
			return {
				state: "authorized",
				grant: { profileId: computerId(120), grantId: computerId(121), version: 1 },
				validForMs: 5000,
			};
		}
		if (method === "qorpera_native_office_operation") {
			if (args.p_action === "finish") return { state: "drained" };
			assert.equal(privacyState, "shared");
			if (args.p_action === "authorize") return { state: "authorized" };
			const id = args.p_receipt_id as string;
			if (args.p_action === "begin") {
				assert.ok(!receipts.has(id));
				receipts.set(id, randomUUID());
			}
			assert.ok(receipts.has(id));
			return { state: "admitted", resourceLeaseId: receipts.get(id), validForMs: 30000 };
		}
		if (method === "qorpera_ack_runtime_office_drain") {
			acknowledged.add(args.p_screen_id as string);
			return { state: "drained", drainId: args.p_drain_id, epoch: args.p_epoch };
		}
		if (method === "qorpera_ack_runtime_office_privacy") {
			assert.deepEqual(args.p_challenge, challenge);
			assert.equal(acknowledged.size, 2);
			privacyState = challenge!.state === "entering" ? "private" : "shared";
			return { state: privacyState, version: privacyVersion, challengeId: challenge!.challengeId };
		}
		throw new Error(`Unexpected fixture RPC ${method}`);
	},
};
async function createGuest() {
	return new CompanyComputerLinuxGuest({
		scope,
		computerGeneration: 1,
		layout,
		limits: { memoryBytes: 2147483648, pids: 512, cpuQuota: 200000, cpuPeriod: 100000 },
		workbenchMount: await mount(layout.workbenchRoot),
		privateWorkbenchMount: await mount("/run/office-private-workbench"),
		displayRuntimeRoot: "/run/office-screens",
		browserRuntimeRoot: "/run/office-browser",
		captureRoot: "/run/office-captures",
		registry: control,
		screenLifecycle,
		boundary: { async assertReady() {} },
		onFailure: (error) => failures.push(error.message),
		screenshots: () => ({
			async publish(bytes) {
				png = Uint8Array.from(bytes);
				return {
					assetId: randomUUID(),
					sha256: createHash("sha256").update(bytes).digest("hex"),
					bytes: bytes.length,
					mediaType: "image/png",
				};
			},
		}),
	});
}
let guest = await createGuest();
const gate = new CompanyComputerScreenActionGate();
async function session(index: number, browser = false) {
	const run = runs[index];
	await run.assertActive(signal);
	const lease: CompanyComputerScreenLease = {
		...computerLease(),
		binding: bindings[index],
		epoch,
		driver: { kind: "agent", runId: run.identity.runId, staffAgentId: run.identity.staffAgentId },
	};
	const resources = {
		officeGrantId: computerId(110 + index),
		officeGrantVersion: 1,
		officePrivacyVersion: privacyVersion,
		...(browser
			? { browserProfileId: computerId(120), browserGrantId: computerId(121), browserGrantVersion: 1 }
			: {}),
	};
	const descriptor = {
		state: "available" as const,
		scope,
		capabilities: browser ? ["shell" as const, "browser" as const] : ["shell" as const],
		resources,
	};
	const effects = new CloudCompanyComputerEffectControl({ run, scope, control });
	const current = await guest.createSession({ run, descriptor, lease, effects, gate });
	return {
		...current,
		lease,
		async perform(action: CompanyComputerOperation["arguments"]) {
			await run.assertActive(signal);
			const kind = (action as { kind: string }).kind;
			const operation = {
				...computerOperation(),
				logicalOperationKey: randomUUID(),
				tool: `computer_${kind}`,
				arguments: action,
				target: { realm: "company_computer", binding: { ...lease.binding }, resources },
			};
			return current.endpoint.perform(operation, lease, {
				identity: run.identity,
				receiptId: randomUUID(),
				idempotencyKey: "a".repeat(64),
				signal,
			});
		},
	};
}
const drains = new CompanyComputerDrainSupervisor({
	scope,
	gate,
	control,
	stopResources: (binding, checked) => guest.stopResources(binding, checked),
});
const privacy = new CompanyComputerPrivacySupervisor({ scope, drains, control, boundary: guest.privacy });
function transition(state: "entering" | "leaving") {
	privacyState = state;
	privacyVersion++;
	epoch++;
	acknowledged.clear();
	challenge = {
		scope,
		computerGeneration: 1,
		challengeId: randomUUID(),
		version: privacyVersion,
		state,
		memberId: computerId(130),
		profileId: computerId(120),
		profileVersion: 2,
		screenId: bindings[0].screenId,
		drains: bindings.map((binding) => ({ state: "draining", drainId: randomUUID(), epoch, binding })),
	};
	return challenge;
}
const exists = async (path: string) =>
	readFile(path).then(
		() => true,
		() => false,
	);
try {
	const first = await session(0, true);
	const second = await session(1);
	assert.deepEqual(await readdir("/run/office-screens"), []);
	await first.perform({ kind: "screen", action: "open" });
	await second.perform({ kind: "screen", action: "open" });
	assert.equal((await readdir("/run/office-screens")).length, 2);
	await screenOutbox.flush(signal);
	assert.equal(offlineExportAttempts, 4);
	assert.equal(screenReceipts.size, 0);
	assert.deepEqual(
		await first.perform({ kind: "shell", command: "test ! -e /var/lib/qorpera-office-events", timeoutMs: 1000 }),
		{
			kind: "json",
			value: { code: 0, stdout: "", stderr: "" },
		},
	);
	const written = await first.perform({
		kind: "shell",
		command: "printf shared-state > shared-state.txt",
		timeoutMs: 1000,
	});
	assert.equal(written.kind, "json");
	assert.deepEqual(await second.perform({ kind: "shell", command: "cat shared-state.txt", timeoutMs: 1000 }), {
		kind: "json",
		value: { code: 0, stdout: "shared-state", stderr: "" },
	});
	await first.perform({ kind: "browser", action: "list_tabs" });
	await first.perform({ kind: "screenshot", surface: "browser" });
	assert.ok(png);
	await writeFile("/opt/probe-artifacts/guest.png", png, { flag: "wx", mode: 0o600 });
	await first.close();
	await second.close();
	// The browser belongs to the screen: the run that opened it has ended, the
	// contained Chromium is still there for the desktop and the next run.
	assert.equal((await readdir("/run/office-browser")).length, 1);
	assert.equal((await readdir("/run/office-screens")).length, 2);
	assert.equal(screenEvents.size, 2);
	assert.ok([...screenEvents.values()].every((events) => events.at(-1)?.event.state === "ready"));
	const watch = await guest.viewer.connect(
		{
			binding: bindings[0],
			viewerSessionId: computerId(131),
			memberId: computerId(130),
			mode: "watch",
			privacyVersion: 0,
			screenEpoch: epoch,
			validForMs: 30000,
		},
		signal,
	);
	assert.equal(watch.socket.isPaused(), true);
	watch.socket.destroy(); // Viewer shutdown is separate from computer shutdown.
	assert.equal((await readdir("/run/office-screens")).length, 2);
	assert.ok([...screenEvents.values()].every((events) => events.at(-1)?.event.state === "ready"));
	// Two cloud agents prepare separate inputs on their own persistent desktops,
	// then consume one another's work after the only member view has closed.
	const offlineFirst = await session(0);
	const offlineSecond = await session(1);
	for (const result of await Promise.all([
		offlineFirst.perform({
			kind: "shell",
			command: "printf 'item,total\\na,12\\nb,8\\n' > totals-a.csv",
			timeoutMs: 2000,
		}),
		offlineSecond.perform({
			kind: "shell",
			command: "printf 'item,total\\nc,13\\nd,7\\n' > totals-b.csv",
			timeoutMs: 2000,
		}),
	]))
		assert.deepEqual(result, { kind: "json", value: { code: 0, stdout: "", stderr: "" } });
	assert.deepEqual(
		await offlineFirst.perform({
			kind: "shell",
			command:
				'set -e; total=0; for report_part in totals-a.csv totals-b.csv; do { IFS=, read -r item amount; while IFS=, read -r item amount; do total=$((total + amount)); done; } < "$report_part"; done; printf \'Total: %d\\n\' "$total" > report.txt; cat report.txt',
			timeoutMs: 2000,
		}),
		{ kind: "json", value: { code: 0, stdout: "Total: 40\n", stderr: "" } },
	);
	assert.deepEqual(await offlineSecond.perform({ kind: "shell", command: "cat report.txt", timeoutMs: 2000 }), {
		kind: "json",
		value: { code: 0, stdout: "Total: 40\n", stderr: "" },
	});
	await offlineFirst.close();
	await offlineSecond.close();
	await privacy.transition(transition("entering"), signal);
	assert.equal(privacyState, "private");
	assert.equal((await readdir("/run/office-screens")).filter((name) => name.startsWith("private-")).length, 1);
	assert.equal((await readdir("/run/office-screens")).filter((name) => name.startsWith("screen-")).length, 0);
	assert.equal(await exists(`${layout.workbenchRoot}/shared-state.txt`), true);
	const memberLease = {
		...computerLease(),
		binding: bindings[0],
		epoch,
		driver: { kind: "member" as const, memberId: computerId(130), sessionId: computerId(132) },
	};
	const privateGrant = {
		binding: bindings[0],
		viewerSessionId: computerId(132),
		memberId: computerId(130),
		mode: "control" as const,
		privacyVersion,
		screenEpoch: epoch,
		validForMs: 30000,
		lease: memberLease,
		privateSignIn: { challengeId: challenge!.challengeId, profileId: challenge!.profileId, profileVersion: 2 },
	};
	const privateViewer = await guest.viewer.connect(privateGrant, signal);
	assert.equal(privateViewer.socket.isPaused(), true);
	// Simulate a completed private viewer drain, then recover the same private
	// challenge through a new viewer. Disconnect must not own browser lifetime.
	await guest.stopResources(bindings[0], signal);
	assert.ok(privateViewer.socket.destroyed);
	assert.deepEqual(await readdir("/run/office-screens"), []);
	await assert.rejects(guest.viewer.connect({ ...privateGrant, privacyVersion: privacyVersion + 1 }, signal));
	assert.deepEqual(await readdir("/run/office-screens"), []);
	const viewerLifetime = new AbortController();
	const recovered = await guest.viewer.connect(privateGrant, viewerLifetime.signal);
	const recoveredScreen = await readdir("/run/office-screens");
	recovered.socket.destroy();
	viewerLifetime.abort();
	const reconnected = await guest.viewer.connect(privateGrant, signal);
	assert.equal(reconnected.socket.isPaused(), true);
	assert.deepEqual(await readdir("/run/office-screens"), recoveredScreen);
	await privacy.transition(transition("leaving"), signal);
	assert.equal(privacyState, "shared");
	assert.ok(reconnected.socket.destroyed);
	assert.deepEqual(await readdir("/run/office-screens"), []);
	assert.deepEqual(await readdir("/run/office-browser"), []);
	epoch++;
	const resumed = await session(0);
	assert.deepEqual(await resumed.perform({ kind: "shell", command: "cat shared-state.txt", timeoutMs: 1000 }), {
		kind: "json",
		value: { code: 0, stdout: "shared-state", stderr: "" },
	});
	await resumed.close();
	assert.equal((await readdir("/run/office-screens")).length, 1);
	await guest.close();
	assert.deepEqual(failures, []);
	for (const path of [
		"/run/office-screens",
		"/run/office-browser",
		"/run/office-captures",
		"/run/office-private-workbench",
	])
		assert.deepEqual(await readdir(path), []);
	assert.equal(await readFile(`${layout.workbenchRoot}/shared-state.txt`, "utf8"), "shared-state");
	assert.equal(await readFile(`${layout.workbenchRoot}/report.txt`, "utf8"), "Total: 40\n");
	// Recreate all guest adapters over the retained workbench. Restore the last
	// privacy barrier before admitting work, as the service supervisor does.
	// This is service reconstruction, not a physical VM reboot or NAS proof.
	guest = await createGuest();
	await guest.privacy.fence(challenge!, signal);
	const reconstructed = await session(1);
	assert.deepEqual(await reconstructed.perform({ kind: "shell", command: "cat report.txt", timeoutMs: 2000 }), {
		kind: "json",
		value: { code: 0, stdout: "Total: 40\n", stderr: "" },
	});
	await reconstructed.close();
	await guest.close();
	assert.deepEqual(failures, []);
	for (const path of [
		"/run/office-screens",
		"/run/office-browser",
		"/run/office-captures",
		"/run/office-private-workbench",
	])
		assert.deepEqual(await readdir(path), []);
	assert.equal(screenEvents.size, 6);
	assert.equal([...screenEvents.values()].filter((events) => events[0].args.p_privacy !== null).length, 2);
	for (const events of screenEvents.values()) {
		assert.deepEqual(
			events.map((record) => record.event.state),
			["requested", "ready", "closing", "closed"],
		);
	}
	assert.equal(screenReceipts.size, 0, "whole guest work and cleanup completed while export was offline");
	await screenOutbox.close();
	screenOutbox = await CompanyComputerScreenOutbox.open(outboxRoot, scope, Object.values(layout), screenRegistry);
	exportAvailable = true;
	for (let i = 0; i < 5; i++) await screenOutbox.flush(signal);
	assert.deepEqual(await readdir(outboxRoot), ["scope.json"]);
	assert.equal(screenReceipts.size, 24);
	assert.equal(lostScreenClosingReply, true);
	for (const records of screenEvents.values())
		for (const record of records) assert.deepEqual(screenReceipts.get(record.event.eventId)?.args, record.args);
	console.log(
		JSON.stringify({
			schema: "qorpera.office-linux-guest-proof/v1",
			platform: process.platform,
			arch: process.arch,
			syntheticAuthorityAndAdoption: true,
			realWholeGuestAdapters: true,
			physicalScreenLifecyclePublisher: true,
			durableScreenOutbox: true,
			workAndDrainWithScreenExportOffline: true,
			replayAfterOutboxReopen: true,
			outboxHiddenFromModelShell: true,
			screenLifecycleRegistry: "fixture",
			screenLifetimes: screenEvents.size,
			lostClosingReplyRecovered: lostScreenClosingReply,
			desktops: 2,
			receiptAdmittedStart: true,
			sharedWorkbench: true,
			concurrentOfficeWorkload: true,
			workloadAfterViewerDisconnect: true,
			workbenchReportAfterGuestReconstruction: true,
			canonicalCompanyFile: "not exercised by this fixture",
			physicalVmReboot: false,
			browserAndScreenshotThroughEndpoint: true,
			desktopSurvivesSessionAndViewerClose: true,
			privateTransitionDrainsAllScreens: true,
			privateRecoveryRejectsStaleViewer: true,
			privateBrowserSurvivesViewerDisconnect: true,
			privateExitThenSharedResume: true,
			persistentStatePreserved: true,
			privateServiceOwnedAdoptionParents: true,
			wholeGuestCleanup: true,
			screenshotBytes: png.length,
			realProviderCalls: false,
		}),
	);
} catch (error) {
	console.error("FIXTURE_GUEST_PROBE_FAILED", error);
	throw error;
} finally {
	await guest.close();
	await screenOutbox.close();
	for (const run of runs) run.close();
}
