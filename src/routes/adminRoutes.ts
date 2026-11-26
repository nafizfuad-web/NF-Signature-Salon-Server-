import { Router } from "express";
import {
    listAdminAppointments,
    updateAdminAppointmentStatus,
} from "../controllers/appointmentController";
import {
    confirmCashReceived,
    listAdminPayments,
} from "../controllers/adminPaymentController";
import {
    createAdminService,
    deleteAdminService,
    getAdminCustomer,
    getAdminDashboard,
    listAdminCustomers,
    listAdminServices,
    setCustomerBlocked,
    updateAdminService,
    uploadAdminServiceImage,
} from "../controllers/adminController";
import { protect, requireRole } from "../middleware/authMiddleware";
import { handleServiceImageUpload } from "../middleware/upload";

const router = Router();

router.use(protect, requireRole("admin"));
router.get("/dashboard", getAdminDashboard);
router.get("/bookings", listAdminAppointments);
router.patch("/bookings/:id/status", updateAdminAppointmentStatus);
router.get("/payments", listAdminPayments);
router.patch("/payments/:transactionId/cash-received", confirmCashReceived);
router.get("/customers", listAdminCustomers);
router.get("/customers/:id", getAdminCustomer);
router.patch("/customers/:id/block", setCustomerBlocked);
router.get("/services", listAdminServices);
router.post("/services", handleServiceImageUpload, createAdminService);
router.patch("/services/:id", handleServiceImageUpload, updateAdminService);
router.post("/services/:id/image", handleServiceImageUpload, uploadAdminServiceImage);
router.delete("/services/:id", deleteAdminService);

export default router;
