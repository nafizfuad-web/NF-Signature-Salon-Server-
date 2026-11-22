
import type { Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User";
import type { AuthRequest } from "../middleware/authMiddleware";
import { getServerConfig } from "../config/env";

export const createToken = (userId: string): string => {
    return jwt.sign({ userId }, getServerConfig().jwtSecret, {
        expiresIn: "7d",
        algorithm: "HS256",
    });
};

export const formatUser = (user: {
    _id: unknown;
    name: string;
    email: string;
    phone?: string;
    avatarUrl?: string;
    role: "customer" | "admin";
    createdAt?: Date;
}) => ({
    id: String(user._id),
    name: user.name,
    email: user.email,
    ...(user.phone ? { phone: user.phone } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    role: user.role,
    ...(user.createdAt ? { createdAt: user.createdAt.toISOString() } : {}),
});

function getRequestBody(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function isDuplicateEmailError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 11000
    );
}

function logAuthError(action: string, error: unknown): void {
    console.error(action, {
        errorName: error instanceof Error ? error.name : "UnknownError",
        ...(isDuplicateEmailError(error) ? { databaseCode: 11000 } : {}),
    });
}

// REGISTER
export const register = async (req: Request, res: Response) => {
    try {
        const body = getRequestBody(req.body);
        if (!body) {
            return res.status(400).json({
                success: false,
                message: "A valid JSON object is required.",
            });
        }
        const { name, email, phone, password } = body;

        if (
            typeof name !== "string" ||
            typeof email !== "string" ||
            typeof password !== "string"
        ) {
            return res.status(400).json({
                success: false,
                message: "Name, email and password are required.",
            });
        }

        const cleanName = name.trim();
        const cleanEmail = email.trim().toLowerCase();

        if (cleanName.length < 2 || cleanName.length > 100) {
            return res.status(400).json({
                success: false,
                message: "Name must be between 2 and 100 characters.",
            });
        }

        if (
            cleanEmail.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
        ) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address.",
            });
        }

        if (
            password.length < 8 ||
            Buffer.byteLength(password, "utf8") > 72 ||
            !/[A-Za-z]/.test(password) ||
            !/\d/.test(password)
        ) {
            return res.status(400).json({
                success: false,
                message: "Password must be 8-72 bytes and include a letter and a number.",
            });
        }

        if (
            phone !== undefined &&
            (typeof phone !== "string" ||
                (phone.trim() !== "" &&
                    (phone.trim().replace(/[^\d]/g, "").length < 7 ||
                        phone.trim().replace(/[^\d]/g, "").length > 15)))
        ) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid phone number.",
            });
        }

        const existingUser = await User.findOne({ email: cleanEmail });

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists. Please sign in instead.",
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const user = await User.create({
            name: cleanName,
            email: cleanEmail,
            ...(typeof phone === "string" && phone.trim()
                ? { phone: phone.trim() }
                : {}),
            passwordHash,
            role: "customer",
        });

        const token = createToken(String(user._id));

        return res.status(201).json({
            success: true,
            token,
            user: formatUser(user),
        });
    } catch (error) {
        logAuthError("Registration failed.", error);
        if (isDuplicateEmailError(error)) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists. Please sign in instead.",
            });
        }
        if (error instanceof mongoose.Error.ValidationError) {
            return res.status(400).json({
                success: false,
                message: "Please check your account details and try again.",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Unable to create your account. Please try again.",
        });
    }
};

// LOGIN
export const login = async (req: Request, res: Response) => {
    try {
        const body = getRequestBody(req.body);
        if (!body) {
            return res.status(400).json({
                success: false,
                message: "A valid JSON object is required.",
            });
        }
        const { email, password } = body;

        if (
            typeof email !== "string" ||
            typeof password !== "string" ||
            !email.trim() ||
            email.trim().length > 254 ||
            !password ||
            Buffer.byteLength(password, "utf8") > 72
        ) {
            return res.status(400).json({
                success: false,
                message: "A valid email address and password are required.",
            });
        }

        const user = await User.findOne({
            email: email.trim().toLowerCase(),
        }).select("+passwordHash");

        if (!user?.passwordHash) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password.",
            });
        }

        const passwordMatches = await bcrypt.compare(
            password,
            user.passwordHash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password.",
            });
        }

        const token = createToken(String(user._id));

        return res.status(200).json({
            success: true,
            token,
            user: formatUser(user),
        });
    } catch (error) {
        logAuthError("Login failed.", error);

        return res.status(500).json({
            success: false,
            message: "Unable to sign in. Please try again.",
        });
    }
};

// GET CURRENT USER
export const getMe = async (req: AuthRequest, res: Response) => {
    try {
        const user = await User.findById(req.userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found.",
            });
        }

        return res.status(200).json({
            success: true,
            user: formatUser(user),
        });
    } catch (error) {
        logAuthError("Current-user request failed.", error);

        return res.status(500).json({
            success: false,
            message: "Unable to retrieve account information.",
        });
    }
};

// LOGOUT
export const logout = async (_req: Request, res: Response) => {
    return res.status(200).json({
        success: true,
        message: "Signed out successfully.",
    });
};
