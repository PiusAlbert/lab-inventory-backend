import express from 'express'
import {
  getBatches,
  getItemBatches,
  createBatch
} from '../controllers/stockBatches.controller.js'

import { verifyToken } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'

const router = express.Router()

router.use(verifyToken)

router.get('/', getBatches)

router.get('/item/:id', getItemBatches)

router.post(
  '/',
  requireRole(['LAB_MANAGER', 'STORE_KEEPER']),
  createBatch
)

export default router