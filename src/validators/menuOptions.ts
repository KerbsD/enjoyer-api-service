import { z } from "zod";
import { priceSchema } from "./menuItems.ts";
import { validateBody } from "../lib/validate.ts";

const name = z.string().trim().min(1).max(100);
const sortOrder = z.number().int().min(0).max(2_147_483_647);
const minSelections = z.number().int().min(0).max(50);
const maxSelections = z.number().int().min(1).max(50);
const optionFields = {
  name,
  priceDelta: priceSchema,
  isAvailable: z.boolean(),
  sortOrder,
};

const selectionIssues = (
  value: {
    required?: boolean;
    minSelections?: number;
    maxSelections?: number;
  },
  ctx: z.RefinementCtx,
) => {
  if (
    value.minSelections !== undefined &&
    value.maxSelections !== undefined &&
    value.minSelections > value.maxSelections
  )
    ctx.addIssue({
      code: "custom",
      path: ["maxSelections"],
      message: "maxSelections must be at least minSelections.",
    });
  if (
    value.required !== undefined &&
    value.minSelections !== undefined &&
    value.required !== (value.minSelections >= 1)
  )
    ctx.addIssue({
      code: "custom",
      path: ["required"],
      message:
        "required must be true exactly when minSelections is at least 1.",
    });
};

export const createOptionSchema = z.strictObject({
  name,
  priceDelta: priceSchema.default("0.00"),
  isAvailable: z.boolean().default(true),
  sortOrder: sortOrder.default(0),
});
export const createOptionGroupSchema = z
  .strictObject({
    name,
    required: z.boolean().optional(),
    minSelections: minSelections.optional(),
    maxSelections: maxSelections.optional(),
    sortOrder: sortOrder.default(0),
    options: z.array(createOptionSchema).min(1).max(50),
  })
  .superRefine((value, ctx) => {
    selectionIssues(value, ctx);
    if (
      value.minSelections !== undefined &&
      value.minSelections > value.options.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["minSelections"],
        message: "minSelections cannot exceed the number of options.",
      });
  });
export const updateOptionGroupSchema = z
  .strictObject({
    name,
    required: z.boolean(),
    minSelections,
    maxSelections,
    sortOrder,
  })
  .partial()
  .superRefine((value, ctx) => {
    selectionIssues(value, ctx);
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide a field to update.",
  });
export const updateOptionSchema = z
  .strictObject(optionFields)
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide a field to update.",
  });

export const assignOptionGroupsSchema = z.strictObject({
  groupIds: z
    .array(z.number().int().positive().max(2_147_483_647))
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Group IDs must be unique.",
    }),
});

export type CreateOptionGroupInput = z.infer<typeof createOptionGroupSchema>;
export type UpdateOptionGroupInput = z.infer<typeof updateOptionGroupSchema>;
export const validateCreateOptionGroup = validateBody(createOptionGroupSchema);
export const validateUpdateOptionGroup = validateBody(updateOptionGroupSchema);
export const validateCreateOption = validateBody(createOptionSchema);
export const validateUpdateOption = validateBody(updateOptionSchema);
export const validateAssignOptionGroups = validateBody(
  assignOptionGroupsSchema,
);
