import { readFileSync } from "node:fs";
import type { ClaudeResetKind } from "../../../packages/runtime/src/cloud-claude-login-usage.ts";
import { ClaudeLoginReader } from "../../../packages/runtime/src/cloud-claude-login-reader.ts";

const [mode, claude, root, credentialsPath, proxy, ca, kind] = process.argv.slice(2);
const reader = new ClaudeLoginReader({
	claudePath: claude!,
	temporaryRoot: root!,
	environment: { HTTPS_PROXY: proxy!, https_proxy: proxy!, NODE_EXTRA_CA_CERTS: ca! },
});
const credentials = readFileSync(credentialsPath!).toString("base64");
const signal = AbortSignal.timeout(120_000);
const started = Date.now();
const result =
	mode === "read"
		? await reader.readClaudeLogin({ credentials, usage: true, resets: true }, signal)
		: await reader.useClaudeReset({ credentials, kind: kind as ClaudeResetKind }, signal);
console.log(`READER-RESULT ${JSON.stringify({ ms: Date.now() - started, result })}`);
