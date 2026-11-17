# Unreal lighting for PrepViz — decision record

Status: **Final** — accepted by JD, 2026-11-17 ("approved"). Implementation begins only on a
separate explicit go, one stage at a time (see Staging in the scope contract).

## Goal as stated

"Make sure it's just the light. How can we make sure Unreal's lighting engine is fully optimized?"
Isolate lighting as the remaining variable (geometry, materials, camera already mirror the browser),
then bring the Unreal lighting path to a deliberate, verified optimum for PrepViz.

**Governing principle (JD, 2026-11-17): "Everything needs to be a translation between the two."**
One canonical scene in the shared save; browser and Unreal are each a translation of it into their
renderer. They use the same data to produce the same intended scene and result; Unreal renders that
result at higher quality. Nothing lives on only one side: Unreal-only rendering technology (Lumen, VSM,
SkyAtmosphere) is presentation, recomputed from shared state on demand and never stored as
Unreal-local look state; edits made in Unreal flow back through PrepViz's own scene model so the
browser and other machines pick them up unchanged. Any future feature that cannot be expressed as
a translation of shared state is out of bounds until the shared model grows to hold it.

## Facts established by research (not decisions)

- Three.js lights stream per frame (position, direction, colour, intensity, castShadow, spot angle/penumbra);
  the mirror creates matching UE light components. Shadow-camera fit/bias/map size are **not** streamed.
- Sun shadows were absent because the handheld preset (any non-NVIDIA GPU) sets `sg.ShadowQuality=0`:
  one cascade, 512 px, over a 400 m distance. Fixed 2026-11-17 via host `DefaultScalability.ini`
  (4 cascades / 2048 at low tiers), CSM instead of VSM (`DefaultEngine.ini`), and fitted sun settings
  in the mirror (150 m, bias 0.1, slope bias 0.2, contact shadows 0.08). Magic-hour sun elevation in
  the reported scene is ~3°, where CSM leak at wall bases is worst; contact shadows counter it.
- Ambient/hemisphere light arrives as material collection parameters added to lit materials, not as
  UE lights. Hooked `MeshStandardMaterial`s (most PrepViz surfaces) become `MSM_DefaultLit` generated
  materials fed by the translated pre-lighting shader chunk, so UE lights/shadows them normally.
- Lumen exists in the bridge (F9, registry overrides, effects) but the handheld preset turns it off on
  this Mac (M2 Ultra, vendor 0x106b) along with DLSS; TSR upscaling runs instead.
- The sky is PrepViz's own dome mesh; Unreal has no SkyAtmosphere/SkyLight of its own in this host.
- PrepViz already has user quality levels: `renderQuality` low/medium/high/ultra
  (`state/qualityTier.ts` lever matrix + an adaptive governor that demotes the effective tier).
  JD pointed at these during the interview: they are the natural dial for Unreal's lighting levers.
- Exposure/tonemapping stream from the three renderer (`post.exposure`, `post.toneMapping`) plus bloom.

## Decisions

1. **Fidelity target — SETTLED (2026-11-17): B, exceed the browser.** Unreal is the quality ceiling.
   JD's framing, corrected same day: "Browser is actually Standard" — the browser is the standard
   (full) product/framework, not a lite approximation; Unreal brings that standard to its max.
   Lighting work may therefore use UE-native capability the browser cannot reproduce, and browser
   parity is not a constraint on Unreal-side choices. Working reading (to confirm): the standard
   defines the look's intent; Unreal exceeds in execution fidelity, not in reinterpreted art direction.
   JD, 2026-11-17: "This should not be marketed. This is only backend right now." — the Standard/max
   framing and the Unreal effort itself are internal/backend only; no product naming or marketing
   surfaces come out of this work.
2. **Lighting model — SETTLED (2026-11-17): A, UE-native sun + sky** (SkyAtmosphere + directional sun +
   SkyLight), driven by PrepViz scene settings (time of day, INT/EXT, sun angle). Practical lights
   (spots/points from G&E) stay mirrored from PrepViz in all cases. Follows from decision 1's framing;
   the mapping from PrepViz looks (e.g. Magic Hour, sky presets) to UE sun/sky parameters must be authored.
3. **Global illumination — SETTLED (2026-11-17): A, Lumen GI + reflections.** Replaces the flat
   ambient/hemisphere terms. Implies a desktop tier in the bridge's GPU preset: the current handheld
   preset force-disables Lumen on every non-NVIDIA GPU, including this M2 Ultra (software Lumen there;
   Apple Silicon has no hardware ray tracing).
4. **Shadow technique — SETTLED (2026-11-17): A, Virtual Shadow Maps at full quality** (pairs with
   Lumen; one system for sun + practicals). Known risk to validate: VSM light-bleed through thin walls
   at magic-hour grazing angles; contact shadows stay on as the seam sealer. Today's tuned CSM
   (host `DefaultScalability.ini` cascade overrides + mirror sun fit) is the interim state until VSM lands.
