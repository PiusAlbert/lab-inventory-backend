import { getDashboardMetrics } from "../services/dashboard.service.js";

export const dashboard = async (req, res) => {
  try {

    /**
     * Validate authenticated user
     */
    if (!req.user || !req.user.laboratory_id) {
      return res.status(401).json({
        error: "Unauthorized request"
      });
    }

    const labId = req.user.laboratory_id;

    /**
     * Fetch dashboard metrics
     */
    const metrics = await getDashboardMetrics(labId);

    return res.status(200).json({
      success: true,
      data: metrics
    });

  } catch (err) {

    console.error("Dashboard error:", err);

    return res.status(500).json({
      success: false,
      error: "Failed to load dashboard metrics"
    });

  }
};