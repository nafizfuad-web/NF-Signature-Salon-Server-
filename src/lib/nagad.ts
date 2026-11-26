// SalonBook — Nagad sandbox adapter boundary.
//
// Nagad's official merchant integration requires merchant-issued RSA keys,
// a whitelisted server IP, signed/encrypted initialize/complete/verify calls,
// and Nagad-issued sandbox credentials. Those materials are not publicly
// available, so this adapter intentionally fails closed instead of inventing
// API details or simulating success.

import { getServerConfig } from "../config/env";

export class NagadAdapterError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "NagadAdapterError";
        this.status = status;
        this.code = code;
    }
}

function fail(status: number, code: string, message: string): never {
    throw new NagadAdapterError(status, code, message);
}

export function isNagadConfigured(): boolean {
    try {
        return Boolean(getServerConfig().nagad);
    } catch {
        return false;
    }
}

export async function createNagadCheckout(_options: {
    appointmentId: string;
    orderId: string;
    amount: number;
    callbackUrl: string;
}): Promise<never> {
    if (!isNagadConfigured()) {
        fail(503, "nagad_not_configured", "Nagad is not configured.");
    }
    fail(
        503,
        "nagad_sandbox_credentials_required",
        "Nagad sandbox merchant credentials and the official API contract are required before checkout can be enabled.",
    );
}

export async function verifyNagadPayment(_options: {
    paymentRefId: string;
    expectedAmount: number;
    expectedOrderId: string;
}): Promise<never> {
    if (!isNagadConfigured()) {
        fail(503, "nagad_not_configured", "Nagad is not configured.");
    }
    fail(
        503,
        "nagad_sandbox_credentials_required",
        "Nagad sandbox merchant credentials and the official API contract are required before verification can be enabled.",
    );
}
