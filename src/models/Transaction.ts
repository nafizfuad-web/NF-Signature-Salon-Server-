import mongoose, { Schema, type Model, type Types } from "mongoose";
import { PAYMENT_METHOD_IDS, type PaymentMethodId } from "../config/payment";

export const PAYMENT_STATUSES = [
    "pending",
    "processing",
    "succeeded",
    "failed",
    "cancelled",
    "cash_pending",
    "cash_received",
    "refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ACTIVE_PAYMENT_STATUSES = [
    "pending",
    "processing",
    "cash_pending",
] as const satisfies readonly PaymentStatus[];

export const SETTLED_PAYMENT_STATUSES = [
    "succeeded",
    "cash_received",
] as const satisfies readonly PaymentStatus[];

export const TERMINAL_PAYMENT_STATUSES = [
    "failed",
    "cancelled",
    "refunded",
] as const satisfies readonly PaymentStatus[];

export const SETTLEMENT_STATES = [
    "idle",
    "in_progress",
    "committed",
    "aborted",
] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

export const SIMULATION_OUTCOMES = ["success", "failed", "cancelled"] as const;
export type SimulationOutcome = (typeof SIMULATION_OUTCOMES)[number];

export const PAYMENT_PROVIDERS = [
    "internal_simulator",
    "salon_cash",
    "stripe",
    "bkash",
    "nagad",
] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const AMOUNT_BASES = [
    "configured_test_demo",
    "service_price",
] as const;
export type AmountBasis = (typeof AMOUNT_BASES)[number];

export interface TransactionFields {
    appointment: Types.ObjectId;
    customer: Types.ObjectId;
    service?: Types.ObjectId;
    serviceTitle: string;
    appointmentDate: string;
    appointmentTime: string;
    displayPrice?: string;
    amount: number;
    currency: "BDT";
    amountBasis: AmountBasis;
    paymentMethod: PaymentMethodId;
    provider: PaymentProvider;
    providerReference: string;
    providerSessionId?: string;
    providerPaymentIntentId?: string;
    providerEventId?: string;
    checkoutUrl?: string;
    providerVerifiedAt?: Date;
    paymentStatus: PaymentStatus;
    environment: "TEST" | "LIVE";
    simulated: boolean;
    simulationOutcome?: SimulationOutcome;
    failureReason?: string;
    settlementState: SettlementState;
    settlementOutcome?: SimulationOutcome;
    settlementStartedAt?: Date;
    settlementAttempts: number;
    lastSettlementError?: string;
    reconcileClaimedBy?: string;
    reconcileLeaseUntil?: Date;
    reconcileAttempts?: number;
    lastReconcileAt?: Date;
    lastReconcileError?: string;
    cashConfirmedBy?: Types.ObjectId;
    cashConfirmedAt?: Date;
    refundedAmount?: number;
    refundedAt?: Date;
    refundedBy?: Types.ObjectId;
    refundReason?: string;
    paidAt?: Date;
    activeAppointmentId?: Types.ObjectId;
    settledAppointmentId?: Types.ObjectId;
}

const transactionSchema = new Schema<TransactionFields>(
    {
        appointment: {
            type: Schema.Types.ObjectId,
            ref: "Appointment",
            required: true,
        },
        customer: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        service: {
            type: Schema.Types.ObjectId,
            ref: "Service",
        },
        serviceTitle: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        appointmentDate: {
            type: String,
            required: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
        },
        appointmentTime: {
            type: String,
            required: true,
            trim: true,
            maxlength: 20,
        },
        displayPrice: {
            type: String,
            trim: true,
            maxlength: 40,
        },
        amount: {
            type: Number,
            required: true,
            min: 0,
        },
        currency: {
            type: String,
            enum: ["BDT"],
            required: true,
            default: "BDT",
        },
        amountBasis: {
            type: String,
            enum: AMOUNT_BASES,
            required: true,
        },
        paymentMethod: {
            type: String,
            enum: PAYMENT_METHOD_IDS,
            required: true,
        },
        provider: {
            type: String,
            enum: PAYMENT_PROVIDERS,
            required: true,
        },
        providerReference: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            maxlength: 160,
        },
        providerSessionId: {
            type: String,
            trim: true,
            maxlength: 200,
        },
        providerPaymentIntentId: {
            type: String,
            trim: true,
            maxlength: 200,
        },
        providerEventId: {
            type: String,
            trim: true,
            maxlength: 200,
        },
        checkoutUrl: {
            type: String,
            trim: true,
            maxlength: 2000,
        },
        providerVerifiedAt: {
            type: Date,
        },
        paymentStatus: {
            type: String,
            enum: PAYMENT_STATUSES,
            required: true,
            default: "pending",
        },
        environment: {
            type: String,
            enum: ["TEST", "LIVE"],
            required: true,
            default: "TEST",
        },
        simulated: {
            type: Boolean,
            required: true,
            default: false,
        },
        simulationOutcome: {
            type: String,
            enum: SIMULATION_OUTCOMES,
        },
        failureReason: {
            type: String,
            trim: true,
            maxlength: 300,
        },
        settlementState: {
            type: String,
            enum: SETTLEMENT_STATES,
            required: true,
            default: "idle",
        },
        settlementOutcome: {
            type: String,
            enum: SIMULATION_OUTCOMES,
        },
        settlementStartedAt: {
            type: Date,
        },
        settlementAttempts: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },
        lastSettlementError: {
            type: String,
            trim: true,
            maxlength: 300,
        },
        reconcileClaimedBy: {
            type: String,
            trim: true,
            maxlength: 120,
        },
        reconcileLeaseUntil: {
            type: Date,
        },
        reconcileAttempts: {
            type: Number,
            default: 0,
            min: 0,
        },
        lastReconcileAt: {
            type: Date,
        },
        lastReconcileError: {
            type: String,
            trim: true,
            maxlength: 300,
        },
        cashConfirmedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
        cashConfirmedAt: {
            type: Date,
        },
        refundedAmount: {
            type: Number,
            min: 0,
        },
        refundedAt: {
            type: Date,
        },
        refundedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
        refundReason: {
            type: String,
            trim: true,
            maxlength: 300,
        },
        paidAt: {
            type: Date,
        },
        activeAppointmentId: {
            type: Schema.Types.ObjectId,
            ref: "Appointment",
        },
        settledAppointmentId: {
            type: Schema.Types.ObjectId,
            ref: "Appointment",
        },
    },
    { timestamps: true, versionKey: false },
);

transactionSchema.index({ appointment: 1, createdAt: -1 });
transactionSchema.index({ customer: 1, createdAt: -1 });
transactionSchema.index({ environment: 1, paymentStatus: 1 });
transactionSchema.index({ paymentMethod: 1, paymentStatus: 1 });
transactionSchema.index({ provider: 1, paymentStatus: 1 });
transactionSchema.index({ settlementState: 1, settlementStartedAt: 1 });
transactionSchema.index({ reconcileLeaseUntil: 1 });
transactionSchema.index(
    { activeAppointmentId: 1 },
    { unique: true, sparse: true },
);
transactionSchema.index(
    { settledAppointmentId: 1 },
    { unique: true, sparse: true },
);

const Transaction: Model<TransactionFields> =
    (mongoose.models.Transaction as Model<TransactionFields> | undefined) ??
    mongoose.model<TransactionFields>("Transaction", transactionSchema);

export default Transaction;
