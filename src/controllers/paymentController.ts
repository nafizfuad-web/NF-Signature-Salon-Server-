// SalonBook — customer TEST payment endpoints.
//
// All payment methods in this phase are internal simulators. No real Stripe,
// bKash, or Nagad API is called and no real money is charged.

import type { Response } from "express";
import mongoose, { type ClientSession, type Types } from "mongoose";
import Appointment from "../models/Appointment";
import Transaction, {
    ACTIVE_PAYMENT_STATUSES,
    type TransactionFields,
} from "../models/Transaction";
import type { AuthRequest } from "../middleware/authMiddleware";
import {
    getPaymentConfig,
    getPaymentMethodsPayload,
    isPaymentMethodId,
    type PaymentMethodId,
} from "../config/payment";
import { formatAppointment, formatTransaction } from "../lib/serializers";
import {
    isPaymentStateError,
    settleTransactionFailure,
    settleTransactionSuccess,
    withPaymentTransactionIfSupported,
    type AppointmentLean,
    type TransactionLean,
} from "../lib/paymentState";
import {
    asRecord,
    isDuplicateKeyError,
    isValidObjectId,
} from "../lib/validation";

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
    return false;
}

function requireEnabledPayment(res: Response) {
    const config = getPaymentConfig();
    if (!config.enabled || config.amount === null) {
        fail(
            res,
            503,
            "TEST payments are disabled. Enable the simulator in a non-production TEST environment.",
        );
        return null;
    }
    return config;
}

async function findActiveTransaction(appointmentId: Types.ObjectId | string) {
    return (await Transaction.findOne({
        appointment: appointmentId,
        paymentStatus: { $in: [...ACTIVE_PAYMENT_STATUSES] },
    })
        .sort({ createdAt: -1 })
        .lean()) as TransactionLean | null;
}

export async function getPaymentMethods(
    _req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        res.status(200).json({ success: true, data: getPaymentMethodsPayload() });
    } catch (error) {
        logFailure("Payment methods lookup failed.", error);
        fail(res, 500, "Unable to load payment methods right now.");
    }
}

export async function createPaymentSession(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const config = requireEnabledPayment(res);
        if (!config) return;
        const demoAmount = config.amount;
        if (demoAmount === null) {
            fail(res, 503, "TEST demo amount is not configured.");
            return;
        }

        const appointmentId = req.params.appointmentId;
        if (!isValidObjectId(appointmentId)) {
            fail(res, 404, "We could not find that appointment.");
            return;
        }

        const body = asRecord(req.body);
        const method = body?.method;
        if (!isPaymentMethodId(method)) {
            fail(res, 400, "Select a valid TEST payment method.");
            return;
        }

        const appointment = (await Appointment.findOne({
            _id: appointmentId,
            customer: req.userId,
        }).lean()) as AppointmentLean | null;
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

        const existingActive = await findActiveTransaction(appointment._id);
        if (existingActive) {
            res.status(200).json({
                success: true,
                idempotentReplay: true,
                data: formatTransaction(existingActive),
            });
            return;
        }

        const transactionData: TransactionFields = {
            appointment: appointment._id,
            customer: appointment.customer,
            ...(appointment.service ? { service: appointment.service } : {}),
            serviceTitle: appointment.serviceTitle,
            appointmentDate: appointment.date,
            appointmentTime: appointment.time,
            ...(appointment.price ? { displayPrice: appointment.price } : {}),
            amount: demoAmount,
            currency: "BDT",
            amountBasis: "configured_test_demo",
            paymentMethod: method,
            provider: method === "pay_at_salon" ? "salon_cash" : "internal_simulator",
            providerReference: `demo_${method}_${new mongoose.Types.ObjectId().toHexString()}`,
            paymentStatus: method === "pay_at_salon" ? "cash_pending" : "pending",
            environment: "TEST",
            simulated: true,
            settlementState: "idle",
            settlementAttempts: 0,
            activeAppointmentId: appointment._id,
        };

        const created = await withPaymentTransactionIfSupported(
            async (session: ClientSession | null) => {
                const fresh = session
                    ? ((await Appointment.findById(appointment._id)
                          .session(session)
                          .lean()) as AppointmentLean | null)
                    : appointment;
                if (!fresh || fresh.status !== "confirmed") {
                    throw new Error("appointment_not_confirmed");
                }
                if ((fresh.paymentStatus ?? "unpaid") === "paid") {
                    throw new Error("appointment_already_paid");
                }

                const transaction = (session
                    ? await new Transaction(transactionData).save({ session })
                    : await Transaction.create(transactionData)) as unknown as TransactionFields & {
                    _id: Types.ObjectId;
                };

                const updated = (await Appointment.findOneAndUpdate(
                    {
                        _id: appointment._id,
                        status: "confirmed",
                        paymentStatus: { $ne: "paid" },
                    },
                    {
                        $set: {
                            paymentStatus: "pending",
                            paymentMethod: method,
                            latestTransactionId: transaction._id,
                        },
                        $unset: { paidAt: 1 },
                    },
                    {
                        new: true,
                        lean: true,
                        ...(session ? { session } : {}),
                    },
                )) as AppointmentLean | null;

                if (!updated) {
                    throw new Error("appointment_state_conflict");
                }

                return transaction as unknown as TransactionLean;
            },
        );

        res.status(201).json({
            success: true,
            idempotentReplay: false,
            data: formatTransaction(created),
        });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            const appointmentId = req.params.appointmentId;
            const replay = isValidObjectId(appointmentId)
                ? await findActiveTransaction(appointmentId)
                : null;
            if (replay) {
                res.status(200).json({
                    success: true,
                    idempotentReplay: true,
                    data: formatTransaction(replay),
                });
                return;
            }
        }
        if (handlePaymentError(res, error)) return;
        if (error instanceof Error && error.message === "appointment_not_confirmed") {
            fail(res, 409, "Only confirmed appointments can be paid.");
            return;
        }
        if (error instanceof Error && error.message === "appointment_already_paid") {
            fail(res, 409, "This appointment is already paid.");
            return;
        }
        if (error instanceof Error && error.message === "appointment_state_conflict") {
            fail(res, 409, "The appointment payment state changed. Please try again.");
            return;
        }
        logFailure("Payment session creation failed.", error);
        fail(res, 500, "Unable to start TEST payment right now.");
    }
}

