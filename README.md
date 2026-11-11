# Enjoyer API

## API-only invite testing

The invite email points to `CLIENT_URL/accept-invite#token=...`. That is a
frontend URL, not an API route; the frontend is deferred. Receiving this email
means account creation and email delivery reached the invitation step. A pending
Manager cannot log in until they set a password, just like Staff and Owners.

Import `postman/Enjoyer-users.postman_collection.json` into Postman. Run requests
individually, rather than running the whole collection unattended. Some requests
send email, change passwords or disable the test account.

1. Set `baseUrl` to your API (default `http://localhost:3000`) and `origin` to
   an entry in `CORS_ORIGINS` (typically `http://localhost:5173`). Set local
   `ownerEmail`, `ownerPassword`, `managerName`, `managerEmail`, and
   `managerPassword` values. Keep real credentials out of shared exports.
2. Run **Owner login**, then **Create Manager**. The collection saves the Owner
   Bearer token and the new account ID. Check `inviteEmailSent`; if false, the
   account still exists and you should resend its invite after the cooldown.
3. Copy only the characters after `#token=` in the invite email into the
   `inviteToken` variable. Do not include the URL or `#token=` prefix.
4. Run **Validate invitation**, then **Accept invitation**. Acceptance sets the
   password and consumes the token; it does not log in automatically.
5. Run **Manager login**, then **Current Manager profile**. Login saves a
   separate Manager Bearer token and an HttpOnly refresh cookie. A Manager
   receives 403 from `/admin/accounts`, because account management is Owner-only.

Equivalent invite acceptance request (no Bearer token required):

```http
PATCH /auth/invite/accept
Content-Type: application/json

{ "token": "TOKEN_FROM_EMAIL", "newPwd": "YOUR_NEW_PASSWORD" }
```

Passwords require at least 12 characters and at most 72 UTF-8 bytes (128
characters maximum); breached passwords are rejected when the configured
check finds a match. Invites expire after 72 hours. Resending rotates the token,
so only the latest link works. Existing `PATCH /auth/password/reset` clients
can still complete invites; `/auth/invite/accept` additionally requires an
account that has never set a password.

Login, refresh and logout require an allowed `Origin` header even in Postman.
Keep Postman's cookie jar enabled. The last login controls the refresh cookie,
while the collection stores Owner and Manager access tokens separately.
After changing/resetting a password, update your local password variable and
log in again. `/auth/password/forgot` returns the same response for unknown,
inactive, throttled and eligible accounts.

## Authentication routes

| Method | Path | Authentication / body |
| --- | --- | --- |
| POST | `/auth/login` | Allowed Origin; `{ email, pwd }` |
| GET | `/auth/me` | Any active staff-side user's Bearer token |
| POST | `/auth/invite/validate` | `{ token }`; checks without consuming |
| PATCH | `/auth/invite/accept` | `{ token, newPwd }`; pending accounts only |
| POST | `/auth/password/forgot` | `{ email }` |
| PATCH | `/auth/password/reset` | `{ token, newPwd }` |
| PATCH | `/auth/password/change` | Bearer token; `{ currentPwd, newPwd }` |
| POST | `/auth/refresh` | Allowed Origin and refresh cookie |
| POST | `/auth/logout` | Allowed Origin; revokes current device's session family |

There is no public registration, customer account, hard-delete endpoint, or
email-change flow. Owner-created invitations are how staff-side users join.

## Account management

All `/admin/accounts` routes require an active Owner's Bearer access token.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/admin/accounts` | List, search and filter accounts |
| GET | `/admin/accounts/:id` | Get one account |
| POST | `/admin/accounts` | Create an account and email an invite |
| POST | `/admin/accounts/:id/resend-invite` | Resend a pending invite |
| PATCH | `/admin/accounts/:id` | Edit name and/or role |
| POST | `/admin/accounts/:id/deactivate` | Disable an account |
| POST | `/admin/accounts/:id/reactivate` | Enable an account |

