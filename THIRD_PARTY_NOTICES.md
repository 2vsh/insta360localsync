# Third-party notices

The INSV V3/V6 calibration layout, lens ordering, and omnidirectional distortion
equations in `lib/stitch.mjs` were informed by and adapted from
[insta360-rs 0.2.0](https://crates.io/crates/insta360-rs/0.2.0), particularly
`src-rust/container.rs`, `calibration.rs`, and `stitch.rs`.

Copyright 2026, Underwater Speleological and Archaeological Heritage Institute.
Licensed under the Apache License, Version 2.0. The license and original copyright
notice are included in [licenses/insta360-rs-APACHE-2.0.txt](licenses/insta360-rs-APACHE-2.0.txt).

This project implements the supported math in JavaScript and uses FFmpeg remap
and mask filters. It does not bundle the Rust package, its data packages, vendor
SDK code, models, or other vendor assets. Neither project is affiliated with or
endorsed by Insta360. Insta360 is a trademark of its respective owner.
