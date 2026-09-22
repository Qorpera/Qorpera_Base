import { readFile, writeFile } from "node:fs/promises";
import { planNodeBuilderInventory } from "./node-builder-inventory-plan.mjs";

if (process.argv.length !== 4) throw new Error("Usage: node scripts/prepare-node-builder-inventory.mjs INPUT.json NEW_PLAN.json");
const input = await readFile(process.argv[2]);
if (input.length > 4 * 1024 * 1024) throw new Error("BUILDER_INVENTORY_INPUT_TOO_LARGE");
const plan = planNodeBuilderInventory(JSON.parse(input.toString("utf8")));
await writeFile(process.argv[3], `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ reviewOnly: true, nodeId: plan.nodeId, budget: plan.budget }));
