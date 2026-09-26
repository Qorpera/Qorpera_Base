import assert from "node:assert/strict";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const integer = (value) => {
	assert(typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)), "Exact nonnegative integer required");
	const result = BigInt(value);
	assert(result >= 0n, "Negative usage counter");
	return result;
};

/** Independent integer oracle: max(CPU/reference, RAM/reference), rounded once
 * at the cumulative microsecond boundary. It consumes observed active time,
 * never manufactures uptime or infers missing physical intervals. */
export function normalizedUsageUs(activeMs, shape, tariff, kind) {
	assert(["agent_sandbox", "company_computer", "coding_machine", "login_helper"].includes(kind), "Unknown workload kind");
	const active = integer(activeMs);
	if (kind === "login_helper" || active === 0n) return 0n;
	assert(shape, "Unknown shape cannot be billed");
	const cpu = integer(shape.cpuMillis), memory = integer(shape.memoryBytes);
	const referenceCpu = integer(tariff.reference_cpu_millis), referenceMemory = integer(tariff.reference_memory_bytes);
	assert(cpu > 0n && memory > 0n && referenceCpu > 0n && referenceMemory > 0n, "Positive resource shape required");
	const [numerator, denominator] = cpu * referenceMemory >= memory * referenceCpu ? [cpu, referenceCpu] : [memory, referenceMemory];
	return (active * 1000n * numerator + denominator - 1n) / denominator;
}

/** Read only. Call against the same fresh native PostgreSQL cluster used by
 * the real controller. The query never selects credentials or request bodies. */
export async function readWorkloadUsage(query, permitId) {
	assert(uuid.test(permitId), "Exact permit UUID required");
	const raw = await query(`with p as (select * from public.qorpera_coding_computer_permits where id='${permitId}'::uuid),
 s as (select usage.* from public.qorpera_computer_usage_streams usage join p on usage.allocation_id=p.allocation_id and usage.epoch=p.epoch),
 r as (select reservation.* from public.qorpera_computer_allowance_reservations reservation join p on reservation.allocation_id=p.allocation_id and reservation.epoch=p.epoch)
 select jsonb_build_object(
 'permit',(select jsonb_build_object('id',p.id,'allocation_id',p.allocation_id,'epoch',p.epoch,
   'host_boot_id',p.host_boot_id,'physical_id',p.physical_id,'guest_boot_id',p.guest_boot_id,
   'state',p.state,'generation',p.generation,'closed_at',p.closed_at) from p),
 'stream',(select to_jsonb(s)||jsonb_build_object('active_ms',s.active_ms::text,'elapsed_ms',s.elapsed_ms::text) from s),
 'tariff',(select to_jsonb(t) from public.qorpera_computer_tariff_versions t join s on t.version=s.tariff_version),
 'samples',coalesce((select jsonb_agg(to_jsonb(sample) order by sequence) from public.qorpera_coding_computer_samples sample where permit_id='${permitId}'::uuid),'[]'),
 'checkpoints',coalesce((select jsonb_agg(to_jsonb(cp)||jsonb_build_object('active_ms',cp.active_ms::text,'elapsed_ms',cp.elapsed_ms::text) order by cp.sequence) from public.qorpera_computer_usage_receipts cp join p on cp.allocation_id=p.allocation_id and cp.epoch=p.epoch),'[]'),
 'reservations',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('reserved_us',r.reserved_us::text,'from_standard_us',r.from_standard_us::text) order by r.created_at,r.id) from r),'[]'),
 'holds',coalesce((select jsonb_agg(to_jsonb(h)||jsonb_build_object('amount_us',h.amount_us::text,'user_id',b.user_id) order by h.reservation_id,h.draw_order) from public.qorpera_computer_allowance_holds h join r on r.id=h.reservation_id join public.qorpera_computer_allowance_buckets b on b.id=h.bucket_id),'[]'),
 'settlements',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('total_standard_us',d.total_standard_us::text,'debited_us',d.debited_us::text,'released_us',d.released_us::text) order by d.created_at,d.reservation_id) from public.qorpera_computer_allowance_settlements d join r on r.id=d.reservation_id),'[]'),
 'debits',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('debited_us',d.debited_us::text,'released_us',d.released_us::text) order by d.reservation_id,d.bucket_id) from public.qorpera_computer_allowance_debits d join r on r.id=d.reservation_id),'[]')
 )::text;`);
	return JSON.parse(raw);
}

/** Reconcile every physical sample, immutable checkpoint and money movement.
 * expected.physicalSamples must be captured from actual controller RPC calls,
 * not constructed by this oracle. Matching identity is necessary but does not
 * independently attest a host; the calling real-LXD harness supplies provenance. */
