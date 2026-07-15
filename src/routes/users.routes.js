import express from 'express'
import { getSupabase } from '../config/supabase.js'
import { verifyToken } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'
import { invalidateProfileCache } from '../middleware/auth.middleware.js'

const router = express.Router()
const ALLOWED = ['SUPER_ADMIN', 'LAB_MANAGER']

/**
 * GET /api/users
 * List staff accounts.
 *   SUPER_ADMIN with x-lab-id → that lab's users
 *   SUPER_ADMIN with no header → all users across all labs
 *   LAB_MANAGER                → their own lab only
 */
router.get('/', verifyToken, requireRole(ALLOWED), async (req, res) => {
  try {
    const supabase = getSupabase()
    const isSuperAdmin = req.user.role === 'SUPER_ADMIN'

    let query = supabase
      .from('app_users')
      .select(`
        id, full_name, role, is_active, registration_status, created_at,
        laboratory_id,
        laboratories ( id, name )
      `)
      .neq('role', 'STUDENT')    // students have their own management page
      .order('full_name')

    // Scope to lab
    const labId = isSuperAdmin ? req.user.laboratory_id : req.user.profile_laboratory_id
    if (labId) query = query.eq('laboratory_id', labId)

    const { data, error } = await query
    if (error) throw error

    res.json(data || [])
  } catch (err) {
    console.error('Get users error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * PATCH /api/users/:id/toggle
 * Activate or deactivate a user account.
 * LAB_MANAGER may only toggle users in their own lab.
 */
router.patch('/:id/toggle', verifyToken, requireRole(ALLOWED), async (req, res) => {
  try {
    const supabase = getSupabase()
    const { id }   = req.params

    const { data: user, error: fetchErr } = await supabase
      .from('app_users')
      .select('id, is_active, laboratory_id, role')
      .eq('id', id)
      .single()

    if (fetchErr || !user) return res.status(404).json({ error: 'User not found' })

    // LAB_MANAGER can only act on their own lab
    if (req.user.role === 'LAB_MANAGER' && user.laboratory_id !== req.user.profile_laboratory_id) {
      return res.status(403).json({ error: 'You can only manage users in your own laboratory' })
    }

    // Nobody can deactivate a SUPER_ADMIN through this endpoint
    if (user.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }

    const { data: updated, error: updateErr } = await supabase
      .from('app_users')
      .update({ is_active: !user.is_active })
      .eq('id', id)
      .select('id, full_name, role, is_active, laboratory_id, registration_status, created_at, laboratories(id, name)')
      .single()

    if (updateErr) throw updateErr

    invalidateProfileCache(id)
    res.json(updated)
  } catch (err) {
    console.error('Toggle user error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
