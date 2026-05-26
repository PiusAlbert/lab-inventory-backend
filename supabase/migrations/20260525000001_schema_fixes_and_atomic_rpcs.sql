-- ════════════════════════════════════════════════════════════════════
-- Migration: 20260525000001_schema_fixes_and_atomic_rpcs
--
-- What this migration does:
--
--   1.  Updates the transaction_type enum to include ISSUE / RECEIVE
--       (the original enum had IN/OUT which no controller uses).
--
--   2.  Adds columns to stock_transactions, items, stock_batches
--       that already exist in the live Supabase schema but were never
--       committed to a migration.  All additions use IF NOT EXISTS so
--       this migration is safe to run against a schema that is already
--       partially evolved.
--
--   3.  Fixes the global items.sku unique constraint to be per-lab.
--       The old constraint "items_sku_key UNIQUE (sku)" prevents two
--       different laboratories from using the same SKU.  The correct
--       business rule is uniqueness within a laboratory.
--
--   4.  Creates polymorphic item-extension tables if they do not exist.
--
--   5.  Adds indexes that will be needed at scale.
--
--   6.  Drops the old stock-quantity trigger (update_stock_quantity).
--       That trigger fired on IN/OUT types that are no longer inserted
--       by any controller.  Batch quantities are now maintained by the
--       atomic RPCs below, which are the single source of truth.
--
--   7.  Creates issue_stock() — an atomic, FIFO, race-condition-safe
--       function that issues stock and writes the transaction record
--       inside a single DB transaction.
--
--   8.  Creates receive_stock() — same atomicity guarantee for
--       returning / receiving stock back into an existing batch.
--
--   9.  Creates get_dashboard_kpis() — four KPI numbers in a single
--       DB round-trip, replacing the JS in-memory aggregation.
--
--  10.  Creates get_stock_by_category() — category totals in DB,
--       replacing the JS in-memory loop.
--
--  11.  Creates get_low_stock_items() — properly sorted low-stock
--       list from the DB, replacing the JS filter.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- 1. Update transaction_type enum
-- ────────────────────────────────────────────────────────────────────
ALTER TYPE public.transaction_type_enum ADD VALUE IF NOT EXISTS 'ISSUE';
ALTER TYPE public.transaction_type_enum ADD VALUE IF NOT EXISTS 'RECEIVE';
ALTER TYPE public.transaction_type_enum ADD VALUE IF NOT EXISTS 'ADJUSTMENT';


-- ────────────────────────────────────────────────────────────────────
-- 2. Evolve stock_transactions to match the current codebase
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE public.stock_transactions
  ADD COLUMN IF NOT EXISTS item_id       UUID REFERENCES public.items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS laboratory_id UUID REFERENCES public.laboratories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reference     TEXT,
  ADD COLUMN IF NOT EXISTS notes         TEXT,
  ADD COLUMN IF NOT EXISTS created_by    UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();

-- Rename old columns to match the codebase conventions where they diverge
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'stock_transactions'
      AND column_name  = 'remarks'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'stock_transactions'
      AND column_name  = 'notes'
  ) THEN
    ALTER TABLE public.stock_transactions RENAME COLUMN remarks TO notes;
  END IF;
END $$;


-- ────────────────────────────────────────────────────────────────────
-- 3. Evolve items table
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS laboratory_id     UUID REFERENCES public.laboratories(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS supplier_id       UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS item_type         VARCHAR(50),
  ADD COLUMN IF NOT EXISTS dispensing_unit   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS reorder_quantity  NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS max_stock_level   NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS unit_price        NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS hazard_class      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS storage_condition VARCHAR(255),
  ADD COLUMN IF NOT EXISTS regulatory_notes  TEXT,
  ADD COLUMN IF NOT EXISTS is_active         BOOLEAN NOT NULL DEFAULT TRUE;

-- Back-fill is_active for any rows where the column was just added with NULL
UPDATE public.items SET is_active = TRUE WHERE is_active IS NULL;


-- ────────────────────────────────────────────────────────────────────
-- 4. Fix SKU uniqueness: global → per-laboratory
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE public.items DROP CONSTRAINT IF EXISTS items_sku_key;

CREATE UNIQUE INDEX IF NOT EXISTS items_sku_lab_key
  ON public.items (laboratory_id, sku)
  WHERE laboratory_id IS NOT NULL;


-- ────────────────────────────────────────────────────────────────────
-- 5. Evolve stock_batches
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE public.stock_batches
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMP WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS created_by  UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();

-- received_date existed in the original migration but was never applied to the live schema.
-- Guard with a DO block so this is safe whether the column exists or not.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'stock_batches'
      AND column_name  = 'received_date'
  ) THEN
    ALTER TABLE public.stock_batches ALTER COLUMN received_date DROP NOT NULL;
  END IF;
END $$;


-- ────────────────────────────────────────────────────────────────────
-- 6. Polymorphic extension tables
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.item_chemical_details (
  item_id            UUID PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  formula            TEXT,
  cas_number         VARCHAR(50),
  molecular_weight   NUMERIC(10,4),
  msds_url           TEXT,
  pubchem_id         BIGINT,
  ghp_classification TEXT
);

