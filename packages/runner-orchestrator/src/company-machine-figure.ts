import {
	drawnStaffCharacter,
	STAFF_CHARACTER_BY_TEMPLATE,
	STAFF_CHARACTER_IDS,
	type StaffCharacterId,
} from "@qorpera/cloud-client/staff-characters";
import { isUuid } from "@qorpera/contracts";

/** Where a machine names the figure of the agent it was started by: one word, root's file, which the machine's desktop
 * reads at every `desktop start` and while it runs (deploy/machine/desktop-look). A machine without it, or with a word
 * its image has no backdrop for, shows the neutral backdrop. */
export const COMPANY_MACHINE_DESKTOP_FIGURE = "/etc/qorpera-machine/desktop-figure";

/** The founding agent's template is not a hireable one; every client draws it as the crown. */
const BY_TEMPLATE: Readonly<Record<string, StaffCharacterId>> = Object.freeze({
	"co-founder": "crown",
	...STAFF_CHARACTER_BY_TEMPLATE,
});

/**
 * The figure every client draws for the agent a machine was started by, from what SQL lists of it
 * (qorpera_list_executor_machines' `starter`, 20260930737000): the saved figure (a retired one's replacement: a saved
 * ghost is drawn as the moon), else its template's, else a stable one from its id. The same rule as the web client's
 * `figureFor` and the office desktop's `companyComputerScreenCharacter`; a test holds the three together.
 *
 * Nothing (undefined) for a starter SQL did not name: an SQL from before the migration, an agent whose row is gone, or
 * an answer that is not a starter's. The machine's desktop then shows the neutral backdrop.
 */
export function companyMachineDesktopFigure(starter: unknown): StaffCharacterId | undefined {
	if (!starter || typeof starter !== "object" || Array.isArray(starter)) return undefined;
	const { staffAgentId, figure, templateId } = starter as Record<string, unknown>;
	if (!isUuid(staffAgentId)) return undefined;
	const saved = drawnStaffCharacter(figure);
	if (saved) return saved;
	if (typeof templateId === "string" && Object.hasOwn(BY_TEMPLATE, templateId)) return BY_TEMPLATE[templateId];
	let seed = 0;
	for (const character of staffAgentId) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
	return STAFF_CHARACTER_IDS[seed % STAFF_CHARACTER_IDS.length];
}
