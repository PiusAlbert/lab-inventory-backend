import express from 'express'
import { registerUser, registerStudent } from '../controllers/auth.controller.js'

const router = express.Router()

// Admin-created users (existing — requires caller to be authenticated at app level)
router.post('/register', registerUser)

// Student self-registration — intentionally public, no verifyToken
router.post('/register/student', registerStudent)

export default router
