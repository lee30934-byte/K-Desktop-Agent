/** Try ready watches in scan order; a deferred watch must not block another conversation. */
export async function dispatchFirstAvailableWatch<T>(
  watches: readonly T[],
  tryDispatch: (watch: T) => Promise<boolean>,
): Promise<boolean> {
  for (const watch of watches) {
    if (await tryDispatch(watch)) return true;
  }
  return false;
}
