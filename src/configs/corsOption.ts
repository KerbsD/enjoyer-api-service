import type { CorsOptions } from "cors";
import whitelist from "./whiteList.ts";

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // No Origin header = same-origin or non-browser client (curl, server-to-server).
    // Anything else must be whitelisted. A rejected origin simply gets no CORS
    // headers, so browsers block it, and scanners can't flood the error log.
    callback(null, !origin || whitelist.includes(origin));
  },
  // Required for the browser to send/accept the refresh cookie cross-origin
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Table-Token"],
  maxAge: 600, // let browsers cache preflight results for 10 minutes
  optionsSuccessStatus: 200,
};

export default corsOptions;
