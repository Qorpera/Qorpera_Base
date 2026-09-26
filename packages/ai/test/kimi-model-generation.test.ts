import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const generator = fileURLToPath(new URL("../scripts/generate-models.ts", import.meta.url));
const model = (name: string) => ({
	id: "kimi-for-coding",
	name,
	tool_call: true,
	reasoning: true,
	limit: { context: 1048576, output: 32768 },
});

describe("Kimi catalog generation", () => {
	it.each(["kimi-code-plan-cn", "kimi-for-coding"])("hydrates the %s source without changing endpoint", (key) => {
		const root = mkdtempSync(join(tmpdir(), "kimi-catalog-"));
		try {
			const catalog = {
				[key]: { models: { "kimi-for-coding": model("Matching region") } },
				...(key === "kimi-code-plan-cn"
					? { "kimi-for-coding": { models: { "kimi-for-coding": model("Old snapshot") } } }
					: {}),
				"kimi-code-plan-global": { models: { "global-only": { ...model("Other region"), id: "global-only" } } },
			};
			const preload = join(root, "fetch.mjs");
			writeFileSync(
				preload,
				`const catalog = ${JSON.stringify(catalog)};
globalThis.fetch = async (url) => {
  if (url === "https://models.dev/api.json") return Response.json(catalog);
  if (url === "https://openrouter.ai/api/v1/models" || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({data: []});
  throw new Error("Unexpected generator request: " + url);
};\n`,
			);
			const output = join(root, "catalog");
			const result = spawnSync(
				process.execPath,
				["--import", preload, generator, "--strict", "--json-only", "--json-output", output],
				{
					encoding: "utf8",
					timeout: 15000,
				},
			);
			expect(result.status, result.stderr).toBe(0);
			const models = JSON.parse(readFileSync(join(output, "providers/kimi-coding.json"), "utf8"));
			expect(Object.keys(models)).toEqual(["kimi-for-coding"]);
			expect(models["kimi-for-coding"]).toMatchObject({
				name: "Matching region",
				provider: "kimi-coding",
				api: "anthropic-messages",
				baseUrl: "https://api.kimi.com/coding",
				contextWindow: 1048576,
				maxTokens: 32768,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