export async function getAppointmentPayment(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
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
        }).lean()) as AppointmentLean | null;
        if (!appointment) {
            fail(res, 404, "We could not find that appointment.");
            return;
        }
        const transaction = (await Transaction.findOne({
            appointment: appointment._id,
        })
            .sort({ createdAt: -1 })
            .lean()) as TransactionLean | null;

        res.status(200).json({
            success: true,
            data: {
                appointment: formatAppointment(appointment),
                transaction: transaction ? formatTransaction(transaction) : null,
                payment: {
                    status: appointment.paymentStatus ?? "unpaid",
                    ...(appointment.paymentMethod
                        ? { method: appointment.paymentMethod }
                        : {}),
                    ...(appointment.paidAt instanceof Date
                        ? { paidAt: appointment.paidAt.toISOString() }
                        : {}),
                },
            },
        });
    } catch (error) {
        logFailure("Appointment payment lookup failed.", error);
        fail(res, 500, "Unable to load payment status right now.");
    }
}

export async function getMyTransactions(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const transactions = (await Transaction.find({ customer: req.userId })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean()) as unknown as TransactionLean[];
        res.status(200).json({
            success: true,
            data: transactions.map((transaction) =>
                formatTransaction(transaction),
            ),
        });
    } catch (error) {
        logFailure("Customer transactions lookup failed.", error);
        fail(res, 500, "Unable to load payment history right now.");
    }
}

export async function simulatePayment(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        if (!requireEnabledPayment(res)) return;

        const transactionId = req.params.transactionId;
        if (!isValidObjectId(transactionId)) {
            fail(res, 404, "We could not find that payment.");
            return;
        }
        const body = asRecord(req.body);
        const outcome = body?.outcome;
        if (outcome !== "success" && outcome !== "failed" && outcome !== "cancelled") {
            fail(res, 400, "Choose a valid simulated outcome.");
            return;
        }

        const existing = (await Transaction.findById(transactionId).lean()) as
            | TransactionLean
            | null;
        if (!existing || String(existing.customer) !== req.userId) {
            fail(res, 404, "We could not find that payment.");
            return;
        }

        const result =
            outcome === "success"
                ? await settleTransactionSuccess({
                      transactionId,
                      finalStatus: "succeeded",
                      requireMethod: existing.paymentMethod as PaymentMethodId,
                      allowedActiveStatuses: ["pending", "processing"],
                  })
                : await settleTransactionFailure({
                      transactionId,
                      outcome,
                      failureReason:
                          outcome === "failed"
                              ? "simulated_failure"
                              : "simulated_cancelled",
                  });

        res.status(200).json({
            success: true,
            idempotentReplay: result.idempotentReplay,
            data: {
                transaction: formatTransaction(result.transaction),
                appointment: formatAppointment(result.appointment),
            },
        });
    } catch (error) {
        if (handlePaymentError(res, error)) return;
        logFailure("Payment simulation failed.", error);
        fail(res, 500, "Unable to simulate TEST payment right now.");
    }
}