5. **Performance floor — SETTLED (2026-11-17): A, map UE lighting levers onto PrepViz's existing
   quality tiers** (low/medium/high/ultra, streamed over; Ultra = Lumen + VSM full + native sun/sky,
   stepping down through Lumen quality, VSM resolution, render scale; low = no Lumen). Floor: 60 fps
   at the user's chosen tier on desktop-class GPUs (M2 Ultra as reference), with UE-side demotion
   mirroring the browser's adaptive governor. Handheld-class GPUs keep today's lite path.
6. **Scope boundary — SETTLED (2026-11-17): A, PrepViz may change, minimally and additively.**
   PrepViz streams the effective quality tier and the sky/time-of-day preset identity (sun parameters
   already stream as a light record). The browser rendering path is untouched; bridge consumers that
   never send the additions keep today's behaviour.
7. **Validation — SETTLED (2026-11-17): A, golden test scenes + numeric probes + perf gates.**
   Fixed scenes (exterior magic-hour thin-wall set, interior with practicals, midday exterior)
   captured in Unreal per tier; probes assert shadows land and seams stay sealed (sampled points
   inside/outside the computed shadow), no light through walls; ≥60 fps at High on the M2 Ultra at
   85% render scale; goldens diff against the previous approved Unreal captures (not the browser —
   Unreal is meant to differ). JD's eyeball is the final sign-off per scene.

## Scope contract (accepted by JD, 2026-11-17)

**Boundary (in scope):**
- PrepViz (`cine-blocking`): stream effective quality tier + sky/time-of-day preset identity. Additive only.
- Bridge (`js-unreal-bridge`): Runtime records for tier/sky; mirror-side native sun/sky rig
  (SkyAtmosphere, directional sun, SkyLight) driven by streamed settings; Lumen enablement with a
  desktop GPU tier in the preset logic; VSM configuration; tier→lever mapping with UE-side demotion.
- Host (`prepviz-unreal-host`): renderer/shadow config; golden test scenes + capture/probe harness.

**Out of scope:** browser renderer changes; export pipeline; non-lighting mirror work; the cursor,
drag, and IndexedDB-stall tracks already in flight; handheld/Windows perf certification beyond
keeping the existing lite path working; any user-facing naming, product tiers, or marketing —
this is backend work only right now.

**Hard constraint (JD, 2026-11-17): one save point, local-first.** A user can pick up between
Unreal, the browser, and their machines and always land on the same save. That save lives first
on the user's own machine: clients on that machine share the local store without a cloud
round-trip (Unreal must work fully offline against it), and it syncs onward to their other
machines from there. Anything that affects the image (sky preset, sun, tier choice) therefore
lives in that shared local saved state — never in Unreal-local-only state. Unreal is a renderer
of the shared save; per-machine runtime demotion (effective tier, render scale) is not saved
state and may differ.

**Done means (status at implementation, 2026-11-17):**
- [x] Native sun/sky driven by the streamed preset; practicals unchanged. (Stage 2; moon keeps the game's dome.)
- [x] Lumen on at High/Ultra on the M2 Ultra; tiers map and demote; ≥60 fps at High, 85% scale.
  (Stage 4; measured 58–60 fps at Ultra/Lumen-high after warmup; governor needs two bad 2 s
  windows to demote and promotes back — JD's eyeball sign-off per scene still open.)
- [x] VSM enabled; sampled VSM output matched the tuned CSM within 1/255 on the magic-hour exterior.
  The in-harness shadow probe is implemented but currently SKIPs unless a wall and its shadow are
  framed (JD's scene 4 set) — interior premium proof still wants that framed run + JD's eyeball.
- [x] Golden harness in one command (`Tools/lighting-golden.mjs`): status/stream, shadow probe,
  golden diff (verified mean |dL| 0.1–0.2 on re-run), perf gate (median 60 fps at Ultra).
  First golden: `Tests/golden/magic-hour-ultra.png` (uncommitted, like all of this work).
- [x] Bridge unit tests (306) + lint pass; host builds clean; PrepViz streamed-field tests (6) pass.
Nothing outside this checklist is a completion dependency.

**Staging:** implementation returns one stage at a time for its own go/no-go — proposed order:
(1) streaming + tier plumbing, (2) native sun/sky, (3) VSM, (4) Lumen + demotion governor,
(5) goldens + probes. Accepting this record approves none of the stages by itself.

**Risks / unresolved:**
- VSM light-bleed through thin walls at grazing sun (fallback: retain today's tuned CSM path).
- Software Lumen cost on Apple Silicon at full resolution (mitigation: tier levers, 85% scale).
- Sky-preset → UE parameter mapping is art-direction work, not just engineering.
- The ~5-minute IndexedDB autosave stall is a separate track; it will still hitch panning
  until the bridge IDB write path is chunked, independent of lighting.
