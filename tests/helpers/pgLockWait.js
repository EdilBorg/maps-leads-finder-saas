/**
 * Deterministic wait until one PostgreSQL backend is blocked by another.
 * Uses pg_blocking_pids — not wall-clock guesses.
 */

async function waitUntilBlockedBy(queryable, waitingPid, blockerPid, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await queryable.query(
      `SELECT pg_blocking_pids($1::int) AS blockers`,
      [waitingPid]
    );
    const blockers = rows[0] && rows[0].blockers ? rows[0].blockers : [];
    if (Array.isArray(blockers) && blockers.map(Number).includes(Number(blockerPid))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `Timeout: backend ${waitingPid} was not blocked by ${blockerPid} within ${timeoutMs}ms`
  );
}

async function backendPid(client) {
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
  return rows[0].pid;
}

module.exports = { waitUntilBlockedBy, backendPid };