export function verifyWorkloadUsage(evidence, expected) {
	const { permit, stream, tariff, samples, checkpoints, reservations, holds, settlements, debits } = evidence;
	assert(permit && stream && tariff, "Paid permit and pinned stream required");
	assert.equal(stream.resource_kind, expected.kind, "Workload identity differs");
	assert.deepEqual(stream.resource_shape, expected.shape, "Admitted physical shape differs");
	assert.equal(permit.physical_id, expected.physicalId, "Physical VM identity differs");
	assert.equal(permit.host_boot_id, expected.hostBootId, "Host boot differs");
	assert.equal(permit.guest_boot_id, expected.guestBootId, "Guest boot differs");
	assert(Array.isArray(expected.physicalSamples) && expected.physicalSamples.length > 0, "Actual observed samples required");
	const observed = new Map();
	for (const sample of expected.physicalSamples) {
		const old = observed.get(sample.observationId);
		if (old) assert.deepEqual(sample, old, "Physical observation replay changed");
		observed.set(sample.observationId, sample);
	}
	assert.equal(samples.length, observed.size, "SQL sample coverage differs from successful physical calls");
	assert.equal(checkpoints.length, samples.length + 1, "Extra/missing machine checkpoint (possible per-session billing)");
	assert.equal(checkpoints[0].sequence, 0);
	assert.equal(integer(checkpoints[0].active_ms), 0n);
	assert.equal(integer(checkpoints[0].elapsed_ms), 0n);
	let active = 0n, elapsed = 0n, previous = null, continuous = 0, gaps = 0;
	for (const [index, record] of samples.entries()) {
		const sample = record.sample, checkpoint = checkpoints[index + 1];
		assert.deepEqual(sample, observed.get(sample.observationId), "SQL sample differs from real controller observation");
		assert.equal(record.sequence, index + 1);
		assert.equal(checkpoint.sequence, record.sequence);
		assert.equal(sample.previousObservationId, previous?.observationId ?? null, "Observation chain broken");
		assert.equal(sample.hostBootId, expected.hostBootId);
		let coverage = previous ? "gap" : "initial";
		if (sample.state === "running") {
			assert.equal(sample.physicalId, expected.physicalId);
			assert.equal(sample.guestBootId, expected.guestBootId);
			assert(Number.isSafeInteger(sample.guestUptimeMs), "Real guest uptime missing");
		}
		if (previous && previous.hostBootId === sample.hostBootId) {
			const host = integer(sample.hostUptimeMs) - integer(previous.hostUptimeMs);
			assert(host >= 0n, "Host uptime moved backwards");
			elapsed += host;
			if (sample.state === "running" && previous.state === "running") {
				const guest = integer(sample.guestUptimeMs) - integer(previous.guestUptimeMs);
				const wall = Date.parse(sample.observedAt) - Date.parse(previous.observedAt);
				if (host <= 15000n && guest >= 0n && Math.abs(Number(guest - host)) <= 1000 && Math.abs(wall - Number(host)) <= 1000) {
					active += guest < host ? guest : host;
					coverage = "continuous"; continuous++;
				}
			}
		}
		if (["stopped", "absent"].includes(sample.state)) coverage = "terminal";
		if (coverage === "gap") gaps++;
		assert.equal(record.coverage, coverage, "SQL coverage differs from clocks");
		assert.equal(integer(checkpoint.active_ms), active, "SQL active time over/under-counted");
		assert.equal(integer(checkpoint.elapsed_ms), elapsed, "SQL elapsed time differs");
		assert.equal(checkpoint.evidence_sha256, sample.evidenceSha256);
		previous = sample;
	}
	assert.equal(integer(stream.active_ms), active);
	assert.equal(integer(stream.elapsed_ms), elapsed);
	assert(active > 0n && continuous > 0, "No real continuous awake interval proved");
	let totalDebit = 0n, totalReleased = 0n;
	assert.equal(new Set(settlements.map((row) => row.reservation_id)).size, settlements.length, "Duplicate settlement");
	for (const settlement of settlements) {
		const reservation = reservations.find((row) => row.id === settlement.reservation_id);
		const cp = checkpoints.find((row) => row.sequence === settlement.through_sequence);
		assert(reservation && cp, "Settlement lacks immutable reservation/checkpoint");
		const total = normalizedUsageUs(cp.active_ms, stream.resource_shape, tariff, stream.resource_kind);
		const cost = total - integer(reservation.from_standard_us);
		assert.equal(integer(settlement.total_standard_us), total, "Cumulative rounding differs");
		assert.equal(integer(settlement.debited_us), cost, "Settlement debit differs");
		assert.equal(integer(settlement.released_us), integer(reservation.reserved_us) - cost, "Unused hold was not restored");
		let remainder = cost, held = 0n;
		const shares = holds.filter((row) => row.reservation_id === reservation.id).sort((a, b) => a.draw_order - b.draw_order);
		assert(shares.length > 0, "Reservation has no source allowance");
		if (expected.firstPayerByReservation?.[reservation.id]) assert.equal(shares[0].user_id, expected.firstPayerByReservation[reservation.id], "Responsible member was not charged first");
		for (const [index, share] of shares.entries()) {
			assert.equal(share.draw_order, index + 1);
			const entries = debits.filter((row) => row.reservation_id === reservation.id && row.bucket_id === share.bucket_id);
			assert.equal(entries.length, 1, "Missing/duplicate source debit");
			const amount = integer(share.amount_us), charged = remainder < amount ? remainder : amount;
			assert.equal(integer(entries[0].debited_us), charged, "Pool debit order differs");
			assert.equal(integer(entries[0].released_us), amount - charged, "Pool remainder refunded to wrong source");
			held += amount; remainder -= charged;
		}
		assert.equal(held, integer(reservation.reserved_us));
		assert.equal(remainder, 0n);
		totalDebit += cost; totalReleased += integer(settlement.released_us);
	}
	if (expected.closed !== false) {
		assert.equal(permit.state, "closed"); assert.equal(stream.closed, true);
		assert.equal(settlements.length, reservations.length, "Stopped VM retained an unsettled hold");
		assert.equal(totalDebit, normalizedUsageUs(active, stream.resource_shape, tariff, stream.resource_kind), "Final cumulative charge differs");
	}
	return { schema: "qorpera.workload-usage-reconciliation/v1", resourceKind: stream.resource_kind,
		permitId: permit.id, allocationId: permit.allocation_id, physicalId: permit.physical_id,
		shape: stream.resource_shape, samples: samples.length, continuousIntervals: continuous, gapIntervals: gaps,
		activeMs: active.toString(), elapsedMs: elapsed.toString(), debitedUs: totalDebit.toString(),
		releasedUs: totalReleased.toString(), reservations: reservations.length, passed: true };
}

