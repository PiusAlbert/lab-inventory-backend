import express from 'express'
import { verifyToken }  from '../middleware/auth.middleware.js'
import { requireRole }  from '../middleware/role.middleware.js'
import {
  getExperiments, getExperimentById,
  createExperiment, updateExperiment, deleteExperiment,
  submitExperiment, approveExperiment, rejectExperiment,
} from '../controllers/experiments.controller.js'
import {
  addParticipant, removeParticipant,
  addMaterial, updateMaterial, deleteMaterial,
  addEquipment, updateEquipment, deleteEquipment,
  upsertSafety,
  addStep, updateStep, deleteStep,
  addControl, updateControl, deleteControl,
  addObservation, updateObservation, deleteObservation,
  addResult, updateResult, deleteResult,
  upsertConclusions,
  addWasteRecord, deleteWasteRecord,
  addEthicalApproval, deleteEthicalApproval,
} from '../controllers/experimentSections.controller.js'

const router = express.Router()
const WRITE_ROLES  = ['STUDENT', 'TECHNICIAN', 'STORE_KEEPER', 'LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN']
const MANAGE_ROLES = ['LAB_MANAGER', 'SUPER_ADMIN', 'ADMIN']

router.use(verifyToken)

// ── Core ─────────────────────────────────────────────────────────────
router.get('/',    getExperiments)
router.get('/:id', getExperimentById)
router.post('/',   requireRole(WRITE_ROLES), createExperiment)
router.put('/:id', requireRole(WRITE_ROLES), updateExperiment)
router.delete('/:id', requireRole(WRITE_ROLES), deleteExperiment)

// ── Workflow ──────────────────────────────────────────────────────────
router.post('/:id/submit',  requireRole(WRITE_ROLES),  submitExperiment)
router.post('/:id/approve', requireRole(MANAGE_ROLES), approveExperiment)
router.post('/:id/reject',  requireRole(MANAGE_ROLES), rejectExperiment)

// ── Participants ──────────────────────────────────────────────────────
router.post('/:id/participants',      requireRole(WRITE_ROLES), addParticipant)
router.delete('/:id/participants/:pid', requireRole(WRITE_ROLES), removeParticipant)

// ── Materials ─────────────────────────────────────────────────────────
router.post('/:id/materials',         requireRole(WRITE_ROLES), addMaterial)
router.put('/:id/materials/:mid',     requireRole(WRITE_ROLES), updateMaterial)
router.delete('/:id/materials/:mid',  requireRole(WRITE_ROLES), deleteMaterial)

// ── Equipment ─────────────────────────────────────────────────────────
router.post('/:id/equipment',         requireRole(WRITE_ROLES), addEquipment)
router.put('/:id/equipment/:eid',     requireRole(WRITE_ROLES), updateEquipment)
router.delete('/:id/equipment/:eid',  requireRole(WRITE_ROLES), deleteEquipment)

// ── Safety ────────────────────────────────────────────────────────────
router.put('/:id/safety', requireRole(WRITE_ROLES), upsertSafety)

// ── Procedure steps ───────────────────────────────────────────────────
router.post('/:id/steps',         requireRole(WRITE_ROLES), addStep)
router.put('/:id/steps/:sid',     requireRole(WRITE_ROLES), updateStep)
router.delete('/:id/steps/:sid',  requireRole(WRITE_ROLES), deleteStep)

// ── Controls ──────────────────────────────────────────────────────────
router.post('/:id/controls',        requireRole(WRITE_ROLES), addControl)
router.put('/:id/controls/:cid',    requireRole(WRITE_ROLES), updateControl)
router.delete('/:id/controls/:cid', requireRole(WRITE_ROLES), deleteControl)

// ── Observations ──────────────────────────────────────────────────────
router.post('/:id/observations',        requireRole(WRITE_ROLES), addObservation)
router.put('/:id/observations/:oid',    requireRole(WRITE_ROLES), updateObservation)
router.delete('/:id/observations/:oid', requireRole(WRITE_ROLES), deleteObservation)

// ── Results ───────────────────────────────────────────────────────────
router.post('/:id/results',        requireRole(WRITE_ROLES), addResult)
router.put('/:id/results/:rid',    requireRole(WRITE_ROLES), updateResult)
router.delete('/:id/results/:rid', requireRole(WRITE_ROLES), deleteResult)

// ── Conclusions ───────────────────────────────────────────────────────
router.put('/:id/conclusions', requireRole(WRITE_ROLES), upsertConclusions)

// ── Waste records ─────────────────────────────────────────────────────
router.post('/:id/waste',        requireRole(WRITE_ROLES), addWasteRecord)
router.delete('/:id/waste/:wid', requireRole(WRITE_ROLES), deleteWasteRecord)

// ── Ethical approvals ─────────────────────────────────────────────────
router.post('/:id/approvals',          requireRole(WRITE_ROLES),  addEthicalApproval)
router.delete('/:id/approvals/:apid',  requireRole(MANAGE_ROLES), deleteEthicalApproval)

export default router
