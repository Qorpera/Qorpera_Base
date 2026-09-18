import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

/** A complete, validated PostgreSQL 42501 response proves rejection of that
 * transaction only. It says nothing about earlier effects in a tool adapter. */
export class CloudCompanyPathRpcRefusal extends CloudRuntimeDiagnosticError {
	constructor() {
		super("authority_unavailable", "Company File authority unavailable");
	}
}

/** Only the Company File gateway promotes a transaction refusal at its initial
 * admission, before it stages objects, registers presence or attempts a commit.
 * Never infer this brand from an HTTP status, diagnostic category or raw text. */
export class CloudCompanyPathToolRefusal extends CloudRuntimeDiagnosticError {
	constructor() {
		super("authority_unavailable", "Company File access denied");
	}
}
