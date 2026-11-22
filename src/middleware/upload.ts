// SalonBook — avatar upload middleware.
//
// Images are stored on the server filesystem (not in MongoDB) under
// salonbook-server/uploads/avatars and served read-only from /uploads.
// Only small, image-only uploads are accepted.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";

export const UPLOAD_ROOT = path.resolve(__dirname, "../../uploads");
export const AVATAR_DIR = path.join(UPLOAD_ROOT, "avatars");

fs.mkdirSync(AVATAR_DIR, { recursive: true });

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
};

const storage = multer.diskStorage({
    destination: (_req, _file, callback) => {
        callback(null, AVATAR_DIR);
    },
    filename: (_req, file, callback) => {
        const extension = ALLOWED_IMAGE_TYPES[file.mimetype] ?? ".jpg";
        callback(
            null,
            `avatar-${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`,
        );
    },
});

const avatarUpload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
        if (!Object.prototype.hasOwnProperty.call(ALLOWED_IMAGE_TYPES, file.mimetype)) {
            callback(new Error("Please upload a JPG, PNG, WEBP or GIF image."));
            return;
        }
        callback(null, true);
    },
});

/** Express middleware wrapper that turns multer failures into safe 400 JSON responses. */
export function handleAvatarUpload(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    avatarUpload.single("avatar")(req, res, (error: unknown) => {
        if (!error) {
            next();
            return;
        }

        const message =
            error instanceof multer.MulterError
                ? error.code === "LIMIT_FILE_SIZE"
                    ? "The image must be 2 MB or smaller."
                    : "The image upload could not be completed."
                : error instanceof Error
                  ? error.message
                  : "The image upload could not be completed.";

        res.status(400).json({ success: false, message });
    });
}

/** Only files inside the avatar directory may ever be deleted. */
export function avatarPathFromUrl(url: string | undefined): string | null {
    if (!url || !url.startsWith("/uploads/avatars/")) return null;
    const relative = url.slice("/uploads/".length);
    const resolved = path.resolve(UPLOAD_ROOT, relative);
    if (!resolved.startsWith(AVATAR_DIR + path.sep)) return null;
    return resolved;
}

export async function deleteAvatarFile(url: string | undefined): Promise<void> {
    const filePath = avatarPathFromUrl(url);
    if (!filePath) return;
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn("Avatar file cleanup failed.", {
                errorName: error instanceof Error ? error.name : "UnknownError",
            });
        }
    }
}
