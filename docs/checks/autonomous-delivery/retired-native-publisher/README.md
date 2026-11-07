# Retired custom native publisher evidence

Historical checks for the custom publisher removed at the owner's request on
2026-11-07. They are retained as an audit record and are not current deployment
instructions, release prerequisites, or authority to create credentials.

The active path is the existing Cloudflare Workers Builds integration for the
single `hive` Worker. Publisher code, machine routes, separate workflow callers,
optional artifact CI jobs and token-entry helper are removed. Applied migration45
is preserved byte-for-byte; its four unused table models remain for database
history compatibility. No runtime publisher consumes them. Existing application,
authentication, guardian, migration safety and CI cache fixes remain.
