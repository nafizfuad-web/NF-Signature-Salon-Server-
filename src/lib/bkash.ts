// SalonBook — bKash Checkout (URL) sandbox adapter.
//
// Implements the documented bKash tokenized Checkout flow for mode "0011":
// grant token -> create payment -> hosted bKash checkout -> callback ->
// execute/query payment verification. Credentials come from server env only.

import mongoose from "mongoose";
import { getServerConfig, type MobileWalletConfig } from "../config/env";
import { TEST_PAYMENT_DATABASE_NAME } from "../config/payment";

export type BkashEnvironment = "TEST" | "LIVE";

export interface BkashCheckoutResult {
    paymentId: string;
    checkoutUrl: string;
    amount: number;
    currency: "BDT";
    merchantInvoiceNumber: string;
}

export interface BkashVerifiedPayment {
    paymentId: string;
    trxId: string;
    amount: number;
    currency: "BDT";
    merchantInvoiceNumber: string;
    verifiedAt: Date;
}

export class BkashAdapterError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "BkashAdapterError";
        this.status = status;
        this.code = code;
    }
}

function fail(status: number, code: string, message: string): never {
    throw new BkashAdapterError(status, code, message);
}

function config(): MobileWalletConfig | undefined {
    try {
        return getServerConfig().bkash;
    } catch {
        return undefined;
    }
}

function assertTestEnvironment(): void {
    if (process.env.NODE_ENV === "production") {
        fail(503, "bkash_disabled_in_production", "bKash payments are disabled in production.");
    }
    if ((process.env.PAYMENT_ENV ?? "").toUpperCase() !== "TEST") {
        fail(503, "payment_env_not_test", "bKash payments require PAYMENT_ENV=TEST.");
    }
    if (mongoose.connection.name !== TEST_PAYMENT_DATABASE_NAME) {
        fail(503, "not_test_database", "bKash payments require the dedicated TEST database.");
    }
}

async function requestJson<T>(
    url: string,
    init: RequestInit,
    timeoutMs = 30_000,
): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const text = await response.text();
        let parsed: unknown = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = null;
        }
        if (!response.ok) {
            const message =
                parsed && typeof parsed === "object" && "statusMessage" in parsed
                    ? String((parsed as { statusMessage?: unknown }).statusMessage)
                    : `bKash request failed with HTTP ${response.status}.`;
            fail(502, "bkash_request_failed", message);
        }
        if (!parsed || typeof parsed !== "object") {
            fail(502, "bkash_invalid_response", "bKash returned an invalid response.");
        }
        return parsed as T;
    } finally {
        clearTimeout(timeout);
    }
}

async function grantToken(cfg: MobileWalletConfig): Promise<string> {
    const base = cfg.baseUrl.replace(/\/+$/, "");
    const data = await requestJson<{ id_token?: string }>(
        `${base}/tokenized/checkout/token/grant`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                username: cfg.username,
                password: cfg.password,
            },
            body: JSON.stringify({ app_key: cfg.appKey, app_secret: cfg.appSecret }),
        },
    );
    if (!data.id_token) {
        fail(502, "bkash_token_missing", "bKash did not return an access token.");
    }
    return data.id_token;
}

function authHeaders(cfg: MobileWalletConfig, token: string): Record<string, string> {
    return {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: token,
        "X-App-Key": cfg.appKey,
    };
}

