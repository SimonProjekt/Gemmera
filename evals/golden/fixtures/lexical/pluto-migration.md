# Pluto migration

First pass succeeded. Second pass crashed with error code `E_PLUTO_2031` during the schema-rewrite stage. Cause: a leftover index from the v1 schema that the new migration assumed didn't exist.

Fix: drop the index manually before re-running.