Example update body:

```json
{ "name": "Ana", "role": "manager" }
```

Names are trimmed and must contain 1–100 characters. Roles are `staff`,
`manager`, or `owner`. Empty update bodies and unknown fields return 400.
**API change:** `active` is no longer accepted by PATCH; use the dedicated
deactivate/reactivate endpoints, which require no body. Email editing is not
supported. Invalid or missing account IDs return 404.

Owners can rename themselves but cannot change their own role or deactivate
themselves (409). Another active Owner must perform those actions. All three
mutations serialize through a shared transaction lock, then recheck the acting
Owner. This ensures at least one active Owner remains, including when two
Owners try to remove each other's access at the same time.

Success returns `{ "success": true, "data": account }`, with an additional
message for deactivation/reactivation. Account data uses the same safe fields
as the list endpoint; passwords and token hashes are never returned. Repeated
requests that make no change do not update timestamps, revoke sessions again,
or emit another change event.

Role changes revoke existing refresh sessions; name-only edits do not.
Deactivation clears outstanding invite/reset links and their email cooldown,
and revokes refresh sessions. Reactivation does not restore those sessions or
links. A pending invite needs a new link via the resend-invite endpoint.
Accounts are retained rather than deleted.

`verifyJwt` checks current role and active state for every protected request.
`requireFreshPermission` performs an additional check at the sensitive account
router. Mutation handlers also recheck the Owner inside their transactions.
Old access tokens cannot retain a previous role's privileges and are rejected
while the account is inactive. Already-running requests may finish; JWTs are
not individually revoked, and an unexpired JWT may work again after reactivation.
Logout and password changes revoke refresh sessions; previously issued access
tokens remain usable until their short expiry (1 minute in production, 10 in
development/test), subject to current account permissions. Clients should
discard access tokens on logout or password change.

Login, refresh, logout and password/account mutations lock user rows before
changing sessions. This prevents a concurrent refresh from escaping session
revocation. The database schema is unchanged by these routes.

## Menu categories

Apply the generated migration before testing these routes. From the `api`
directory, run `npm run db:migrate` using the configured migration database
connection. `drizzle/0001_menu_categories.sql` creates the categories table,
validation constraints and ordering index. This is already applied to the
configured database; run migrations when setting up another database.

