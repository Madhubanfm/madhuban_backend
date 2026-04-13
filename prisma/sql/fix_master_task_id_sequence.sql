-- Run once if POST /api/tasks fails with: Unique constraint failed on the fields: (`id`)
-- Cause: rows were inserted with explicit ids (e.g. seed) without bumping the serial sequence.
SELECT setval(
  pg_get_serial_sequence('"MasterTask"', 'id')::regclass,
  (SELECT COALESCE(MAX(id), 1) FROM "MasterTask")
);
