import { describe, expect, it } from "vitest";
import { parseProductFeedbackRequest } from "../src/product-feedback.ts";

describe("product feedback", () => {
	it("normalizes a valid feedback request", () => {
		expect(
			parseProductFeedbackRequest({
				clientFeedbackId: "10000000-0000-4000-8000-000000000001",
				category: "bug",
				details: "  The composer stopped responding.  ",
				includeDiagnostics: true,
			}),
		).toEqual({
			clientFeedbackId: "10000000-0000-4000-8000-000000000001",
			category: "bug",
			details: "The composer stopped responding.",
			includeDiagnostics: true,
		});
	});

	it("rejects missing details and unknown categories", () => {
		expect(() =>
			parseProductFeedbackRequest({
				clientFeedbackId: "10000000-0000-4000-8000-000000000001",
				category: "billing",
				details: "Something changed.",
				includeDiagnostics: false,
			}),
		).toThrow("valid feedback category");
		expect(() =>
			parseProductFeedbackRequest({
				clientFeedbackId: "10000000-0000-4000-8000-000000000001",
				category: "other",
				details: "   ",
				includeDiagnostics: false,
			}),
		).toThrow("Share a few details");
	});
});
