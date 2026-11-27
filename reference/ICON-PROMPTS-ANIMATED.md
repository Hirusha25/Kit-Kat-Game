# Dunk the Break — second icon pack: hazards and bonuses with built-in "alive" states

What the game does with icons today: every hazard falls with a pulsing dashed warning ring, a slow
blink and a nervous twitch, drawn in code around a single still PNG. That already lifts the four
hazards. The next step up is icons that are *designed* to blink: each one delivered as two frames,
an "off" state and an "on" state, which the game flips between at 2–3 times a second. A clock
whose bells flash, a phone whose screen lights, an envelope whose badge pops. Two PNGs per icon,
same size and framing, and the game cross-fades them.

Also in this pack: three **bonus** pick-ups to break up "wafer or hazard" and give the round a
story: a gold wafer already exists (+3); below are a time bonus, a shield and a magnet. They need a
small code change each (noted) that I will do once the artwork is in.

Rules for every file: transparent PNG, 600 x 600 px, centred, same camera angle and framing across
the two frames of an icon, soft studio light from the top-left, no ground shadow, no text other than
what the prompt names, no background. Attach the current file where named (from `assets/img/game/`)
and the reference frame `reference/game-screen-reference.webp` for palette.

### Shared style line (paste first)

> Glossy toy-like 3D render for a premium chocolate-brand arcade game, clean edges, soft studio key
> light from the top-left, warm rim light from the right, subtle warm bounce from a red environment,
> no ground shadow, transparent background, centred, nothing cropped. Deliver two frames with
> identical camera, scale and position: FRAME A (idle) and FRAME B (active).

---

## Hazards (two frames each)

### Alarm clock — `alarm.png` + `alarm-on.png`  [attach alarm.png]
> Royal-blue alarm clock (#1E4FD8 to #2B6BFF), white face, black hands, silver hammer. FRAME A: bells
> still, hammer centred, no motion lines. FRAME B: the two bells glow bright with a white-hot hotspot,
> the hammer tilted hard to one side, four short warm yellow-orange vibration arcs either side, face
> very slightly tilted. Same size and position in both frames.

### Phone — `phone.png` + `phone-on.png`  [attach phone.png]
> Teal-cyan phone (#12B5C9), dark-teal screen. FRAME A: screen dim with a faint white handset icon,
> no arcs. FRAME B: screen fully lit near-white with the handset icon bold, green and red call buttons
> bright, two warm orange vibration arcs each side and a small red notification badge "1" top-right.

### Deadline calendar — `deadline.png` + `deadline-on.png`  [attach deadline.png]
> Violet-purple calendar (#7A3FD6) with gold rings, cream page, big dark "15", "DEADLINE" on the
> header strip. FRAME A: calm. FRAME B: the header strip flashes to red-orange, the "15" turns red
> with a thin red ring around it, the page corner curls up further, two short warm alert ticks above.

### Urgent mail — `inbox.png` + `inbox-on.png`  [attach inbox.png]
> Violet envelope (#7A3FD6) opened, cream letter with a red envelope icon, red exclamation badge.
> FRAME A: letter sitting low in the envelope, badge dull red. FRAME B: letter risen higher, badge
> bright red with a white glow, three warm yellow alert ticks fanning out above, flap lifted a touch.

## Bonuses (new, two frames each)

### Time bonus — `bonus-time.png` + `bonus-time-on.png`  [no attachment]
> A small glossy gold stopwatch with a cream face and a "+5" in bold red on the face, red-brown
> KitKat-style ridges on the crown. FRAME A: plain. FRAME B: the whole watch with a warm gold glow,
> the hand swept forward, three gold sparkles around it.
> Game rule (to build): catching it adds 5 seconds to the clock.

### Shield — `bonus-shield.png` + `bonus-shield-on.png`  [no attachment]
> A rounded shield in glossy cream with a red KitKat-red chevron band, gold rim. FRAME A: matte.
> FRAME B: the rim lit gold with a soft white hotspot and a thin white flare on the left edge.
> Game rule (to build): the next hazard hit does not cost a point; a cream ring shows on the mug while
> the shield is active.

### Magnet — `bonus-magnet.png` + `bonus-magnet-on.png`  [no attachment]
> A horseshoe magnet in KitKat red with cream tips and a gold band at the bend. FRAME A: plain.
> FRAME B: three tiny chocolate wafer chunks drawn toward the tips with short motion streaks, the tips
> glowing warm gold.
> Game rule (to build): for 4 seconds wafers near the mug curve into it.

## Optional: broken-end crumb puff — `crunch-puff.png`  [no attachment]
> A small loose puff of 8–10 wafer crumbs and two chocolate flakes bursting outward from a centre,
> milk chocolate and golden wafer, arranged in a 300 x 300 px square, transparent.
> Game use: played at the rim with the crunch sound when a wafer goes in.

---

## What is code and already live (no artwork needed)

- Warning ring, blink and twitch on hazards; wafer streaks and 3D shadows; drink rocking in the mug.
- Crunch sound on every catch, layered 70 ms after the plop.
- Missed wafers slow, blink twice and vanish.

Send the two-frame pairs and I wire the cross-fade; send any bonus pair and I build its rule.
