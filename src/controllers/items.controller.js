import { getSupabase } from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";

const supabase = getSupabase();

/**
 * Utility: Write Audit Log
 */
async function writeAuditLog({
  userId,
  labId,
  action,
  entity,
  entityId,
  oldData = null,
  newData = null
}) {

  const { error } = await supabase.from("audit_logs").insert({
    id: uuidv4(),
    user_id: userId,
    laboratory_id: labId,
    action,
    entity,
    entity_id: entityId,
    old_data: oldData,
    new_data: newData,
    created_at: new Date()
  });

  if (error) {
    console.error("Audit log error:", error);
  }
}

/**
 * GET /api/items
 */
export const getItems = async (req, res) => {
  try {
    const labId = req.user.laboratory_id

    const { data, error } = await supabase
      .from('items')
      .select(`
        *,
        categories(name, type),
        suppliers(name)
      `)
      .eq('laboratory_id', labId)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

export const searchItems = async (req, res) => {

  const labId = req.user.laboratory_id

  const {
    search = '',
    category,
    low_stock,
    page = 1,
    limit = 20,
    sort = 'created_at'
  } = req.query

  const offset = (page - 1) * limit

  try {

    let query = supabase
      .from('items')
      .select(`
        *,
        categories(name),
        suppliers(name)
      `, { count: 'exact' })
      .eq('laboratory_id', labId)

    if (search) {
      query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`)
    }

    if (category) {
      query = query.eq('category_id', category)
    }

    query = query.order(sort, { ascending: true })

    query = query.range(offset, offset + limit - 1)

    const { data, error, count } = await query

    if (error) throw error

    /**
     * LOW STOCK FILTER
     * done via batches
     */

    let filteredData = data

    if (low_stock === 'true') {

      const itemIds = data.map(i => i.id)

      const { data: batches } = await supabase
        .from('stock_batches')
        .select('item_id, current_quantity')

      const stockMap = {}

      batches.forEach(b => {
        stockMap[b.item_id] = (stockMap[b.item_id] || 0) + b.current_quantity
      })

      filteredData = data.filter(i =>
        (stockMap[i.id] || 0) < i.minimum_threshold
      )
    }

    res.json({
      data: filteredData,
      pagination: {
        total: count,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(count / limit)
      }
    })

  } catch (err) {

    res.status(500).json({
      error: err.message
    })

  }

}

/**
 * GET /api/items/:id
 */
export const getItemById = async (req, res) => {
  try {
    const labId = req.user.laboratory_id
    const { id } = req.params

    const { data, error } = await supabase
      .from('items')
      .select(`
        *,
        categories(name, type),
        suppliers(name)
      `)
      .eq('id', id)
      .eq('laboratory_id', labId)
      .single()

    if (error || !data) {
      return res.status(404).json({ error: 'Item not found' })
    }

    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

/**
 * POST /api/items
 */
export const createItem = async (req, res) => {
  const labId = req.user.laboratory_id
  const userId = req.user.id

  const {
    category_id,
    supplier_id,
    name,
    sku,
    barcode,
    unit_of_measure,
    minimum_threshold,
    reorder_quantity,
    max_stock_level,
    hazard_class,
    storage_condition,
    regulatory_notes,
    is_perishable,
    item_type,
    extension_data = {}
  } = req.body

  try {

    /**
     * VALIDATE CATEGORY BELONGS TO SAME LAB
     */
    const { data: category } = await supabase
      .from('categories')
      .select('id')
      .eq('id', category_id)
      .eq('laboratory_id', labId)
      .single()

    if (!category) {
      return res.status(400).json({
        error: 'Invalid category for this laboratory'
      })
    }

    /**
     * CHEMICAL VALIDATION
     */
    if (item_type === 'CHEMICAL' && !hazard_class) {
      return res.status(400).json({
        error: 'Hazard class required for chemical items'
      })
    }

    /**
     * EQUIPMENT VALIDATION
     */
    if (
      item_type === 'EQUIPMENT' &&
      !extension_data?.maintenance_interval_days
    ) {
      return res.status(400).json({
        error: 'Maintenance interval required for equipment'
      })
    }

    /**
     * CRM VALIDATION
     */
    if (
      item_type === 'CRM' &&
      !extension_data?.certification_expiry
    ) {
      return res.status(400).json({
        error: 'Certification expiry required for CRM'
      })
    }

    /**
     * CHECK SKU UNIQUENESS PER LAB
     */
    const { data: existing } = await supabase
      .from('items')
      .select('id')
      .eq('laboratory_id', labId)
      .eq('sku', sku)
      .maybeSingle()

    if (existing) {
      return res.status(400).json({
        error: 'SKU already exists in this laboratory'
      })
    }

    const itemId = uuidv4()

    /**
     * INSERT ITEM
     */
    const { error: itemError } = await supabase.from('items').insert({
      id: itemId,
      laboratory_id: labId,
      category_id,
      supplier_id,
      name,
      sku,
      barcode,
      unit_of_measure,
      minimum_threshold,
      reorder_quantity,
      max_stock_level,
      hazard_class,
      storage_condition,
      regulatory_notes,
      is_perishable,
      item_type,
      created_at: new Date()
    })

    if (itemError) throw itemError

    /**
     * INSERT EXTENSION TABLE
     */
    await insertExtensionTable(item_type, itemId, extension_data)

    /**
     * WRITE AUDIT LOG
     */
    await writeAuditLog({
      userId,
      labId,
      action: 'CREATE',
      entity: 'ITEM',
      entityId: itemId,
      newData: req.body
    })

    /**
     * RETURN FULL ITEM OBJECT
     */
    const { data: newItem } = await supabase
      .from('items')
      .select(`
        *,
        categories(name, type),
        suppliers(name)
      `)
      .eq('id', itemId)
      .single()

    return res.status(201).json(newItem)

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

/**
 * PUT /api/items/:id
 */
export const updateItem = async (req, res) => {
  const labId = req.user.laboratory_id
  const userId = req.user.id
  const { id } = req.params

  try {
    const { data: existingItem } = await supabase
      .from('items')
      .select('*')
      .eq('id', id)
      .eq('laboratory_id', labId)
      .single()

    if (!existingItem) {
      return res.status(404).json({ error: 'Item not found' })
    }

    const { error } = await supabase
      .from('items')
      .update(req.body)
      .eq('id', id)
      .eq('laboratory_id', labId)

    if (error) throw error

    await writeAuditLog({
      userId,
      labId,
      action: 'UPDATE',
      entity: 'ITEM',
      entityId: id,
      oldData: existingItem,
      newData: req.body
    })

    return res.json({ message: 'Item updated successfully' })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

/**
 * DELETE /api/items/:id
 */
export const deleteItem = async (req, res) => {
  const labId = req.user.laboratory_id
  const userId = req.user.id
  const { id } = req.params

  try {
    const { data: existingItem } = await supabase
      .from('items')
      .select('*')
      .eq('id', id)
      .eq('laboratory_id', labId)
      .single()

    if (!existingItem) {
      return res.status(404).json({ error: 'Item not found' })
    }

    const { error } = await supabase
      .from('items')
      .delete()
      .eq('id', id)
      .eq('laboratory_id', labId)

    if (error) throw error

    await writeAuditLog({
      userId,
      labId,
      action: 'DELETE',
      entity: 'ITEM',
      entityId: id,
      oldData: existingItem
    })

    return res.json({ message: 'Item deleted successfully' })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

/**
 * Extension Table Handler
 */
async function insertExtensionTable(itemType, itemId, data = {}) {
  const tableMap = {
    CHEMICAL: 'item_chemical_details',
    EQUIPMENT: 'item_equipment_details',
    CRM: 'item_reference_details'
  }

  const tableName = tableMap[itemType]
  if (!tableName) return

  const { error } = await supabase
    .from(tableName)
    .insert({ item_id: itemId, ...data })

  if (error) throw error
}