CREATE TABLE IF NOT EXISTS public.item_equipment_details (
  item_id                   UUID PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  model_number              VARCHAR(100),
  serial_number             VARCHAR(100),
  maintenance_interval_days INT,
  last_maintenance_date     DATE,
  warranty_expiry           DATE
);

CREATE TABLE IF NOT EXISTS public.item_reference_details (
  item_id              UUID PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  certification_number VARCHAR(100),
  certification_expiry DATE,
  issuing_body         VARCHAR(255)
);


-- ────────────────────────────────────────────────────────────────────
-- 7. Performance indexes
-- ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_items_laboratory    ON public.items(laboratory_id);
CREATE INDEX IF NOT EXISTS idx_items_category      ON public.items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_active        ON public.items(is_active) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_batches_item        ON public.stock_batches(item_id);
CREATE INDEX IF NOT EXISTS idx_batches_lab         ON public.stock_batches(laboratory_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry      ON public.stock_batches(expiry_date) WHERE expiry_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_batches_qty_nonzero ON public.stock_batches(item_id, laboratory_id) WHERE current_quantity > 0;

CREATE INDEX IF NOT EXISTS idx_transactions_batch   ON public.stock_transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_item    ON public.stock_transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_transactions_lab     ON public.stock_transactions(laboratory_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON public.stock_transactions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user     ON public.audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created  ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_record   ON public.audit_logs(record_id);


-- ────────────────────────────────────────────────────────────────────
-- 8. Drop the old trigger — superseded by the atomic RPCs below.
--    The original trigger fired on 'IN'/'OUT' which no current
--    controller inserts.  Leaving it would be a silent maintenance trap.
-- ────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_update_stock ON public.stock_transactions;
-- Keep the function in case it's referenced somewhere; it's harmless.
-- DROP FUNCTION IF EXISTS public.update_stock_quantity();


-- ════════════════════════════════════════════════════════════════════
-- 9. issue_stock()
--
--    Atomically issues stock from an item using FIFO batch selection
--    (nearest expiry first, NULL expiry batches last).
--
--    The FOR UPDATE on the cursor locks all matching batch rows before
--    any deduction begins, preventing concurrent overdraft without
--    application-level locking.
--
--    A PostgreSQL exception rolls back all partial updates if the
--    total available stock is less than requested.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.issue_stock(
  p_item_id   UUID,
  p_lab_id    UUID,
  p_quantity  NUMERIC,
  p_user_id   UUID,
  p_reference TEXT DEFAULT NULL,
  p_notes     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch     RECORD;
  v_remaining NUMERIC := p_quantity;
  v_deduct    NUMERIC;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive';
  END IF;

  -- FIFO: nearest expiry first, no-expiry batches last.
  -- FOR UPDATE locks all matching rows; concurrent issue_stock calls
  -- for the same item will queue rather than race.
  FOR v_batch IN
    SELECT id, current_quantity
    FROM public.stock_batches
    WHERE item_id      = p_item_id
      AND laboratory_id = p_lab_id
      AND current_quantity > 0
    ORDER BY expiry_date ASC NULLS LAST, created_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;

    -- Re-read current_quantity under lock — it may have changed since
    -- the cursor snapshot if a concurrent UPDATE beat us to this row.
    v_deduct   := LEAST(v_batch.current_quantity, v_remaining);
    v_remaining := v_remaining - v_deduct;

    UPDATE public.stock_batches
    SET current_quantity = current_quantity - v_deduct
    WHERE id = v_batch.id;

    INSERT INTO public.stock_transactions (
      id, item_id, batch_id, laboratory_id, transaction_type,
      quantity, reference, notes, created_by, created_at
    ) VALUES (
      gen_random_uuid(), p_item_id, v_batch.id, p_lab_id, 'ISSUE',
      v_deduct, p_reference, p_notes, p_user_id, NOW()
    );
  END LOOP;

  -- If we exhausted all batches but still have remaining quantity,
  -- the stock is insufficient.  The RAISE rolls back every UPDATE and
  -- INSERT executed in this call.
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Insufficient stock. Requested: %, available: %',
      p_quantity, p_quantity - v_remaining;
  END IF;

  RETURN jsonb_build_object('issued', p_quantity);
END;
$$;


-- ════════════════════════════════════════════════════════════════════
-- 10. receive_stock()
--
--    Atomically adds quantity back to an existing batch (stock return
--    or correction).  FOR UPDATE on the batch prevents concurrent
--    modifications.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.receive_stock(
  p_batch_id  UUID,
  p_lab_id    UUID,
  p_quantity  NUMERIC,
  p_user_id   UUID,
  p_reference TEXT DEFAULT NULL,
  p_notes     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id UUID;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive';
  END IF;

  SELECT item_id INTO v_item_id
  FROM public.stock_batches
  WHERE id = p_batch_id AND laboratory_id = p_lab_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found in the active laboratory';
  END IF;

  UPDATE public.stock_batches
  SET current_quantity = current_quantity + p_quantity
  WHERE id = p_batch_id;

  INSERT INTO public.stock_transactions (
    id, item_id, batch_id, laboratory_id, transaction_type,
    quantity, reference, notes, created_by, created_at
  ) VALUES (
    gen_random_uuid(), v_item_id, p_batch_id, p_lab_id, 'RECEIVE',
    p_quantity, p_reference, p_notes, p_user_id, NOW()
  );

  RETURN jsonb_build_object('received', p_quantity, 'batch_id', p_batch_id);
END;
$$;


-- ════════════════════════════════════════════════════════════════════
-- 11. get_dashboard_kpis()
--
--    Returns all four dashboard KPI numbers in a single round-trip,
--    replacing the in-memory JS aggregation over full table scans.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(p_lab_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH item_stock AS (
    SELECT
      i.id,
      COALESCE(i.minimum_threshold, 0)            AS min_threshold,
      COALESCE(i.unit_price, 0)                   AS unit_price,
      COALESCE(SUM(sb.current_quantity), 0)        AS total_qty
    FROM public.items i
    LEFT JOIN public.stock_batches sb
      ON sb.item_id = i.id
      AND (p_lab_id IS NULL OR sb.laboratory_id = p_lab_id)
    WHERE (p_lab_id IS NULL OR i.laboratory_id = p_lab_id)
      AND COALESCE(i.is_active, TRUE) = TRUE
    GROUP BY i.id, i.minimum_threshold, i.unit_price
  )
  SELECT jsonb_build_object(
    'total_items',     COUNT(*),
    'low_stock',       COUNT(*) FILTER (WHERE total_qty < min_threshold),
    'expiring_soon', (
      SELECT COUNT(*)
      FROM public.stock_batches esb
      WHERE (p_lab_id IS NULL OR esb.laboratory_id = p_lab_id)
        AND esb.expiry_date IS NOT NULL
        AND esb.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
        AND esb.current_quantity > 0
    ),
    'inventory_value', ROUND(COALESCE(SUM(total_qty * unit_price), 0)::NUMERIC, 2)
  )
  FROM item_stock;
$$;


-- ════════════════════════════════════════════════════════════════════
-- 12. get_stock_by_category()
--
--    Aggregates current stock quantities per category in the DB.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_stock_by_category(p_lab_id UUID DEFAULT NULL)
RETURNS TABLE (category TEXT, total_quantity NUMERIC)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(c.name, 'Uncategorised') AS category,
    SUM(sb.current_quantity)          AS total_quantity
  FROM public.stock_batches sb
  JOIN public.items i ON i.id = sb.item_id
  LEFT JOIN public.categories c ON c.id = i.category_id
  WHERE (p_lab_id IS NULL OR sb.laboratory_id = p_lab_id)
  GROUP BY c.name
  ORDER BY total_quantity DESC;
$$;


-- ════════════════════════════════════════════════════════════════════
-- 13. get_low_stock_items()
--
--    Returns items below their minimum threshold, sorted worst-first
--    (lowest stock/threshold ratio at the top).
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_low_stock_items(
  p_lab_id UUID DEFAULT NULL,
  p_limit  INT  DEFAULT 10
)
RETURNS TABLE (
  id                UUID,
  laboratory_id     UUID,
  name              TEXT,
  sku               TEXT,
  category          TEXT,
  unit_of_measure   TEXT,
  current_stock     NUMERIC,
  minimum_threshold NUMERIC,
  shortage          NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    i.id,
    i.laboratory_id,
    i.name::TEXT,
    i.sku::TEXT,
    COALESCE(c.name, 'Uncategorised')::TEXT                          AS category,
    COALESCE(i.dispensing_unit, i.unit_of_measure, 'units')::TEXT    AS unit_of_measure,
    COALESCE(SUM(sb.current_quantity), 0)                            AS current_stock,
    COALESCE(i.minimum_threshold, 0)                                 AS minimum_threshold,
    GREATEST(0, COALESCE(i.minimum_threshold, 0) - COALESCE(SUM(sb.current_quantity), 0)) AS shortage
  FROM public.items i
  LEFT JOIN public.stock_batches sb
    ON sb.item_id = i.id
    AND (p_lab_id IS NULL OR sb.laboratory_id = p_lab_id)
  LEFT JOIN public.categories c ON c.id = i.category_id
  WHERE (p_lab_id IS NULL OR i.laboratory_id = p_lab_id)
    AND COALESCE(i.is_active, TRUE) = TRUE
    AND COALESCE(i.minimum_threshold, 0) > 0
  GROUP BY i.id, i.laboratory_id, i.name, i.sku, c.name,
           i.dispensing_unit, i.unit_of_measure, i.minimum_threshold
  HAVING COALESCE(SUM(sb.current_quantity), 0) < COALESCE(i.minimum_threshold, 0)
  ORDER BY
    (COALESCE(SUM(sb.current_quantity), 0) / NULLIF(COALESCE(i.minimum_threshold, 0), 0)) ASC NULLS FIRST
  LIMIT p_limit;
$$;
