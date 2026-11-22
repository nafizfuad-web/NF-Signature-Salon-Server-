import { Router } from "express";
import {
    confirmCashReceived,
    listAdminPayments,
} from "../controllers/adminPaymentController";
import { protect, requireRole } from "../middleware/authMiddleware";

const router = Router();

router.use(protect, requireRole("admin"));
router.get("/payments", listAdminPayments);
router.patch("/payments/:transactionId/cash-received", confirmCashReceived);

export default router;
