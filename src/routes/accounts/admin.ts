import express from "express";
import { handleGetAccount } from "../../controllers/accounts/getAccount.ts";
import { handleCreateAccount } from "../../controllers/accounts/createAccount.ts";
import { handleListAccounts } from "../../controllers/accounts/listAccounts.ts";
import { handleResendInvite } from "../../controllers/accounts/resendInvite.ts";
import { handleUpdateAccount } from "../../controllers/accounts/updateAccount.ts";
import { requireFreshPermission } from "../../middlewares/requireFreshPermission.ts";
import { handleDeactivateAccount } from "../../controllers/accounts/deactivateAccount.ts";
import { handleReactivateAccount } from "../../controllers/accounts/reactivateAccount.ts";
import {
  validateCreateAccount,
  validateListAccountsQuery,
  validateUpdateAccount,
} from "../../validators/accounts.ts";

const router = express.Router();

// Mounted below verifyJwt in server.ts. Account management is Owner-only, and
// guarding the whole router (not each route) means any route added here later
// is Owner-only by default.
router.use(requireFreshPermission("account:manage"));

router.get("/", validateListAccountsQuery, handleListAccounts);
router.get("/:id", handleGetAccount);
router.post("/", validateCreateAccount, handleCreateAccount);
router.patch("/:id", validateUpdateAccount, handleUpdateAccount);
router.post("/:id/deactivate", handleDeactivateAccount);
router.post("/:id/reactivate", handleReactivateAccount);
router.post("/:id/resend-invite", handleResendInvite);

export default router;
