// Transcribed from the three menu screenshots supplied on 2026-11-11.
// Names omit Iced/Hot badges because those are represented as selectable options.
// Oat-milk eligibility was explicitly confirmed by the user for six drinks.
export type SeedItem = {
  name: string;
  price: string;
  description: string;
  isSpicy?: boolean;
  groups?: string[];
};
export const menuSeed: { name: string; items: SeedItem[] }[] = [
  {
    name: "Signature Coffee",
    items: [
      {
        name: "Tropical Black",
        price: "250.00",
        description:
          "Double shot espresso, pineapple, lemon, falernum, soda water.",
      },
      {
        name: "Smoke & Bramble",
        price: "220.00",
        description:
          "Double shot espresso, lapsang souchong tea, blackberry, orange.",
      },
      {
        name: "Crema Catalana Latte",
        price: "250.00",
        description:
          "Double shot espresso, hamungaya farms sugar, orange, lemon, cinnamon, farm fresh milk.",
        groups: ["Temperature", "Milk substitution"],
      },
      {
        name: "Honey Oat Osmanthus Latte",
        price: "250.00",
        description:
          "Double shot espresso, wild honey, osmanthus, oat milk, oat foam.",
        groups: ["Temperature"],
      },
    ],
  },
  {
    name: "Black",
    items: [
      {
        name: "Espresso",
        price: "110.00",
        description: "Double shot, Yardstick – Legazpi Blend.",
      },
      {
        name: "Long Black",
        price: "130.00",
        description: "Double shot espresso over hot or cold water.",
        groups: ["Temperature"],
      },
    ],
  },
  {
    name: "White",
    items: [
      {
        name: "Cortado",
        price: "160.00",
        description:
          "Double shot espresso with a small amount of steamed milk.",
        groups: ["Milk substitution"],
      },
      {
        name: "Flat White",
        price: "180.00",
        description: "Double shot espresso with milk.",
        groups: ["Temperature", "Milk substitution"],
      },
      {
        name: "Mocha",
        price: "220.00",
        description:
          "Double shot espresso, Milk, Auro Chocolate, Brown sugar syrup, vanilla.",
        groups: ["Temperature", "Milk substitution"],
      },
    ],
  },
  {
    name: "Non-Coffee",
    items: [
      {
        name: "Matcha Latte",
        price: "240.00",
        description: "Yumeno Matcha High-Grade Signature Blend",
        groups: ["Temperature", "Milk substitution"],
      },
      {
        name: "Chocolate",
        price: "160.00",
        description:
          "Auro chocolate, housemade brown sugar chocolate syrup, vanilla, milk.",
        groups: ["Temperature", "Milk substitution"],
      },
    ],
  },
  {
    name: "Refreshers",
    items: [
      { name: "Almond Fizz", price: "230.00", description: "Orgeat, lemon." },
      {
        name: "Rosemary Peach Soda",
        price: "230.00",
        description: "Peach, rosemary, orange.",
      },
    ],
  },
  {
    name: "Starters",
    items: [
      {
        name: "Potato Enjoyer",
        price: "200.00",
        description: "Fried potatoes, garlic aioli, chimichurri.",
      },
    ],
  },
  {
    name: "Sandwiches",
    items: [
      {
        name: "Cheese Burger",
        price: "350.00",
        description: "Angus beef, brioche bun, cheese, sauce.",
        groups: ["Sandwich extras"],
      },
      {
        name: "Fried Chicken Sandwich",
        price: "350.00",
        description: "Sichuan honey, ranch, seasonal slaw.",
        isSpicy: true,
        groups: ["Sandwich extras"],
      },
      {
        name: "Grilled Cheese",
        price: "320.00",
        description: "Sourdough, mozzarella, cheddar, tomato jam.",
        groups: ["Sandwich extras"],
      },
    ],
  },
  {
    name: "Pastries",
    items: [
      { name: "Croissant", price: "130.00", description: "" },
      { name: "Pain Au Chocolat", price: "140.00", description: "" },
      { name: "Blueberry Danish", price: "140.00", description: "" },
      { name: "Strawberry Danish", price: "140.00", description: "" },
    ],
  },
];

export const optionGroupSeed = [
  {
    name: "Temperature",
    required: true,
    sortOrder: 0,
    options: [
      { name: "Iced", priceDelta: "0.00", sortOrder: 0 },
      { name: "Hot", priceDelta: "0.00", sortOrder: 1 },
    ],
  },
  {
    name: "Milk substitution",
    required: false,
    sortOrder: 1,
    options: [{ name: "Oat milk", priceDelta: "30.00", sortOrder: 0 }],
  },
  {
    name: "Sandwich extras",
    required: false,
    sortOrder: 2,
    options: [{ name: "Side Fries", priceDelta: "60.00", sortOrder: 0 }],
  },
];
