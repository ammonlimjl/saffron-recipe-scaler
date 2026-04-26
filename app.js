// PrepFresh — recipe scaler & unit converter.
// Pipeline: parse pasted recipe → scale by servings → convert units →
// render with copy/share + Pro upsell hooks.

const SAMPLE_RECIPE = `Honey Garlic Chicken Stir-Fry
Serves 4

For the sauce:
1/4 cup soy sauce
3 tablespoons honey
2 cloves garlic, minced
1 teaspoon grated ginger
1 tablespoon rice vinegar

For the stir-fry:
500g boneless chicken thighs, cut into bite-sized pieces
2 tablespoons vegetable oil
1 red bell pepper, sliced
1 cup broccoli florets
3 spring onions, chopped

To serve:
2 cups cooked jasmine rice
1 tablespoon sesame seeds`;

const UNICODE_FRACTIONS = {
  "\u00BC": "1/4", "\u00BD": "1/2", "\u00BE": "3/4",
  "\u2153": "1/3", "\u2154": "2/3",
  "\u215B": "1/8", "\u215C": "3/8", "\u215D": "5/8", "\u215E": "7/8",
  "\u2155": "1/5", "\u2156": "2/5", "\u2157": "3/5", "\u2158": "4/5",
  "\u2159": "1/6", "\u215A": "5/6",
};

const UNICODE_FRACTION_REGEX = /[\u00BC\u00BD\u00BE\u2153\u2154\u215B\u215C\u215D\u215E\u2155\u2156\u2157\u2158\u2159\u215A]/g;

const JUNK_PATTERNS = [
  /^(save|print|pin|share|email)\s*(recipe|to.+)?$/i,
  /^jump to (recipe|video|instructions|comments)$/i,
  /^(advertisement|sponsored|ad)$/i,
  /^ad ends in\b/i,
  /^click (here )?(for|to)\b/i,
  /^continue reading\b/i,
  /^(rate|review) this recipe/i,
  /^scroll (down|to)\b/i,
  /^(now popular|trending|featured|popular)$/i,
  /^you (might|may) (also )?like\b/i,
  /^related (recipes?|posts?|articles?)\b/i,
  /^more (recipes?|posts?|articles?)\b/i,
  /^(get|view|read) (the )?(recipe|more)\b/i,
  /^video (paused|unpaused|playing|loading|started|completed|ended)$/i,
  /^a note (from|on|about|by)\b/i,
  /^keep screen (awake|on|active)\b/i,
  /^cook(?:ing)? mode\b/i,
  /^prevent your screen\b/i,
  /^recipe (notes?|tester|writer|developer)\b/i,
  /^cook'?s (notes?|tips?)\s*:?\s*$/i,
  /^(prep|cook|total|active|inactive|chill|cooling|resting|rest|stand|wait) time\s*:/i,
];

const UNIT_WORDS = [
  "tablespoons", "tablespoon", "tbsp", "tbs",
  "teaspoons", "teaspoon", "tsp",
  "cups", "cup",
  "pints", "pint", "pt",
  "quarts", "quart", "qt",
  "gallons", "gallon", "gal",
  "fluid ounces", "fluid ounce", "fl oz",
  "milliliters", "milliliter", "millilitres", "millilitre", "ml",
  "liters", "liter", "litres", "litre",
  "kilograms", "kilogram", "kg",
  "grams", "gram", "g",
  "ounces", "ounce", "oz",
  "pounds", "pound", "lbs", "lb",
  "cloves", "clove",
  "slices", "slice",
  "pieces", "piece",
  "sprigs", "sprig",
  "cans", "can",
  "jars", "jar",
  "bunches", "bunch",
  "pinches", "pinch",
  "dashes", "dash",
  "sticks", "stick",
  "heads", "head",
  "l",
];

const UNIT_REGEX = new RegExp(
  "^(" +
    UNIT_WORDS.slice()
      .sort((a, b) => b.length - a.length)
      .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|") +
    ")\\b\\.?\\s*",
  "i"
);

// === Unit conversion data ===

// Volume units: each maps to milliliters.
const VOLUME_UNITS = {
  ml: 1,
  l: 1000,
  tsp: 4.92892,
  tbsp: 14.7868,
  "fl oz": 29.5735,
  cup: 236.588,
  pint: 473.176,
  quart: 946.353,
  gallon: 3785.41,
};

// Mass units: each maps to grams.
const MASS_UNITS = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
};

// Order shown in dropdowns (small to large within each system).
const VOLUME_UNIT_ORDER = ["tsp", "tbsp", "fl oz", "cup", "pint", "quart", "gallon", "ml", "l"];
const MASS_UNIT_ORDER = ["oz", "lb", "g", "kg"];

// Map plural/abbreviated/synonymous unit strings to canonical keys.
const UNIT_NORMALIZE = {
  "cup": "cup", "cups": "cup",
  "tablespoon": "tbsp", "tablespoons": "tbsp", "tbsp": "tbsp", "tbs": "tbsp",
  "teaspoon": "tsp", "teaspoons": "tsp", "tsp": "tsp",
  "pint": "pint", "pints": "pint", "pt": "pint",
  "quart": "quart", "quarts": "quart", "qt": "quart",
  "gallon": "gallon", "gallons": "gallon", "gal": "gallon",
  "fl oz": "fl oz", "fluid ounce": "fl oz", "fluid ounces": "fl oz",
  "ml": "ml", "milliliter": "ml", "milliliters": "ml", "millilitre": "ml", "millilitres": "ml",
  "l": "l", "liter": "l", "liters": "l", "litre": "l", "litres": "l",
  "g": "g", "gram": "g", "grams": "g",
  "kg": "kg", "kilogram": "kg", "kilograms": "kg",
  "oz": "oz", "ounce": "oz", "ounces": "oz",
  "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb",
};

