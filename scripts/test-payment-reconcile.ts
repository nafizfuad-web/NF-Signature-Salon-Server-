// Non-database reconciliation decision checks.
// Run with: npx tsx scripts/test-payment-reconcile.ts

import assert from "node:assert/strict";
import {
    canReconcileTestPaymentsInEnvironment,
    decidePaidRepairAction,
    decideReconcileAction,
    isCanonicalTestSettledTransaction,
    isReconcileLeaseExpired,
    reconcileFenceIsCurrent,
    reconcileLeaseUntil,
    shouldAbortForRetryLimit,
} from "../src/lib/paymentReconciliation";

const now = new Date("2026-01-01T00:00:00.000Z");

// Lease expiry drives concurrency-safe claiming.
assert.equal(isReconcileLeaseExpired(undefined, now), true);
assert.equal(isReconcileLeaseExpired(null, now), true);
assert.equal(isReconcileLeaseExpired(new Date(now.getTime() - 1), now), true);
assert.equal(isReconcileLeaseExpired(new Date(now.getTime() + 1), now), false);
assert.equal(reconcileLeaseUntil(now, 30_000).getTime(), now.getTime() + 30_000);

// Retry limits stop endless reconciliation attempts.
assert.equal(shouldAbortForRetryLimit(4, 5), false);
assert.equal(shouldAbortForRetryLimit(5, 5), true);
assert.equal(shouldAbortForRetryLimit(6, 5), true);

// Interrupted success with unpaid appointment retries success settlement.
assert.equal(
    decideReconcileAction({
        transaction: {
            paymentStatus: "pending",
            settlementState: "in_progress",
            settlementOutcome: "success",
        },
        appointment: { paymentStatus: "pending" },
        canonicalSettled: false,
    }),
    "settle_success",
);

// Interrupted success after appointment commit retries finalization.
assert.equal(
    decideReconcileAction({
        transaction: {
            paymentStatus: "pending",
            settlementState: "in_progress",
            settlementOutcome: "success",
        },
        appointment: { paymentStatus: "paid" },
        canonicalSettled: false,
    }),
    "settle_success",
);

// Duplicate success is idempotent when already committed and canonical exists.
assert.equal(
    decideReconcileAction({
        transaction: {
            paymentStatus: "succeeded",
            settlementState: "committed",
            settlementOutcome: "success",
        },
        appointment: { paymentStatus: "paid" },
        canonicalSettled: true,
    }),
    "skip",
);

// A canonical settled transaction wins over an interrupted duplicate.
assert.equal(
    decideReconcileAction({
        transaction: {
            paymentStatus: "pending",
            settlementState: "in_progress",
            settlementOutcome: "success",
        },
        appointment: { paymentStatus: "paid" },
        canonicalSettled: true,
    }),
    "repair_paid",
);

// Interrupted failure/cancelled retries terminal settlement.
assert.equal(
    decideReconcileAction({
        transaction: {
            paymentStatus: "processing",
            settlementState: "in_progress",
            settlementOutcome: "failed",
        },
        appointment: { paymentStatus: "pending" },
        canonicalSettled: false,
    }),
    "settle_failure",
);
assert.equal(
    decideReconcileAction({
        transaction: {
            paymentStatus: "pending",
            settlementState: "in_progress",
            settlementOutcome: "cancelled",
        },
        appointment: { paymentStatus: "pending" },
        canonicalSettled: false,
    }),
    "settle_failure",
);

// Inconsistent states abort safely instead of marking paid without canonical tx.
assert.equal(
    decideReconcileAction({
        transaction: {
            paymentStatus: "pending",
            settlementState: "in_progress",
            settlementOutcome: null,
        },
        appointment: { paymentStatus: "unpaid" },
        canonicalSettled: false,
    }),
    "abort",
);
assert.equal(
    decideReconcileAction({
        transaction: {
            paymentStatus: "failed",
            settlementState: "in_progress",
            settlementOutcome: "failed",
        },
        appointment: { paymentStatus: "paid" },
        canonicalSettled: false,
    }),
    "abort",
);
assert.equal(
    decideReconcileAction({
        transaction: {
            paymentStatus: "pending",
            settlementState: "in_progress",
            settlementOutcome: "success",
        },
        appointment: null,
        canonicalSettled: false,
    }),
    "abort",
);

// Paid appointments are repaired only for TEST-scoped records.
assert.equal(
    decidePaidRepairAction({
        appointmentPaymentStatus: "paid",
        paymentMethodIsTest: true,
        hasTestHistory: false,
        canonicalSettled: false,
    }),
    "unpay",
);
assert.equal(
    decidePaidRepairAction({
        appointmentPaymentStatus: "paid",
        paymentMethodIsTest: false,
        hasTestHistory: false,
        canonicalSettled: false,
    }),
    "skip",
);
assert.equal(
    decidePaidRepairAction({
        appointmentPaymentStatus: "paid",
        paymentMethodIsTest: true,
        hasTestHistory: true,
        canonicalSettled: true,
    }),
    "repair_canonical",
);
assert.equal(
    decidePaidRepairAction({
        appointmentPaymentStatus: "unpaid",
        paymentMethodIsTest: true,
        hasTestHistory: true,
        canonicalSettled: false,
    }),
    "skip",
);

// Canonical lookup requires TEST simulated settled transactions for the appointment.
assert.equal(
    isCanonicalTestSettledTransaction(
        {
            environment: "TEST",
            simulated: true,
            paymentStatus: "succeeded",
            settledAppointmentId: "appt1",
        },
        "appt1",
    ),
    true,
);
assert.equal(
    isCanonicalTestSettledTransaction(
        {
            environment: "LIVE",
            simulated: false,
            paymentStatus: "succeeded",
            settledAppointmentId: "appt1",
        },
        "appt1",
    ),
    false,
);
assert.equal(
    isCanonicalTestSettledTransaction(
        {
            environment: "TEST",
            simulated: true,
            paymentStatus: "pending",
            settledAppointmentId: "appt1",
        },
        "appt1",
    ),
    false,
);
assert.equal(
    isCanonicalTestSettledTransaction(
        {
            environment: "TEST",
            simulated: true,
            paymentStatus: "succeeded",
            settledAppointmentId: "appt2",
        },
        "appt1",
    ),
    false,
);

// Reconciliation is confined to the dedicated test database.
assert.equal(
    canReconcileTestPaymentsInEnvironment("nf_signature_salon_test", "development"),
    true,
);
assert.equal(
    canReconcileTestPaymentsInEnvironment("salonbook", "development"),
    false,
);
assert.equal(
    canReconcileTestPaymentsInEnvironment("nf_signature_salon_test", "production"),
    false,
);

// Expired worker cannot finalize after another worker claims the lease.
const fence = { workerId: "worker-old", leaseUntil: new Date(now.getTime() + 30_000) };
assert.equal(reconcileFenceIsCurrent(fence, "worker-old", fence.leaseUntil, now), true);
assert.equal(reconcileFenceIsCurrent(fence, "worker-new", fence.leaseUntil, now), false);
assert.equal(
    reconcileFenceIsCurrent(
        fence,
        "worker-old",
        new Date(now.getTime() + 60_000),
        now,
    ),
    false,
);
assert.equal(
    reconcileFenceIsCurrent(
        { workerId: "worker-old", leaseUntil: new Date(now.getTime() - 1) },
        "worker-old",
        new Date(now.getTime() - 1),
        now,
    ),
    false,
);

console.log("payment-reconcile checks passed");
