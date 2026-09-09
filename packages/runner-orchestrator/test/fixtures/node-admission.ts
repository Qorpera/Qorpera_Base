/** Unit-test registry response only; the PostgreSQL driver proves the ledger. */
export function nodeAdmissionFixture(args: Record<string, unknown>) {
	return {
		state: "reserved",
		allocationId: args.p_allocation_id,
		nodeId: "36000000-0000-4000-8000-000000000010",
		nodeVersion: 1,
		instanceSha256: args.p_instance_sha256,
		cpuMillis: args.p_cpu_millis,
		memoryBytes: args.p_memory_bytes,
		validForMs: 5000,
	};
}
