import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cloud/runtime architecture boundaries. The symbol and module lists below
 * are the single source of truth: packages/shell/test/userland-wiring.test.ts
 * imports them, so a ban added here is asserted by both the check and the
 * shell test suite. Importing this module runs nothing; the checks execute
 * only when the file is the Node entry point.
 */

/** The local execution lane is gone: none of its modules may come back. */
export const removedLocalLaneModules = Object.freeze([
	"packages/shell/src/model-request-broker.ts",
	"packages/shell/src/legacy-local-model-request-broker.ts",
	"packages/shell/src/model-request-scope.ts",
	"packages/shell/src/model-accounts.ts",
	"packages/shell/src/local-execution.ts",
	"packages/shell/src/intelligence-account.ts",
	"packages/shell/src/intelligence-onboarding.ts",
	"packages/shell/src/http-request-broker.ts",
	"packages/shell/src/wake-scheduler.ts",
	"packages/shell/src/custom-trigger-builds.ts",
	"packages/shell/src/room-delegation-policy.ts",
]);

/** Local child helpers packages/shell/src/agent-runtime.ts may not export. */
export const removedAgentRuntimeExports = Object.freeze(["codexSpawn", "provisionSandbox", "writeSandboxProfile"]);

/**
 * Substrings that may not appear anywhere in packages/shell/src/main.ts.
 * Each entry names the exact text and the boundary it protects.
 */
export const removedMainSymbols = Object.freeze([
	// The local execution lane was removed from the desktop entirely.
	{ symbol: "startLegacyPiSessionAttachment(", reason: "the local execution lane was removed" },
	{ symbol: "sendLegacyLocalPrompt(", reason: "the local execution lane was removed" },
	{ symbol: "sendLegacyLocalStaffDirective(", reason: "the local execution lane was removed" },
	{ symbol: "childProfileTypes", reason: "the local execution lane was removed" },
	{ symbol: "writeChildFrame(", reason: "the local execution lane was removed" },
	{ symbol: "function startChild(", reason: "the local execution lane was removed" },
	{ symbol: "childRuntimeReady", reason: "the local execution lane was removed" },
	{ symbol: "MODEL_CONNECTIONS", reason: "the desktop holds no model connections of its own" },
	{ symbol: "requireDurableExecution,", reason: "the desktop no longer imports a durable local executor" },
	{
		symbol: "Cloud company publication is waiting for the active agent run to finish",
		reason: "the desktop has no local agent run to wait for",
	},
	// The desktop neither ticks wakes nor runs rooms; it only observes the
	// durable queues the Runner Orchestrator drains.
	{ symbol: "startWakeTicker(", reason: "cloud wakes belong to the Runner Orchestrator" },
	{ symbol: "wakeChild", reason: "cloud wakes belong to the Runner Orchestrator" },
	{ symbol: "startWakeChildExclusive(", reason: "cloud wakes belong to the Runner Orchestrator" },
	{ symbol: "startRoomChildExclusive(", reason: "cloud wakes belong to the Runner Orchestrator" },
	{ symbol: "scheduleRoomDeliveryPump(", reason: "cloud wakes belong to the Runner Orchestrator" },
	{ symbol: "wake is waiting for the runner orchestrator", reason: "cloud wakes belong to the Runner Orchestrator" },
	{ symbol: "completeActiveCloudWake(", reason: "cloud wakes belong to the Runner Orchestrator" },
	{ symbol: "submitCloudWakeProposal(", reason: "cloud wakes belong to the Runner Orchestrator" },
	{
		symbol: "claimTurn(",
		reason: "the desktop may observe cloud queues but may not claim cloud turns or wakes",
	},
	{
		symbol: "runtimeCloudWakeArbiter(",
		reason: "the desktop may observe cloud queues but may not claim cloud turns or wakes",
	},
	// Every cloud input is sponsored by a runner job.
	{ symbol: ".appendPrompt(", reason: "the desktop may not append unsponsored cloud inputs" },
	// There is no local broker output to checkpoint.
	{ symbol: "withBrokerOutputCheckpoint(", reason: "the desktop has no local broker output to checkpoint" },
	{ symbol: "childBrokerOutputCheckpoints", reason: "the desktop has no local broker output to checkpoint" },
]);

function sourceFiles(repositoryRoot, directory) {
	const files = [];
	for (const entry of readdirSync(join(repositoryRoot, directory), { withFileTypes: true })) {
		if (entry.isDirectory() && (entry.name === "dist" || entry.name === "node_modules")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(repositoryRoot, path));
		else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name === "package.json")) files.push(path);
	}
	return files;
}

