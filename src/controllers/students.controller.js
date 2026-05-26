import { getSupabase } from '../config/supabase.js'
import { writeAuditLog } from '../utils/audit.js'

const MANAGER_ROLES = ['LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN']

const STUDENT_SELECT = `
  id, full_name, registration_status, is_active, created_at,
  preferred_laboratory_id,
  laboratories!app_users_preferred_laboratory_id_fkey ( id, name ),
  student_profiles ( student_number, department, course_name, course_level, year_of_study, supervisor_name )
`

// ── GET /api/students/pending ─────────────────────────────────────────
// Returns students awaiting approval for the caller's laboratory.
// SUPER_ADMIN sees all pending across all labs (or filtered by x-lab-id).
export const getPendingStudents = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null

  try {
    let query = supabase
      .from('app_users')
      .select(STUDENT_SELECT)
      .eq('role', 'STUDENT')
      .eq('registration_status', 'PENDING')
      .order('created_at', { ascending: true })

    // Scope to manager's lab — match on preferred_laboratory_id
    if (labId) query = query.eq('preferred_laboratory_id', labId)

    const { data, error } = await query
    if (error) throw error

    return res.json(data || [])
  } catch (err) {
    console.error('[getPendingStudents]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── GET /api/students ─────────────────────────────────────────────────
// Returns all students (approved) for the caller's lab.
export const getStudents = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null

  try {
    let query = supabase
      .from('app_users')
      .select(STUDENT_SELECT)
      .eq('role', 'STUDENT')
      .eq('registration_status', 'ACTIVE')
      .order('full_name', { ascending: true })

    if (labId) query = query.eq('laboratory_id', labId)

    const { data, error } = await query
    if (error) throw error

    return res.json(data || [])
  } catch (err) {
    console.error('[getStudents]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── POST /api/students/:id/approve ────────────────────────────────────
// Activates the student and assigns them to the approver's laboratory.
export const approveStudent = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const userId   = req.user.id
  const { id }   = req.params

  if (!labId) {
    return res.status(400).json({ error: 'Select a laboratory before approving students' })
  }

  try {
    const { data: student, error: fetchErr } = await supabase
      .from('app_users')
      .select('id, full_name, registration_status, role')
      .eq('id', id)
      .single()

    if (fetchErr || !student) return res.status(404).json({ error: 'Student not found' })
    if (student.role !== 'STUDENT') return res.status(400).json({ error: 'User is not a student' })
    if (student.registration_status !== 'PENDING') {
      return res.status(400).json({ error: `Student registration is already ${student.registration_status}` })
    }

    const { error: updateErr } = await supabase
      .from('app_users')
      .update({
        is_active:           true,
        registration_status: 'ACTIVE',
        laboratory_id:       labId,
      })
      .eq('id', id)

    if (updateErr) throw updateErr

    await writeAuditLog({
      userId,
      action:   'UPDATE',
      entity:   'app_users',
      entityId: id,
      oldData:  { registration_status: 'PENDING', is_active: false },
      newData:  { registration_status: 'ACTIVE',  is_active: true, laboratory_id: labId },
      reason:   'Student registration approved',
    })

    return res.json({ message: `${student.full_name} has been approved and assigned to this laboratory` })
  } catch (err) {
    console.error('[approveStudent]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── POST /api/students/:id/reject ─────────────────────────────────────
// Rejects a pending student registration.
export const rejectStudent = async (req, res) => {
  const supabase = getSupabase()
  const userId   = req.user.id
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const reason   = req.body?.reason?.trim() || 'No reason provided'

  try {
    const { data: student, error: fetchErr } = await supabase
      .from('app_users')
      .select('id, full_name, registration_status, role')
      .eq('id', id)
      .single()

    if (fetchErr || !student) return res.status(404).json({ error: 'Student not found' })
    if (student.role !== 'STUDENT') return res.status(400).json({ error: 'User is not a student' })
    if (student.registration_status !== 'PENDING') {
      return res.status(400).json({ error: `Student registration is already ${student.registration_status}` })
    }

    const { error: updateErr } = await supabase
      .from('app_users')
      .update({ registration_status: 'REJECTED', is_active: false })
      .eq('id', id)

    if (updateErr) throw updateErr

    await writeAuditLog({
      userId,
      action:   'UPDATE',
      entity:   'app_users',
      entityId: id,
      oldData:  { registration_status: 'PENDING' },
      newData:  { registration_status: 'REJECTED' },
      reason,
    })

    return res.json({ message: `${student.full_name}'s registration has been rejected` })
  } catch (err) {
    console.error('[rejectStudent]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}
