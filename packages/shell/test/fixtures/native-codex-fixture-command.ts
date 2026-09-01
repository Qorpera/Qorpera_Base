import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Test-only launcher: loopback Responses server and a literal synthetic bearer, never an account credential. */
export async function nativeCodexFixtureCommand(
	root: string,
	codexCommand: readonly [string, ...string[]],
	port: number,
	compaction?: "local" | "remote" | "remote-v2",
): Promise<{ command: readonly [string, string]; binarySha256: string }> {
	const wrapper = join(root, "codex-fixture.cjs");
	const provider = `model_providers.qorpera_fixture={name="${compaction?.startsWith("remote") ? "OpenAI" : "Offline boundary fixture"}",base_url="http://127.0.0.1:${port}/v1",env_key="QORPERA_OFFLINE_PROBE_KEY",wire_api="responses",requires_openai_auth=false}`;
	const compactConfig = compaction
		? [
				"-c",
				"model_auto_compact_token_limit=20000",
				"-c",
				`features.remote_compaction_v2=${compaction === "remote-v2"}`,
			]
		: [];
	// App-server's config overrides belong after its subcommand. Production launches the
	// independently verified native artifact directly, without this Node test wrapper.
	await writeFile(
		wrapper,
		[
			'const { spawn } = require("node:child_process");',
			`const [command, ...prefix] = ${JSON.stringify(codexCommand)};`,
			"const args = process.argv.slice(2);",
			`const child = spawn(command, [...prefix, args[0], "-c", 'model_provider="qorpera_fixture"', "-c", ${JSON.stringify(provider)}, ...${JSON.stringify(compactConfig)}, ...args.slice(1)], {env:{...process.env,QORPERA_OFFLINE_PROBE_KEY:"not-a-provider-credential"},stdio:"inherit"});`,
			'child.on("error", () => process.exit(125));',
			'child.on("exit", code => process.exit(code ?? 1));',
		].join("\n"),
	);
	return {
		command: [process.execPath, wrapper],
		binarySha256: createHash("sha256")
			.update(await readFile(process.execPath))
			.digest("hex"),
	};
}