// Approximate density in grams per milliliter for cross-dimension conversion.
// Numbers are baking-reference estimates; exact density depends on packing.
const DENSITY_G_PER_ML = {
  // === Liquids (kept in ml in Metric) ===
  "water": 1.0,
  "milk": 1.03,
  "buttermilk": 1.04,
  "almond milk": 1.03,
  "soy milk": 1.03,
  "oat milk": 1.03,
  "evaporated milk": 1.07,
  "cream": 1.01,
  "heavy cream": 1.0,
  "whipping cream": 0.99,
  "double cream": 1.0,
  "single cream": 1.0,
  "half and half": 1.02,
  "half-and-half": 1.02,
  "stock": 1.0,
  "broth": 1.0,
  "juice": 1.04,
  "lemon juice": 1.03,
  "lime juice": 1.03,
  "orange juice": 1.04,
  "olive oil": 0.92,
  "vegetable oil": 0.92,
  "canola oil": 0.92,
  "sunflower oil": 0.92,
  "sesame oil": 0.92,
  "coconut oil": 0.92,
  "oil": 0.92,
  "vinegar": 1.01,
  "rice vinegar": 1.01,
  "balsamic vinegar": 1.06,
  "white vinegar": 1.01,
  "apple cider vinegar": 1.01,
  "soy sauce": 1.15,
  "fish sauce": 1.20,
  "worcestershire sauce": 1.10,
  "ponzu": 1.04,
  "wine": 0.99,
  "white wine": 0.99,
  "red wine": 0.99,
  "marsala": 0.99,
  "vermouth": 0.99,
  "beer": 1.01,
  "sake": 0.99,
  "mirin": 1.04,
  "dashi": 1.0,
  "cognac": 0.94,
  "rum": 0.94,
  "vodka": 0.94,
  "coffee": 1.0,
  "espresso": 1.0,
  "tea": 1.0,
  "coconut milk": 0.98,
  "coconut cream": 0.98,
  "coconut water": 1.0,
  "santan": 0.98,
  "vanilla extract": 0.88,
  "almond extract": 0.88,

  // === Thick "liquids" but commonly weighed (treated as solid in Metric) ===
  "honey": 1.42,
  "maple syrup": 1.32,
  "molasses": 1.40,
  "treacle": 1.40,
  "golden syrup": 1.42,
  "corn syrup": 1.38,
  "condensed milk": 1.30,
  "peanut butter": 1.10,
  "almond butter": 1.05,
  "tahini": 1.10,

  // === Dry baking solids ===
  "all-purpose flour": 0.53,
  "bread flour": 0.55,
  "whole wheat flour": 0.51,
  "almond flour": 0.40,
  "coconut flour": 0.51,
  "rice flour": 0.55,
  "flour": 0.53,
  "granulated sugar": 0.85,
  "brown sugar": 0.90,
  "powdered sugar": 0.56,
  "icing sugar": 0.56,
  "caster sugar": 0.83,
  "palm sugar": 0.85,
  "gula melaka": 0.85,
  "sugar": 0.85,
  "salt": 1.20,
  "kosher salt": 1.0,
  "sea salt": 1.20,
  "baking powder": 0.90,
  "baking soda": 0.90,
  "yeast": 0.55,
  "cocoa powder": 0.55,
  "cocoa": 0.55,
  "cornstarch": 0.55,
  "cornflour": 0.55,
  "cornmeal": 0.74,
  "grits": 0.74,
  "semolina": 0.69,
  "polenta": 0.78,
  "matcha": 0.50,
  "curry powder": 0.55,
  "paprika": 0.50,

  // === Grains, pasta, rice ===
  "cooked rice": 0.67,
  "jasmine rice": 0.85,
  "basmati rice": 0.78,
  "arborio rice": 0.85,
  "sushi rice": 0.85,
  "wild rice": 0.78,
  "brown rice": 0.78,
  "rice": 0.85,
  "rolled oats": 0.41,
  "porridge oats": 0.41,
  "oats": 0.41,
  "quinoa": 0.78,
  "couscous": 0.85,
  "pasta": 0.70,
  "spaghetti": 0.70,
  "macaroni": 0.45,
  "lasagna sheets": 0.45,

  // === Cheeses ===
  "parmesan": 0.40,
  "parmigiano": 0.40,
  "pecorino": 0.40,
  "mozzarella": 0.45,
  "cheddar": 0.42,
  "gruyere": 0.42,
  "comte": 0.42,
  "feta": 0.45,
  "goat cheese": 0.55,
  "blue cheese": 0.50,
  "ricotta": 0.55,
  "mascarpone": 0.95,
  "cream cheese": 0.97,
  "cottage cheese": 1.05,
  "shredded cheese": 0.42,
  "grated cheese": 0.42,
  "cheese": 0.45,

  // === Pastes & sauces (commonly weighed) ===
  "tomato paste": 1.10,
  "tomato sauce": 1.04,
  "tomato puree": 1.05,
  "miso paste": 1.20,
  "miso": 1.20,
  "wasabi paste": 1.10,
  "curry paste": 1.10,
  "chili paste": 1.10,
  "harissa": 1.10,
  "sambal": 1.10,
  "tamarind paste": 1.30,
  "shrimp paste": 1.20,
  "belacan": 1.20,
  "kecap manis": 1.20,
  "kaya": 1.20,
  "dijon mustard": 1.10,
  "mustard": 1.05,
  "ketchup": 1.10,
  "mayonnaise": 0.91,

  // === Butter, fats, dairy solids ===
  "butter": 0.91,
  "shortening": 0.90,
  "lard": 0.92,
  "yogurt": 1.05,
  "greek yogurt": 1.05,
  "creme fraiche": 0.98,
  "crème fraîche": 0.98,
  "sour cream": 0.96,

  // === Nuts, seeds, dried fruit, chocolate ===
  "almonds": 0.55,
  "walnuts": 0.55,
  "cashews": 0.55,
  "pecans": 0.55,
  "pistachios": 0.55,
  "hazelnuts": 0.55,
  "pine nuts": 0.50,
  "peanuts": 0.55,
  "sesame seeds": 0.71,
  "chia seeds": 0.65,
  "flax seeds": 0.65,
  "pumpkin seeds": 0.65,
  "sunflower seeds": 0.55,
  "raisins": 0.55,
  "dried cranberries": 0.55,
  "chocolate chips": 0.60,
  "marshmallows": 0.16,

  // === Fresh produce, aromatics ===
  "ginger": 0.60,
  "garlic": 1.0,
  "lemongrass": 0.50,
  "galangal": 0.65,
  "kaffir lime leaves": 0.30,
  "broccoli": 0.34,
  "cauliflower": 0.30,
  "carrot": 0.50,
  "onion": 0.50,
  "tomato": 0.65,
  "spinach": 0.20,
  "kale": 0.20,
  "lettuce": 0.20,
  "cabbage": 0.30,
  "celery": 0.40,
  "zucchini": 0.65,
  "eggplant": 0.45,
  "potato": 0.70,
  "sweet potato": 0.70,
  "mushrooms": 0.40,
  "frozen peas": 0.65,
  "peas": 0.65,
  "corn kernels": 0.70,
  "edamame": 0.65,
  "apple": 0.55,
  "banana": 0.60,
  "blueberries": 0.70,
  "strawberries": 0.65,
  "raspberries": 0.55,

  // === Meats (when measured by volume — uncommon but supported) ===
  "ground beef": 1.04,
  "ground pork": 1.04,
  "ground turkey": 1.04,
  "ground chicken": 1.04,

  // === Breads & breadcrumbs ===
  "panko breadcrumbs": 0.30,
  "panko": 0.30,
  "breadcrumbs": 0.45,

  // === Fresh herbs (chopped) ===
  "parsley": 0.30,
  "fresh parsley": 0.30,
  "basil": 0.30,
  "fresh basil": 0.30,
  "cilantro": 0.30,
  "fresh cilantro": 0.30,
  "coriander leaves": 0.30,
  "mint": 0.30,
  "fresh mint": 0.30,
  "dill": 0.30,
  "fresh dill": 0.30,
  "chives": 0.40,
  "fresh chives": 0.40,
  "rosemary": 0.40,
  "fresh rosemary": 0.40,
  "thyme": 0.40,
  "fresh thyme": 0.40,
  "oregano": 0.40,
  "fresh oregano": 0.40,
  "sage": 0.40,
  "fresh sage": 0.40,
  "tarragon": 0.40,

  // === Ground spices ===
  "black pepper": 0.50,
  "white pepper": 0.50,
  "ground pepper": 0.50,
  "cumin": 0.50,
  "ground cumin": 0.50,
  "cinnamon": 0.45,
  "ground cinnamon": 0.45,
  "nutmeg": 0.50,
  "ground nutmeg": 0.50,
  "allspice": 0.45,
  "ground cloves": 0.50,
  "cardamom": 0.50,
  "ground cardamom": 0.50,
  "chili powder": 0.40,
  "cayenne": 0.45,
  "cayenne pepper": 0.45,
  "garlic powder": 0.50,
  "onion powder": 0.55,
  "ginger powder": 0.50,
  "ground ginger": 0.50,
  "smoked paprika": 0.50,
  "sweet paprika": 0.50,
  "five spice": 0.45,
  "italian seasoning": 0.30,
  "herbs de provence": 0.30,
  "bay leaves": 0.30,

  // === Misc ===
  "pumpkin puree": 0.95,
  "applesauce": 1.05,
};

