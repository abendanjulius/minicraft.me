# Eldercube — design

Status: **design agreed, not implemented.** This describes the endgame the rename
is named after. Nothing in `js/` implements it yet.

Convention: **Eldercube** (one word) is the game. **Elder Cube** (two words) is the
artifact inside it.

---

## 1. Why the name is earned

The game is called Eldercube because finding the Elder Cube is the point of it.
The name is a promise the game keeps, not a mood.

Two facts about the current build made this the right shape:

**There is no endgame.** The achievement list in `js/survival.js` tops out at
*"Motherlode — Mine Crystal Ore in the deep dark."* After that, progression stops.
The Elder Cube fills a slot that is currently empty — it is not a bolt-on.

**The world is a torus.** `wrapC = v => ((v % WORLD) + WORLD) % WORLD`
(`js/world.js:21`) means walking 2048 blocks in any direction returns you to where
you started. Today that is an engine detail. In the fiction it is the mystery:

> The world repeats because the Cube bent it. It isn't a map. It's a cage.

---

## 2. The premise

Before it broke, the entire world was claimed — all 2048² of it, permanently lit,
no horde anywhere. The Cube shattered. The claim decayed, the night flooded back,
and the survivors have been renting light from torches ever since.

Every torch and lantern in the world is a shard of it. That is *why* fire holds the
dark back. The lantern on the home screen is a fragment of the Cube.

You are not conquering the world. You are putting it back.

---

## 3. The power

**The Elder Cube makes light permanent.**

Not brighter. Not more. *Permanent.*

Today light is rented. A torch clears a 10-block bubble (`js/mobs.js:200`); remove
the torch and the dark floods straight back. Everything you make safe you must keep
paying for.

Ground that sits inside the Cube's influence long enough becomes **claimed** —
and claimed ground never spawns a horde again. In pitch dark, with no torch, a year
later, after you have walked away.

|              | Torch                  | Elder Cube (socketed)                     |
| ------------ | ---------------------- | ----------------------------------------- |
| Radius       | 10 blocks              | ~24 blocks                                |
| Duration     | while it exists        | **permanent, after ~20s of contact**      |
| Effect       | suppresses spawning    | removes ground from the spawn table for good |

### The hook

One clause on the existing spawn gate:

```js
// js/mobs.js:200 — today
if (gy > 0 && nearestTorchDist(x, z) > 10) create(x, gy + .5, z);

// with claiming
if (gy > 0 && nearestTorchDist(x, z) > 10 && !claimed(x, z)) create(x, gy + .5, z);
```

### Storage

One bit per column at 4×4 granularity over a 2048² world is a 512×512 grid —
**32 KB for the entire world.** Drops straight into the existing IndexedDB saves.

That grid *is* the map (see §8). No separate map system is needed.

---

## 4. The Keepstone — how claiming starts

The Cube claims **only while socketed.** Carrying it claims nothing.

That is what turns a walking simulator into a game with a rhythm. Dragging a bubble
around is passive; planting a stone and defending it is a **siege** — and sieges are
what the horde code is already built for.

**The Keepstone** is a crafted pedestal — the grown-up version of the Wardens'
*"torch pillars mark safe ground"* (`js/villagers.js`).

