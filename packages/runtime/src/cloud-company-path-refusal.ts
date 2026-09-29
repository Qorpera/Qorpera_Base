import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

/** A complete, validated PostgreSQL 42501 response proves rejection of that
 * transaction only. It says nothing about earlier effects in a tool adapter. */
export class CloudCompanyPathRpcRefusal extends CloudRuntimeDiagnosticError {
	constructor() {
		super("authority_unavailable", "Company File authority unavailable");
	}
}

/** A complete PostgREST PGRST202 response: the database has no such function yet
 * (a runtime ahead of its migration). Nothing ran. Branded only for the one-call context
 * fence, which falls back to the separate calls it replaces. */
export class CloudCompanyPathRpcMissing extends CloudRuntimeDiagnosticError {
	constructor() {
		super("unavailable_tool", "Company File authority unavailable");
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

/** A complete, validated PostgREST PT412 response: that transaction was refused
 * on a request precondition the caller bound (a version, snapshot or ticket).
 * Like the refusal above, it says nothing about earlier effects in an adapter. */
export class CloudCompanyPathRpcPrecondition extends CloudRuntimeDiagnosticError {
	constructor() {
		super("stale_version", "Company File authority unavailable");
	}
}

/** Only the Company File gateway promotes a precondition refusal of its own
 * check, prepare or commit. Each of those transactions replays a completed
 * operation key before it tests the expected version (or another precondition
 * on the path's current state), and a refusal rolls it back whole: the path is
 * not as the caller last saw it and this mutation wrote nothing (contract 5.2:
 * a typed stale-version result). Never infer this brand from any other RPC or text. */
export class CloudCompanyPathVersionChanged extends CloudRuntimeDiagnosticError {
	constructor() {
		super("stale_version", "Company File path version changed");
	}
}

/** A complete, validated PostgREST PT424 response: the check that runs inside
 * that transaction found no folder at the path's parent (20260926203300). Like
 * the refusals above, it says nothing about earlier effects in an adapter. */
export class CloudCompanyPathRpcParentMissing extends CloudRuntimeDiagnosticError {
	constructor() {
		super("parent_missing", "Company File authority unavailable");
	}
}

/** Only the Company File gateway's mutate() promotes a missing-folder refusal
 * of its own check, prepare or commit (each runs the same check, which a
 * refusal rolls back whole), or finds the plan's own folder missing from the
 * entries prepare listed, before its commit. The gateway never invents parent
 * folders: this write or mkdir changed nothing, and succeeds once the folder
 * exists. Never infer this brand from any other RPC or text. */
export class CloudCompanyPathParentMissing extends CloudRuntimeDiagnosticError {
	constructor() {
		super("parent_missing", "Company File parent folder is missing");
	}
}

/** Only the Company File gateway's mutate() raises this, after its check and
 * before it stages anything: a write of organization/formation.json that the
 * organization projection would refuse over the file's current version (see
 * cloud-company-formation.ts). Nothing was staged, proposed or written. The
 * reason names only fixed formation keys and whole numbers, never the text. */
export class CloudCompanyFormationRefused extends CloudRuntimeDiagnosticError {
	readonly reason: string;
	constructor(reason: string) {
		super("invalid_arguments", "Company formation write refused");
		this.reason = reason;
	}
}

/** A complete PostgREST error from one of the folder core's entry points (`qorpera_folder_read`, `_list`, `_commit`,
 * `_record_release`), with its SQLSTATE (or PostgREST's own `PGRST1nn`-`PGRST3nn`, for a request nothing ran) and
 * message. The folder client alone decides what each means (core C3): a
 * stop, a run that is no longer live, a read the run may no longer see, or a change it retries with the same key. */
export class CloudCompanyFolderRpcError extends CloudRuntimeDiagnosticError {
	readonly code: string;
	readonly #detail: string;

	constructor(code: string, message: string) {
		super(
			code.startsWith("22") || code === "25000" || code.startsWith("PGRST1") || code.startsWith("PGRST2")
				? "invalid_arguments"
				: code === "42501" || code === "0A000" || code === "55000" || code.startsWith("PGRST3")
					? "authority_unavailable"
					: "transport_unavailable",
			"Company folder authority unavailable",
		);
		this.code = code;
		this.#detail = message.slice(0, 200);
	}

	/** SQL's message, for the folder client to tell its refusals apart. It is kept off the error's text and out of
	 * its serialization, so SQL's words reach no model and no log. */
	get detail(): string {
		return this.#detail;
	}
}
