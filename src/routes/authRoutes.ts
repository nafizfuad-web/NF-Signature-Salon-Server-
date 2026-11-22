
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
    register,
    login,
    getMe,
    logout,
} from "../controllers/authController";
import {
    completeGoogleAuth,
    startGoogleAuth,
} from "../controllers/googleAuthController";
import { protect } from "../middleware/authMiddleware";

const router = Router();

function createAuthRateLimit(message: string) {
    return rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: true,
        legacyHeaders: false,
        // Successful authentication must not consume the brute-force budget.
        // Only failed attempts should count toward the limit.
        skipSuccessfulRequests: true,
        message: {
            success: false,
            message,
        },
    });
}

const loginRateLimit = createAuthRateLimit(
    "Too many sign-in attempts. Please wait and try again."
);
const registerRateLimit = createAuthRateLimit(
    "Too many account creation attempts. Please wait and try again."
);
const googleRateLimit = createAuthRateLimit(
    "Too many Google sign-in attempts. Please wait and try again."
);

// Public routes
router.post("/register", registerRateLimit, register);
router.post("/login", loginRateLimit, login);
router.get("/google", googleRateLimit, startGoogleAuth);
router.get("/google/callback", completeGoogleAuth);

// Protected routes
router.get("/me", protect, getMe);
router.post("/logout", protect, logout);

export default router;
