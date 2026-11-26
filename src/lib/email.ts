// SalonBook — server-side email delivery.
//
// Email is entirely optional. When SMTP is not configured these helpers throw a
// typed error so API routes can report a configuration blocker instead of
// pretending a message was delivered.

import nodemailer, { type Transporter } from "nodemailer";
import { getServerConfig, type EmailConfig } from "../config/env";

export class EmailNotConfiguredError extends Error {
    readonly code = "email_not_configured";

    constructor() {
        super(
            "Email delivery is not configured. Set SMTP_HOST, EMAIL_FROM and the SMTP credentials on the server.",
        );
        this.name = "EmailNotConfiguredError";
    }
}

export interface EmailMessage {
    to: string;
    subject: string;
    text: string;
    html: string;
    replyTo?: string;
}

export interface EmailDeliveryResult {
    delivered: true;
    messageId: string;
}

let transporter: Transporter | undefined;
let transporterKey: string | undefined;

export function getEmailConfig(): EmailConfig | undefined {
    try {
        return getServerConfig().email;
    } catch {
        return undefined;
    }
}

export function isEmailConfigured(): boolean {
    return Boolean(getEmailConfig());
}

function getTransporter(config: EmailConfig): Transporter {
    const key = [
        config.host,
        config.port,
        config.secure ? "1" : "0",
        config.user ?? "",
    ].join(":");
    if (transporter && transporterKey === key) return transporter;

    transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        ...(config.user && config.pass
            ? { auth: { user: config.user, pass: config.pass } }
            : {}),
        tls: { minVersion: "TLSv1.2" },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
    });
    transporterKey = key;
    return transporter;
}

export async function sendEmail(
    message: EmailMessage,
): Promise<EmailDeliveryResult> {
    const config = getEmailConfig();
    if (!config) throw new EmailNotConfiguredError();

    const result = await getTransporter(config).sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.replyTo
            ? { replyTo: message.replyTo }
            : config.replyTo
              ? { replyTo: config.replyTo }
              : {}),
    });

    return { delivered: true, messageId: result.messageId };
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function layout(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#0b0b0b;color:#f4f1e8;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <p style="margin:0 0 24px;color:#c9a84c;font-size:12px;letter-spacing:3px;text-transform:uppercase;">NF Signature Salon</p>
    <div style="border:1px solid #2a2a2a;border-radius:8px;background:#121212;padding:28px;">
      <h1 style="margin:0 0 18px;color:#f4f1e8;font-size:22px;font-weight:normal;">${escapeHtml(title)}</h1>
      ${body}
    </div>
    <p style="margin:24px 0 0;color:#8f8b80;font-size:12px;">This message was sent by NF Signature Salon. If you did not request it, you can safely ignore it.</p>
  </div>
</body>
</html>`;
}

function button(url: string, label: string): string {
    return `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;border-radius:4px;background:#c9a84c;color:#0b0b0b;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;">${escapeHtml(label)}</a></p>`;
}

export async function sendVerificationEmail(options: {
    to: string;
    name: string;
    token: string;
}): Promise<EmailDeliveryResult> {
    const { clientOrigin } = getServerConfig();
    const url = `${clientOrigin}/verify-email?token=${encodeURIComponent(options.token)}`;
    return sendEmail({
        to: options.to,
        subject: "Verify your NF Signature Salon email",
        text: `Hello ${options.name},\n\nConfirm your email address to finish setting up your NF Signature Salon account:\n${url}\n\nIf you did not create an account, ignore this message.`,
        html: layout(
            "Verify your email address",
            `<p style="margin:0 0 12px;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">Hello ${escapeHtml(options.name)},</p>
             <p style="margin:0;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">Confirm your email address to finish setting up your account.</p>
             ${button(url, "Verify email")}
             <p style="margin:0;color:#8f8b80;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;">If the button does not work, copy this link into your browser:<br>${escapeHtml(url)}</p>`,
        ),
    });
}

export async function sendPasswordResetEmail(options: {
    to: string;
    name: string;
    token: string;
}): Promise<EmailDeliveryResult> {
    const { clientOrigin } = getServerConfig();
    const url = `${clientOrigin}/reset-password?token=${encodeURIComponent(options.token)}`;
    return sendEmail({
        to: options.to,
        subject: "Reset your NF Signature Salon password",
        text: `Hello ${options.name},\n\nUse this link to choose a new password:\n${url}\n\nThe link expires soon and can only be used once. If you did not request a reset, ignore this message.`,
        html: layout(
            "Reset your password",
            `<p style="margin:0 0 12px;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">Hello ${escapeHtml(options.name)},</p>
             <p style="margin:0;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">Use the button below to choose a new password. The link expires soon and can only be used once.</p>
             ${button(url, "Reset password")}
             <p style="margin:0;color:#8f8b80;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;">If you did not request a password reset, you can safely ignore this message.</p>`,
        ),
    });
}

