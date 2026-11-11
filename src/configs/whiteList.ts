import { env } from "./env.ts";

// Cross Origin Resource Sharing: loaded from CORS_ORIGINS in .env
const whitelist: string[] = env.CORS_ORIGINS;

export default whitelist;
