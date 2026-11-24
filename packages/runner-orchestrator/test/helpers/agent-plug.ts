import type { AgentPlug } from "../../src/agent-plug.ts";

/** The MAC a test machine's agent card carries (as the agent plug gives it). */
export const testAgentMac = "0e:51:0a:d2:01:01";
/** A fake agent plug: every machine gets testAgentMac. */
export const testAgentPlug: AgentPlug = async () => testAgentMac;
