// SalonBook — Stripe Checkout integration (TEST mode).
//
// Creates server-side Stripe Checkout sessions and handles Stripe webhook
// events. Never trusts payment success information sent only by the frontend.
// All payment state changes are driven by verified Stripe webhook events.

import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import Stripe from "stripe";
import mongoose, { type Types } from "mongoose";
import Appointment from "../models/Appointment";
import Service from "../models/Service";
import Transaction from "../models/Transaction";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import WebhookEvent from "../models/WebhookEvent";
import type { AuthRequest } from "../middleware/authMiddleware";
import { getServerConfig } from "../config/env";
import { formatAppointment, formatTransaction } from "../lib/serializers";
import {
    isPaymentStateError,
    settleTransactionSuccess,
    type TransactionLean,
} from "../lib/paymentState";
import {
    asRecord,
    isDuplicateKeyError,
    isValidObjectId,
} from "../lib/validation";
import { sendPaymentReceiptEmail } from "../lib/email";

let stripe: Stripe | undefined;

function getStripeClient(): Stripe | null {
    const config = getServerConfig();
    if (!config.stripe) return null;
    if (!stripe) {
        stripe = new Stripe(config.stripe.secretKey);
    }
    return stripe;
}

function fail(res: Response, status: number, message: string): void {
    res.status(status).json({ success: false, message });
}

