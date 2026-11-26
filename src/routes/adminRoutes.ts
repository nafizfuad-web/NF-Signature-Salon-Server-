import { Router } from "express";
import {
    listAdminAppointments,
    updateAdminAppointmentStatus,
} from "../controllers/appointmentController";
import {
    confirmCashReceived,
    listAdminPayments,
} from "../controllers/adminPaymentController";
import { protect, requireRole } from "../middleware/authMiddleware";

const router = Router();

router.use(protect, requireRole("admin"));
router.get("/bookings", listAdminAppointments);
router.patch("/bookings/:id/status", updateAdminAppointmentStatus);
router.get("/payments", listAdminPayments);
router.patch("/payments/:transactionId/cash-received", confirmCashReceived);

export default router;
