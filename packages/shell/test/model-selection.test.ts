import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

interface ModelOption {
	value: string;
	name: string;
	fastCapable: boolean;
}

interface ModelSelectionApi {
	curateModels(models: readonly ModelOption[]): readonly ModelOption[];
	selectSameProviderFallback(models: readonly ModelOption[], currentValue: string): ModelOption | undefined;
}

let modelSelection: ModelSelectionApi;

beforeAll(() => {
	const directory = dirname(fileURLToPath(import.meta.url));
	const source = readFileSync(join(directory, "../userland/model-selection.js"), "utf-8");
	const context: { window: { qorperaModelSelection?: ModelSelectionApi } } = { window: {} };
	runInNewContext(source, context);
	if (!context.window.qorperaModelSelection) throw new Error("model selection helpers were not installed");
	modelSelection = context.window.qorperaModelSelection;
});

const model = (value: string): ModelOption => ({ value, name: value, fastCapable: false });

describe("model selection", () => {
	it("loads before the renderer", () => {
		const directory = dirname(fileURLToPath(import.meta.url));
		const index = readFileSync(join(directory, "../userland/index.html"), "utf-8");
		const helperIndex = index.indexOf("./model-selection.js");
		const rendererIndex = index.indexOf("./renderer.js");

		expect(helperIndex).toBeGreaterThanOrEqual(0);
		expect(rendererIndex).toBeGreaterThan(helperIndex);
	});

	it("excludes models outside the curated slate", () => {
		const offered = modelSelection.curateModels([
			model("anthropic::claude-fable-5"),
			model("openai-codex::gpt-5.6-sol"),
			model("openai-codex::gpt-5.5"),
		]);

		expect(offered.map((option) => option.value)).toEqual(["anthropic::claude-fable-5", "openai-codex::gpt-5.6-sol"]);
	});

	it("falls back within the active provider", () => {
		const offered = [model("anthropic::claude-fable-5"), model("openai-codex::gpt-5.6-sol")];

		expect(modelSelection.selectSameProviderFallback(offered, "openai-codex::gpt-5.5")?.value).toBe(
			"openai-codex::gpt-5.6-sol",
		);
	});

	it("does not substitute a model from an unconnected provider", () => {
		const offered = [model("anthropic::claude-fable-5")];

		expect(modelSelection.selectSameProviderFallback(offered, "openai-codex::gpt-5.5")).toBeUndefined();
	});
});
