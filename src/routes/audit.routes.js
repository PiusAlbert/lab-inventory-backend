import express from 'express'
import { getSupabase } from '../config/supabase.js'
import { verifyToken } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'

const router = express.Router()
router.use(verifyToken, requireRole(['LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN']))

router.get('/', async (req, res) => {
  try {
    const supabase = getSupabase()
    const { role, laboratory_id: labId } = req.user
    const page   = Math.max(1, parseInt(req.query.page  || '1', 10))
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)))
    const offset = (page - 1) * limit
    const action = req.query.action || ''
    const entity = req.query.entity || ''

    // LAB_MANAGER: scope log to users who belong to their laboratory
    let userIds = null
    if (role === 'LAB_MANAGER' && labId) {
      const { data: labUsers } = await supabase
        .from('app_users')
        .select('id')
        .eq('laboratory_id', labId)
      userIds = (labUsers || []).map(u => u.id)
      if (userIds.length === 0) {
        return res.json({ data: [], pagination: { total: 0, page, limit, pages: 0 } })
      }
    }

    let query = supabase
      .from('audit_logs')
      .select('id, user_id, action, table_affected, record_id, created_at, details', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (action)   query = query.eq('action',          action)
    if (entity)   query = query.eq('table_affected',  entity)
    if (userIds)  query = query.in('user_id',         userIds)

    const { data: logs, error, count } = await query
    if (error) throw error

    // Resolve performer names in a second query to avoid FK ambiguity
    const ids = [...new Set((logs || []).map(l => l.user_id).filter(Boolean))]
    let userMap = {}
    if (ids.length > 0) {
      const { data: users } = await supabase
        .from('app_users')
        .select('id, full_name, role')
        .in('id', ids)
      ;(users || []).forEach(u => { userMap[u.id] = u })
    }

    const data = (logs || []).map(l => ({
      ...l,
      performer: userMap[l.user_id] || null,
    }))

    res.json({
      data,
      pagination: { total: count ?? 0, page, limit, pages: Math.ceil((count ?? 0) / limit) },
    })
  } catch (err) {
    console.error('[audit GET]', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
