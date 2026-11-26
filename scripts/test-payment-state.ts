// Non-database TEST payment rule checks.
// Run with: npx tsx scripts/test-payment-state.ts

import assert from "node:assert/strict";
import {
    getPaymentConfig,
    getPaymentMethodsPayload,
    isPaymentMethodId,
} from "../src/config/payment";
import {
    appointmentPaymentStatusForTransaction,
    canSimulateTransaction,
    isActivePaymentStatus,
    isSettledPaymentStatus,
    isTerminalPaymentStatus,
} from "../src/lib/paymentState";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(vars)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return fn();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

// Payment methods are clearly labelled TEST/demo methods.
assert.equal(isPaymentMethodId("stripe_demo"), true);
assert.equal(isPaymentMethodId("bkash_demo"), true);
assert.equal(isPaymentMethodId("nagad_demo"), true);
assert.equal(isPaymentMethodId("pay_at_salon"), true);
assert.equal(isPaymentMethodId("stripe"), true);
assert.equal(isPaymentMethodId("bkash"), true);
assert.equal(isPaymentMethodId("nagad"), true);
assert.equal(isPaymentMethodId("cash"), false);
assert.equal(isPaymentMethodId(""), false);

// Simulator is disabled unless explicitly enabled in TEST non-production.
withEnv(
    {
        NODE_ENV: "development",
        PAYMENT_ENV: "TEST",
        PAYMENT_SIMULATOR_ENABLED: "true",
        PAYMENT_TEST_DEMO_AMOUNT_BDT: "500",
    },
    () => {
        const config = getPaymentConfig("nf_signature_salon_test");
        assert.equal(config.enabled, true);
        assert.equal(config.amount, 500);
        assert.equal(config.currency, "BDT");
        const payload = getPaymentMethodsPayload("nf_signature_salon_test");
        assert.equal(payload.enabled, true);
        assert.equal(payload.environment, "TEST");
        assert.equal(payload.methods.length, 7);
        const available = payload.methods.filter((method) => method.available);
        assert.equal(available.length, 4);
        assert.equal(
            available
                .filter((method) => method.id.endsWith("_demo"))
                .every((method) => method.simulated && method.environment === "TEST"),
            true,
        );
        assert.equal(
            available.find((method) => method.id === "pay_at_salon")?.mode,
            "cash",
        );
        assert.equal(payload.methods.some((m) => m.requiresSimulation), true);
    },
);

withEnv(
    {
        NODE_ENV: "production",
        PAYMENT_ENV: "TEST",
        PAYMENT_SIMULATOR_ENABLED: "true",
        PAYMENT_TEST_DEMO_AMOUNT_BDT: "500",
    },
    () => {
        const config = getPaymentConfig("nf_signature_salon_test");
        assert.equal(config.enabled, false);
        assert.equal(config.reason, "disabled_in_production");
        const payload = getPaymentMethodsPayload("nf_signature_salon_test");
        assert.equal(payload.enabled, false);
        assert.equal(payload.methods.some((method) => method.available), false);
    },
);

withEnv(
    {
        NODE_ENV: "development",
        PAYMENT_ENV: "LIVE",
        PAYMENT_SIMULATOR_ENABLED: "true",
        PAYMENT_TEST_DEMO_AMOUNT_BDT: "500",
    },
    () => {
        assert.equal(getPaymentConfig("nf_signature_salon_test").enabled, false);
    },
);

withEnv(
    {
        NODE_ENV: "development",
        PAYMENT_ENV: "TEST",
        PAYMENT_SIMULATOR_ENABLED: "false",
        PAYMENT_TEST_DEMO_AMOUNT_BDT: "500",
    },
    () => {
        assert.equal(getPaymentConfig("nf_signature_salon_test").enabled, false);
    },
);

withEnv(
    {
        NODE_ENV: "development",
        PAYMENT_ENV: "TEST",
        PAYMENT_SIMULATOR_ENABLED: "true",
        PAYMENT_TEST_DEMO_AMOUNT_BDT: "not-a-number",
    },
    () => {
        assert.equal(getPaymentConfig("nf_signature_salon_test").enabled, false);
    },
);

withEnv(
    {
        NODE_ENV: "development",
        PAYMENT_ENV: "TEST",
        PAYMENT_SIMULATOR_ENABLED: "true",
        PAYMENT_TEST_DEMO_AMOUNT_BDT: "500",
    },
    () => {
        const config = getPaymentConfig("salonbook");
        assert.equal(config.enabled, false);
        assert.equal(config.reason, "not_test_database");
    },
);

// Status helpers match the approved state model.
assert.equal(isActivePaymentStatus("pending"), true);
assert.equal(isActivePaymentStatus("processing"), true);
assert.equal(isActivePaymentStatus("cash_pending"), true);
assert.equal(isActivePaymentStatus("succeeded"), false);
assert.equal(isSettledPaymentStatus("succeeded"), true);
assert.equal(isSettledPaymentStatus("cash_received"), true);
assert.equal(isTerminalPaymentStatus("failed"), true);
assert.equal(isTerminalPaymentStatus("cancelled"), true);
assert.equal(appointmentPaymentStatusForTransaction("pending"), "pending");
assert.equal(appointmentPaymentStatusForTransaction("cash_pending"), "pending");
assert.equal(appointmentPaymentStatusForTransaction("succeeded"), "paid");
assert.equal(appointmentPaymentStatusForTransaction("cash_received"), "paid");
assert.equal(appointmentPaymentStatusForTransaction("failed"), "unpaid");
assert.equal(appointmentPaymentStatusForTransaction("cancelled"), "unpaid");

// Only demo gateway transactions may be simulated; cash stays admin-confirmed.
assert.equal(
    canSimulateTransaction({
        paymentMethod: "stripe_demo",
        paymentStatus: "pending",
        environment: "TEST",
        simulated: true,
    }),
    true,
);
assert.equal(
    canSimulateTransaction({
        paymentMethod: "pay_at_salon",
        paymentStatus: "cash_pending",
        environment: "TEST",
        simulated: true,
    }),
    false,
);
assert.equal(
    canSimulateTransaction({
        paymentMethod: "bkash_demo",
        paymentStatus: "cash_pending",
        environment: "TEST",
        simulated: true,
    }),
    false,
);

console.log("payment-state checks passed");
