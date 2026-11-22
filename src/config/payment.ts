// SalonBook — TEST-only payment configuration.
//
// This phase implements an internal simulator only. It never talks to Stripe,
// bKash, Nagad, or any real payment provider and never charges real money.

import mongoose from "mongoose";

export const PAYMENT_METHOD_IDS = [
    "stripe_demo",
    "bkash_demo",
    "nagad_demo",
    "pay_at_salon",
] as const;

export type PaymentMethodId = (typeof PAYMENT_METHOD_IDS)[number];

export const TEST_PAYMENT_DATABASE_NAME = "nf_signature_salon_test";

export interface PaymentMethodDefinition {
    id: PaymentMethodId;
    label: string;
    provider: "internal_simulator" | "salon_cash";
    requiresSimulation: boolean;
}

export const PAYMENT_METHODS: readonly PaymentMethodDefinition[] = [
    {
        id: "stripe_demo",
        label: "Stripe Demo",
        provider: "internal_simulator",
        requiresSimulation: true,
    },
    {
        id: "bkash_demo",
        label: "bKash Demo",
        provider: "internal_simulator",
        requiresSimulation: true,
    },
    {
        id: "nagad_demo",
        label: "Nagad Demo",
        provider: "internal_simulator",
        requiresSimulation: true,
    },
    {
        id: "pay_at_salon",
        label: "Pay at Salon Demo",
        provider: "salon_cash",
        requiresSimulation: false,
    },
] as const;

export interface PaymentRuntimeConfig {
    enabled: boolean;
    environment: "TEST";
    simulatorEnabled: boolean;
    amount: number | null;
    currency: "BDT";
    amountBasis: "configured_test_demo";
    reason: string | null;
}

export interface PaymentMethodsPayload {
    enabled: boolean;
    environment: "TEST";
    currency: "BDT";
    amount: number | null;
    amountBasis: "configured_test_demo";
    simulated: true;
    methods: Array<{
        id: PaymentMethodId;
        label: string;
        provider: PaymentMethodDefinition["provider"];
        requiresSimulation: boolean;
        simulated: true;
        environment: "TEST";
        currency: "BDT";
    }>;
    reason: string | null;
}

function readDemoAmount(): number | null {
    const raw = process.env.PAYMENT_TEST_DEMO_AMOUNT_BDT?.trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
        return null;
    }
    return value;
}

export function getPaymentConfig(
    databaseName: string = mongoose.connection.name,
): PaymentRuntimeConfig {
    const nodeEnv = process.env.NODE_ENV?.trim() || "development";
    const paymentEnv = process.env.PAYMENT_ENV?.trim().toUpperCase() || "";
    const simulatorEnabled =
        process.env.PAYMENT_SIMULATOR_ENABLED?.trim().toLowerCase() === "true";
    const amount = readDemoAmount();

    if (nodeEnv === "production") {
        return {
            enabled: false,
            environment: "TEST",
            simulatorEnabled,
            amount,
            currency: "BDT",
            amountBasis: "configured_test_demo",
            reason: "disabled_in_production",
        };
    }
    if (databaseName !== TEST_PAYMENT_DATABASE_NAME) {
        return {
            enabled: false,
            environment: "TEST",
            simulatorEnabled,
            amount,
            currency: "BDT",
            amountBasis: "configured_test_demo",
            reason: "not_test_database",
        };
    }
    if (paymentEnv !== "TEST") {
        return {
            enabled: false,
            environment: "TEST",
            simulatorEnabled,
            amount,
            currency: "BDT",
            amountBasis: "configured_test_demo",
            reason: "payment_env_not_test",
        };
    }
    if (!simulatorEnabled) {
        return {
            enabled: false,
            environment: "TEST",
            simulatorEnabled,
            amount,
            currency: "BDT",
            amountBasis: "configured_test_demo",
            reason: "simulator_disabled",
        };
    }
    if (amount === null) {
        return {
            enabled: false,
            environment: "TEST",
            simulatorEnabled,
            amount: null,
            currency: "BDT",
            amountBasis: "configured_test_demo",
            reason: "demo_amount_not_configured",
        };
    }

    return {
        enabled: true,
        environment: "TEST",
        simulatorEnabled,
        amount,
        currency: "BDT",
        amountBasis: "configured_test_demo",
        reason: null,
    };
}

export function isPaymentMethodId(value: unknown): value is PaymentMethodId {
    return (
        typeof value === "string" &&
        (PAYMENT_METHOD_IDS as readonly string[]).includes(value)
    );
}

export function getPaymentMethodsPayload(
    databaseName: string = mongoose.connection.name,
): PaymentMethodsPayload {
    const config = getPaymentConfig(databaseName);
    if (!config.enabled || config.amount === null) {
        return {
            enabled: false,
            environment: "TEST",
            currency: "BDT",
            amount: config.amount,
            amountBasis: "configured_test_demo",
            simulated: true,
            methods: [],
            reason: config.reason,
        };
    }

    return {
        enabled: true,
        environment: "TEST",
        currency: "BDT",
        amount: config.amount,
        amountBasis: "configured_test_demo",
        simulated: true,
        methods: PAYMENT_METHODS.map((method) => ({
            id: method.id,
            label: method.label,
            provider: method.provider,
            requiresSimulation: method.requiresSimulation,
            simulated: true as const,
            environment: "TEST" as const,
            currency: "BDT" as const,
        })),
        reason: null,
    };
}
