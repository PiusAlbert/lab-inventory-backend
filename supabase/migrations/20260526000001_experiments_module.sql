-- ════════════════════════════════════════════════════════════════════
-- Migration: 20260526000001_experiments_module
-- Creates the full experiment-recording schema (14 tables).
-- Safe to run against any schema state — all additions use IF NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════

-- ── Enum ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.experiment_status_enum AS ENUM (
    'DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. experiments ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  laboratory_id       UUID NOT NULL REFERENCES public.laboratories(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  objective           TEXT,
  course_module       TEXT,
  instructor_id       UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  session_date        DATE NOT NULL,
  session_start       TIMESTAMPTZ,
  session_end         TIMESTAMPTZ,
  protocol_reference  TEXT,
  status              public.experiment_status_enum NOT NULL DEFAULT 'DRAFT',
  rejection_comment   TEXT,
  created_by          UUID NOT NULL REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. experiment_participants ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_participants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id  UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'STUDENT',
  added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(experiment_id, user_id)
);

-- ── 3. experiment_materials ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_materials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id  UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  item_id        UUID REFERENCES public.items(id) ON DELETE SET NULL,
  batch_id       UUID REFERENCES public.stock_batches(id) ON DELETE SET NULL,
  material_name  TEXT NOT NULL,
  quantity_used  NUMERIC NOT NULL CHECK (quantity_used > 0),
  unit           TEXT NOT NULL,
  lot_number     TEXT,
  notes          TEXT
);

-- ── 4. experiment_equipment ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_equipment (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id       UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  item_id             UUID REFERENCES public.items(id) ON DELETE SET NULL,
  equipment_name      TEXT NOT NULL,
  model_serial        TEXT,
  calibration_status  TEXT NOT NULL DEFAULT 'N/A',
  calibration_date    DATE,
  notes               TEXT
);

-- ── 5. experiment_safety (1:1) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_safety (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   UUID NOT NULL UNIQUE REFERENCES public.experiments(id) ON DELETE CASCADE,
  ppe_used        JSONB NOT NULL DEFAULT '[]',
  fume_hood_used  BOOLEAN NOT NULL DEFAULT FALSE,
  fume_hood_id    TEXT,
  hazard_level    TEXT NOT NULL DEFAULT 'LOW',
  biosafety_level TEXT,
  other_precautions TEXT
);

-- ── 6. experiment_procedure_steps ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_procedure_steps (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id  UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  step_number    INT NOT NULL,
  description    TEXT NOT NULL,
  conditions     JSONB NOT NULL DEFAULT '{}',
  is_deviation   BOOLEAN NOT NULL DEFAULT FALSE,
  deviation_note TEXT,
  UNIQUE(experiment_id, step_number)
);

-- ── 7. experiment_controls ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_controls (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id  UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  control_type   TEXT NOT NULL,
  description    TEXT NOT NULL,
  expected_value TEXT,
  actual_value   TEXT,
  unit           TEXT,
  passed         BOOLEAN
);

-- ── 8. experiment_observations ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_observations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id       UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  step_id             UUID REFERENCES public.experiment_procedure_steps(id) ON DELETE SET NULL,
  observation_type    TEXT NOT NULL DEFAULT 'QUANTITATIVE',
  label               TEXT NOT NULL,
  value               TEXT,
  unit                TEXT,
  replicate_number    INT,
  instrument_settings JSONB NOT NULL DEFAULT '{}',
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes               TEXT
);

-- ── 9. experiment_attachments ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  observation_id  UUID REFERENCES public.experiment_observations(id) ON DELETE SET NULL,
  file_name       TEXT NOT NULL,
  storage_path    TEXT NOT NULL,
  file_type       TEXT NOT NULL DEFAULT 'IMAGE',
  description     TEXT,
  uploaded_by     UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 10. experiment_results ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_results (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id      UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  label              TEXT NOT NULL,
  result_type        TEXT NOT NULL DEFAULT 'CALCULATED',
  value              NUMERIC,
  unit               TEXT,
  expected_value     NUMERIC,
  deviation_percent  NUMERIC,
  uncertainty        NUMERIC,
  method             TEXT,
  notes              TEXT
);

