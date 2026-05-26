import { getSupabase } from '../config/supabase.js'
import { v4 as uuidv4 } from 'uuid'

/**
 * Writes a record to audit_logs.  Never throws — a logging failure
 * should not abort the operation that triggered it.
 *
 * @param {object} opts
 * @param {string}  opts.userId    - UUID of the acting user
 * @param {string}  opts.action    - CREATE | UPDATE | DELETE | ISSUE | RECEIVE | ADJUSTMENT
 * @param {string}  opts.entity    - Table name (e.g. "items", "stock_batches")
 * @param {string}  opts.entityId  - UUID of the affected record
 * @param {object}  [opts.oldData] - Previous state
 * @param {object}  [opts.newData] - New state
 * @param {string}  [opts.reason]  - Required for batch corrections
 */
export async function writeAuditLog({
  userId,
  action,
  entity,
  entityId,
  oldData = null,
  newData = null,
  reason  = null,
}) {
  const supabase = getSupabase()
  const details  = { old_data: oldData, new_data: newData }
  if (reason) details.reason = reason

  const { error } = await supabase.from('audit_logs').insert({
    id:             uuidv4(),
    user_id:        userId,
    action,
    table_affected: entity,
    record_id:      entityId,
    created_at:     new Date(),
    details,
  })

  if (error) {
    console.error('[audit] write failed:', error.message, { action, entity, entityId })
  }
}
