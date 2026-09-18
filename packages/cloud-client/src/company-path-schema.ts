import type { CloudCompanyTreeEntry } from "./node/cloud-company-snapshot.ts";

export interface CloudCompanyPathPlan {
	schema: "qorpera.company-path-mutation/v1";
	operationKey: string;
	path: string;
	expectedVersion: string | null;
	entry: CloudCompanyTreeEntry | null;
}

/** Representation checks only. Path and audience authorization lives in SQL. */
export function parseCloudCompanyPath(value: unknown, allowRoot = false): string {
	if (allowRoot && value === "") return value;
	if (
		typeof value !== "string" ||
		!value ||
		new TextEncoder().encode(value).byteLength > 4096 ||
		value.normalize("NFC") !== value
	)
		throw new Error("Invalid Company File path");
	for (const candidate of [value, value.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC")]) {
		if (
			/[\u0000-\u001f\u007f-\u009f\\%]/.test(candidate) ||
			candidate.split("/").length !== value.split("/").length ||
			candidate
				.split("/")
				.some(
					(part) =>
						!part ||
						part === "." ||
						part === ".." ||
						part.includes(":") ||
						/[. ]$/.test(part) ||
						/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\..*)?$/i.test(part),
				)
		)
			throw new Error("Invalid Company File path");
	}
	return value;
}
