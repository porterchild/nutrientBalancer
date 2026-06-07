/* ==========================================================================
 * Nutrient Balancer — UI, totals, charts, and swap optimizer
 * Depends on foods.js (FOODS, DAILY_VALUES, MACRO_KEYS, MICRO_KEYS, LIMIT_KEYS)
 * ======================================================================== */

"use strict";

const ALL_KEYS = [...MACRO_KEYS, ...MICRO_KEYS, ...FAT_KEYS, ...CAROT_KEYS, ...AMINO_KEYS, ...LIMIT_KEYS];

// ---------------------------------------------------------------------------
// Nutrient math
// ---------------------------------------------------------------------------

// Nutrient contribution of `grams` of FOODS[idx], as a key->amount object.
function contribution(idx, grams) {
  const food = FOODS[idx];
  const factor = grams / 100;
  const out = {};
  for (const k of [...ALL_KEYS, "kcal"]) out[k] = (food[k] || 0) * factor;
  return out;
}

// Sum a list of meal items into total nutrients.
function totals(mealList) {
  const sum = {};
  for (const k of [...ALL_KEYS, "kcal"]) sum[k] = 0;
  for (const m of mealList) {
    const c = contribution(m.foodIndex, m.grams);
    for (const k in c) sum[k] += c[k];
  }
  return sum;
}

// Per-day averages = totals / days.
function perDay(sum, days) {
  const out = {};
  for (const k in sum) out[k] = sum[k] / days;
  return out;
}

// Fraction of DV achieved for a nutrient key (1.0 = 100%).
function dvFraction(daily, key) {
  const dv = DAILY_VALUES[key].dv;
  return dv ? daily[key] / dv : 0;
}

// ---------------------------------------------------------------------------
// Optimizer
//   Greedy iso-caloric swaps. For each candidate swap we replace a logged food
//   with a database food at a calorie-matched serving (capped to a realistic
//   amount), recompute the FULL daily totals, and score how much the swap
//   closes the gap on deficient micronutrients without overshooting limits.
// ---------------------------------------------------------------------------

const MAX_SERVING_G = 250;     // realistic upper bound for a swapped-in food
const MAX_SWAPS = 5;           // how many swaps to recommend
const DEFICIT_EPS = 0.999;     // treat >=99.9% DV as "met"
const SUM_KEYS = [...ALL_KEYS, "kcal"];

// Foods you can LOG freely, but that make poor RECOMMENDATIONS — engineered/
// fortified/prepared items (bars, fortified cereals, sweets, fast food) that
// "win" the math without being meaningful whole-food advice, plus dehydrated/
// powdered items that are unrealistic at a 250 g serving. We keep these OUT of
// the swap-candidate pool so suggestions are genuine nutrient-dense whole foods.
const EXCLUDED_GROUPS = new Set([
  "Spices and Herbs", "Baby Foods", "Soups, Sauces, and Gravies",
  "Breakfast Cereals", "Beverages", "Baked Products", "Sweets",
  "Fast Foods", "Meals, Entrees, and Side Dishes", "Snacks",
  "Restaurant Foods", "Branded Food Products Database",
  "Quality Control Materials", "Alcoholic Beverages",
]);
const EXCLUDE_NAME_RE =
  /powder|dried|dehydrated|\bdry\b|\bflour\b|\bmeal\b|defatted|infant formula|formula,|leavening|, mix\b|\bmix,|formulated|fortified|concentrate|freeze[- ]dried|extract|bouillon|baby ?food/i;
// Whole nuts/seeds are normally listed as "kernels, dried" / "dry roasted", so
// the generic dried/dry filter would wrongly drop them. For this culinary class
// we only reject the truly processed forms (flour/meal/defatted/powder/paste).
const NUTSEED_EXCLUDE_RE = /\bflour\b|\bmeal\b|defatted|powder|paste|\bmix\b/;

// To keep recommendations to foods people actually eat (not grape leaves,
// dandelion greens, lambsquarters, emu…), a candidate's primary food noun must
// be in this everyday-foods set. USDA names foods "Noun, qualifier…" (and fish
// as "Fish, salmon…"), so we check the first or second comma-segment. Animal
// nouns (beef, chicken…) pull in their cuts AND organ meats. You can still LOG
// any of the 7,793 foods — this only constrains what gets *suggested*.
const COMMON_NOUNS = new Set([
  // meat & poultry
  "beef","chicken","pork","turkey","lamb","veal","ham","bacon","sausage","duck",
  // seafood
  "salmon","tuna","cod","halibut","trout","tilapia","herring","sardine","mackerel",
  "catfish","haddock","pollock","snapper","bass","flounder","sole","anchovy",
  "shrimp","crab","lobster","oyster","clam","mussel","scallop","squid",
  // eggs & dairy
  "egg","milk","yogurt","cheese","butter","cream","kefir",
  // legumes & soy
  "bean","lentil","chickpea","pea","soybean","tofu","edamame","hummus","peanut",
  // nuts & seeds
  "nut","almond","walnut","cashew","pecan","pistachio","hazelnut","macadamia",
  "seed","sesame","chia","flaxseed","flax",
  // grains
  "rice","oat","quinoa","barley","buckwheat","bread","pasta","noodle","wheat",
  "cornmeal","couscous","millet","bulgur","tortilla","oatmeal",
  // vegetables
  "spinach","kale","broccoli","cauliflower","cabbage","lettuce","carrot","potato",
  "sweet potato","tomato","pepper","onion","garlic","mushroom","asparagus",
  "brussels sprouts","celery","cucumber","zucchini","squash","pumpkin","beet",
  "beet greens","collards","turnip greens","mustard greens","chard","corn","peas",
  "artichoke","eggplant","okra","radish","yam","leek","sprouts","kohlrabi","parsnip",
  // fruits
  "apple","banana","orange","strawberry","blueberry","raspberry","blackberry",
  "grape","grapefruit","lemon","lime","mango","pineapple","peach","pear","plum",
  "cherry","watermelon","cantaloupe","melon","kiwi","apricot","fig","date",
  "pomegranate","papaya","avocado","raisin","cranberry","tangerine","nectarine",
]);

function commonStem(seg) {
  if (COMMON_NOUNS.has(seg)) return true;
  if (seg.endsWith("ies") && COMMON_NOUNS.has(seg.slice(0, -3) + "y")) return true;
  if (seg.endsWith("es") && COMMON_NOUNS.has(seg.slice(0, -2))) return true;
  if (seg.endsWith("s") && COMMON_NOUNS.has(seg.slice(0, -1))) return true;
  return false;
}

function isCommonFood(food) {
  const lc = food._lc || (food._lc = food.name.toLowerCase());
  const segs = food._segs || (food._segs = lc.split(",").map(s => s.trim()));
  // segment 1 or 2 ("Chicken, …", "Fish, salmon, …"). The first-word fallback is
  // applied ONLY when a parenthetical comma split the first segment (e.g.
  // "Chickpeas (garbanzo beans, bengal gram), …") — not for multi-word segments
  // like "grape leaves" (which shouldn't match on "grape").
  return commonStem(segs[0]) ||
    (segs.length > 1 && commonStem(segs[1])) ||
    (segs[0].includes("(") && commonStem(lc.split(/[\s,]/)[0]));
}

function isRecommendable(food) {
  if (!(food.kcal > 0) || EXCLUDED_GROUPS.has(food.group) || !isCommonFood(food)) return false;
  if (culinaryGroup(food) === "nuts & seeds") return !NUTSEED_EXCLUDE_RE.test(food._lc);
  return !EXCLUDE_NAME_RE.test(food.name);
}

// Precompute the candidate pool once (FOODS is available from foods.js).
const SWAP_CANDIDATES = FOODS.reduce((a, f, i) => {
  if (isRecommendable(f)) a.push(i);
  return a;
}, []);

// total ± a food's contribution, returning a fresh object.
function addScaled(total, idx, grams, sign) {
  const f = FOODS[idx], factor = (grams / 100) * sign, out = {};
  for (const k of SUM_KEYS) out[k] = total[k] + (f[k] || 0) * factor;
  return out;
}

// Nutrients the optimizer tries to bring to 100%: micronutrients + the
// essential amino acids (both have DV/requirement targets via dvFraction).
const TARGET_KEYS = [...MICRO_KEYS, ...AMINO_KEYS];

// Penalty score for a daily profile: how far below target across all tracked
// nutrients (capped), plus penalties for exceeding calorie target and sodium.
function deficiencyScore(daily, days, kcalTarget) {
  let score = 0;
  for (const k of TARGET_KEYS) {
    const frac = dvFraction(daily, k);
    if (frac < 1) score += (1 - frac);          // reward closing the gap
  }
  // Sodium limit (per day): penalize going over.
  const naFrac = daily.na / DAILY_VALUES.na.dv;
  if (naFrac > 1) score += (naFrac - 1) * 2;
  // Calorie budget: penalize drifting from target (soft).
  if (kcalTarget > 0) {
    const kcalDaily = daily.kcal;
    score += Math.abs(kcalDaily - kcalTarget) / kcalTarget * 0.5;
  }
  return score;
}