All category routes require an active **Manager or Owner** Bearer token through
`menu:manage`. Staff receive 403; unauthenticated or inactive users receive 401.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/admin/categories` | Create a category; returns 201 |
| GET | `/admin/categories?limit=50&offset=0` | List categories in display order |
| PATCH | `/admin/categories/:id` | Rename and/or change the display position |

Example creation body:

```json
{ "name": "Sandwiches", "sortOrder": 10 }
```

Names are trimmed and must contain 1–100 characters. `sortOrder` is an integer
from 0 to 2147483647 and defaults to 0 on creation. Lower values appear first;
equal positions sort by ID. Updating a position does not renumber other
categories. Category names are not required to be unique.

PATCH accepts either field or both, preserves omitted fields, and rejects empty
bodies. Unknown fields, invalid names and invalid positions return 400. Missing
or invalid category IDs return 404. Category responses contain `id`, `name`,
`sortOrder`, `createdAt`, and `updatedAt`. List responses include
`pagination: { limit, offset, total, hasMore }`; the maximum limit is 100.

Import `postman/Enjoyer-categories.postman_collection.json` for login, creation,
listing, renaming and reordering requests.

## Menu items and public menu

From `api`, run `npm run db:migrate` before using the new routes. Migration
`drizzle/0002_menu_items.sql` adds items, their category foreign key, validation
constraints and display-order index. This and the option migration described
below were applied to the configured database during the menu seed.

| Method | Path | Permission / purpose |
| --- | --- | --- |
| POST | `/admin/menu-items` | Manager/Owner: create an item (201) |
| GET | `/admin/menu-items` | Manager/Owner: paginated list, including hidden items |
| GET | `/admin/menu-items/:id` | Manager/Owner: item details |
| PATCH | `/admin/menu-items/:id` | Manager/Owner: edit, move category, hide/show, reorder |
| PATCH | `/staff/menu-items/:id/availability` | Staff/Manager/Owner: set sold-out or available |
| GET | `/menu` | Public: visible items grouped by category, no login |

Example creation body:

```json
{
  "categoryId": 1,
  "name": "Cheese Burger",
  "description": "Angus beef, brioche bun, cheese, sauce",
  "price": "350.00",
  "isSpicy": false,
  "isAvailable": true,
  "isHidden": false,
  "sortOrder": 0
}
```

Create the category first and use its actual ID. Required fields are
`categoryId`, `name` and `price`; the other fields default to the values above,
except `description`, which defaults to an empty string. Names are trimmed and
limited to 100 characters; descriptions are trimmed and limited to 2000.
Booleans must be JSON booleans, and positions must be nonnegative int4 values.
PATCH changes only supplied fields and requires at least one field.

Prices are **Philippine pesos**, accept a JSON number or decimal string, and
are returned as exact two-decimal strings (for example `"350.00"`). The allowed
range is 0 through 99999999.99. More than two decimal places is rejected, not
rounded. Currency is defined once in `src/configs/currency.ts` and returned as
`currency: "PHP"`. PostgreSQL stores prices as `numeric(10,2)`.

Use `{ "isAvailable": false }` on the Staff route to mark an item sold out,
or `true` to restore availability. Only this field is accepted there; Staff
cannot change prices, hide items or edit other menu details. The explicit state
makes repeated requests safe. Hidden and sold-out are independent flags.

List filters are `categoryId`, `isAvailable=true|false`, `isHidden=true|false`,
`limit` (default 50, max 100), and `offset` (default 0). Item lists sort by
category position/ID and then item position/ID. Bad bodies and invalid queries
return 400. A nonexistent category returns 400; missing or invalid item IDs
return 404. Category references are enforced by a foreign key, and a category
with items cannot be deleted through the database while those references exist.

`GET /menu` returns `{ success, currency, data: [{ id, name, sortOrder, items }] }`.
It omits hidden items and categories with no visible items. Sold-out items remain
present with `isAvailable: false`. It reads current database state on each request;
live push updates and cart/order availability enforcement belong to later work.
The customer menu is browseable without a QR token; table QR validation will be
required for ordering when that feature is implemented.

Import `postman/Enjoyer-menu-items.postman_collection.json` to test creation,
editing, sold-out state, hiding and the public menu. Option groups and add-ons
are described below. Images and real-time subscriptions are not implemented.
There is no hard-delete route; use hiding to remove an item from the public menu.

## Seeded Enjoyer menu and options

The three screenshots supplied on 2026-11-11 were transcribed into
`scripts/data/enjoyer-menu.ts`. The configured database now contains the source
menu: **8 categories, 21 items, 3 option groups, 4 choices and 16 item/group
associations**. Fried Chicken Sandwich is spicy. All newly seeded items are
visible and available. No promotional tags were added.

| Option group | Required | Choices | Applies to |
| --- | --- | --- | --- |
| Temperature | Yes | Iced / Hot, +₱0 | Crema Catalana Latte, Honey Oat Osmanthus Latte, Long Black, Flat White, Mocha, Matcha Latte, Chocolate |
| Milk substitution | No | Oat milk, +₱30 | Crema Catalana Latte, Cortado, Flat White, Mocha, Matcha Latte, Chocolate |
| Sandwich extras | No | Side Fries, +₱60 | Cheese Burger, Fried Chicken Sandwich, Grilled Cheese |

Oat-milk eligibility was explicitly confirmed by the user. Honey Oat Osmanthus
Latte already includes oat milk. Iced/Hot badges are represented as options,
not duplicated products or text in their names. Pastries have empty descriptions
because the source menu provides none. Category display order is Signature
Coffee, Black, White, Non-Coffee, Refreshers, Starters, Sandwiches, Pastries.

`0003_menu_options.sql` adds option groups, choices, and item/group links.
Each group allows at most one selection. `required: true` means a selection is
required; otherwise leaving it unselected preserves the standard recipe/base
price. `priceDelta` is an exact decimal peso surcharge. Each choice has an
availability flag, allowing it to stay visible but unavailable. Shared group
edits affect every attached item.

`GET /menu` now includes `optionGroups` on every item. Each group contains
`id`, `name`, `required`, `maxSelections: 1`, `sortOrder` and `options` (choice
IDs, names, price deltas, availability and order). Options are batch-loaded for
the visible menu. Choice validation and server-calculated order totals will be
enforced when cart/order submission is implemented; there is no ordering API yet.

All management endpoints below require `menu:manage` (Manager or Owner):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/admin/option-groups` | List groups with choices |
| POST | `/admin/option-groups` | Create a group and 1–50 choices atomically |
| PATCH | `/admin/option-groups/:id` | Edit name, required flag or order |
| POST | `/admin/option-groups/:id/options` | Add a choice |
| PATCH | `/admin/option-groups/:id/options/:optionId` | Edit name, priceDelta, availability or order |
| GET | `/admin/menu-items/:id/option-groups` | Inspect an item's choices |
| PUT | `/admin/menu-items/:id/option-groups` | Replace the complete assignment list with `{ "groupIds": [1, 2] }` |

