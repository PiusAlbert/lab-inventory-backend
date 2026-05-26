import { getSupabase } from '../config/supabase.js'
import { v4 as uuidv4 } from 'uuid'
import { writeAuditLog } from '../utils/audit.js'
import { normalizeNullableString } from '../utils/helpers.js'

/**
 * Convert a time-only string ("HH:MM" or "HH:MM:SS") into a full
 * TIMESTAMPTZ by combining it with the session date.
 * If the value is already a full ISO string, or is null/empty, it is
 * returned unchanged so we never break data that is already correct.
 */
function resolveTimestamp(dateStr, timeOrIso) {
  if (!timeOrIso) return null
  // Already a full ISO string (contains 'T' or a date separator)
  if (timeOrIso.includes('T') || timeOrIso.length > 10) return timeOrIso
  // Time-only — combine with session date
  if (dateStr) return `${dateStr}T${timeOrIso}:00`
  return null
}

const ALLOWED_TRANSITIONS = {
  DRAFT:       ['IN_PROGRESS', 'SUBMITTED'],   // allow skipping IN_PROGRESS
  IN_PROGRESS: ['SUBMITTED'],
  SUBMITTED:   ['APPROVED', 'REJECTED'],
  REJECTED:    ['IN_PROGRESS', 'SUBMITTED'],   // allow re-submitting from rejected
  APPROVED:    [],
}

const MANAGER_ROLES = ['LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN']

// Full experiment select — all sections in one query via joins
const FULL_SELECT = `
  *,
  app_users!experiments_instructor_id_fkey ( id, full_name ),
  experiment_participants ( id, role, added_at, app_users ( id, full_name ) ),
  experiment_materials ( *, items ( id, name, sku, unit_of_measure ), stock_batches ( id, batch_number, expiry_date ) ),
  experiment_equipment ( *, items ( id, name, sku ) ),
  experiment_safety ( * ),
  experiment_procedure_steps ( * ),
  experiment_controls ( * ),
  experiment_observations ( *, experiment_attachments ( * ) ),
  experiment_results ( * ),
  experiment_conclusions ( * ),
  experiment_waste_records ( * ),
  experiment_ethical_approvals ( * ),
  experiment_signatures ( *, app_users ( id, full_name ) )
`