function deficientTargets(daily) {
  return TARGET_KEYS.filter(k => dvFraction(daily, k) < DEFICIT_EPS);
}

// Describe a before→after change in terms of the gaps it actually closes: only
// nutrients that were BELOW target, and only the portion of the shortfall
// filled (capped at 100% so overshoot doesn't inflate the number). This matches
// what the ranking rewards, so the label explains why a swap was suggested.
function gapClosedGains(beforeDaily, afterDaily, limit = 2) {
  return TARGET_KEYS
    .map(k => {
      const base = dvFraction(beforeDaily, k);
      if (base >= DEFICIT_EPS) return null;                 // wasn't deficient
      const closed = Math.min(dvFraction(afterDaily, k), 1) - base;
      return closed > 0.01 ? { k, closed } : null;          // ignore trivial (<1%)
    })
    .filter(Boolean)
    .sort((a, b) => b.closed - a.closed)
    .slice(0, limit)
    .map(g => `${DAILY_VALUES[g.k].label} +${Math.round(g.closed * 100)}%`);
}

// "Do no harm": coverage a swap GIVES UP, counting surplus down to a buffer
// (BUFFER_CAP) so the optimizer won't gut a well-met, hard-to-get nutrient (e.g.
// take vitamin D from 700% to 0%) just to nudge a couple of others. Returned in
// the same units as the deficiency score and subtracted from a swap's gain.
const BUFFER_CAP = 1.25;   // value coverage as "kept" up to 125% of target
const LOSS_WEIGHT = 1.5;   // how heavily to weight lost coverage vs. gained
function coverageLost(before, after) {
  let lost = 0;
  for (const k of TARGET_KEYS) {
    const d = Math.min(dvFraction(before, k), BUFFER_CAP) - Math.min(dvFraction(after, k), BUFFER_CAP);
    if (d > 0) lost += d;
  }
  return lost;
}

// Net benefit of a swap: how much it lowers the deficiency score, minus a
// penalty for coverage it sacrifices. Higher is better; >0 means worth doing.
// `beforeScore` is precomputed (it's constant across candidates in a loop).
function swapBenefit(beforeDaily, beforeScore, afterDaily, days, kcalTarget) {
  return beforeScore - deficiencyScore(afterDaily, days, kcalTarget)
    - LOSS_WEIGHT * coverageLost(beforeDaily, afterDaily);
}

// Produce a sequence of recommended swaps. Returns { swaps, finalMeals }.
function optimize(baseMeals, days) {
  let working = baseMeals.map(m => ({ ...m }));
  let total = totals(working);                       // running totals (whole period)
  const kcalTarget = total.kcal / days;              // keep daily calories steady
  const swaps = [];
  const swapped = new Set();                         // logged positions already swapped

  for (let step = 0; step < MAX_SWAPS; step++) {
    const dailyNow = perDay(total, days);
    if (deficientTargets(dailyNow).length === 0) break;
    const scoreNow = deficiencyScore(dailyNow, days, kcalTarget);

    let best = null; // { mealPos, addIdx, addGrams, benefit }

    for (let pos = 0; pos < working.length; pos++) {
      if (swapped.has(pos)) continue;  // each logged food is swapped at most once
      const item = working[pos];
      const removedKcal = (FOODS[item.foodIndex].kcal * item.grams) / 100;
      // totals with this logged item removed (computed once per position).
      const without = addScaled(total, item.foodIndex, item.grams, -1);

      for (const addIdx of SWAP_CANDIDATES) {
        if (addIdx === item.foodIndex) continue;
        const addFood = FOODS[addIdx];

        // Calorie-matched serving, capped to a realistic amount.
        let grams = removedKcal > 0 ? (removedKcal / addFood.kcal) * 100 : 100;
        grams = Math.max(20, Math.min(MAX_SERVING_G, grams));

        const dailyTrial = perDay(addScaled(without, addIdx, grams, +1), days);
        const benefit = swapBenefit(dailyNow, scoreNow, dailyTrial, days, kcalTarget);

        if (benefit > 1e-6 && (!best || benefit > best.benefit)) {
          best = { mealPos: pos, addIdx, addGrams: grams, benefit };
        }
      }
    }

    if (!best) break; // no swap improves things further

    const removed = working[best.mealPos];
    const beforeDaily = perDay(total, days);
    total = addScaled(addScaled(total, removed.foodIndex, removed.grams, -1),
                      best.addIdx, best.addGrams, +1);
    working[best.mealPos] = { foodIndex: best.addIdx, grams: best.addGrams };
    swapped.add(best.mealPos);
    const afterDaily = perDay(total, days);

    swaps.push({
      removeFood: FOODS[removed.foodIndex].name,
      removeGrams: Math.round(removed.grams),
      addFood: FOODS[best.addIdx].name,
      addGrams: Math.round(best.addGrams),
      before: beforeDaily,
      after: afterDaily,
    });
  }

  return { swaps, finalMeals: working };
}

// A food's "nutrient signature" = its 3 richest micronutrients (per 100 g, as a
// fraction of DV). Foods sharing a signature are near-duplicates for swap
// purposes (e.g. every animal liver is B12/A/copper), so we dedupe on it to
// keep the replacement list diverse.
function foodSig(food) {
  if (food._sig) return food._sig;
  const ranked = MICRO_KEYS
    .map(k => [k, (food[k] || 0) / DAILY_VALUES[k].dv])
    .sort((a, b) => b[1] - a[1]);
  return (food._sig = ranked.slice(0, 2).map(x => x[0]).sort().join(","));
}

// Culinary class for "recipe-sensible" swaps — mostly the USDA food group, but
// nuts, seeds and nut/seed butters are merged (peanut butter is a USDA legume
// but culinarily a nut butter), so e.g. almonds count as a swap for peanut
// butter. Used to reserve a few slots for foods that fit the same recipe role.
function culinaryGroup(food) {
  const lc = food._lc || (food._lc = food.name.toLowerCase());
  // Real nuts/seeds (USDA group) plus peanuts/peanut butter (USDA files those
  // under legumes, but they're culinarily nut butters). Note: legumes named
  // "…, mature seeds, …" must NOT match here.
  if (food.group === "Nut and Seed Products" || /peanut|nut butter/.test(lc))
    return "nuts & seeds";
  return food.group;
}

// Distinguishes distinct foods (almonds vs walnuts, cheddar vs cottage) for the
// recipe slots, so we don't list five variants of the same thing.
function recipeKey(food) {
  const segs = food._segs || (food._segs = food._lc.split(",").map(s => s.trim()));
  return segs.slice(0, 2).join(",");
}

// Top-N calorie-matched replacements for the food at `pos`, ranked by how much
// each improves the WHOLE-diet balance (other foods held fixed). The first ~7
// slots are the best diverse picks (deduped by nutrient signature); the LAST 3
// are reserved for "recipe-sensible" swaps in the same culinary class as the
// food being replaced (e.g. cheddar → cottage cheese, peanut butter → almonds).
function topReplacements(meals, pos, days, n = 10) {
  const baseTotal = totals(meals);
  const baseDaily = perDay(baseTotal, days);
  const kcalTarget = baseTotal.kcal / days;
  const scoreNow = deficiencyScore(baseDaily, days, kcalTarget);
  const item = meals[pos];
  const removedKcal = (FOODS[item.foodIndex].kcal * item.grams) / 100;
  const without = addScaled(baseTotal, item.foodIndex, item.grams, -1);
  const origGroup = culinaryGroup(FOODS[item.foodIndex]);

  const cands = [];
  for (const addIdx of SWAP_CANDIDATES) {
    if (addIdx === item.foodIndex) continue;
    let grams = removedKcal > 0 ? (removedKcal / FOODS[addIdx].kcal) * 100 : 100;
    grams = Math.max(20, Math.min(MAX_SERVING_G, grams));
    const trialDaily = perDay(addScaled(without, addIdx, grams, +1), days);
    const improvement = swapBenefit(baseDaily, scoreNow, trialDaily, days, kcalTarget);
    cands.push({ addIdx, grams, improvement });
  }
  cands.sort((a, b) => b.improvement - a.improvement);

  const nRecipe = 3, nGlobal = n - nRecipe;
  const seenSig = new Set(), seenIdx = new Set();

  // Global phase: best diverse picks (signature dedup).
  const global = [];
  for (const cand of cands) {
    if (global.length >= nGlobal) break;
    const sig = foodSig(FOODS[cand.addIdx]);
    if (seenSig.has(sig)) continue;
    seenSig.add(sig); seenIdx.add(cand.addIdx); global.push(cand);
  }

  // Recipe phase: improving swaps in the same culinary class, distinct foods.
  const recipe = [], seenRecipe = new Set();
  for (const cand of cands) {
    if (recipe.length >= nRecipe) break;
    if (cand.improvement <= 0 || seenIdx.has(cand.addIdx)) continue;
    if (culinaryGroup(FOODS[cand.addIdx]) !== origGroup) continue;
    const rk = recipeKey(FOODS[cand.addIdx]);
    if (seenRecipe.has(rk)) continue;
    seenRecipe.add(rk); seenIdx.add(cand.addIdx);
    recipe.push({ ...cand, recipe: true });
  }

  // Backfill global if recipe came up short, so the list stays ~n long.
  for (const cand of cands) {
    if (global.length + recipe.length >= n) break;
    const sig = foodSig(FOODS[cand.addIdx]);
    if (seenSig.has(sig) || seenIdx.has(cand.addIdx)) continue;
    seenSig.add(sig); seenIdx.add(cand.addIdx); global.push(cand);
  }

  const result = [...global, ...recipe];
  // Annotate each with the deficient-nutrient gaps it closes most (why it ranks).
  for (const cand of result) {
    const trialDaily = perDay(addScaled(without, cand.addIdx, cand.grams, +1), days);
    cand.gainText = gapClosedGains(baseDaily, trialDaily, 2).join(", ");
  }
  return result;
}

