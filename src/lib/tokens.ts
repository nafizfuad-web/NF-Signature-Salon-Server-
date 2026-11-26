// SalonBook — opaque token helpers for email verification and password reset.
// Raw tokens are only ever sent by email; MongoDB stores a SHA-256 hash.

import { createHash, randomBytes } from "node:crypto";

export function createOpaqueToken(): string {
    return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}
