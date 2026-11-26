# Dunk the Break — gameplay asset prompts

One prompt per asset. Attach the reference image named in brackets, paste the prompt, generate. Every asset must be a **PNG with a transparent background**, centred, with empty margin around it. Sizes are the final pixel sizes I will drop in; generating larger and letting me downscale is fine.

Shared style line (already inside every prompt): photoreal 3D product render, soft studio lighting from the top-left, crisp edges, no text, no watermark, no shadow baked onto the ground (the game draws shadows).

---

## 1. Player's mug — `mug.png`, 920 x 900 px  [attach: the white KitKat mug photo]

> Photoreal 3D render of this exact white ceramic mug with the red KitKat Chocolate Drink logo on the front, handle on the LEFT, seen from slightly above the rim (camera about 20 degrees above level) so the inside of the rim and the surface of the hot chocolate drink are visible. The drink is glossy milk chocolate brown with a thin cocoa-dusted foam ring near the rim and two or three small bubbles. No steam. Soft studio lighting from the top-left, crisp edges, transparent background, nothing else in frame, no shadow on the ground, no text apart from the logo on the mug.

## 2. Mug with splash — `mug-splash.png`, 920 x 900 px  [attach: the generated mug.png]

> Same mug, same camera, same lighting as the attached image, but at the exact moment a KitKat wafer finger has been dunked: a crown-shaped splash of glossy milk chocolate rises 15 cm above the rim with eight to ten droplets flying up and outward, and the top third of a KitKat finger is still visible sinking into the drink in the middle of the splash. The mug body and logo are unchanged. Transparent background, no ground shadow, no text.

## 3. Wafer finger — `wafer.png`, 180 x 440 px  [attach: a KitKat finger photo if you have one]

> Photoreal 3D render of a single KitKat wafer finger standing vertically, milk chocolate, with the embossed KitKat wordmark readable on the top face and the three-layer wafer visible at one broken end at the bottom. Slight glossy highlight on the chocolate. Soft studio lighting from the top-left, transparent background, no ground shadow, no text other than the embossed wordmark.

## 4. Golden wafer (bonus) — `wafer-gold.png`, 180 x 440 px  [attach: the generated wafer.png]

> Same wafer finger as the attached image, same angle and lighting, but wrapped in shiny gold foil with the KitKat wordmark embossed in the foil, catching bright highlights. A few small gold sparkles float around it. Transparent background, no ground shadow.

## 5. Broken wafer chunk — `wafer-piece.png`, 120 x 120 px  [attach: the generated wafer.png]

> A small broken chunk of the attached KitKat finger, about one third of a finger, showing the wafer layers at the break, tumbling at an angle. Same chocolate colour and lighting. Transparent background, no ground shadow.

## 6. Alarm clock (hazard, everyone) — `alarm.png`, 300 x 300 px

> Photoreal 3D render of a classic twin-bell alarm clock in glossy KitKat red with a white face, black hands, and silver bells, ringing: the hammer is a motion blur between the bells and three short curved vibration lines on each side. Seen straight on, slightly from above. Soft studio lighting from the top-left, transparent background, no ground shadow, no text on the face.

## 7. Exam paper (hazard, students) — `exam.png`, 300 x 300 px

> Photoreal 3D render of a stack of white exam answer sheets with a red pencil on top and a big red "F" grade circled on the first page, seen from slightly above and tilted 15 degrees. Clean toy-like 3D style. Soft studio lighting from the top-left, transparent background, no ground shadow, no other readable text.

## 8. Order ticket rail (hazard, kitchen and culinary crowd) — `orders.png`, 300 x 300 px

> Photoreal 3D render of a stainless-steel kitchen order-ticket rail crammed with white paper tickets, one ticket flying off, with a small red flame on the end of the rail. Seen straight on, slightly from above. Clean toy-like 3D style. Soft studio lighting from the top-left, transparent background, no ground shadow, no readable text.

## 9. Traffic jam (hazard, commuters) — `traffic.png`, 300 x 300 px

> Photoreal 3D render of a glossy red traffic cone with a small grey toy car stuck behind it and a red hourglass floating above, tilted 15 degrees. Clean toy-like 3D style. Soft studio lighting from the top-left, transparent background, no ground shadow, no text.

