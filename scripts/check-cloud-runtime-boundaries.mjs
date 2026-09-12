import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = process.cwd();
const failures = [];

function sourceFiles(directory) {
	const files = [];
	for (const entry of readdirSync(join(repositoryRoot, directory), { withFileTypes: true })) {
		if (entry.isDirectory() && (entry.name === "dist" || entry.name === "node_modules")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name === "package.json")) files.push(path);
	}
	return files;
}

const providerNeutralFiles = [
	...sourceFiles("packages/contracts"),
	...sourceFiles("packages/company"),
	...sourceFiles("packages/object-gateway"),
	...sourceFiles("packages/runner-orchestrator"),
	...sourceFiles("packages/runtime"),
	...sourceFiles("packages/cloud-client"),
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

// The local execution lane is gone: none of its modules may come back.
const removedLocalLaneModules = [
	"packages/shell/src/model-request-broker.ts",
	"packages/shell/src/legacy-local-model-request-broker.ts",
	"packages/shell/src/model-request-scope.ts",
	"packages/shell/src/model-accounts.ts",
	"packages/shell/src/local-execution.ts",
	"packages/shell/src/intelligence-account.ts",
	"packages/shell/src/intelligence-onboarding.ts",
	"packages/shell/src/http-request-broker.ts",
];
for (const file of removedLocalLaneModules) {
	if (existsSync(join(repositoryRoot, file))) failures.push(`${file}: the local execution lane was removed`);
}

const agentRuntimeSource = readFileSync(join(repositoryRoot, "packages/shell/src/agent-runtime.ts"), "utf-8");
for (const name of ["codexSpawn", "provisionSandbox", "writeSandboxProfile"]) {
	if (new RegExp(`export (async )?function ${name}\\(`).test(agentRuntimeSource)) {
		failures.push(`packages/shell/src/agent-runtime.ts: may not export the local child helper ${name}`);
	}
}

const mainPath = join(repositoryRoot, "packages/shell/src/main.ts");
const mainSource = readFileSync(mainPath, "utf-8");

const removedMainSymbols = [
	"startLegacyPiSessionAttachment(",
	"sendLegacyLocalPrompt(",
	"sendLegacyLocalStaffDirective(",
	"childProfileTypes",
	"writeChildFrame(",
	"function startChild(",
	"cloud ${cause} wake is waiting for the runner orchestrator",
];
for (const symbol of removedMainSymbols) {
	if (mainSource.includes(symbol)) {
		failures.push(`packages/shell/src/main.ts: the local execution lane was removed; found ${JSON.stringify(symbol)}`);
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
	if (sponsoredTurn.includes("enqueueCloudPrompt(") || sponsoredTurn.includes("sendLegacyLocalPrompt(")) {
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
	if (rpcSend.includes("sendLegacyLocalPrompt(") || rpcSend.includes("writeChildFrame(")) {
		failures.push("packages/shell/src/main.ts: rpc:send may not execute frames on this computer");
	}
}

if (mainSource.includes(".appendPrompt(")) {
	failures.push("packages/shell/src/main.ts: the desktop may not append unsponsored cloud inputs");
}

if (mainSource.includes("claimTurn(") || mainSource.includes("runtimeCloudWakeArbiter(")) {
	failures.push("packages/shell/src/main.ts: the desktop may observe cloud queues but may not claim cloud turns or wakes");
}
if (mainSource.includes("completeActiveCloudWake(") || mainSource.includes("submitCloudWakeProposal(")) {
	failures.push("packages/shell/src/main.ts: cloud wakes belong to the Runner Orchestrator");
}
if (mainSource.includes("withBrokerOutputCheckpoint(") || mainSource.includes("childBrokerOutputCheckpoints")) {
	failures.push("packages/shell/src/main.ts: the desktop has no local broker output to checkpoint");
}

if (failures.length > 0) {
	console.error("Cloud/runtime architecture boundary check failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
