import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
    createPaymentSession,
    getAppointmentPayment,
    getMyTransactions,
    getPaymentMethods,
    simulatePayment,
} from "../controllers/paymentController";
import { protect } from "../middleware/authMiddleware";

const router = Router();

const paymentAttemptLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many payment attempts. Please wait a moment and try again.",
    },
});

router.use(protect);
router.get("/methods", getPaymentMethods);
router.post(
    "/appointments/:appointmentId/sessions",
    paymentAttemptLimit,
    createPaymentSession,
);
router.get("/appointments/:appointmentId", getAppointmentPayment);
router.get("/me/transactions", getMyTransactions);
router.post(
    "/transactions/:transactionId/simulate",
    paymentAttemptLimit,
    simulatePayment,
);

export default router;