PUT validates all group IDs before changing links, rejects duplicates, and
accepts an empty list to detach all groups. It does not delete the groups or
choices themselves. Import `postman/Enjoyer-options.postman_collection.json`
for management examples; use the actual IDs returned by the API.

Seed commands (run from `api`):

```text
npm run seed:menu -- --dry-run
npm run seed:menu
npm run verify:menu
```

The seed validates its data, locks menu tables for the short transaction,
matches existing names case-insensitively, and inserts only missing records.
It refuses ambiguous matches or conflicting existing values instead of
overwriting menu edits. Existing ordering is preserved. It does not delete
data. The dry run performs no writes. A repeat dry run after seeding reported
zero inserts. `verify:menu` executes the actual public-menu handler against
PostgreSQL and checks every seeded name, description, price, spicy flag and
option assignment against the source manifest. It is an initial-seed check;
intentional later menu edits can cause it to report differences.

## Checks

Run `npm run typecheck` and `npm test`. The authentication suite runs the
production Express app over local HTTP with real bcrypt and JWT handling.
It covers creation, invitations, login, profile, refresh/logout, recovery,
password changes, account reads, duplicate emails, failed email delivery and
rejected session operations. The account suite covers editing, role permissions,
deactivation/reactivation and self-protection rules.

Database responses, email, rate limiting and the breach-check service are mocked
in the authentication suite. These tests do not verify PostgreSQL transaction
isolation, SMTP delivery, or external service behavior. The account suite also
mocks JWT verification. Node's experimental module-mocking flag is included in
the npm test script. `src/app.ts` exports the app for tests; `server.ts` owns
listening, background maintenance and shutdown.

Category tests keep real Drizzle SQL generation and result mapping while
mocking the PostgreSQL driver. They cover authorization, validation, ordering,
pagination, partial updates and error handling. A separate test verifies the
category router is mounted in the production app. Database constraints and
migration execution still need validation against your PostgreSQL database.

Menu-item tests also keep real Drizzle SQL generation and mock the driver. They
cover exact price parsing, category errors, permissions, partial edits, pagination,
availability-only Staff writes, and public hidden/sold-out filtering. Production
app tests verify that `/menu` is mounted before authentication and protected item
routes remain behind it.
