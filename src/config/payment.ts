// SalonBook — payment method catalogue and runtime availability.
//
// The internal simulator remains restricted to a dedicated non-production TEST
// database. Real Stripe Checkout is only available when a valid test key (or an
// explicitly opted-in live key) is configured. bKash and Nagad adapters are
// configured but intentionally report that provider approval/integration is
// still required instead of pretending a payment succeeded.

import mongoose from "mongoose";
import { getServerConfig, type ServerConfig } from "./env";

export const PAYMENT_METHOD_IDS = [
    "stripe",
    "bkash",
    "nagad",
    "stripe_demo",
    "bkash_demo",
    "nagad_demo",
    "pay_at_salon",
] as const;

export type PaymentMethodId = (typeof PAYMENT_METHOD_IDS)[number];

export const TEST_PAYMENT_DATABASE_NAME = "nf_signature_salon_test";
const SIMULATOR_DATABASE_NAMES = new Set([TEST_PAYMENT_DATABASE_NAME, "test"]);

export const SIMULATED_PAYMENT_METHOD_IDS = [
    "stripe_demo",
    "bkash_demo",
    "nagad_demo",
] as const satisfies readonly PaymentMethodId[];

export interface PaymentMethodDefinition {
    id: PaymentMethodId;
    label: string;
    provider: "internal_simulator" | "salon_cash" | "stripe" | "bkash" | "nagad";
    requiresSimulation: boolean;
    mode: "real" | "simulated" | "cash";
}

