# 🥗 Nutrient Balancer

A self-contained, offline tool that turns a list of logged meals into a
nutritional picture and tells you which **specific foods to swap in** to fill
your micronutrient gaps.

## Run it

Just open **`index.html`** in any browser. No install, no server, no internet
needed — everything (food data, charts, optimizer) runs locally in the page.

Your entered foods and "days" value are **saved automatically** to the
browser's `localStorage`, so you can refresh (or come back later) without
re-typing them. Use **Clear all** to reset. (Saved per browser; foods are keyed
by name so they survive even if the food database is regenerated.)

**Named diets:** the **Saved diets** bar lets you keep multiple input sets —
type a name and **Save current**, then **Clear all** and build a different diet,
and switch between them via the dropdown + **Load** / **Delete**. These named
saves are separate from the auto-saved working set, so loading one doesn't lose
the others.

## What it does

1. **Log meals** — start typing a food name; a ranked dropdown filters the 7,793 foods as you type. Results are ordered **whole/basic foods first** (e.g. typing "chicken" surfaces the generic cuts — breast/thigh, with/without skin, raw/roasted/fried — before restaurant or branded items). Singular/plural both work ("oysters" finds "Mollusks, oyster…"). Foods already in your meal list float to the **top of every search** (tagged "in your list"), so they're easy to reuse in the swap explorer and compare tool. Pick a match (click or arrow-keys + Enter) and enter a serving in grams. Each row also has a **× multiplier** (e.g. enter 200 g ×5 if you ate that serving on 5 days) so you can log multiple days quickly. Add as many rows as you like, and **drag the ⠿ handle to reorder** them. You can also **+ Add meal section** to drop in **Breakfast / Lunch / Dinner** dividers (editable labels) and drag them anywhere among your foods to organize the list — they're purely organizational and don't affect the nutrient totals. Dividers are saved with your diet just like the food rows.
2. **Enter days covered** — totals are divided by this to get your *average daily intake*.
3. **Calculate** — you get:
   - a **pie chart** of macronutrients (protein / carbs / fat by calorie share, plus fiber),
   - **per-food breakdown bars** — each macro and each micronutrient bar is split into
     colored segments showing how much each logged food contributes (so you can see
     e.g. that 87% of your protein is from the chicken, not just the protein total).
     Every food gets a consistent color (shared legend), and hovering any segment shows
     the exact amount. **Click a food in the legend** to highlight it across every
     per-food chart at once (the rest dim out), so you can instantly see the effect a
     single ingredient is having; click it again to clear.
   - the micronutrient bars (22 of them, including **choline** and
     **pantothenic acid / B5**) are shown as a % of their Daily Value, with a
     dashed **100% DV reference line** on every bar,
   - a **Fats & fatty acids** breakdown — saturated / mono / poly fat,
     **omega-3 (ALA+EPA+DHA)**, **omega-6 (linoleic)**, and cholesterol, each
     stacked by food (so you can see e.g. that your omega-3 is from the salmon).
     Omega-3/6 use IOM Adequate Intakes (the FDA sets no DV for them); saturated
     fat and cholesterol are shown against their upper limits,
   - a **Carotenoids** breakdown — beta-carotene, lutein+zeaxanthin, lycopene
     (informational amounts; no DV exists for these),
   - an **Essential amino acids** chart (same %-of-target, stacked-by-food style
     as the micros) — the 9 indispensable amino acids vs. IOM requirements for a
     ~70 kg adult (Met+Cys and Phe+Tyr grouped as in protein-quality scoring),
   - a **"What If I Swapped…" explorer** — per logged food, a dropdown of its
     top 10 calorie-matched replacements **plus a search box to try any food**.
     The list is split into **"Best for your gaps"** (7 diverse highest-impact
     picks, deduped by nutrient profile so you don't get ten kinds of liver) and
     **"Similar foods (recipe-friendly)"** (3 swaps in the same culinary class —
     e.g. cheddar → cottage cheese, peanut butter → sunflower seeds — so they're
     realistic to cook with). Each is labeled with the deficient-nutrient gaps it
     closes. Pick replacements and the balance preview ("nutrients at target:
     X → Y") updates live.
   - automatic **swap recommendations** to close any gaps.

There's also a standalone **Compare two ingredients** card (independent of your
logged diet): pick two foods to see every nutrient side by side, with %DV and
the higher value highlighted. The first food defaults to 100 g and the second is
auto-set to **calorie-match** it (edit either serving freely).

## How the recommendations work

You can't just "add more food" to fix a deficiency — removing or replacing a
food also removes its nutrients. So the optimizer does **calorie-matched
swaps**:

- For every logged item × every *recommendable* food, it tentatively replaces
  the logged food with the candidate at a serving sized to match the removed
  food's calories (capped at a realistic 250 g).
- The recommendable pool (~3,600 foods) is restricted to **common, everyday
  whole foods**: it drops engineered/fortified/prepared items (bars, fortified
  cereals, sweets, fast food, powders), and then keeps only foods whose primary
  food noun is in a curated everyday-foods set (so you get spinach, salmon,
  eggs, beans, liver — not grape leaves, dandelion greens, or lambsquarters).
  You can still **log** any of the 7,793 foods; this only constrains *suggestions*.
- It recomputes the **full daily totals** for that trial (so the lost nutrients
  from the removed food are fully accounted for).
- It scores each trial by how much it closes the gap on nutrients below target —
  the 22 micronutrients **and the 9 essential amino acids** — while penalizing
  going over the sodium limit or drifting from your calorie level.
- It also applies a **"do no harm" penalty**: a swap is charged for coverage it
  *gives up* (counting surplus down to a 125% buffer), so it won't gut a well-met,
  hard-to-get nutrient — e.g. take vitamin D from 700% to 0% — just to nudge a
  couple of others. A swap is only suggested if its gains clearly outweigh what
  it costs; if nothing qualifies, it says so rather than recommending a harmful trade.
- It greedily applies the single best swap, then repeats, recomputing every
  time. **Each logged food is swapped at most once** (no swapping a food it just
  swapped in), so you get at most one suggestion per food you logged. The result
  is an ordered list of swaps plus a projected "after" chart.

This is a greedy heuristic over a constraint-style objective — fast, runs in
the browser, and good enough to surface the high-impact moves (it tends to
suggest things like liver, oysters, sardines, leafy greens, dairy, and seeds —
the genuine nutrient powerhouses among common foods).

## Data sources

- **Food nutrients** (`foods.js`): all **7,793 foods** from the
  [USDA FoodData Central **SR Legacy**](https://fdc.nal.usda.gov/download-datasets/)
  release (2018-04, the final SR release), at real per-100g values. `foods.js`
  is generated by `build/build_foods.js` directly from the USDA CSV dump; the
  nutrient→ID mapping was verified against the dataset's own `nutrient.csv`.
  To regenerate, download the SR Legacy CSV zip (URL in the build script),
  unzip it next to the script, and run `node build_foods.js`.
- **Daily Values**: FDA Nutrition Facts label values for adults & children 4+
  (2016 rule, in effect since 2020). Verified against
  [FDA](https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels)
  guidance (e.g. Vit A 900 mcg RAE, Vit C 90 mg, Vit D 20 mcg, Calcium 1300 mg,
  Potassium 4700 mg, Zinc 11 mg).

## Limitations

- Nutrient values are USDA reference figures rounded to 3 decimals — accurate
  for a given food entry, but real foods vary by brand, cultivar, and prep.
  This is a planning/education aid, not a clinical or medical tool.
- DVs are generic adult targets; they don't adjust for age, sex, pregnancy,
  or activity.
- Not every SR Legacy food has every micronutrient measured; missing values
  are treated as 0, which can understate a food.
- Swaps are calorie-matched and capped at 250 g, so swapping calorie-dense
  foods for low-calorie greens can pull daily calories down. The calorie-drift
  penalty is intentionally soft; tune the weight in `deficiencyScore` if you
  want calories held tighter.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI and styling |
| `foods.js`   | Generated food database (7,793 foods) + Daily Value reference |
| `app.js`     | Totals, averaging, typeahead, SVG charts, swap optimizer |
| `build/build_foods.js` | Regenerates `foods.js` from the USDA SR Legacy CSV dump |
