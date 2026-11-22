
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import User from "../models/User";
import { getServerConfig } from "../config/env";
import { createToken, formatUser } from "./authController";

const COOKIE_PATH = "/api/auth/google";
const COOKIE_MAX_AGE = 5 * 60 * 1000;

const COOKIE_NAMES = [
    "nf_google_state",
    "nf_google_nonce",
    "nf_google_verifier",
] as const;

function getCookie(req: Request, name: string): string | undefined {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return undefined;

    for (const item of cookieHeader.split(";")) {
        const separator = item.indexOf("=");

        if (separator < 0 || item.slice(0, separator).trim() !== name) {
            continue;
        }

        try {
            return decodeURIComponent(item.slice(separator + 1).trim());
        } catch {
            return undefined;
        }
    }

    return undefined;
}

function matchesSecret(
    left: string | undefined,
    right: string | undefined,
): boolean {
    if (!left || !right) return false;

    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    return (
        leftBuffer.length === rightBuffer.length &&
        timingSafeEqual(leftBuffer, rightBuffer)
    );
}

function clearFlowCookies(res: Response): void {
    const { nodeEnv } = getServerConfig();

    for (const name of COOKIE_NAMES) {
        res.clearCookie(name, {
            httpOnly: true,
            sameSite: "lax",
            secure: nodeEnv === "production",
            path: COOKIE_PATH,
        });
    }
}

function escapeScriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
        return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    });
}

function sendPopupResult(
    res: Response,
    status: number,
    message:
        | {
            type: "nf-signature-auth";
            token: string;
            user: ReturnType<typeof formatUser>;
        }
        | {
            type: "nf-signature-auth";
            error: string;
        },
): void {
    const { clientOrigin } = getServerConfig();

    const nonce = randomBytes(18).toString("base64");
    const encodedMessage = escapeScriptJson(message);
    const encodedOrigin = escapeScriptJson(clientOrigin);

    res.status(status)
        .set({
            "Cache-Control": "no-store",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        })
        .type("html")
        .send(
            `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google sign-in</title>
</head>
<body>
<p>Returning to NF Signature Salon...</p>
<script nonce="${nonce}">
(function () {
    const message = ${encodedMessage};
    const targetOrigin = ${encodedOrigin};

    if (window.opener && !window.opener.closed) {
        window.opener.postMessage(message, targetOrigin);
        window.close();
    } else {
        document.body.innerHTML =
            "<p>Unable to return to the salon website. Please close this window and try signing in again.</p>";
    }
})();
</script>
</body>
</html>`,
        );
}

function sendGoogleError(
    res: Response,
    status: number,
    error: string,
): void {
    clearFlowCookies(res);
    sendPopupResult(res, status, {
        type: "nf-signature-auth",
        error,
    });
}

export async function startGoogleAuth(
    _req: Request,
    res: Response,
): Promise<void> {
    const { googleOAuth, nodeEnv } = getServerConfig();

    if (!googleOAuth) {
        sendGoogleError(
            res,
            503,
            "Google sign-in is not configured for this application.",
        );
        return;
    }

    const oauthClient = new OAuth2Client(
        googleOAuth.clientId,
        googleOAuth.clientSecret,
        googleOAuth.callbackUrl,
    );

    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");

    const { codeVerifier, codeChallenge } =
        await oauthClient.generateCodeVerifierAsync();

    if (!codeChallenge) {
        sendGoogleError(
            res,
            500,
            "Google sign-in could not be started.",
        );
        return;
    }

    const cookieOptions = {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: nodeEnv === "production",
        path: COOKIE_PATH,
        maxAge: COOKIE_MAX_AGE,
    };

    res.cookie("nf_google_state", state, cookieOptions);
    res.cookie("nf_google_nonce", nonce, cookieOptions);
    res.cookie("nf_google_verifier", codeVerifier, cookieOptions);

    const authorizationUrl = oauthClient.generateAuthUrl({
        access_type: "online",
        prompt: "select_account",
        scope: ["openid", "email", "profile"],
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
    });

    res.redirect(302, authorizationUrl);
}

