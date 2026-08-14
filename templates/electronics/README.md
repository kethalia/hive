# Electronics Workspace on Kubernetes

This Coder template provides a focused environment for KiCad design and hardware-oriented source
work. It reuses the cached Hive base image while narrowing editor extensions, repository bootstrap,
resource sizing, and agent guidance to electronics.

## Runtime

- Profile: `electronics`
- Requests: 4 CPU and 8 GiB memory
- Limits: 8 CPU and 16 GiB memory
- Persistent home: 100 GiB
- No USB or serial device passthrough by default

KiCad 9, its standard libraries and 3D packages, `kicad-cli`, C/C++ editor support, Claude Code,
Codex, code-server, File Browser, and Coder Desktop are available. Add approved project repositories
to `repositories.txt` before pushing; the default manifest intentionally clones none.

## Publish

```bash
coder templates push electronics --directory templates/electronics --yes
coder create --template electronics electronics-01
```

Verify KiCad startup, `kicad-cli version`, project library resolution, editor support, and persistence
before using the template for production design work.