// ---------------------------------------------------------------------------
// SVG chart helpers (no external chart library — works fully offline)
// ---------------------------------------------------------------------------

const MACRO_COLORS = { p: "#4e79a7", c: "#f28e2b", f: "#e15759" };

// Distinct colors assigned to each logged food, consistent across all charts.
const FOOD_COLORS = ["#4e79a7","#f28e2b","#59a14f","#e15759","#76b7b2","#edc948",
  "#b07aa1","#ff9da7","#9c755f","#86bcb6","#d37295","#8cd17d","#b6992d","#499894"];
const colorFor = i => FOOD_COLORS[i % FOOD_COLORS.length];

// Per-day nutrient contribution of each logged meal item (sums to `daily`).
function perFoodContribs(mealList, days) {
  return mealList.map(m => {
    const c = contribution(m.foodIndex, m.grams);
    const o = {};
    for (const k of [...ALL_KEYS, "kcal"]) o[k] = c[k] / days;
    return o;
  });
}

// Shared color legend mapping each food to its swatch.
function foodLegend(mealList, title = "Your foods (chart colors)") {
  const titleHtml = title ? `<div class="legend-title">${title}</div>` : "";
  const rows = mealList.map((m, i) => {
    const amt = m.mult > 1
      ? `${Math.round(m.baseGrams)} g ×${m.mult} = ${Math.round(m.grams)} g`
      : `${Math.round(m.grams)} g`;
    return `<span class="food-chip" data-food="${i}" title="click to highlight this food across the charts"><span class="swatch" style="background:${colorFor(i)}"></span>` +
      `${escapeHtml(FOODS[m.foodIndex].name)} <span class="muted">(${amt})</span></span>`;
  }).join("");
  return `<div class="food-legend">${titleHtml}${rows}</div>`;
}

// Stacked horizontal bars showing each food's share of every macro (in grams).
function macroBars(mealList, perFood, daily) {
  const macros = [["p","Protein"],["c","Carbs"],["f","Fat"],["fib","Fiber"]];
  const rowH = 30, labelW = 70, barW = 300, valW = 120, padTop = 6;
  const fullW = labelW + barW + valW, h = padTop + macros.length * rowH;
  let svg = "";
  macros.forEach(([k, label], r) => {
    const total = daily[k] || 0;
    const y = padTop + r * rowH;
    svg += `<text x="0" y="${y + 17}" class="bar-label" text-anchor="start">${label}</text>` +
           `<rect x="${labelW}" y="${y + 4}" width="${barW}" height="16" fill="#eef0f3" rx="2"/>`;
    let x = labelW;
    if (total > 0) {
      mealList.forEach((m, i) => {
        const v = perFood[i][k];
        if (v <= 0) return;
        const w = (v / total) * barW;
        svg += `<rect x="${x.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="16" fill="${colorFor(i)}" data-food="${i}">` +
               `<title>${escapeHtml(FOODS[m.foodIndex].name)}: ${fmt(v)} g (${Math.round(v / total * 100)}% of ${label.toLowerCase()})</title></rect>`;
        x += w;
      });
    }
    const pct = Math.round(dvFraction(daily, k) * 100);
    svg += `<text x="${labelW + barW + 8}" y="${y + 17}" class="bar-pct">${fmt(total)} g · ${pct}% DV</text>`;
  });
  return `<svg viewBox="0 0 ${fullW} ${h}" width="100%" preserveAspectRatio="xMinYMin meet" role="img">${svg}</svg>`;
}

// Stacked-by-food bars for a set of nutrient keys. Each bar is scaled to its own
// total so you can see which foods supply it (e.g. omega-3 from the salmon).
// Right-side text gives the amount + reference target (DV / AI / limit) if one
// exists, else just the amount (e.g. carotenoids, which have no DV).
function stackedNutrientBars(keys, mealList, perFood, daily) {
  const rowH = 30, labelW = 130, barW = 250, valW = 150, padTop = 6;
  const fullW = labelW + barW + valW, h = padTop + keys.length * rowH;
  let svg = "";
  keys.forEach((k, r) => {
    const meta = DAILY_VALUES[k], total = daily[k] || 0, y = padTop + r * rowH;
    svg += `<text x="0" y="${y + 17}" class="bar-label" text-anchor="start">${meta.label}</text>` +
           `<rect x="${labelW}" y="${y + 4}" width="${barW}" height="16" fill="#eef0f3" rx="2"/>`;
    let x = labelW;
    if (total > 0) {
      mealList.forEach((m, i) => {
        const v = perFood[i][k];
        if (v <= 0) return;
        const w = (v / total) * barW;
        svg += `<rect x="${x.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="16" fill="${colorFor(i)}" data-food="${i}">` +
               `<title>${escapeHtml(FOODS[m.foodIndex].name)}: ${fmt(v)} ${meta.unit} (${Math.round(v / total * 100)}% of ${meta.label.toLowerCase()})</title></rect>`;
        x += w;
      });
    }
    // reference text: % of DV/AI when a target exists, else just the amount
    let ref = `${fmt(total)} ${meta.unit}`;
    if (meta.dv) {
      const pct = Math.round(total / meta.dv * 100);
      ref += meta.limit ? ` · ${pct}% of ${meta.dv} ${meta.unit} limit`
                        : ` · ${pct}% of ${meta.dv} ${meta.unit} AI`;
    }
    svg += `<text x="${labelW + barW + 8}" y="${y + 17}" class="bar-pct">${ref}</text>`;
  });
  return `<svg viewBox="0 0 ${fullW} ${h}" width="100%" preserveAspectRatio="xMinYMin meet" role="img">${svg}</svg>`;
}

function macroPie(daily) {
  // Calories from each macro (protein 4, carb 4, fat 9 kcal/g).
  const parts = [
    { key: "p", label: "Protein", kcal: daily.p * 4 },
    { key: "c", label: "Carbs",   kcal: daily.c * 4 },
    { key: "f", label: "Fat",     kcal: daily.f * 9 },
  ];
  const total = parts.reduce((s, p) => s + p.kcal, 0) || 1;
  const cx = 110, cy = 110, r = 100;
  let angle = -Math.PI / 2;
  let paths = "";
  let legend = "";
  for (const p of parts) {
    const frac = p.kcal / total;
    const end = angle + frac * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(end),   y2 = cy + r * Math.sin(end);
    const large = frac > 0.5 ? 1 : 0;
    paths += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} ` +
             `A${r},${r} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" ` +
             `fill="${MACRO_COLORS[p.key]}" stroke="#fff" stroke-width="2"/>`;
    legend += `<div class="legend-row"><span class="swatch" style="background:${MACRO_COLORS[p.key]}"></span>` +
              `${p.label}: ${Math.round(daily[p.key])} g (${Math.round(frac * 100)}% of kcal)</div>`;
    angle = end;
  }
  return `<div class="chart-flex">
      <svg viewBox="0 0 220 220" width="220" height="220" role="img">${paths}</svg>
      <div class="legend">
        <div class="legend-title">Calorie sources</div>
        ${legend}
        <div class="legend-row muted">Fiber: ${Math.round(daily.fib)} g/day (DV ${DAILY_VALUES.fib.dv} g)</div>
      </div>
    </div>`;
}

