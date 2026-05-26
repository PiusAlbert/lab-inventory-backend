import { getSupabase } from '../config/supabase.js'
import { daysUntil, addToMap } from '../utils/helpers.js'

/**
 * Fetches all dashboard data for the given lab (or all labs if labId is null).
 *
 * Performance profile (before → after):
 *   Before: 3 full-table SELECT * calls → all aggregation in JS memory
 *   After:  5 targeted queries, all aggregation done in Postgres
 *
 *   1. get_dashboard_kpis RPC   — 4 KPI numbers in 1 round-trip
 *   2. get_low_stock_items RPC  — pre-aggregated low-stock list
 *   3. get_stock_by_category RPC — category totals
 *   4. Expiring batches          — targeted WHERE clause, limited columns
 *   5. Recent transactions       — already limited to 10
 *
 * The SUPER_ADMIN all-labs grouping (low_stock_by_lab, expiring_by_lab)
 * is computed from the results of (2) and (4) — no extra DB round-trip.
 */
export async function getDashboardMetrics(labId = null, isAdmin = false) {
  const supabase  = getSupabase()
  const isAllLabs = !labId
  const rpcLabId  = labId ?? null   // Postgres functions accept NULL for all-labs

  // ── 1. KPI numbers ─────────────────────────────────────────────────
  const { data: kpis, error: kpiError } = await supabase
    .rpc('get_dashboard_kpis', { p_lab_id: rpcLabId })

  if (kpiError) throw kpiError

  // ── 2. Low-stock item details ──────────────────────────────────────
  const { data: lowStockItems, error: lowStockError } = await supabase
    .rpc('get_low_stock_items', { p_lab_id: rpcLabId, p_limit: 10 })

  if (lowStockError) throw lowStockError

  // ── 3. Stock by category ───────────────────────────────────────────
  const { data: stockByCategory, error: categoryError } = await supabase
    .rpc('get_stock_by_category', { p_lab_id: rpcLabId })

  if (categoryError) throw categoryError

  // ── 4. Expiring batches (within 30 days, with stock remaining) ─────
  const expiryThreshold = new Date()
  expiryThreshold.setDate(expiryThreshold.getDate() + 30)

  let expiryQuery = supabase
    .from('stock_batches')
    .select(`
      id, item_id, laboratory_id, batch_number, current_quantity,
      quantity_received, expiry_date, storage_location,
      items ( id, name, sku, unit_of_measure, dispensing_unit, categories ( name ) )
    `)
    .not('expiry_date', 'is', null)
    .lte('expiry_date', expiryThreshold.toISOString().split('T')[0])
    .gt('current_quantity', 0)
    .order('expiry_date', { ascending: true })
    .limit(50)

  if (labId) expiryQuery = expiryQuery.eq('laboratory_id', labId)

  const { data: rawExpiring, error: expiryError } = await expiryQuery
  if (expiryError) throw expiryError

  const expiringBatches = (rawExpiring || []).map((batch) => ({
    id:                batch.id,
    item_id:           batch.item_id,
    laboratory_id:     batch.laboratory_id,
    batch_number:      batch.batch_number,
    current_quantity:  Number(batch.current_quantity || 0),
    quantity_received: Number(batch.quantity_received || 0),
    expiry_date:       batch.expiry_date,
    days_to_expiry:    daysUntil(batch.expiry_date),
    storage_location:  batch.storage_location,
    items:             batch.items,
  }))

  // ── 5. Recent transactions ─────────────────────────────────────────
  let trxQuery = supabase
    .from('stock_transactions')
    .select(`
      id, transaction_type, quantity, reference, notes, created_at,
      items        ( id, name, sku, unit_of_measure ),
      stock_batches( batch_number )
    `)
    .order('created_at', { ascending: false })
    .limit(10)

  if (labId) trxQuery = trxQuery.eq('laboratory_id', labId)

  const { data: recentTransactions, error: trxError } = await trxQuery
  if (trxError) throw trxError

  // ── SUPER_ADMIN: group alerts by lab ─────────────────────────────
  const lowStockByLab = groupByLab(lowStockItems || [], 'items')
  const expiringByLab = groupByLab(expiringBatches, 'batches')

  // Resolve lab UUIDs → names in one query so the frontend never shows raw IDs
  if (isAllLabs) {
    const allLabIds = Array.from(
      new Set(
        [...lowStockByLab, ...expiringByLab]
          .map((g) => g.laboratory_id)
          .filter((id) => id && id !== 'unknown')
      )
    )

    if (allLabIds.length > 0) {
      const { data: labs } = await supabase
        .from('laboratories')
        .select('id, name')
        .in('id', allLabIds)

      const labNameMap = new Map((labs || []).map((l) => [l.id, l.name]))
      const enrich = (groups) =>
        groups.map((g) => ({
          ...g,
          laboratory_name: labNameMap.get(g.laboratory_id) ?? g.laboratory_id,
        }))

      lowStockByLab.splice(0, lowStockByLab.length, ...enrich(lowStockByLab))
      expiringByLab.splice(0, expiringByLab.length, ...enrich(expiringByLab))
    }
  }

  return {
    // KPIs from DB
    total_items:     kpis?.total_items     ?? 0,
    low_stock:       kpis?.low_stock       ?? 0,
    expiring_soon:   kpis?.expiring_soon   ?? 0,
    inventory_value: kpis?.inventory_value ?? 0,

    // Detail lists
    low_stock_items:    (lowStockItems    || []).slice(0, 10),
    expiring_batches:   expiringBatches.slice(0, 10),
    stock_by_category:  stockByCategory || [],
    recent_transactions: recentTransactions || [],

    // SUPER_ADMIN multi-lab groupings
    low_stock_by_lab:  lowStockByLab,
    expiring_by_lab:   expiringByLab,

    is_all_labs:       isAllLabs,
    selected_lab_id:   labId ?? null,
    user_is_admin:     Boolean(isAdmin),
  }
}

// ── Private helpers ───────────────────────────────────────────────────

/**
 * Groups an alert list by laboratory_id for the SUPER_ADMIN all-labs view.
 * itemKey: 'items' | 'batches' — which array key to use in each group entry.
 */
function groupByLab(list, itemKey) {
  const map = new Map()

  for (const entry of list) {
    const labKey = entry.laboratory_id || 'unknown'
    const group  = map.get(labKey) || { laboratory_id: labKey, count: 0, [itemKey]: [] }
    group.count += 1
    group[itemKey].push(entry)
    map.set(labKey, group)
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count)
}