export async function createBkashCheckout(options: {
    appointmentId: string;
    merchantInvoiceNumber: string;
    amount: number;
    callbackUrl: string;
    payerReference?: string | undefined;
}): Promise<BkashCheckoutResult> {
    assertTestEnvironment();
    const cfg = config();
    if (!cfg) fail(503, "bkash_not_configured", "bKash is not configured.");
    if (!Number.isInteger(options.amount) || options.amount <= 0 || options.amount > 1_000_000) {
        fail(400, "invalid_amount", "Payment amount must be a positive whole BDT amount.");
    }

    const token = await grantToken(cfg);
    const base = cfg.baseUrl.replace(/\/+$/, "");
    const body: Record<string, string> = {
        mode: "0011",
        callbackURL: options.callbackUrl,
        amount: String(options.amount),
        currency: "BDT",
        intent: "sale",
        merchantInvoiceNumber: options.merchantInvoiceNumber,
    };
    if (options.payerReference) body.payerReference = options.payerReference;

    const data = await requestJson<{
        paymentID?: string;
        bKashURL?: string;
        bkashURL?: string;
        amount?: string;
        currency?: string;
        merchantInvoiceNumber?: string;
        statusCode?: string;
        statusMessage?: string;
    }>(`${base}/tokenized/checkout/create`, {
        method: "POST",
        headers: authHeaders(cfg, token),
        body: JSON.stringify(body),
    });

    const paymentId = data.paymentID;
    const checkoutUrl = data.bKashURL ?? data.bkashURL;
    if (!paymentId || !checkoutUrl) {
        fail(502, "bkash_checkout_missing", "bKash did not return a checkout session.");
    }
    return {
        paymentId,
        checkoutUrl,
        amount: options.amount,
        currency: "BDT",
        merchantInvoiceNumber: options.merchantInvoiceNumber,
    };
}

async function executePayment(cfg: MobileWalletConfig, token: string, paymentId: string) {
    const base = cfg.baseUrl.replace(/\/+$/, "");
    return requestJson<Record<string, unknown>>(`${base}/tokenized/checkout/execute`, {
        method: "POST",
        headers: authHeaders(cfg, token),
        body: JSON.stringify({ paymentID: paymentId }),
    });
}

async function queryPayment(cfg: MobileWalletConfig, token: string, paymentId: string) {
    const base = cfg.baseUrl.replace(/\/+$/, "");
    return requestJson<Record<string, unknown>>(`${base}/tokenized/checkout/payment/status`, {
        method: "POST",
        headers: authHeaders(cfg, token),
        body: JSON.stringify({ paymentID: paymentId }),
    });
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function amountToNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

export async function verifyBkashPayment(options: {
    paymentId: string;
    expectedAmount: number;
    expectedInvoice: string;
}): Promise<BkashVerifiedPayment> {
    assertTestEnvironment();
    const cfg = config();
    if (!cfg) fail(503, "bkash_not_configured", "bKash is not configured.");

    const token = await grantToken(cfg);
    let data: Record<string, unknown>;
    try {
        data = await executePayment(cfg, token, options.paymentId);
    } catch {
        // Execute is one-shot; if it was already executed or timed out, query status.
        data = await queryPayment(cfg, token, options.paymentId);
    }

    const status = asString(data.transactionStatus) ?? asString(data.status);
    const paymentId = asString(data.paymentID) ?? options.paymentId;
    const trxId = asString(data.trxID) ?? asString(data.trxId);
    const invoice = asString(data.merchantInvoiceNumber);
    const amount = amountToNumber(data.amount);
    const currency = asString(data.currency)?.toUpperCase();

    if (status !== "Completed" && status !== "Success" && status !== "success") {
        fail(409, "bkash_payment_not_completed", "bKash payment is not completed.");
    }
    if (!trxId) fail(502, "bkash_trx_missing", "bKash did not return a transaction id.");
    if (invoice && invoice !== options.expectedInvoice) {
        fail(409, "bkash_invoice_mismatch", "bKash invoice does not match this payment.");
    }
    if (amount !== options.expectedAmount) {
        fail(
            409,
            "bkash_amount_mismatch",
            amount === null
                ? "bKash did not return a payment amount."
                : "bKash amount does not match this payment.",
        );
    }
    if (currency !== "BDT") {
        fail(409, "bkash_currency_mismatch", "bKash currency must be BDT.");
    }

    return {
        paymentId,
        trxId,
        amount: options.expectedAmount,
        currency: "BDT",
        merchantInvoiceNumber: options.expectedInvoice,
        verifiedAt: new Date(),
    };
}
