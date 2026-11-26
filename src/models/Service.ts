// SalonBook — service catalogue model.
//
// Services are seeded into MongoDB (see scripts/seed-services.cjs) and read by
// the public catalogue endpoints. The admin UI is out of scope for this phase.

import mongoose, { Schema, type Model, type Types } from "mongoose";

export const SERVICE_CATEGORIES = ["hair", "skin", "nails", "wellness"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface ServiceFields {
    title: string;
    description: string;
    longDescription?: string;
    price: string;
    /** Chargeable amount in whole BDT used by real payment methods. */
    priceAmount?: number;
    duration?: string;
    category: ServiceCategory;
    image?: string;
    featured: boolean;
    includes: string[];
    goodToKnow: string[];
    active: boolean;
    createdBy?: Types.ObjectId;
    updatedBy?: Types.ObjectId;
}

const serviceSchema = new Schema<ServiceFields>(
    {
        title: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        description: {
            type: String,
            required: true,
            trim: true,
            maxlength: 500,
        },
        longDescription: {
            type: String,
            trim: true,
            maxlength: 2000,
        },
        price: {
            type: String,
            required: true,
            trim: true,
            maxlength: 40,
        },
        priceAmount: {
            type: Number,
            min: 1,
            max: 10_000_000,
            validate: {
                validator: (value: number) => Number.isInteger(value),
                message: "priceAmount must be a whole BDT amount.",
            },
        },
        duration: {
            type: String,
            trim: true,
            maxlength: 40,
        },
        category: {
            type: String,
            enum: SERVICE_CATEGORIES,
            required: true,
            index: true,
        },
        image: {
            type: String,
            trim: true,
            maxlength: 500,
        },
        featured: {
            type: Boolean,
            default: false,
        },
        includes: {
            type: [String],
            default: [],
        },
        goodToKnow: {
            type: [String],
            default: [],
        },
        active: {
            type: Boolean,
            default: true,
            index: true,
        },
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
        updatedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
    },
    { timestamps: true, versionKey: false },
);

serviceSchema.index({ active: 1, category: 1, createdAt: 1 });

const Service: Model<ServiceFields> =
    (mongoose.models.Service as Model<ServiceFields> | undefined) ??
    mongoose.model<ServiceFields>("Service", serviceSchema);

export default Service;
