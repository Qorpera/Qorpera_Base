import type { AgentState } from "../app/company.ts";
import type { Activity } from "./figure-motion.ts";

export interface AgentLook {
	figure: Activity;
	line?: string;
	note?: string;
	disc?: "working" | "failed";
}

/** One visual vocabulary for the sidebar and the conversation. Thinking is
 * the motion studio's name for the agent-coloured, unframed writing dots. */
export const AGENT_LOOK: Record<AgentState, AgentLook> = {
	idle: { figure: "Idle" },
	working: { figure: "Working", line: "Working", disc: "working" },
	writing: { figure: "Thinking", line: "Writing", disc: "working" },
	decision: { figure: "Waiting", line: "Needs you" },
	failed: { figure: "Idle", note: "A run did not finish", disc: "failed" },
};
