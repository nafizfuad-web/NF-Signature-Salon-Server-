import type { ClientSession, Types } from "mongoose";
import mongoose from "mongoose";
import Appointment from "../models/Appointment";
import Transaction, {
    SETTLED_PAYMENT_STATUSES,
    type PaymentStatus,
} from "../models/Transaction";
import {
    PAYMENT_METHOD_IDS,
    TEST_PAYMENT_DATABASE_NAME,
} from "../config/payment";
import {
    isActivePaymentStatus,
    settleTransactionFailure,
    settleTransactionSuccess,
    type AppointmentLean,
    type TransactionLean,
} from "./paymentState";

export type ReconcileDecision =
    | "skip"
    | "settle_success"
    | "settle_failure"
    | "repair_paid"
    | "abort";

export interface ReconcileTransactionShape {
    paymentStatus: PaymentStatus;
    settlementState?: string;
    settlementOutcome?: string | null;
}

export interface ReconcileActionInput {
    transaction: ReconcileTransactionShape;
    appointment: { paymentStatus?: string } | null;
    canonicalSettled: boolean;
}

export function canReconcileTestPaymentsInEnvironment(
    databaseName: string,
    nodeEnv: string,
): boolean {
    return (
        nodeEnv !== "production" &&
        databaseName === TEST_PAYMENT_DATABASE_NAME
    );
}

export function canReconcileExistingTestPayments(): boolean {
    return canReconcileTestPaymentsInEnvironment(
        mongoose.connection.name,
        process.env.NODE_ENV?.trim() || "development",
    );
}

