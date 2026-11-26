// SalonBook — bKash Checkout (URL) sandbox controller.
//
// Creates server-side bKash checkout sessions and handles bKash's browser
// callback. Payment success is only applied after the server verifies the
// payment with bKash execute/query APIs; callback query parameters are never
// trusted by themselves.

import type { Request, Response } from "express";
import mongoose, { type Types } from "mongoose";
import Appointment from "../models/Appointment";
import Service from "../models/Service";
import Transaction from "../models/Transaction";
import AuditLog from "../models/AuditLog";
import type { AuthRequest } from "../middleware/authMiddleware";
import { getServerConfig } from "../config/env";
import { formatAppointment, formatTransaction } from "../lib/serializers";
import {
    isPaymentStateError,
    settleTransactionSuccess,
    type AppointmentLean,
    type TransactionLean,
} from "../lib/paymentState";
import {
    isDuplicateKeyError,
    isValidObjectId,
} from "../lib/validation";
import {
    BkashAdapterError,
    createBkashCheckout,
    verifyBkashPayment,
} from "../lib/bkash";

function fail(res: Response, status: number, message: string): void {
    res.status(status).json({ success: false, message });
}

function logFailure(action: string, error: unknown): void {
    console.error(action, {
        errorName: error instanceof Error ? error.name : "UnknownError",
    });
}

function handlePaymentError(res: Response, error: unknown): boolean {
    if (isPaymentStateError(error)) {
        fail(res, error.status, error.message);
        return true;
    }
    if (error instanceof BkashAdapterError) {
        fail(res, error.status, "Unable to complete bKash payment right now.");
        return true;
    }
    return false;
}

async function loadActiveTransaction(
    appointmentId: Types.ObjectId | string,
): Promise<TransactionLean | null> {
    return (await Transaction.findOne({
        appointment: appointmentId,
        paymentStatus: { $in: ["pending", "processing"] },
    })
        .sort({ createdAt: -1 })
        .lean()) as TransactionLean | null;
}

function clientPaymentUrl(path: string, params: Record<string, string>): string {
    const config = getServerConfig();
    const url = new URL(path, config.clientOrigin);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    return url.toString();
}

