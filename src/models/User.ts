
import mongoose, { Schema, type Model, type Types } from "mongoose";

export interface UserFields {
    name: string;
    email: string;
    phone?: string;
    avatarUrl?: string;
    passwordHash?: string;
    googleId?: string;
    role: "customer" | "admin";
    isBlocked: boolean;
    blockedAt?: Date;
    blockedBy?: Types.ObjectId;
    blockReason?: string;
    emailVerified: boolean;
    emailVerificationTokenHash?: string;
    emailVerificationExpiresAt?: Date;
    passwordResetTokenHash?: string;
    passwordResetExpiresAt?: Date;
    tokenVersion: number;
    lastLoginAt?: Date;
}

const userSchema = new Schema<UserFields>(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 2,
            maxlength: 100,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            maxlength: 254,
            match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        },
        phone: {
            type: String,
            trim: true,
            maxlength: 40,
        },
        avatarUrl: {
            type: String,
            trim: true,
            maxlength: 500,
        },
        passwordHash: {
            type: String,
            select: false,
        },
        googleId: {
            type: String,
            unique: true,
            sparse: true,
            select: false,
        },
        role: {
            type: String,
            enum: ["customer", "admin"],
            default: "customer",
            index: true,
        },
        isBlocked: {
            type: Boolean,
            default: false,
            index: true,
        },
        blockedAt: {
            type: Date,
        },
        blockedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
        blockReason: {
            type: String,
            trim: true,
            maxlength: 300,
        },
        emailVerified: {
            type: Boolean,
            default: false,
        },
        emailVerificationTokenHash: {
            type: String,
            select: false,
        },
        emailVerificationExpiresAt: {
            type: Date,
            select: false,
        },
        passwordResetTokenHash: {
            type: String,
            select: false,
        },
        passwordResetExpiresAt: {
            type: Date,
            select: false,
        },
        tokenVersion: {
            type: Number,
            default: 0,
            min: 0,
        },
        lastLoginAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
    }
);

const User: Model<UserFields> =
    (mongoose.models.User as Model<UserFields>) ||
    mongoose.model<UserFields>("User", userSchema);

export default User;
