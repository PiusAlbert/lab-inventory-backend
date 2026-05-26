-- ════════════════════════════════════════════════════════════════════
-- Migration: 20260526000002_student_registration
--
-- Adds the STUDENT role and self-registration infrastructure:
--   1. STUDENT value added to user_role_enum
--   2. registration_status + preferred_laboratory_id columns on app_users
--   3. student_profiles extension table (student number, course, dept)
--   4. Index for pending-student queries
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Extend the role enum ───────────────────────────────────────────
ALTER TYPE public.user_role_enum ADD VALUE IF NOT EXISTS 'STUDENT';

-- ── 2. Extend app_users ───────────────────────────────────────────────
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS registration_status    TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS preferred_laboratory_id UUID REFERENCES public.laboratories(id) ON DELETE SET NULL;

-- registration_status values:
--   'PENDING'   — registered, awaiting lab manager approval
--   'ACTIVE'    — approved and able to log in  (mirrors is_active = true)
--   'REJECTED'  — registration denied by lab manager
--   'SUSPENDED' — previously active, manually disabled

-- ── 3. student_profiles ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_profiles (
  user_id         UUID PRIMARY KEY REFERENCES public.app_users(id) ON DELETE CASCADE,
  student_number  TEXT,
  department      TEXT,
  course_name     TEXT,
  course_level    TEXT NOT NULL DEFAULT 'UNDERGRADUATE',
  year_of_study   INT,
  supervisor_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. Indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_app_users_reg_status
  ON public.app_users(registration_status);

CREATE INDEX IF NOT EXISTS idx_app_users_preferred_lab
  ON public.app_users(preferred_laboratory_id);

-- ── 5. RLS for student_profiles ───────────────────────────────────────
ALTER TABLE public.student_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_student_profiles"
  ON public.student_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
