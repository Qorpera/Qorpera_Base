import { readFileSync } from "node:fs";
import type { ClaudeResetKind } from "../../../packages/runtime/src/cloud-claude-login-usage.ts";
import { ModelLoginHelperClient } from "../../../packages/runtime/src/cloud-model-login-helper.ts";

const [mode, socketPath, tokenPath, credentialsPath, kind] = process.argv.slice(2);
const client = new ModelLoginHelperClient({ socketPath: socketPath!, token: readFileSync(tokenPath!, "utf8").trim() });
const credentials = readFileSync(credentialsPath!).toString("base64");
const signal = AbortSignal.timeout(120_000);
const started = Date.now();
try {
	const result =
		mode === "read"
			? await client.readClaudeLogin({ credentials, usage: true, resets: true }, signal)
			: await client.useClaudeReset({ credentials, kind: kind as ClaudeResetKind }, signal);
	console.log(`CLIENT-RESULT ${JSON.stringify({ ms: Date.now() - started, result })}`);
} catch (error) {
	console.log(`CLIENT-RESULT ${JSON.stringify({ ms: Date.now() - started, error: String(error) })}`);
}
