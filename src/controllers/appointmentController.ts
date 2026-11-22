// SalonBook — appointment availability and booking endpoints.
//
// Every write is validated and re-checked against the database so a client can
// never create an overlapping, past, out-of-hours or duplicate appointment.

import type { Response } from "express";
import Appointment from "../models/Appointment";
import Service from "../models/Service";
import Transaction, { ACTIVE_PAYMENT_STATUSES } from "../models/Transaction";
import User from "../models/User";
import type { AuthRequest } from "../middleware/authMiddleware";
import {
    BOOKING_WINDOW,
    MAX_ADVANCE_DAYS,
    buildAvailableSlots,
    daysFromToday,
    hasStarted,
    isValidDateOnly,
    parseDurationMinutes,
    parseTimeLabel,
    type BusyInterval,
} from "../lib/booking";
import { formatAppointment } from "../lib/serializers";
import {
    asRecord,
    isDuplicateKeyError,
    isValidObjectId,
    isValidPhone,
} from "../lib/validation";

function fail(res: Response, status: number, message: string): void {
    res.status(status).json({ success: false, message });
}

function logFailure(action: string, error: unknown): void {
    console.error(action, {
        errorName: error instanceof Error ? error.name : "UnknownError",
    });
}

async function loadBusyIntervals(date: string): Promise<BusyInterval[]> {
    const appointments = await Appointment.find({
        date,
        status: { $in: ["pending", "confirmed"] },
    })
        .select("startMinutes endMinutes")
        .lean();

    return appointments.map((appointment) => ({
        startMinutes: appointment.startMinutes,
        endMinutes: appointment.endMinutes,
    }));
}

export async function getAvailability(req: AuthRequest, res: Response): Promise<void> {
    try {
        const serviceId =
            typeof req.query.serviceId === "string" ? req.query.serviceId : "";
        const date = typeof req.query.date === "string" ? req.query.date : "";

        if (!isValidObjectId(serviceId)) {
            fail(res, 400, "Select a valid service.");
            return;
        }
        if (!isValidDateOnly(date)) {
            fail(res, 400, "Select a valid appointment date.");
            return;
        }

        const daysAhead = daysFromToday(date);
        if (daysAhead < 0) {
            fail(res, 400, "Please choose today or a future appointment date.");
            return;
        }
        if (daysAhead > MAX_ADVANCE_DAYS) {
            fail(res, 400, `Appointments can be booked up to ${MAX_ADVANCE_DAYS} days ahead.`);
            return;
        }

        const service = await Service.findOne({ _id: serviceId, active: true }).lean();
        if (!service) {
            fail(res, 404, "We could not find that service.");
            return;
        }

        const durationMinutes = parseDurationMinutes(service.duration);
        const slots = buildAvailableSlots({
            durationMinutes,
            date,
            busy: await loadBusyIntervals(date),
        });

        res.status(200).json({
            success: true,
            serviceId,
            date,
            availableSlots: slots.map((slot) => slot.label),
        });
    } catch (error) {
        logFailure("Availability lookup failed.", error);
        fail(res, 500, "Unable to check availability right now.");
    }
}

