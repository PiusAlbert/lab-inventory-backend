-- ── Experiment Bookings ──────────────────────────────────────────────
-- Students request a lab slot; a manager approves or declines.

CREATE TABLE IF NOT EXISTS experiment_bookings (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  laboratory_id      UUID        NOT NULL REFERENCES laboratories(id),
  created_by         UUID        NOT NULL REFERENCES app_users(id),

  title              TEXT        NOT NULL,
  purpose            TEXT,
  requested_date     DATE        NOT NULL,
  start_time         TIME        NOT NULL,
  end_time           TIME        NOT NULL,
  bench_location     TEXT,
  participants_count INTEGER     NOT NULL DEFAULT 1,
  notes              TEXT,

  status             TEXT        NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','APPROVED','DECLINED','CANCELLED')),

  reviewed_by        UUID        REFERENCES app_users(id),
  reviewed_at        TIMESTAMPTZ,
  review_note        TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_lab      ON experiment_bookings(laboratory_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user     ON experiment_bookings(created_by);
CREATE INDEX IF NOT EXISTS idx_bookings_date     ON experiment_bookings(requested_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status   ON experiment_bookings(status);
