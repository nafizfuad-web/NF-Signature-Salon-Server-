
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
    userId?: string;
}

export const protect = (
    req: AuthRequest,
    res: Response,
    next: NextFunction
) => {
    try {
        const authorization = req.headers.authorization;

        if (!authorization?.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Authentication required.",
            });
        }

        const token = authorization.split(" ")[1];
        const secret = process.env.JWT_SECRET;

        if (!token || !secret) {
            return res.status(401).json({
                success: false,
                message: "Invalid authentication token.",
            });
        }

        const decoded = jwt.verify(token, secret);

        if (
            typeof decoded !== "object" ||
            decoded === null ||
            typeof decoded.userId !== "string"
        ) {
            return res.status(401).json({
                success: false,
                message: "Invalid authentication token.",
            });
        }

        req.userId = decoded.userId;
        next();
    } catch {
        return res.status(401).json({
            success: false,
            message: "Session expired. Please sign in again.",
        });
    }
};
