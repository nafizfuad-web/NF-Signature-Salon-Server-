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
    paymentStatus?: string;
    paymentMethod?: string;
    paidAt?: Date;
    latestTransactionId?: unknown;
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
        paymentStatus: appointment.paymentStatus ?? "unpaid",
        ...(appointment.paymentMethod ? { paymentMethod: appointment.paymentMethod } : {}),
        ...(appointment.paidAt instanceof Date
            ? { paidAt: appointment.paidAt.toISOString() }
            : {}),
        ...(appointment.latestTransactionId
            ? { latestTransactionId: String(appointment.latestTransactionId) }
            : {}),
        ...(appointment.createdAt instanceof Date
            ? { createdAt: appointment.createdAt.toISOString() }
            : {}),
    };
}

export interface TransactionLike {
    _id: unknown;
    appointment: unknown;
    customer: unknown;
    service?: unknown;
    serviceTitle: string;
    appointmentDate: string;
    appointmentTime: string;
    displayPrice?: string;
    amount: number;
    currency: string;
    amountBasis: string;
    paymentMethod: string;
    provider: string;
    paymentStatus: string;
    environment: string;
    simulated: boolean;
    simulationOutcome?: string;
    failureReason?: string;
    paidAt?: Date;
    cashConfirmedAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
}

export function formatTransaction(transaction: TransactionLike) {
    return {
        id: String(transaction._id),
        appointmentId: String(transaction.appointment),
        customerId: String(transaction.customer),
        ...(transaction.service ? { serviceId: String(transaction.service) } : {}),
        serviceTitle: transaction.serviceTitle,
        appointmentDate: transaction.appointmentDate,
        appointmentTime: transaction.appointmentTime,
        ...(transaction.displayPrice ? { displayPrice: transaction.displayPrice } : {}),
        amount: transaction.amount,
        currency: transaction.currency,
        amountBasis: transaction.amountBasis,
        paymentMethod: transaction.paymentMethod,
        provider: transaction.provider,
        paymentStatus: transaction.paymentStatus,
        environment: transaction.environment,
        simulated: transaction.simulated,
        ...(transaction.simulationOutcome
            ? { simulationOutcome: transaction.simulationOutcome }
            : {}),
        ...(transaction.failureReason ? { failureReason: transaction.failureReason } : {}),
        ...(transaction.paidAt instanceof Date
            ? { paidAt: transaction.paidAt.toISOString() }
            : {}),
        ...(transaction.cashConfirmedAt instanceof Date
            ? { cashConfirmedAt: transaction.cashConfirmedAt.toISOString() }
            : {}),
        ...(transaction.createdAt instanceof Date
            ? { createdAt: transaction.createdAt.toISOString() }
            : {}),
        ...(transaction.updatedAt instanceof Date
            ? { updatedAt: transaction.updatedAt.toISOString() }
            : {}),
    };
}
