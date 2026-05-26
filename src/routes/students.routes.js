import express from 'express'
import { verifyToken } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'
import {
  getPendingStudents,
  getStudents,
  approveStudent,
  rejectStudent,
} from '../controllers/students.controller.js'

const router = express.Router()
const MANAGE_ROLES = ['LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN']

router.use(verifyToken)

router.get('/',                         requireRole(MANAGE_ROLES), getStudents)
router.get('/pending',                  requireRole(MANAGE_ROLES), getPendingStudents)
router.post('/:id/approve',             requireRole(MANAGE_ROLES), approveStudent)
router.post('/:id/reject',              requireRole(MANAGE_ROLES), rejectStudent)

export default router