// POST /api/payments/bkash/appointments/:appointmentId/session
export async function createBkashCheckoutSession(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }

        const config = getServerConfig();
        if (!config.bkash) {
            fail(res, 503, "bKash is not configured on this server.");
            return;
        }

        const appointmentId = req.params.appointmentId;
        if (!isValidObjectId(appointmentId)) {
            fail(res, 404, "We could not find that appointment.");
            return;
        }

        const appointment = (await Appointment.findOne({
            _id: appointmentId,
            customer: req.userId,
        }).lean()) as {
            _id: Types.ObjectId;
            customer: Types.ObjectId;
            service?: Types.ObjectId;
            serviceTitle: string;
            category?: string;
            date: string;
            time: string;
            price?: string;
            priceAmount?: number;
            status: string;
            paymentStatus?: string;
        } | null;
        if (!appointment) {
            fail(res, 404, "We could not find that appointment.");
            return;
        }
        if (appointment.status !== "confirmed") {
            fail(res, 409, "Only confirmed appointments can be paid.");
            return;
        }
        if ((appointment.paymentStatus ?? "unpaid") === "paid") {
            fail(res, 409, "This appointment is already paid.");
            return;
        }

        const existingActive = await loadActiveTransaction(appointment._id);
        if (existingActive) {
            res.status(200).json({
                success: true,
                idempotentReplay: true,
                data: {
                    transaction: formatTransaction(existingActive),
                    checkoutUrl: existingActive.checkoutUrl ?? null,
                    paymentId: existingActive.providerSessionId ?? null,
                },
            });
            return;
        }

        let amount = appointment.priceAmount ?? 0;
        if (!amount && appointment.service) {
            const service = (await Service.findById(appointment.service)
                .select("priceAmount")
                .lean()) as { priceAmount?: number } | null;
            amount = service?.priceAmount ?? 0;
        }
        if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
            fail(res, 409, "This appointment has no chargeable BDT amount.");
            return;
        }

        const merchantInvoiceNumber = `bkash_${appointment._id}_${new mongoose.Types.ObjectId().toHexString()}`;
        const transactionData = {
            appointment: appointment._id,
            customer: appointment.customer,
            ...(appointment.service ? { service: appointment.service } : {}),
            serviceTitle: appointment.serviceTitle,
            appointmentDate: appointment.date,
            appointmentTime: appointment.time,
            ...(appointment.price ? { displayPrice: appointment.price } : {}),
            amount,
            currency: "BDT" as const,
            amountBasis: "service_price" as const,
            paymentMethod: "bkash" as const,
            provider: "bkash" as const,
            providerReference: merchantInvoiceNumber,
            paymentStatus: "pending" as const,
            environment: "TEST" as const,
            simulated: false,
            settlementState: "idle" as const,
            settlementAttempts: 0,
            activeAppointmentId: appointment._id,
        } as unknown as Parameters<typeof Transaction.create>[0];

        const created = await Transaction.create(transactionData);
        const createdId = (created as { _id: Types.ObjectId })._id;

        const payableAppointment = await Appointment.findOneAndUpdate(
            {
                _id: appointment._id,
                status: "confirmed",
                paymentStatus: { $ne: "paid" },
            },
            {
                $set: {
                    paymentStatus: "pending",
                    paymentMethod: "bkash",
                    latestTransactionId: createdId,
                },
                $unset: { paidAt: 1 },
            },
            { new: true, lean: true },
        );
        if (!payableAppointment) {
            await Transaction.updateOne(
                { _id: createdId, paymentStatus: "pending" },
                {
                    $set: {
                        paymentStatus: "cancelled",
                        settlementState: "committed",
                        settlementOutcome: "cancelled",
                        failureReason: "appointment_no_longer_payable",
                    },
                    $unset: { activeAppointmentId: 1 },
                },
            );
            fail(res, 409, "This appointment is no longer payable.");
            return;
        }

        let checkout;
        try {
            checkout = await createBkashCheckout({
                appointmentId: String(appointment._id),
                merchantInvoiceNumber,
                amount,
                callbackUrl: config.bkash.callbackUrl,
                payerReference: `customer_${req.userId}`,
            });
        } catch (error) {
            await Transaction.updateOne(
                { _id: createdId, paymentStatus: "pending" },
                {
                    $set: {
                        paymentStatus: "failed",
                        settlementState: "committed",
                        settlementOutcome: "failed",
                        failureReason: "bkash_checkout_creation_failed",
                    },
                    $unset: { activeAppointmentId: 1 },
                },
            );
            await Appointment.updateOne(
                {
                    _id: appointment._id,
                    status: "confirmed",
                    paymentStatus: "pending",
                    latestTransactionId: createdId,
                },
                {
                    $set: { paymentStatus: "unpaid" },
                    $unset: { paymentMethod: 1, paidAt: 1 },
                },
            );
            throw error;
        }

        const updated = (await Transaction.findByIdAndUpdate(
            createdId,
            {
                $set: {
                    providerSessionId: checkout.paymentId,
                    checkoutUrl: checkout.checkoutUrl,
                },
            },
            { new: true, lean: true },
        )) as TransactionLean | null;

        res.status(201).json({
            success: true,
            idempotentReplay: false,
            data: {
                transaction: formatTransaction(updated ?? created),
                checkoutUrl: checkout.checkoutUrl,
                paymentId: checkout.paymentId,
            },
        });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            const appointmentId = req.params.appointmentId;
            const replay = isValidObjectId(appointmentId)
                ? await loadActiveTransaction(appointmentId)
                : null;
            if (replay) {
                res.status(200).json({
                    success: true,
                    idempotentReplay: true,
                    data: {
                        transaction: formatTransaction(replay),
                        checkoutUrl: replay.checkoutUrl ?? null,
                        paymentId: replay.providerSessionId ?? null,
                    },
                });
                return;
            }
        }
        if (handlePaymentError(res, error)) return;
        logFailure("bKash checkout session creation failed.", error);
        fail(res, 500, "Unable to create bKash checkout session right now.");
    }
}

async function closeProviderPayment(
    transaction: TransactionLean,
    outcome: "failed" | "cancelled",
    reason: string,
): Promise<void> {
    await Transaction.updateOne(
        {
            _id: transaction._id,
            paymentStatus: { $in: ["pending", "processing"] },
        },
        {
            $set: {
                paymentStatus: outcome,
                settlementState: "committed",
                settlementOutcome: outcome,
                simulationOutcome: outcome,
                failureReason: reason,
            },
            $unset: { activeAppointmentId: 1 },
        },
    );
    await Appointment.updateOne(
        {
            _id: transaction.appointment,
            status: "confirmed",
            paymentStatus: "pending",
            latestTransactionId: transaction._id,
        },
        {
            $set: { paymentStatus: "unpaid" },
            $unset: { paymentMethod: 1, paidAt: 1 },
        },
    );
}

