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
	...readdirSync(join(repositoryRoot, "packages/shell/src"))
		.filter((name) => name.startsWith("cloud-") && name.endsWith(".ts"))
		.map((name) => join("packages/shell/src", name)),
	"packages/shell/src/hosted-primary.ts",
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

const oldBrokerPath = join(repositoryRoot, "packages/shell/src/model-request-broker.ts");
if (existsSync(oldBrokerPath)) failures.push("packages/shell/src/model-request-broker.ts: use the explicit legacy-local boundary");

const mainPath = join(repositoryRoot, "packages/shell/src/main.ts");
const mainSource = readFileSync(mainPath, "utf-8");
const composerStart = mainSource.indexOf("const cloudSponsoredPrompt = reviewedCloudPrompt?.executionSponsor !== undefined;");
const composerEnd = mainSource.indexOf('if (cloudStaffConversation && frame.type === "prompt")', composerStart);
if (composerStart < 0 || composerEnd <= composerStart) {
	failures.push("packages/shell/src/main.ts: cloud composer boundary was not found");
} else {
	const composer = mainSource.slice(composerStart, composerEnd);
	if (!composer.includes("await control.requestSessionTurn({")) {
		failures.push("packages/shell/src/main.ts: sponsored cloud turns must enqueue a runner job");
	}
	if (!composer.includes("Cloud turns never use the desktop model runtime.")) {
		failures.push("packages/shell/src/main.ts: cloud turns must reject an absent execution sponsor");
	}
	if (composer.includes("enqueueCloudPrompt(") || composer.includes("sendLegacyLocalPrompt(")) {
		failures.push("packages/shell/src/main.ts: cloud composer may not fall back to the legacy local executor");
	}
}

const legacyPromptStart = mainSource.indexOf("function sendLegacyLocalPrompt(");
const legacyPromptEnd = mainSource.indexOf("function ", legacyPromptStart + 1);
const legacyPrompt = mainSource.slice(legacyPromptStart, legacyPromptEnd);
if (
	legacyPromptStart < 0 ||
	!legacyPrompt.includes('childProfileTypes.get(child) === "cloud"') ||
	!legacyPrompt.includes("legacy local executor rejected a cloud prompt")
) {
	failures.push("packages/shell/src/main.ts: the legacy local executor must fail closed for cloud profiles");
}

const legacyStaffStart = mainSource.indexOf("function sendLegacyLocalStaffDirective(");
const legacyStaffEnd = mainSource.indexOf("function ", legacyStaffStart + 1);
const legacyStaffDirective = mainSource.slice(legacyStaffStart, legacyStaffEnd);
if (
	legacyStaffStart < 0 ||
	!legacyStaffDirective.includes('childProfileTypes.get(child) === "cloud"') ||
	!legacyStaffDirective.includes("legacy local executor rejected a cloud staff directive")
) {
	failures.push("packages/shell/src/main.ts: legacy staff directives must fail closed for cloud profiles");
}

if (mainSource.includes(".appendPrompt(")) {
	failures.push("packages/shell/src/main.ts: the desktop may not append unsponsored cloud inputs");
}

if (mainSource.includes("claimTurn(") || mainSource.includes("runtimeCloudWakeArbiter(")) {
	failures.push("packages/shell/src/main.ts: the desktop may observe cloud queues but may not claim cloud turns or wakes");
}
if (!mainSource.includes("startLegacyPiSessionAttachment(") || mainSource.includes("function startChild(")) {
	failures.push("packages/shell/src/main.ts: the inherited Pi attachment must remain an explicit legacy boundary");
}
if (!mainSource.includes("cloud ${cause} wake is waiting for the runner orchestrator")) {
	failures.push("packages/shell/src/main.ts: cloud wakes must fail closed until the Runner Orchestrator executes them");
}

if (failures.length > 0) {
	console.error("Cloud/runtime architecture boundary check failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
