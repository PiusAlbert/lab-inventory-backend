import { getSupabase } from "../config/supabase.js"

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

function getPeriodRange(period = "monthly", start = null, end = null) {
  const now = new Date()

  if (period === "custom") {
    if (!start || !end) {
      throw new Error("Custom report requires start and end dates")
    }

    return {
      startDate: startOfDay(new Date(start)),
      endDate: endOfDay(new Date(end)),
    }
  }

  if (period === "weekly") {
    const endDate = endOfDay(now)
    const startDate = startOfDay(new Date(now))
    startDate.setDate(startDate.getDate() - 6)

    return { startDate, endDate }
  }

  if (period === "monthly") {
    const endDate = endOfDay(now)
    const startDate = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1))

    return { startDate, endDate }
  }

  throw new Error("Unsupported report period")
}

function daysUntil(dateStr) {
  if (!dateStr) return null
  const diff = new Date(dateStr) - new Date()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

function addToMap(map, key, value) {
  map.set(key, (map.get(key) || 0) + Number(value || 0))
}

export async function generateReport(labId = null, period = "monthly", start = null, end = null) {
  const supabase = getSupabase()
  const { startDate, endDate } = getPeriodRange(period, start, end)

  // 1. Items
  let itemsQuery = supabase
    .from("items")
    .select(`
      id,
      laboratory_id,
      category_id,
      supplier_id,
      name,
      sku,
      barcode,
      unit_of_measure,
      dispensing_unit,
      minimum_threshold,
      reorder_quantity,
      max_stock_level,
      item_type,
      unit_price,
      hazard_class,
      storage_condition,
      is_perishable,
      categories ( name )
    `)
    .order("name", { ascending: true })

  if (labId) itemsQuery = itemsQuery.eq("laboratory_id", labId)

  const { data: items, error: itemsError } = await itemsQuery
  if (itemsError) throw itemsError

  // 2. Current stock batches
  let batchesQuery = supabase
    .from("stock_batches")
    .select(`
      id,
      item_id,
      laboratory_id,
      batch_number,
      quantity_received,
      current_quantity,
      expiry_date,
      storage_location,
      received_at,
      created_at,
      items (
        id,
        name,
        sku,
        unit_of_measure,
        dispensing_unit,
        minimum_threshold,
        item_type,
        categories ( name )
      )
    `)

  if (labId) batchesQuery = batchesQuery.eq("laboratory_id", labId)

  const { data: batches, error: batchesError } = await batchesQuery
  if (batchesError) throw batchesError

  // 3. Transactions within report period
  let trxQuery = supabase
    .from("stock_transactions")
    .select(`
      id,
      item_id,
      batch_id,
      laboratory_id,
      transaction_type,
      quantity,
      reference,
      notes,
      created_at,
      items ( id, name, sku, unit_of_measure, dispensing_unit, categories ( name ) ),
      stock_batches ( id, batch_number )
    `)
    .gte("created_at", startDate.toISOString())
    .lte("created_at", endDate.toISOString())
    .order("created_at", { ascending: false })

  if (labId) trxQuery = trxQuery.eq("laboratory_id", labId)

  const { data: transactions, error: trxError } = await trxQuery
  if (trxError) throw trxError

  // 4. Current stock totals per item from batches
  const stockByItem = new Map()
  for (const batch of batches || []) {
    addToMap(stockByItem, batch.item_id, batch.current_quantity || 0)
  }

  // 5. Stock snapshot
  const stockSnapshot = (items || []).map((item) => {
    const currentStock = Number(stockByItem.get(item.id) || 0)
    const unit = item.dispensing_unit || item.unit_of_measure || "units"
    const threshold = Number(item.minimum_threshold || 0)

    return {
      id: item.id,
      laboratory_id: item.laboratory_id,
      sku: item.sku,
      name: item.name,
      category: item.categories?.name || "Uncategorised",
      item_type: item.item_type,
      current_stock: currentStock,
      unit_of_measure: unit,
      minimum_threshold: threshold,
      reorder_quantity: item.reorder_quantity,
      max_stock_level: item.max_stock_level,
      hazard_class: item.hazard_class,
      storage_condition: item.storage_condition,
      is_perishable: item.is_perishable,
      status:
        currentStock === 0
          ? "OUT_OF_STOCK"
          : currentStock < threshold
            ? "LOW_STOCK"
            : "OK",
    }
  })

  // 6. Low stock items
  const lowStockItems = stockSnapshot
    .filter((item) => item.current_stock < Number(item.minimum_threshold || 0))
    .sort((a, b) => {
      const aRatio = a.minimum_threshold > 0 ? a.current_stock / a.minimum_threshold : 1
      const bRatio = b.minimum_threshold > 0 ? b.current_stock / b.minimum_threshold : 1
      return aRatio - bRatio
    })

  // 7. Expiring batches
  const expiringBatches = (batches || [])
    .filter((b) => b.expiry_date)
    .map((b) => ({
      id: b.id,
      item_id: b.item_id,
      laboratory_id: b.laboratory_id,
      batch_number: b.batch_number,
      expiry_date: b.expiry_date,
      days_to_expiry: daysUntil(b.expiry_date),
      current_quantity: Number(b.current_quantity || 0),
      quantity_received: Number(b.quantity_received || 0),
      storage_location: b.storage_location,
      item_name: b.items?.name || "Unknown item",
      sku: b.items?.sku || "—",
      category: b.items?.categories?.name || "Uncategorised",
      unit_of_measure: b.items?.dispensing_unit || b.items?.unit_of_measure || "units",
    }))
    .filter((b) => b.days_to_expiry !== null && b.days_to_expiry <= 30)
    .sort((a, b) => a.days_to_expiry - b.days_to_expiry)

  // 8. Category breakdown from current stock snapshot
  const categoryMap = new Map()
  for (const item of stockSnapshot) {
    const key = item.category || "Uncategorised"
    const current = categoryMap.get(key) || {
      category: key,
      total_items: 0,
      total_stock: 0,
      low_stock: 0,
    }

    current.total_items += 1
    current.total_stock += Number(item.current_stock || 0)
    if (item.current_stock < Number(item.minimum_threshold || 0)) {
      current.low_stock += 1
    }

    categoryMap.set(key, current)
  }

  const categoryBreakdown = Array.from(categoryMap.values()).sort((a, b) =>
    a.category.localeCompare(b.category)
  )

  // 9. Transaction summaries
  const totalIssued = (transactions || [])
    .filter((t) => t.transaction_type === "ISSUE")
    .reduce((sum, t) => sum + Number(t.quantity || 0), 0)

  const totalReceived = (transactions || [])
    .filter((t) => t.transaction_type === "RECEIVE")
    .reduce((sum, t) => sum + Number(t.quantity || 0), 0)

  // 10. Reconciliation from transaction history vs current stock
  // Net movement in this period = receives - issues
  const movementByItem = new Map()
  const movementByBatch = new Map()

  for (const trx of transactions || []) {
    const signedQty =
      trx.transaction_type === "ISSUE"
        ? -Number(trx.quantity || 0)
        : trx.transaction_type === "RECEIVE"
          ? Number(trx.quantity || 0)
          : 0

    addToMap(movementByItem, trx.item_id, signedQty)

    if (trx.batch_id) {
      addToMap(movementByBatch, trx.batch_id, signedQty)
    }
  }

  const reconciliationByItem = stockSnapshot
    .map((item) => {
      const periodNetMovement = Number(movementByItem.get(item.id) || 0)

      return {
        item_id: item.id,
        laboratory_id: item.laboratory_id,
        sku: item.sku,
        name: item.name,
        category: item.category,
        unit_of_measure: item.unit_of_measure,
        current_stock: Number(item.current_stock || 0),
        minimum_threshold: Number(item.minimum_threshold || 0),
        period_net_movement: periodNetMovement,
        status:
          item.current_stock === 0
            ? "OUT_OF_STOCK"
            : item.current_stock < item.minimum_threshold
              ? "LOW_STOCK"
              : "OK",
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const reconciliationByBatch = (batches || [])
    .map((batch) => {
      const periodNetMovement = Number(movementByBatch.get(batch.id) || 0)
      const issuedSinceReceipt =
        Number(batch.quantity_received || 0) - Number(batch.current_quantity || 0)

      return {
        batch_id: batch.id,
        item_id: batch.item_id,
        laboratory_id: batch.laboratory_id,
        item_name: batch.items?.name || "Unknown item",
        sku: batch.items?.sku || "—",
        batch_number: batch.batch_number || "—",
        quantity_received: Number(batch.quantity_received || 0),
        current_quantity: Number(batch.current_quantity || 0),
        issued_since_receipt: issuedSinceReceipt,
        period_net_movement: periodNetMovement,
        expiry_date: batch.expiry_date,
        storage_location: batch.storage_location,
        unit_of_measure:
          batch.items?.dispensing_unit || batch.items?.unit_of_measure || "units",
      }
    })
    .sort((a, b) => a.item_name.localeCompare(b.item_name))

  const report = {
    summary: {
      period,
      period_start: startDate.toISOString(),
      period_end: endDate.toISOString(),
      total_items: stockSnapshot.length,
      low_stock_count: lowStockItems.length,
      out_of_stock_count: stockSnapshot.filter((i) => i.current_stock === 0).length,
      expiring_soon_count: expiringBatches.length,
      total_transactions: (transactions || []).length,
      total_issued: Number(totalIssued),
      total_received: Number(totalReceived),
      selected_lab_id: labId || null,
      is_all_labs: !labId,
    },

    stock_snapshot: stockSnapshot,
    category_breakdown: categoryBreakdown,
    low_stock_items: lowStockItems,
    expiring_batches: expiringBatches,
    transactions: transactions || [],

    reconciliation: {
      by_item: reconciliationByItem,
      by_batch: reconciliationByBatch,
      notes: [
        "Current stock is derived from stock_batches.current_quantity.",
        "Period net movement is derived from stock_transactions within the selected report period.",
        "Positive net movement means stock increased during the report period; negative means stock decreased.",
      ],
    },
  }

  return report
}