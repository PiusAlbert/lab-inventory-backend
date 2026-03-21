import { getDashboardMetrics } from "../services/dashboard.service.js";

export const dashboard = async (req, res) => {
  try {

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    /**
     * SUPER_ADMIN with no lab selected → labId is null → show all-labs aggregate.
     * Regular users always have a labId.
     * We no longer reject null labId here — dashboard.service handles both cases.
     */
    const labId = req.user.laboratory_id ?? null;

    const metrics = await getDashboardMetrics(labId, req.user.is_admin);

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