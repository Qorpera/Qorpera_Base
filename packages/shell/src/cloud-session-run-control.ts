/** Member-authenticated controls for one exact cloud conversation/run. No
 * runner credentials, provider output, or local execution enter this lane. */
export interface CloudSessionRun {
	runId: string;
	status: "queued" | "leased";
	canCancel: boolean;
}

export interface CloudSessionRunState {
	sessionId: string;
	staffAgentId: string;
	run: CloudSessionRun | null;
}

export type CloudSessionRunTerminalStatus = "completed" | "failed" | "cancelled";

export type CloudSessionRunRpc = (
	name: "qorpera_get_session_run_control" | "qorpera_cancel_session_run",
	args: Record<string, string>,
	signal: AbortSignal,
) => Promise<{ data: unknown; error: { code?: string } | null }>;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Cloud run control returned an invalid response.");
	}
	return value as Record<string, unknown>;
}

function uuid(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

export class CloudSessionRunControl {
	private readonly rpc: CloudSessionRunRpc;
	private readonly timeoutMs: number;

	constructor(rpc: CloudSessionRunRpc, timeoutMs = 10_000) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
			throw new Error("Cloud run control timeout is invalid.");
		}
		this.rpc = rpc;
		this.timeoutMs = timeoutMs;
	}

	private async request(
		name: Parameters<CloudSessionRunRpc>[0],
		args: Record<string, string>,
	): Promise<Record<string, unknown>> {
		const controller = new AbortController();
		const message =
			name === "qorpera_cancel_session_run"
				? "Could not confirm that the cloud run stopped. Refresh its status before trying again."
				: "Cloud run status is unavailable. Try again.";
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				this.rpc(name, args, controller.signal),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error(message));
					}, this.timeoutMs);
				}),
			]).catch(() => {
				throw new Error(message);
			});
			if (result.error) {
				throw new Error(
					result.error.code === "42501" ? "You do not have permission to control this cloud run." : message,
				);
			}
			return record(result.data);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async read(sessionId: string, staffAgentId: string): Promise<CloudSessionRunState> {
		if (!uuid(sessionId) || !uuid(staffAgentId)) throw new Error("Cloud conversation identity is invalid.");
		const data = await this.request("qorpera_get_session_run_control", { p_session_id: sessionId });
		if (data.session_id !== sessionId || data.staff_agent_id !== staffAgentId) {
			throw new Error("Cloud run status belongs to a different conversation.");
		}
		if (data.run === null) return { sessionId, staffAgentId, run: null };
		const run = record(data.run);
		if (
			!uuid(run.run_id) ||
			(run.status !== "queued" && run.status !== "leased") ||
			typeof run.can_cancel !== "boolean"
		) {
			throw new Error("Cloud run status is invalid.");
		}
		return { sessionId, staffAgentId, run: { runId: run.run_id, status: run.status, canCancel: run.can_cancel } };
	}

	async cancel(sessionId: string, runId: string): Promise<CloudSessionRunTerminalStatus> {
		if (!uuid(sessionId) || !uuid(runId)) throw new Error("Select an exact cloud run to stop.");
		const data = await this.request("qorpera_cancel_session_run", { p_session_id: sessionId, p_run_id: runId });
		if (
			data.session_id !== sessionId ||
			data.run_id !== runId ||
			(data.status !== "cancelled" && data.status !== "completed" && data.status !== "failed")
		) {
			throw new Error("Cloud cancellation was not confirmed for the selected run.");
		}
		return data.status;
	}
}