export async function sendContactMessage(options: {
    name: string;
    email: string;
    message: string;
}): Promise<EmailDeliveryResult> {
    const config = getEmailConfig();
    if (!config) throw new EmailNotConfiguredError();
    const recipient = config.adminRecipient ?? config.from;
    return sendEmail({
        to: recipient,
        replyTo: options.email,
        subject: `Contact message from ${options.name}`,
        text: `Name: ${options.name}\nEmail: ${options.email}\n\n${options.message}`,
        html: layout(
            "New contact message",
            `<p style="margin:0 0 8px;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;"><strong>Name:</strong> ${escapeHtml(options.name)}</p>
             <p style="margin:0 0 16px;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;"><strong>Email:</strong> ${escapeHtml(options.email)}</p>
             <p style="margin:0;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(options.message)}</p>`,
        ),
    });
}

export async function sendBookingConfirmationEmail(options: {
    to: string;
    customerName: string;
    serviceTitle: string;
    date: string;
    time: string;
    price?: string;
}): Promise<EmailDeliveryResult> {
    const { clientOrigin } = getServerConfig();
    return sendEmail({
        to: options.to,
        subject: `Appointment requested: ${options.serviceTitle}`,
        text: `Hello ${options.customerName},\n\nWe received your appointment request.\nService: ${options.serviceTitle}\nDate: ${options.date}\nTime: ${options.time}${options.price ? `\nPrice: ${options.price}` : ""}\n\nView your appointments: ${clientOrigin}/dashboard/appointments`,
        html: layout(
            "Appointment request received",
            `<p style="margin:0 0 12px;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;">Hello ${escapeHtml(options.customerName)},</p>
             <p style="margin:0 0 12px;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">We received your appointment request. The salon will confirm it shortly.</p>
             <p style="margin:0;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;"><strong>Service:</strong> ${escapeHtml(options.serviceTitle)}<br><strong>Date:</strong> ${escapeHtml(options.date)}<br><strong>Time:</strong> ${escapeHtml(options.time)}${options.price ? `<br><strong>Price:</strong> ${escapeHtml(options.price)}` : ""}</p>
             ${button(`${clientOrigin}/dashboard/appointments`, "View appointments")}`,
        ),
    });
}

export async function sendAdminBookingNotification(options: {
    customerName: string;
    customerEmail: string;
    serviceTitle: string;
    date: string;
    time: string;
}): Promise<EmailDeliveryResult> {
    const config = getEmailConfig();
    if (!config) throw new EmailNotConfiguredError();
    const recipient = config.adminRecipient ?? config.from;
    return sendEmail({
        to: recipient,
        replyTo: options.customerEmail,
        subject: `New booking request: ${options.serviceTitle}`,
        text: `${options.customerName} (${options.customerEmail}) requested ${options.serviceTitle} on ${options.date} at ${options.time}.`,
        html: layout(
            "New booking request",
            `<p style="margin:0;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;"><strong>${escapeHtml(options.customerName)}</strong> (${escapeHtml(options.customerEmail)}) requested <strong>${escapeHtml(options.serviceTitle)}</strong> on ${escapeHtml(options.date)} at ${escapeHtml(options.time)}.</p>`,
        ),
    });
}

export async function sendBookingStatusEmail(options: {
    to: string;
    customerName: string;
    serviceTitle: string;
    date: string;
    time: string;
    status: string;
}): Promise<EmailDeliveryResult> {
    const { clientOrigin } = getServerConfig();
    return sendEmail({
        to: options.to,
        subject: `Appointment ${options.status}: ${options.serviceTitle}`,
        text: `Hello ${options.customerName},\n\nYour appointment for ${options.serviceTitle} on ${options.date} at ${options.time} is now ${options.status}.\n\nView your appointments: ${clientOrigin}/dashboard/appointments`,
        html: layout(
            "Appointment updated",
            `<p style="margin:0 0 12px;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;">Hello ${escapeHtml(options.customerName)},</p>
             <p style="margin:0;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;">Your appointment for <strong>${escapeHtml(options.serviceTitle)}</strong> on ${escapeHtml(options.date)} at ${escapeHtml(options.time)} is now <strong>${escapeHtml(options.status)}</strong>.</p>
             ${button(`${clientOrigin}/dashboard/appointments`, "View appointments")}`,
        ),
    });
}

export async function sendPaymentReceiptEmail(options: {
    to: string;
    customerName: string;
    serviceTitle: string;
    amount: number;
    method: string;
    date: string;
    time: string;
}): Promise<EmailDeliveryResult> {
    const { clientOrigin } = getServerConfig();
    return sendEmail({
        to: options.to,
        subject: `Payment received for ${options.serviceTitle}`,
        text: `Hello ${options.customerName},\n\nWe received BDT ${options.amount} for ${options.serviceTitle} on ${options.date} at ${options.time} (${options.method}).\n\nView your appointments: ${clientOrigin}/dashboard/appointments`,
        html: layout(
            "Payment received",
            `<p style="margin:0 0 12px;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;">Hello ${escapeHtml(options.customerName)},</p>
             <p style="margin:0;color:#d1d1d1;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;">We received <strong>BDT ${options.amount}</strong> for <strong>${escapeHtml(options.serviceTitle)}</strong> on ${escapeHtml(options.date)} at ${escapeHtml(options.time)} via ${escapeHtml(options.method)}.</p>
             ${button(`${clientOrigin}/dashboard/appointments`, "View appointments")}`,
        ),
    });
}
