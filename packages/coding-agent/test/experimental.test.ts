import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.QORPERA_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.QORPERA_EXPERIMENTAL;
		} else {
			process.env.QORPERA_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when QORPERA_EXPERIMENTAL is unset", () => {
		delete process.env.QORPERA_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when QORPERA_EXPERIMENTAL is empty", () => {
		process.env.QORPERA_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when QORPERA_EXPERIMENTAL is set to 1", () => {
		process.env.QORPERA_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when QORPERA_EXPERIMENTAL is set to 0", () => {
		process.env.QORPERA_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when QORPERA_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.QORPERA_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
