import { getSupabase } from '../config/supabase.js'
import { v4 as uuidv4 } from 'uuid'
import { writeAuditLog } from '../utils/audit.js'
import { cleanObject, normalizeNullableString, safeNumber, safePositiveNumber } from '../utils/helpers.js'
import { invalidateProfileCache } from '../middleware/auth.middleware.js'

// ── Private helpers ───────────────────────────────────────────────────

/**
 * Normalises a raw item payload from the request body into DB-ready fields.
 * Using safeNumber / safePositiveNumber removes the verbose ternary chains
 * that were scattered across createItem and updateItem.
 */
function normalizeItemPayload(body = {}) {
  return {
    category_id:        body.category_id,
    supplier_id:        body.supplier_id        ?? null,
    name:               body.name,
    sku:                body.sku,
    barcode:            body.barcode            ?? null,
    unit_of_measure:    body.unit_of_measure,
    dispensing_unit:    body.dispensing_unit     ?? null,
    conversion_factor:  safePositiveNumber(body.conversion_factor),
    minimum_threshold:  safeNumber(body.minimum_threshold, 0),
    reorder_quantity:   safeNumber(body.reorder_quantity),
    max_stock_level:    safeNumber(body.max_stock_level),
    hazard_class:       body.hazard_class        ?? null,
    storage_condition:  body.storage_condition   ?? null,
    regulatory_notes:   body.regulatory_notes    ?? null,
    is_perishable:      Boolean(body.is_perishable),
    item_type:          body.item_type,
    unit_price:         safeNumber(body.unit_price),
  }
}

function normalizeExtensionData(itemType, data = {}) {
  if (!data || typeof data !== 'object') return {}

  if (itemType === 'CHEMICAL') {
    return cleanObject({
      formula:            data.formula            ?? null,
      cas_number:         data.cas_number         ?? null,
      molecular_weight:   safePositiveNumber(data.molecular_weight),
      msds_url:           data.msds_url            ?? null,
      pubchem_id:         safePositiveNumber(data.pubchem_id),
      ghp_classification: data.ghp_classification  ?? null,
    })
  }

  if (itemType === 'EQUIPMENT') {
    return cleanObject({
      model_number:              data.model_number              ?? null,
      serial_number:             data.serial_number             ?? null,
      maintenance_interval_days: safePositiveNumber(data.maintenance_interval_days),
      last_maintenance_date:     data.last_maintenance_date     ?? null,
      warranty_expiry:           data.warranty_expiry           ?? null,
    })
  }

  if (itemType === 'CRM') {
    return cleanObject({
      certification_number: data.certification_number ?? null,
      certification_expiry: data.certification_expiry ?? null,
      issuing_body:         data.issuing_body         ?? null,
    })
  }

  return {}
}

const EXTENSION_TABLE = {
  CHEMICAL:  'item_chemical_details',
  EQUIPMENT: 'item_equipment_details',
  CRM:       'item_reference_details',
}

async function insertExtensionTable(itemType, itemId, data = {}) {
  const tableName = EXTENSION_TABLE[itemType]
  if (!tableName) return

  const normalized = normalizeExtensionData(itemType, data)
  const { error } = await getSupabase().from(tableName).insert({ item_id: itemId, ...normalized })
  if (error) throw error
}

async function upsertExtensionTable(itemType, itemId, data = {}) {
  const tableName = EXTENSION_TABLE[itemType]
  if (!tableName) return

  const normalized = normalizeExtensionData(itemType, data)
  const { error } = await getSupabase()
    .from(tableName)
    .upsert({ item_id: itemId, ...normalized }, { onConflict: 'item_id' })
  if (error) throw error
}

/**
 * Deletes rows from the extension tables that DO NOT belong to itemType.
 * Only runs when the item_type has actually changed, avoiding unnecessary
 * DELETEs when editing a CHEMICAL item that remains a CHEMICAL item.
 */
async function deleteStaleExtensionRows(newItemType, oldItemType, itemId) {
  if (newItemType === oldItemType) return

  const supabase = getSupabase()
  const tablesToClear = Object.entries(EXTENSION_TABLE)
    .filter(([type]) => type !== newItemType)
    .map(([, tableName]) => tableName)

  await Promise.all(
    tablesToClear.map((tableName) =>
      supabase.from(tableName).delete().eq('item_id', itemId)
    )
  )
}