// Ingredients we keep in ml (or cups) when the user picks Metric. Anything
// matching is considered a true liquid where volume is the cook's natural
// reference. Everything else with a known density flips to grams in Metric.
const LIQUID_INGREDIENTS = new Set([
  "water",
  "milk", "buttermilk", "evaporated milk", "almond milk", "soy milk", "oat milk",
  "cream", "heavy cream", "whipping cream", "double cream", "single cream",
  "half and half", "half-and-half",
  "stock", "broth",
  "juice", "lemon juice", "lime juice", "orange juice",
  "oil", "olive oil", "vegetable oil", "canola oil", "sunflower oil", "sesame oil", "coconut oil",
  "vinegar", "rice vinegar", "balsamic vinegar", "white vinegar", "apple cider vinegar",
  "soy sauce", "fish sauce", "worcestershire", "ponzu",
  "wine", "white wine", "red wine", "marsala", "vermouth",
  "beer", "sake", "mirin", "dashi",
  "cognac", "rum", "vodka",
  "coffee", "espresso", "tea",
  "coconut milk", "coconut water", "santan",
  "vanilla extract", "almond extract",
]);

function isLiquidIngredient(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  for (const key of LIQUID_INGREDIENTS) {
    if (n.includes(key)) return true;
  }
  return false;
}

const state = {
  parsed: { title: "", servings: null, sections: [], hasContent: false },
  originalServings: null,
  targetServings: null,
  unitSystem: "original", // 'original' | 'metric' | 'imperial'
  unitOverrides: {},      // { "section:ingredient" => unit }
};

function getMultiplier() {
  if (!state.originalServings || !state.targetServings) return 1;
  return state.targetServings / state.originalServings;
}

function normalizeUnit(unit) {
  if (!unit) return null;
  const u = unit.toLowerCase().replace(/\s+/g, " ").trim();
  return UNIT_NORMALIZE[u] || u;
}

function getUnitDimension(unit) {
  const u = normalizeUnit(unit);
  if (u && u in VOLUME_UNITS) return "volume";
  if (u && u in MASS_UNITS) return "mass";
  return "count";
}

// Words describing prep/state. When a density key contains one of these
// (e.g., "cooked rice"), it should win over a variety match (e.g., "jasmine
// rice") for the same ingredient name.
const STATE_MODIFIERS = new Set([
  "cooked", "uncooked", "raw", "fresh", "dried", "frozen",
  "ground", "shredded", "grated", "chopped", "minced", "sliced",
  "powdered", "rolled", "whole", "canned", "peeled",
]);

function tokenizeIngredient(text) {
  return text.toLowerCase().split(/[\s,()\/\-]+/).filter(Boolean);
}

function findIngredientDensity(name) {
  if (!name) return null;
  const nameTokens = new Set(tokenizeIngredient(name));

  let bestKey = null;
  let bestScore = 0;

  for (const key of Object.keys(DENSITY_G_PER_ML)) {
    const keyTokens = tokenizeIngredient(key);
    if (!keyTokens.every((w) => nameTokens.has(w))) continue;

    // More matched words = more specific. State-modifier words break ties
    // in favor of preparation-aware keys (cooked rice over jasmine rice).
    let score = keyTokens.length * 1000 + key.length;
    for (const w of keyTokens) {
      if (STATE_MODIFIERS.has(w)) score += 500;
    }
    if (score > bestScore) {
      bestKey = key;
      bestScore = score;
    }
  }

  return bestKey ? DENSITY_G_PER_ML[bestKey] : null;
}

function convertQuantity(qty, fromUnit, toUnit, ingredientName) {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (from === to || qty === null) return qty;

  const fromDim = getUnitDimension(from);
  const toDim = getUnitDimension(to);

  if (fromDim === "volume" && toDim === "volume") {
    return (qty * VOLUME_UNITS[from]) / VOLUME_UNITS[to];
  }
  if (fromDim === "mass" && toDim === "mass") {
    return (qty * MASS_UNITS[from]) / MASS_UNITS[to];
  }

  const density = findIngredientDensity(ingredientName);
  if (density === null) return null;

  if (fromDim === "volume" && toDim === "mass") {
    const ml = qty * VOLUME_UNITS[from];
    const g = ml * density;
    return g / MASS_UNITS[to];
  }
  if (fromDim === "mass" && toDim === "volume") {
    const g = qty * MASS_UNITS[from];
    const ml = g / density;
    return ml / VOLUME_UNITS[to];
  }

  return null;
}

function getCompatibleUnits(unit, ingredientName) {
  const dim = getUnitDimension(unit);
  if (dim === "count") return [];

  const hasDensity = findIngredientDensity(ingredientName) !== null;
  const result = [];
  if (dim === "volume") {
    result.push(...VOLUME_UNIT_ORDER);
    if (hasDensity) result.push(...MASS_UNIT_ORDER);
  } else if (dim === "mass") {
    result.push(...MASS_UNIT_ORDER);
    if (hasDensity) result.push(...VOLUME_UNIT_ORDER);
  }
  return result;
}

