# Paid computer accounting monitoring

The read-only checker reports stranded allowance, missing accounting custody, stale observations and guard service availability. It never releases a hold, guesses usage, stops a computer, changes readiness, sends notifications or claims that an absent observation proves physical stop.

Run the database checks against the complete production schema, and the guard checks on every paid runtime host. The current guards are `qorpera-paid-computer-guard.service` (coding), `qorpera-native-computer-guard.service` and `qorpera-office-computer-guard.service`. Configure the exact installed guards; a different active service is not a substitute. Systemd active/running state supplements the guards' independent watchdogs. It is not direct physical-instance inspection. A report with active permits and no configured guard probe fails with `custodyUnverified`.

## Operator installation

An operator applies `deploy/computer-accounting/install-monitor-role.sql` through a trusted database-owner connection. This creates a dedicated `NOLOGIN` role with `BYPASSRLS` and only the required column-level SELECT grants. It has no key-table reads or balance-write grants. Installation refuses an existing role so unexpected inherited grants cannot silently survive. Create a separate login under the deployment's normal authentication policy and grant only membership in this role. The checker explicitly sets that role and `row_security=off`; missing role, grants, schema or complete visibility produces an error, never an empty healthy result. The role's `BYPASSRLS` is for these specific granted reads, not application or user access.

Install Node 24, PostgreSQL 17 `psql`, and these two reviewed files together under a root-owned directory:

- `scripts/computer-accounting-health.mjs`
- `scripts/computer-accounting-health.sql`

Provision a dedicated unprivileged OS account `qorpera-accounting-monitor`. Create `/etc/qorpera/accounting-health` and `/var/lib/qorpera-accounting-health`, owned by this account with mode 0700. Store an account-owned mode 0600 PostgreSQL service file at `/etc/qorpera/accounting-health/pg-service.conf`:

```ini
[qorpera-accounting-health]
host=your-database.example
port=5432
dbname=postgres
user=your_monitor_login
password=provisioned-separately
sslmode=verify-full
sslrootcert=/etc/qorpera/accounting-health/database-ca.pem
```

Use a private Unix socket instead of TCP for an isolated local test. Never copy the production service file into tests. The subprocess excludes inherited PG environment variables, shell startup files and ambient passwords; only the configured private service file supplies the connection. No connection strings or SQL error bodies are logged.

Create mode 0600 `/etc/qorpera/accounting-health/config.json`:

```json
{
  "psqlPath": "/usr/lib/postgresql/17/bin/psql",
  "serviceFile": "/etc/qorpera/accounting-health/pg-service.conf",
  "reportPath": "/var/lib/qorpera-accounting-health/report.json",
  "systemctlPath": "/usr/bin/systemctl",
  "guardUnits": ["qorpera-native-computer-guard.service"],
  "graceSeconds": 60,
  "sampleSeconds": 60
}
```

Use actual absolute, non-symlink executable paths on that host. The sample budget is deliberately longer than the 15-second continuous observation budget and five-second maintenance cadence, allowing ordinary request latency. Both budgets must remain within 30–300 seconds. Expired permit checks include the funded stop margin and then the configured grace. No budget extends execution or releases money.

Run once:

```sh
node /opt/qorpera/accounting-health/computer-accounting-health.mjs \
  --config /etc/qorpera/accounting-health/config.json
```

Exit 0 means the snapshot/probes passed; exit 1 means actionable findings or unverified custody; exit 2 means the probe itself failed. Reports contain fixed codes, counts and at most 20 internal IDs per finding, with no user emails, model credentials, Stripe objects or monetary histories. Full aggregate counts remain visible when ID examples are capped. The report is atomically replaced in a private directory, and the same redacted result goes to stdout. Probe errors go to stderr; an old report must never be interpreted as current.

Install the supplied service and timer from `deploy/computer-accounting/`, verify paths, then enable `qorpera-computer-accounting-health.timer`. It runs every minute with a 90-second overall limit and produces a failed service status for exit 1/2. The service is unprivileged and read only outside its private StateDirectory.

Connect the deployment's existing alert collector to the service's failed status and structured journal, or collect the configured `reportPath`. Configure an additional alarm if `observedAt` is older than two minutes, the timer is inactive, or no report exists. A notification destination is intentionally not hardcoded: an operator can add an `OnFailure=` drop-in naming an already authorized alert service or use its existing metrics collector. Installing these files does not send email, Slack messages, or any other notification. Verify the chosen collector receives a controlled nonzero test before publishing checkout; a local timer without a monitored sink is not an operational alarm.

## Interpreting findings

`permit_expired_open`, `reservation_expired_unsettled`, `closed_permit_unsettled` and `prior_generation_unsettled` require custody/settlement investigation. Settled predecessor windows from legitimate renewal are ignored. `permit_window_missing` and `permit_generation_chain_invalid` identify missing/skipped accounting generations. `hold_missing_prestart_custody` catches legacy/raw holds without a trustworthy immutable prestart; it does not invent cancellation proof.

`bound_identity_missing`, `bound_observation_unconfirmed` and `held_meter_shape_unknown` mean accounting cannot establish the required identity or observation coverage. They do not prove a drain, graceful shutdown, absent VM or stopped service. Inspect the exact host's retained guard journal and operation receipts before recovery. A guard reported unavailable also requires host investigation independently of the last database sample.

`bucket_conservation_mismatch` compares reserved totals against unsettled holds, debits against immutable debit receipts, and `debited + held <= issued`. `reservation_holds_mismatch` checks the original allocation of each reservation. A refund can legitimately leave existing usage and holds above the reduced funded cap, so `fundingShortfallBuckets` is informational and does not fail health. New reservations still obey the current funded cap. Never erase past usage or already-authorized holds to silence this metric.

`billing_command_reconciliation_required` points to an unresolved creation command older than 23 hours. Follow [positive-proof billing recovery](computer-billing-recovery.md). An empty provider search is not permission to create again.

Use the established protected controller/guard recovery paths to resolve incidents. Legacy holds, missing custody, skipped generations and uncertain physical operations need explicit operator investigation. This checker provides neither a mutation endpoint nor an automated refund path.

## Validation

`node --test scripts/computer-accounting-health.test.mjs` verifies redaction, bounded configuration, guard failures and the refund distinction. On disposable Linux, run:

```sh
node scripts/acceptance/accounting-health-native.mjs \
  --bin /usr/lib/postgresql/17/bin \
  --out /tmp/new-accounting-health-evidence
```

This initializes a new private PostgreSQL 17 cluster, applies the real schema, uses the real ledger to create a controlled hold, ages only that fixture, and runs the production checker under its restricted role. It proves the checker leaves held funds intact. A trusted test actor then settles the genuine zero checkpoint, after which the report clears. This is accounting acceptance; it does not substitute for physical failure or an actual deployment alert-delivery test.
