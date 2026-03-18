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

// Add to stockTransactions.routes.js — filter transactions by item_id query param
router.get('/', getTransactions)
// becomes:
// GET /api/transactions?item_id=abc123 — backend filters before returning
router.post(
  '/receive',
  requireRole(['LAB_MANAGER','STORE_KEEPER']),
  receiveStock
)

export default router