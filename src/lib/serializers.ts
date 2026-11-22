// SalonBook — response serializers.
//
// MongoDB documents are never returned raw: these helpers guarantee a stable
// JSON shape, hide internal fields and keep passwords out of responses.

 export interface ServiceLike {
    _id: unknown;
    title: string;
    description: string;
    longDescription?: string;
    price: string;
    duration?: string;
    category: string;
    image?: string;
    featured?: boolean;
    includes?: string[];
    goodToKnow?: string[];
}

export interface AppointmentLike {
    _id: unknown;
    service: unknown;
    serviceTitle: string;
    category?: string;
    duration?: string;
    price?: string;
    date: string;
    time: string;
    status: string;
    staffName?: string;
    notes?: string;
    customerName?: string;
    customerEmail?: string;
    customerPhone?: string;
    createdAt?: Date;
}

export function formatService(service: ServiceLike) {
    return {
        id: String(service._id),
        title: service.title,
        description: service.description,
        ...(service.longDescription ? { longDescription: service.longDescription } : {}),
        price: service.price,
        ...(service.duration ? { duration: service.duration } : {}),
        category: service.category,
        ...(service.image ? { image: service.image } : {}),
        featured: Boolean(service.featured),
        ...(service.includes && service.includes.length ? { includes: service.includes } : {}),
        ...(service.goodToKnow && service.goodToKnow.length
            ? { goodToKnow: service.goodToKnow }
            : {}),
    };
}

export function formatAppointment(appointment: AppointmentLike) {
    return {
        id: String(appointment._id),
        serviceId: String(appointment.service),
        serviceTitle: appointment.serviceTitle,
        ...(appointment.category ? { category: appointment.category } : {}),
        date: appointment.date,
        time: appointment.time,
        ...(appointment.duration ? { duration: appointment.duration } : {}),
        ...(appointment.price ? { price: appointment.price } : {}),
        status: appointment.status,
        ...(appointment.staffName ? { staffName: appointment.staffName } : {}),
        ...(appointment.notes ? { notes: appointment.notes } : {}),
        ...(appointment.customerName ? { customerName: appointment.customerName } : {}),
        ...(appointment.customerEmail ? { customerEmail: appointment.customerEmail } : {}),
        ...(appointment.customerPhone ? { customerPhone: appointment.customerPhone } : {}),
        ...(appointment.createdAt instanceof Date
            ? { createdAt: appointment.createdAt.toISOString() }
            : {}),
    };
}
