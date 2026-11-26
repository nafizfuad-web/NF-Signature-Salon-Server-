// SalonBook — admin dashboard, customer, and service management endpoints.
// All routes are mounted under /api/admin with protect + requireRole("admin").

import type { Response } from "express";
import mongoose, { type QueryFilter } from "mongoose";
import Appointment, { APPOINTMENT_STATUSES } from "../models/Appointment";
import Service, { SERVICE_CATEGORIES, type ServiceFields } from "../models/Service";
import Transaction, { SETTLED_PAYMENT_STATUSES } from "../models/Transaction";
import User, { type UserFields } from "../models/User";
import type { AuthRequest } from "../middleware/authMiddleware";
import { formatAppointment, formatTransaction } from "../lib/serializers";
import { escapeRegExp, isValidObjectId } from "../lib/validation";

function fail(res: Response, status: number, message: string): void {
    res.status(status).json({ success: false, message });
}

function logFailure(action: string, error: unknown): void {
    console.error(action, {
        errorName: error instanceof Error ? error.name : "UnknownError",
    });
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function readString(value: unknown, max = 500): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : null;
}

function readOptionalString(value: unknown, max = 500): string | undefined | null {
    if (value === undefined || value === null || value === "") return undefined;
    return readString(value, max);
}

function readStringArray(value: unknown, maxItems = 12, maxLength = 160): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => readString(item, maxLength))
        .filter((item): item is string => Boolean(item))
        .slice(0, maxItems);
}

function readPositiveInteger(value: unknown, min: number, max: number): number | null {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function formatAdminUser(user: {
    _id: unknown;
    name: string;
    email: string;
    phone?: string;
    avatarUrl?: string;
    role: "customer" | "admin";
    isBlocked?: boolean;
    emailVerified?: boolean;
    lastLoginAt?: Date;
    createdAt?: Date;
}) {
    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        ...(user.phone ? { phone: user.phone } : {}),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
        role: user.role,
        isBlocked: user.isBlocked === true,
        emailVerified: user.emailVerified === true,
        ...(user.lastLoginAt instanceof Date
            ? { lastLoginAt: user.lastLoginAt.toISOString() }
            : {}),
        ...(user.createdAt instanceof Date
            ? { createdAt: user.createdAt.toISOString() }
            : {}),
    };
}

function formatAdminService(service: ServiceFields & {
    _id: unknown;
    createdAt?: Date;
    updatedAt?: Date;
}) {
    return {
        id: String(service._id),
        title: service.title,
        description: service.description,
        ...(service.longDescription ? { longDescription: service.longDescription } : {}),
        price: service.price,
        ...(service.priceAmount ? { priceAmount: service.priceAmount } : {}),
        ...(service.duration ? { duration: service.duration } : {}),
        category: service.category,
        ...(service.image ? { image: service.image } : {}),
        featured: Boolean(service.featured),
        includes: service.includes ?? [],
        goodToKnow: service.goodToKnow ?? [],
        active: service.active !== false,
        ...(service.createdAt instanceof Date
            ? { createdAt: service.createdAt.toISOString() }
            : {}),
        ...(service.updatedAt instanceof Date
            ? { updatedAt: service.updatedAt.toISOString() }
            : {}),
    };
}

export async function getAdminDashboard(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }

        const today = new Date();
        const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        const [
            totalCustomers,
            activeServices,
            totalAppointments,
            appointmentGroups,
            successfulPayments,
            todayBookings,
            recentBookings,
            recentTransactions,
            categoryRows,
        ] = await Promise.all([
            User.countDocuments({ role: "customer" }),
            Service.countDocuments({ active: true }),
            Appointment.countDocuments({}),
            Appointment.aggregate<{ _id: string; count: number }>([
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),
            Transaction.countDocuments({
                paymentStatus: { $in: [...SETTLED_PAYMENT_STATUSES] },
            }),
            Appointment.countDocuments({
                date: todayString,
                status: { $in: ["pending", "confirmed", "completed"] },
            }),
            Appointment.find({})
                .sort({ createdAt: -1 })
                .limit(8)
                .lean(),
            Transaction.find({})
                .sort({ createdAt: -1 })
                .limit(8)
                .lean(),
            Service.aggregate<{ _id: string; count: number }>([
                { $match: { active: true } },
                { $group: { _id: "$category", count: { $sum: 1 } } },
            ]),
        ]);

        const byStatus = Object.fromEntries(
            appointmentGroups.map((row) => [row._id, row.count]),
        ) as Record<string, number>;
        const servicesByCategory = Object.fromEntries(
            categoryRows.map((row) => [row._id, row.count]),
        ) as Record<string, number>;

        res.status(200).json({
            success: true,
            data: {
                stats: {
                    totalCustomers,
                    activeServices,
                    totalAppointments,
                    pendingBookings: byStatus.pending ?? 0,
                    confirmedBookings: byStatus.confirmed ?? 0,
                    cancelledBookings: byStatus.cancelled ?? 0,
                    completedBookings: byStatus.completed ?? 0,
                    todayBookings,
                    successfulPayments,
                },
                recentBookings: recentBookings.map((appointment) =>
                    formatAppointment(appointment),
                ),
                recentTransactions: recentTransactions.map((transaction) =>
                    formatTransaction(transaction),
                ),
                servicesByCategory,
            },
        });
    } catch (error) {
        logFailure("Admin dashboard failed.", error);
        fail(res, 500, "Unable to load the admin dashboard right now.");
    }
}

