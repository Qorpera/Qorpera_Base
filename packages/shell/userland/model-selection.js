"use strict";

(() => {
	const CURATED_MODELS = [
		["anthropic::claude-fable-5"],
		["anthropic::claude-opus-5"],
		["openai-codex::gpt-5.6-sol", "openai::gpt-5.6-sol"],
		["openai-codex::gpt-5.6-terra", "openai::gpt-5.6-terra"],
	];

	function curateModels(models) {
		const byValue = new Map(models.map((model) => [model.value, model]));
		const picked = [];
		for (const lanes of CURATED_MODELS) {
			for (const value of lanes) {
				const model = byValue.get(value);
				if (model) {
					picked.push(model);
					break;
				}
			}
		}
		return picked.length ? picked : models;
	}

	function selectSameProviderFallback(models, currentValue) {
		const [provider, modelId] = currentValue.split("::");
		const sameProvider = models.filter((model) => model.value.split("::")[0] === provider);
		return sameProvider.find((model) => model.value.split("::")[1] === modelId) ?? sameProvider[0];
	}

	window.qorperaModelSelection = Object.freeze({ curateModels, selectSameProviderFallback });
})();