Not "anvil" (Minecraft's) and not "waystone" (a well-known Minecraft mod).

- **Recipe:** Crystal Shards (item `122`) + Iron Block + Stone
- **Gated behind** *"Mine Crystal Ore in the deep dark"* — the current final
  achievement becomes the new midgame
- **Keepstones are repeatable. The Cube is not.** You will build dozens. There is one Cube.

### The loop

1. Find the Elder Cube in the deep dark, below the Crystal Ore layer.
2. Craft a Keepstone.
3. Place it where you want the world to be safe.
4. **Tap it with the Cube in hand.** It sockets — sits in the cradle, lit, turning slowly.
5. The claim circle grows outward. ~1 block of radius every few seconds, max ~24.
6. **The horde comes.** Intel tiers rise the whole time it is socketed. This is the siege.
7. The circle maxes out. The Keepstone goes dark and dormant, its work done.
8. Pull the Cube and walk to the next site.

**The claim stays.** The Keepstone you abandon leaves a 24-block disc of world where
the night can never return, forever, with no torch and nobody watching it.

### Why the loop works

| Phase                          | Feeling                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| **Travel** carrying the Cube   | Tense — you are a beacon, you cannot sleep, you have no claim   |
| **Build** the Keepstone        | Preparation. Wall it, light it, choose your ground              |
| **Siege** while it claims      | The hardest fighting in the game                                |
| **Payoff**                     | A permanent disc of safe world, on the map forever              |

The map becomes a growing constellation of overlapping safe discs — each one a night
you survived. A territory, not a snail trail.

### Placing Keepstones near each other

Allowed, but pointless. **A Keepstone only claims ground that is not already claimed**,
so a stone planted beside an existing disc claims a thin crescent for a full siege.
The economics teach spacing better than a rule would, and it is less code than an
arbitrary minimum-distance check.

One guard: **scale siege difficulty off total claimed percentage**, not off the
individual stone — otherwise clustering becomes a way to farm easy sieges.

---

## 5. Carrying the Cube

Carrying it is not neutral. It is actively expensive.

| Effect                     |                                                            |
| -------------------------- | ---------------------------------------------------------- |
| Lights your way            | ✅ real benefit — see in caves without spending torches      |
| Suppresses horde spawning  | ❌ **no. Zero blocks.** Never touches `nearestTorchDist()`   |
| Raises horde intel         | ⚠️ actively worse — packs at `intel>=3`, daywalkers          |
| Blocks sleeping            | ⚠️ every night gets fought, never skipped (`js/content.js`)  |
| Occupies your hands        | ⚠️ no building while carrying                                |

A torch is better protection than the Elder Cube. That is deliberate.

> **The Cube lights your way. It does not protect you.**

**This rule is load-bearing.** If carrying it suppressed spawning comparably to a
torch, nobody would ever socket it — it becomes a super-torch you hold forever, and
the Keepstone loop, the sieges and the map all die with it.

**Tuning knob:** anything *below* torch radius (10) is safe design space. If the
travel phase proves miserable rather than tense, give it a 3–4 block glow — still
strictly worse than a torch, so the loop holds. Ship at zero; only turn this dial if
playtesting demands it.

---

## 6. Losing the Cube

**Never destroy it.** Permanent loss of the title artifact in a sandbox means the
player quits. A setback should cost *time*, not the run.

If you die holding it, it drops — lit, visible from far away — and the horde comes
for it.

**A zombie that picks it up becomes a Bearer:** visibly lit, faster, and it stops
fighting. It *flees* toward the nearest cave mouth. You get a chase.

- Kill the Bearer → the Cube drops.
- The Bearer reaches the deep dark → the Cube goes home, and you go down and find it again.

Flee behaviour already exists to borrow from — `fleeT` on animals (`js/animals.js:42`).

The Cube is the one item in the game with **no despawn timer.**

This is also what finally makes *"Leave No One Behind"* (`js/survival.js:48`) load-bearing.

---

## 7. The four shards

Four village kinds already exist in `js/villagers.js`, each with a personality
already written. One shard each, and how you earn it falls out of who they are:

| Faction          | Their existing line                              | How you get the shard          |
| ---------------- | ------------------------------------------------ | ------------------------------ |
| **Coin Market**  | *"Trade fair, sleep safer."*                     | For sale. Absurdly expensive.  |
| **Dune Outpost** | *"We are Wardens, not villagers. Different oath."* | The oath is **to the Cube**. Earn it. |
| **Log Haven**    | *"We do not deal in coins — only warmth."*       | Gifted, if you help them.      |
| **Stilt Rest**   | *"Thatch holds better secrets than stone."*      | Hidden. You have to find it.   |

The Wardens are the gift here — a faction with a mysterious oath and a doctrine of
*"torch pillars mark safe ground, trust the light"* was written before any of this
existed. Their oath now has an object.

The Cube itself sits below the Crystal Ore layer in the deep dark — the one place
light never won, since caves are permanently night (`js/mobs.js:205`).

---

## 8. The map

Essential, not optional. *"7.3% claimed"* is an abstract number; the emotional payoff
of permanence is **seeing** the territory.

The data structure is already the map: claim state at 4×4 granularity over 2048² is
a 512×512 grid — a canvas image at 1px per cell, drawn directly.

Show on it:

- Claimed regions (warm tint)
- Keepstones — lit = working, dark = done
- Villages, from `villageSites` (`js/world.js:9`)
- Your bed / respawn
- Other players in multiplayer

Claimed ground should also read in-world: a faint warm tint on the top face. Cheap,
since `styleTexture()` in `js/render.js` already does per-face lightening.

---

## 9. Rewards

The intrinsic reward is real — claimed ground is where you can finally build without
walls. But it must compound, because horde intel keeps climbing.

**Primary: villages inside your claim become allies.** Each faction already has
`trades`, `gift` and `lines` arrays, so an allied village just swaps to a better set.
The Coin Market discounts you, the Wardens hand over gear, the Grove Kin feed you,
the Reed Folk tell you where things are. This gives non-combat players a reason to
claim, and reuses structure that already exists.

**Secondary: milestone unlocks** at 1 / 5 / 10 / 25% claimed — cheaper Keepstones,
better lanterns, crystal tooling — plus new achievement entries, since the list
currently has nothing past *"Motherlode."*

---

## 10. Multiplayer

One Cube, many Keepstones, four players in a room. One person carries and sockets;
the others build the walls and hold the line. A genuine co-op objective — rooms
currently have company but no shared goal.

**Hand-off must be first-class** — not "drop it and hope." Fast enough to do at low
health while being chased, so the Bearer can swap when hurt.

> ⚠️ **This is where the known multiplayer trust gap becomes a correctness bug, not
> just a griefing risk.** `js/net.js` currently has the host applying client
> `give`/`edit` messages unchecked. The Cube is a single global object — a client
> could duplicate it and produce two Elder Cubes, which unravels the entire premise.
> **The host must be authoritative on who holds the Cube.** This is the first place
> to spend effort on that backlog item.

---

## 11. Endings

What happens when the Cube is fully restored. These are mechanically different, not
flavour:

- **Keep it lit** — permanent dawn over your region, horde intel climbs forever.
  *The builder's ending — an endless siege.* **Build this first:** it is cheapest
  (intel tiers and light radius already exist — mostly tuning) and the most replayable.
- **Restore it** — put it back, the loop opens, the world stops wrapping and becomes
  endless. *The explorer's ending.* Most striking, but un-wrapping the torus is a real
  engine change. Treat as a later addition, not a launch feature.
- **Break it again** — shatter it into shards for the four villages. Everyone safe,
  nobody powerful. *The social ending.*

---

## 12. Open questions

1. **Can the Cube be pulled mid-claim?** Recommend yes, and the partial circle keeps
   what it earned. Wiping progress would make the siege feel cheap.
2. Exact claim rate, siege escalation curve and Keepstone recipe cost — all need
   playtesting.

---

## 13. Implementation order

Rough ascending cost:

1. Claim bitmap + `claimed(x,z)` + the one-clause spawn gate — *small*
2. Keepstone block, recipe, socket interaction — *small*, `trackSpecial()`
   (`js/render.js:1403`) already exists as the registry for special placed blocks
3. Elder Cube item, deep-dark placement, carry costs — *small*
4. Siege escalation while socketed — *medium*, tuning-heavy
5. Map screen — *small*, the bitmap renders directly
6. Bearer flee behaviour on Cube drop — *medium*
7. Village ally states — *small*, reuses `trades`/`gift`/`lines`
8. Host-authoritative Cube ownership in `net.js` — *medium*, **required before
   multiplayer ships**
9. Four shards / faction quests — *large*
10. Endings — *large*
