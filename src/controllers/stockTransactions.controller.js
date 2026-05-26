import { getSupabase } from '../config/supabase.js'
import { writeAuditLog } from '../utils/audit.js'

/**
 * GET /api/transactions
 *
 * Paginated transaction list, scoped to the effective laboratory.
 * Default: page 1, 50 rows, newest first.
 */
export const getTransactions = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null

  const page  = Math.max(1, parseInt(req.query.page  || '1',  10))
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)))
  const offset = (page - 1) * limit

  try {
    let query = supabase
      .from('stock_transactions')
      .select(`
        id,
        transaction_type,
        quantity,
        reference,
        notes,
        created_at,
        items        ( id, name, sku, unit_of_measure ),
        stock_batches( batch_number )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (labId) query = query.eq('laboratory_id', labId)

    const { data, error, count } = await query
    if (error) throw error

    res.json({
      data,
      pagination: {
        total: count,
        page,
        limit,
        pages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (err) {
    console.error('[getTransactions]', err)
    res.status(500).json({ error: 'An internal error occurred' })
  }
}


/**
 * POST /api/transactions/issue
 *
 * Issues stock for an item using FIFO batch selection.
 * Delegates to the issue_stock() Postgres function which is atomic:
 * the batch UPDATE and the transaction INSERT happen in one DB
 * transaction, preventing concurrent overdraft.
 *
 * Body: { item_id, quantity, reference?, notes? }
 */
export const issueStock = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id
  const userId   = req.user.id

  if (!labId) {
    return res.status(400).json({ error: 'Please select a laboratory before issuing stock' })
  }

  const { item_id, quantity, reference, notes } = req.body

  if (!item_id) return res.status(400).json({ error: 'item_id is required' })

  const qty = Number(quantity)
  if (!qty || qty <= 0 || Number.isNaN(qty)) {
    return res.status(400).json({ error: 'quantity must be a positive number' })
  }

  const { data, error } = await getSupabase().rpc('issue_stock', {
    p_item_id:   item_id,
    p_lab_id:    labId,
    p_quantity:  qty,
    p_user_id:   userId,
    p_reference: reference || null,
    p_notes:     notes     || null,
  })

  if (error) {
    const msg = error.message || ''
    if (
      msg.includes('Insufficient stock') ||
      msg.includes('Quantity must be positive') ||
      msg.includes('temporarily locked')
    ) {
      return res.status(400).json({ error: msg })
    }
    console.error('[issueStock] RPC error:', error)
    return res.status(500).json({ error: 'An internal error occurred' })
  }

  // Audit the issue event at the item level
  await writeAuditLog({
    userId,
    action:   'ISSUE',
    entity:   'stock_transactions',
    entityId: item_id,
    newData:  { item_id, laboratory_id: labId, quantity: qty, reference, notes },
  })

  res.status(201).json({ message: 'Stock issued successfully', ...data })
}


/**
 * POST /api/transactions/receive
 *
 * Returns stock to an existing batch (e.g. partial return from a user).
 * This is distinct from POST /api/batches which creates a NEW batch.
 * Delegates to the receive_stock() Postgres function for atomicity.
 *
 * Body: { batch_id, quantity, reference?, notes? }
 */
export const receiveStock = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id
  const userId   = req.user.id

  if (!labId) {
    return res.status(400).json({ error: 'Please select a laboratory before receiving stock' })
  }

  const { batch_id, quantity, reference, notes } = req.body

  if (!batch_id) return res.status(400).json({ error: 'batch_id is required' })

  const qty = Number(quantity)
  if (!qty || qty <= 0 || Number.isNaN(qty)) {
    return res.status(400).json({ error: 'quantity must be a positive number' })
  }

  const { data, error } = await getSupabase().rpc('receive_stock', {
    p_batch_id:  batch_id,
    p_lab_id:    labId,
    p_quantity:  qty,
    p_user_id:   userId,
    p_reference: reference || null,
    p_notes:     notes     || null,
  })

  if (error) {
    const msg = error.message || ''
    if (
      msg.includes('Batch not found') ||
      msg.includes('Quantity must be positive')
    ) {
      return res.status(400).json({ error: msg })
    }
    console.error('[receiveStock] RPC error:', error)
    return res.status(500).json({ error: 'An internal error occurred' })
  }

  await writeAuditLog({
    userId,
    action:   'RECEIVE',
    entity:   'stock_transactions',
    entityId: batch_id,
    newData:  { batch_id, laboratory_id: labId, quantity: qty, reference, notes },
  })

  res.status(201).json({ message: 'Stock received successfully', ...data })
}
