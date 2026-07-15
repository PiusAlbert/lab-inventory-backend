import { getSupabase } from '../config/supabase.js'
import { v4 as uuidv4 } from 'uuid'
import { normalizeNullableString } from '../utils/helpers.js'

// ── POST /api/auth/register  (admin-created users) ───────────────────
/**
 * SUPER_ADMIN and LAB_MANAGER can create staff accounts.
 * Accounts are immediately active (no approval flow).
 * LAB_MANAGER may only add users to their own lab and may not assign
 * SUPER_ADMIN or LAB_MANAGER roles.
 */
export const registerUser = async (req, res) => {
  const supabase = getSupabase()

  const { email, password, full_name, role, laboratory_id } = req.body

  if (!email?.trim())     return res.status(400).json({ error: 'Email is required' })
  if (!password)          return res.status(400).json({ error: 'Password is required' })
  if (!full_name?.trim()) return res.status(400).json({ error: 'Full name is required' })
  if (!role)              return res.status(400).json({ error: 'Role is required' })
  if (!laboratory_id)     return res.status(400).json({ error: 'Laboratory is required' })

  const callerRole = req.user?.role
  const callerLab  = req.user?.profile_laboratory_id

  // Only SUPER_ADMIN can assign SUPER_ADMIN or LAB_MANAGER roles
  if (['SUPER_ADMIN', 'LAB_MANAGER'].includes(role) && callerRole !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only Super Admin can assign this role' })
  }

  // LAB_MANAGER can only register users for their own lab
  if (callerRole === 'LAB_MANAGER' && laboratory_id !== callerLab) {
    return res.status(403).json({ error: 'You can only add users to your own laboratory' })
  }

  try {
    // Verify lab exists and is active
    const { data: lab, error: labErr } = await supabase
      .from('laboratories')
      .select('id, name, is_active')
      .eq('id', laboratory_id)
      .single()

    if (labErr || !lab) return res.status(400).json({ error: 'Laboratory not found' })
    if (!lab.is_active)  return res.status(400).json({ error: 'Laboratory is not active' })

    // Create the Supabase auth user (auto-confirmed, no email needed)
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email:         email.trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: { full_name: full_name.trim() },
    })

    if (authErr) {
      if (authErr.message?.toLowerCase().includes('already')) {
        return res.status(409).json({ error: 'An account with this email already exists' })
      }
      return res.status(400).json({ error: authErr.message })
    }

    const userId = authData.user.id

    // Create app_users row — immediately active, no approval required
    const { error: profileErr } = await supabase.from('app_users').insert({
      id:                  userId,
      full_name:           full_name.trim(),
      role,
      laboratory_id,
      is_active:           true,
      registration_status: 'APPROVED',
    })

    if (profileErr) {
      await supabase.auth.admin.deleteUser(userId)
      throw profileErr
    }

    return res.status(201).json({
      message: `${full_name.trim()} has been registered to ${lab.name}.`,
      user: { id: userId, full_name: full_name.trim(), role, laboratory_id },
    })
  } catch (err) {
    console.error('[registerUser]', err)
    return res.status(500).json({ error: 'Registration failed. Please try again.' })
  }
}


// ── POST /api/auth/register/student  (public — no auth required) ──────
/**
 * Students self-register. The account is created with:
 *   is_active = false         → blocked from all API calls until approved
 *   registration_status = 'PENDING'
 *   laboratory_id = null      → assigned by lab manager on approval
 *   preferred_laboratory_id   → the lab they wish to join
 *
 * The lab manager sees them in /api/students/pending and approves or rejects.
 */
export const registerStudent = async (req, res) => {
  const supabase = getSupabase()

  const {
    email, password, full_name,
    student_number, department, course_name,
    course_level = 'UNDERGRADUATE', year_of_study,
    supervisor_name, preferred_laboratory_id,
  } = req.body

  if (!email?.trim())     return res.status(400).json({ error: 'Email is required' })
  if (!password)          return res.status(400).json({ error: 'Password is required' })
  if (!full_name?.trim()) return res.status(400).json({ error: 'Full name is required' })
  if (!preferred_laboratory_id) {
    return res.status(400).json({ error: 'Please select a laboratory to register with' })
  }

  try {
    // Verify the lab actually exists
    const { data: lab, error: labErr } = await supabase
      .from('laboratories')
      .select('id, name, is_active')
      .eq('id', preferred_laboratory_id)
      .single()

    if (labErr || !lab) return res.status(400).json({ error: 'Selected laboratory not found' })
    if (!lab.is_active)  return res.status(400).json({ error: 'Selected laboratory is not active' })

    // Create the Supabase auth user
    // (duplicate email is caught by auth.admin.createUser — it returns a 422 error)
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email:          email.trim().toLowerCase(),
      password,
      email_confirm:  true,           // auto-confirm email so login works immediately after approval
      user_metadata:  { full_name: full_name.trim() },
    })

    if (authErr) {
      if (authErr.message?.toLowerCase().includes('already')) {
        return res.status(409).json({ error: 'An account with this email already exists' })
      }
      return res.status(400).json({ error: authErr.message })
    }

    const userId = authData.user.id

    // Create app_users row — inactive until approved
    const { error: profileErr } = await supabase.from('app_users').insert({
      id:                      userId,
      full_name:               full_name.trim(),
      role:                    'STUDENT',
      laboratory_id:           null,                   // assigned on approval
      preferred_laboratory_id,
      is_active:               false,
      registration_status:     'PENDING',
    })

    if (profileErr) {
      // Roll back the auth user to avoid orphaned records
      await supabase.auth.admin.deleteUser(userId)
      throw profileErr
    }

    // Create student_profiles row
    await supabase.from('student_profiles').insert({
      user_id:        userId,
      student_number: normalizeNullableString(student_number),
      department:     normalizeNullableString(department),
      course_name:    normalizeNullableString(course_name),
      course_level,
      year_of_study:  year_of_study ? parseInt(year_of_study, 10) : null,
      supervisor_name: normalizeNullableString(supervisor_name),
    })

    return res.status(201).json({
      message: `Registration submitted. Your account is pending approval by the ${lab.name} lab manager.`,
      status: 'PENDING',
    })
  } catch (err) {
    console.error('[registerStudent]', err)
    return res.status(500).json({ error: 'Registration failed. Please try again.' })
  }
}
