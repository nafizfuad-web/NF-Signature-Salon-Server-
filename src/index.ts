
import path from "node:path";
import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db";
import { loadServerConfig } from "./config/env";
import authRoutes from "./routes/authRoutes";
import serviceRoutes from "./routes/serviceRoutes";
import appointmentRoutes from "./routes/appointmentRoutes";
import customerRoutes from "./routes/customerRoutes";
import paymentRoutes from "./routes/paymentRoutes";
import stripeSessionRoutes, { stripeWebhook } from "./routes/stripeRoutes";
import bkashRoutes from "./routes/bkashRoutes";
import adminRoutes from "./routes/adminRoutes";
import { startPaymentReconciler } from "./lib/paymentReconciliation";

// Load .env from the server package directory.
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
const config = loadServerConfig();

// Safe Google OAuth diagnostic.
// Never logs the actual Client ID or Client Secret.
const googleOAuthDiagnostic = {
    clientId: Boolean(process.env.GOOGLE_CLIENT_ID?.trim()),
    clientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET?.trim()),
    callbackUrl: Boolean(process.env.GOOGLE_CALLBACK_URL?.trim()),
    configured: Boolean(config.googleOAuth),
};

console.log("Google OAuth diagnostic:", googleOAuthDiagnostic);

function isLocalDevelopmentOrigin(origin: string): boolean {
    try {
        const parsed = new URL(origin);

        return (
            (parsed.hostname === "localhost" ||
                parsed.hostname === "127.0.0.1") &&
            (parsed.protocol === "http:" ||
                parsed.protocol === "https:")
        );
    } catch {
        return false;
    }
}

const hasAnyGoogleOAuthSetting = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CALLBACK_URL",
].some((name) => Boolean(process.env[name]?.trim()));

if (hasAnyGoogleOAuthSetting && !config.googleOAuth) {
    console.warn(
        "Google OAuth is disabled because its required environment variables are incomplete.",
    );
}

app.use(
    cors({
        origin: (origin, callback) => {
            const allowed =
                !origin ||
                origin === config.clientOrigin ||
                (config.nodeEnv !== "production" &&
                    isLocalDevelopmentOrigin(origin));

            callback(null, allowed);
        },
    }),
);

app.disable("x-powered-by");

// Stripe webhook requires the raw request body for signature verification.
// It must be mounted before express.json() so the body stays unparsed.
app.use(
    "/api/payments/stripe/webhook",
    express.raw({ type: "*/*" }),
    stripeWebhook,
);

app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

// Stripe checkout session creation/status (authenticated, JSON body).
app.use("/api/payments/stripe", stripeSessionRoutes);
app.use("/api/payments/bkash", bkashRoutes);

// Serve uploaded profile pictures.
app.use(
    "/uploads",
    express.static(path.resolve(__dirname, "../uploads"), {
        index: false,
        maxAge: "1d",
    }),
);

// Health check.
app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
        success: true,
        message: "NF Signature Salon API is running!",
        environment: config.nodeEnv,
    });
});

// Authentication routes.
app.use("/api/auth", authRoutes);

// Service catalogue.
app.use("/api/services", serviceRoutes);

// Availability, booking and cancellation.
app.use("/api/appointments", appointmentRoutes);

// Customer dashboard, appointments, profile and avatar.
app.use("/api/customers", customerRoutes);

// TEST-only simulated payments.
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);

// 404 handler.
app.use((_req: Request, res: Response) => {
    res.status(404).json({
        success: false,
        message: "API route not found",
    });
});

// Central error handler.
app.use(
    (
        error: unknown,
        _req: Request,
        res: Response,
        next: (error?: unknown) => void,
    ) => {
        if (res.headersSent) {
            next(error);
            return;
        }

        const status =
            typeof error === "object" &&
                error !== null &&
                "status" in error &&
                typeof error.status === "number"
                ? error.status
                : 500;

        console.error("Unhandled API error.", {
            errorName:
                error instanceof Error
                    ? error.name
                    : "UnknownError",
            status,
        });

        res.status(status).json({
            success: false,
            message:
                status >= 500
                    ? "An unexpected server error occurred."
                    : "Invalid request.",
        });
    },
);

const startServer = async (): Promise<void> => {
    try {
        await connectDB(config.mongoUri);
        startPaymentReconciler();

        app.listen(config.port, () => {
            console.log("--------------------------------");
            console.log("NF Signature Salon API Started");
            console.log(`Server listening on port ${config.port}`);
            console.log("--------------------------------");
        });
    } catch (error) {
        console.error("Server startup failed.", {
            errorName:
                error instanceof Error
                    ? error.name
                    : "UnknownError",
        });

        process.exit(1);
    }
};

startServer();
