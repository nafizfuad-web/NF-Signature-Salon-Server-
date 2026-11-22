// SalonBook — public service catalogue endpoints.

import type { QueryFilter } from "mongoose";
import type { Request, Response } from "express";
import Service, {
    SERVICE_CATEGORIES,
    type ServiceCategory,
    type ServiceFields,
} from "../models/Service";
import { formatService } from "../lib/serializers";
import { escapeRegExp, isValidObjectId } from "../lib/validation";

function isServiceCategory(value: string): value is ServiceCategory {
    return (SERVICE_CATEGORIES as readonly string[]).includes(value);
}

function logFailure(action: string, error: unknown): void {
    console.error(action, {
        errorName: error instanceof Error ? error.name : "UnknownError",
    });
}

export async function listServices(req: Request, res: Response): Promise<void> {
    try {
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const categoryValue =
            typeof req.query.category === "string"
                ? req.query.category.trim().toLowerCase()
                : "";

        const filter: QueryFilter<ServiceFields> = { active: true };
        if (categoryValue && isServiceCategory(categoryValue)) {
            filter.category = categoryValue;
        }
        if (search) {
            const pattern = new RegExp(escapeRegExp(search), "i");
            filter.$or = [
                { title: pattern },
                { description: pattern },
                { longDescription: pattern },
            ];
        }

        const services = await Service.find(filter)
            .sort({ featured: -1, createdAt: 1 })
            .lean();

        res.status(200).json({
            success: true,
            data: services.map((service) => formatService(service)),
        });
    } catch (error) {
        logFailure("Service list failed.", error);
        res.status(500).json({
            success: false,
            message: "Unable to load the service menu right now.",
        });
    }
}

export async function getService(req: Request, res: Response): Promise<void> {
    try {
        const serviceId = req.params.id;
        if (!isValidObjectId(serviceId)) {
            res.status(404).json({
                success: false,
                message: "We could not find that service.",
            });
            return;
        }

        const service = await Service.findOne({ _id: serviceId, active: true }).lean();
        if (!service) {
            res.status(404).json({
                success: false,
                message: "We could not find that service.",
            });
            return;
        }

        res.status(200).json({ success: true, data: formatService(service) });
    } catch (error) {
        logFailure("Service detail failed.", error);
        res.status(500).json({
            success: false,
            message: "Unable to load that service right now.",
        });
    }
}