// Bars scaled so 100% of target sits at a fixed reference line; the filled
// portion is split into per-food segments (colored to match the legend). Bar
// caps at 150% for layout. `keys` selects which nutrients; `lineLabel` names the
// reference line (e.g. "100% DV" or "100% target").
function dvBars(keys, daily, mealList, perFood, lineLabel = "100% DV") {
  const rowH = 26, labelW = 130, barW = 320, padTop = 8, scale = barW / 1.5;
  const h = padTop + keys.length * rowH + 24;
  const fullW = labelW + barW + 70;
  let rows = "";
  keys.forEach((k, i) => {
    const frac = dvFraction(daily, k);
    const y = padTop + i * rowH;
    const total = daily[k] || 0;
    const visW = Math.min(frac, 1.5) * scale;   // total filled width (capped at 150%)
    const unit = DAILY_VALUES[k].unit;
    rows += `<text x="${labelW - 6}" y="${y + 16}" text-anchor="end" class="bar-label">${DAILY_VALUES[k].label}</text>` +
            `<rect x="${labelW}" y="${y + 4}" width="${barW / 1.5}" height="16" fill="#eef0f3"/>`;
    let x = labelW;
    if (total > 0) {
      mealList.forEach((m, fi) => {
        const v = perFood[fi][k];
        if (v <= 0) return;
        const w = (v / total) * visW;           // this food's share of the visible bar
        rows += `<rect x="${x.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="16" fill="${colorFor(fi)}" data-food="${fi}">` +
                `<title>${escapeHtml(FOODS[m.foodIndex].name)}: ${fmt(v)} ${unit} (${Math.round(v / total * 100)}% of ${DAILY_VALUES[k].label})</title></rect>`;
        x += w;
      });
    }
    const pctClass = frac >= DEFICIT_EPS ? "bar-pct met" : "bar-pct";
    rows += `<text x="${labelW + barW / 1.5 + 8}" y="${y + 16}" class="${pctClass}">${Math.round(frac * 100)}%</text>`;
  });
  const lineX = labelW + scale;
  rows += `<line x1="${lineX}" y1="${padTop}" x2="${lineX}" y2="${padTop + keys.length * rowH}"
            stroke="#333" stroke-width="1.5" stroke-dasharray="4 3"/>
           <text x="${lineX}" y="${padTop + keys.length * rowH + 16}" text-anchor="middle" class="bar-pct">${lineLabel}</text>`;
  return `<svg viewBox="0 0 ${fullW} ${h}" width="100%" preserveAspectRatio="xMinYMin meet" role="img">${rows}</svg>`;
}