function pickSystemUnit(qty, unit, ingredientName, system) {
  const u = normalizeUnit(unit);
  const dim = getUnitDimension(u);
  if (dim === "count") return u;

  const inMl = dim === "volume" ? qty * VOLUME_UNITS[u] : null;
  const inG = dim === "mass" ? qty * MASS_UNITS[u] : null;

  // Thresholds for promoting tsp/tbsp to a larger unit when amounts grow.
  // 50 g for solids ≈ 6 tbsp flour or 4 tbsp sugar — past this, weighing wins.
  // 60 ml (1/4 cup) for liquids — the conventional kitchen breakpoint.
  const SPOON_TO_GRAMS_THRESHOLD = 50;
  const SPOON_TO_LARGER_THRESHOLD = 60;

  if (system === "metric") {
    if (dim === "volume") {
      if (u === "ml" || u === "l") return u;
      if (u === "tsp" || u === "tbsp") {
        // Promote spoons to grams (solids) or ml (liquids) above threshold.
        const density = findIngredientDensity(ingredientName);
        if (density !== null && !isLiquidIngredient(ingredientName)) {
          const grams = inMl * density;
          if (grams >= SPOON_TO_GRAMS_THRESHOLD) {
            return grams >= 1000 ? "kg" : "g";
          }
          return u;
        }
        if (inMl >= SPOON_TO_LARGER_THRESHOLD) {
          return inMl >= 1000 ? "l" : "ml";
        }
        return u;
      }
      // Imperial-only volume (cup, fl oz, pint, etc.) → full convert.
      const density = findIngredientDensity(ingredientName);
      if (density !== null && !isLiquidIngredient(ingredientName)) {
        const grams = inMl * density;
        return grams >= 1000 ? "kg" : "g";
      }
      return inMl >= 1000 ? "l" : "ml";
    }
    if (dim === "mass") {
      if (u === "g" || u === "kg") return u;
      return inG >= 1000 ? "kg" : "g";
    }
  }
  if (system === "imperial") {
    if (dim === "volume") {
      if (u === "tsp" || u === "tbsp") {
        // Promote to cup once we cross 1/4 cup.
        if (inMl >= SPOON_TO_LARGER_THRESHOLD) return "cup";
        return u;
      }
      if (
        u === "fl oz" || u === "cup" || u === "pint" ||
        u === "quart" || u === "gallon"
      ) {
        return u;
      }
      // Metric source (ml / l) → pick best imperial fit by size.
      if (inMl < 15) return "tsp";
      if (inMl < 60) return "tbsp";
      return "cup";
    }
    if (dim === "mass") {
      if (u === "oz" || u === "lb") return u;
      return inG >= 454 ? "lb" : "oz";
    }
  }
  return u;
}

function normalizeFractions(text) {
  return text.replace(UNICODE_FRACTION_REGEX, (m) => " " + UNICODE_FRACTIONS[m] + " ");
}

function cleanInput(text) {
  if (!text) return "";
  return normalizeFractions(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && line.length <= 500 && !JUNK_PATTERNS.some((re) => re.test(line)))
    .join("\n");
}

function isLikelyTitle(line) {
  if (/^\d/.test(line)) return false;
  if (/:\s*$/.test(line)) return false;
  if (line.length > 100) return false;
  if (/^(ingredients?|instructions?|directions?|method|preparation|steps?|how to make|notes?|tips?|equipment)\s*:?\s*$/i.test(line)) return false;
  return true;
}