const ITEM_WITH_JOINS_SELECT = `
  *,
  categories          ( name ),
  suppliers           ( name ),
  item_chemical_details (
    formula, cas_number, molecular_weight, msds_url, pubchem_id, ghp_classification
  ),
  item_equipment_details (
    model_number, serial_number, maintenance_interval_days,
    last_maintenance_date, warranty_expiry
  ),
  item_reference_details (
    certification_number, certification_expiry, issuing_body
  )
`

async function fetchSingleItemWithJoins(id, labId = null) {
  let query = getSupabase()
    .from('items')
    .select(ITEM_WITH_JOINS_SELECT)
    .eq('id', id)

  if (labId) query = query.eq('laboratory_id', labId)

  const { data, error } = await query.single()
  if (error || !data) throw new Error('Item not found')
  return data
}

// ── Route handlers ────────────────────────────────────────────────────

export const getItems = async (req, res) => {
  const labId = req.user.laboratory_id ?? null

  try {
    let query = getSupabase()
      .from('items')
      .select('*, categories(name), suppliers(name)')
      .order('created_at', { ascending: false })

    if (labId) query = query.eq('laboratory_id', labId)

    const { data, error } = await query
    if (error) throw error

    return res.json(data)
  } catch (err) {
    console.error('[getItems]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}


/**
 * GET /api/items/search
 *
 * When low_stock=true, the filter is applied BEFORE pagination so that
 * the paginated page is drawn from the full low-stock set, not from a
 * pre-paginated slice that may contain zero low-stock items.
 */
export const searchItems = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const {
    search   = '',
    category,
    low_stock,
    page  = 1,
    limit = 20,
    sort  = 'created_at',
  } = req.query

  const pageNum  = Math.max(1, Number(page))
  const limitNum = Math.min(100, Math.max(1, Number(limit)))
  const offset   = (pageNum - 1) * limitNum

  try {
    // ── Low-stock path: filter THEN paginate ────────────────────────
    if (low_stock === 'true') {
      // 1. Batch totals for the lab
      let bq = supabase.from('stock_batches').select('item_id, current_quantity')
      if (labId) bq = bq.eq('laboratory_id', labId)
      const { data: batches, error: batchErr } = await bq
      if (batchErr) throw batchErr

      const stockMap = {}
      for (const b of batches || []) {
        stockMap[b.item_id] = (stockMap[b.item_id] || 0) + Number(b.current_quantity || 0)
      }

      // 2. All matching items (no range — we need the full set to filter correctly)
      let allQ = supabase
        .from('items')
        .select('*, categories(name), suppliers(name)')
        .order(sort, { ascending: true })
      if (labId)    allQ = allQ.eq('laboratory_id', labId)
      if (search)   allQ = allQ.or(`name.ilike.%${search}%,sku.ilike.%${search}%`)
      if (category) allQ = allQ.eq('category_id', category)

      const { data: allItems, error: allErr } = await allQ
      if (allErr) throw allErr

      // 3. Apply low-stock filter, then paginate in JS
      const lowStock = (allItems || []).filter(
        (i) => (stockMap[i.id] || 0) < Number(i.minimum_threshold || 0)
      )

      return res.json({
        data: lowStock.slice(offset, offset + limitNum),
        pagination: {
          total: lowStock.length,
          page:  pageNum,
          limit: limitNum,
          pages: Math.ceil(lowStock.length / limitNum),
        },
      })
    }

    // ── Normal search path: let DB paginate ─────────────────────────
    let query = supabase
      .from('items')
      .select('*, categories(name), suppliers(name)', { count: 'exact' })
      .order(sort, { ascending: true })
      .range(offset, offset + limitNum - 1)

    if (labId)    query = query.eq('laboratory_id', labId)
    if (search)   query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`)
    if (category) query = query.eq('category_id', category)

    const { data, error, count } = await query
    if (error) throw error

    return res.json({
      data,
      pagination: {
        total: count,
        page:  pageNum,
        limit: limitNum,
        pages: Math.ceil((count || 0) / limitNum),
      },
    })
  } catch (err) {
    console.error('[searchItems]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}


export const getItemById = async (req, res) => {
  const labId = req.user.laboratory_id ?? null
  const { id } = req.params

  try {
    const item = await fetchSingleItemWithJoins(id, labId)
    return res.json(item)
  } catch {
    return res.status(404).json({ error: 'Item not found' })
  }
}


export const createItem = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id
  const userId   = req.user.id

  if (!labId) {
    return res.status(400).json({ error: 'Please select a laboratory before adding items' })
  }

  const { extension_data = {}, ...rawItemFields } = req.body
  const itemFields = normalizeItemPayload(rawItemFields)
  const { category_id, name, sku, unit_of_measure, item_type, hazard_class,
          dispensing_unit, conversion_factor } = itemFields

  try {
    // ── Validation ────────────────────────────────────────────────────
    if (!name?.trim())        return res.status(400).json({ error: 'Name is required' })
    if (!sku?.trim())         return res.status(400).json({ error: 'SKU is required' })
    if (!item_type)           return res.status(400).json({ error: 'Item type is required' })
    if (!category_id)         return res.status(400).json({ error: 'Category is required' })
    if (!unit_of_measure)     return res.status(400).json({ error: 'Unit of measure is required' })

    if (item_type === 'CHEMICAL' && !hazard_class) {
      return res.status(400).json({ error: 'Hazard class is required for chemical items' })
    }

    if (dispensing_unit && (conversion_factor == null || conversion_factor <= 0)) {
      return res.status(400).json({
        error: 'Conversion factor must be greater than 0 when a dispensing unit is set',
      })
    }

    if (item_type === 'EQUIPMENT' && !extension_data?.maintenance_interval_days) {
      return res.status(400).json({ error: 'Maintenance interval is required for equipment' })
    }

    if (item_type === 'CRM' && !extension_data?.certification_expiry) {
      return res.status(400).json({ error: 'Certification expiry is required for CRM items' })
    }

    // ── Category existence check ──────────────────────────────────────
    const { data: category, error: categoryError } = await supabase
      .from('categories')
      .select('id')
      .eq('id', category_id)
      .single()

    if (categoryError || !category) {
      return res.status(400).json({ error: 'Invalid category' })
    }

    // ── SKU uniqueness check (per lab) ────────────────────────────────
    const { data: existing } = await supabase
      .from('items')
      .select('id')
      .eq('laboratory_id', labId)
      .eq('sku', sku)
      .maybeSingle()

    if (existing) {
      return res.status(400).json({ error: 'SKU already exists in this laboratory' })
    }

    // ── Insert ────────────────────────────────────────────────────────
    const itemId = uuidv4()

    const { error: itemError } = await supabase
      .from('items')
      .insert({ id: itemId, laboratory_id: labId, ...itemFields })

    if (itemError) throw itemError

    await insertExtensionTable(item_type, itemId, extension_data)

    await writeAuditLog({ userId, action: 'CREATE', entity: 'items', entityId: itemId, newData: req.body })

    // Use .select() on the insert to avoid the extra round-trip for simple cases,
    // but fetchSingleItemWithJoins gives us all the joined data the frontend needs.
    const item = await fetchSingleItemWithJoins(itemId, labId)
    return res.status(201).json(item)
  } catch (err) {
    console.error('[createItem]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}


export const updateItem = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const userId   = req.user.id
  const { id }   = req.params

  const { extension_data = {}, ...rawItemFields } = req.body
  const cleanedRaw = cleanObject(rawItemFields)

  try {
    // ── Load existing record ──────────────────────────────────────────
    let existingQuery = supabase.from('items').select('*').eq('id', id)
    if (labId) existingQuery = existingQuery.eq('laboratory_id', labId)

    const { data: existingItem, error: existingErr } = await existingQuery.single()
    if (existingErr || !existingItem) {
      return res.status(404).json({ error: 'Item not found' })
    }

    // Merge existing values with incoming changes, then normalise
    const mergedItemFields = normalizeItemPayload({ ...existingItem, ...cleanedRaw })
    const itemType = mergedItemFields.item_type || existingItem.item_type

    // ── Validation ────────────────────────────────────────────────────
    if (!mergedItemFields.name?.trim()) {
      return res.status(400).json({ error: 'Name is required' })
    }
    if (!mergedItemFields.sku?.trim()) {
      return res.status(400).json({ error: 'SKU is required' })
    }
    if (!mergedItemFields.category_id) {
      return res.status(400).json({ error: 'Category is required' })
    }
    if (!mergedItemFields.unit_of_measure) {
      return res.status(400).json({ error: 'Unit of measure is required' })
    }
    if (itemType === 'CHEMICAL' && !mergedItemFields.hazard_class) {
      return res.status(400).json({ error: 'Hazard class is required for chemical items' })
    }
    if (
      mergedItemFields.dispensing_unit &&
      (mergedItemFields.conversion_factor == null || mergedItemFields.conversion_factor <= 0)
    ) {
      return res.status(400).json({
        error: 'Conversion factor must be greater than 0 when a dispensing unit is set',
      })
    }

    const normalizedExt = normalizeExtensionData(itemType, extension_data)

    if (itemType === 'EQUIPMENT' && existingItem.item_type !== 'EQUIPMENT' &&
        !normalizedExt.maintenance_interval_days) {
      return res.status(400).json({ error: 'Maintenance interval is required for equipment' })
    }
    if (itemType === 'CRM' && existingItem.item_type !== 'CRM' && !normalizedExt.certification_expiry) {
      return res.status(400).json({ error: 'Certification expiry is required for CRM items' })
    }

    // ── SKU uniqueness (only when SKU changed) ────────────────────────
    if (mergedItemFields.sku !== existingItem.sku) {
      const scopedLabId = labId ?? existingItem.laboratory_id ?? null
      let dupQuery = supabase.from('items').select('id').eq('sku', mergedItemFields.sku).neq('id', id)
      if (scopedLabId) dupQuery = dupQuery.eq('laboratory_id', scopedLabId)

      const { data: duplicate } = await dupQuery.maybeSingle()
      if (duplicate) {
        return res.status(400).json({ error: 'SKU already exists in this laboratory' })
      }
    }

    // ── Category existence check ──────────────────────────────────────
    const { data: category, error: categoryError } = await supabase
      .from('categories')
      .select('id')
      .eq('id', mergedItemFields.category_id)
      .single()

    if (categoryError || !category) {
      return res.status(400).json({ error: 'Invalid category' })
    }

    // ── Update ────────────────────────────────────────────────────────
    let updateQuery = supabase.from('items').update(mergedItemFields).eq('id', id)
    if (labId) updateQuery = updateQuery.eq('laboratory_id', labId)

    const { error: updateError } = await updateQuery
    if (updateError) throw updateError

    await upsertExtensionTable(itemType, id, extension_data)

    // Delete stale extension rows only when item_type changes
    await deleteStaleExtensionRows(itemType, existingItem.item_type, id)

    await writeAuditLog({
      userId,
      action:   'UPDATE',
      entity:   'items',
      entityId: id,
      oldData:  existingItem,
      newData:  req.body,
    })

    const updatedItem = await fetchSingleItemWithJoins(id, labId)
    return res.json(updatedItem)
  } catch (err) {
    console.error('[updateItem]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}


export const deleteItem = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const userId   = req.user.id
  const { id }   = req.params

  try {
    let selectQuery = supabase.from('items').select('*').eq('id', id)
    if (labId) selectQuery = selectQuery.eq('laboratory_id', labId)

    const { data: existingItem, error: existingErr } = await selectQuery.single()
    if (existingErr || !existingItem) {
      return res.status(404).json({ error: 'Item not found' })
    }

    // Block hard-delete if the item has any stock transactions
    const { count, error: trxCheckErr } = await supabase
      .from('stock_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('item_id', id)

    if (trxCheckErr) throw trxCheckErr

    if ((count || 0) > 0) {
      // Soft-delete: preserves history
      let deactivateQuery = supabase.from('items').update({ is_active: false }).eq('id', id)
      if (labId) deactivateQuery = deactivateQuery.eq('laboratory_id', labId)

      const { error: deactivateError } = await deactivateQuery
      if (deactivateError) throw deactivateError

      await writeAuditLog({ userId, action: 'DELETE', entity: 'items', entityId: id, oldData: existingItem })
      return res.json({ message: 'Item deactivated (has transaction history — use is_active filter to hide)' })
    }

    let deleteQuery = supabase.from('items').delete().eq('id', id)
    if (labId) deleteQuery = deleteQuery.eq('laboratory_id', labId)

    const { error } = await deleteQuery
    if (error) throw error

    await writeAuditLog({ userId, action: 'DELETE', entity: 'items', entityId: id, oldData: existingItem })
    return res.json({ message: 'Item deleted successfully' })
  } catch (err) {
    console.error('[deleteItem]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}