export function isCanonicalTestSettledTransaction(
    transaction: {
        environment?: string;
        simulated?: boolean;
        paymentStatus: PaymentStatus;
        settledAppointmentId?: unknown;
    },
    appointmentId: unknown,
): boolean {
    return (
        transaction.environment === "TEST" &&
        transaction.simulated === true &&
        (SETTLED_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(
            transaction.paymentStatus,
        ) &&
        String(transaction.settledAppointmentId) === String(appointmentId)
    );
}

export type PaidRepairDecision = "repair_canonical" | "unpay" | "skip";

export function decidePaidRepairAction(input: {
    appointmentPaymentStatus: string | undefined;
    paymentMethodIsTest: boolean;
    hasTestHistory: boolean;
    canonicalSettled: boolean;
}): PaidRepairDecision {
    if (input.appointmentPaymentStatus !== "paid") return "skip";
    if (input.canonicalSettled) return "repair_canonical";
    if (input.hasTestHistory || input.paymentMethodIsTest) return "unpay";
    return "skip";
}

export function reconcileFenceIsCurrent(
    fence: { workerId: string; leaseUntil: Date },
    currentClaimedBy: string | null | undefined,
    currentLeaseUntil: Date | string | null | undefined,
    now: Date = new Date(),
): boolean {
    if (currentClaimedBy !== fence.workerId) return false;
    if (!currentLeaseUntil) return false;
    const leaseTime =
        currentLeaseUntil instanceof Date
            ? currentLeaseUntil.getTime()
            : new Date(currentLeaseUntil).getTime();
    return leaseTime === fence.leaseUntil.getTime() && leaseTime > now.getTime();
}

export function isReconcileLeaseExpired(
    leaseUntil: Date | string | null | undefined,
    now: Date = new Date(),
): boolean {
    if (!leaseUntil) return true;
    const time = leaseUntil instanceof Date ? leaseUntil.getTime() : new Date(leaseUntil).getTime();
    return Number.isNaN(time) || time <= now.getTime();
}

export function reconcileLeaseUntil(now: Date = new Date(), leaseMs = 30_000): Date {
    return new Date(now.getTime() + leaseMs);
}

export function shouldAbortForRetryLimit(
    reconcileAttempts: number,
    maxReconcileAttempts: number,
): boolean {
    return reconcileAttempts >= maxReconcileAttempts;
}

export function decideReconcileAction(input: ReconcileActionInput): ReconcileDecision {
    const { transaction, appointment, canonicalSettled } = input;

    if (
        transaction.settlementState === "committed" &&
        (SETTLED_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(transaction.paymentStatus)
    ) {
        return "skip";
    }
    if (canonicalSettled) return "repair_paid";
    if (!appointment) return "abort";

    const outcome = transaction.settlementOutcome;
    const active = isActivePaymentStatus(transaction.paymentStatus);

    if (appointment.paymentStatus === "paid") {
        if (outcome === "success" && active) return "settle_success";
        return "abort";
    }

    if (outcome === "success" && active) return "settle_success";
    if ((outcome === "failed" || outcome === "cancelled") && active) return "settle_failure";
    return "abort";
}

async function loadCanonicalSettledTransaction(
    appointmentId: unknown,
): Promise<TransactionLean | null> {
    const filter = {
        settledAppointmentId: appointmentId as Types.ObjectId,
        paymentStatus: { $in: [...SETTLED_PAYMENT_STATUSES] },
        environment: "TEST",
        simulated: true,
    } as never;
    return (await Transaction.findOne(filter)
        .sort({ paidAt: -1, createdAt: -1 })
        .lean()) as TransactionLean | null;
}

async function loadAppointment(
    appointmentId: unknown,
): Promise<AppointmentLean | null> {
    return (await Appointment.findById(appointmentId).lean()) as AppointmentLean | null;
}

async function repairAppointmentFromCanonical(
    appointmentId: unknown,
    canonical: TransactionLean,
): Promise<void> {
    await Appointment.findOneAndUpdate(
        { _id: appointmentId },
        {
            $set: {
                paymentStatus: "paid",
                paymentMethod: canonical.paymentMethod,
                paidAt: canonical.paidAt ?? new Date(),
                latestTransactionId: canonical._id,
            },
        },
        { new: true, lean: true },
    );
}

async function abortInterruptedSettlement(
    transaction: TransactionLean,
    reason: string,
): Promise<boolean> {
    if ((SETTLED_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(transaction.paymentStatus)) {
        return false;
    }

    const appointmentId = transaction.appointment;
    const canonical = await loadCanonicalSettledTransaction(appointmentId);
    const appointment = await loadAppointment(appointmentId);

    if (canonical) {
        await repairAppointmentFromCanonical(appointmentId, canonical);
    } else if (appointment?.paymentStatus === "paid") {
        await Appointment.findOneAndUpdate(
            { _id: appointmentId, paymentStatus: "paid" },
            {
                $set: {
                    paymentStatus: "unpaid",
                    latestTransactionId: transaction._id,
                },
                $unset: { paymentMethod: 1, paidAt: 1 },
            },
            { new: true, lean: true },
        );
    }

    const finalStatus = transaction.settlementOutcome === "cancelled" ? "cancelled" : "failed";
    const set: Record<string, unknown> = {
        paymentStatus: finalStatus,
        settlementState: "aborted",
        settlementOutcome: finalStatus,
        lastSettlementError: reason,
        lastReconcileError: reason,
    };
    if (finalStatus === "failed") {
        set.failureReason = reason;
    }
    if (transaction.simulated && transaction.provider === "internal_simulator") {
        set.simulationOutcome = finalStatus;
    }

    await Transaction.findOneAndUpdate(
        { _id: transaction._id, settlementState: "in_progress" },
        {
            $set: set,
            $unset: {
                activeAppointmentId: 1,
                settledAppointmentId: 1,
                reconcileClaimedBy: 1,
                reconcileLeaseUntil: 1,
            },
        },
        { new: true, lean: true },
    );
    return true;
}

async function clearReconcileClaim(transactionId: unknown): Promise<void> {
    await Transaction.updateOne(
        { _id: transactionId },
        {
            $unset: {
                reconcileClaimedBy: 1,
                reconcileLeaseUntil: 1,
                lastReconcileError: 1,
            },
        },
    );
}

async function markReconcileError(transactionId: unknown, message: string): Promise<void> {
    await Transaction.updateOne(
        { _id: transactionId },
        {
            $set: {
                lastReconcileError: message.slice(0, 200),
                lastReconcileAt: new Date(),
            },
        },
    );
}

async function reconcileClaimedTransaction(
    transaction: TransactionLean,
    maxReconcileAttempts: number,
    fence: { workerId: string; leaseUntil: Date },
): Promise<"recovered" | "repaired" | "aborted" | "skipped" | "error"> {
    if (shouldAbortForRetryLimit(transaction.reconcileAttempts ?? 0, maxReconcileAttempts)) {
        return (await abortInterruptedSettlement(transaction, "reconcile_retry_limit"))
            ? "aborted"
            : "skipped";
    }

    const appointment = await loadAppointment(transaction.appointment);
    const canonical = appointment
        ? await loadCanonicalSettledTransaction(appointment._id)
        : null;
    const decision = decideReconcileAction({
        transaction,
        appointment: appointment ? { paymentStatus: appointment.paymentStatus ?? "unpaid" } : null,
        canonicalSettled: Boolean(canonical),
    });

    try {
        if (decision === "skip") {
            await clearReconcileClaim(transaction._id);
            return "skipped";
        }

        if (decision === "repair_paid") {
            if (!canonical) return "error";
            await repairAppointmentFromCanonical(transaction.appointment, canonical);
            await abortInterruptedSettlement(transaction, "superseded_by_settled_transaction");
            return "repaired";
        }

        if (decision === "settle_success") {
            const finalStatus = transaction.paymentStatus === "cash_pending" ? "cash_received" : "succeeded";
            const allowedActiveStatuses = isActivePaymentStatus(transaction.paymentStatus)
                ? [transaction.paymentStatus]
                : [];
            if (allowedActiveStatuses.length === 0) {
                await abortInterruptedSettlement(transaction, "settlement_not_active");
                return "aborted";
            }
            await settleTransactionSuccess({
                transactionId: String(transaction._id),
                finalStatus,
                requireMethod: transaction.paymentMethod,
                allowedActiveStatuses,
                reconcileFence: fence,
            });
            await clearReconcileClaim(transaction._id);
            return "recovered";
        }

        if (decision === "settle_failure") {
            const outcome = transaction.settlementOutcome === "cancelled" ? "cancelled" : "failed";
            await settleTransactionFailure({
                transactionId: String(transaction._id),
                outcome,
                failureReason: transaction.lastSettlementError ?? `reconcile_${outcome}`,
                reconcileFence: fence,
            });
            await clearReconcileClaim(transaction._id);
            return "recovered";
        }

        await abortInterruptedSettlement(transaction, "reconcile_abort");
        return "aborted";
    } catch (error) {
        const message = error instanceof Error ? error.message : "reconcile_failed";
        await markReconcileError(transaction._id, message);
        return "error";
    }
}

async function repairPaidAppointmentsWithoutCanonical(limit: number): Promise<{
    audited: number;
    repaired: number;
    unpaid: number;
    skipped: number;
}> {
    const result = { audited: 0, repaired: 0, unpaid: 0, skipped: 0 };
    const appointments = (await Appointment.find({
        paymentStatus: "paid",
        paymentMethod: { $in: [...PAYMENT_METHOD_IDS] },
    })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean()) as AppointmentLean[];

    for (const appointment of appointments) {
        result.audited += 1;
        const canonical = await loadCanonicalSettledTransaction(appointment._id);
        const hasTestHistory = Boolean(
            await Transaction.exists({
                appointment: appointment._id,
                environment: "TEST",
                simulated: true,
            }),
        );
        const paymentMethodIsTest = (PAYMENT_METHOD_IDS as readonly string[]).includes(
            String(appointment.paymentMethod ?? ""),
        );
        const decision = decidePaidRepairAction({
            appointmentPaymentStatus: appointment.paymentStatus,
            paymentMethodIsTest,
            hasTestHistory,
            canonicalSettled: Boolean(canonical),
        });

        if (decision === "skip") {
            result.skipped += 1;
            continue;
        }
        if (decision === "repair_canonical" && canonical) {
            await Appointment.findOneAndUpdate(
                { _id: appointment._id, paymentStatus: "paid" },
                {
                    $set: {
                        paymentMethod: canonical.paymentMethod,
                        paidAt: canonical.paidAt ?? new Date(),
                        latestTransactionId: canonical._id,
                    },
                },
                { new: true, lean: true },
            );
            result.repaired += 1;
            continue;
        }
        if (decision === "unpay") {
            const latestTest = (await Transaction.findOne({
                appointment: appointment._id,
                environment: "TEST",
                simulated: true,
            })
                .sort({ createdAt: -1 })
                .lean()) as TransactionLean | null;
            await Appointment.findOneAndUpdate(
                { _id: appointment._id, paymentStatus: "paid" },
                {
                    $set: {
                        paymentStatus: "unpaid",
                        ...(latestTest ? { latestTransactionId: latestTest._id } : {}),
                    },
                    $unset: { paymentMethod: 1, paidAt: 1 },
                },
                { new: true, lean: true },
            );
            result.unpaid += 1;
        }
    }
    return result;
}

export interface ReconcileRunOptions {
    batchSize?: number;
    leaseMs?: number;
    maxReconcileAttempts?: number;
    workerId?: string;
    now?: Date;
}

export interface ReconcileRunResult {
    ran: boolean;
    reason?: string;
    processed: number;
    recovered: number;
    repaired: number;
    aborted: number;
    skipped: number;
    errors: number;
    paidAudited: number;
    paidRepaired: number;
    paidUnpaid: number;
    paidSkipped: number;
}

export async function runPaymentReconciliationOnce(
    options: ReconcileRunOptions = {},
): Promise<ReconcileRunResult> {
    const empty = {
        processed: 0,
        recovered: 0,
        repaired: 0,
        aborted: 0,
        skipped: 0,
        errors: 0,
        paidAudited: 0,
        paidRepaired: 0,
        paidUnpaid: 0,
        paidSkipped: 0,
    };
    if (!canReconcileExistingTestPayments()) {
        return { ran: false, reason: "disabled_in_production", ...empty };
    }

    const batchSize = options.batchSize ?? 25;
    const leaseMs = options.leaseMs ?? 30_000;
    const maxReconcileAttempts = options.maxReconcileAttempts ?? 5;
    const workerId = options.workerId ?? `reconciler_${process.pid}_${Date.now().toString(36)}`;
    const now = options.now ?? new Date();
    const leaseUntil = reconcileLeaseUntil(now, leaseMs);

    const candidates = (await Transaction.find({
        environment: "TEST",
        simulated: true,
        settlementState: "in_progress",
        $or: [
            { reconcileLeaseUntil: { $exists: false } },
            { reconcileLeaseUntil: null },
            { reconcileLeaseUntil: { $lt: now } },
        ],
    })
        .sort({ settlementStartedAt: 1, createdAt: 1 })
        .limit(batchSize)
        .lean()) as TransactionLean[];

    const result: ReconcileRunResult = { ran: true, ...empty, processed: candidates.length };

    for (const candidate of candidates) {
        const claimed = (await Transaction.findOneAndUpdate(
            {
                _id: candidate._id,
                settlementState: "in_progress",
                $or: [
                    { reconcileLeaseUntil: { $exists: false } },
                    { reconcileLeaseUntil: null },
                    { reconcileLeaseUntil: { $lt: now } },
                ],
            },
            {
                $set: {
                    reconcileClaimedBy: workerId,
                    reconcileLeaseUntil: leaseUntil,
                    lastReconcileAt: now,
                },
                $inc: { reconcileAttempts: 1 },
            },
            { new: true, lean: true },
        )) as TransactionLean | null;

        if (!claimed) continue;

        const outcome = await reconcileClaimedTransaction(claimed, maxReconcileAttempts, {
            workerId,
            leaseUntil: claimed.reconcileLeaseUntil ?? leaseUntil,
        });
        if (outcome === "recovered") result.recovered += 1;
        else if (outcome === "repaired") result.repaired += 1;
        else if (outcome === "aborted") result.aborted += 1;
        else if (outcome === "skipped") result.skipped += 1;
        else result.errors += 1;
    }

    const paid = await repairPaidAppointmentsWithoutCanonical(batchSize);
    result.paidAudited = paid.audited;
    result.paidRepaired = paid.repaired;
    result.paidUnpaid = paid.unpaid;
    result.paidSkipped = paid.skipped;

    return result;
}

let reconcilerTimer: ReturnType<typeof setInterval> | null = null;
let reconcilerInFlight = false;

export function startPaymentReconciler(intervalMs = 60_000): () => void {
    if (reconcilerTimer) return stopPaymentReconciler;

    const tick = async () => {
        if (reconcilerInFlight) return;
        reconcilerInFlight = true;
        try {
            await runPaymentReconciliationOnce();
        } catch (error) {
            const message = error instanceof Error ? error.message : "payment_reconciler_failed";
            console.error(`payment reconciler failed: ${message}`);
        } finally {
            reconcilerInFlight = false;
        }
    };

    reconcilerTimer = setInterval(() => {
        void tick();
    }, intervalMs);
    reconcilerTimer.unref?.();

    return stopPaymentReconciler;
}

export function stopPaymentReconciler(): void {
    if (reconcilerTimer) {
        clearInterval(reconcilerTimer);
        reconcilerTimer = null;
    }
}
