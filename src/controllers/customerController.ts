// SalonBook — customer account endpoints.
//
// Every query is scoped to the authenticated user; there is no endpoint that
// exposes another customer's appointments or profile.

import type { Response } from "express";
import Appointment, { type AppointmentFields } from "../models/Appointment";
import User from "../models/User";
import { formatUser } from "./authController";
import { formatAppointment } from "../lib/serializers";
import type { AuthRequest } from "../middleware/authMiddleware";
import { currentMinutes, localDateString } from "../lib/booking";
import { deleteAvatarFile } from "../middleware/upload";
import {
    asRecord,
    isDuplicateKeyError,
    isValidEmail,
    isValidPhone,
    readOptionalString,
    readString,
} from "../lib/validation";

type LeanAppointment = AppointmentFields & {
    _id: unknown;
    createdAt?: Date;
};

function fail(res: Response, status: number, message: string): void {
    res.status(status).json({ success: false, message });
}

function logFailure(action: string, error: unknown): void {
    console.error(action, {
        errorName: error instanceof Error ? error.name : "UnknownError",
    });
}

function isUpcoming(appointment: LeanAppointment, now: Date): boolean {
    const today = localDateString(now);
    if (appointment.date > today) return true;
    if (appointment.date < today) return false;
    return appointment.startMinutes >= currentMinutes(now);
}

export async function getDashboard(req: AuthRequest, res: Response): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }

        const now = new Date();
        const appointments = (await Appointment.find({ customer: req.userId })
            .sort({ date: -1, startMinutes: -1 })
            .lean()) as unknown as LeanAppointment[];

        const active = appointments.filter(
            (appointment) =>
                appointment.status === "pending" || appointment.status === "confirmed",
        );
        const upcoming = active
            .filter((appointment) => isUpcoming(appointment, now))
            .sort(
                (left, right) =>
                    left.date.localeCompare(right.date) ||
                    left.startMinutes - right.startMinutes,
            );
        const completed = appointments.filter(
            (appointment) => appointment.status === "completed",
        );

        const categoryCounts = new Map<string, number>();
        for (const appointment of appointments) {
            if (appointment.status === "cancelled") continue;
            categoryCounts.set(
                appointment.category,
                (categoryCounts.get(appointment.category) ?? 0) + 1,
            );
        }

        let favouriteCategory: string | undefined;
        let favouriteCount = 0;
        for (const [category, count] of categoryCounts) {
            if (count > favouriteCount) {
                favouriteCount = count;
                favouriteCategory = category;
            }
        }

        const stats: {
            upcoming: number;
            completed: number;
            visits: number;
            favouriteCategory?: string;
        } = {
            upcoming: upcoming.length,
            completed: completed.length,
            visits: completed.length,
        };
        if (favouriteCategory) {
            stats.favouriteCategory = favouriteCategory;
        }

        const recent = [...appointments].slice(0, 5);
        const nextAppointment = upcoming[0];

        res.status(200).json({
            success: true,
            data: {
                stats,
                nextAppointment: nextAppointment
                    ? formatAppointment(nextAppointment)
                    : null,
                recentAppointments: recent.map((appointment) =>
                    formatAppointment(appointment),
                ),
            },
        });
    } catch (error) {
        logFailure("Customer dashboard failed.", error);
        fail(res, 500, "Unable to load your dashboard right now.");
    }
}

export async function getMyAppointments(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }

        const appointments = (await Appointment.find({ customer: req.userId })
            .sort({ date: -1, startMinutes: -1 })
            .lean()) as unknown as LeanAppointment[];

        res.status(200).json({
            success: true,
            data: appointments.map((appointment) => formatAppointment(appointment)),
        });
    } catch (error) {
        logFailure("Customer appointments failed.", error);
        fail(res, 500, "Unable to load your appointments right now.");
    }
}

export async function updateProfile(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }

        const body = asRecord(req.body);
        if (!body) {
            fail(res, 400, "A valid JSON body is required.");
            return;
        }

        const name = readString(body.name, 100);
        if (!name || name.length < 2) {
            fail(res, 400, "Name must be between 2 and 100 characters.");
            return;
        }

        const emailRaw = readString(body.email, 254);
        if (!emailRaw || !isValidEmail(emailRaw)) {
            fail(res, 400, "Please enter a valid email address.");
            return;
        }
        const email = emailRaw.toLowerCase();

        const phoneValue = readOptionalString(body.phone, 40);
        if (phoneValue === null) {
            fail(res, 400, "Please enter a valid phone number.");
            return;
        }

        const phone = phoneValue;
        if (phone && !isValidPhone(phone)) {
            fail(res, 400, "Please enter a valid phone number.");
            return;
        }

        const duplicate = await User.findOne({
            email,
            _id: { $ne: req.userId },
        })
            .select("_id")
            .lean();
        if (duplicate) {
            fail(res, 409, "An account with this email already exists.");
            return;
        }

        let updated;
        try {
            updated = await User.findByIdAndUpdate(
                req.userId,
                phone
                    ? { $set: { name, email, phone } }
                    : { $set: { name, email }, $unset: { phone: 1 } },
                { new: true, runValidators: true },
            );
        } catch (error) {
            if (isDuplicateKeyError(error)) {
                fail(res, 409, "An account with this email already exists.");
                return;
            }
            throw error;
        }

        if (!updated) {
            fail(res, 404, "We could not find your account.");
            return;
        }

        res.status(200).json({ success: true, user: formatUser(updated) });
    } catch (error) {
        logFailure("Profile update failed.", error);
        fail(res, 500, "Unable to save your profile right now.");
    }
}

export async function uploadAvatar(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }

        const file = req.file;
        if (!file) {
            fail(res, 400, "Choose an image to upload.");
            return;
        }

        const user = await User.findById(req.userId);
        if (!user) {
            await deleteAvatarFile(`/uploads/avatars/${file.filename}`);
            fail(res, 404, "We could not find your account.");
            return;
        }

        const previousAvatar = user.avatarUrl;
        user.avatarUrl = `/uploads/avatars/${file.filename}`;
        await user.save();

        if (previousAvatar) {
            await deleteAvatarFile(previousAvatar);
        }

        res.status(200).json({ success: true, user: formatUser(user) });
    } catch (error) {
        logFailure("Avatar upload failed.", error);
        fail(res, 500, "Unable to save your profile picture right now.");
    }
}

export async function removeAvatar(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }

        const user = await User.findById(req.userId);
        if (!user) {
            fail(res, 404, "We could not find your account.");
            return;
        }

        const previousAvatar = user.avatarUrl;
        if (previousAvatar) {
            await User.updateOne({ _id: user._id }, { $unset: { avatarUrl: 1 } });
            await deleteAvatarFile(previousAvatar);
        }

        const updated = await User.findById(req.userId);
        if (!updated) {
            fail(res, 404, "We could not find your account.");
            return;
        }

        res.status(200).json({ success: true, user: formatUser(updated) });
    } catch (error) {
        logFailure("Avatar removal failed.", error);
        fail(res, 500, "Unable to remove your profile picture right now.");
    }
}