// Omega-6 : omega-3 ratio shown on a scale. Zones: ideal 1:1–4:1 (green),
// suboptimal 4–10 (amber), poor/Western 10–20+ (red). A marker sits at the
// user's actual ratio. Returns "" if neither omega is present.
function omegaRatioChart(daily) {
  const o3 = daily.o3, o6 = daily.o6;
  if (!(o6 > 0) && !(o3 > 0)) return "";
  const hasRatio = o3 > 0;
  const r = hasRatio ? o6 / o3 : Infinity;
  const W = 500, padL = 24, padR = 24, barW = W - padL - padR;
  const MAX = 20, trackY = 28, trackH = 18;
  const xOf = v => padL + Math.min(Math.max(v, 0), MAX) / MAX * barW;

  let svg = "";
  for (const [a, b, color, label] of [
    [0, 4, "#cdeccd", "ideal"], [4, 10, "#fce6c4", ""], [10, MAX, "#f6cccc", ""],
  ]) {
    const x = xOf(a), w = xOf(b) - xOf(a);
    svg += `<rect x="${x.toFixed(1)}" y="${trackY}" width="${w.toFixed(1)}" height="${trackH}" fill="${color}"/>`;
    if (label) svg += `<text x="${(x + w / 2).toFixed(1)}" y="${trackY + 13}" text-anchor="middle" class="bar-label" fill="#2f7a2f">${label}</text>`;
  }
  svg += `<rect x="${padL}" y="${trackY}" width="${barW}" height="${trackH}" fill="none" stroke="#d4d8de"/>`;
  for (const t of [4, 10, 15, 20]) {
    const x = xOf(t);
    svg += `<line x1="${x.toFixed(1)}" y1="${trackY + trackH}" x2="${x.toFixed(1)}" y2="${trackY + trackH + 4}" stroke="#9aa1ab"/>` +
           `<text x="${x.toFixed(1)}" y="${trackY + trackH + 16}" text-anchor="middle" class="bar-pct">${t}:1${t === MAX ? "+" : ""}</text>`;
  }
  // marker at the actual ratio
  const mx = xOf(hasRatio ? r : MAX);
  const mcolor = !hasRatio ? "#b91c1c" : r <= 4 ? "#15803d" : r <= 10 ? "#b45309" : "#b91c1c";
  const label = !hasRatio ? ">20 : 1 (no ω-3)" : r > MAX ? `${Math.round(r)} : 1` : `${r.toFixed(1)} : 1`;
  const tx = Math.max(padL + 32, Math.min(W - padL - 32, mx));   // keep label on-canvas
  svg += `<polygon points="${(mx - 6).toFixed(1)},${trackY - 9} ${(mx + 6).toFixed(1)},${trackY - 9} ${mx.toFixed(1)},${trackY - 1}" fill="${mcolor}"/>` +
         `<text x="${tx.toFixed(1)}" y="${trackY - 13}" text-anchor="middle" class="bar-label" fill="${mcolor}" style="font-weight:700">${label}</text>`;
  return `<svg viewBox="0 0 ${W} ${trackY + trackH + 24}" width="100%" preserveAspectRatio="xMinYMin meet" role="img">${svg}</svg>`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmt(n) { return n >= 100 ? Math.round(n) : Math.round(n * 10) / 10; }

// --- Click-to-highlight one food across every per-food chart ------------------
// Each per-food bar segment and each legend chip carries data-food="<i>" (the
// i-th logged food, same color everywhere via colorFor). Clicking a legend chip
// emphasizes that food and dims the rest, across all charts inside #results
// (main charts, swap-preview, projected-after). Click again to clear.
let highlightIdx = null;

function applyHighlight() {
  const root = document.getElementById("results");
  if (!root) return;
  const h = highlightIdx;
  root.querySelectorAll("[data-food]").forEach(el => {
    const i = Number(el.dataset.food);
    if (el.classList.contains("food-chip")) {
      el.classList.toggle("chip-active", h !== null && i === h);
      el.classList.toggle("chip-dim", h !== null && i !== h);
    } else {
      el.classList.toggle("seg-dim", h !== null && i !== h);   // svg segment
    }
  });
}

function onLegendClick(e) {
  // A legend chip OR any per-food bar segment (both carry data-food).
  const el = e.target.closest("[data-food]");
  if (!el) return;
  const i = Number(el.dataset.food);
  highlightIdx = highlightIdx === i ? null : i;   // toggle off if re-clicked
  applyHighlight();
}

// Read every meal row in the DOM into a [{foodIndex, grams}] list.
// Each row stores its resolved food index in data-idx (set when the user
// picks a value that matches a food name).
function collectMeals() {
  const out = [];
  const unknown = [];
  document.querySelectorAll(".meal-row").forEach(row => {
    const search = row.querySelector(".food-search");
    const baseGrams = Number(row.querySelector(".grams").value);
    const mult = Number(row.querySelector(".mult").value) || 1;   // blank → ×1
    const grams = baseGrams * mult;                                // effective total
    const name = search.value.trim();
    if (!name && !(grams > 0)) return;       // blank row, ignore
    const idx = NAME_TO_INDEX.has(name) ? NAME_TO_INDEX.get(name)
                                        : Number(row.dataset.idx);
    if (!(idx >= 0) || !Number.isInteger(idx) || !FOODS[idx]) { unknown.push(name || "(empty)"); return; }
    if (grams > 0) out.push({ foodIndex: idx, grams, baseGrams, mult });
  });
  if (unknown.length) {
    alert("These entries don't match a food in the database (pick from the dropdown):\n• " +
          unknown.join("\n• "));
  }
  return out;
}

// Click handler: show a spinner, then run the (synchronous, multi-second)
// calculation AFTER a paint so the spinner is actually visible.
function runCalculate() {
  const results = document.getElementById("results");
  results.innerHTML =
    `<div class="loading"><span class="spinner"></span> Crunching the numbers…</div>`;
  requestAnimationFrame(() => requestAnimationFrame(renderResults));
}

function renderResults() {
  const days = Math.max(1, Number(document.getElementById("days").value) || 1);
  const meals = collectMeals();
  if (meals.length === 0) {
    document.getElementById("results").innerHTML = "";   // clear the spinner
    alert("Add at least one food (with a serving size in grams) first.");
    return;
  }
  const daily = perDay(totals(meals), days);
  const perFood = perFoodContribs(meals, days);
  const results = document.getElementById("results");

  // Subheading shown under every section with a hoverable/clickable chart.
  const HINT = `<h4 class="hint">Hover for info and Click to focus</h4>`;

  // Omega-6 : omega-3 ratio chart. Health consensus: aim for ~4:1 or lower
  // (ideal 1:1–4:1); typical Western diets run a pro-inflammatory 15–20:1.
  const omegaChart = omegaRatioChart(daily);
  const omegaHeading = daily.o3 > 0
    ? `Omega-6 to Omega-3 ratio is ${fmt(daily.o6)} g to ${fmt(daily.o3)} g, or ${(daily.o6 / daily.o3).toFixed(1)} : 1`
    : `Omega-6 to Omega-3 ratio is ${fmt(daily.o6)} g to 0 g (no omega-3 logged)`;
  const omegaRatioHtml = omegaChart
    ? `<h4 class="sub">${omegaHeading}</h4>${omegaChart}` +
      `<p class="muted" style="margin:2px 0 0">Aim for 4:1 or lower (ideal 1:1–4:1); typical Western diets run 15–20:1.</p>`
    : "";

  // Summary line (sodium now lives in the Fats & fatty acids "upper limits" chart)
  let html = `
    <h2>Daily average over ${days} day${days > 1 ? "s" : ""}</h2>
    <p class="muted">${Math.round(daily.kcal)} kcal/day</p>
    <div class="card"><h3>Macronutrients</h3>${macroPie(daily)}
      <h4 class="sub">Where each macro comes from</h4>${HINT}${macroBars(meals, perFood, daily)}</div>
    <div class="card"><h3>Micronutrients vs. Daily Value</h3>${HINT}${dvBars(MICRO_KEYS, daily, meals, perFood)}</div>
    <div class="card"><h3>Essential amino acids vs. requirement</h3>${HINT}${dvBars(AMINO_KEYS, daily, meals, perFood, "100% req")}
      <p class="muted" style="margin:8px 0 0">Targets are IOM estimated requirements for a ~70 kg adult (they scale with body weight); no FDA Daily Value exists for amino acids. Met+Cys and Phe+Tyr are grouped as in protein-quality scoring.</p></div>
    <div class="card"><h3>Fats &amp; fatty acids</h3>${HINT}${stackedNutrientBars([...FAT_KEYS, "na"], meals, perFood, daily)}
      ${omegaRatioHtml}
      <p class="muted" style="margin:8px 0 0">Omega-3/6 use IOM Adequate Intakes (no FDA Daily Value exists); saturated fat, cholesterol &amp; sodium are upper limits.</p></div>
    <div class="card"><h3>Carotenoids (phytonutrients)</h3>${HINT}${stackedNutrientBars(CAROT_KEYS, meals, perFood, daily)}
      <p class="muted" style="margin:8px 0 0">No Daily Value exists for these; shown as amounts. Beta-carotene also counts toward vitamin A (already included above).</p></div>
    <div class="card" id="swapExplorer"></div>`;

  // Optimizer
  const deficient = deficientTargets(daily);
  html += `<div class="card"><h3>Recommendations</h3>`;
  if (deficient.length === 0) {
    html += `<p class="ok">🎉 You're at or above target for all tracked micronutrients and amino acids. Nice balance!</p>`;
  } else {
    html += `<p>Below target: <strong>${deficient.map(k => DAILY_VALUES[k].label).join(", ")}</strong>.</p>`;
    const { swaps, finalMeals } = optimize(meals, days);
    if (swaps.length === 0) {
      html += `<p class="muted">No single-food swap in the database improves your coverage without overshooting calorie/sodium limits. Consider adding a serving of a nutrient-dense food (e.g. beef liver, oysters, sardines, spinach, pumpkin seeds, fortified cereal).</p>`;
    } else {
      html += `<p>Suggested calorie-matched swaps (applied in order, recomputing totals each time):</p><ol class="swaps">`;
      for (const s of swaps) {
        const gains = gapClosedGains(s.before, s.after, 4).join(", ");
        html += `<li>Swap <strong>${s.removeGrams} g ${s.removeFood}</strong> →
                 <strong>${s.addGrams} g ${s.addFood}</strong>
                 ${gains ? `<br><span class="muted">gains: ${gains}</span>` : ""}</li>`;
      }
      html += `</ol>`;
      const finalDaily = perDay(totals(finalMeals), days);
      const finalPerFood = perFoodContribs(finalMeals, days);
      const stillLow = deficientTargets(finalDaily);
      html += `<p class="muted">After these swaps: ${TARGET_KEYS.length - stillLow.length}/${TARGET_KEYS.length} nutrients at 100%+ target` +
        (stillLow.length ? `; still low: ${stillLow.map(k => DAILY_VALUES[k].label).join(", ")}.` : `. All targets met!`) + `</p>`;
      html += `<details><summary>Projected micronutrient chart after swaps</summary>` +
        `${HINT}${foodLegend(finalMeals, "Foods after swaps")}${dvBars(MICRO_KEYS, finalDaily, finalMeals, finalPerFood)}</details>`;
    }
  }
  html += `</div>`;

  results.innerHTML = html;
  highlightIdx = null;          // fresh results start with nothing highlighted
  mountSwapExplorer(meals, days);
  applyHighlight();
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Interactive "What If I Swapped" explorer: a replacement dropdown per food and
// a live balance preview that updates as the user combines choices.
function mountSwapExplorer(meals, days) {
  const box = document.getElementById("swapExplorer");
  if (!box) return;
  const baseDaily = perDay(totals(meals), days);
  const baseMet = TARGET_KEYS.length - deficientTargets(baseDaily).length;
  const selection = {};                       // pos -> { addIdx, grams } or absent
  const customByPos = {};                     // pos -> last food picked via search
  const replacementsByPos = meals.map((_, pos) => topReplacements(meals, pos, days, 10));

  box.innerHTML = `<h3>What If I Swapped…</h3>
    <p class="muted">Pick from the top-10 suggestions <em>or</em> search any food to try it. Combine as many as you like — calorie-matched servings.</p>
    <div class="swap-controls"></div>
    <div class="swap-preview"></div>`;
  const controls = box.querySelector(".swap-controls");
  const preview = box.querySelector(".swap-preview");

  // Calorie-matched serving for replacing the logged food at `pos`.
  const matchGrams = (pos, addIdx) => {
    const removedKcal = (FOODS[meals[pos].foodIndex].kcal * meals[pos].grams) / 100;
    const g = removedKcal > 0 ? (removedKcal / FOODS[addIdx].kcal) * 100 : 100;
    return Math.max(20, Math.min(MAX_SERVING_G, g));
  };

  meals.forEach((m, pos) => {
    const ctl = document.createElement("div");
    ctl.className = "swap-ctl";
    const reps = replacementsByPos[pos];
    const optOf = (c, i) =>
      `<option value="${i}">→ ${escapeHtml(FOODS[c.addIdx].name)} (${Math.round(c.grams)} g)` +
      `${c.gainText ? ` · ${c.gainText}` : ""}</option>`;
    const globalOpts = reps.map((c, i) => ({ c, i })).filter(x => !x.c.recipe).map(x => optOf(x.c, x.i)).join("");
    const recipeOpts = reps.map((c, i) => ({ c, i })).filter(x => x.c.recipe).map(x => optOf(x.c, x.i)).join("");
    ctl.innerHTML =
      `<span class="swatch" style="background:${colorFor(pos)}"></span>` +
      `<select class="swap-select" data-pos="${pos}">` +
        `<option value="">Keep — ${escapeHtml(FOODS[m.foodIndex].name)} (${Math.round(m.grams)} g)</option>` +
        `<optgroup label="Best for your gaps">${globalOpts}</optgroup>` +
        (recipeOpts ? `<optgroup label="Similar foods (recipe-friendly)">${recipeOpts}</optgroup>` : "") +
      `</select>`;
    const sel = ctl.querySelector("select");

    // Search box: try ANY food. A pick adds/updates a "✎ custom" option on the
    // select and selects it, so the dropdown reflects the active choice and you
    // can still revert to "Keep" or a top-10 option.
    const searcher = buildFoodSearch(addIdx => {
      const grams = matchGrams(pos, addIdx);
      customByPos[pos] = { addIdx, grams };
      let opt = [...sel.options].find(o => o.value === "c");
      if (!opt) { opt = document.createElement("option"); opt.value = "c"; sel.appendChild(opt); }
      opt.textContent = `✎ ${FOODS[addIdx].name} (${Math.round(grams)} g)`;
      sel.value = "c";
      selection[pos] = customByPos[pos];
      updatePreview();
    });
    ctl.appendChild(searcher.wrap);
    controls.appendChild(ctl);

    sel.addEventListener("change", e => {
      const v = e.target.value;
      if (v === "") delete selection[pos];
      else if (v === "c") selection[pos] = customByPos[pos];
      else selection[pos] = replacementsByPos[pos][Number(v)];
      updatePreview();
    });
  });

  function updatePreview() {
    const newMeals = meals.map((m, i) =>
      selection[i] ? { foodIndex: selection[i].addIdx, grams: selection[i].grams } : m);
    const newDaily = perDay(totals(newMeals), days);
    const perFood = perFoodContribs(newMeals, days);
    const met = TARGET_KEYS.length - deficientTargets(newDaily).length;
    const nSwaps = Object.keys(selection).length;
    const naPct = Math.round(newDaily.na / DAILY_VALUES.na.dv * 100);
    const metDelta = met === baseMet ? `${met}/${TARGET_KEYS.length}`
      : `${baseMet} → <strong>${met}</strong>/${TARGET_KEYS.length}`;
    preview.innerHTML =
      `<p class="muted" style="margin:14px 0 6px">${nSwaps ? `Previewing ${nSwaps} swap${nSwaps > 1 ? "s" : ""}` : "No swaps selected (showing your current balance)"} — ` +
      `${Math.round(newDaily.kcal)} kcal/day · Sodium ${naPct}% · nutrients at target: ${metDelta}</p>` +
      `<h4 class="hint">Hover for info and Click to focus</h4>` +
      dvBars(MICRO_KEYS, newDaily, newMeals, perFood);
    applyHighlight();    // keep any active highlight after the preview rebuilds
  }
  updatePreview();
}

// "Compare two ingredients" — pick two foods (with serving sizes) and see their
// nutrients side by side, independent of the logged diet.
const COMPARE_GROUPS = [
  ["Energy", ["kcal"]],
  ["Macronutrients", MACRO_KEYS],
  ["Micronutrients", MICRO_KEYS],
  ["Fats & fatty acids", FAT_KEYS],
  ["Carotenoids", CAROT_KEYS],
  ["Essential amino acids", AMINO_KEYS],
];

// Significance reference per nutrient (a "meaningful daily amount") used only to
// suppress highlighting of trivial gaps — e.g. 0 vs 1 mcg shouldn't look huge.
// For nutrients with a DV/AI we use that; these cover the no-DV ones.
const SIG_REF = { kcal: 200, bcar: 5000, lutzea: 6000, lyco: 8000, mufa: 5, pufa: 5 };

function compareTable(ia, ga, ib, gb) {
  const A = contribution(ia, ga), B = contribution(ib, gb);
  const head = (idx, g, c) =>
    `<div class="cmp-name">${escapeHtml(FOODS[idx].name)}</div>` +
    `<div class="muted">${Math.round(g)} g · ${Math.round(c.kcal)} kcal</div>`;
  let rows = "";
  for (const [group, keys] of COMPARE_GROUPS) {
    rows += `<tr class="cmp-group"><td colspan="3">${group}</td></tr>`;
    for (const k of keys) {
      const meta = k === "kcal"
        ? { label: "Calories", unit: "kcal", dv: null }
        : DAILY_VALUES[k];
      const va = A[k] || 0, vb = B[k] || 0;
      if (va === 0 && vb === 0) continue;                 // skip all-zero rows
      const dvOf = v => meta.dv ? ` <span class="cmp-dv">${Math.round(v / meta.dv * 100)}%</span>` : "";
      // Escalate the higher cell only when BOTH matter: the relative gap (ratio)
      // AND the absolute gap as a fraction of a meaningful daily amount (DV/AI/
      // floor). So a tiny value next to zero (e.g. 2.7 mcg = 2% DV vs 0) stays
      // plain even though the ratio is huge.
      //   green  ≥10% ratio & ≥5% DV gap
      //   bold   ≥50% ratio & ≥10% DV gap
      //   larger ≥100% ratio & ≥20% DV gap
      const ref = meta.dv || SIG_REF[k] || 0;
      const tier = (win, other) => {
        const d = other > 0 ? (win / other - 1) * 100 : Infinity;
        const gapFrac = ref ? (win - other) / ref : Infinity;
        let cls = "";
        if (d >= 10 && gapFrac >= 0.05) cls = " cmp-hi";
        if (d >= 50 && gapFrac >= 0.10) cls += " cmp-bold";
        if (d >= 100 && gapFrac >= 0.20) cls += " cmp-xl";
        return cls;
      };
      const a = va > vb ? tier(va, vb) : "";
      const b = vb > va ? tier(vb, va) : "";
      rows += `<tr><td class="cmp-lbl">${meta.label}</td>` +
        `<td class="cmp-val${a}">${fmt(va)} ${meta.unit}${dvOf(va)}</td>` +
        `<td class="cmp-val${b}">${fmt(vb)} ${meta.unit}${dvOf(vb)}</td></tr>`;
    }
  }
  return `<table class="cmp-table">
    <thead><tr><th></th><th>${head(ia, ga, A)}</th><th>${head(ib, gb, B)}</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted" style="margin:8px 0 0">The higher value is highlighted by how big the gap is — green, then bold, then larger — but only when the amount is also nutritionally meaningful, so a tiny value next to zero stays plain. %DV shown where a Daily Value / AI exists.</p>`;
}

function mountCompare() {
  const box = document.getElementById("compare");
  if (!box) return;
  let idxA = null, idxB = null;
  box.innerHTML = `<h3>Compare two ingredients</h3>
    <p class="muted">Pick two foods to see their nutrients side by side — independent of your logged diet. The second serving is auto-set to match the first's calories; edit either freely.</p>
    <div class="compare-inputs">
      <div class="compare-side"><div class="cmp-search-a"></div>
        <label class="cmp-g">grams <input class="cmp-grams cmp-grams-a" type="number" min="1" step="1" value="100"></label></div>
      <div class="compare-side"><div class="cmp-search-b"></div>
        <label class="cmp-g">grams <input class="cmp-grams cmp-grams-b" type="number" min="1" step="1" value="100"></label></div>
    </div>
    <div class="compare-result"></div>`;
  const gA = box.querySelector(".cmp-grams-a"), gB = box.querySelector(".cmp-grams-b");

  // Set B's serving to the same calories as A's current serving (A is the
  // reference). Runs when either food is picked, not on manual grams edits.
  function matchBtoA() {
    if (idxA == null || idxB == null) return;
    const kcalA = FOODS[idxA].kcal * (Number(gA.value) || 0) / 100;
    const kB = FOODS[idxB].kcal;
    if (kcalA > 0 && kB > 0) gB.value = Math.max(1, Math.round(kcalA / kB * 100));
  }

  const sa = buildFoodSearch(i => { idxA = i; matchBtoA(); render(); }, { keepValue: true, placeholder: "search first food…" });
  const sb = buildFoodSearch(i => { idxB = i; matchBtoA(); render(); }, { keepValue: true, placeholder: "search second food…" });
  box.querySelector(".cmp-search-a").appendChild(sa.wrap);
  box.querySelector(".cmp-search-b").appendChild(sb.wrap);
  gA.addEventListener("input", render);
  gB.addEventListener("input", render);

  function render() {
    const out = box.querySelector(".compare-result");
    if (idxA == null || idxB == null) {
      out.innerHTML = `<p class="muted">Pick a food on each side to compare.</p>`;
      return;
    }
    const ga = Math.max(0, Number(gA.value) || 0), gb = Math.max(0, Number(gB.value) || 0);
    out.innerHTML = compareTable(idxA, ga, idxB, gb);
  }
  render();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// Map of exact food name -> index, for resolving typed/picked values.
const NAME_TO_INDEX = new Map();
FOODS.forEach((f, i) => { if (!NAME_TO_INDEX.has(f.name)) NAME_TO_INDEX.set(f.name, i); });

// Food indices currently present in the meal rows (resolved by data-idx or name).
// Used to float already-logged foods to the top of search results.
function enteredFoodIndices() {
  const set = new Set();
  document.querySelectorAll(".meal-row").forEach(r => {
    const di = Number(r.dataset.idx);
    if (Number.isInteger(di) && di >= 0 && FOODS[di]) { set.add(di); return; }
    const sEl = r.querySelector(".food-search");
    if (sEl) { const idx = NAME_TO_INDEX.get(sEl.value.trim()); if (idx !== undefined) set.add(idx); }
  });
  return set;
}

// One dropdown option row; tags foods already in the user's meal list.
function foodOptionHTML(idx, i, entered) {
  const tag = entered && entered.has(idx) ? `<span class="opt-in">in your list</span>` : "";
  return `<div class="food-opt" data-i="${i}">` +
    `<span class="opt-name">${escapeHtml(FOODS[idx].name)}${tag}</span>` +
    `<span class="opt-grp">${escapeHtml(FOODS[idx].group)}</span></div>`;
}

// --- Search ranking: surface whole/basic foods before niche/branded ones ----
// Lower tier = more "basic whole food" → shown first.
const GROUP_TIER = {};
[
  ["Dairy and Egg Products",0], ["Poultry Products",0], ["Fruits and Fruit Juices",0],
  ["Vegetables and Vegetable Products",0], ["Beef Products",0], ["Pork Products",0],
  ["Finfish and Shellfish Products",0], ["Legumes and Legume Products",0],
  ["Lamb, Veal, and Game Products",0], ["Nut and Seed Products",0],
  ["Cereal Grains and Pasta",0], ["Fats and Oils",0],
  ["Breakfast Cereals",1], ["Soups, Sauces, and Gravies",1],
  ["Sausages and Luncheon Meats",1], ["Baked Products",1], ["Spices and Herbs",1],
  ["American Indian/Alaska Native Foods",1], ["Beverages",1], ["Alcoholic Beverages",1],
  ["Sweets",2], ["Snacks",2], ["Meals, Entrees, and Side Dishes",2], ["Fast Foods",2],
  ["Restaurant Foods",2], ["Branded Food Products Database",2], ["Baby Foods",2],
  ["Quality Control Materials",3],
].forEach(([g, t]) => { GROUP_TIER[g] = t; });
const tierOf = f => (f.group in GROUP_TIER ? GROUP_TIER[f.group] : 2);

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

// In USDA naming, a canonical whole food is "Noun, qualifier, qualifier…", so
// the food noun is the first comma-segment ("Chicken, broilers…", "Apples,
// raw"). Finfish/shellfish are "Fish, salmon, …" / "Mollusks, oyster, …", where
// the noun you'd type is the SECOND segment. Product-y items match neither
// ("Chicken patty", "Salmon nuggets", "Apple juice").
//   0 = token is the leading segment   1 = token is the second segment   2 = neither
function primaryRank(food, t0) {
  const segs = food._segs || (food._segs = food._lc.split(",").map(s => s.trim()));
  const eq = s => s === t0 || s === t0 + "s" || s === t0 + "es" || s + "s" === t0 || s + "es" === t0;
  if (eq(segs[0])) return 0;
  if (segs.length > 1 && eq(segs[1])) return 1;
  return 2;
}

// Return food indices matching all whitespace-separated tokens, ranked so that
// basic whole foods come first.
function searchFoods(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const tokens = q.split(/\s+/);
  const t0 = tokens[0];
  // Each token can match itself or its singular form (so "oysters" finds the
  // "Mollusks, oyster, …" entries, "eggs" finds "Egg, …", etc.).
  const variants = tokens.map(t =>
    t.length > 3 && t.endsWith("s") ? [t, t.slice(0, -1)] : [t]);
  const hits = [];
  for (let i = 0; i < FOODS.length; i++) {
    const f = FOODS[i];
    const name = f._lc || (f._lc = f.name.toLowerCase());
    let ok = true;
    for (const vs of variants) {
      if (!vs.some(v => name.indexOf(v) >= 0)) { ok = false; break; }
    }
    if (ok) hits.push(i);
  }
  const entered = enteredFoodIndices();
  hits.sort((a, b) => {
    const fa = FOODS[a], fb = FOODS[b];
    let d = (entered.has(a) ? 0 : 1) - (entered.has(b) ? 0 : 1); if (d) return d; // 0. foods you've already logged
    d = tierOf(fa) - tierOf(fb); if (d) return d;             // 1. whole-food groups first
    d = primaryRank(fa, t0) - primaryRank(fb, t0); if (d) return d; // 2. canonical "Noun, …" first
    d = (fa._lc.startsWith(t0) ? 0 : 1) - (fb._lc.startsWith(t0) ? 0 : 1); if (d) return d; // 3. leading match
    const ia = fa._lc.indexOf(t0), ib = fb._lc.indexOf(t0);        // 4. exact token earlier in name
    d = (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); if (d) return d; //    (-1 = only singular matched → last)
    const ca = fa._cc ?? (fa._cc = (fa.name.match(/,/g) || []).length);
    const cb = fb._cc ?? (fb._cc = (fb.name.match(/,/g) || []).length);
    d = ca - cb; if (d) return d;                             // 5. fewer qualifiers = more basic
    return fa.name.length - fb.name.length;                   // 6. shorter
  });
  return hits;
}

// Reusable ranked food typeahead. Returns { wrap, search }; calls onPick(idx)
// with the chosen food index. By default clears itself on pick (swap explorer);
// pass { keepValue:true } to leave the chosen name in the box (compare tool).
function buildFoodSearch(onPick, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "swap-search food-cell";
  wrap.innerHTML =
    `<input class="food-search" placeholder="${opts.placeholder || "or search any food…"}" autocomplete="off">` +
    `<div class="food-dropdown" hidden></div>`;
  const search = wrap.querySelector(".food-search");
  const dd = wrap.querySelector(".food-dropdown");
  let current = [], active = -1;
  const close = () => { dd.hidden = true; dd.innerHTML = ""; active = -1; };
  function renderList() {
    current = searchFoods(search.value).slice(0, 60);
    if (search.value.trim().length < 2) { close(); return; }
    if (!current.length) { dd.innerHTML = `<div class="food-opt none">no matches</div>`; dd.hidden = false; return; }
    const entered = enteredFoodIndices();
    dd.innerHTML = current.map((idx, i) => foodOptionHTML(idx, i, entered)).join("");
    active = -1; dd.hidden = false; dd.scrollTop = 0;
  }
  function highlight() {
    [...dd.children].forEach((c, i) => c.classList.toggle("active", i === active));
    if (dd.children[active]) dd.children[active].scrollIntoView({ block: "nearest" });
  }
  function pick(i) {
    const idx = current[i];
    if (idx === undefined) return;
    close();
    search.value = opts.keepValue ? FOODS[idx].name : "";
    onPick(idx);
  }
  search.addEventListener("input", renderList);
  search.addEventListener("focus", () => { if (search.value.trim().length >= 2) renderList(); });
  search.addEventListener("blur", () => setTimeout(close, 150));
  search.addEventListener("keydown", e => {
    if (dd.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, current.length - 1); highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") close();
  });
  dd.addEventListener("mousedown", e => {
    const opt = e.target.closest(".food-opt");
    if (!opt || opt.classList.contains("none")) return;
    e.preventDefault();
    pick(Number(opt.dataset.i));
  });
  return { wrap, search };
}

// --- Persistence: keep entered foods across page refreshes -------------------
// Stored by food NAME (not array index) so saved meals survive a database
// regeneration. Wrapped in try/catch in case localStorage is unavailable.
const STORE_KEY = "nutrientBalancer.v1";
let restoring = false;
let draggingRow = null;

// Wire a drag handle so its host element (a meal row OR a meal-section divider)
// can be dragged to reorder. Both carry the `drag-item` class so they reorder
// together. The element itself isn't draggable, so its inputs stay clickable.
function wireDragHandle(el) {
  const handle = el.querySelector(".drag-handle");
  handle.addEventListener("dragstart", e => {
    draggingRow = el;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");   // Firefox needs data set
  });
  handle.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    draggingRow = null;
    saveState();                                 // persist new order
  });
}

// Which item should the dragged item be inserted *before*, given the cursor Y?
function rowAfterCursor(container, y) {
  const others = [...container.querySelectorAll(".drag-item:not(.dragging)")];
  let closest = null, closestDist = -Infinity;
  for (const r of others) {
    const box = r.getBoundingClientRect();
    const offset = y - (box.top + box.height / 2);  // negative = cursor above midpoint
    if (offset < 0 && offset > closestDist) { closestDist = offset; closest = r; }
  }
  return closest;
}

// Serialize the on-screen items (foods AND meal-section dividers, in order) +
// days. Dividers are stored as { divider: "<label>" }; food rows keep their
// existing { food, grams, mult } shape, so old saves still load.
function currentRowsData() {
  const rows = [...document.getElementById("mealRows").children].map(el => {
    if (el.classList.contains("meal-divider")) {
      return { divider: el.querySelector(".divider-label").value };
    }
    return {
      food: el.querySelector(".food-search").value,
      grams: el.querySelector(".grams").value,
      mult: el.querySelector(".mult").value,
    };
  });
  const daysEl = document.getElementById("days");
  return { rows, days: daysEl ? daysEl.value : "1" };
}

// Rebuild the UI from a saved data object, then persist it as the working set.
// An item with a `divider` field is a section header; everything else is a food
// row (so saves made before dividers existed still restore correctly).
function applyState(data) {
  restoring = true;
  document.getElementById("mealRows").innerHTML = "";
  document.getElementById("days").value = (data && data.days) || "1";
  const rows = (data && data.rows) || [];
  if (rows.length) rows.forEach(r => r.divider != null ? addDivider(r.divider, false)
                                                       : addMealRow(r, false));
  else addMealRow(undefined, false);
  restoring = false;
  saveState();
}

// Append a draggable meal-section divider (Breakfast / Lunch / …). Purely
// organizational — collectMeals ignores it, so it never affects the nutrients.
function addDivider(label, focus = true) {
  const div = document.createElement("div");
  div.className = "meal-divider drag-item";
  div.innerHTML =
    `<span class="drag-handle" draggable="true" title="drag to reorder">⠿</span>` +
    `<input class="divider-label" autocomplete="off" placeholder="meal section…">` +
    `<button type="button" class="link-btn" title="remove this section" aria-label="remove">✕</button>`;
  const input = div.querySelector(".divider-label");
  input.value = label || "";
  input.addEventListener("input", saveState);
  div.querySelector(".link-btn").addEventListener("click", () => { div.remove(); saveState(); });
  wireDragHandle(div);
  document.getElementById("mealRows").appendChild(div);
  if (focus) { input.focus(); input.select(); }
  return div;
}

function saveState() {
  if (restoring) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(currentRowsData())); }
  catch (e) { /* storage disabled — silently skip */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// --- Named diet sets: save / load / delete (separate from the working set) ---
const SAVES_KEY = "nutrientBalancer.saves.v1";

function loadSaves() {
  try { return JSON.parse(localStorage.getItem(SAVES_KEY)) || {}; }
  catch (e) { return {}; }
}
function writeSaves(map) {
  try { localStorage.setItem(SAVES_KEY, JSON.stringify(map)); } catch (e) {}
}
function refreshSavesUI(selected) {
  const sel = document.getElementById("savedList");
  if (!sel) return;
  const names = Object.keys(loadSaves()).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">${names.length ? "— pick a saved diet —" : "— no saved diets —"}</option>` +
    names.map(n => `<option${n === selected ? " selected" : ""}>${escapeHtml(n)}</option>`).join("");
}
function saveCurrentDiet() {
  const input = document.getElementById("dietName");
  const name = input.value.trim();
  if (!name) { alert("Type a name for this diet first."); input.focus(); return; }
  const map = loadSaves();
  if (name in map && !confirm(`Overwrite the saved diet "${name}"?`)) return;
  map[name] = currentRowsData();
  writeSaves(map);
  refreshSavesUI(name);
}
function loadSavedDiet() {
  const name = document.getElementById("savedList").value;
  if (!name) return;
  const map = loadSaves();
  if (map[name]) {
    applyState(map[name]);
    document.getElementById("dietName").value = name;
    document.getElementById("results").innerHTML = "";   // stale results
  }
}
function deleteSavedDiet() {
  const name = document.getElementById("savedList").value;
  if (!name) return;
  if (!confirm(`Delete the saved diet "${name}"? (Your current entries stay as they are.)`)) return;
  const map = loadSaves();
  delete map[name];
  writeSaves(map);
  refreshSavesUI();
}

// Append a fresh meal row with a ranked typeahead food picker.
// `prefill` = { food, grams, mult } restores a saved row; `focus` auto-focuses it.
function addMealRow(prefill, focus = true) {
  const row = document.createElement("div");
  row.className = "meal-row drag-item";
  row.innerHTML =
    `<span class="drag-handle" draggable="true" title="drag to reorder">⠿</span>` +
    `<div class="food-cell">` +
      `<input class="food-search" placeholder="type to search ${FOODS.length} foods…" autocomplete="off">` +
      `<div class="food-dropdown" hidden></div>` +
    `</div>` +
    `<input class="grams" type="number" min="1" step="1" placeholder="grams" value="100">` +
    `<input class="mult" type="number" min="1" step="1" value="1" title="multiplier — e.g. 5 if you ate this on 5 days">` +
    `<button type="button" class="link-btn" title="remove this food" aria-label="remove">✕</button>`;
  const search = row.querySelector(".food-search");
  const dd = row.querySelector(".food-dropdown");
  let current = [], active = -1;

  const close = () => { dd.hidden = true; dd.innerHTML = ""; active = -1; };
  function renderList() {
    current = searchFoods(search.value).slice(0, 60);
    if (search.value.trim().length < 2) { close(); return; }
    if (!current.length) { dd.innerHTML = `<div class="food-opt none">no matches</div>`; dd.hidden = false; return; }
    const entered = enteredFoodIndices();
    dd.innerHTML = current.map((idx, i) => foodOptionHTML(idx, i, entered)).join("");
    active = -1; dd.hidden = false; dd.scrollTop = 0;
  }
  function highlight() {
    [...dd.children].forEach((c, i) => c.classList.toggle("active", i === active));
    if (dd.children[active]) dd.children[active].scrollIntoView({ block: "nearest" });
  }
  function pick(i) {
    const idx = current[i];
    if (idx === undefined) return;
    search.value = FOODS[idx].name;
    row.dataset.idx = String(idx);
    search.classList.remove("invalid");
    close();
    saveState();
  }

  search.addEventListener("input", () => { row.dataset.idx = ""; renderList(); saveState(); });
  search.addEventListener("focus", () => { if (search.value.trim().length >= 2) renderList(); });
  search.addEventListener("blur", () => {
    setTimeout(close, 150); // let a click on an option register first
    const idx = NAME_TO_INDEX.get(search.value.trim());
    if (idx !== undefined) row.dataset.idx = String(idx);
    search.classList.toggle("invalid", search.value.trim() !== "" && idx === undefined);
    saveState();
  });
  search.addEventListener("keydown", e => {
    if (dd.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, current.length - 1); highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") { close(); }
  });
  dd.addEventListener("mousedown", e => {
    const opt = e.target.closest(".food-opt");
    if (!opt || opt.classList.contains("none")) return;
    e.preventDefault(); // keep focus, beat blur
    pick(Number(opt.dataset.i));
  });

  row.querySelector(".grams").addEventListener("input", saveState);
  row.querySelector(".mult").addEventListener("input", saveState);

  row.querySelector(".link-btn").addEventListener("click", () => {
    row.remove();
    if (!document.querySelector(".meal-row")) addMealRow(); // keep ≥1 row
    saveState();
  });

  // Drag-to-reorder via the handle (live reordering handled by the container).
  wireDragHandle(row);

  document.getElementById("mealRows").appendChild(row);

  if (prefill) {
    search.value = prefill.food || "";
    row.querySelector(".grams").value = prefill.grams || "";
    if (prefill.mult != null && prefill.mult !== "") row.querySelector(".mult").value = prefill.mult;
    const idx = NAME_TO_INDEX.get((prefill.food || "").trim());
    if (idx !== undefined) row.dataset.idx = String(idx);
    else if ((prefill.food || "").trim()) search.classList.add("invalid");
  }
  if (focus) search.focus();
  return row;
}

// Reset the working set to a single empty row. Saved named diets are untouched.
function clearAll() {
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  document.getElementById("mealRows").innerHTML = "";
  document.getElementById("days").value = "1";
  document.getElementById("results").innerHTML = "";
  document.getElementById("dietName").value = "";
  addMealRow();
}

document.addEventListener("DOMContentLoaded", () => {
  applyState(loadState());        // restore the working set (or one empty row)
  refreshSavesUI();               // populate the saved-diets dropdown
  mountCompare();                 // standalone ingredient comparison tool

  document.getElementById("addRow").addEventListener("click", () => addMealRow());
  document.getElementById("addDivider").addEventListener("click", () => {
    const presets = ["Breakfast", "Lunch", "Dinner", "Snacks"];
    const n = document.querySelectorAll(".meal-divider").length;
    addDivider(presets[n] || `Meal ${n + 1}`);
  });
  document.getElementById("clearAll").addEventListener("click", clearAll);
  document.getElementById("days").addEventListener("input", saveState);
  document.getElementById("calculate").addEventListener("click", runCalculate);
  document.getElementById("results").addEventListener("click", onLegendClick);
  document.getElementById("saveDiet").addEventListener("click", saveCurrentDiet);
  document.getElementById("loadDiet").addEventListener("click", loadSavedDiet);
  document.getElementById("deleteDiet").addEventListener("click", deleteSavedDiet);

  // Live reorder: as the dragged row moves, slot it among the others by cursor Y.
  const mealRows = document.getElementById("mealRows");
  mealRows.addEventListener("dragover", e => {
    if (!draggingRow) return;
    e.preventDefault();
    const before = rowAfterCursor(mealRows, e.clientY);
    if (before == null) mealRows.appendChild(draggingRow);
    else if (before !== draggingRow.nextSibling) mealRows.insertBefore(draggingRow, before);
  });
  mealRows.addEventListener("drop", e => e.preventDefault());
});
