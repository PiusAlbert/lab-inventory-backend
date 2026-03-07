import { getDashboardMetrics } from '../services/dashboard.service.js'

export const dashboard = async (req, res) => {

  const labId = req.user.laboratory_id

  try {

    const metrics = await getDashboardMetrics(labId)

    res.json(metrics)

  } catch (err) {

    res.status(500).json({
      error: 'Failed to load dashboard'
    })

  }
}