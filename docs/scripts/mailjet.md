// server/src/lib/email.ts
import { env } from "../config/env.js";

export async function sendMail(to: string, subject: string, html: string) {
  // Mailjet uses Basic Auth: username=API Key, password=Secret Key
  const auth = Buffer.from(`${env.sendgrid.apiKey}:${env.sendgrid.apiSecret}`).toString("base64");

  const res = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Messages: [
        {
          From: { Email: env.sendgrid.fromEmail, Name: env.sendgrid.fromName },
          To: [{ Email: to }],
          Subject: subject,
          HTMLPart: html,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Mailjet ${res.status}: ${await res.text()}`);
}