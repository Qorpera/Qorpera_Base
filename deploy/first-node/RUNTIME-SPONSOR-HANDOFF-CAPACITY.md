# Sponsor handoff capacity

A usage-limit handoff could select a native provider connection whose allowed
execution slots were already occupied. The next attempt then rebound the old
lease row and returned before the normal acquisition capacity check, allowing
two active leases on a connection limited to one.

The disposable PostgreSQL regressions reproduced both defects before the fix:
selection chose the full connection instead of the next free connection, and
an acquisition after another job took the selected slot succeeded instead of
returning SQLSTATE `55000`.

Migration `20260906000300` filters candidates by active authorization, enabled
native policy and available capacity. Rebinding checks capacity again while
holding the existing target-connection row lock. Rejection occurs before the
old lease is archived or rebound, preserving its exact state and history.
Successful acquisition and active replay retain one historical lease record.
The original effect fence, same-principal selection, notifications and grants
remain in place. Each function replacement checks its expected source text.

Regression coverage uses real login, member admission, runner assignment and
lease entrypoints in an isolated database. Provider credentials and usage
signals are explicitly synthetic fixtures. Cases cover an occupied fallback,
capacity consumed between selection and acquisition, subsequent acquisition
after capacity is released, exact active replay, no available fallback,
reauthentication-required authorization, and separate rate-limit/outage
failures without a handoff. Existing successful continuation coverage remains.

The candidate bundle is v10:
`7bfd6cd12160a3b5119e7727374e28d854c1004de6640f12c40446b21d67764e`.
Its activation is a new migration; historical v9 is unchanged. Local database
tests do not replace the outstanding real provider usage-limit and sponsor
continuation acceptance gate. See the [acceptance ledger](RUNTIME-STEPS-0-3-ACCEPTANCE.md)
for deployment status and live proof limits.
