import mongoose, { Schema, type Model, type Types } from "mongoose";

export interface AuditLogFields {
    actor: Types.ObjectId;
    actorEmail?: string;
    action: string;
    entityType: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
}

const auditLogSchema = new Schema<AuditLogFields>(
    {
        actor: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        actorEmail: {
            type: String,
            trim: true,
            lowercase: true,
            maxlength: 254,
        },
        action: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100,
            index: true,
        },
        entityType: {
            type: String,
            required: true,
            trim: true,
            maxlength: 60,
            index: true,
        },
        entityId: {
            type: String,
            trim: true,
            maxlength: 120,
        },
        metadata: {
            type: Schema.Types.Mixed,
        },
        ipAddress: {
            type: String,
            trim: true,
            maxlength: 80,
        },
        userAgent: {
            type: String,
            trim: true,
            maxlength: 300,
        },
    },
    { timestamps: true, versionKey: false },
);

auditLogSchema.index({ createdAt: -1 });

const AuditLog: Model<AuditLogFields> =
    (mongoose.models.AuditLog as Model<AuditLogFields> | undefined) ??
    mongoose.model<AuditLogFields>("AuditLog", auditLogSchema);

export default AuditLog;
