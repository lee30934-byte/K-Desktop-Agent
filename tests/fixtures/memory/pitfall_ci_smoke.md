# pitfall: CI smoke fixture

A second `.md` so the smoke verifies the loader sums multiple files (count >= 2,
bytes > 0). Content is intentionally trivial — this file is not consulted by any
real code path; it is read by `loadMemoryContext()` only as filler bytes.
