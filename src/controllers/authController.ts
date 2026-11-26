
import type { Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User";
import type { AuthRequest } from "../middleware/authMiddleware";
import { getServerConfig } from "../config/env";
import {
    EmailNotConfiguredError,
    isEmailConfigured,
    sendPasswordResetEmail,
    sendVerificationEmail,
} from "../lib/email";
import { createOpaqueToken, hashOpaqueToken } from "../lib/tokens";
import { asRecord, isValidEmail, readString } from "../lib/validation";

export const createToken = (
    userId: string,
    tokenVersion = 0,
): string => {
    return jwt.sign({ userId, tokenVersion }, getServerConfig().jwtSecret, {
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
    emailVerified?: boolean;
    createdAt?: Date;
}) => ({
    id: String(user._id),
    name: user.name,
    email: user.email,
    ...(user.phone ? { phone: user.phone } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    role: user.role,
    emailVerified: user.emailVerified === true,
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

function validPassword(password: string): boolean {
    return (
        password.length >= 8 &&
        Buffer.byteLength(password, "utf8") <= 72 &&
        /[A-Za-z]/.test(password) &&
        /\d/.test(password)
    );
}

async function storeVerificationToken(userId: string): Promise<string> {
    const token = createOpaqueToken();
    const { auth } = getServerConfig();
    await User.updateOne(
        { _id: userId },
        {
            $set: {
                emailVerificationTokenHash: hashOpaqueToken(token),
                emailVerificationExpiresAt: new Date(
                    Date.now() + auth.verificationTtlMinutes * 60_000,
                ),
            },
        },
    );
    return token;
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

        if (!isValidEmail(cleanEmail)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address.",
            });
        }

        if (!validPassword(password)) {
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
            emailVerified: false,
        });

        const { auth } = getServerConfig();
        let verificationEmail: { sent: boolean; reason?: string } = {
            sent: false,
            reason: "email_not_configured",
        };

        if (isEmailConfigured()) {
            try {
                const token = await storeVerificationToken(String(user._id));
                await sendVerificationEmail({
                    to: user.email,
                    name: user.name,
                    token,
                });
                verificationEmail = { sent: true };
            } catch (error) {
                logAuthError("Verification email delivery failed.", error);
                verificationEmail = {
                    sent: false,
                    reason:
                        error instanceof EmailNotConfiguredError
                            ? "email_not_configured"
                            : "delivery_failed",
                };
            }
        }

        if (auth.emailVerificationRequired) {
            return res.status(201).json({
                success: true,
                requiresEmailVerification: true,
                verificationEmail,
                user: formatUser(user),
                message:
                    "Your account was created. Check your email and verify your address before signing in.",
            });
        }

        const token = createToken(
            String(user._id),
            user.tokenVersion ?? 0,
        );

        return res.status(201).json({
            success: true,
            token,
            user: formatUser(user),
            verificationEmail,
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

        if (user.isBlocked) {
            return res.status(403).json({
                success: false,
                code: "account_blocked",
                message:
                    "This account has been blocked. Please contact the salon team for help.",
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

        const { auth } = getServerConfig();
        if (auth.emailVerificationRequired && !user.emailVerified) {
            return res.status(403).json({
                success: false,
                code: "email_not_verified",
                message:
                    "Please verify your email address before signing in. Check your inbox for the verification link.",
            });
        }

        await User.updateOne(
            { _id: user._id },
            { $set: { lastLoginAt: new Date() } },
        );

        const token = createToken(
            String(user._id),
            user.tokenVersion ?? 0,
        );

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

// FORGOT PASSWORD
export const forgotPassword = async (req: Request, res: Response) => {
    try {
        const body = getRequestBody(req.body);
        const emailRaw = body ? readString(body.email, 254) : null;
        if (!emailRaw || !isValidEmail(emailRaw)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address.",
            });
        }

        if (!isEmailConfigured()) {
            return res.status(503).json({
                success: false,
                code: "email_not_configured",
                message:
                    "Password reset email is not configured on this server. Please contact the salon team.",
            });
        }

        const email = emailRaw.toLowerCase();
        const user = await User.findOne({ email });

        if (user && !user.isBlocked) {
            const token = createOpaqueToken();
            const { auth } = getServerConfig();
            await User.updateOne(
                { _id: user._id },
                {
                    $set: {
                        passwordResetTokenHash: hashOpaqueToken(token),
                        passwordResetExpiresAt: new Date(
                            Date.now() + auth.passwordResetTtlMinutes * 60_000,
                        ),
                    },
                },
            );

            try {
                await sendPasswordResetEmail({
                    to: user.email,
                    name: user.name,
                    token,
                });
            } catch (error) {
                logAuthError("Password reset email delivery failed.", error);
                if (error instanceof EmailNotConfiguredError) {
                    return res.status(503).json({
                        success: false,
                        code: "email_not_configured",
                        message:
                            "Password reset email is not configured on this server. Please contact the salon team.",
                    });
                }
                return res.status(502).json({
                    success: false,
                    code: "email_delivery_failed",
                    message:
                        "The password reset email could not be delivered. Please try again shortly.",
                });
            }
        }

        return res.status(200).json({
            success: true,
            message:
                "If an account exists for that email address, a password reset link has been sent.",
        });
    } catch (error) {
        logAuthError("Forgot-password request failed.", error);
        return res.status(500).json({
            success: false,
            message: "Unable to start a password reset right now.",
        });
    }
};

// RESET PASSWORD
export const resetPassword = async (req: Request, res: Response) => {
    try {
        const body = getRequestBody(req.body);
        const token = body ? readString(body.token, 200) : null;
        const password = body?.password;

        if (!token || typeof password !== "string" || !validPassword(password)) {
            return res.status(400).json({
                success: false,
                message:
                    "A valid reset token and a password of 8-72 bytes containing a letter and a number are required.",
            });
        }

        const user = await User.findOne({
            passwordResetTokenHash: hashOpaqueToken(token),
            passwordResetExpiresAt: { $gt: new Date() },
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                message:
                    "This reset link is invalid or has expired. Please request a new one.",
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const result = await User.updateOne(
            { _id: user._id, passwordResetTokenHash: hashOpaqueToken(token) },
            {
                $set: {
                    passwordHash,
                    emailVerified: true,
                    lastLoginAt: new Date(),
                },
                $unset: {
                    passwordResetTokenHash: 1,
                    passwordResetExpiresAt: 1,
                    emailVerificationTokenHash: 1,
                    emailVerificationExpiresAt: 1,
                },
                $inc: { tokenVersion: 1 },
            },
        );

        if (result.modifiedCount !== 1) {
            return res.status(400).json({
                success: false,
                message:
                    "This reset link is invalid or has expired. Please request a new one.",
            });
        }

        return res.status(200).json({
            success: true,
            message:
                "Your password has been updated. Sign in again with the new password.",
        });
    } catch (error) {
        logAuthError("Password reset failed.", error);
        return res.status(500).json({
            success: false,
            message: "Unable to reset your password right now.",
        });
    }
};

// VERIFY EMAIL
export const verifyEmail = async (req: Request, res: Response) => {
    try {
        const body = getRequestBody(req.body);
        const token = body ? readString(body.token, 200) : null;
        if (!token) {
            return res.status(400).json({
                success: false,
                message: "A verification token is required.",
            });
        }

        const tokenHash = hashOpaqueToken(token);
        const result = await User.updateOne(
            {
                emailVerificationTokenHash: tokenHash,
                emailVerificationExpiresAt: { $gt: new Date() },
            },
            {
                $set: { emailVerified: true },
                $unset: {
                    emailVerificationTokenHash: 1,
                    emailVerificationExpiresAt: 1,
                },
            },
        );

        if (result.modifiedCount !== 1) {
            return res.status(400).json({
                success: false,
                message:
                    "This verification link is invalid or has expired. Sign in and request a new link.",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Your email address has been verified.",
        });
    } catch (error) {
        logAuthError("Email verification failed.", error);
        return res.status(500).json({
            success: false,
            message: "Unable to verify your email address right now.",
        });
    }
};

// RESEND VERIFICATION BY EMAIL (public, rate-limited)
// Used when a user has not verified yet and therefore cannot obtain a JWT.
export const resendVerificationByEmail = async (req: Request, res: Response) => {
    try {
        const body = getRequestBody(req.body);
        const emailRaw = body ? readString(body.email, 254) : null;
        if (!emailRaw || !isValidEmail(emailRaw)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address.",
            });
        }

        if (!isEmailConfigured()) {
            return res.status(503).json({
                success: false,
                code: "email_not_configured",
                message:
                    "Email delivery is not configured on this server. Please contact the salon team.",
            });
        }

        const email = emailRaw.toLowerCase();
        const user = await User.findOne({ email });

        if (user && !user.isBlocked && !user.emailVerified) {
            const token = await storeVerificationToken(String(user._id));
            try {
                await sendVerificationEmail({
                    to: user.email,
                    name: user.name,
                    token,
                });
            } catch (error) {
                logAuthError("Verification email delivery failed.", error);
                if (error instanceof EmailNotConfiguredError) {
                    return res.status(503).json({
                        success: false,
                        code: "email_not_configured",
                        message:
                            "Email delivery is not configured on this server. Please contact the salon team.",
                    });
                }
                return res.status(502).json({
                    success: false,
                    code: "email_delivery_failed",
                    message:
                        "The verification email could not be delivered. Please try again shortly.",
                });
            }
        }

        return res.status(200).json({
            success: true,
            message:
                "If an account exists for that email address and still needs verification, a new link has been sent.",
        });
    } catch (error) {
        logAuthError("Resend verification by email failed.", error);
        return res.status(500).json({
            success: false,
            message: "Unable to send a verification email right now.",
        });
    }
};

// CHANGE PASSWORD (signed-in)
export const changePassword = async (req: AuthRequest, res: Response) => {
    try {
        if (!req.userId) {
            return res.status(401).json({
                success: false,
                message: "Please sign in to continue.",
            });
        }
        const body = getRequestBody(req.body);
        const currentPassword = body?.currentPassword;
        const newPassword = body?.newPassword;
        if (
            typeof currentPassword !== "string" ||
            !currentPassword ||
            typeof newPassword !== "string" ||
            !validPassword(newPassword)
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Current password is required and the new password must be 8-72 bytes containing a letter and a number.",
            });
        }

        const user = await User.findById(req.userId).select("+passwordHash");
        if (!user?.passwordHash) {
            return res.status(409).json({
                success: false,
                message:
                    "This account does not have a password. Use the sign-in method originally used to create it.",
            });
        }

        const matches = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!matches) {
            return res.status(401).json({
                success: false,
                message: "The current password is incorrect.",
            });
        }

        user.passwordHash = await bcrypt.hash(newPassword, 12);
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        await user.save();

        const token = createToken(String(user._id), user.tokenVersion);
        return res.status(200).json({
            success: true,
            token,
            user: formatUser(user),
        });
    } catch (error) {
        logAuthError("Change password failed.", error);
        return res.status(500).json({
            success: false,
            message: "Unable to change your password right now.",
        });
    }
};

// RESEND VERIFICATION (signed-in)
export const resendVerification = async (req: AuthRequest, res: Response) => {
    try {
        if (!req.userId) {
            return res.status(401).json({
                success: false,
                message: "Please sign in to continue.",
            });
        }

        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found.",
            });
        }

        if (user.emailVerified) {
            return res.status(200).json({
                success: true,
                alreadyVerified: true,
                message: "Your email address is already verified.",
            });
        }

        if (!isEmailConfigured()) {
            return res.status(503).json({
                success: false,
                code: "email_not_configured",
                message:
                    "Email delivery is not configured on this server. Please contact the salon team.",
            });
        }

        const token = await storeVerificationToken(String(user._id));
        try {
            await sendVerificationEmail({
                to: user.email,
                name: user.name,
                token,
            });
        } catch (error) {
            logAuthError("Verification email delivery failed.", error);
            return res.status(502).json({
                success: false,
                code: "email_delivery_failed",
                message:
                    "The verification email could not be delivered. Please try again shortly.",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Verification email sent.",
        });
    } catch (error) {
        logAuthError("Resend verification failed.", error);
        return res.status(500).json({
            success: false,
            message: "Unable to send a verification email right now.",
        });
    }
};
