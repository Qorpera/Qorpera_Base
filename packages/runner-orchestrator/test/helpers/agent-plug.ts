import { type AgentPlug, withAgentPlug } from "../../src/agent-plug.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../../src/lxd-office-guest.ts";

/** The MAC a test machine's agent card carries (as the agent plug gives it). */
export const testAgentMac = "0e:51:0a:d2:01:01";
/** A fake agent plug: every machine gets testAgentMac. */
export const testAgentPlug: AgentPlug = async () => testAgentMac;
/** A Company Computer's create request as its creator sends it: the agent card carries testAgentMac. */
export function pluggedOfficeRequest(binding: LxdOfficeGuestBinding) {
	return withAgentPlug(lxdOfficeGuestPlan(binding).request, "plug", testAgentMac);
}