export async function createAppointment(req: AuthRequest, res: Response): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to book an appointment.");
            return;
        }

        const body = asRecord(req.body);
        if (!body) {
            fail(res, 400, "A valid JSON body is required.");
            return;
        }

        const serviceId = body.serviceId;
        const date = body.date;
        const time = body.time;

        if (typeof serviceId !== "string" || !isValidObjectId(serviceId)) {
            fail(res, 400, "Select a valid service.");
            return;
        }
        if (typeof date !== "string" || !isValidDateOnly(date)) {
            fail(res, 400, "Select a valid appointment date.");
            return;
        }
        if (typeof time !== "string") {
            fail(res, 400, "Select an available appointment time.");
            return;
        }

        const startMinutes = parseTimeLabel(time);
        if (startMinutes === null) {
            fail(res, 400, "Select a valid appointment time.");
            return;
        }

        const daysAhead = daysFromToday(date);
        if (daysAhead < 0) {
            fail(res, 400, "Please choose today or a future appointment date.");
            return;
        }
        if (daysAhead > MAX_ADVANCE_DAYS) {
            fail(res, 400, `Appointments can be booked up to ${MAX_ADVANCE_DAYS} days ahead.`);
            return;
        }

        let notes: string | undefined;
        if (body.notes !== undefined) {
            if (typeof body.notes !== "string") {
                fail(res, 400, "Notes must be text.");
                return;
            }
            const trimmed = body.notes.trim();
            if (trimmed.length > 600) {
                fail(res, 400, "Notes must be 600 characters or fewer.");
                return;
            }
            if (trimmed) notes = trimmed;
        }

        let customerPhone: string | undefined;
        if (body.phone !== undefined) {
            if (typeof body.phone !== "string") {
                fail(res, 400, "Please enter a valid phone number.");
                return;
            }
            const trimmed = body.phone.trim();
            if (trimmed && !isValidPhone(trimmed)) {
                fail(res, 400, "Please enter a valid phone number.");
                return;
            }
            if (trimmed) customerPhone = trimmed;
        }

        const service = await Service.findOne({ _id: serviceId, active: true }).lean();
        if (!service) {
            fail(res, 404, "We could not find that service.");
            return;
        }

        const durationMinutes = parseDurationMinutes(service.duration);
        const endMinutes = startMinutes + durationMinutes;
        if (
            startMinutes < BOOKING_WINDOW.openMinutes ||
            endMinutes > BOOKING_WINDOW.closeMinutes
        ) {
            fail(res, 400, "That time is outside the salon's booking hours.");
            return;
        }

        // Re-validate against the live database at write time.
        const slots = buildAvailableSlots({
            durationMinutes,
            date,
            busy: await loadBusyIntervals(date),
        });
        const slot = slots.find((candidate) => candidate.startMinutes === startMinutes);
        if (!slot) {
            fail(res, 409, "That time is no longer available. Please choose another slot.");
            return;
        }

        const customer = await User.findById(req.userId).select("name email");
        if (!customer) {
            fail(res, 401, "Your session is no longer valid. Please sign in again.");
            return;
        }

        let appointment;
        try {
            appointment = await Appointment.create({
                customer: customer._id,
                service: service._id,
                serviceTitle: service.title,
                category: service.category,
                ...(service.duration ? { duration: service.duration } : {}),
                durationMinutes,
                ...(service.price ? { price: service.price } : {}),
                date,
                time: slot.label,
                startMinutes: slot.startMinutes,
                endMinutes: slot.endMinutes,
                status: "pending",
                customerName: customer.name,
                customerEmail: customer.email,
                ...(customerPhone ? { customerPhone } : {}),
                ...(notes ? { notes } : {}),
            });
        } catch (error) {
            if (isDuplicateKeyError(error)) {
                fail(res, 409, "That time is no longer available. Please choose another slot.");
                return;
            }
            throw error;
        }

        res.status(201).json({
            success: true,
            data: formatAppointment(appointment),
        });
    } catch (error) {
        logFailure("Appointment creation failed.", error);
        fail(res, 500, "Unable to create your appointment right now.");
    }
}

export async function cancelAppointment(req: AuthRequest, res: Response): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }

        const appointmentId = req.params.id;
        if (!isValidObjectId(appointmentId)) {
            fail(res, 404, "We could not find that appointment.");
            return;
        }

        const appointment = await Appointment.findOne({
            _id: appointmentId,
            customer: req.userId,
        });
        if (!appointment) {
            fail(res, 404, "We could not find that appointment.");
            return;
        }

        if (
            appointment.status !== "pending" &&
            appointment.status !== "confirmed"
        ) {
            fail(res, 409, "Only pending or confirmed appointments can be cancelled online.");
            return;
        }

        if ((appointment.paymentStatus ?? "unpaid") !== "unpaid") {
            fail(res, 409, "This appointment has a payment in progress or is already paid.");
            return;
        }

        const activePayment = await Transaction.exists({
            appointment: appointment._id,
            paymentStatus: { $in: [...ACTIVE_PAYMENT_STATUSES] },
        });
        if (activePayment) {
            fail(res, 409, "This appointment has a payment in progress and cannot be cancelled.");
            return;
        }

        if (hasStarted(appointment.date, appointment.startMinutes)) {
            fail(res, 409, "This appointment has already started and cannot be cancelled online.");
            return;
        }

        appointment.status = "cancelled";
        await appointment.save();

        res.status(200).json({
            success: true,
            data: formatAppointment(appointment),
        });
    } catch (error) {
        logFailure("Appointment cancellation failed.", error);
        fail(res, 500, "Unable to cancel this appointment right now.");
    }
}
