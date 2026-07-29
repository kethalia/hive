---
name: kicad-development
description: Create, inspect, modify, validate, and release KiCad electronics projects. Use for .kicad_pro, .kicad_sch, .kicad_pcb, symbol and footprint libraries, BOMs, ERC/DRC, PCB layout, Gerber/drill/position exports, or diagnosing KiCad CLI, library, and manufacturing-output problems.
---

# KiCad Development

Treat the schematic as the electrical source of truth and the PCB as its physical implementation. Keep changes reviewable and validate with KiCad's own engines.

## Workflow

1. Inspect the project, KiCad version, local libraries, design rules, board stackup, and existing output conventions before editing.
2. Confirm electrical, mechanical, fabrication, assembly, and sourcing constraints. Do not invent pinouts, package dimensions, ratings, tolerances, or manufacturer capabilities; verify them from authoritative datasheets or fabrication rules.
3. Prefer KiCad MCP tools or KiCad itself for structural edits. Avoid raw S-expression edits unless the affected format is understood and the result will be reopened and validated by KiCad.
4. Keep project-specific symbols, footprints, models, and tables inside the repository when reproducibility requires them. Preserve library nicknames and `${KIPRJMOD}`-relative paths.
5. Annotate and validate the schematic before transferring changes to the PCB. Reconcile references, footprints, nets, and board changes intentionally.
6. Make placement, stackup, constraints, routing, zones, return paths, clearances, creepage, thermal relief, and test access explicit. Treat signal-integrity, power-integrity, EMC, and thermal estimates as preliminary engineering evidence, not sign-off.
7. Run the narrowest relevant checks after each change and repeat the complete release checks before generating manufacturing files.

## Validation

Use unique report paths so results remain attributable:

```bash
kicad-cli sch erc --output build/erc.rpt project.kicad_sch
kicad-cli pcb drc --output build/drc.rpt project.kicad_pcb
```

Inspect the reports, distinguish new violations from accepted waivers, and never claim success from the process exit code alone. Open changed schematics and boards in the installed KiCad version when practical to catch load, rescue, font, and rendering issues.

## Release outputs

Generate BOM, Gerber, drill, position, schematic PDF, and STEP outputs into a clean staging directory. Use the project's documented presets and fabricator requirements rather than guessing flags. Verify:

- ERC and DRC reports are current and reviewed.
- Board outline, layer set, stackup, drill pairs, units, origins, and plot settings are correct.
- BOM identities and values match placed footprints; DNP and variant handling is explicit.
- Gerber and drill files reopen coherently in a viewer.
- Position-file side, rotation, origin, and units match the assembler contract.
- Fabrication archives contain only intentional release artifacts and include revision evidence.

Require qualified human review before fabrication or assembly. Clearly report assumptions, waived findings, unverified datasheet constraints, and checks that require lab equipment or a field solver.

## Remote workspace

Launch KiCad from the Coder Desktop. `kicad-cli` checks and exports work headlessly. Live MCP editing may require the relevant KiCad editor to be running with IPC/API access enabled; fall back to file inspection and CLI validation when it is unavailable.