## 10. Laundry pile (hazard, home) — `laundry.png`, 300 x 300 px

> Photoreal 3D render of a white laundry basket overflowing with folded and tumbling clothes in red, white and grey, with a sock falling out, seen from slightly above. Clean toy-like 3D style. Soft studio lighting from the top-left, transparent background, no ground shadow, no text.

## 10b. Deadline calendar (hazard, office, optional) — `deadline.png`, 300 x 300 px

> Photoreal 3D render of a desk tear-off calendar block, seen straight on, slightly from above. Red header band with the word DEADLINE in bold white capitals, a white page below with a big red circle around a date, and a red marker pen leaning against it. Soft studio lighting from the top-left, transparent background, no ground shadow.

## 11. Chocolate splash drop — `splash-drop.png`, 60 x 80 px

> Photoreal 3D render of a single glossy milk chocolate droplet, teardrop shape pointing down, with a bright highlight. Transparent background, no ground shadow.

## 12. Gold sparkle — `sparkle.png`, 64 x 64 px

> A single four-point star sparkle in warm gold, soft glowing centre, crisp thin points, on a transparent background.

## 13. Single-line game header — `header-dunk.png`, 1200 x 220 px  [attach: the current "DUNK THE Break" artwork]

> The attached "DUNK THE Break" lettering rebuilt on ONE line: "DUNK THE" in bold white italic capitals followed by "Break" in the same white script, with three thin white sparkle lines on each side. Transparent background, no other elements.

## 14. Gold score digits — `digits/0.png` to `digits/9.png`, each about 300 x 400 px  [attach: the results reference with the gold "30"]

> The digit [N] in exactly the style of the gold "30" in the attached image: same font, same italic angle, same cream-to-gold glossy face, same down-left golden extrusion with the bright edge along the bottom, same soft shadow. One digit only, centred, transparent background. Repeat for 0 through 9 and keep the digit height identical across all ten.

---

## How the game uses them

- **Mug and splash.** The mug follows the player's left–right movement. On a catch the engine swaps to `mug-splash.png` for 0.35 s, spawns `splash-drop.png` particles from the rim and shows the +1. If you only generate `mug.png`, the engine keeps drawing its own splash.
- **Falling items.** Wafers are +1. Golden wafer is +3. Every third wafer in a row is a streak bonus. The hazards are the things that get in the way of a break for every kind of player: alarm clock (everyone), exam paper (students), order-ticket rail (kitchen and culinary crowd), traffic jam (commuters), laundry pile (home), and optionally the deadline calendar (office). Each is –1, streak reset and a 1.2 s stun. The engine rotates through whichever hazard files exist, so you can ship any subset. The game ramps over the 40 seconds: fall speed 420 → 820 px/s, spawn gap 1.0 → 0.5 s, hazard share 0% in the first 8 s then 35%, so the second half demands real left–right movement to thread between hazards.
- **Drop-in.** Put the files into `assets/img/game/` with the names above. The engine already looks for them; the new hazards and the golden wafer need one line each in the manifest, which I will add when they arrive.

---

## "Dunk the Break" title lettering as a vector  [attach: reference/break-lettering-reference.png]

Ask for an SVG (or AI/EPS) so the title stays razor sharp on the 4K kiosk. Attach `reference/break-lettering-reference.png` (the current lettering on the brand red) and paste:

> Recreate the attached title lettering exactly as a clean vector: "DUNK THE" in heavy condensed italic capitals on the top line, "Break" in a flowing brush script below it, with the long swash from the "k" sweeping back under the word and the second swash flying off the top right. Match the attached proportions, slant, letter shapes and the way the two lines overlap. Pure white (#FFFFFF) fill, no outline, no shadow, no gradient, no background. Deliver as SVG with each word as a separate group, artboard trimmed to the lettering, no raster effects. Also deliver a second version of the same lettering filled with a warm gold gradient (#FFE49A top to #C98A1E bottom).

If the generator cannot output SVG, ask for a 4500 x 4000 px PNG with a transparent background and I will trace it.