// GET /api/payments/bkash/callback — public bKash browser redirect.
export async function bkashCallback(
    req: Request,
    res: Response,
): Promise<void> {
    const paymentId = typeof req.query.paymentID === "string" ? req.query.paymentID : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";

    const transaction = paymentId
        ? ((await Transaction.findOne({
              providerSessionId: paymentId,
              provider: "bkash",
          }).lean()) as TransactionLean | null)
        : null;

    if (!transaction) {
        res.redirect(
            clientPaymentUrl("/payment/cancel", {
                provider: "bkash",
                reason: "unknown_payment",
            }),
        );
        return;
    }

    if (status === "success") {
        try {
            const verified = await verifyBkashPayment({
                paymentId,
                expectedAmount: transaction.amount,
                expectedInvoice: transaction.providerReference,
            });
            await Transaction.updateOne(
                { _id: transaction._id },
                {
                    $set: {
                        providerPaymentIntentId: verified.trxId,
                        providerVerifiedAt: verified.verifiedAt,
                        providerEventId: `bkash_callback_${paymentId}`,
                    },
                },
            );
            await settleTransactionSuccess({
                transactionId: String(transaction._id),
                actorUserId: String(transaction.customer),
                finalStatus: "succeeded",
                requireMethod: "bkash",
                allowedActiveStatuses: ["pending", "processing"],
            });
            await AuditLog.create({
                actor: transaction.customer,
                action: "bkash_payment_succeeded",
                entityType: "transaction",
                entityId: String(transaction._id),
                metadata: {
                    appointmentId: String(transaction.appointment),
                    amount: transaction.amount,
                    currency: transaction.currency,
                    bkashPaymentId: paymentId,
                    trxId: verified.trxId,
                },
            });
            res.redirect(
                clientPaymentUrl("/payment/success", {
                    provider: "bkash",
                    session_id: paymentId,
                }),
            );
            return;
        } catch (error) {
            logFailure("bKash callback verification failed.", error);
            if (error instanceof BkashAdapterError && error.status === 409) {
                await closeProviderPayment(transaction, "failed", "bkash_verification_failed");
            }
            res.redirect(
                clientPaymentUrl("/payment/cancel", {
                    provider: "bkash",
                    session_id: paymentId,
                    reason: "verification_failed",
                }),
            );
            return;
        }
    }

    const outcome = status === "cancel" || status === "cancelled" ? "cancelled" : "failed";
    await closeProviderPayment(
        transaction,
        outcome,
        `bkash_callback_${status || "unknown"}`,
    );
    res.redirect(
        clientPaymentUrl("/payment/cancel", {
            provider: "bkash",
            session_id: paymentId,
            reason: outcome,
        }),
    );
}

// GET /api/payments/bkash/payments/:paymentId
export async function getBkashPaymentStatus(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const paymentId = req.params.paymentId;
        if (typeof paymentId !== "string" || !paymentId.trim()) {
            fail(res, 404, "We could not find that payment.");
            return;
        }

        const transaction = (await Transaction.findOne({
            providerSessionId: paymentId,
            provider: "bkash",
            customer: req.userId,
        }).lean()) as TransactionLean | null;
        if (!transaction) {
            fail(res, 404, "We could not find that payment.");
            return;
        }

        const appointment = (await Appointment.findById(transaction.appointment).lean()) as
            | AppointmentLean
            | null;

        res.status(200).json({
            success: true,
            data: {
                transaction: formatTransaction(transaction),
                appointment: appointment ? formatAppointment(appointment) : null,
                payment: {
                    status: appointment?.paymentStatus ?? "unpaid",
                    ...(appointment?.paymentMethod
                        ? { method: appointment.paymentMethod }
                        : {}),
                    ...(appointment?.paidAt instanceof Date
                        ? { paidAt: appointment.paidAt.toISOString() }
                        : {}),
                },
            },
        });
    } catch (error) {
        logFailure("bKash payment status lookup failed.", error);
        fail(res, 500, "Unable to load bKash payment status right now.");
    }
}
