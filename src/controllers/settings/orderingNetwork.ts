import type { CookieOptions, Request, Response } from "express";
import { env } from "../../configs/env.ts";
import { securityLog } from "../../lib/logger.ts";
import {
  orderingAddress,
  readOrderingNetwork,
  requestOrderingAddress,
  terminalMatches,
  updateOrderingNetwork,
} from "../../lib/orderingNetwork.ts";
import { isWellFormedToken, newToken, sha256 } from "../../lib/tokens.ts";

const COOKIE = "enjoyer-ordering-terminal";
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production" || env.COOKIE_SAMESITE === "none",
  sameSite: env.COOKIE_SAMESITE,
  path: "/admin/ordering-network",
};

type Network = Awaited<ReturnType<typeof readOrderingNetwork>>;
const describe = (req: Request, network: Network) => ({
  enabled: network.enabled,
  address: network.address,
  detectedAddress: requestOrderingAddress(req),
  terminalEnrolled: !!network.terminalHash,
  thisTerminal: terminalMatches(network, req.cookies?.[COOKIE]),
  updatedAt: network.updatedAt,
});

const invalidAddress = (res: Response) =>
  res.status(400).json({
    success: false,
    code: "ORDERING_ADDRESS_INVALID",
    message:
      "No usable IP address. Check the café network and the API’s ordering IP configuration.",
  });

export const getOrderingNetwork = async (req: Request, res: Response) =>
  res.json({ success: true, data: describe(req, await readOrderingNetwork()) });

export async function enrollOrderingTerminal(req: Request, res: Response) {
  const address = requestOrderingAddress(req);
  if (!address) return invalidAddress(res);
  if (address !== req.body.expectedAddress)
    return res.status(409).json({
      success: false,
      message:
        "Your network changed. Refresh the setting and confirm the detected address again.",
    });
  const token = newToken();
  const { current } = await updateOrderingNetwork((state) => ({
    ...state,
    enabled: true,
    address,
    terminalHash: sha256(token),
  }));
  securityLog("ordering_terminal_enrolled", { userId: req.user?.id, address });
  res.cookie(COOKIE, token, {
    ...cookieOptions,
    maxAge: 365 * 24 * 60 * 60_000,
  });
  return res.json({
    success: true,
    data: { ...describe(req, current), thisTerminal: true },
  });
}

export async function setOrderingNetwork(req: Request, res: Response) {
  const override = req.body.action === "override";
  const address = override ? orderingAddress(req.body.address) : null;
  if (override && (!address || !requestOrderingAddress(req)))
    return invalidAddress(res);
  const { current } = await updateOrderingNetwork((state) => ({
    ...state,
    enabled: override,
    address,
    terminalHash: null,
  }));
  securityLog(
    override ? "ordering_network_overridden" : "ordering_network_disabled",
    { userId: req.user?.id, address },
  );
  return res.json({ success: true, data: describe(req, current) });
}

export async function revokeOrderingTerminal(req: Request, res: Response) {
  const { current, changed } = await updateOrderingNetwork(
    (state) => (state.terminalHash ? { ...state, terminalHash: null } : null),
    false,
  );
  if (changed)
    securityLog("ordering_terminal_revoked", { userId: req.user?.id });
  return res.json({ success: true, data: describe(req, current) });
}

export async function syncOrderingTerminal(req: Request, res: Response) {
  const token: unknown = req.cookies?.[COOKIE];
  if (!isWellFormedToken(token))
    return res.json({
      success: true,
      data: { enrolled: false, changed: false },
    });
  const address = requestOrderingAddress(req);
  const { current, changed } = await updateOrderingNetwork(
    (state) =>
      state.enabled &&
      terminalMatches(state, token) &&
      address &&
      state.address !== address
        ? { ...state, address }
        : null,
    false,
  );
  const enrolled = terminalMatches(current, token);
  if (changed)
    securityLog("ordering_network_updated_by_terminal", {
      userId: req.user?.id,
      address,
    });
  // Revocation is server-side. A delayed response must not clear a newer
  // credential that the browser received from a concurrent enrollment.
  return res.json({ success: true, data: { enrolled, changed } });
}
