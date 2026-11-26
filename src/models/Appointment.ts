// SalonBook — appointment model.
//
// Service details are denormalized onto the appointment so history stays
// readable even if a service is later edited or deactivated. The unique partial
// index prevents two active appointments from starting at the same minute.

import mongoose, { Schema, type Model, type Types } from "mongoose";
import {
    PAYMENT_METHOD_IDS,
    type PaymentMethodId,
} from "../config/payment";

export const APPOINTMENT_STATUSES = [
    "pending",
    "confirmed",
    "cancelled",
    "completed",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export interface AppointmentFields {
    customer: Types.ObjectId;
    service: Types.ObjectId;
    serviceTitle: string;
    category: string;
    duration?: string;
    durationMinutes: number;
    price?: string;
    /** Denormalized BDT amount captured at booking time for payments. */
    priceAmount?: number;
    date: string;
    time: string;
    startMinutes: number;
    endMinutes: number;
    status: AppointmentStatus;
    staffName?: string;
    notes?: string;
    customerName: string;
    customerEmail: string;
    customerPhone?: string;
    paymentStatus?: "unpaid" | "pending" | "paid";
    paymentMethod?: PaymentMethodId;
    paidAt?: Date;
    latestTransactionId?: Types.ObjectId;
}

const appointmentSchema = new Schema<AppointmentFields>(
    {
        customer: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        service: {
            type: Schema.Types.ObjectId,
            ref: "Service",
            required: true,
        },
        serviceTitle: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        category: {
            type: String,
            required: true,
            trim: true,
            maxlength: 20,
        },
        duration: {
            type: String,
            trim: true,
            maxlength: 40,
        },
        durationMinutes: {
            type: Number,
            required: true,
            min: 15,
            max: 480,
        },
        price: {
            type: String,
            trim: true,
            maxlength: 40,
        },
        priceAmount: {
            type: Number,
            min: 1,
            max: 10_000_000,
        },
        date: {
            type: String,
            required: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
            index: true,
        },
        time: {
            type: String,
            required: true,
            trim: true,
            maxlength: 20,
        },
        startMinutes: {
            type: Number,
            required: true,
            min: 0,
            max: 1439,
        },
        endMinutes: {
            type: Number,
            required: true,
            min: 1,
            max: 1440,
        },
        status: {
            type: String,
            enum: APPOINTMENT_STATUSES,
            default: "pending",
            index: true,
        },
        staffName: {
            type: String,
            trim: true,
            maxlength: 80,
        },
        notes: {
            type: String,
            trim: true,
            maxlength: 600,
        },
        customerName: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100,
        },
        customerEmail: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            maxlength: 254,
        },
        customerPhone: {
            type: String,
            trim: true,
            maxlength: 40,
        },
        paymentStatus: {
            type: String,
            enum: ["unpaid", "pending", "paid"],
        },
        paymentMethod: {
            type: String,
            enum: PAYMENT_METHOD_IDS,
        },
        paidAt: {
            type: Date,
        },
        latestTransactionId: {
            type: Schema.Types.ObjectId,
            ref: "Transaction",
        },
    },
    { timestamps: true, versionKey: false },
);

appointmentSchema.index({ customer: 1, date: -1, startMinutes: -1 });
appointmentSchema.index({ customer: 1, status: 1, date: 1 });
appointmentSchema.index(
    { date: 1, startMinutes: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ["pending", "confirmed"] } },
    },
);

const Appointment: Model<AppointmentFields> =
    (mongoose.models.Appointment as Model<AppointmentFields> | undefined) ??
    mongoose.model<AppointmentFields>("Appointment", appointmentSchema);

export default Appointment;
