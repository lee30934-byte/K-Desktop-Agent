/** Fill available turn slots in scan order. Deferred watches stay available for later ticks. */
export async function dispatchAvailableWatches<T>(
  watches: readonly T[],
  availableSlots: number,
  tryDispatch: (watch: T) => Promise<boolean>,
): Promise<number> {
  let dispatched = 0;
  for (const watch of watches) {
    if (dispatched >= availableSlots) break;
    if (await tryDispatch(watch)) dispatched++;
  }
  return dispatched;
}
