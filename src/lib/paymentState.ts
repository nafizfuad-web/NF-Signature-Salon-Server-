// SalonBook — TEST payment state transitions and settlement helpers.
//
// Settlement is intentionally conservative: MongoDB transactions are used when
// the deployment supports them, and a durable claim/finalize fallback is used
// otherwise. TEST/simulated transactions never represent real revenue.

import mongoose, { type ClientSession, type Types } from "mongoose";
import Appointment, { type AppointmentFields } from "../models/Appointment";
import Transaction, {
    ACTIVE_PAYMENT_STATUSES,
    TERMINAL_PAYMENT_STATUSES,
    type PaymentStatus,
    type SimulationOutcome,
    type TransactionFields,
} from "../models/Transaction";
import type { PaymentMethodId } from "../config/payment";

export type TransactionLean = TransactionFields & {
    _id: Types.ObjectId;
    createdAt?: Date;
    updatedAt?: Date;
};

export type AppointmentLean = AppointmentFields & {
    _id: Types.ObjectId;
    createdAt?: Date;
    updatedAt?: Date;
};

export class PaymentStateError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "PaymentStateError";
    }
}

export function isPaymentStateError(error: unknown): error is PaymentStateError {
    return error instanceof PaymentStateError;
}

export function isActivePaymentStatus(status: string): status is PaymentStatus {
    return (ACTIVE_PAYMENT_STATUSES as readonly string[]).includes(status);
}

export function isSettledPaymentStatus(status: string): status is PaymentStatus {
    return status === "succeeded" || status === "cash_received";
}

