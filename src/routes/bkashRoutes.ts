import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
    bkashCallback,
    createBkashCheckoutSession,
    getBkashPaymentStatus,
} from "../controllers/bkashController";
import { protect } from "../middleware/authMiddleware";

const router = Router();

const bkashAttemptLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many bKash payment attempts. Please wait a moment and try again.",
    },
});

// Public browser callback from bKash. It must not require a customer JWT.
router.get("/callback", bkashAttemptLimit, bkashCallback);

router.use(protect);
router.get("/payments/:paymentId", getBkashPaymentStatus);
router.post(
    "/appointments/:appointmentId/session",
    bkashAttemptLimit,
    createBkashCheckoutSession,
);

export default router;
