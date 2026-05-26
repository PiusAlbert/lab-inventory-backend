import { getSupabase } from '../config/supabase.js'
import { v4 as uuidv4 } from 'uuid'
import { writeAuditLog } from '../utils/audit.js'
import { cleanObject, normalizeNullableString, safeNumber } from '../utils/helpers.js'

/**
 * DUAL-UNIT ARCHITECTURE
 *
 * items.unit_of_measure   = packaging / stock unit  (bottle, kg, box)
 * items.dispensing_unit   = usage / base unit        (ml, g, mg)  — null = same unit
 * items.conversion_factor = dispensing units per stock unit       — null = 1
 *
 * Batches ALWAYS store quantities in the dispensing/base unit.
 *
 * Receive:  user enters stock units → multiply by conversion_factor → store base qty
 * Issue:    stockTransactions.controller deducts from current_quantity in base units
 */

const BATCH_WITH_ITEM_SELECT = `
  *,
  items (
    id, name, sku, unit_of_measure, dispensing_unit, conversion_factor, minimum_threshold,
    categories ( name )
  )
`

// ── Route handlers ────────────────────────────────────────────────────

/**
 * GET /api/batches
 * Paginated list of all batches for the effective laboratory.
 */
export const getBatches = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null

  try {
    let query = supabase
      .from('stock_batches')
      .select(BATCH_WITH_ITEM_SELECT)
      .order('created_at', { ascending: false })

    if (labId) query = query.eq('laboratory_id', labId)

    const { data, error } = await query
    if (error) throw error

    return res.json(data)
  } catch (err) {
    console.error('[getBatches]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}


/**
 * GET /api/batches/item/:itemId
 * All batches for a specific item, sorted FIFO (nearest expiry first, nulls last).
 */
export const getBatchesByItem = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { itemId } = req.params

  try {
    let query = supabase
      .from('stock_batches')
      .select(`
        *,
        items ( id, name, sku, unit_of_measure, dispensing_unit, conversion_factor )
      `)
      .eq('item_id', itemId)
      .order('expiry_date', { ascending: true, nullsFirst: false })

    if (labId) query = query.eq('laboratory_id', labId)

    const { data, error } = await query
    if (error) throw error

    return res.json(data)
  } catch (err) {
    console.error('[getBatchesByItem]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}


/**
 * POST /api/batches
 *
 * Creates a new batch (new purchase / stock receipt).
 * Quantities stored in the dispensing/base unit after applying conversion_factor.
 *
 * Body:
 *   item_id           — uuid (required)
 *   batch_number      — string (optional)
 *   quantity_received — number in STOCK UNITS (required, > 0)
 *   expiry_date       — ISO date string (optional)
 *   storage_location  — string (optional)
 */
export const receiveBatch = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id
  const userId   = req.user.id

  if (!labId) {
    return res.status(400).json({ error: 'Please select a laboratory before receiving stock' })
  }

  const { item_id, batch_number, quantity_received, expiry_date, storage_location } = req.body

  try {
    if (!item_id) return res.status(400).json({ error: 'item_id is required' })

    const qty = Number(quantity_received)
    if (Number.isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'quantity_received must be a positive number' })
    }

    // Validate item exists and belongs to this lab
    const { data: item, error: itemErr } = await supabase
      .from('items')
      .select('id, laboratory_id, unit_of_measure, dispensing_unit, conversion_factor')
      .eq('id', item_id)
      .single()

    if (itemErr || !item) return res.status(404).json({ error: 'Item not found' })

    if (item.laboratory_id !== labId) {
      return res.status(403).json({ error: 'You can only receive stock for items in your active laboratory' })
    }

    // Convert stock units to base / dispensing units
    const factor  = item.conversion_factor ? Number(item.conversion_factor) : 1
    const baseQty = parseFloat((qty * factor).toFixed(4))

    const insertPayload = {
      id:                uuidv4(),
      item_id,
      laboratory_id:     labId,
      batch_number:      normalizeNullableString(batch_number),
      quantity_received: baseQty,
      current_quantity:  baseQty,
      expiry_date:       expiry_date || null,
      storage_location:  normalizeNullableString(storage_location),
      received_at:       new Date(),
      created_by:        userId,
      created_at:        new Date(),
    }

    const { data: batch, error: batchErr } = await supabase
      .from('stock_batches')
      .insert(insertPayload)
      .select(BATCH_WITH_ITEM_SELECT)
      .single()

    if (batchErr) throw batchErr

    await writeAuditLog({
      userId,
      action:   'CREATE',
      entity:   'stock_batches',
      entityId: batch.id,
      newData:  insertPayload,
    })

    return res.status(201).json({
      ...batch,
      _conversion: {
        stock_units_received: qty,
        stock_unit:           item.unit_of_measure,
        base_qty_stored:      baseQty,
        base_unit:            item.dispensing_unit || item.unit_of_measure,
        factor,
      },
    })
  } catch (err) {
    console.error('[receiveBatch]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}


/**
 * PUT /api/batches/:id
 *
 * Corrects batch metadata (quantities, expiry date, storage location).
 * A reason field is required for every correction (audit trail).
 * Business rules enforced:
 *   - current_quantity cannot exceed quantity_received
 *   - quantity_received cannot be reduced below what has already been issued
 */
export const updateBatch = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const userId   = req.user.id
  const { id }   = req.params

  try {
    let existingQuery = supabase.from('stock_batches').select(BATCH_WITH_ITEM_SELECT).eq('id', id)
    if (labId) existingQuery = existingQuery.eq('laboratory_id', labId)

    const { data: existingBatch, error: existingError } = await existingQuery.single()
    if (existingError || !existingBatch) {
      return res.status(404).json({ error: 'Batch not found' })
    }

    const reason = normalizeNullableString(req.body.reason)
    if (!reason) {
      return res.status(400).json({ error: 'A correction reason is required when editing a batch' })
    }

    const hasQtyReceived = Object.prototype.hasOwnProperty.call(req.body, 'quantity_received')
    const hasCurrentQty  = Object.prototype.hasOwnProperty.call(req.body, 'current_quantity')
    const hasExpiry      = Object.prototype.hasOwnProperty.call(req.body, 'expiry_date')
    const hasLocation    = Object.prototype.hasOwnProperty.call(req.body, 'storage_location')

    const quantityReceived = hasQtyReceived
      ? Number(req.body.quantity_received)
      : Number(existingBatch.quantity_received)

    const currentQuantity = hasCurrentQty
      ? Number(req.body.current_quantity)
      : Number(existingBatch.current_quantity)

    if (Number.isNaN(quantityReceived) || quantityReceived < 0) {
      return res.status(400).json({ error: 'Received quantity must be a valid non-negative number' })
    }
    if (Number.isNaN(currentQuantity) || currentQuantity < 0) {
      return res.status(400).json({ error: 'Available quantity must be a valid non-negative number' })
    }
    if (currentQuantity > quantityReceived) {
      return res.status(400).json({ error: 'Available quantity cannot exceed received quantity' })
    }

    // Guard: cannot reduce quantity_received below already-issued amount
    if (hasQtyReceived) {
      const { data: trxRows, error: trxErr } = await supabase
        .from('stock_transactions')
        .select('quantity, transaction_type')
        .eq('batch_id', id)

      if (trxErr) throw trxErr

      const issuedQuantity = (trxRows || []).reduce((sum, row) => {
        if (row.transaction_type === 'ISSUE')   return sum + Number(row.quantity || 0)
        if (row.transaction_type === 'RECEIVE') return sum - Number(row.quantity || 0)
        return sum
      }, 0)

      if (quantityReceived < issuedQuantity) {
        return res.status(400).json({
          error: `Received quantity cannot be reduced below the amount already issued (${issuedQuantity})`,
        })
      }
    }

    const updates = cleanObject({
      quantity_received: hasQtyReceived ? quantityReceived : undefined,
      current_quantity:  hasCurrentQty  ? currentQuantity  : undefined,
      expiry_date:       hasExpiry      ? (req.body.expiry_date || null) : undefined,
      storage_location:  hasLocation    ? normalizeNullableString(req.body.storage_location) : undefined,
    })

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' })
    }

    let updateQuery = supabase.from('stock_batches').update(updates).eq('id', id)
    if (labId) updateQuery = updateQuery.eq('laboratory_id', labId)

    const { data: updatedRows, error: updateError } = await updateQuery.select(BATCH_WITH_ITEM_SELECT)
    if (updateError) throw updateError

    const updatedBatch = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows

    await writeAuditLog({
      userId,
      action:   'UPDATE',
      entity:   'stock_batches',
      entityId: id,
      oldData:  existingBatch,
      newData:  updates,
      reason,
    })

    return res.json(updatedBatch)
  } catch (err) {
    console.error('[updateBatch]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}


/**
 * DELETE /api/batches/:id
 *
 * Hard-deletes a batch only if it has no transaction history.
 * Batches with history are protected to preserve the audit trail.
 */
export const deleteBatch = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const userId   = req.user.id
  const { id }   = req.params

  try {
    let existingQuery = supabase.from('stock_batches').select(BATCH_WITH_ITEM_SELECT).eq('id', id)
    if (labId) existingQuery = existingQuery.eq('laboratory_id', labId)

    const { data: existingBatch, error: existingError } = await existingQuery.single()
    if (existingError || !existingBatch) {
      return res.status(404).json({ error: 'Batch not found' })
    }

    const { count, error: trxError } = await supabase
      .from('stock_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', id)

    if (trxError) throw trxError

    if ((count || 0) > 0) {
      return res.status(400).json({ error: 'Cannot delete a batch that has transaction history' })
    }

    let deleteQuery = supabase.from('stock_batches').delete().eq('id', id)
    if (labId) deleteQuery = deleteQuery.eq('laboratory_id', labId)

    const { error: deleteError } = await deleteQuery
    if (deleteError) throw deleteError

    await writeAuditLog({
      userId,
      action:   'DELETE',
      entity:   'stock_batches',
      entityId: id,
      oldData:  existingBatch,
    })

    return res.json({ message: 'Batch deleted successfully' })
  } catch (err) {
    console.error('[deleteBatch]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}
