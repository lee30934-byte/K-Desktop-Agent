// Test process only: exercise the production expiry callback without waiting 2m.
const original = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 120000 ? 40 : ms, ...args);
