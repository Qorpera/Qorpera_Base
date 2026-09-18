import { describe, expect, it } from "vitest";
import { assertLxdOfficeVmLineageCommands, type LxdOfficeVmLineageCommand } from "../src/lxd-office-vm-lineage.ts";

const commands = (...actions: LxdOfficeVmLineageCommand["action"][]) =>
	actions.map((action, index) => ({
		commandId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
		action,
	}));
describe("retained VM command grammar", () => {
	it("permits repeated governed reset and normal boot groups without losing the initial create", () => {
		expect(() =>
			assertLxdOfficeVmLineageCommands(
				commands(
					"create",
					"start",
					"stop",
					"delete",
					"create",
					"start",
					"stop",
					"start",
					"stop",
					"delete",
					"create",
					"start",
				),
				true,
			),
		).not.toThrow();
	});
	it.each([
		["start", "stop"],
		["create", "delete"],
		["create", "start", "create"],
		["create", "start", "delete"],
		["create", "start", "stop", "delete", "start"],
		["create", "start", "stop", "delete", "create", "delete"],
	] as LxdOfficeVmLineageCommand["action"][][])("rejects an impossible physical sequence %j", (...actions) => {
		expect(() => assertLxdOfficeVmLineageCommands(commands(...actions))).toThrow("OFFICE_VM_LINEAGE_UNCONFIRMED");
	});
	it("rejects reused command identity and incomplete running prefixes", () => {
		const sequence = commands("create", "start", "stop", "start");
		sequence[3].commandId = sequence[1].commandId;
		expect(() => assertLxdOfficeVmLineageCommands(sequence)).toThrow();
		expect(() => assertLxdOfficeVmLineageCommands(commands("create", "start", "stop"), true)).toThrow();
	});
});
