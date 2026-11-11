import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { pool } from "../src/db/index.ts";
import { handlePublicMenu } from "../src/controllers/menuItems/public.ts";
import type { OptionGroupView } from "../src/lib/menuOptions.ts";
import { menuSeed, optionGroupSeed } from "./data/enjoyer-menu.ts";

try {
  let payload: any;
  await handlePublicMenu(
    {} as Request,
    {
      json(value: unknown) {
        payload = value;
      },
    } as Response,
  );
  assert.equal(payload.currency, "PHP");
  let itemCount = 0,
    links = 0;
  for (const category of menuSeed) {
    const actualCategory = payload.data.find(
      (c: any) => c.name === category.name,
    );
    assert.ok(actualCategory, `Missing category ${category.name}`);
    for (const source of category.items) {
      const item = actualCategory.items.find(
        (i: any) => i.name === source.name,
      );
      assert.ok(item, `Missing item ${source.name}`);
      assert.equal(item.price, source.price);
      assert.equal(item.description, source.description);
      assert.equal(item.isSpicy, source.isSpicy ?? false);
      assert.deepEqual(
        item.optionGroups.map((g: OptionGroupView) => g.name).sort(),
        [...(source.groups ?? [])].sort(),
      );
      for (const group of item.optionGroups as OptionGroupView[]) {
        const expected = optionGroupSeed.find((g) => g.name === group.name)!;
        assert.equal(group.required, expected.required);
        assert.equal(group.maxSelections, 1);
        assert.deepEqual(
          group.options.map((o) => [o.name, o.priceDelta, o.isAvailable]),
          expected.options.map((o) => [o.name, o.priceDelta, true]),
        );
        links++;
      }
      itemCount++;
    }
  }
  console.log(
    JSON.stringify({
      verified: true,
      categories: menuSeed.length,
      items: itemCount,
      optionAssignments: links,
    }),
  );
} catch (err) {
  console.error(
    "Seeded menu verification failed:",
    err instanceof assert.AssertionError
      ? err.message
      : "database or API query error",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
