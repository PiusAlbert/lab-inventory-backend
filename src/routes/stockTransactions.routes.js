import express from 'express'

import {
  getTransactions,
  issueStock,
  receiveStock
} from '../controllers/stockTransactions.controller.js'

import { verifyToken } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'

const router = express.Router()

router.use(verifyToken)

router.get('/', getTransactions)

router.post(
  '/issue',
  requireRole(['LAB_MANAGER','STORE_KEEPER','TECHNICIAN']),
  issueStock
)

router.post(
  '/receive',
  requireRole(['LAB_MANAGER','STORE_KEEPER']),
  receiveStock
)

export default router