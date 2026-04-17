import { getSupabase } from "../config/supabase.js"

function addToMap(map, key, value) {
  map.set(key, (map.get(key) || 0) + Number(value || 0))
}

function daysUntil(dateStr) {
  if (!dateStr) return null
  const diff = new Date(dateStr) - new Date()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

export async function getDashboardMetrics(labId = null, isAdmin = false) {
  const supabase = getSupabase()
  const isAllLabs = !labId

  // 1. Load items
  let itemsQuery = supabase
    .from("items")
    .select(`
      id,
      laboratory_id,
      category_id,
      name,
      sku,
      unit_of_measure,
      dispensing_unit,
      minimum_threshold,
      unit_price,
      categories ( name )
    `)

  if (labId) itemsQuery = itemsQuery.eq("laboratory_id", labId)

  const { data: items, error: itemsError } = await itemsQuery
  if (itemsError) throw itemsError

  // 2. Load stock batches
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
      items (
        id,
        name,
        sku,
        unit_of_measure,
        dispensing_unit,
        minimum_threshold,
        laboratory_id,
        categories ( name )
      )
    `)

  if (labId) batchesQuery = batchesQuery.eq("laboratory_id", labId)

  const { data: batches, error: batchesError } = await batchesQuery
  if (batchesError) throw batchesError

  // 3. Load recent transactions
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
      items ( id, name, sku, unit_of_measure ),
      stock_batches ( batch_number )
    `)
    .order("created_at", { ascending: false })
    .limit(10)

  if (labId) trxQuery = trxQuery.eq("laboratory_id", labId)

  const { data: recentTransactions, error: trxError } = await trxQuery
  if (trxError) throw trxError

  // 4. Build stock totals by item
  const stockByItem = new Map()
  for (const batch of batches || []) {
    addToMap(stockByItem, batch.item_id, batch.current_quantity || 0)
  }

  // 5. Inventory value
  let inventoryValue = 0
  for (const item of items || []) {
    const stockQty = Number(stockByItem.get(item.id) || 0)
    const unitPrice = Number(item.unit_price || 0)
    inventoryValue += stockQty * unitPrice
  }

  // 6. Low-stock items
  const lowStockItems = (items || [])
    .map((item) => {
      const currentStock = Number(stockByItem.get(item.id) || 0)
      const threshold = Number(item.minimum_threshold || 0)

      return {
        id: item.id,
        laboratory_id: item.laboratory_id,
        name: item.name,
        sku: item.sku,
        category: item.categories?.name || null,
        unit_of_measure: item.dispensing_unit || item.unit_of_measure || "units",
        current_stock: currentStock,
        minimum_threshold: threshold,
        shortage: Math.max(0, threshold - currentStock),
        is_low_stock: currentStock < threshold,
      }
    })
    .filter((item) => item.is_low_stock)
    .sort((a, b) => {
      const aRatio = a.minimum_threshold > 0 ? a.current_stock / a.minimum_threshold : 1
      const bRatio = b.minimum_threshold > 0 ? b.current_stock / b.minimum_threshold : 1
      return aRatio - bRatio
    })

  // 7. Expiring batches (next 30 days + already expired)
  const expiringBatches = (batches || [])
    .filter((batch) => batch.expiry_date)
    .map((batch) => {
      const days = daysUntil(batch.expiry_date)
      return {
        id: batch.id,
        item_id: batch.item_id,
        laboratory_id: batch.laboratory_id,
        batch_number: batch.batch_number,
        current_quantity: Number(batch.current_quantity || 0),
        quantity_received: Number(batch.quantity_received || 0),
        expiry_date: batch.expiry_date,
        days_to_expiry: days,
        storage_location: batch.storage_location,
        items: batch.items,
      }
    })
    .filter((batch) => batch.days_to_expiry !== null && batch.days_to_expiry <= 30)
    .sort((a, b) => a.days_to_expiry - b.days_to_expiry)

  // 8. Stock by category
  const categoryTotals = new Map()
  for (const batch of batches || []) {
    const categoryName = batch.items?.categories?.name || "Uncategorised"
    addToMap(categoryTotals, categoryName, batch.current_quantity || 0)
  }

  const stockByCategory = Array.from(categoryTotals.entries())
    .map(([category, total_quantity]) => ({
      category,
      total_quantity: Number(total_quantity),
    }))
    .sort((a, b) => b.total_quantity - a.total_quantity)

  // 9. Alerts grouped by lab (useful for SUPER_ADMIN all-labs view)
  const lowStockByLabMap = new Map()
  for (const item of lowStockItems) {
    const key = item.laboratory_id || "unknown"
    const current = lowStockByLabMap.get(key) || {
      laboratory_id: key,
      count: 0,
      items: [],
    }
    current.count += 1
    current.items.push(item)
    lowStockByLabMap.set(key, current)
  }

  const expiringByLabMap = new Map()
  for (const batch of expiringBatches) {
    const key = batch.laboratory_id || "unknown"
    const current = expiringByLabMap.get(key) || {
      laboratory_id: key,
      count: 0,
      batches: [],
    }
    current.count += 1
    current.batches.push(batch)
    expiringByLabMap.set(key, current)
  }

  const lowStockByLab = Array.from(lowStockByLabMap.values()).sort((a, b) => b.count - a.count)
  const expiringByLab = Array.from(expiringByLabMap.values()).sort((a, b) => b.count - a.count)

  return {
    total_items: Array.isArray(items) ? items.length : 0,
    low_stock: lowStockItems.length,
    expiring_soon: expiringBatches.length,
    inventory_value: Number(inventoryValue.toFixed(2)),
    low_stock_items: lowStockItems.slice(0, 10),
    expiring_batches: expiringBatches.slice(0, 10),
    stock_by_category: stockByCategory,
    recent_transactions: recentTransactions || [],
    low_stock_by_lab: lowStockByLab,
    expiring_by_lab: expiringByLab,
    is_all_labs: isAllLabs,
    selected_lab_id: labId || null,
    user_is_admin: Boolean(isAdmin),
  }
}