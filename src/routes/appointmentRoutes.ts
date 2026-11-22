import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
    cancelAppointment,
    createAppointment,
    getAvailability,
} from "../controllers/appointmentController";
import { protect } from "../middleware/authMiddleware";

const router = Router();

const createBookingLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many booking attempts. Please wait a moment and try again.",
    },
});

// Availability is public so the homepage search can suggest times.
router.get("/availability", getAvailability);

// Booking and cancellation require a signed-in customer.
router.post("/", protect, createBookingLimit, createAppointment);
router.patch("/:id/cancel", protect, cancelAppointment);

export default router;