-- ── 11. experiment_conclusions (1:1) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_conclusions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id           UUID NOT NULL UNIQUE REFERENCES public.experiments(id) ON DELETE CASCADE,
  key_findings            TEXT,
  error_sources           TEXT,
  limitations             TEXT,
  improvement_suggestions TEXT,
  follow_up_experiments   TEXT
);

-- ── 12. experiment_waste_records ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_waste_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id     UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  waste_description TEXT NOT NULL,
  waste_type        TEXT NOT NULL DEFAULT 'NON_HAZARDOUS',
  quantity          NUMERIC,
  unit              TEXT,
  disposal_method   TEXT,
  disposal_date     DATE,
  disposed_by       UUID REFERENCES public.app_users(id) ON DELETE SET NULL
);

-- ── 13. experiment_ethical_approvals ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_ethical_approvals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id  UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  approval_type  TEXT NOT NULL,
  approval_number TEXT,
  approving_body TEXT,
  approval_date  DATE,
  expiry_date    DATE,
  document_path  TEXT
);

-- ── 14. experiment_signatures ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experiment_signatures (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id  UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
  signer_id      UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  signer_role    TEXT NOT NULL,
  signed_at      TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'PENDING',
  comment        TEXT,
  UNIQUE(experiment_id, signer_id)
);

-- ── Indexes ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_experiments_lab        ON public.experiments(laboratory_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status     ON public.experiments(status);
CREATE INDEX IF NOT EXISTS idx_experiments_created_by ON public.experiments(created_by);
CREATE INDEX IF NOT EXISTS idx_experiments_date       ON public.experiments(session_date DESC);
CREATE INDEX IF NOT EXISTS idx_exp_materials_exp      ON public.experiment_materials(experiment_id);
CREATE INDEX IF NOT EXISTS idx_exp_materials_item     ON public.experiment_materials(item_id);
CREATE INDEX IF NOT EXISTS idx_exp_materials_batch    ON public.experiment_materials(batch_id);
CREATE INDEX IF NOT EXISTS idx_exp_steps_exp          ON public.experiment_procedure_steps(experiment_id);
CREATE INDEX IF NOT EXISTS idx_exp_obs_exp            ON public.experiment_observations(experiment_id);
CREATE INDEX IF NOT EXISTS idx_exp_sigs_exp           ON public.experiment_signatures(experiment_id);

-- ── updated_at trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_experiments_updated_at
    BEFORE UPDATE ON public.experiments
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.experiments                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_participants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_materials         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_equipment         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_safety            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_procedure_steps   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_controls          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_observations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_attachments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_results           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_conclusions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_waste_records     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_ethical_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_signatures        ENABLE ROW LEVEL SECURITY;

-- Service-role bypass (backend uses service role key — full access)
-- Note: CREATE POLICY does not support IF NOT EXISTS; these tables are new so no conflict.
CREATE POLICY "service_role_all_experiments"
  ON public.experiments FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_participants"
  ON public.experiment_participants FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_materials"
  ON public.experiment_materials FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_equipment"
  ON public.experiment_equipment FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_safety"
  ON public.experiment_safety FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_steps"
  ON public.experiment_procedure_steps FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_controls"
  ON public.experiment_controls FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_obs"
  ON public.experiment_observations FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_attach"
  ON public.experiment_attachments FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_results"
  ON public.experiment_results FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_conclusions"
  ON public.experiment_conclusions FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_waste"
  ON public.experiment_waste_records FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_approvals"
  ON public.experiment_ethical_approvals FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_exp_sigs"
  ON public.experiment_signatures FOR ALL TO service_role USING (true) WITH CHECK (true);
