
import mongoose, { Schema, type Model } from "mongoose";

interface UserFields {
    name: string;
    email: string;
    phone?: string;
    passwordHash?: string;
    googleId?: string;
    role: "customer" | "admin";
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
