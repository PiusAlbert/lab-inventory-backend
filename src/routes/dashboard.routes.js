import express from 'express'
import { dashboard } from '../controllers/dashboard.controller.js'
import { verifyToken } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/', verifyToken, dashboard)

export default router