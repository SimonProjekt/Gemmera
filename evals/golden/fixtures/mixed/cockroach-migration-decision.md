# Postgres → CockroachDB migration window

Team decided the cutover happens during the Christmas-week traffic trough. Dual-write begins three weeks before, read-traffic shift one week before, hard cutover on the night of December 28. Postgres stays as a hot fallback for two more weeks.

Owner: backend team. Coordination doc lives in the shared drive.
