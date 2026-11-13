import express from "express";
import {
  addCartItem,
  clearCart,
  deleteCartItem,
  getCart,
  updateCartItem,
} from "../../controllers/cart/public.ts";
import { requireTableSession } from "../../middlewares/tableSession.ts";
import {
  validateAddCartItem,
  validateCartVersionQuery,
  validateUpdateCartItem,
} from "../../validators/cart.ts";

const router = express.Router();
// Every cart route is authenticated by the printed table QR token. The cart
// belongs to the table's current session, so there is no cart id in the URL.
router.use(requireTableSession);

router.get("/", getCart);
router.post("/items", validateAddCartItem, addCartItem);
router.patch("/items/:id", validateUpdateCartItem, updateCartItem);
router.delete("/items/:id", validateCartVersionQuery, deleteCartItem);
router.delete("/", validateCartVersionQuery, clearCart);

export default router;