export function isTerminalPaymentStatus(status: string): status is PaymentStatus {
    return (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(status);
}

export function appointmentPaymentStatusForTransaction(
    status: PaymentStatus,
): "unpaid" | "pending" | "paid" {
    if (isSettledPaymentStatus(status)) return "paid";
    if (isActivePaymentStatus(status)) return "pending";
    return "unpaid";
}

export interface ReconcileFence {
    workerId: string;
    leaseUntil: Date;
}

function reconcileFenceFilter(fence?: ReconcileFence): Record<string, unknown> {
    if (!fence) return {};
    return {
        reconcileClaimedBy: fence.workerId,
        reconcileLeaseUntil: fence.leaseUntil,
    };
}

export function canSimulateTransaction(transaction: {
    paymentMethod: string;
    paymentStatus: string;
    environment: string;
    simulated: boolean;
}): boolean {
    return (
        transaction.environment === "TEST" &&
        transaction.simulated === true &&
        transaction.paymentMethod !== "pay_at_salon" &&
        (transaction.paymentStatus === "pending" ||
            transaction.paymentStatus === "processing")
    );
}

let transactionsSupported: boolean | undefined;

export async function paymentTransactionsSupported(): Promise<boolean> {
    if (transactionsSupported !== undefined) return transactionsSupported;
    try {
        const db = mongoose.connection.db;
        if (!db) {
            transactionsSupported = false;
            return false;
        }
        const hello = (await db.admin().command({ hello: 1 })) as {
            setName?: string;
            isWritablePrimary?: boolean;
            isreplicaset?: boolean;
            logicalSessionTimeoutMinutes?: number;
            msg?: string;
        };
        transactionsSupported = Boolean(
            hello.setName ||
                hello.isWritablePrimary ||
                hello.isreplicaset ||
                (hello.logicalSessionTimeoutMinutes ?? 0) > 0 ||
                hello.msg === "isdbgrid",
        );
    } catch {
        transactionsSupported = false;
    }
    return transactionsSupported;
}

export async function withPaymentTransactionIfSupported<T>(
    work: (session: ClientSession | null) => Promise<T>,
): Promise<T> {
    if (!(await paymentTransactionsSupported())) {
        return work(null);
    }
    const session = await mongoose.startSession();
    try {
        let result: T | undefined;
        await session.withTransaction(async () => {
            result = await work(session);
        });
        if (result === undefined) {
            throw new PaymentStateError(
                500,
                "payment_transaction_empty",
                "Payment transaction did not complete.",
            );
        }
        return result;
    } finally {
        await session.endSession();
    }
}

function sessionOptions(session: ClientSession | null) {
    return session ? { session } : {};
}

async function loadTransaction(
    transactionId: string,
    session: ClientSession | null,
): Promise<TransactionLean | null> {
    let query = Transaction.findById(transactionId);
    if (session) query = query.session(session);
    return (await query.lean()) as TransactionLean | null;
}

async function loadAppointment(
    appointmentId: Types.ObjectId | string,
    session: ClientSession | null,
): Promise<AppointmentLean | null> {
    let query = Appointment.findById(appointmentId);
    if (session) query = query.session(session);
    return (await query.lean()) as AppointmentLean | null;
}

function assertTransactionSettleable(
    transaction: TransactionLean,
    options: {
        allowedActiveStatuses: readonly PaymentStatus[];
        finalStatus: "succeeded" | "cash_received";
        requireMethod?: PaymentMethodId | undefined;
        settlementOutcome: SimulationOutcome;
    },
): void {
    if (transaction.environment !== "TEST" || transaction.simulated !== true) {
        throw new PaymentStateError(
            409,
            "test_payments_only",
            "Only TEST simulated payments can be settled in this phase.",
        );
    }
    if (
        options.requireMethod &&
        transaction.paymentMethod !== options.requireMethod
    ) {
        throw new PaymentStateError(
            409,
            "payment_method_mismatch",
            "This payment method cannot be settled by this action.",
        );
    }
    if (isTerminalPaymentStatus(transaction.paymentStatus)) {
        throw new PaymentStateError(
            409,
            "payment_already_closed",
            "This payment attempt is already closed.",
        );
    }
    if (isSettledPaymentStatus(transaction.paymentStatus)) {
        const settledMatches =
            transaction.paymentStatus === options.finalStatus &&
            transaction.settlementState === "committed" &&
            String(transaction.settledAppointmentId) ===
                String(transaction.appointment);
        if (!settledMatches) {
            throw new PaymentStateError(
                409,
                "payment_already_settled",
                "This appointment already has a settled payment.",
            );
        }
        return;
    }
    if (
        !(options.allowedActiveStatuses as readonly string[]).includes(
            transaction.paymentStatus,
        )
    ) {
        throw new PaymentStateError(
            409,
            "payment_not_active",
            "This payment is not in an active state.",
        );
    }
    if (transaction.settlementState === "aborted") {
        throw new PaymentStateError(
            409,
            "settlement_aborted",
            "This payment settlement was aborted and cannot be retried.",
        );
    }
    if (
        transaction.settlementState === "in_progress" &&
        transaction.settlementOutcome &&
        transaction.settlementOutcome !== options.settlementOutcome
    ) {
        throw new PaymentStateError(
            409,
            "settlement_conflict",
            "This payment is already being settled with a different outcome.",
        );
    }
}

async function claimSuccessTransition(
    transaction: TransactionLean,
    session: ClientSession | null,
    allowedActiveStatuses: readonly PaymentStatus[],
): Promise<TransactionLean | null> {
    let query = Transaction.findOneAndUpdate(
        {
            _id: transaction._id,
            paymentStatus: {
                $in: [
                    ...allowedActiveStatuses,
                ] as PaymentStatus[],
            },
            settlementState: { $in: ["idle", "in_progress"] },
            $or: [
                { settlementOutcome: { $exists: false } },
                { settlementOutcome: null },
                { settlementOutcome: "success" },
            ],
        },
        {
            $set: {
                settlementState: "in_progress",
                settlementOutcome: "success",
                settlementStartedAt: new Date(),
                lastSettlementError: null,
            },
            $inc: { settlementAttempts: 1 },
        },
        { new: true, lean: true, ...sessionOptions(session) },
    );
    return (await query) as TransactionLean | null;
}

async function finalizeSuccessTransition(
    transaction: TransactionLean,
    options: {
        finalStatus: "succeeded" | "cash_received";
        actorUserId?: string | undefined;
        reconcileFence?: ReconcileFence | undefined;
    },
    session: ClientSession | null,
): Promise<TransactionLean | null> {
    const now = new Date();
    const set: Record<string, unknown> = {
        paymentStatus: options.finalStatus,
        paidAt: now,
        settlementState: "committed",
        settledAppointmentId: transaction.appointment,
    };
    const unset: Record<string, 1> = {
        activeAppointmentId: 1,
        lastSettlementError: 1,
    };
    if (options.finalStatus === "succeeded") {
        set.simulationOutcome = "success";
    } else {
        set.cashConfirmedAt = now;
        if (options.actorUserId) {
            set.cashConfirmedBy = new mongoose.Types.ObjectId(options.actorUserId);
        }
    }

    let query = Transaction.findOneAndUpdate(
        {
            _id: transaction._id,
            settlementState: "in_progress",
            settlementOutcome: "success",
            ...reconcileFenceFilter(options.reconcileFence),
        },
        { $set: set, $unset: unset },
        { new: true, lean: true, ...sessionOptions(session) },
    );
    return (await query) as TransactionLean | null;
}

async function markSettlementAborted(
    transaction: TransactionLean,
    reason: string,
    session: ClientSession | null,
): Promise<void> {
    await Transaction.updateOne(
        { _id: transaction._id, settlementState: "in_progress" },
        {
            $set: {
                paymentStatus: "failed",
                settlementState: "aborted",
                settlementOutcome: "failed",
                failureReason: reason,
                lastSettlementError: reason,
            },
            $unset: { activeAppointmentId: 1 },
        },
        sessionOptions(session),
    );
}

async function settleSuccessInSession(
    session: ClientSession,
    options: {
        transactionId: string;
        actorUserId?: string | undefined;
        finalStatus: "succeeded" | "cash_received";
        requireMethod?: PaymentMethodId | undefined;
        allowedActiveStatuses: readonly PaymentStatus[];
        reconcileFence?: ReconcileFence | undefined;
    },
): Promise<{
    transaction: TransactionLean;
    appointment: AppointmentLean;
    idempotentReplay: boolean;
}> {
    const transaction = await loadTransaction(options.transactionId, session);
    if (!transaction) {
        throw new PaymentStateError(404, "transaction_not_found", "Payment not found.");
    }

    assertTransactionSettleable(transaction, {
        allowedActiveStatuses: options.allowedActiveStatuses,
        finalStatus: options.finalStatus,
        requireMethod: options.requireMethod,
        settlementOutcome: "success",
    });

    if (
        transaction.paymentStatus === options.finalStatus &&
        transaction.settlementState === "committed" &&
        String(transaction.settledAppointmentId) === String(transaction.appointment)
    ) {
        const appointment = await loadAppointment(transaction.appointment, session);
        if (!appointment) {
            throw new PaymentStateError(404, "appointment_not_found", "Appointment not found.");
        }
        return { transaction, appointment, idempotentReplay: true };
    }

    const claimed = await claimSuccessTransition(transaction, session, options.allowedActiveStatuses);
    if (!claimed) {
        throw new PaymentStateError(
            409,
            "settlement_conflict",
            "This payment is already being settled.",
        );
    }

    const payableAppointment = await loadAppointment(transaction.appointment, session);
    if (!payableAppointment || payableAppointment.status !== "confirmed") {
        throw new PaymentStateError(
            409,
            "appointment_not_confirmed",
            "Only confirmed appointments can be paid.",
        );
    }

    const now = new Date();
    let appointment = (await Appointment.findOneAndUpdate(
        {
            _id: transaction.appointment,
            status: "confirmed",
            latestTransactionId: transaction._id,
            paymentStatus: { $ne: "paid" },
        },
        {
            $set: {
                paymentStatus: "paid",
                paymentMethod: transaction.paymentMethod,
                paidAt: now,
                latestTransactionId: transaction._id,
            },
        },
        { new: true, lean: true, ...sessionOptions(session) },
    )) as AppointmentLean | null;

    if (!appointment) {
        const existing = await loadAppointment(transaction.appointment, session);
        if (
            existing?.paymentStatus === "paid" &&
            String(existing.latestTransactionId) === String(transaction._id)
        ) {
            appointment = existing;
        } else {
            throw new PaymentStateError(
                409,
                "appointment_state_conflict",
                "The appointment payment state changed during settlement.",
            );
        }
    }

    const finalTransaction = await finalizeSuccessTransition(
        transaction,
        {
            finalStatus: options.finalStatus,
            actorUserId: options.actorUserId,
            reconcileFence: options.reconcileFence,
        },
        session,
    );
    if (!finalTransaction) {
        throw new PaymentStateError(
            500,
            "settlement_finalize_failed",
            "Payment settlement could not be finalized.",
        );
    }

    return {
        transaction: finalTransaction,
        appointment,
        idempotentReplay: false,
    };
}

async function settleSuccessFallback(options: {
    transactionId: string;
    actorUserId?: string | undefined;
    finalStatus: "succeeded" | "cash_received";
    requireMethod?: PaymentMethodId | undefined;
    allowedActiveStatuses: readonly PaymentStatus[];
    reconcileFence?: ReconcileFence | undefined;
}): Promise<{
    transaction: TransactionLean;
    appointment: AppointmentLean;
    idempotentReplay: boolean;
}> {
    const transaction = await loadTransaction(options.transactionId, null);
    if (!transaction) {
        throw new PaymentStateError(404, "transaction_not_found", "Payment not found.");
    }

    assertTransactionSettleable(transaction, {
        allowedActiveStatuses: options.allowedActiveStatuses,
        finalStatus: options.finalStatus,
        requireMethod: options.requireMethod,
        settlementOutcome: "success",
    });

    if (
        transaction.paymentStatus === options.finalStatus &&
        transaction.settlementState === "committed" &&
        String(transaction.settledAppointmentId) === String(transaction.appointment)
    ) {
        const appointment = await loadAppointment(transaction.appointment, null);
        if (!appointment) {
            throw new PaymentStateError(404, "appointment_not_found", "Appointment not found.");
        }
        return { transaction, appointment, idempotentReplay: true };
    }

    const claimed = await claimSuccessTransition(
        transaction,
        null,
        options.allowedActiveStatuses,
    );
    if (!claimed) {
        throw new PaymentStateError(
            409,
            "settlement_conflict",
            "This payment is already being settled.",
        );
    }

    const payableAppointment = await loadAppointment(transaction.appointment, null);
    if (!payableAppointment || payableAppointment.status !== "confirmed") {
        throw new PaymentStateError(
            409,
            "appointment_not_confirmed",
            "Only confirmed appointments can be paid.",
        );
    }

    const now = new Date();
    let appointment = (await Appointment.findOneAndUpdate(
        {
            _id: transaction.appointment,
            status: "confirmed",
            latestTransactionId: transaction._id,
            paymentStatus: { $ne: "paid" },
        },
        {
            $set: {
                paymentStatus: "paid",
                paymentMethod: transaction.paymentMethod,
                paidAt: now,
                latestTransactionId: transaction._id,
            },
        },
        { new: true, lean: true },
    )) as AppointmentLean | null;

    if (!appointment) {
        const existing = await loadAppointment(transaction.appointment, null);
        if (
            existing?.paymentStatus === "paid" &&
            String(existing.latestTransactionId) === String(transaction._id)
        ) {
            appointment = existing;
        } else {
            await markSettlementAborted(
                transaction,
                "appointment_update_failed",
                null,
            );
            throw new PaymentStateError(
                409,
                "appointment_state_conflict",
                "The appointment payment state changed during settlement.",
            );
        }
    }

    const finalTransaction = await finalizeSuccessTransition(
        transaction,
        {
            finalStatus: options.finalStatus,
            actorUserId: options.actorUserId,
            reconcileFence: options.reconcileFence,
        },
        null,
    );
    if (!finalTransaction) {
        const latest = await loadTransaction(options.transactionId, null);
        if (
            latest?.paymentStatus === options.finalStatus &&
            latest.settlementState === "committed"
        ) {
            return {
                transaction: latest,
                appointment,
                idempotentReplay: true,
            };
        }
        throw new PaymentStateError(
            500,
            "settlement_finalize_failed",
            "Payment settlement could not be finalized.",
        );
    }

    return {
        transaction: finalTransaction,
        appointment,
        idempotentReplay: false,
    };
}

export async function settleTransactionSuccess(options: {
    transactionId: string;
    actorUserId?: string | undefined;
    finalStatus: "succeeded" | "cash_received";
    requireMethod?: PaymentMethodId | undefined;
    allowedActiveStatuses: readonly PaymentStatus[];
    reconcileFence?: ReconcileFence | undefined;
}): Promise<{
    transaction: TransactionLean;
    appointment: AppointmentLean;
    idempotentReplay: boolean;
}> {
    if (await paymentTransactionsSupported()) {
        const session = await mongoose.startSession();
        try {
            let result:
                | {
                      transaction: TransactionLean;
                      appointment: AppointmentLean;
                      idempotentReplay: boolean;
                  }
                | undefined;
            await session.withTransaction(async () => {
                result = await settleSuccessInSession(session, options);
            });
            if (!result) {
                throw new PaymentStateError(
                    500,
                    "payment_transaction_empty",
                    "Payment transaction did not complete.",
                );
            }
            return result;
        } finally {
            await session.endSession();
        }
    }
    return settleSuccessFallback(options);
}

async function claimFailureTransition(
    transaction: TransactionLean,
    outcome: "failed" | "cancelled",
    session: ClientSession | null,
): Promise<TransactionLean | null> {
    let query = Transaction.findOneAndUpdate(
        {
            _id: transaction._id,
            paymentStatus: {
                $in: ["pending", "processing"] as PaymentStatus[],
            },
            settlementState: { $in: ["idle", "in_progress"] },
            $or: [
                { settlementOutcome: { $exists: false } },
                { settlementOutcome: null },
                { settlementOutcome: outcome },
            ],
        },
        {
            $set: {
                settlementState: "in_progress",
                settlementOutcome: outcome,
                settlementStartedAt: new Date(),
                lastSettlementError: null,
            },
            $inc: { settlementAttempts: 1 },
        },
        { new: true, lean: true, ...sessionOptions(session) },
    );
    return (await query) as TransactionLean | null;
}

async function finalizeFailureTransition(
    transaction: TransactionLean,
    outcome: "failed" | "cancelled",
    failureReason: string | undefined,
    reconcileFence: ReconcileFence | undefined,
    session: ClientSession | null,
): Promise<TransactionLean | null> {
    const set: Record<string, unknown> = {
        paymentStatus: outcome,
        simulationOutcome: outcome,
        settlementState: "committed",
        settlementOutcome: outcome,
    };
    if (outcome === "failed") {
        set.failureReason = failureReason ?? "simulated_failure";
    }
    let query = Transaction.findOneAndUpdate(
        {
            _id: transaction._id,
            settlementState: "in_progress",
            settlementOutcome: outcome,
            ...reconcileFenceFilter(reconcileFence),
        },
        {
            $set: set,
            $unset: { activeAppointmentId: 1, lastSettlementError: 1 },
        },
        { new: true, lean: true, ...sessionOptions(session) },
    );
    return (await query) as TransactionLean | null;
}

async function settleFailureCore(options: {
    transactionId: string;
    outcome: "failed" | "cancelled";
    failureReason?: string | undefined;
    reconcileFence?: ReconcileFence | undefined;
    session: ClientSession | null;
}): Promise<{
    transaction: TransactionLean;
    appointment: AppointmentLean;
    idempotentReplay: boolean;
}> {
    const { session } = options;
    const transaction = await loadTransaction(options.transactionId, session);
    if (!transaction) {
        throw new PaymentStateError(404, "transaction_not_found", "Payment not found.");
    }

    if (transaction.environment !== "TEST" || transaction.simulated !== true) {
        throw new PaymentStateError(
            409,
            "test_payments_only",
            "Only TEST simulated payments can be settled in this phase.",
        );
    }
    if (transaction.paymentMethod === "pay_at_salon") {
        throw new PaymentStateError(
            409,
            "payment_method_not_simulatable",
            "Pay at Salon cannot be simulated.",
        );
    }
    if (transaction.paymentStatus === options.outcome) {
        if (transaction.settlementState === "committed") {
            const appointment = await loadAppointment(transaction.appointment, session);
            if (!appointment) {
                throw new PaymentStateError(404, "appointment_not_found", "Appointment not found.");
            }
            return { transaction, appointment, idempotentReplay: true };
        }
    }
    if (isSettledPaymentStatus(transaction.paymentStatus)) {
        throw new PaymentStateError(
            409,
            "payment_already_settled",
            "This appointment already has a settled payment.",
        );
    }
    if (
        transaction.paymentStatus !== "pending" &&
        transaction.paymentStatus !== "processing"
    ) {
        throw new PaymentStateError(
            409,
            "payment_not_active",
            "This payment is not in an active state.",
        );
    }
    if (
        transaction.settlementState === "in_progress" &&
        transaction.settlementOutcome &&
        transaction.settlementOutcome !== options.outcome
    ) {
        throw new PaymentStateError(
            409,
            "settlement_conflict",
            "This payment is already being settled with a different outcome.",
        );
    }

    const claimed = await claimFailureTransition(
        transaction,
        options.outcome,
        session,
    );
    if (!claimed) {
        throw new PaymentStateError(
            409,
            "settlement_conflict",
            "This payment is already being settled.",
        );
    }

    let appointment = (await Appointment.findOneAndUpdate(
        {
            _id: transaction.appointment,
            latestTransactionId: transaction._id,
            paymentStatus: "pending",
        },
        {
            $set: {
                paymentStatus: "unpaid",
                latestTransactionId: transaction._id,
            },
            $unset: { paymentMethod: 1, paidAt: 1 },
        },
        { new: true, lean: true, ...sessionOptions(session) },
    )) as AppointmentLean | null;

    if (!appointment) {
        const existing = await loadAppointment(transaction.appointment, session);
        if (existing && existing.paymentStatus !== "paid") {
            appointment = existing;
        } else {
            throw new PaymentStateError(
                409,
                "appointment_state_conflict",
                "The appointment payment state changed during settlement.",
            );
        }
    }

    const finalTransaction = await finalizeFailureTransition(
        transaction,
        options.outcome,
        options.failureReason,
        options.reconcileFence,
        session,
    );
    if (!finalTransaction) {
        const latest = await loadTransaction(options.transactionId, session);
        if (latest?.paymentStatus === options.outcome) {
            return { transaction: latest, appointment, idempotentReplay: true };
        }
        throw new PaymentStateError(
            500,
            "settlement_finalize_failed",
            "Payment settlement could not be finalized.",
        );
    }

    return {
        transaction: finalTransaction,
        appointment,
        idempotentReplay: false,
    };
}

export async function settleTransactionFailure(options: {
    transactionId: string;
    outcome: "failed" | "cancelled";
    failureReason?: string | undefined;
    reconcileFence?: ReconcileFence | undefined;
}): Promise<{
    transaction: TransactionLean;
    appointment: AppointmentLean;
    idempotentReplay: boolean;
}> {
    if (await paymentTransactionsSupported()) {
        const session = await mongoose.startSession();
        try {
            let result:
                | {
                      transaction: TransactionLean;
                      appointment: AppointmentLean;
                      idempotentReplay: boolean;
                  }
                | undefined;
            await session.withTransaction(async () => {
                result = await settleFailureCore({
                    transactionId: options.transactionId,
                    outcome: options.outcome,
                    failureReason: options.failureReason,
                    reconcileFence: options.reconcileFence,
                    session,
                });
            });
            if (!result) {
                throw new PaymentStateError(
                    500,
                    "payment_transaction_empty",
                    "Payment transaction did not complete.",
                );
            }
            return result;
        } finally {
            await session.endSession();
        }
    }
    return settleFailureCore({
        transactionId: options.transactionId,
        outcome: options.outcome,
        failureReason: options.failureReason,
        reconcileFence: options.reconcileFence,
        session: null,
    });
}
