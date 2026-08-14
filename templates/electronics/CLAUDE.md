# Electronics Workspace

Use this workspace for KiCad schematics, PCB layouts, libraries, manufacturing outputs, simulation,
and firmware repositories. Preserve project file formats and library links, and distinguish source
design files from generated fabrication artifacts.

Run the checks available to the project, including ERC, DRC, schematic/PCB parity, and `kicad-cli`
automation where configured. Never claim that a physical circuit, voltage level, footprint, assembly,
or connected device has been validated unless the relevant evidence was actually supplied or tested.

Ask before changing stackups, footprints, net classes, design rules, production variants, or generated
Gerbers/BOM/position files. This Kubernetes template does not expose local USB or serial hardware by
default; treat flashing and bench validation as external steps unless a device path is explicitly
provided.

Use repository-local source, Git history, issues, datasheets, and `AGENTS.md` files as the source of
truth. Use only vendor-published or OpenAI-curated skills and plugins. Do not require or sync an
Obsidian vault.
