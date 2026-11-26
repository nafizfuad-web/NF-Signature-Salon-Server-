import { Router } from "express";
import {
    createStripeCheckoutSession,
    getStripeSessionStatus,
    stripeWebhook,
} from "../controllers/stripeController";
import { protect } from "../middleware/authMiddleware";

// Export the webhook handler so index.ts can mount it with express.raw()
// before express.json() body parsing.
export { stripeWebhook };

const router = Router();

// Checkout session creation: requires authentication. Body is parsed by
// express.json() in index.ts.
router.use(protect);
router.get("/sessions/:sessionId", getStripeSessionStatus);
router.post(
    "/appointments/:appointmentId/session",
    createStripeCheckoutSession,
);

export default router;