function matchServings(line) {
  let m = line.match(/^(?:serves|makes|yields?|servings?)\s*:?\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  m = line.match(/^(\d+)\s+servings?$/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function isInstructionsHeader(line) {
  return /^(instructions?|directions?|method|preparation|steps?|how to make)\s*:?\s*$/i.test(line);
}

function isSectionHeader(line) {
  if (/^\d/.test(line)) return false;
  if (/^ingredients?\s*:?\s*$/i.test(line)) return true;
  if (!/:\s*$/.test(line)) return false;
  if (line.length > 60) return false;
  return true;
}

function isLikelyIngredient(line) {
  return /^\d/.test(line);
}

function parseIngredient(line) {
  let rest = line.trim();
  let quantity = null;
  let unit = null;

  let m = rest.match(/^(\d+)\s+(\d+)\/(\d+)/);
  if (m) {
    quantity = parseInt(m[1], 10) + parseInt(m[2], 10) / parseInt(m[3], 10);
    rest = rest.slice(m[0].length);
  } else if ((m = rest.match(/^(\d+)\/(\d+)/))) {
    quantity = parseInt(m[1], 10) / parseInt(m[2], 10);
    rest = rest.slice(m[0].length);
  } else if ((m = rest.match(/^(\d+(?:\.\d+)?)/))) {
    quantity = parseFloat(m[1]);
    rest = rest.slice(m[0].length);
  }
  rest = rest.replace(/^\s+/, "");

  const uMatch = rest.match(UNIT_REGEX);
  if (uMatch) {
    unit = uMatch[1].toLowerCase();
    rest = rest.slice(uMatch[0].length);
  }

  const name = rest.replace(/^[\s,;:.]+/, "").trim();

  return { quantity, unit, name, raw: line };
}

function parseRecipe(rawText) {
  const cleaned = cleanInput(rawText);
  if (!cleaned) {
    return { title: "", servings: null, sections: [], hasContent: false };
  }

  const lines = cleaned.split("\n");
  let title = "";
  let servings = null;
  const sections = [];
  const instructions = [];
  let currentSection = { header: null, ingredients: [] };
  let inIngredientMode = true;
  // Permissive mode kicks in after we see the literal "Ingredients" header.
  // It lets non-numeric lines like "salt to taste" or "lemon wedges (optional)"
  // through. URL imports always emit an "Ingredients" header so they benefit;
  // recipes with named sections (e.g., "For the sauce:") stay strict.
  let permissiveMode = false;

  for (const line of lines) {
    if (!title && isLikelyTitle(line) && !isLikelyIngredient(line)) {
      title = line;
      continue;
    }
    if (servings === null) {
      const s = matchServings(line);
      if (s !== null) {
        servings = s;
        continue;
      }
    }
    if (isInstructionsHeader(line)) {
      inIngredientMode = false;
      permissiveMode = false;
      if (currentSection.ingredients.length > 0) {
        sections.push(currentSection);
        currentSection = { header: null, ingredients: [] };
      }
      continue;
    }
    if (!inIngredientMode) {
      // Everything past the Instructions header is captured as a step.
      const trimmed = line.trim();
      if (trimmed) instructions.push(trimmed);
      continue;
    }
    if (isSectionHeader(line)) {
      if (currentSection.ingredients.length > 0) {
        sections.push(currentSection);
      }
      let header = line.replace(/:\s*$/, "");
      const isIngredientsMarker = /^ingredients?$/i.test(header);
      if (isIngredientsMarker) {
        header = null;
        permissiveMode = true;
      }
      currentSection = { header, ingredients: [] };
      continue;
    }
    if (permissiveMode || isLikelyIngredient(line)) {
      currentSection.ingredients.push(parseIngredient(line));
    }
  }
  if (currentSection.ingredients.length > 0) {
    sections.push(currentSection);
  }
  return { title, servings, sections, instructions, hasContent: true };
}

function formatQuantity(q, unit) {
  if (q === null) return "";
  if (q === Math.floor(q)) return String(q);

  // Metric continuous units: prefer rounded numbers over fractions.
  // Cooks read "11 g" naturally; "10 1/2 g" looks awkward.
  const u = (unit || "").toLowerCase().trim();
  if (u === "g" || u === "kg" || u === "ml" || u === "l") {
    if (q >= 10) return String(Math.round(q));
    return (Math.round(q * 10) / 10).toString();
  }

  const fractions = [
    [1 / 8, "1/8"], [1 / 4, "1/4"], [1 / 3, "1/3"],
    [3 / 8, "3/8"], [1 / 2, "1/2"], [5 / 8, "5/8"],
    [2 / 3, "2/3"], [3 / 4, "3/4"], [7 / 8, "7/8"],
  ];

  const whole = Math.floor(q);
  const frac = q - whole;

  for (const [val, repr] of fractions) {
    if (Math.abs(frac - val) < 0.02) {
      return whole > 0 ? `${whole} ${repr}` : repr;
    }
  }
  return (Math.round(q * 100) / 100).toString();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Decide which unit to display for a given ingredient: explicit override wins,
// then global system rule, then the unit as parsed.
function getDisplayUnit(ing, ingId, scaledQty) {
  if (state.unitOverrides[ingId]) return state.unitOverrides[ingId];
  if (state.unitSystem !== "original" && ing.unit && ing.quantity !== null) {
    return pickSystemUnit(scaledQty, ing.unit, ing.name, state.unitSystem);
  }
  return normalizeUnit(ing.unit) || ing.unit || "";
}

function updateScaleControls() {
  const scaleSection = document.getElementById("scale-section");
  const servingsInput = document.getElementById("servings-input");
  const note = document.getElementById("no-servings-note");
  if (!scaleSection || !servingsInput) return;

  if (!state.parsed.hasContent) {
    scaleSection.hidden = true;
    return;
  }
  scaleSection.hidden = false;

  if (state.originalServings === null) {
    servingsInput.value = "";
    servingsInput.disabled = true;
    if (note) note.hidden = false;
  } else {
    servingsInput.value = state.targetServings;
    servingsInput.disabled = false;
    if (note) note.hidden = true;
  }
}

function updateUnitToggleButtons() {
  const buttons = document.querySelectorAll(".unit-toggle__btn");
  buttons.forEach((btn) => {
    if (btn.dataset.system === state.unitSystem) {
      btn.classList.add("is-active");
    } else {
      btn.classList.remove("is-active");
    }
  });
}

function renderOutput() {
  // We now split the output card into three children that we manage
  // independently so the scale-section sits BETWEEN head and body without
  // being wiped on every render.
  //   #output-placeholder — shown when no recipe is loaded
  //   #recipe-head        — hero image, title, "Serves N"
  //   #scale-section      — stable; never touched by this function
  //   #recipe-body        — ingredient sections, Copy/Share, disclaimer
  const container = document.getElementById("output-section");
  const placeholder = document.getElementById("output-placeholder");
  const headEl = document.getElementById("recipe-head");
  const bodyEl = document.getElementById("recipe-body");
  if (!container || !headEl || !bodyEl) return;

  const parsed = state.parsed;

  if (!parsed.hasContent) {
    container.classList.remove("output-section--has-content");
    if (placeholder) placeholder.hidden = false;
    headEl.hidden = true;
    bodyEl.hidden = true;
    headEl.innerHTML = "";
    bodyEl.innerHTML = "";
    return;
  }

  container.classList.add("output-section--has-content");
  if (placeholder) placeholder.hidden = true;
  headEl.hidden = false;
  bodyEl.hidden = false;

  // === HEAD: hero image, title, serves ===
  const headParts = [];
  if (parsed.image) {
    headParts.push(
      `<div class="recipe__hero"><img class="recipe__image" src="${escapeHtml(parsed.image)}" alt="${escapeHtml(parsed.title || "Recipe photo")}" loading="lazy" referrerpolicy="no-referrer" /></div>`
    );
  }
  if (parsed.title) {
    headParts.push(`<h2 class="recipe__title">${escapeHtml(parsed.title)}</h2>`);
  }
  if (state.targetServings !== null) {
    headParts.push(`<p class="recipe__servings">Serves ${state.targetServings}</p>`);
  }
  headEl.innerHTML = headParts.join("");

  // === BODY: ingredient sections, Copy/Share, disclaimer ===
  const bodyParts = [];

  if (parsed.sections.length === 0) {
    bodyParts.push(
      '<div class="output-section__placeholder">No ingredients detected yet. Each ingredient line should start with a quantity (like "1 cup flour").</div>'
    );
  } else {
    const multiplier = getMultiplier();

    for (let s = 0; s < parsed.sections.length; s++) {
      const section = parsed.sections[s];
      bodyParts.push('<div class="recipe__section">');
      if (section.header) {
        bodyParts.push(
          `<h3 class="recipe__section-header">${escapeHtml(section.header)}</h3>`
        );
      }
      bodyParts.push('<ul class="recipe__ingredients">');

      for (let i = 0; i < section.ingredients.length; i++) {
        const ing = section.ingredients[i];
        const ingId = `${s}:${i}`;
        const scaledQty = ing.quantity !== null ? ing.quantity * multiplier : null;
        const displayUnit = getDisplayUnit(ing, ingId, scaledQty);

        let displayQty = scaledQty;
        const sourceUnit = normalizeUnit(ing.unit);
        if (ing.unit && displayUnit && displayUnit !== sourceUnit) {
          const converted = convertQuantity(scaledQty, ing.unit, displayUnit, ing.name);
          if (converted !== null) {
            displayQty = converted;
          }
        }

        const compatible = ing.unit ? getCompatibleUnits(ing.unit, ing.name) : [];
        let unitHtml;
        if (compatible.length > 0) {
          const options = compatible
            .map(
              (u) =>
                `<option value="${escapeHtml(u)}"${u === displayUnit ? " selected" : ""}>${escapeHtml(u)}</option>`
            )
            .join("");
          unitHtml = `<select class="recipe__ing-unit-select" data-ing-id="${escapeHtml(ingId)}" aria-label="Change unit">${options}</select>`;
        } else {
          unitHtml = `<span class="recipe__ing-unit">${escapeHtml(displayUnit || ing.unit || "")}</span>`;
        }

        bodyParts.push(
          `<li class="recipe__ingredient">` +
            `<span class="recipe__ing-qty">${escapeHtml(formatQuantity(displayQty, displayUnit))}</span>` +
            unitHtml +
            `<span class="recipe__ing-name">${escapeHtml(ing.name || "")}</span>` +
            `</li>`
        );
      }

      bodyParts.push("</ul>");
      bodyParts.push("</div>");
    }

    // Cooking steps (if the source recipe included them).
    if (parsed.instructions && parsed.instructions.length) {
      bodyParts.push('<div class="recipe__instructions">');
      bodyParts.push('<h3 class="recipe__section-header">Instructions</h3>');
      bodyParts.push('<ol class="recipe__steps">');
      for (const step of parsed.instructions) {
        bodyParts.push(`<li class="recipe__step">${escapeHtml(step)}</li>`);
      }
      bodyParts.push("</ol>");
      bodyParts.push("</div>");
    }

    bodyParts.push(
      '<div class="recipe__actions">' +
        '<button type="button" class="btn btn--secondary" data-action="save">' +
          '<svg class="btn__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>' +
          '<span class="btn__label">Save</span>' +
        '</button>' +
        '<button type="button" class="btn btn--primary" data-action="copy">' +
          '<svg class="btn__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>' +
          '<span class="btn__label">Copy all</span>' +
        '</button>' +
        '<button type="button" class="btn btn--secondary" data-action="share">' +
          '<svg class="btn__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>' +
          '<span class="btn__label">Share</span>' +
        '</button>' +
      '</div>'
    );
    bodyParts.push(
      '<p class="recipe__disclaimer">Quantities are rounded for practical measurement.</p>'
    );
  }

  bodyEl.innerHTML = bodyParts.join("");
}

function refreshFromInput() {
  const input = document.getElementById("recipe-input");
  if (!input) return;

  state.parsed = parseRecipe(input.value);
  state.originalServings = state.parsed.servings;
  state.targetServings = state.originalServings;
  state.unitOverrides = {};
  // unitSystem persists across pastes — feels natural for a returning user.

  updateUrlUpsell();
  updateScaleControls();
  updateUnitToggleButtons();
  renderOutput();
}

function handleServingsChange() {
  const servingsInput = document.getElementById("servings-input");
  if (!servingsInput || state.originalServings === null) return;

  const v = parseInt(servingsInput.value, 10);
  if (!Number.isFinite(v) || v <= 0) return;

  state.targetServings = v;
  renderOutput();
}

function handleReset() {
  state.targetServings = state.originalServings;
  state.unitSystem = "original";
  state.unitOverrides = {};

  const servingsInput = document.getElementById("servings-input");
  if (servingsInput) {
    servingsInput.value = state.originalServings === null ? "" : state.originalServings;
  }
  updateUnitToggleButtons();
  renderOutput();
}

function handleUnitToggleClick(e) {
  const btn = e.target.closest(".unit-toggle__btn");
  if (!btn) return;
  const system = btn.dataset.system;
  if (!system) return;
  state.unitSystem = system;
  // Picking a system clears manual overrides — system choice is bulk intent.
  state.unitOverrides = {};
  updateUnitToggleButtons();
  renderOutput();
}

function handleIngredientUnitChange(e) {
  const select = e.target.closest(".recipe__ing-unit-select");
  if (!select) return;
  const ingId = select.dataset.ingId;
  if (!ingId) return;
  state.unitOverrides[ingId] = select.value;
  renderOutput();
}

// Backend URL — local Flask dev server when running from file:// or
// localhost; the deployed Railway service otherwise (used by Netlify build).
const BACKEND_URL =
  location.hostname === "localhost" || location.protocol === "file:"
    ? "http://localhost:5000"
    : "https://saffron-recipe-scaler-production.up.railway.app";

const URL_UPSELL_DEFAULT_TEXT =
  "Recipe URL detected. Tap Import to fetch it automatically.";

function looksLikeURL(text) {
  if (!text) return false;
  return /^https?:\/\/\S+$/i.test(text.trim());
}

function updateUrlUpsell() {
  const input = document.getElementById("recipe-input");
  const banner = document.getElementById("url-upsell");
  if (!input || !banner) return;

  const wasHidden = banner.hidden;
  const isURL = looksLikeURL(input.value);
  banner.hidden = !isURL;

  // Reset banner UI when it becomes visible after being hidden.
  if (wasHidden && isURL) {
    const text = document.getElementById("url-upsell-text");
    const btn = document.getElementById("import-url-btn");
    if (text) text.textContent = URL_UPSELL_DEFAULT_TEXT;
    if (btn) {
      btn.textContent = "Import";
      btn.disabled = false;
    }
  }
}

function recipeJsonToText(data) {
  // Convert backend's structured JSON into the same plain-text shape a user
  // would have pasted, so the existing parseRecipe pipeline handles it.
  // Preserves ingredient_groups (e.g., "Optional add-ins") as section headers.
  const lines = [];
  if (data.title) lines.push(data.title);
  if (data.servings) lines.push(`Serves ${data.servings}`);

  const groups =
    data.ingredient_groups && data.ingredient_groups.length
      ? data.ingredient_groups
      : data.ingredients && data.ingredients.length
      ? [{ purpose: null, ingredients: data.ingredients }]
      : [];

  if (groups.length > 0) {
    lines.push("");
    // The "Ingredients" header trips the parser's permissive mode so even
    // group sub-headers (which don't match the ingredients regex) still allow
    // their lines through.
    lines.push("Ingredients");
    for (const group of groups) {
      if (group.purpose) {
        lines.push("");
        lines.push(`${group.purpose}:`);
      }
      for (const ing of group.ingredients || []) {
        lines.push(ing);
      }
    }
  }

  // Cooking steps come back from the backend as an array of plain strings.
  // Emitting them after an "Instructions" header lets parseRecipe pick
  // them up via the same path used by manually-pasted recipes.
  if (data.instructions && data.instructions.length) {
    lines.push("");
    lines.push("Instructions");
    for (const step of data.instructions) {
      lines.push(step);
    }
  }
  return lines.join("\n");
}

async function handleImportUrl() {
  const input = document.getElementById("recipe-input");
  const text = document.getElementById("url-upsell-text");
  const btn = document.getElementById("import-url-btn");
  if (!input || !btn) return;

  const url = input.value.trim();
  if (!looksLikeURL(url)) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Importing\u2026';
  if (text) text.textContent = "Fetching recipe\u2026";

  try {
    const response = await fetch(
      `${BACKEND_URL}/import?url=${encodeURIComponent(url)}`
    );
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    input.value = recipeJsonToText(data);
    refreshFromInput();
    // Banner hides on its own — the textarea no longer just contains a URL.

    // Attach the image to the parsed state and re-render so the recipe card
    // gets a hero photo. (parseRecipe is text-only and discards image data;
    // we splice the image back in after the refresh.)
    if (data.image && state.parsed.hasContent) {
      state.parsed.image = data.image;
      renderOutput();
    }
  } catch (err) {
    if (text) {
      text.textContent =
        err.message && err.message.length < 200
          ? err.message
          : "Couldn't import that recipe. Try pasting the ingredients manually.";
    }
    btn.textContent = "Try again";
    btn.disabled = false;
  }
}

// Appended to every Copy / Share. Single source of truth so brand changes
// (or future "remove branding" Pro feature) only touch one line.
const SHARE_TAGLINE = "Scaled with PrepFresh";

// === Saved recipes (localStorage, free-tier 5-save limit) ===
const SAVED_RECIPES_KEY = "prepfresh.saved_recipes";
const FREE_SAVE_LIMIT = 5;

function getSavedRecipes() {
  try {
    const raw = localStorage.getItem(SAVED_RECIPES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function setSavedRecipes(list) {
  try {
    localStorage.setItem(SAVED_RECIPES_KEY, JSON.stringify(list));
  } catch (e) {
    // localStorage may be full or disabled; surface a generic error.
    console.warn("Couldn't save recipes:", e);
  }
}

function saveCurrentRecipe() {
  if (!state.parsed.hasContent) return { ok: false, reason: "no-recipe" };
  const list = getSavedRecipes();
  if (list.length >= FREE_SAVE_LIMIT) {
    return { ok: false, reason: "limit-reached", count: list.length };
  }
  const entry = {
    id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7),
    title: state.parsed.title || "Untitled recipe",
    image: state.parsed.image || "",
    savedAt: new Date().toISOString(),
    parsed: state.parsed,
    targetServings: state.targetServings,
    unitSystem: state.unitSystem,
    unitOverrides: state.unitOverrides,
  };
  list.unshift(entry);
  setSavedRecipes(list);
  return { ok: true, count: list.length };
}

function loadSavedRecipe(id) {
  const list = getSavedRecipes();
  const entry = list.find((r) => r.id === id);
  if (!entry) return false;

  state.parsed = entry.parsed;
  state.originalServings = entry.parsed.servings;
  state.targetServings = entry.targetServings;
  state.unitSystem = entry.unitSystem || "original";
  state.unitOverrides = entry.unitOverrides || {};

  // Reflect in the textarea so the user can see what was loaded.
  const input = document.getElementById("recipe-input");
  if (input) input.value = "";  // Clear paste box; saved recipe is now the source of truth.

  updateScaleControls();
  updateUnitToggleButtons();
  updateUrlUpsell();
  renderOutput();
  return true;
}

function deleteSavedRecipe(id) {
  const list = getSavedRecipes().filter((r) => r.id !== id);
  setSavedRecipes(list);
}

function buildPlainTextRecipe() {
  if (!state.parsed.hasContent) return "";

  const out = [];
  if (state.parsed.title) out.push(state.parsed.title);
  if (state.targetServings !== null) out.push(`Serves ${state.targetServings}`);

  const multiplier = getMultiplier();

  for (let s = 0; s < state.parsed.sections.length; s++) {
    const section = state.parsed.sections[s];
    out.push("");
    if (section.header) out.push(`${section.header}:`);

    for (let i = 0; i < section.ingredients.length; i++) {
      const ing = section.ingredients[i];
      const ingId = `${s}:${i}`;
      const scaledQty = ing.quantity !== null ? ing.quantity * multiplier : null;
      const displayUnit = getDisplayUnit(ing, ingId, scaledQty);

      let displayQty = scaledQty;
      const sourceUnit = normalizeUnit(ing.unit);
      if (ing.unit && displayUnit && displayUnit !== sourceUnit) {
        const converted = convertQuantity(scaledQty, ing.unit, displayUnit, ing.name);
        if (converted !== null) displayQty = converted;
      }

      const qty = formatQuantity(displayQty, displayUnit);
      const parts = [];
      if (qty) parts.push(qty);
      if (displayUnit) parts.push(displayUnit);
      if (ing.name) parts.push(ing.name);
      out.push(`\u2022 ${parts.join(" ")}`);
    }
  }

  // Numbered cooking steps (if any).
  if (state.parsed.instructions && state.parsed.instructions.length) {
    out.push("");
    out.push("Instructions");
    state.parsed.instructions.forEach((step, i) => {
      out.push(`${i + 1}. ${step}`);
    });
  }

  out.push("");
  out.push("\u2014");
  out.push(SHARE_TAGLINE);

  return out.join("\n").trim();
}

// Tracks any pending label-reset so rapid Copy clicks don't strand the
// button on "Copied!" forever.
let copyResetTimeout = null;

async function handleCopyAll() {
  const text = buildPlainTextRecipe();
  const btn = document.querySelector('[data-action="copy"]');
  if (!text || !btn) return;

  if (copyResetTimeout) clearTimeout(copyResetTimeout);

  // Update only the label span so the SVG icon isn't wiped.
  const label = btn.querySelector(".btn__label") || btn;
  try {
    await navigator.clipboard.writeText(text);
    label.textContent = "Copied!";
  } catch (err) {
    label.textContent = "Copy failed";
  }
  copyResetTimeout = setTimeout(() => {
    label.textContent = "Copy all";
    copyResetTimeout = null;
  }, 1500);
}

async function handleShare() {
  const text = buildPlainTextRecipe();
  if (!text) return;
  const title = state.parsed.title || "Recipe";

  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (err) {
      // AbortError = user dismissed the share sheet → do nothing.
      if (err && err.name === "AbortError") return;
      // Any other error → fall through to clipboard copy.
    }
  }
  handleCopyAll();
}

// === Save / Saved-recipes UI ===

function handleSaveRecipe() {
  const result = saveCurrentRecipe();
  const btn = document.querySelector('[data-action="save"]');
  if (!btn) return;
  const label = btn.querySelector(".btn__label") || btn;

  if (result.ok) {
    label.textContent = "Saved!";
    setTimeout(() => { label.textContent = "Save"; }, 1500);
    updateSavedCountBadge();
  } else if (result.reason === "limit-reached") {
    showSaveLimitDialog();
  }
}

function updateSavedCountBadge() {
  const badge = document.getElementById("saved-count");
  if (!badge) return;
  const count = getSavedRecipes().length;
  badge.textContent = String(count);
  badge.dataset.count = String(count);
}

function openSavedModal() {
  const modal = document.getElementById("saved-modal");
  if (!modal) return;
  renderSavedRecipesList();
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSavedModal() {
  const modal = document.getElementById("saved-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

function showSaveLimitDialog() {
  const modal = document.getElementById("limit-modal");
  if (!modal) return;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSaveLimitDialog() {
  const modal = document.getElementById("limit-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

function renderSavedRecipesList() {
  const body = document.getElementById("saved-modal-body");
  const countEl = document.getElementById("saved-count-footer");
  if (!body) return;

  const list = getSavedRecipes();

  if (list.length === 0) {
    body.innerHTML =
      '<p class="modal__empty">No saved recipes yet. Click <strong>Save</strong> on any recipe to keep it here.</p>';
    if (countEl) countEl.textContent = `0 of ${FREE_SAVE_LIMIT} free saves used`;
    return;
  }

  const items = list
    .map((entry) => {
      const date = new Date(entry.savedAt).toLocaleDateString();
      const thumb = entry.image
        ? `<img class="saved-item__image" src="${escapeHtml(entry.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : '<div class="saved-item__placeholder" aria-hidden="true">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18a9 9 0 0 1-18 0z"/><path d="M10 6c0 1-1 2-1 3M15 5c0 1-1 2-1 3"/></svg>' +
          '</div>';
      return (
        `<article class="saved-item" data-id="${escapeHtml(entry.id)}">` +
          thumb +
          '<div class="saved-item__details">' +
            `<h3 class="saved-item__title">${escapeHtml(entry.title)}</h3>` +
            `<p class="saved-item__date">${escapeHtml(date)}</p>` +
          '</div>' +
          '<div class="saved-item__actions">' +
            '<button type="button" class="btn btn--secondary btn--small" data-saved-action="open">Open</button>' +
            '<button type="button" class="saved-item__delete" data-saved-action="delete" aria-label="Delete">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
            '</button>' +
          '</div>' +
        '</article>'
      );
    })
    .join("");

  body.innerHTML = items;
  if (countEl) {
    countEl.textContent = `${list.length} of ${FREE_SAVE_LIMIT} free saves used`;
  }
}

function handleSavedItemAction(e) {
  const btn = e.target.closest("[data-saved-action]");
  if (!btn) return;
  const item = btn.closest(".saved-item");
  if (!item) return;
  const id = item.dataset.id;
  const action = btn.dataset.savedAction;

  if (action === "open") {
    if (loadSavedRecipe(id)) {
      closeSavedModal();
      const output = document.getElementById("output-section");
      if (output) output.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } else if (action === "delete") {
    if (confirm("Delete this saved recipe?")) {
      deleteSavedRecipe(id);
      renderSavedRecipesList();
      updateSavedCountBadge();
    }
  }
}

function handleOutputAction(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "copy") handleCopyAll();
  else if (action === "share") handleShare();
  else if (action === "save") handleSaveRecipe();
}

document.addEventListener("DOMContentLoaded", () => {
  const recipeInput = document.getElementById("recipe-input");
  const sampleBtn = document.getElementById("sample-btn");
  const clearBtn = document.getElementById("clear-btn");
  const servingsInput = document.getElementById("servings-input");
  const resetBtn = document.getElementById("reset-btn");
  const unitToggle = document.getElementById("unit-toggle");
  const outputSection = document.getElementById("output-section");
  const importUrlBtn = document.getElementById("import-url-btn");

  if (!recipeInput || !sampleBtn || !clearBtn) return;

  recipeInput.addEventListener("input", refreshFromInput);

  sampleBtn.addEventListener("click", () => {
    recipeInput.value = SAMPLE_RECIPE;
    refreshFromInput();
    recipeInput.focus();
  });

  clearBtn.addEventListener("click", () => {
    recipeInput.value = "";
    refreshFromInput();
    recipeInput.focus();
  });

  if (servingsInput) servingsInput.addEventListener("input", handleServingsChange);
  if (resetBtn) resetBtn.addEventListener("click", handleReset);
  if (unitToggle) unitToggle.addEventListener("click", handleUnitToggleClick);
  if (importUrlBtn) importUrlBtn.addEventListener("click", handleImportUrl);

  // Sync banner / scale visibility to current textarea state on load.
  updateUrlUpsell();
  // Delegate dropdown changes and Save/Copy/Share clicks from the output container.
  if (outputSection) {
    outputSection.addEventListener("change", handleIngredientUnitChange);
    outputSection.addEventListener("click", handleOutputAction);
  }

  // Saved recipes UI
  const savedBtn = document.getElementById("saved-button");
  const savedModal = document.getElementById("saved-modal");
  const savedClose = document.getElementById("saved-modal-close");
  const savedBody = document.getElementById("saved-modal-body");
  const limitModal = document.getElementById("limit-modal");
  const limitClose = document.getElementById("limit-close");

  if (savedBtn) savedBtn.addEventListener("click", openSavedModal);
  if (savedClose) savedClose.addEventListener("click", closeSavedModal);
  if (limitClose) limitClose.addEventListener("click", closeSaveLimitDialog);
  if (savedBody) savedBody.addEventListener("click", handleSavedItemAction);

  // Click backdrop or hit Escape to dismiss either modal
  [savedModal, limitModal].forEach((m) => {
    if (!m) return;
    m.addEventListener("click", (e) => {
      if (e.target === m) {
        m.hidden = true;
        document.body.style.overflow = "";
      }
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeSavedModal();
    closeSaveLimitDialog();
  });

  updateSavedCountBadge();

  // === PWA install button ===
  // Browsers that support installable PWAs (Chrome/Edge/Android) fire a
  // `beforeinstallprompt` event when the site qualifies. We catch it, save
  // the event for later, and show our own button. iOS Safari doesn't fire
  // this event at all — for iOS we show a manual instructions modal.
  setupInstallButton();
});

function setupInstallButton() {
  const installBtn = document.getElementById("install-button");
  const iosModal = document.getElementById("ios-install-modal");
  const iosClose = document.getElementById("ios-install-close");
  if (!installBtn) return;

  // If the app is already running as an installed PWA, never show the button.
  // `display-mode: standalone` is how the browser tells us "no browser chrome,
  // running as an app". `navigator.standalone` is the iOS-specific equivalent.
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (isStandalone) return;

  // User-agent sniff for iOS. Not perfect but good enough for this purpose.
  // We also exclude desktop Safari (which has a Mac-shaped UA) by checking
  // for touch points.
  const ua = window.navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes("Mac") && navigator.maxTouchPoints > 1);

  // Check session-level dismissal so we don't keep nagging within one visit.
  const dismissedThisSession = sessionStorage.getItem("prepfresh.installDismissed") === "1";

  let deferredPrompt = null;

  // --- Path 1: Chrome / Edge / Android Chrome (real install prompt) ---
  window.addEventListener("beforeinstallprompt", (e) => {
    // Stop the browser's mini-banner from appearing — we want our button instead.
    e.preventDefault();
    deferredPrompt = e;
    if (!dismissedThisSession) {
      installBtn.hidden = false;
    }
  });

  // --- Path 2: iOS Safari (manual instructions modal) ---
  if (isIOS && !dismissedThisSession) {
    installBtn.hidden = false;
  }

  // Click handler: route to the real prompt or the iOS modal.
  installBtn.addEventListener("click", async () => {
    if (deferredPrompt) {
      // Show the native install dialog.
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") {
        // Installed — hide forever (the `appinstalled` event fires too, but
        // belt and braces).
        installBtn.hidden = true;
      } else {
        // User dismissed — back off for this session.
        installBtn.hidden = true;
        sessionStorage.setItem("prepfresh.installDismissed", "1");
      }
      // The deferred event can only be used once.
      deferredPrompt = null;
    } else if (isIOS && iosModal) {
      iosModal.hidden = false;
      document.body.style.overflow = "hidden";
    }
  });

  // Close the iOS modal (X-style — backdrop click + button + Escape all dismiss).
  function closeIosModal() {
    if (!iosModal) return;
    iosModal.hidden = true;
    document.body.style.overflow = "";
  }
  if (iosClose) iosClose.addEventListener("click", closeIosModal);
  if (iosModal) {
    iosModal.addEventListener("click", (e) => {
      if (e.target === iosModal) closeIosModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeIosModal();
  });

  // When the app actually gets installed (Chrome fires this event), hide the
  // button permanently for this device.
  window.addEventListener("appinstalled", () => {
    installBtn.hidden = true;
    deferredPrompt = null;
  });
}
