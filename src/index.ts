
import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db";
import authRoutes from "./routes/authRoutes";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

app.use(
    cors({
        origin: CLIENT_URL,
        credentials: true,
    })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
        success: true,
        message: "NF Signature Salon API is running!",
        environment: process.env.NODE_ENV || "development",
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
        await connectDB();

        app.listen(PORT, () => {
            console.log("--------------------------------");
            console.log("NF Signature Salon API Started");
            console.log(`Server: http://localhost:${PORT}`);
            console.log(`Client: ${CLIENT_URL}`);
            console.log("--------------------------------");
        });
    } catch (error) {
        console.error("Server startup failed:", error);
        process.exit(1);
    }
};

startServer();
