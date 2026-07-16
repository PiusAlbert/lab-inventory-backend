import express from 'express'
import { getSupabase }  from '../config/supabase.js'
import { verifyToken }  from '../middleware/auth.middleware.js'

const router = express.Router()
router.use(verifyToken)

const MANAGER_ROLES = ['LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN']
const STOCK_ROLES   = ['LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN', 'STORE_KEEPER']
const REVIEW_ROLES  = ['LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN', 'TECHNICIAN']

/**
 * GET /api/notifications
 * Returns per-category counts for alert badges.
 * Only includes categories relevant to the caller's role.
 */
router.get('/', async (req, res) => {
  try {
    const supabase = getSupabase()
    const { role, laboratory_id: labId } = req.user
    const result = {}
    const tasks  = []

    const count = async (query) => {
      const { count: n, error } = await query
      if (error) throw error
      return n ?? 0
    }

    if (MANAGER_ROLES.includes(role)) {
      tasks.push(
        count(
          (() => {
            let q = supabase
              .from('app_users')
              .select('id', { count: 'exact', head: true })
              .eq('role', 'STUDENT')
              .eq('registration_status', 'PENDING')
            if (labId) q = q.eq('laboratory_id', labId)
            return q
          })()
        ).then(n => { result.pending_students = n })
      )

      tasks.push(
        count(
          (() => {
            let q = supabase
              .from('experiment_bookings')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'PENDING')
            if (labId) q = q.eq('laboratory_id', labId)
            return q
          })()
        ).then(n => { result.pending_bookings = n })
      )
    }

    if (STOCK_ROLES.includes(role)) {
      // Low stock — reuse the RPC that the dashboard already uses
      tasks.push(
        supabase
          .rpc('get_low_stock_items', { p_lab_id: labId ?? null, p_limit: 500 })
          .then(({ data }) => { result.low_stock = (data || []).length })
      )

      // Expiring within 7 days (stricter threshold than dashboard's 30-day window)
      const today = new Date().toISOString().split('T')[0]
      const in7   = new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0]
      tasks.push(
        count(
          (() => {
            let q = supabase
              .from('stock_batches')
              .select('id', { count: 'exact', head: true })
              .not('expiry_date', 'is', null)
              .gte('expiry_date', today)
              .lte('expiry_date', in7)
              .gt('current_quantity', 0)
            if (labId) q = q.eq('laboratory_id', labId)
            return q
          })()
        ).then(n => { result.expiring_soon = n })
      )
    }

    if (REVIEW_ROLES.includes(role)) {
      tasks.push(
        count(
          (() => {
            let q = supabase
              .from('experiments')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'SUBMITTED')
            if (labId) q = q.eq('laboratory_id', labId)
            return q
          })()
        ).then(n => { result.pending_reports = n })
      )
    }

    await Promise.all(tasks)
    res.json(result)
  } catch (err) {
    console.error('[notifications]', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
