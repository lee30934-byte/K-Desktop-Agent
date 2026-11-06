# Companion interface refinement

K requested a more polished companion interface. This candidate refines the existing single ceramic character's controls, settings and voice selection. It does not replace character artwork or add voices.

The companion uses a scoped slate and mint palette, consistent line icons, larger text hierarchy, material color tiles, a dedicated voice card with preview and refresh, and a keyboard accessible motion switch. Existing accessible button names and native select behavior are retained. The torso controls keep their approved proportional anchor.

At widths of at least 900 px the menu opens beside the character. Smaller windows stack the menu below a smaller character, with a scrollable panel bounded by the viewport. Reduced motion disables the new decorative waveform and transitions. These layouts concern the desktop application window; no phone service is implemented.

Call sessions, preview teardown, saved preferences, drag behavior and the hidden DOT dispatcher retain their existing controllers. The only verification script change allows voice UI checks to write into a new evidence directory, preserving earlier receipts.

Current evidence and source hashes: `evidence/companion-polish-20261106/status.json`. Screenshots and UI receipts: `ui-v2/`. The initial vertical panel exploration is preserved in `ui/`; the final desktop layout uses the adjacent panel in `ui-v2/`. Hardware audio, installation and publication remain outside this change.