/** Attribute already reconciled physical intervals to idle and busy phases.
 * These are cumulative-tariff allocations of the final debit, not separate
 * settlements. Busy boundaries come from the completed guest process's actual
 * Linux boot clock; both endpoints must be inside that observed execution. */
export function verifyWorkloadActivity(evidence, activity) {
	const { samples, checkpoints, stream, tariff } = evidence;
	const { startedGuestUptimeMs: start, finishedGuestUptimeMs: end } = activity.completion;
	assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start, "Guest workload clock required");
	const idleIds = new Set(activity.idleObservationIds);
	assert.equal(idleIds.size, 2, "Two distinct idle observations required");
	const phases = { idle: { active: 0n, charge: 0n, observations: [] }, busy: { active: 0n, charge: 0n, observations: [] } };
	for (let index = 1; index < samples.length; index++) {
		const previous = samples[index - 1], current = samples[index];
		let phase;
		if (idleIds.has(current.sample.observationId)) {
			assert(current.sample.guestUptimeMs <= start, "Idle interval overlaps guest workload");
			phase = phases.idle;
		} else if (previous.sample.guestUptimeMs >= start && current.sample.guestUptimeMs <= end
			&& current.sample.state === "running" && previous.sample.state === "running") phase = phases.busy;
		if (!phase) continue;
		assert.equal(current.coverage, "continuous", "Workload phase lacks continuous physical coverage");
		const before = checkpoints.find((row) => row.sequence === previous.sequence);
		const after = checkpoints.find((row) => row.sequence === current.sequence);
		assert(before && after, "Workload phase lacks immutable checkpoints");
		phase.active += integer(after.active_ms) - integer(before.active_ms);
		phase.charge += normalizedUsageUs(after.active_ms, stream.resource_shape, tariff, stream.resource_kind)
			- normalizedUsageUs(before.active_ms, stream.resource_shape, tariff, stream.resource_kind);
		phase.observations.push(current.sample.observationId);
	}
	assert.equal(phases.idle.observations.length, 2, "Idle observations missing from actual SQL samples");
	assert(phases.idle.active >= 1000n && phases.busy.active >= 5000n, "Insufficient observed idle/busy physical time");
	return { schema: "qorpera.workload-activity-reconciliation/v1", tariffVersion: stream.tariff_version,
		shape: stream.resource_shape, phases: Object.fromEntries(Object.entries(phases).map(([name, phase]) => [name,
			{ activeMs: phase.active.toString(), allocatedStandardUs: phase.charge.toString(), observationIds: phase.observations }])),
		passed: true };
}
