const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PRODUCT_FEEDBACK_CATEGORIES = [
	"bug",
	"bad-result",
	"good-result",
	"feature-request",
	"performance",
	"other",
] as const;

export type ProductFeedbackCategory = (typeof PRODUCT_FEEDBACK_CATEGORIES)[number];

export interface ProductFeedbackRequest {
	clientFeedbackId: string;
	category: ProductFeedbackCategory;
	details: string;
	includeDiagnostics: boolean;
}

export interface ProductFeedbackSubmission extends ProductFeedbackRequest {
	diagnostics: Record<string, string>;
}

export function parseProductFeedbackRequest(input: unknown): ProductFeedbackRequest {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("Feedback is invalid. Please try again.");
	}
	const value = input as Record<string, unknown>;
	if (typeof value.clientFeedbackId !== "string" || !UUID_PATTERN.test(value.clientFeedbackId)) {
		throw new Error("Feedback is invalid. Please reopen the form and try again.");
	}
	if (
		typeof value.category !== "string" ||
		!PRODUCT_FEEDBACK_CATEGORIES.includes(value.category as ProductFeedbackCategory)
	) {
		throw new Error("Choose a valid feedback category.");
	}
	if (typeof value.details !== "string") throw new Error("Share a few details before submitting.");
	const details = value.details.trim();
	if (!details) throw new Error("Share a few details before submitting.");
	if (details.length > 10_000) throw new Error("Feedback must be 10,000 characters or fewer.");
	if (typeof value.includeDiagnostics !== "boolean") {
		throw new Error("Choose whether to include diagnostic data.");
	}
	return {
		clientFeedbackId: value.clientFeedbackId,
		category: value.category as ProductFeedbackCategory,
		details,
		includeDiagnostics: value.includeDiagnostics,
	};
}
