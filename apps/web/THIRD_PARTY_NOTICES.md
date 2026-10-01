# Third-party notices

## Site frame

The site foundation adapts the App Router layout, fixed site frame, floating
navigation, Lenis integration, Motion primitives, reduced-motion handling,
metadata helpers, and responsive conventions from
[DavidHDev/rbp-portfolio](https://github.com/DavidHDev/rbp-portfolio), reviewed
at commit `1581b9b8e5876f60e5eb844970747506980c4412`.

Portfolio-specific copy, portraits, About/Projects/Contact sections, external
portfolio imagery, Matter.js physics, and that portfolio's OGL shader are not
part of this site. The React Bits Scroll Expand and Gradient Waves adaptations
are not included.

## Manrope

Manrope is self-hosted through `@fontsource-variable/manrope`.

Copyright 2019 The Manrope Project Authors.

Licensed under the SIL Open Font License, Version 1.1. The license text ships
with the installed font package.

## Geist

Geist Sans and Geist Mono are vendored under `fonts/` from the Geist project,
under the SIL Open Font License. `fonts/OFL.txt` is the license text.

## React Bits

Adapted from [React Bits](https://www.reactbits.dev) (MIT + Commons Clause):

- Prompt Bar and Lattice Loader (TS + CSS), source commit
  `e1bbb696fc53f7f91e694c529e4d68c899773b6e`, adapted in
  `components/react-bits/prompt-bar.tsx` and `lattice-loader.tsx`.
- Pattern Waves (TS + CSS), the registry item
  `https://reactbits.dev/r/PatternWaves-TS-CSS.json` fetched 2026-09-30,
  vendored in `components/react-bits/pattern-waves.tsx` with type-only edits.

## OGL

Pattern Waves renders with [`ogl`](https://github.com/oframe/ogl) 1.0.11,
released under the Unlicense (public domain).
