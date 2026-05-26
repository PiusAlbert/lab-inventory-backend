import { getSupabase } from '../config/supabase.js'
import { v4 as uuidv4 } from 'uuid'
import { normalizeNullableString } from '../utils/helpers.js'

// ── POST /api/auth/register  (admin-created users — existing route) ───
export const registerUser = async (req, res) => {
  const supabase = getSupabase()
  try {
    const { email, password, laboratory_id, role } = req.body

    if (!email || !password || !laboratory_id || !role) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { laboratory_id, role } },
    })

    if (error) return res.status(400).json({ error: error.message })

    return res.status(201).json({
      message: 'User registered successfully',
      user: data?.user ?? null,
    })
  } catch (err) {
    console.error('[registerUser]', err)
    return res.status(500).json({ error: 'Registration failed' })
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
