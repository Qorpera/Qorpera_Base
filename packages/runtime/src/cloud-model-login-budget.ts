/** Every step of one Codex renewal ends inside this budget, well within the vault's 35 s. The
 * helper answers inside it plus a few seconds, and the broker waits a little longer again. */
export const CODEX_RENEWAL_BUDGET_MS = 25_000;
