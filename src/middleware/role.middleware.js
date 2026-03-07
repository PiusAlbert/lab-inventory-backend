/**
 * ROLE-BASED ACCESS CONTROL
 * Usage:
 * requireRole(['LAB_MANAGER', 'SUPER_ADMIN'])
 */

export const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {

    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (!req.user.role) {
      return res.status(403).json({ error: 'User role not defined' })
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }

    next()
  }
}