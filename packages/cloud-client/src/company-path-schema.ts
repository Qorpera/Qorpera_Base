import { folderKey } from "@qorpera/contracts";

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
	for (const candidate of [value, folderKey(value)]) {
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
