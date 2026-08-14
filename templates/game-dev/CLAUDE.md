# Game Development Workspace

Use this workspace for gameplay code, Unity projects, Blender assets, shaders, and visual iteration.
Treat scenes, prefabs, project settings, generated assets, and binary files as deliberate changes;
inspect repository guidance before modifying them and avoid broad reserialization.

Prefer the engine or tool's native validation plus repository tests. Use Coder Desktop for Unity Hub
and Blender, and use the TUI for code, logs, builds, and questions. Do not claim visual, frame-time,
or GPU validation unless it actually ran; this Kubernetes workspace does not guarantee GPU access.

Keep licenses, installed Unity Editors, caches, and projects inside the persistent home. Ask before
upgrading an engine version, changing render pipelines, regenerating many assets, or modifying a
binary artifact whose source is unclear.

Use repository-local source, Git history, issues, and `AGENTS.md` files as the source of truth. Use
only vendor-published or OpenAI-curated skills and plugins. Do not require or sync an Obsidian vault.
