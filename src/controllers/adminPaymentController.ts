// SalonBook — admin TEST payment endpoints.
//
// These endpoints expose simulated TEST transactions only. They never compute
// or expose real revenue and cannot mark gateway/demo payments as received.

import type { Response } from "express";
import Appointment from "../models/Appointment";
import Transaction, {
    ACTIVE_PAYMENT_STATUSES,
    SETTLED_PAYMENT_STATUSES,
    type TransactionFields,
} from "../models/Transaction";
import type { AuthRequest } from "../middleware/authMiddleware";
import { formatAppointment, formatTransaction } from "../lib/serializers";
import {
    isPaymentStateError,
    settleTransactionSuccess,
    type AppointmentLean,
    type TransactionLean,
} from "../lib/paymentState";
import { isValidObjectId } from "../lib/validation";

function fail(res: Response, status: number, message: string): void {
    res.status(status).json({ success: false, message });
}

function logFailure(action: string, error: unknown): void {
    console.error(action, {
        errorName: error instanceof Error ? error.name : "UnknownError",
    });
}

export async function listAdminPayments(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 100, 1),
            200,
        );
        const transactions = (await Transaction.find({
            environment: "TEST",
            simulated: true,
        })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean()) as unknown as TransactionLean[];

        const byStatus: Record<string, number> = {};
        let settledCount = 0;
        let settledAmount = 0;
        for (const transaction of transactions) {
            byStatus[transaction.paymentStatus] =
                (byStatus[transaction.paymentStatus] ?? 0) + 1;
            if (
                (SETTLED_PAYMENT_STATUSES as readonly string[]).includes(
                    transaction.paymentStatus,
                )
            ) {
                settledCount += 1;
                settledAmount += transaction.amount;
            }
        }

        res.status(200).json({
            success: true,
            data: {
                scope: "TEST_SIMULATED",
                stats: {
                    transactionCount: transactions.length,
                    byStatus,
                    settledCount,
                    testSimulatedAmountTotal: settledAmount,
                    currency: "BDT",
                    realRevenueAmount: 0,
                },
                transactions: transactions.map((transaction) =>
                    formatTransaction(transaction),
                ),
            },
        });
    } catch (error) {
        logFailure("Admin payments lookup failed.", error);
        fail(res, 500, "Unable to load TEST payments right now.");
    }
}

export async function confirmCashReceived(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const transactionId = req.params.transactionId;
        if (!isValidObjectId(transactionId)) {
            fail(res, 404, "We could not find that payment.");
            return;
        }

        const existing = (await Transaction.findById(transactionId).lean()) as
            | TransactionLean
            | null;
        if (!existing) {
            fail(res, 404, "We could not find that payment.");
            return;
        }
        if (existing.paymentMethod !== "pay_at_salon") {
            fail(
                res,
                409,
                "Only Pay at Salon payments can be confirmed as cash received.",
            );
            return;
        }
        if (existing.paymentStatus === "cash_received") {
            const appointment = (await Appointment.findById(
                existing.appointment,
            ).lean()) as unknown as AppointmentLean | null;
            res.status(200).json({
                success: true,
                idempotentReplay: true,
                data: {
                    transaction: formatTransaction(existing),
                    appointment: appointment ? formatAppointment(appointment) : null,
                },
            });
            return;
        }
        if (!(ACTIVE_PAYMENT_STATUSES as readonly string[]).includes(existing.paymentStatus)) {
            fail(res, 409, "This payment is not awaiting cash confirmation.");
            return;
        }

        const result = await settleTransactionSuccess({
            transactionId,
            actorUserId: req.userId,
            finalStatus: "cash_received",
            requireMethod: "pay_at_salon",
            allowedActiveStatuses: ["cash_pending"],
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
        if (isPaymentStateError(error)) {
            fail(res, error.status, error.message);
            return;
        }
        logFailure("Cash confirmation failed.", error);
        fail(res, 500, "Unable to confirm cash payment right now.");
    }
}
