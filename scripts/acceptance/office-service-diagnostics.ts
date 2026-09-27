import { companyComputerFailureDiagnostic } from "../../packages/runtime/src/cloud-company-computer-diagnostics.ts";

const categoryCodes: Record<string, string> = {
	"filesystem-not-found": "ENOENT",
	"filesystem-permission": "EACCES",
	"filesystem-read-only": "EROFS",
	"resource-capacity": "ENOSPC",
	"resource-memory": "ENOMEM",
	"resource-file-descriptors": "EMFILE",
	transport: "ECONNRESET",
};

/** Guest logs are untrusted. Reproject only the service's closed failure record
 * through the production allowlist; discard every raw line and extra field. */
export function officeServiceFailureDiagnostics(text: string) {
	if (Buffer.byteLength(text) > 65536) throw new Error("OFFICE_SERVICE_DIAGNOSTIC_LIMIT");
	const result: ReturnType<typeof companyComputerFailureDiagnostic>[] = [];
	for (const line of text.split("\n").slice(-64)) {
		if (Buffer.byteLength(line) > 8192) continue;
		let value: unknown;
		try { value = JSON.parse(line); } catch { continue; }
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const record = value as Record<string, unknown>;
		if (record.schema !== "qorpera.office-service-failure/v1" ||
			Object.keys(record).some(key => !["schema", "stages", "codes", "categories", "staleStatus"].includes(key)) ||
			![record.stages, record.codes, record.categories].every(values => Array.isArray(values) && values.length <= 16 && values.every(entry => typeof entry === "string" && entry.length <= 128))) continue;
		const diagnostic = companyComputerFailureDiagnostic({ errors: [
			...(record.stages as string[]).map(stage => ({ stage })),
			...(record.codes as string[]).map(message => ({ message })),
			...(record.categories as string[]).map(category => Object.hasOwn(categoryCodes, category) ? { code: categoryCodes[category] } : { category }),
		] });
		result.push(diagnostic);
		if (result.length === 8) break;
	}
	return result;
}
