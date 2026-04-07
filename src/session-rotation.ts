/**
 * Decide whether to rotate a group's Agent SDK session based on idle time.
 *
 * Returns true if there is no prior turn recorded, or if the time since the
 * last turn exceeds the configured idle window. The caller should then pass
 * `sessionId: undefined` to the container runner so a fresh session starts.
 *
 * Pure function — no side effects, no I/O.
 *
 * @param lastTurnAt  Epoch ms of the last successful turn, or null if none.
 * @param now         Epoch ms of the current moment (inject for testability).
 * @param timeoutMin  Idle window in minutes.
 */
export function shouldRotateSession(
  lastTurnAt: number | null,
  now: number,
  timeoutMin: number,
): boolean {
  if (lastTurnAt == null) return true;
  return now - lastTurnAt > timeoutMin * 60_000;
}