function ensureSessionIdPlaceholder(url: string): string {
    if (url.includes("{CHECKOUT_SESSION_ID}")) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}session_id={CHECKOUT_SESSION_ID}`;
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

async function loadActiveTransaction(
    appointmentId: Types.ObjectId | string,
): Promise<TransactionLean | null> {
    return (await Transaction.findOne({
        appointment: appointmentId,
        paymentStatus: { $in: ["pending", "processing"] },
    })
        .sort({ createdAt: -1 })
        .lean()) as TransactionLean | null;
}

// POST /api/payments/stripe/session
export async function createStripeCheckoutSession(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }

        const stripeClient = getStripeClient();
        if (!stripeClient) {
            fail(res, 503, "Stripe is not configured on this server.");
            return;
        }

        const config = getServerConfig();
        if (!config.stripe || config.stripe.mode !== "TEST") {
            fail(res, 503, "Stripe is only enabled in TEST mode.");
            return;
        }

        const appointmentId = req.params.appointmentId;
        if (!isValidObjectId(appointmentId)) {
            fail(res, 404, "We could not find that appointment.");
            return;
        }

        const body = asRecord(req.body);
        const successUrl = ensureSessionIdPlaceholder(
            typeof body?.successUrl === "string" && body.successUrl
                ? body.successUrl
                : config.stripe.successUrl,
        );
        const cancelUrl = typeof body?.cancelUrl === "string" && body.cancelUrl
            ? body.cancelUrl
            : config.stripe.cancelUrl;

        const appointment = (await Appointment.findOne({
            _id: appointmentId,
            customer: req.userId,
        }).lean()) as {
            _id: Types.ObjectId;
            customer: Types.ObjectId;
            service?: Types.ObjectId;
            serviceTitle: string;
            category?: string;
            date: string;
            time: string;
            price?: string;
            priceAmount?: number;
            status: string;
            paymentStatus?: string;
        } | null;
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

        const existingActive = await loadActiveTransaction(appointment._id);
        if (existingActive) {
            res.status(200).json({
                success: true,
                idempotentReplay: true,
                data: {
                    transaction: formatTransaction(existingActive),
                    checkoutUrl: existingActive.checkoutUrl ?? null,
                    sessionId: existingActive.providerSessionId ?? null,
                },
            });
            return;
        }

        const customer = await User.findById(req.userId).select("name email");
        if (!customer) {
            fail(res, 401, "Your session is no longer valid. Please sign in again.");
            return;
        }

        let amount = appointment.priceAmount ?? 0;
        if (!amount && appointment.service) {
            const service = (await Service.findById(appointment.service)
                .select("priceAmount")
                .lean()) as { priceAmount?: number } | null;
            amount = service?.priceAmount ?? 0;
        }
        if (!Number.isInteger(amount) || amount < 1) {
            fail(res, 409, "This appointment has no chargeable amount.");
            return;
        }

        const idempotencyKey = `stripe_${appointment._id}_${customer._id}`;

        const session = await stripeClient.checkout.sessions.create({
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "bdt",
                        product_data: {
                            name: appointment.serviceTitle,
                            ...(appointment.category
                                ? { description: `Category: ${appointment.category}` }
                                : {}),
                        },
                        unit_amount: amount * 100,
                    },
                    quantity: 1,
                },
            ],
            success_url: successUrl,
            cancel_url: cancelUrl,
            customer_email: customer.email,
            client_reference_id: String(appointment._id),
            metadata: {
                appointmentId: String(appointment._id),
                customerId: String(customer._id),
                serviceTitle: appointment.serviceTitle,
            },
        }, {
            idempotencyKey,
        });

        const transactionData = {
            appointment: appointment._id,
            customer: appointment.customer,
            ...(appointment.service ? { service: appointment.service } : {}),
            serviceTitle: appointment.serviceTitle,
            appointmentDate: appointment.date,
            appointmentTime: appointment.time,
            ...(appointment.price ? { displayPrice: appointment.price } : {}),
            amount,
            currency: "BDT" as const,
            amountBasis: "service_price" as const,
            paymentMethod: "stripe" as const,
            provider: "stripe" as const,
            providerReference: session.id,
            providerSessionId: session.id,
            ...(session.url ? { checkoutUrl: session.url } : {}),
            paymentStatus: "pending" as const,
            environment: "TEST" as const,
            simulated: false,
            settlementState: "idle" as const,
            settlementAttempts: 0,
            activeAppointmentId: appointment._id,
        } as unknown as Parameters<typeof Transaction.create>[0];

        const created = await Transaction.create(transactionData);
        const createdId = (created as { _id: Types.ObjectId })._id;

        await Appointment.findOneAndUpdate(
            {
                _id: appointment._id,
                status: "confirmed",
                paymentStatus: { $ne: "paid" },
            },
            {
                $set: {
                    paymentStatus: "pending",
                    paymentMethod: "stripe",
                    latestTransactionId: createdId,
                },
                $unset: { paidAt: 1 },
            },
            { new: true, lean: true },
        );

        res.status(201).json({
            success: true,
            idempotentReplay: false,
            data: {
                transaction: formatTransaction(created),
                checkoutUrl: session.url,
                sessionId: session.id,
            },
        });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            const appointmentId = req.params.appointmentId;
            const replay = isValidObjectId(appointmentId)
                ? await loadActiveTransaction(appointmentId)
                : null;
            if (replay) {
                res.status(200).json({
                    success: true,
                    idempotentReplay: true,
                    data: {
                        transaction: formatTransaction(replay),
                        checkoutUrl: replay.checkoutUrl ?? null,
                        sessionId: replay.providerSessionId ?? null,
                    },
                });
                return;
            }
        }
        if (handlePaymentError(res, error)) return;
        logFailure("Stripe checkout session creation failed.", error);
        fail(res, 500, "Unable to create Stripe checkout session right now.");
    }
}

// POST /api/payments/stripe/webhook
export async function stripeWebhook(
    req: Request,
    res: Response,
): Promise<void> {
    const stripeClient = getStripeClient();
    if (!stripeClient) {
        fail(res, 503, "Stripe is not configured on this server.");
        return;
    }

    const config = getServerConfig();
    const webhookSecret = config.stripe?.webhookSecret;
    if (!webhookSecret) {
        fail(res, 503, "Stripe webhook is not configured.");
        return;
    }

    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") {
        fail(res, 400, "Missing Stripe signature header.");
        return;
    }

    let event: Stripe.Event;
    try {
        event = stripeClient.webhooks.constructEvent(
            req.body as unknown as Buffer,
            signature,
            webhookSecret,
        );
    } catch (error) {
        logFailure("Stripe webhook signature verification failed.", error);
        fail(res, 400, "Invalid Stripe webhook signature.");
        return;
    }

    // Idempotency: claim the Stripe event before processing it. A failed claim
    // may be retried; processed/ignored/in-flight events are duplicates.
    const payloadHash = createHash("sha256")
        .update(req.body as Buffer)
        .digest("hex");
    let claimedWebhookId: Types.ObjectId | null = null;
    try {
        const createdEvent = await WebhookEvent.create({
            provider: "stripe",
            eventId: event.id,
            type: event.type,
            status: "processing",
            payloadHash,
        });
        claimedWebhookId = (createdEvent as { _id: Types.ObjectId })._id;
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existingEvent = await WebhookEvent.findOne({
            provider: "stripe",
            eventId: event.id,
        }).lean();
        if (
            !existingEvent ||
            existingEvent.status === "processed" ||
            existingEvent.status === "ignored" ||
            existingEvent.status === "processing"
        ) {
            res.status(200).json({ received: true, duplicate: true });
            return;
        }
        if (existingEvent.status === "failed") {
            await WebhookEvent.updateOne(
                { _id: existingEvent._id, status: "failed" },
                { $set: { status: "processing", error: null } },
            );
            claimedWebhookId = existingEvent._id as Types.ObjectId;
        } else {
            res.status(200).json({ received: true, duplicate: true });
            return;
        }
    }

    let handled = false;
    try {
        switch (event.type) {
            case "checkout.session.completed": {
                handled = true;
                await handleCheckoutSessionCompleted(
                    event.data.object as Stripe.Checkout.Session,
                    event.id,
                );
                break;
            }
            case "checkout.session.expired": {
                handled = true;
                await handleCheckoutSessionExpired(event.data.object as Stripe.Checkout.Session);
                break;
            }
            case "payment_intent.payment_failed": {
                handled = true;
                await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
                break;
            }
            case "payment_intent.canceled": {
                handled = true;
                await handlePaymentCanceled(event.data.object as Stripe.PaymentIntent);
                break;
            }
            case "charge.refunded": {
                handled = true;
                await handleChargeRefunded(event.data.object as Stripe.Charge);
                break;
            }
            default:
                // Unhandled event types are acknowledged but not processed.
                break;
        }

        if (claimedWebhookId) {
            await WebhookEvent.updateOne(
                { _id: claimedWebhookId },
                {
                    $set: {
                        status: handled ? "processed" : "ignored",
                        processedAt: new Date(),
                    },
                    $unset: { error: 1 },
                },
            );
        }
        res.status(200).json({ received: true });
    } catch (error) {
        if (claimedWebhookId) {
            await WebhookEvent.updateOne(
                { _id: claimedWebhookId },
                {
                    $set: {
                        status: "failed",
                        error:
                            error instanceof Error
                                ? error.message.slice(0, 500)
                                : "Webhook handling failed.",
                    },
                },
            );
        }
        logFailure("Stripe webhook event handling failed.", error);
        fail(res, 500, "Webhook event handling failed.");
    }
}

export async function getStripeSessionStatus(
    req: AuthRequest,
    res: Response,
): Promise<void> {
    try {
        if (!req.userId) {
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        const sessionId = req.params.sessionId;
        if (
            typeof sessionId !== "string" ||
            !/^cs_[A-Za-z0-9_]{3,120}$/.test(sessionId)
        ) {
            fail(res, 404, "We could not find that payment session.");
            return;
        }

        const transaction = (await Transaction.findOne({
            providerSessionId: sessionId,
            provider: "stripe",
            customer: req.userId,
        }).lean()) as TransactionLean | null;
        if (!transaction) {
            fail(res, 404, "We could not find that payment session.");
            return;
        }

        const appointment = (await Appointment.findById(transaction.appointment).lean()) as {
            _id: Types.ObjectId;
            service: Types.ObjectId;
            serviceTitle: string;
            category?: string;
            date: string;
            time: string;
            status: string;
            paymentStatus?: string;
            paymentMethod?: string;
            paidAt?: Date;
        } | null;

        res.status(200).json({
            success: true,
            data: {
                transaction: formatTransaction(transaction),
                appointment: appointment ? formatAppointment(appointment) : null,
                payment: {
                    status: appointment?.paymentStatus ?? "unpaid",
                    ...(appointment?.paymentMethod
                        ? { method: appointment.paymentMethod }
                        : {}),
                    ...(appointment?.paidAt instanceof Date
                        ? { paidAt: appointment.paidAt.toISOString() }
                        : {}),
                },
            },
        });
    } catch (error) {
        logFailure("Stripe session status lookup failed.", error);
        fail(res, 500, "Unable to load payment status right now.");
    }
}

async function handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
    eventId: string,
): Promise<void> {
    const appointmentId = session.client_reference_id;
    if (!appointmentId || !mongoose.isValidObjectId(appointmentId)) {
        console.warn("Stripe checkout session missing client_reference_id:", session.id);
        return;
    }

    const transaction = (await Transaction.findOne({
        providerSessionId: session.id,
        provider: "stripe",
    }).lean()) as TransactionLean | null;
    if (!transaction) {
        console.warn("Stripe webhook: no transaction found for session:", session.id);
        return;
    }

    const amountMatches =
        Number.isInteger(transaction.amount) &&
        session.amount_total === transaction.amount * 100;
    const paymentVerified =
        session.payment_status === "paid" &&
        session.currency === "bdt" &&
        amountMatches &&
        String(transaction.appointment) === appointmentId;

    if (!paymentVerified) {
        console.warn("Stripe webhook verification failed for session:", session.id, {
            paymentStatus: session.payment_status,
            currency: session.currency,
            amountTotal: session.amount_total,
            expectedAmount: transaction.amount * 100,
        });
        await Transaction.updateOne(
            {
                _id: transaction._id,
                paymentStatus: { $in: ["pending", "processing"] },
            },
            {
                $set: {
                    paymentStatus: "failed",
                    settlementState: "committed",
                    settlementOutcome: "failed",
                    failureReason: "stripe_verification_failed",
                },
                $unset: { activeAppointmentId: 1 },
            },
        );
        await Appointment.updateOne(
            {
                _id: transaction.appointment,
                status: "confirmed",
                paymentStatus: "pending",
                latestTransactionId: transaction._id,
            },
            {
                $set: { paymentStatus: "unpaid" },
                $unset: { paymentMethod: 1, paidAt: 1, latestTransactionId: 1 },
            },
        );
        return;
    }

    const providerUpdate: Record<string, unknown> = {
        providerEventId: eventId,
        providerPaymentIntentId: session.payment_intent as string,
        providerVerifiedAt: new Date(),
    };
    if (typeof session.url === "string") {
        providerUpdate.checkoutUrl = session.url;
    }
    await Transaction.updateOne({ _id: transaction._id }, { $set: providerUpdate });

    const result = await settleTransactionSuccess({
        transactionId: String(transaction._id),
        actorUserId: String(transaction.customer),
        finalStatus: "succeeded",
        requireMethod: "stripe",
        allowedActiveStatuses: ["pending", "processing"],
    });

    try {
        const appointment = await Appointment.findById(result.appointment._id).lean();
        const customer = await User.findById(transaction.customer).select("name email");
        if (appointment && customer) {
            await sendPaymentReceiptEmail({
                to: customer.email,
                customerName: customer.name,
                serviceTitle: appointment.serviceTitle,
                amount: transaction.amount,
                method: "Stripe Card",
                date: appointment.date,
                time: appointment.time,
            }).catch((error) => {
                console.error("Payment receipt email failed.", {
                    errorName: error instanceof Error ? error.name : "UnknownError",
                });
            });
        }
    } catch {
        // Email delivery failure must not fail the webhook.
    }

    await AuditLog.create({
        actor: transaction.customer,
        action: "stripe_payment_succeeded",
        entityType: "transaction",
        entityId: String(transaction._id),
        metadata: {
            appointmentId: String(transaction.appointment),
            amount: transaction.amount,
            currency: transaction.currency,
            stripeSessionId: session.id,
            paymentIntentId: session.payment_intent,
        },
    });
}

async function handleCheckoutSessionExpired(
    session: Stripe.Checkout.Session,
): Promise<void> {
    const transaction = await Transaction.findOneAndUpdate(
        {
            providerSessionId: session.id,
            provider: "stripe",
            paymentStatus: { $in: ["pending", "processing"] },
        },
        {
            $set: {
                paymentStatus: "cancelled",
                settlementState: "committed",
                settlementOutcome: "cancelled",
                simulationOutcome: "cancelled",
            },
            $unset: { activeAppointmentId: 1 },
        },
        { new: true, lean: true },
    ) as TransactionLean | null;

    if (transaction) {
        await Appointment.findOneAndUpdate(
            {
                _id: transaction.appointment,
                status: "confirmed",
                paymentStatus: "pending",
            },
            {
                $set: { paymentStatus: "unpaid" },
                $unset: { paymentMethod: 1, paidAt: 1 },
            },
        );
    }
}

async function handlePaymentFailed(
    paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
    const transaction = await Transaction.findOneAndUpdate(
        {
            providerPaymentIntentId: paymentIntent.id,
            provider: "stripe",
            paymentStatus: { $in: ["pending", "processing"] },
        },
        {
            $set: {
                paymentStatus: "failed",
                settlementState: "committed",
                settlementOutcome: "failed",
                simulationOutcome: "failed",
                failureReason: paymentIntent.last_payment_error
                    ? `stripe: ${paymentIntent.last_payment_error.message}`
                    : "stripe_payment_failed",
            },
            $unset: { activeAppointmentId: 1 },
        },
        { new: true, lean: true },
    ) as TransactionLean | null;

    if (transaction) {
        await Appointment.findOneAndUpdate(
            {
                _id: transaction.appointment,
                status: "confirmed",
                paymentStatus: "pending",
            },
            {
                $set: { paymentStatus: "unpaid" },
                $unset: { paymentMethod: 1, paidAt: 1 },
            },
        );
    }
}

async function handlePaymentCanceled(
    paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
    const transaction = await Transaction.findOneAndUpdate(
        {
            providerPaymentIntentId: paymentIntent.id,
            provider: "stripe",
            paymentStatus: { $in: ["pending", "processing"] },
        },
        {
            $set: {
                paymentStatus: "cancelled",
                settlementState: "committed",
                settlementOutcome: "cancelled",
                simulationOutcome: "cancelled",
            },
            $unset: { activeAppointmentId: 1 },
        },
        { new: true, lean: true },
    ) as TransactionLean | null;

    if (transaction) {
        await Appointment.findOneAndUpdate(
            {
                _id: transaction.appointment,
                status: "confirmed",
                paymentStatus: "pending",
            },
            {
                $set: { paymentStatus: "unpaid" },
                $unset: { paymentMethod: 1, paidAt: 1 },
            },
        );
    }
}

async function handleChargeRefunded(
    charge: Stripe.Charge,
): Promise<void> {
    await Transaction.findOneAndUpdate(
        {
            providerPaymentIntentId: charge.payment_intent as string,
            provider: "stripe",
            paymentStatus: "succeeded",
        },
        {
            $set: {
                paymentStatus: "refunded",
                settlementState: "committed",
                refundedAmount: charge.amount_refunded / 100,
                refundedAt: new Date(),
            },
        },
        { new: true, lean: true },
    );
}
