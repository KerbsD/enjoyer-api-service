import QRCode from "qrcode";
import { env } from "../configs/env.ts";

export const tableUrl = (token: string): string => {
  const url = new URL("/order", env.CUSTOMER_URL ?? env.CLIENT_URL);
  // Fragment keeps the table token out of frontend server request logs.
  url.hash = new URLSearchParams({ table: token }).toString();
  return url.toString();
};
const options = { errorCorrectionLevel: "M" as const, margin: 4, width: 512 };
export const qrPng = (token: string) => QRCode.toBuffer(tableUrl(token), { ...options, type: "png" });
export const qrSvg = (token: string) => QRCode.toString(tableUrl(token), { ...options, type: "svg" });
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]!));

export const printSheet = async (tables: { id: number; name: string; qrToken: string }[]) => {
  const cards: string[] = [];
  for (const table of tables) {
    const image = Buffer.from(await qrSvg(table.qrToken)).toString("base64");
    cards.push(`<article><h2>${escapeHtml(table.name)}</h2><img alt="Table ${table.id} QR code" src="data:image/svg+xml;base64,${image}"><p>Scan to order · Just enjoy.</p></article>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Enjoyer table QR codes</title><style>
    @page { size: A4; margin: 12mm; } body { font-family: sans-serif; color: #111; }
    main { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8mm; }
    article { border: 1px solid #ccc; padding: 4mm; text-align: center; break-inside: avoid; }
    h2 { font-size: 18pt; margin: 2mm; overflow-wrap: anywhere; } img { width: 60mm; height: 60mm; }
    p { font-size: 11pt; } @media print { .help { display: none; } }
    </style></head><body><p class="help">Use your browser's Print command to print these active table codes.</p><main>${cards.join("")}</main>${cards.length ? "" : "<p>No active tables.</p>"}</body></html>`;
};
