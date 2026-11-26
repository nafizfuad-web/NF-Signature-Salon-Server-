// SalonBook — admin audit logging.

import type { AuthRequest } from "../middleware/authMiddleware";
import AuditLog from "../models/AuditLog";

export async function recordAudit(
    req: AuthRequest,
    action: string,
    entityType: string,
    entityId?: string,
    metadata?: Record<string, unknown>,
): Promise<void> {
    if (!req.userId) return;
    try {
        await AuditLog.create({
            actor: req.userId,
            ...(req.userEmail ? { actorEmail: req.userEmail } : {}),
            action,
            entityType,
            ...(entityId ? { entityId } : {}),
            ...(metadata ? { metadata } : {}),
            ...(req.ip ? { ipAddress: req.ip.slice(0, 80) } : {}),
            ...(req.headers["user-agent"]
                ? { userAgent: String(req.headers["user-agent"]).slice(0, 300) }
                : {}),
        });
    } catch (error) {
        console.error("Audit log write failed.", {
            action,
            entityType,
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
    }
}
