import mongoose, { Schema, type Model } from "mongoose";

export const WEBHOOK_EVENT_STATUSES = [
    "processing",
    "processed",
    "ignored",
    "failed",
] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export interface WebhookEventFields {
    provider: "stripe";
    eventId: string;
    type: string;
    status: WebhookEventStatus;
    payloadHash: string;
    transactionId?: string;
    error?: string;
    receivedAt: Date;
    processedAt?: Date;
}

const webhookEventSchema = new Schema<WebhookEventFields>(
    {
        provider: {
            type: String,
            enum: ["stripe"],
            required: true,
        },
        eventId: {
            type: String,
            required: true,
            trim: true,
            maxlength: 200,
        },
        type: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        status: {
            type: String,
            enum: WEBHOOK_EVENT_STATUSES,
            required: true,
            default: "processing",
            index: true,
        },
        payloadHash: {
            type: String,
            required: true,
            maxlength: 128,
        },
        transactionId: {
            type: String,
            trim: true,
            maxlength: 120,
        },
        error: {
            type: String,
            trim: true,
            maxlength: 500,
        },
        receivedAt: {
            type: Date,
            required: true,
            default: () => new Date(),
        },
        processedAt: {
            type: Date,
        },
    },
    { timestamps: true, versionKey: false },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ createdAt: -1 });

const WebhookEvent: Model<WebhookEventFields> =
    (mongoose.models.WebhookEvent as Model<WebhookEventFields> | undefined) ??
    mongoose.model<WebhookEventFields>("WebhookEvent", webhookEventSchema);

export default WebhookEvent;