export async function listAdminCustomers(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const filter: QueryFilter<UserFields> = { role: "customer" };
        if (search) {
            const pattern = new RegExp(escapeRegExp(search), "i");
            filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
        }

        const customers = await User.find(filter)
            .select("name email phone avatarUrl role isBlocked emailVerified lastLoginAt createdAt")
            .sort({ createdAt: -1 })
            .limit(300)
            .lean();
        const customerIds = customers.map((customer) => customer._id);
        const stats = customerIds.length
            ? await Appointment.aggregate<{
                  _id: mongoose.Types.ObjectId;
                  visits: number;
                  lastVisit: string | null;
              }>([
                  { $match: { customer: { $in: customerIds }, status: "completed" } },
                  {
                      $group: {
                          _id: "$customer",
                          visits: { $sum: 1 },
                          lastVisit: { $max: "$date" },
                      },
                  },
              ])
            : [];
        const statByCustomer = new Map(
            stats.map((row) => [String(row._id), row]),
        );

        res.status(200).json({
            success: true,
            data: customers.map((customer) => {
                const stat = statByCustomer.get(String(customer._id));
                return {
                    ...formatAdminUser(customer),
                    visits: stat?.visits ?? 0,
                    lastVisit: stat?.lastVisit ?? null,
                };
            }),
        });
    } catch (error) {
        logFailure("Admin customers lookup failed.", error);
        fail(res, 500, "Unable to load customers right now.");
    }
}

export async function getAdminCustomer(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const customerId = req.params.id;
        if (!isValidObjectId(customerId)) {
            fail(res, 404, "We could not find that customer.");
            return;
        }
        const customer = await User.findOne({ _id: customerId, role: "customer" })
            .select("name email phone avatarUrl role isBlocked emailVerified lastLoginAt createdAt")
            .lean();
        if (!customer) {
            fail(res, 404, "We could not find that customer.");
            return;
        }
        const [appointments, transactions] = await Promise.all([
            Appointment.find({ customer: customer._id })
                .sort({ date: -1, startMinutes: -1 })
                .limit(100)
                .lean(),
            Transaction.find({ customer: customer._id })
                .sort({ createdAt: -1 })
                .limit(100)
                .lean(),
        ]);
        res.status(200).json({
            success: true,
            data: {
                customer: formatAdminUser(customer),
                appointments: appointments.map((appointment) =>
                    formatAppointment(appointment),
                ),
                transactions: transactions.map((transaction) =>
                    formatTransaction(transaction),
                ),
            },
        });
    } catch (error) {
        logFailure("Admin customer lookup failed.", error);
        fail(res, 500, "Unable to load that customer right now.");
    }
}

export async function setCustomerBlocked(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const customerId = req.params.id;
        if (!isValidObjectId(customerId)) {
            fail(res, 404, "We could not find that customer.");
            return;
        }
        const body = asRecord(req.body);
        if (typeof body?.blocked !== "boolean") {
            fail(res, 400, "Choose whether to block or unblock this customer.");
            return;
        }
        if (String(customerId) === req.userId) {
            fail(res, 409, "You cannot block your own admin account.");
            return;
        }

        const customer = await User.findOne({ _id: customerId, role: "customer" });
        if (!customer) {
            fail(res, 404, "We could not find that customer.");
            return;
        }

        const reason = readOptionalString(body.reason, 300);
        if (reason === null) {
            fail(res, 400, "Block reason is invalid.");
            return;
        }
        if (body.blocked) {
            customer.isBlocked = true;
            customer.blockedAt = new Date();
            customer.blockedBy = new mongoose.Types.ObjectId(req.userId);
            customer.blockReason = reason ?? "";
            customer.tokenVersion = (customer.tokenVersion ?? 0) + 1;
            await customer.save();
        } else {
            customer.isBlocked = false;
            await User.updateOne(
                { _id: customer._id },
                {
                    $set: { isBlocked: false },
                    $unset: { blockedAt: 1, blockedBy: 1, blockReason: 1 },
                },
            );
        }

        res.status(200).json({
            success: true,
            data: formatAdminUser(customer),
        });
    } catch (error) {
        logFailure("Customer block update failed.", error);
        fail(res, 500, "Unable to update this customer right now.");
    }
}

