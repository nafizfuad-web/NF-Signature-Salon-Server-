
import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User";
import type { AuthRequest } from "../middleware/authMiddleware";

const createToken = (userId: string): string => {
    const secret = process.env.JWT_SECRET;

    if (!secret) {
        throw new Error("JWT_SECRET is not configured.");
    }

    return jwt.sign({ userId }, secret, { expiresIn: "7d" });
};

const formatUser = (user: {
    _id: unknown;
    name: string;
    email: string;
    phone?: string;
    role: "customer" | "admin";
    createdAt?: Date;
}) => ({
    id: String(user._id),
    name: user.name,
    email: user.email,
    ...(user.phone ? { phone: user.phone } : {}),
    role: user.role,
    ...(user.createdAt ? { createdAt: user.createdAt.toISOString() } : {}),
});

// REGISTER
export const register = async (req: Request, res: Response) => {
    try {
        const { name, email, phone, password } = req.body;

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

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address.",
            });
        }

        if (
            password.length < 8 ||
            password.length > 128 ||
            !/[A-Za-z]/.test(password) ||
            !/\d/.test(password)
        ) {
            return res.status(400).json({
                success: false,
                message: "Password must be 8-128 characters and include a letter and a number.",
            });
        }

        if (
            phone !== undefined &&
            (typeof phone !== "string" ||
                phone.trim().replace(/[^\d]/g, "").length < 7)
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
                message: "An account with this email already exists.",
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
        console.error("Registration error:", error);

        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === 11000
        ) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists.",
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
        const { email, password } = req.body;

        if (
            typeof email !== "string" ||
            typeof password !== "string" ||
            !email.trim() ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required.",
            });
        }

        const user = await User.findOne({
            email: email.trim().toLowerCase(),
        }).select("+passwordHash");

        if (!user) {
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
        console.error("Login error:", error);

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
        console.error("Get current user error:", error);

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
