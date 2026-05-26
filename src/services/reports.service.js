import { getSupabase } from '../config/supabase.js'
import { daysUntil, addToMap } from '../utils/helpers.js'

// ── Period helpers ────────────────────────────────────────────────────

function startOfDay(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function endOfDay(date) {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

function getPeriodRange(period = 'monthly', start = null, end = null) {
  const now = new Date()

  if (period === 'custom') {
    if (!start || !end) throw new Error('Custom report requires start and end dates')
    return { startDate: startOfDay(new Date(start)), endDate: endOfDay(new Date(end)) }
  }

  if (period === 'weekly') {
    const endDate   = endOfDay(now)
    const startDate = startOfDay(new Date(now))
    startDate.setDate(startDate.getDate() - 6)
    return { startDate, endDate }
  }

  if (period === 'monthly') {
    const endDate   = endOfDay(now)
    const startDate = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1))
    return { startDate, endDate }
  }

  throw new Error('Unsupported report period. Use: weekly | monthly | custom')
}

// ── Main function ─────────────────────────────────────────────────────

export async function generateReport(labId = null, period = 'monthly', start = null, end = null) {
  const supabase = getSupabase()
  const { startDate, endDate } = getPeriodRange(period, start, end)

  // ── 1. Items ────────────────────────────────────────────────────────
  let itemsQuery = supabase
    .from('items')
    .select(`
      id, laboratory_id, category_id, supplier_id, name, sku, barcode,
      unit_of_measure, dispensing_unit, minimum_threshold, reorder_quantity,
      max_stock_level, item_type, unit_price, hazard_class, storage_condition,
      is_perishable, categories ( name )
    `)
    .order('name', { ascending: true })

  if (labId) itemsQuery = itemsQuery.eq('laboratory_id', labId)

  const { data: items, error: itemsError } = await itemsQuery
  if (itemsError) throw itemsError

  // ── 2. Current stock batches ────────────────────────────────────────
  let batchesQuery = supabase
    .from('stock_batches')
    .select(`
      id, item_id, laboratory_id, batch_number, quantity_received,
      current_quantity, expiry_date, storage_location, received_at, created_at,
      items (
        id, name, sku, unit_of_measure, dispensing_unit,
        minimum_threshold, item_type, categories ( name )
      )
    `)

  if (labId) batchesQuery = batchesQuery.eq('laboratory_id', labId)

  const { data: batches, error: batchesError } = await batchesQuery
  if (batchesError) throw batchesError

  // ── 3. Transactions within report period ────────────────────────────
  let trxQuery = supabase
    .from('stock_transactions')
    .select(`
      id, item_id, batch_id, laboratory_id, transaction_type,
      quantity, reference, notes, created_at,
      items         ( id, name, sku, unit_of_measure, dispensing_unit, categories ( name ) ),
      stock_batches ( id, batch_number )
    `)
    .gte('created_at', startDate.toISOString())
    .lte('created_at', endDate.toISOString())
    .order('created_at', { ascending: false })

  if (labId) trxQuery = trxQuery.eq('laboratory_id', labId)

  const { data: transactions, error: trxError } = await trxQuery
  if (trxError) throw trxError

  // ── 4. Aggregate stock totals per item from batches ─────────────────
  const stockByItem = new Map()
  for (const batch of batches || []) {
    addToMap(stockByItem, batch.item_id, batch.current_quantity || 0)
  }

  // ── 5. Stock snapshot ───────────────────────────────────────────────
  const stockSnapshot = (items || []).map((item) => {
    const currentStock = Number(stockByItem.get(item.id) || 0)
    const threshold    = Number(item.minimum_threshold || 0)

    return {
      id:                item.id,
      laboratory_id:     item.laboratory_id,
      sku:               item.sku,
      name:              item.name,
      category:          item.categories?.name || 'Uncategorised',
      item_type:         item.item_type,
      current_stock:     currentStock,
      unit_of_measure:   item.dispensing_unit || item.unit_of_measure || 'units',
      minimum_threshold: threshold,
      reorder_quantity:  item.reorder_quantity,
      max_stock_level:   item.max_stock_level,
      hazard_class:      item.hazard_class,
      storage_condition: item.storage_condition,
      is_perishable:     item.is_perishable,
      status:
        currentStock === 0     ? 'OUT_OF_STOCK'
        : currentStock < threshold ? 'LOW_STOCK'
        : 'OK',
    }
  })

  // ── 6. Low-stock items ──────────────────────────────────────────────
  const lowStockItems = stockSnapshot
    .filter((item) => item.current_stock < Number(item.minimum_threshold || 0))
    .sort((a, b) => {
      const aRatio = a.minimum_threshold > 0 ? a.current_stock / a.minimum_threshold : 1
      const bRatio = b.minimum_threshold > 0 ? b.current_stock / b.minimum_threshold : 1
      return aRatio - bRatio
    })

  // ── 7. Expiring batches (within 30 days) ────────────────────────────
  const expiringBatches = (batches || [])
    .filter((b) => b.expiry_date)
    .map((b) => ({
      id:                b.id,
      item_id:           b.item_id,
      laboratory_id:     b.laboratory_id,
      batch_number:      b.batch_number,
      expiry_date:       b.expiry_date,
      days_to_expiry:    daysUntil(b.expiry_date),
      current_quantity:  Number(b.current_quantity || 0),
      quantity_received: Number(b.quantity_received || 0),
      storage_location:  b.storage_location,
      item_name:         b.items?.name || 'Unknown item',
      sku:               b.items?.sku  || '—',
      category:          b.items?.categories?.name || 'Uncategorised',
      unit_of_measure:   b.items?.dispensing_unit || b.items?.unit_of_measure || 'units',
    }))
    .filter((b) => b.days_to_expiry !== null && b.days_to_expiry <= 30)
    .sort((a, b) => a.days_to_expiry - b.days_to_expiry)

  // ── 8. Category breakdown ───────────────────────────────────────────
  const categoryMap = new Map()
  for (const item of stockSnapshot) {
    const key     = item.category || 'Uncategorised'
    const current = categoryMap.get(key) || { category: key, total_items: 0, total_stock: 0, low_stock: 0 }
    current.total_items  += 1
    current.total_stock  += Number(item.current_stock || 0)
    if (item.current_stock < Number(item.minimum_threshold || 0)) current.low_stock += 1
    categoryMap.set(key, current)
  }

  const categoryBreakdown = Array.from(categoryMap.values())
    .sort((a, b) => a.category.localeCompare(b.category))

  // ── 9. Transaction summaries ────────────────────────────────────────
  let totalIssued   = 0
  let totalReceived = 0
  const movementByItem  = new Map()
  const movementByBatch = new Map()

  for (const trx of transactions || []) {
    const qty    = Number(trx.quantity || 0)
    const signed = trx.transaction_type === 'ISSUE'   ? -qty
                 : trx.transaction_type === 'RECEIVE' ?  qty
                 : 0

    if (trx.transaction_type === 'ISSUE')   totalIssued   += qty
    if (trx.transaction_type === 'RECEIVE') totalReceived += qty

    addToMap(movementByItem,  trx.item_id,  signed)
    if (trx.batch_id) addToMap(movementByBatch, trx.batch_id, signed)
  }

  // ── 10. Reconciliation ──────────────────────────────────────────────
  const reconciliationByItem = stockSnapshot
    .map((item) => ({
      item_id:             item.id,
      laboratory_id:       item.laboratory_id,
      sku:                 item.sku,
      name:                item.name,
      category:            item.category,
      unit_of_measure:     item.unit_of_measure,
      current_stock:       Number(item.current_stock || 0),
      minimum_threshold:   Number(item.minimum_threshold || 0),
      period_net_movement: Number(movementByItem.get(item.id) || 0),
      status:              item.status,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const reconciliationByBatch = (batches || [])
    .map((batch) => ({
      batch_id:             batch.id,
      item_id:              batch.item_id,
      laboratory_id:        batch.laboratory_id,
      item_name:            batch.items?.name || 'Unknown item',
      sku:                  batch.items?.sku  || '—',
      batch_number:         batch.batch_number || '—',
      quantity_received:    Number(batch.quantity_received || 0),
      current_quantity:     Number(batch.current_quantity  || 0),
      issued_since_receipt: Number(batch.quantity_received || 0) - Number(batch.current_quantity || 0),
      period_net_movement:  Number(movementByBatch.get(batch.id) || 0),
      expiry_date:          batch.expiry_date,
      storage_location:     batch.storage_location,
      unit_of_measure:      batch.items?.dispensing_unit || batch.items?.unit_of_measure || 'units',
    }))
    .sort((a, b) => a.item_name.localeCompare(b.item_name))

  return {
    summary: {
      period,
      period_start:        startDate.toISOString(),
      period_end:          endDate.toISOString(),
      total_items:         stockSnapshot.length,
      low_stock_count:     lowStockItems.length,
      out_of_stock_count:  stockSnapshot.filter((i) => i.current_stock === 0).length,
      expiring_soon_count: expiringBatches.length,
      total_transactions:  (transactions || []).length,
      total_issued:        Number(totalIssued),
      total_received:      Number(totalReceived),
      selected_lab_id:     labId || null,
      is_all_labs:         !labId,
    },
    stock_snapshot:     stockSnapshot,
    category_breakdown: categoryBreakdown,
    low_stock_items:    lowStockItems,
    expiring_batches:   expiringBatches,
    transactions:       transactions || [],
    reconciliation: {
      by_item:  reconciliationByItem,
      by_batch: reconciliationByBatch,
      notes: [
        'Current stock is derived from stock_batches.current_quantity.',
        'Period net movement is from stock_transactions within the report period.',
        'Positive net movement = stock increased; negative = stock decreased.',
      ],
    },
  }
}