export async function listAdminServices(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
        const active = typeof req.query.active === "string" ? req.query.active : "";
        const filter: QueryFilter<ServiceFields> = {};
        if ((SERVICE_CATEGORIES as readonly string[]).includes(category)) {
            filter.category = category as ServiceFields["category"];
        }
        if (active === "true" || active === "false") {
            filter.active = active === "true";
        }
        if (search) {
            const pattern = new RegExp(escapeRegExp(search), "i");
            filter.$or = [{ title: pattern }, { description: pattern }];
        }
        const services = await Service.find(filter)
            .sort({ active: -1, title: 1 })
            .lean();
        res.status(200).json({
            success: true,
            data: services.map((service) => formatAdminService(service)),
        });
    } catch (error) {
        logFailure("Admin services lookup failed.", error);
        fail(res, 500, "Unable to load services right now.");
    }
}

function readServicePayload(body: Record<string, unknown>) {
    const title = readString(body.title, 120);
    const description = readString(body.description, 500);
    const category = readString(body.category, 20);
    const priceAmount = readPositiveInteger(body.priceAmount, 1, 10_000_000);
    const durationMinutes = readPositiveInteger(body.durationMinutes, 5, 480);
    const price = readOptionalString(body.price, 40);
    const longDescription = readOptionalString(body.longDescription, 2000);
    const image = readOptionalString(body.image, 500);
    const featured = body.featured === true;
    const active = body.active === undefined ? true : body.active === true;
    const includes = readStringArray(body.includes);
    const goodToKnow = readStringArray(body.goodToKnow);

    if (!title || title.length < 2) return { error: "Service name is required." } as const;
    if (!description) return { error: "Service description is required." } as const;
    if (!(SERVICE_CATEGORIES as readonly string[]).includes(category ?? "")) {
        return { error: "Choose a valid service category." } as const;
    }
    if (priceAmount === null) {
        return { error: "Price must be a positive whole number." } as const;
    }
    if (durationMinutes === null) {
        return { error: "Duration must be a positive number of minutes." } as const;
    }
    return {
        value: {
            title,
            description,
            ...(longDescription ? { longDescription } : {}),
            price: price ?? `৳${priceAmount}`,
            priceAmount,
            duration: `${durationMinutes} min`,
            category: category as ServiceFields["category"],
            ...(image ? { image } : {}),
            featured,
            includes,
            goodToKnow,
            active,
        },
    } as const;
}

export async function createAdminService(
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
        const parsed = readServicePayload(body);
        if ("error" in parsed) {
            fail(res, 400, parsed.error);
            return;
        }
        const image = req.file
            ? `/uploads/services/${req.file.filename}`
            : parsed.value.image;
        const service = await Service.create({
            ...parsed.value,
            ...(image ? { image } : {}),
            createdBy: new mongoose.Types.ObjectId(req.userId),
            updatedBy: new mongoose.Types.ObjectId(req.userId),
        });
        res.status(201).json({ success: true, data: formatAdminService(service) });
    } catch (error) {
        logFailure("Admin service create failed.", error);
        fail(res, 500, "Unable to create this service right now.");
    }
}

