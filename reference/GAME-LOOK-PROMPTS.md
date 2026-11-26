# Dunk the Break — gameplay look: every prompt in one place

Goal: the game screen matches the reference frame (`reference/game-screen-reference.webp`): deep red
radial burst, long warm light streaks falling with the items, warm milk-chocolate wafers, a glowing
gold wafer, and **cool, saturated hazards** that pop against the red (royal-blue alarm, teal phone,
violet calendar, violet envelope). Glossy toy-like 3D, soft studio light from the top-left.

What is artwork and what is code:

- **Artwork (these prompts):** wafers, gold wafer, chunks, drops, sparkle, the four hazards, the mug
  pair, optional backdrop.
- **Code (already live, no prompt needed):** falling speed streaks behind every item, warm speed lines
  across the background that grow with the pace of the round, rotating gold rays, splash on a catch,
  +1/+2/+3 pops, mug shadow, 60 fps fixed-step engine, crossfaded music.

## How to use

1. Attach the file named in **Attach** (the current PNG from `assets/img/game/`, plus the reference frame
   when it says so).
2. Paste the **Shared style line** first, then the asset prompt.
3. Save the result under the **same file name** into `assets/img/game/`. Nothing else changes: the game
   scales every sprite to its logical size, so bigger files simply look sharper on the 4K kiosk.

**Output rules for every asset:** transparent PNG, centred, same camera angle and framing as the attached
file, no ground shadow, no text other than what the prompt names, no background. Sizes below are 2x the
current files so they stay crisp on the 2160 x 3840 panel.

### Shared style line (paste before every prompt)

> Glossy, toy-like 3D render for a premium chocolate-brand game, clean edges, soft studio key light from the
> top-left with a warm rim light from the right, subtle warm bounce from a red environment, no ground shadow,
> transparent background, centred, nothing cropped.

---

## A. Falling items (warm)

### `wafer.png` — KitKat finger  [Attach: wafer.png]  Output 360 x 880

> A single KitKat finger standing upright, milk chocolate (#8B4A1E body, #C27A3A highlights), the KitKat
> wordmark embossed on top, one end snapped to show the crisp golden wafer layers with a few crumbs
> floating beside it. Slight glossy sheen, premium.

### `wafer-gold.png` — gold bonus finger  [Attach: wafer-gold.png]  Output 360 x 880

> The same KitKat finger wrapped in bright metallic gold foil (#FFE49A highlights to #C98A1E shadow),
> wordmark embossed, a snapped end showing the wafer, three small four-point sparkles around it and a soft
> golden glow. Must read as "special" next to the chocolate one.

### `wafer-piece.png` — broken chunks for the splash  [Attach: wafer-piece.png]  Output 240 x 240

> Three broken KitKat chunks tumbling, one large and two small, showing the layered wafer inside, with a
> few crumbs, milk chocolate, arranged loosely in a square.

### `splash-drop.png` — chocolate drop  [Attach: splash-drop.png]  Output 120 x 160

> A single airborne drop of hot chocolate, glossy, teardrop shape with a bright specular highlight,
> milk-chocolate colour (#7A3B12 to #C98A4E).

### `sparkle.png` — sparkle  [Attach: sparkle.png]  Output 128 x 128

> A soft four-point gold sparkle with a bright white core and a faint warm halo, on transparent.

## B. Hazards (cool palette from the reference)

### `alarm.png` — alarm clock  [Attach: alarm.png + game-screen-reference.webp]  Output 600 x 600

> Recolour the attached alarm clock to match the reference: glossy royal-blue body and twin bells
> (#1E4FD8 to #2B6BFF highlights), white face, black hands, silver hammer. Keep the ringing vibration
> lines but make them warm yellow-orange. Same angle, size and lighting.

### `phone.png` — ringing phone  [Attach: phone.png + game-screen-reference.webp]  Output 600 x 600

> Recolour the attached phone to match the reference: teal-cyan body (#12B5C9), slightly darker teal
> screen with a white handset icon and the green and red call buttons. Keep the vibration arcs but make
> them warm yellow-orange. Same angle, size and lighting.

### `deadline.png` — deadline calendar  [Attach: deadline.png + game-screen-reference.webp]  Output 600 x 600

> Recolour the attached calendar to match the reference: violet-purple body (#7A3FD6) with gold rings,
> a cream page showing a big dark "15" and a small folded corner. Remove the red circle and the pen.
> Same angle, size and lighting.

### `inbox.png` — urgent mail (new, replaces the ticket rail)  [Attach: game-screen-reference.webp]  Output 600 x 600

> A violet-purple envelope (#7A3FD6) opened, a cream letter sliding out with a small red envelope icon on
> it, a red circular badge with a white exclamation mark at the top-right, and small warm yellow alert
> ticks around it. Seen straight on, slightly from above.

### `traffic.png` — traffic (keep only if you want five hazards)  [Attach: traffic.png]  Output 600 x 600

> Recolour the attached traffic hazard: cone stays orange-white, the car becomes glossy teal-blue
> (#1A8FCF), the hourglass frame violet-purple with warm yellow sand. Same angle, size and lighting.

The reference shows four hazards: alarm, phone, calendar, envelope. Send me `inbox.png` and I will swap
it in for the order-ticket rail so the set matches exactly.

## C. The mug (optional re-render; the current pair already matches)

### `mug.png`  [Attach: mug.png]  Output 1840 x 1800

> The attached cream-white KitKat Chocolate Drink mug, front three-quarter view, filled with hot
> chocolate to just below the rim, glossy ceramic with a soft top-left highlight, the red KitKat logo and
> "CHOCOLATE DRINK" exactly as attached. Same angle and framing.

### `mug-splash.png`  [Attach: mug-splash.png]  Output 1840 x 1800

> The same mug at the same angle with a tall chocolate splash bursting from the drink, crown-shaped,
> with flying drops and a snapped KitKat finger half-sunk in the middle. Same framing as attached.

## D. Backdrop (optional; the game draws the rays and streaks itself)

### `backdrop-4k.png`  [Attach: game-screen-reference.webp]  Output 2160 x 3840

> A portrait backdrop in the reference style: deep KitKat red (#C00A12) with a brighter radial burst
> rising from the lower centre, dozens of long, soft, warm light streaks falling vertically at slightly
> different lengths and brightness, a few faint gold sparkles, darker red vignette at the corners. No
> objects, no text, no wave.

## E. Prompt for a video reference of the motion (if you want to show the client the feel)

> 9:16 vertical, 6 seconds, seamless loop: KitKat fingers and a gold foil finger fall at a steep diagonal
> through a deep red radial-burst background, each trailing a long soft warm light streak, with thin
> vertical speed lines falling faster behind them. A royal-blue alarm clock and a violet calendar fall among
> them. At the bottom a cream KitKat mug catches a finger with a glossy chocolate splash and a gold "+1"
> pops up. Smooth 60 fps motion, premium advertising finish, no camera movement.
