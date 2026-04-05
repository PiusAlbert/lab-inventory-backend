import express from 'express';
import { verifyToken } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/role.middleware.js';
import {
  getBatches,
  getBatchesByItem,
  receiveBatch,
  updateBatch,
  deleteBatch,
} from '../controllers/stockBatches.controller.js';

const router = express.Router();

// Apply auth to every batches route
router.use(verifyToken);

router.get('/',                getBatches);
router.get('/item/:itemId',    getBatchesByItem);

router.post(
  '/',
  requireRole(['LAB_MANAGER', 'STORE_KEEPER', 'SUPER_ADMIN', 'ADMIN']),
  receiveBatch
);

router.put(
  '/:id',
  requireRole(['LAB_MANAGER', 'STORE_KEEPER', 'SUPER_ADMIN', 'ADMIN']),
  updateBatch
);

router.delete(
  '/:id',
  requireRole(['LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN']),
  deleteBatch
);

export default router;