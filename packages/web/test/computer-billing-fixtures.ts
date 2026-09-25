import type { ComputerPlanCatalog, ComputerUsage } from "../src/cloud/computer-billing.ts";

export const computerCatalog: ComputerPlanCatalog = {
	meterMode: "shadow",
	plans: [
		{
			planKey: "basis",
			version: 1,
			name: "Basis",
			currency: "DKK",
			monthlyPriceMinor: 18500,
			advertisedHours: 74,
			allowanceKind: "hours",
			activeForCheckout: false,
			tariffVersion: 1,
		},
	],
};
export const computerUsage: ComputerUsage = {
	meterMode: "shadow",
	checkoutAvailable: false,
	portalAvailable: false,
	runtimeAccountingReady: false,
	subscriptions: [],
	balance: {
		issuedUs: "266400000000",
		reservedUs: "3600000000",
		debitedUs: "7200000000",
		availableUs: "255600000000",
	},
	standardComputer: { cpuMillis: 4000, memoryBytes: 8589934592, tariffVersion: 1 },
};
export const catalogResponse = () => ({
	schema: "qorpera.computer-plan-catalog/v1",
	...structuredClone(computerCatalog),
});
export const usageResponse = () => ({
	schema: "qorpera.my-computer-usage/v1",
	...structuredClone(computerUsage),
	balance: { unit: "standard_computer_microsecond", ...computerUsage.balance },
});
