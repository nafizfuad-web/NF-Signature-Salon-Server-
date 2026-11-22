// SalonBook — small request-validation helpers shared by controllers.

import mongoose from "mongoose";

export function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

/** Returns a trimmed string no longer than maxLength, or null when invalid. */
export function readString(
    value: unknown,
    maxLength: number,
): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength) return null;
    return trimmed;
}

/** Returns a trimmed string (possibly empty) or null when the value is not a string. */
export function readOptionalString(value: unknown, maxLength: number): string | null {
    if (value === undefined) return "";
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length > maxLength) return null;
    return trimmed;
}

export function isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

export function isValidPhone(value: string): boolean {
    const digits = value.replace(/[^\d]/g, "");
    return digits.length >= 7 && digits.length <= 15;
}

export function isValidObjectId(value: unknown): value is string {
    return typeof value === "string" && mongoose.isValidObjectId(value);
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isDuplicateKeyError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 11000
    );
}
