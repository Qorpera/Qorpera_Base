/** Representation checks only. Path and audience authorization lives in SQL. Under code/ (by the key's first name), a
 * name may hold '%' and ':' and may be a device name, as `qorpera_company_path_valid` allows (20260930446100). */
export function parseCloudCompanyPath(value: unknown, allowRoot = false): string {
	if (allowRoot && value === "") return value;
	if (
		typeof value !== "string" ||
		!value ||
		new TextEncoder().encode(value).byteLength > 4096 ||
		value.normalize("NFC") !== value
	)
		throw new Error("Invalid Company File path");
	const key = value.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
	const code = key.split("/")[0] === "code";
	for (const candidate of [value, key]) {
		if (
			/[\u0000-\u001f\u007f-\u009f\\]/.test(candidate) ||
			(!code && candidate.includes("%")) ||
			candidate.split("/").length !== value.split("/").length ||
			candidate
				.split("/")
				.some(
					(part) =>
						!part ||
						part === "." ||
						part === ".." ||
						/[. ]$/.test(part) ||
						(!code &&
							(part.includes(":") ||
								/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\..*)?$/i.test(part))),
				)
		)
			throw new Error("Invalid Company File path");
	}
	return value;
}

/** A path inside `parent` (a new folder's contents): the folder core checks only the joined path, so its first name
 * decides here too. Returns the inner path. */
export function parseCloudCompanyInnerPath(parent: string, value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("Invalid Company File path");
	parseCloudCompanyPath(`${parent}/${value}`);
	return value;
}
