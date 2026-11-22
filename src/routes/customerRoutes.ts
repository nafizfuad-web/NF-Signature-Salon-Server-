import { Router } from "express";
import {
    getDashboard,
    getMyAppointments,
    removeAvatar,
    updateProfile,
    uploadAvatar,
} from "../controllers/customerController";
import { protect } from "../middleware/authMiddleware";
import { handleAvatarUpload } from "../middleware/upload";

const router = Router();

// Every customer route is scoped to the authenticated account.
router.use(protect);

router.get("/me/dashboard", getDashboard);
router.get("/me/appointments", getMyAppointments);
router.patch("/me", updateProfile);
router.post("/me/avatar", handleAvatarUpload, uploadAvatar);
router.delete("/me/avatar", removeAvatar);

export default router;
