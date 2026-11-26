
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User";
import { getServerConfig } from "../config/env";

export interface AuthRequest extends Request {
    userId?: string;
    userRole?: "customer" | "admin";
    userEmail?: string;
}

export const protect = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
) => {
    const secret = getServerConfig().jwtSecret;
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
        return res.status(401).json({
            success: false,
            message: "Authentication required.",
        });
    }

    const token = authorization.slice("Bearer ".length).trim();
    if (!token || !secret) {
        return res.status(401).json({
            success: false,
            message: "Invalid authentication token.",
        });
    }

    let userId: string;
    let tokenVersion: number;
    try {
        const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });

        if (
            typeof decoded !== "object" ||
            decoded === null ||
            typeof decoded.userId !== "string"
        ) {
            throw new Error("Invalid token claims.");
        }

        userId = decoded.userId;
        tokenVersion =
            typeof decoded.tokenVersion === "number" ? decoded.tokenVersion : 0;
    } catch {
        return res.status(401).json({
            success: false,
            message: "Session expired. Please sign in again.",
        });
    }

    const user = await User.findById(userId).select(
        "_id role email isBlocked tokenVersion",
    );
    if (!user) {
        return res.status(401).json({
            success: false,
            message: "Session expired. Please sign in again.",
        });
    }

    if ((user.tokenVersion ?? 0) !== tokenVersion) {
        return res.status(401).json({
            success: false,
            message: "Session expired. Please sign in again.",
        });
    }

    if (user.isBlocked) {
        return res.status(403).json({
            success: false,
            code: "account_blocked",
            message:
                "This account has been blocked. Please contact the salon team for help.",
        });
    }

    req.userId = String(user._id);
    req.userRole = user.role;
    req.userEmail = user.email;
    return next();
};

export const requireRole = (...roles: Array<"customer" | "admin">) => (
    req: AuthRequest,
    res: Response,
    next: NextFunction
) => {
    if (!req.userRole) {
        return res.status(401).json({
            success: false,
            message: "Authentication required.",
        });
    }
    if (!roles.includes(req.userRole)) {
        return res.status(403).json({
            success: false,
            message: "You do not have permission to access this resource.",
        });
    }
    return next();
};
