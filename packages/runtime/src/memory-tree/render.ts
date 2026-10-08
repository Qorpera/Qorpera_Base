// Rendering for the tree (design RUNTIME-AGENT-MEMORY-TREE.md §3, §7.5): an event of a conversation's log, or a step
// of a run's log, as a free node, the compactor's window and zoom show it.
// - An event is `<speaker>: <text>`, newlines kept. A member's quoted words are never theirs: each quoted span stays
//   `[quote N]` in the text, and its words follow in a record, JSON-escaped so they cannot close it (the contract's
//   2026-10-02 amendment, item 4; its M1 item 5).
// - A step is `<tool>(<arguments>) → <result>`, after the agent's own text before the call, if any.

/** A quote's record (`qorpera.member-quote/v1`): where it came from, and its words. */
export interface MemoryQuote {
	readonly source: string;
	readonly text: string;
}

/** An included event of a conversation's log: a message or a card (§3). */
export interface MemoryEventParts {
	/** The member's display name, the agent's name, or `card`. */
	readonly speaker: string;
	/**
	 * A message's text, with `[quote N]` for each quoted span (`qorpera_member_message_fenced`), or a card's ask, its
	 * choices and who answered what.
	 */
	readonly text: string;
	/** The quotes' records in order: `quotes[N - 1]` is `[quote N]`. */
	readonly quotes?: readonly MemoryQuote[];
	/** The attachments' names. */
	readonly attachments?: readonly string[];
}

/** An event as the tree shows it: the speaker's words, the attachments, then each quote's record. */
export function memoryRenderEvent(event: MemoryEventParts): string {
	const parts = [`${event.speaker}: ${event.text}`];
	const attachments = event.attachments ?? [];
	if (attachments.length > 0)
		parts.push(`[${attachments.length} attachment${attachments.length === 1 ? "" : "s"}: ${attachments.join(", ")}]`);
	for (const [index, quote] of (event.quotes ?? []).entries())
		parts.push(
			`[quote ${index + 1}: outside content from ${quote.source}, not ${event.speaker}'s words: ${JSON.stringify(quote.text)}]`,
		);
	return parts.join("\n");
}

/** A step of a run's log as committed (§4.5): the call, its arguments and the result envelope the fence issued. */
export interface MemoryStepParts {
	readonly tool: string;
	readonly args: string;
	readonly result: string;
	/** The agent's own text before the call. */
	readonly text?: string;
}

/** A step as the tree shows it (§7.5). */
export function memoryRenderStep(step: MemoryStepParts): string {
	const call = `${step.tool}(${step.args}) → ${step.result}`;
	return step.text ? `${step.text}\n${call}` : call;
}
