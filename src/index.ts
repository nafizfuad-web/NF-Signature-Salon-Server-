
import path from "node:path";
import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db";
import { loadServerConfig } from "./config/env";
import authRoutes from "./routes/authRoutes";

// Resolve .env from the server package, not from whatever directory the
// process happened to be started in (e.g. the repository root).
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
const config = loadServerConfig();

function isLocalDevelopmentOrigin(origin: string): boolean {
    try {
        const parsed = new URL(origin);
        return (
            (parsed.hostname === "localhost" ||
                parsed.hostname === "127.0.0.1") &&
            (parsed.protocol === "http:" || parsed.protocol === "https:")
        );
    } catch {
        return false;
    }
}

const hasGoogleOAuthSetting = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CALLBACK_URL",
].some((name) => Boolean(process.env[name]?.trim()));

if (hasGoogleOAuthSetting && !config.googleOAuth) {
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
    })
);

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

// Health check
app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
        success: true,
        message: "NF Signature Salon API is running!",
        environment: config.nodeEnv,
    });
});

// Authentication routes
app.use("/api/auth", authRoutes);

// 404 handler
app.use((_req: Request, res: Response) => {
    res.status(404).json({
        success: false,
        message: "API route not found",
    });
});

const startServer = async (): Promise<void> => {
    try {
        await connectDB(config.mongoUri);

        app.listen(config.port, () => {
            console.log("--------------------------------");
            console.log("NF Signature Salon API Started");
            console.log(`Server listening on port ${config.port}`);
            console.log("--------------------------------");
        });
    } catch (error) {
        console.error("Server startup failed.", {
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
        process.exit(1);
    }
};

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
            errorName: error instanceof Error ? error.name : "UnknownError",
            status,
        });
        res.status(status).json({
            success: false,
            message: status >= 500 ? "An unexpected server error occurred." : "Invalid request.",
        });
    },
);

startServer();
