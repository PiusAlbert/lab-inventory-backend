import express from 'express'
import { registerUser, registerStudent } from '../controllers/auth.controller.js'
import { verifyToken } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'

const router = express.Router()

// Admin-created staff accounts — must be authenticated as SUPER_ADMIN or LAB_MANAGER
router.post('/register', verifyToken, requireRole(['SUPER_ADMIN', 'LAB_MANAGER']), registerUser)

// Student self-registration — intentionally public, no verifyToken
router.post('/register/student', registerStudent)

export default router
