import express from 'express'
import { getSupabase } from '../config/supabase.js'
import { verifyToken } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'

const router = express.Router()

const MANAGERS = ['SUPER_ADMIN', 'LAB_MANAGER', 'STORE_KEEPER', 'TECHNICIAN', 'AUDITOR']
const ALL_ROLES = [...MANAGERS, 'STUDENT']

const BOOKING_SELECT = `
  id, title, purpose, requested_date, start_time, end_time,
  bench_location, participants_count, notes, status,
  review_note, reviewed_at, created_at,
  created_by,
  requester:app_users!experiment_bookings_created_by_fkey ( id, full_name, role ),
  reviewer:app_users!experiment_bookings_reviewed_by_fkey ( id, full_name )
`

/**
 * GET /api/bookings
 * Students see only their own. Managers see all bookings in their lab.
 * Optional ?status= filter.
 */
router.get('/', verifyToken, requireRole(ALL_ROLES), async (req, res) => {
  try {
    const supabase    = getSupabase()
    const isStudent   = req.user.role === 'STUDENT'
    const labId       = req.user.laboratory_id

    let query = supabase
      .from('experiment_bookings')
      .select(BOOKING_SELECT)
      .order('requested_date', { ascending: false })
      .order('start_time',     { ascending: false })

    if (isStudent) {
      query = query.eq('created_by', req.user.id)
    } else if (labId) {
      query = query.eq('laboratory_id', labId)
    }

    if (req.query.status) query = query.eq('status', req.query.status)

    const { data, error } = await query
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    console.error('GET /bookings', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/bookings/:id
 */
router.get('/:id', verifyToken, requireRole(ALL_ROLES), async (req, res) => {
  try {
    const supabase  = getSupabase()
    const isStudent = req.user.role === 'STUDENT'

    const { data, error } = await supabase
      .from('experiment_bookings')
      .select(BOOKING_SELECT)
      .eq('id', req.params.id)
      .single()

    if (error || !data) return res.status(404).json({ error: 'Booking not found' })

    // Students can only view their own bookings
    if (isStudent && data.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    res.json(data)
  } catch (err) {
    console.error('GET /bookings/:id', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/bookings
 * Students (and staff) request a lab slot.
 */
router.post('/', verifyToken, requireRole(ALL_ROLES), async (req, res) => {
  try {
    const supabase = getSupabase()
    const {
      title, purpose, requested_date, start_time, end_time,
      bench_location, participants_count, notes,
    } = req.body

    if (!title?.trim())      return res.status(400).json({ error: 'Title is required' })
    if (!requested_date)     return res.status(400).json({ error: 'Requested date is required' })
    if (!start_time)         return res.status(400).json({ error: 'Start time is required' })
    if (!end_time)           return res.status(400).json({ error: 'End time is required' })
    if (start_time >= end_time) return res.status(400).json({ error: 'End time must be after start time' })

    const labId = req.user.laboratory_id
    if (!labId) return res.status(400).json({ error: 'You must be assigned to a laboratory to make a booking' })

    const { data, error } = await supabase
      .from('experiment_bookings')
      .insert({
        laboratory_id:      labId,
        created_by:         req.user.id,
        title:              title.trim(),
        purpose:            purpose?.trim() || null,
        requested_date,
        start_time,
        end_time,
        bench_location:     bench_location?.trim() || null,
        participants_count: participants_count ? parseInt(participants_count, 10) : 1,
        notes:              notes?.trim() || null,
        status:             'PENDING',
      })
      .select(BOOKING_SELECT)
      .single()

    if (error) throw error
    res.status(201).json(data)
  } catch (err) {
    console.error('POST /bookings', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * PATCH /api/bookings/:id/approve
 * Manager approves a PENDING booking.
 */
router.patch('/:id/approve', verifyToken, requireRole(MANAGERS), async (req, res) => {
  try {
    const supabase = getSupabase()
    const { review_note } = req.body

    const { data: booking, error: fetchErr } = await supabase
      .from('experiment_bookings')
      .select('id, status, laboratory_id')
      .eq('id', req.params.id)
      .single()

    if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' })
    if (booking.status !== 'PENDING') return res.status(400).json({ error: 'Only PENDING bookings can be approved' })

    // Scope check — manager can only act on their own lab's bookings
    const managerLab = req.user.role === 'SUPER_ADMIN' ? req.user.laboratory_id : req.user.profile_laboratory_id
    if (managerLab && booking.laboratory_id !== managerLab) {
      return res.status(403).json({ error: 'You can only manage bookings in your own laboratory' })
    }

    const { data, error } = await supabase
      .from('experiment_bookings')
      .update({
        status:      'APPROVED',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        review_note: review_note?.trim() || null,
        updated_at:  new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select(BOOKING_SELECT)
      .single()

    if (error) throw error
    res.json(data)
  } catch (err) {
    console.error('PATCH /bookings/:id/approve', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * PATCH /api/bookings/:id/decline
 * Manager declines a PENDING booking.
 */
router.patch('/:id/decline', verifyToken, requireRole(MANAGERS), async (req, res) => {
  try {
    const supabase = getSupabase()
    const { review_note } = req.body

    const { data: booking, error: fetchErr } = await supabase
      .from('experiment_bookings')
      .select('id, status, laboratory_id')
      .eq('id', req.params.id)
      .single()

    if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' })
    if (booking.status !== 'PENDING') return res.status(400).json({ error: 'Only PENDING bookings can be declined' })

    const managerLab = req.user.role === 'SUPER_ADMIN' ? req.user.laboratory_id : req.user.profile_laboratory_id
    if (managerLab && booking.laboratory_id !== managerLab) {
      return res.status(403).json({ error: 'You can only manage bookings in your own laboratory' })
    }

    const { data, error } = await supabase
      .from('experiment_bookings')
      .update({
        status:      'DECLINED',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        review_note: review_note?.trim() || null,
        updated_at:  new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select(BOOKING_SELECT)
      .single()

    if (error) throw error
    res.json(data)
  } catch (err) {
    console.error('PATCH /bookings/:id/decline', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * PATCH /api/bookings/:id/cancel
 * Student cancels their own PENDING booking.
 */
router.patch('/:id/cancel', verifyToken, requireRole(ALL_ROLES), async (req, res) => {
  try {
    const supabase = getSupabase()

    const { data: booking, error: fetchErr } = await supabase
      .from('experiment_bookings')
      .select('id, status, created_by')
      .eq('id', req.params.id)
      .single()

    if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' })
    if (booking.created_by !== req.user.id && !MANAGERS.includes(req.user.role)) {
      return res.status(403).json({ error: 'You can only cancel your own bookings' })
    }
    if (!['PENDING', 'APPROVED'].includes(booking.status)) {
      return res.status(400).json({ error: 'This booking cannot be cancelled' })
    }

    const { data, error } = await supabase
      .from('experiment_bookings')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select(BOOKING_SELECT)
      .single()

    if (error) throw error
    res.json(data)
  } catch (err) {
    console.error('PATCH /bookings/:id/cancel', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
