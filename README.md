# 🥗 Nutrient Balancer

A self-contained, offline tool that turns a list of logged meals into a
nutritional picture and tells you which **specific foods to eat more of** to fill
your micronutrient gaps.

## Run it

Just open **`index.html`** in any browser. No install, no server, no internet
needed — everything (food data, charts, suggestions) runs locally in the page.

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

1. **Log meals** — start typing a food name; a ranked dropdown filters the 7,793 foods as you type. Results are ordered **whole/basic foods first** (e.g. typing "chicken" surfaces the generic cuts — breast/thigh, with/without skin, raw/roasted/fried — before restaurant or branded items). Singular/plural both work ("oysters" finds "Mollusks, oyster…"). Foods already in your meal list float to the **top of every search** (tagged "in your list"), so they're easy to reuse in the compare tool. Pick a match (click or arrow-keys + Enter) and enter a serving in grams. Each row also has a **× multiplier** (e.g. enter 200 g ×5 if you ate that serving on 5 days) so you can log multiple days quickly. Add as many rows as you like, and **drag the ⠿ handle to reorder** them. You can also **+ Add meal section** to drop in **Breakfast / Lunch / Dinner** dividers (editable labels) and drag them anywhere among your foods to organize the list — they're purely organizational and don't affect the nutrient totals. Dividers are saved with your diet just like the food rows.
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
   - a **"Foods rich in the nutrients you're low on"** table — for every nutrient
     below 100% of target, ten whole foods proportionally highest in it (as % of
     the Daily Value per 100 g), spread across **different food families** for variety
     (so you get e.g. mushroom / fish / egg for vitamin D, not five mushrooms) and
     filtered to genuine everyday foods (no oils, rendered fats, cured/processed
     meats, or obscure lab entries).

There's also a standalone **Compare two ingredients** card (independent of your
logged diet): pick two foods to see every nutrient side by side, with %DV and
the higher value highlighted. The first food defaults to 100 g and the second is
auto-set to **calorie-match** it (edit either serving freely).

## How the suggestions work

For every nutrient you're below target on, the app lists the foods that are
proportionally richest in it (highest % of the Daily Value per 100 g), drawn
from a curated pool of common whole foods:

- The recommendable pool is restricted to **common, everyday whole foods**: it
  drops engineered/fortified/prepared items (bars, fortified cereals, sweets,
  fast food, powders) and keeps only foods whose primary food noun is in a
  curated everyday-foods set (spinach, salmon, eggs, beans, liver — not grape
  leaves or lambsquarters), with an extra filter for non-foods (extracted
  oils/rendered fats, cured/processed meats, mechanically-separated meats,
  unusual organs, and obscure lab entries). You can still **log** any of the
  7,793 foods; this only constrains *suggestions*.
- Picks are **spread across food families** for variety: the leading food noun
  ("Nuts, …" vs "Seeds, …"), with all organ meats grouped by organ — so a
  nutrient returns one liver / one mushroom / one kind of seed rather than ten
  near-identical entries, before backfilling with the next-best distinct foods.

It's deliberately a "go eat more of these" guide rather than a diet solver — you
decide which suggested foods to add to your meals.

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
- Suggestions rank foods by nutrient density (% DV per 100 g), so very
  low-calorie foods can rank high even when you'd need a large portion to hit
  the target — treat the list as "good sources to add," not exact servings.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI and styling |
| `foods.js`   | Generated food database (7,793 foods) + Daily Value reference |
| `app.js`     | Totals, averaging, typeahead, SVG charts, rich-foods suggestions |
| `build/build_foods.js` | Regenerates `foods.js` from the USDA SR Legacy CSV dump |