export async function updateAdminService(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const serviceId = req.params.id;
        if (!isValidObjectId(serviceId)) {
            fail(res, 404, "We could not find that service.");
            return;
        }
        const existing = await Service.findById(serviceId).lean();
        if (!existing) {
            fail(res, 404, "We could not find that service.");
            return;
        }
        const body = asRecord(req.body);
        if (!body) {
            fail(res, 400, "A valid JSON body is required.");
            return;
        }

        const update: Record<string, unknown> = {};
        const title = body.title === undefined ? undefined : readString(body.title, 120);
        const description = body.description === undefined ? undefined : readString(body.description, 500);
        const longDescription = readOptionalString(body.longDescription, 2000);
        const price = readOptionalString(body.price, 40);
        const category = body.category === undefined ? undefined : readString(body.category, 20);
        const image = readOptionalString(body.image, 500);
        const includes = body.includes === undefined ? undefined : readStringArray(body.includes);
        const goodToKnow = body.goodToKnow === undefined ? undefined : readStringArray(body.goodToKnow);

        if (body.title !== undefined) {
            if (!title || title.length < 2) {
                fail(res, 400, "Service name must be at least 2 characters.");
                return;
            }
            update.title = title;
        }
        if (body.description !== undefined) {
            if (!description) {
                fail(res, 400, "Service description is required.");
                return;
            }
            update.description = description;
        }
        if (body.longDescription !== undefined) {
            if (longDescription === null) {
                fail(res, 400, "Long description is invalid.");
                return;
            }
            if (longDescription) update.longDescription = longDescription;
            else update.longDescription = "";
        }
        if (body.price !== undefined) {
            if (!price) {
                fail(res, 400, "Display price is invalid.");
                return;
            }
            update.price = price;
        }
        if (body.priceAmount !== undefined) {
            const priceAmount = readPositiveInteger(body.priceAmount, 1, 10_000_000);
            if (priceAmount === null) {
                fail(res, 400, "Price must be a positive whole number.");
                return;
            }
            update.priceAmount = priceAmount;
        }
        if (body.durationMinutes !== undefined) {
            const minutes = readPositiveInteger(body.durationMinutes, 5, 480);
            if (minutes === null) {
                fail(res, 400, "Duration must be a positive number of minutes.");
                return;
            }
            update.duration = `${minutes} min`;
        } else if (body.duration !== undefined) {
            const duration = readString(body.duration, 40);
            if (!duration) {
                fail(res, 400, "Duration is invalid.");
                return;
            }
            update.duration = duration;
        }
        if (body.category !== undefined) {
            if (!(SERVICE_CATEGORIES as readonly string[]).includes(category ?? "")) {
                fail(res, 400, "Choose a valid service category.");
                return;
            }
            update.category = category;
        }
        if (body.image !== undefined) {
            if (image === null) {
                fail(res, 400, "Service image is invalid.");
                return;
            }
            if (image) update.image = image;
            else update.image = "";
        }
        if (body.featured !== undefined) update.featured = body.featured === true;
        if (body.active !== undefined) update.active = body.active === true;
        if (includes !== undefined) update.includes = includes;
        if (goodToKnow !== undefined) update.goodToKnow = goodToKnow;
        if (req.file) update.image = `/uploads/services/${req.file.filename}`;

        if (Object.keys(update).length === 0) {
            fail(res, 400, "No service changes were provided.");
            return;
        }
        update.updatedBy = new mongoose.Types.ObjectId(req.userId);
        const updated = await Service.findByIdAndUpdate(serviceId, update, {
            new: true,
            runValidators: true,
        }).lean();
        if (!updated) {
            fail(res, 404, "We could not find that service.");
            return;
        }
        res.status(200).json({ success: true, data: formatAdminService(updated) });
    } catch (error) {
        logFailure("Admin service update failed.", error);
        fail(res, 500, "Unable to update this service right now.");
    }
}

export async function uploadAdminServiceImage(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const serviceId = req.params.id;
        if (!isValidObjectId(serviceId) || !req.file) {
            fail(res, 400, "Choose an image to upload.");
            return;
        }
        const updated = await Service.findByIdAndUpdate(
            serviceId,
            {
                image: `/uploads/services/${req.file.filename}`,
                updatedBy: new mongoose.Types.ObjectId(req.userId),
            },
            { new: true, runValidators: true },
        ).lean();
        if (!updated) {
            fail(res, 404, "We could not find that service.");
            return;
        }
        res.status(200).json({ success: true, data: formatAdminService(updated) });
    } catch (error) {
        logFailure("Admin service image upload failed.", error);
        fail(res, 500, "Unable to upload this service image right now.");
    }
}

export async function deleteAdminService(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const serviceId = req.params.id;
        if (!isValidObjectId(serviceId)) {
            fail(res, 404, "We could not find that service.");
            return;
        }
        const appointmentCount = await Appointment.countDocuments({ service: serviceId });
        if (appointmentCount > 0) {
            const deactivated = await Service.findByIdAndUpdate(
                serviceId,
                {
                    active: false,
                    updatedBy: new mongoose.Types.ObjectId(req.userId),
                },
                { new: true },
            ).lean();
            res.status(200).json({
                success: true,
                data: formatAdminService(deactivated!),
                message:
                    "This service has appointment history, so it was deactivated instead of deleted.",
            });
            return;
        }
        const deleted = await Service.findByIdAndDelete(serviceId).lean();
        if (!deleted) {
            fail(res, 404, "We could not find that service.");
            return;
        }
        res.status(200).json({ success: true, data: { id: String(deleted._id) } });
    } catch (error) {
        logFailure("Admin service delete failed.", error);
        fail(res, 500, "Unable to delete this service right now.");
    }
}