export const PAYMENT_METHODS: readonly PaymentMethodDefinition[] = [
    {
        id: "stripe",
        label: "Card via Stripe",
        provider: "stripe",
        requiresSimulation: false,
        mode: "real",
    },
    {
        id: "bkash",
        label: "bKash",
        provider: "bkash",
        requiresSimulation: false,
        mode: "real",
    },
    {
        id: "nagad",
        label: "Nagad",
        provider: "nagad",
        requiresSimulation: false,
        mode: "real",
    },
    {
        id: "stripe_demo",
        label: "Stripe Demo",
        provider: "internal_simulator",
        requiresSimulation: true,
        mode: "simulated",
    },
    {
        id: "bkash_demo",
        label: "bKash Demo",
        provider: "internal_simulator",
        requiresSimulation: true,
        mode: "simulated",
    },
    {
        id: "nagad_demo",
        label: "Nagad Demo",
        provider: "internal_simulator",
        requiresSimulation: true,
        mode: "simulated",
    },
    {
        id: "pay_at_salon",
        label: "Pay at Salon",
        provider: "salon_cash",
        requiresSimulation: false,
        mode: "cash",
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

export interface PaymentMethodAvailability {
    id: PaymentMethodId;
    label: string;
    provider: PaymentMethodDefinition["provider"];
    mode: PaymentMethodDefinition["mode"];
    requiresSimulation: boolean;
    available: boolean;
    reason: string | null;
    simulated: boolean;
    environment: "TEST" | "LIVE";
    currency: "BDT";
}

export interface PaymentMethodsPayload {
    enabled: boolean;
    environment: "TEST" | "LIVE";
    currency: "BDT";
    amount: number | null;
    amountBasis: "configured_test_demo";
    simulated: boolean;
    methods: PaymentMethodAvailability[];
    reason: string | null;
}

function readDemoAmount(): number | null {
    const raw = process.env.PAYMENT_TEST_DEMO_AMOUNT_BDT?.trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value) || value > 1_000_000) {
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
    if (!SIMULATOR_DATABASE_NAMES.has(databaseName)) {
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

function loadValidatedConfig(): ServerConfig | undefined {
    try {
        return getServerConfig();
    } catch {
        return undefined;
    }
}

function isSandboxProviderEnvironment(databaseName: string): boolean {
    return (
        (process.env.NODE_ENV ?? "development") !== "production" &&
        (process.env.PAYMENT_ENV ?? "").toUpperCase() === "TEST" &&
        databaseName === TEST_PAYMENT_DATABASE_NAME
    );
}

function rawStripeMode(): "TEST" | "LIVE" | null {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    if (!key) return null;
    if (key.startsWith("sk_test_")) return "TEST";
    if (key.startsWith("sk_live_")) return "LIVE";
    return null;
}

export function getPaymentMethodAvailability(
    databaseName: string = mongoose.connection.name,
): PaymentMethodAvailability[] {
    const simulator = getPaymentConfig(databaseName);
    const serverConfig = loadValidatedConfig();
    const stripeMode = serverConfig?.stripe?.mode ?? rawStripeMode();

    const unavailableReason = (method: PaymentMethodDefinition): string | null => {
        if (method.mode === "simulated") {
            if (simulator.enabled) return null;
            return simulator.reason ?? "simulator_disabled";
        }
        if (method.mode === "cash") {
            return simulator.enabled
                ? null
                : (simulator.reason ?? "simulator_disabled");
        }
        if (method.id === "stripe") {
            if (serverConfig?.stripe) {
                return serverConfig.stripe.mode === "TEST"
                    ? null
                    : "stripe_live_payments_not_enabled";
            }
            if (rawStripeMode() === "LIVE") return "stripe_live_payments_not_enabled";
            if (rawStripeMode()) return "stripe_configuration_incomplete";
            return "stripe_not_configured";
        }
        if (method.id === "bkash") {
            if (!serverConfig?.bkash) return "bkash_not_configured";
            return isSandboxProviderEnvironment(databaseName)
                ? null
                : "bkash_sandbox_only";
        }
        if (method.id === "nagad") {
            return serverConfig?.nagad && isSandboxProviderEnvironment(databaseName)
                ? "nagad_sandbox_credentials_required"
                : serverConfig?.nagad
                  ? "nagad_sandbox_only"
                  : "nagad_not_configured";
        }
        return "payment_method_unavailable";
    };

    return PAYMENT_METHODS.map((method) => {
        const reason = unavailableReason(method);
        return {
            id: method.id,
            label: method.label,
            provider: method.provider,
            mode: method.mode,
            requiresSimulation: method.requiresSimulation,
            available: reason === null,
            reason,
            simulated: method.mode === "simulated",
            environment:
                method.mode === "real" && stripeMode === "LIVE" ? "LIVE" : "TEST",
            currency: "BDT" as const,
        };
    });
}

export function isPaymentMethodId(value: unknown): value is PaymentMethodId {
    return (
        typeof value === "string" &&
        (PAYMENT_METHOD_IDS as readonly string[]).includes(value)
    );
}

export function getPaymentMethodDefinition(
    id: PaymentMethodId,
): PaymentMethodDefinition {
    const method = PAYMENT_METHODS.find((candidate) => candidate.id === id);
    if (!method) {
        throw new Error("Unknown payment method.");
    }
    return method;
}

export function isSimulatedPaymentMethod(id: PaymentMethodId): boolean {
    return (SIMULATED_PAYMENT_METHOD_IDS as readonly string[]).includes(id);
}

export function getPaymentMethodsPayload(
    databaseName: string = mongoose.connection.name,
): PaymentMethodsPayload {
    const simulator = getPaymentConfig(databaseName);
    const methods = getPaymentMethodAvailability(databaseName);
    const availableMethods = methods.filter((method) => method.available);
    const environment = methods.some(
        (method) => method.id === "stripe" && method.environment === "LIVE",
    )
        ? "LIVE"
        : "TEST";
    const reason =
        availableMethods.length > 0
            ? null
            : methods.find((method) => method.reason)?.reason ??
              simulator.reason ??
              "no_payment_methods_available";

    return {
        enabled: availableMethods.length > 0,
        environment,
        currency: "BDT",
        amount: simulator.amount,
        amountBasis: "configured_test_demo",
        simulated:
            availableMethods.length > 0 &&
            availableMethods.every((method) => method.simulated),
        methods,
        reason,
    };
}
