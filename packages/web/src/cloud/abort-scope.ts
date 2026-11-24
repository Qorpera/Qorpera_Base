import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type AbortScope, createAbortScope, withAbortScopes } from "@qorpera/contracts";

export { type AbortScope, createAbortScope, withAbortScopes };

export function withScopedCloudDeadline<T>(
	parents: readonly (AbortSignal | undefined)[],
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return withAbortScopes(parents, (scoped) => withCloudDeadline(operation, timeoutMs, scoped));
}