export function checkCloudRuntimeBoundaries(repositoryRoot) {
	const failures = [];

	const providerNeutralFiles = [
		...sourceFiles(repositoryRoot, "packages/contracts"),
		...sourceFiles(repositoryRoot, "packages/company"),
		...sourceFiles(repositoryRoot, "packages/object-gateway"),
		...sourceFiles(repositoryRoot, "packages/runner-orchestrator"),
		...sourceFiles(repositoryRoot, "packages/runtime"),
		...sourceFiles(repositoryRoot, "packages/cloud-client"),
		...readdirSync(join(repositoryRoot, "packages/shell/src"))
			.filter((name) => name.startsWith("cloud-") && name.endsWith(".ts"))
			.map((name) => join("packages/shell/src", name)),
		"packages/shell/src/company-operation-broker.ts",
		"packages/shell/src/connector-execution-authorization.ts",
		"packages/shell/src/github-company-connector.ts",
	];

	for (const file of providerNeutralFiles) {
		const source = readFileSync(join(repositoryRoot, file), "utf-8");
		if (source.includes("@qorpera/pi-")) {
			failures.push(`${file}: provider-neutral cloud and company code may not import a Pi package`);
		}
	}

	for (const file of removedLocalLaneModules) {
		if (existsSync(join(repositoryRoot, file))) failures.push(`${file}: the local execution lane was removed`);
	}

	const agentRuntimeSource = readFileSync(join(repositoryRoot, "packages/shell/src/agent-runtime.ts"), "utf-8");
	for (const name of removedAgentRuntimeExports) {
		if (new RegExp(`export (async )?function ${name}\\(`).test(agentRuntimeSource)) {
			failures.push(`packages/shell/src/agent-runtime.ts: may not export the local child helper ${name}`);
		}
	}

	const mainPath = join(repositoryRoot, "packages/shell/src/main.ts");
	const mainSource = readFileSync(mainPath, "utf-8");

	for (const { symbol, reason } of removedMainSymbols) {
		if (mainSource.includes(symbol)) {
			failures.push(`packages/shell/src/main.ts: ${reason}; found ${JSON.stringify(symbol)}`);
		}
	}

	const sponsoredTurnStart = mainSource.indexOf("async function requestSponsoredCloudTurn(");
	const sponsoredTurnEnd = mainSource.indexOf("function trailSessionLeafEntryId(", sponsoredTurnStart);
	if (sponsoredTurnStart < 0 || sponsoredTurnEnd <= sponsoredTurnStart) {
		failures.push("packages/shell/src/main.ts: sponsored cloud turn boundary was not found");
	} else {
		const sponsoredTurn = mainSource.slice(sponsoredTurnStart, sponsoredTurnEnd);
		if (!sponsoredTurn.includes("await control.requestSessionTurn({")) {
			failures.push("packages/shell/src/main.ts: sponsored cloud turns must enqueue a runner job");
		}
		if (!sponsoredTurn.includes("Cloud turns never use the desktop model runtime.")) {
			failures.push("packages/shell/src/main.ts: cloud turns must reject an absent execution sponsor");
		}
		if (sponsoredTurn.includes("enqueueCloudPrompt(")) {
			failures.push("packages/shell/src/main.ts: sponsored cloud turns may not fall back to a local executor");
		}
	}

	// The session anchor is the only path from the composer to an agent turn.
	if (!mainSource.includes("async function anchoredSessionRpc(")) {
		failures.push("packages/shell/src/main.ts: the session anchor rpc boundary was not found");
	}
	if (!mainSource.includes("requestSponsoredCloudTurn(runtime, arbiter, anchor.staffAgentId, ref, reviewed)")) {
		failures.push("packages/shell/src/main.ts: the session anchor must use the sponsored turn boundary");
	}

	const rpcSendStart = mainSource.indexOf('ipcMain.handle("rpc:send"');
	const rpcSendEnd = mainSource.indexOf("ipcMain.handle(", rpcSendStart + 1);
	if (rpcSendStart < 0 || rpcSendEnd <= rpcSendStart) {
		failures.push("packages/shell/src/main.ts: rpc:send handler was not found");
	} else {
		const rpcSend = mainSource.slice(rpcSendStart, rpcSendEnd);
		if (!rpcSend.includes("runtime.sessionAnchor") || !rpcSend.includes("anchoredSessionRpc(")) {
			failures.push("packages/shell/src/main.ts: rpc:send must route prompts only through the session anchor");
		}
		if (!rpcSend.includes("Agents execute in the cloud.")) {
			failures.push("packages/shell/src/main.ts: rpc:send must reject frames without an anchored cloud conversation");
		}
	}

	return failures;
}

const isMainModule = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) {
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const failures = checkCloudRuntimeBoundaries(repositoryRoot);
	if (failures.length > 0) {
		console.error("Cloud/runtime architecture boundary check failed:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
}
