/** A normalized inbound event a webhook adapter projects for a routine. The
 * desktop only receives and persists these; the Runner Orchestrator owns
 * trigger evaluation and every routine run. */
export interface RoutineTriggerEvent {
	id: string;
	source: string;
	type: string;
	repository?: string;
	actor?: string;
	occurredAt: string;
	summary: string;
	payload: Record<string, unknown>;
}