export async function completeGoogleAuth(
    req: Request,
    res: Response,
): Promise<void> {
    const { googleOAuth } = getServerConfig();

    if (!googleOAuth) {
        sendGoogleError(
            res,
            503,
            "Google sign-in is not configured for this application.",
        );
        return;
    }

    const state =
        typeof req.query.state === "string"
            ? req.query.state
            : undefined;

    const code =
        typeof req.query.code === "string"
            ? req.query.code
            : undefined;

    const storedState = getCookie(req, "nf_google_state");
    const storedNonce = getCookie(req, "nf_google_nonce");
    const codeVerifier = getCookie(req, "nf_google_verifier");

    if (typeof req.query.error === "string") {
        sendGoogleError(
            res,
            400,
            "Google sign-in was cancelled or denied.",
        );
        return;
    }

    if (
        !matchesSecret(state, storedState) ||
        !storedNonce ||
        !codeVerifier ||
        !code
    ) {
        sendGoogleError(
            res,
            400,
            "Google sign-in could not be verified.",
        );
        return;
    }

    clearFlowCookies(res);

    try {
        const oauthClient = new OAuth2Client(
            googleOAuth.clientId,
            googleOAuth.clientSecret,
            googleOAuth.callbackUrl,
        );

        const { tokens } = await oauthClient.getToken({
            code,
            codeVerifier,
        });

        if (!tokens.id_token) {
            sendPopupResult(res, 400, {
                type: "nf-signature-auth",
                error: "Google did not return a valid identity.",
            });
            return;
        }

        const ticket = await oauthClient.verifyIdToken({
            idToken: tokens.id_token,
            audience: googleOAuth.clientId,
        });

        const identity = ticket.getPayload();

        if (
            !identity?.sub ||
            !identity.email ||
            identity.email_verified !== true ||
            !matchesSecret(identity.nonce, storedNonce)
        ) {
            sendPopupResult(res, 401, {
                type: "nf-signature-auth",
                error: "Google could not verify this account.",
            });
            return;
        }

        const email = identity.email.trim().toLowerCase();
        const preferredName = identity.name?.trim();
        const fallbackName = email.split("@")[0];

        const name =
            preferredName && preferredName.length <= 100
                ? preferredName
                : fallbackName &&
                    fallbackName.length >= 2 &&
                    fallbackName.length <= 100
                    ? fallbackName
                    : "Google user";

        let user = await User.findOne({
            googleId: identity.sub,
        });

        if (!user) {
            const existingEmail = await User.findOne({
                email,
            }).select("+googleId");

            if (existingEmail) {
                if (
                    existingEmail.googleId &&
                    existingEmail.googleId !== identity.sub
                ) {
                    sendPopupResult(res, 409, {
                        type: "nf-signature-auth",
                        error:
                            "This email is linked to a different Google account. Sign in with email and password instead.",
                    });
                    return;
                }

                existingEmail.googleId = identity.sub;

                if (!existingEmail.avatarUrl && identity.picture) {
                    existingEmail.avatarUrl = identity.picture;
                }

                await existingEmail.save();
                user = existingEmail;
            } else {
                try {
                    user = await User.create({
                        name,
                        email,
                        googleId: identity.sub,
                        role: "customer",
                        ...(identity.picture
                            ? { avatarUrl: identity.picture }
                            : {}),
                    });
                } catch (error) {
                    if (
                        typeof error === "object" &&
                        error !== null &&
                        "code" in error &&
                        error.code === 11000
                    ) {
                        sendPopupResult(res, 409, {
                            type: "nf-signature-auth",
                            error:
                                "An account with this email already exists.",
                        });
                        return;
                    }

                    throw error;
                }
            }
        }

        sendPopupResult(res, 200, {
            type: "nf-signature-auth",
            token: createToken(String(user._id)),
            user: formatUser(user),
        });
    } catch (error) {
        console.error("Google sign-in failed.", {
            errorName:
                error instanceof Error
                    ? error.name
                    : "UnknownError",
        });

        sendPopupResult(res, 500, {
            type: "nf-signature-auth",
            error:
                "Google sign-in could not be completed. Please try again.",
        });
    }
}
