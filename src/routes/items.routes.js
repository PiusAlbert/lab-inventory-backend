import express from 'express'
import {
  getItems,
  getItemById,
  createItem,
  updateItem,
  deleteItem
} from '../controllers/items.controller.js'

import { verifyToken } from '../middleware/auth.middleware.js'
import { requireRole } from '../middleware/role.middleware.js'
import { searchItems } from '../controllers/items.controller.js'

const router = express.Router()

/* =========================================================
   GLOBAL MIDDLEWARE
   All routes require authentication
========================================================= */

router.use(verifyToken)

/* =========================================================
   ROUTES
========================================================= */

/**
 * GET /api/items
 * Accessible to all authenticated lab users
 */
router.get(
  '/',
  getItems
)

/**
 * GET /api/items/:id
 */
router.get(
  '/:id',
  getItemById
)

/**
 * POST /api/items
 * Only LAB_MANAGER and SUPER_ADMIN can create
 */
router.post(
  '/',
  requireRole(['LAB_MANAGER', 'SUPER_ADMIN']),
  createItem
)

/**
 * PUT /api/items/:id
 * Only LAB_MANAGER and SUPER_ADMIN can update
 */
router.put(
  '/:id',
  requireRole(['LAB_MANAGER', 'SUPER_ADMIN']),
  updateItem
)

/**
 * DELETE /api/items/:id
 * Only LAB_MANAGER and SUPER_ADMIN can deactivate
 */
router.delete(
  '/:id',
  requireRole(['LAB_MANAGER', 'SUPER_ADMIN']),
  deleteItem
)

router.get('/search', searchItems)

export default router