// ── GET /api/experiments ─────────────────────────────────────────────
export const getExperiments = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null

  const { status, course, from, to, page = 1, limit = 20 } = req.query
  const pageNum  = Math.max(1, parseInt(page, 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
  const offset   = (pageNum - 1) * pageSize

  try {
    let query = supabase
      .from('experiments')
      .select(`
        id, title, course_module, session_date, status, created_at, updated_at,
        app_users!experiments_instructor_id_fkey ( full_name ),
        experiment_participants ( id )
      `, { count: 'exact' })
      .order('session_date', { ascending: false })
      .range(offset, offset + pageSize - 1)

    if (labId)   query = query.eq('laboratory_id', labId)
    // Students only see experiments they created or participated in
    if (req.user.role === 'STUDENT') query = query.eq('created_by', req.user.id)
    if (status)  query = query.eq('status', status.toUpperCase())
    if (course)  query = query.ilike('course_module', `%${course}%`)
    if (from)    query = query.gte('session_date', from)
    if (to)      query = query.lte('session_date', to)

    const { data, error, count } = await query
    if (error) throw error

    return res.json({
      data: data || [],
      pagination: {
        page: pageNum,
        limit: pageSize,
        total: count ?? 0,
        pages: Math.ceil((count ?? 0) / pageSize),
      },
    })
  } catch (err) {
    console.error('[getExperiments]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── GET /api/experiments/:id ─────────────────────────────────────────
export const getExperimentById = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params

  try {
    let query = supabase.from('experiments').select(FULL_SELECT).eq('id', id)
    if (labId) query = query.eq('laboratory_id', labId)
    // Students can only view experiments they created
    if (req.user.role === 'STUDENT') query = query.eq('created_by', req.user.id)

    const { data, error } = await query.single()
    if (error || !data) return res.status(404).json({ error: 'Experiment not found' })

    // Sort steps by step_number
    if (data.experiment_procedure_steps) {
      data.experiment_procedure_steps.sort((a, b) => a.step_number - b.step_number)
    }

    return res.json(data)
  } catch (err) {
    console.error('[getExperimentById]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── POST /api/experiments ────────────────────────────────────────────
export const createExperiment = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id
  const userId   = req.user.id

  if (!labId) {
    return res.status(400).json({ error: 'Please select a laboratory before creating an experiment' })
  }

  const { title, objective, course_module, instructor_id, session_date, session_start, session_end, protocol_reference } = req.body

  if (!title?.trim()) return res.status(400).json({ error: 'title is required' })
  if (!session_date)  return res.status(400).json({ error: 'session_date is required' })

  try {
    const id = uuidv4()
    const payload = {
      id,
      laboratory_id:      labId,
      title:              title.trim(),
      objective:          normalizeNullableString(objective),
      course_module:      normalizeNullableString(course_module),
      instructor_id:      instructor_id || null,
      session_date,
      session_start:      resolveTimestamp(session_date, session_start),
      session_end:        resolveTimestamp(session_date, session_end),
      protocol_reference: normalizeNullableString(protocol_reference),
      status:             'DRAFT',
      created_by:         userId,
      created_at:         new Date(),
      updated_at:         new Date(),
    }

    const { data, error } = await supabase
      .from('experiments')
      .insert(payload)
      .select('id, title, status, session_date, created_at')
      .single()

    if (error) throw error

    // Auto-add creator as LEAD participant
    await supabase.from('experiment_participants').insert({
      id: uuidv4(), experiment_id: id, user_id: userId, role: 'LEAD',
    })

    await writeAuditLog({ userId, action: 'CREATE', entity: 'experiments', entityId: id, newData: payload })

    return res.status(201).json(data)
  } catch (err) {
    console.error('[createExperiment]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── PUT /api/experiments/:id ─────────────────────────────────────────
export const updateExperiment = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const userId   = req.user.id
  const { id }   = req.params

  try {
    let existingQ = supabase.from('experiments').select('*').eq('id', id)
    if (labId) existingQ = existingQ.eq('laboratory_id', labId)
    const { data: existing, error: existErr } = await existingQ.single()
    if (existErr || !existing) return res.status(404).json({ error: 'Experiment not found' })

    if (['APPROVED'].includes(existing.status)) {
      return res.status(400).json({ error: 'Approved experiments cannot be edited' })
    }

    const { title, objective, course_module, instructor_id, session_date, session_start, session_end, protocol_reference } = req.body

    const updates = {}
    if (title              !== undefined) updates.title              = title.trim()
    if (objective          !== undefined) updates.objective          = normalizeNullableString(objective)
    if (course_module      !== undefined) updates.course_module      = normalizeNullableString(course_module)
    if (instructor_id      !== undefined) updates.instructor_id      = instructor_id || null
    if (session_date       !== undefined) updates.session_date  = session_date
    // Use the incoming date if provided, otherwise fall back to what is already stored
    const effectiveDate = session_date ?? existing.session_date
    if (session_start !== undefined) updates.session_start = resolveTimestamp(effectiveDate, session_start)
    if (session_end   !== undefined) updates.session_end   = resolveTimestamp(effectiveDate, session_end)
    if (protocol_reference !== undefined) updates.protocol_reference = normalizeNullableString(protocol_reference)

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' })
    }

    let updateQ = supabase.from('experiments').update(updates).eq('id', id)
    if (labId) updateQ = updateQ.eq('laboratory_id', labId)

    const { data, error } = await updateQ.select('id, title, status, session_date, updated_at').single()
    if (error) throw error

    await writeAuditLog({ userId, action: 'UPDATE', entity: 'experiments', entityId: id, oldData: existing, newData: updates })

    return res.json(data)
  } catch (err) {
    console.error('[updateExperiment]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── Shared status transition helper ──────────────────────────────────
async function transitionStatus(req, res, targetStatus) {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const userId   = req.user.id
  const { id }   = req.params

  let existingQ = supabase.from('experiments').select('id, status, created_by, laboratory_id').eq('id', id)
  if (labId) existingQ = existingQ.eq('laboratory_id', labId)
  const { data: existing, error: existErr } = await existingQ.single()
  if (existErr || !existing) return res.status(404).json({ error: 'Experiment not found' })

  const allowed = ALLOWED_TRANSITIONS[existing.status] || []
  if (!allowed.includes(targetStatus)) {
    return res.status(400).json({
      error: `Cannot move from ${existing.status} to ${targetStatus}`,
    })
  }

  // Manager-only transitions
  if (['APPROVED', 'REJECTED'].includes(targetStatus) && !MANAGER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only Lab Managers can approve or reject experiments' })
  }

  const updates = { status: targetStatus }
  if (targetStatus === 'REJECTED') {
    updates.rejection_comment = normalizeNullableString(req.body?.comment) || 'No reason provided'
  }
  if (targetStatus === 'APPROVED') updates.rejection_comment = null

  let updateQ = supabase.from('experiments').update(updates).eq('id', id)
  if (labId) updateQ = updateQ.eq('laboratory_id', labId)
  const { data, error } = await updateQ.select('id, status, updated_at').single()
  if (error) throw error

  // Record signature for approve/reject
  if (['APPROVED', 'REJECTED'].includes(targetStatus)) {
    await supabase.from('experiment_signatures').upsert({
      id:           uuidv4(),
      experiment_id: id,
      signer_id:    userId,
      signer_role:  req.user.role,
      signed_at:    new Date(),
      status:       targetStatus === 'APPROVED' ? 'SIGNED' : 'REJECTED',
      comment:      normalizeNullableString(req.body?.comment),
    }, { onConflict: 'experiment_id,signer_id' })
  }

  await writeAuditLog({
    userId, action: 'UPDATE', entity: 'experiments', entityId: id,
    oldData: { status: existing.status }, newData: updates,
  })

  return res.json(data)
}

export const submitExperiment  = (req, res) => transitionStatus(req, res, 'SUBMITTED').catch(err => {
  console.error('[submitExperiment]', err); res.status(500).json({ error: 'An internal error occurred' })
})
export const approveExperiment = (req, res) => transitionStatus(req, res, 'APPROVED').catch(err => {
  console.error('[approveExperiment]', err); res.status(500).json({ error: 'An internal error occurred' })
})
export const rejectExperiment  = (req, res) => transitionStatus(req, res, 'REJECTED').catch(err => {
  console.error('[rejectExperiment]', err); res.status(500).json({ error: 'An internal error occurred' })
})

// ── DELETE /api/experiments/:id ──────────────────────────────────────
export const deleteExperiment = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const userId   = req.user.id
  const { id }   = req.params

  try {
    let existingQ = supabase.from('experiments').select('id, status, created_by').eq('id', id)
    if (labId) existingQ = existingQ.eq('laboratory_id', labId)
    const { data: existing, error: existErr } = await existingQ.single()
    if (existErr || !existing) return res.status(404).json({ error: 'Experiment not found' })

    if (!['DRAFT', 'REJECTED'].includes(existing.status)) {
      return res.status(400).json({ error: 'Only DRAFT or REJECTED experiments can be deleted' })
    }

    // Non-managers can only delete their own
    if (!MANAGER_ROLES.includes(req.user.role) && existing.created_by !== userId) {
      return res.status(403).json({ error: 'You can only delete your own experiments' })
    }

    let deleteQ = supabase.from('experiments').delete().eq('id', id)
    if (labId) deleteQ = deleteQ.eq('laboratory_id', labId)
    const { error } = await deleteQ
    if (error) throw error

    await writeAuditLog({ userId, action: 'DELETE', entity: 'experiments', entityId: id, oldData: existing })
    return res.json({ message: 'Experiment deleted successfully' })
  } catch (err) {
    console.error('[deleteExperiment]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}
