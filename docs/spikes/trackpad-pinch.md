# Spike `trackpad-pinch` — Trackpad pinch as a usable event

**Question:** does trackpad pinch arrive as a usable event on Windows and Linux?

**Answer on Linux: not in JavaScript, yes in Rust.** WebKitGTK never shows the pinch to the page: no `wheel` with `ctrlKey`, no `gesturestart`/`gesturechange`. It zooms the whole page by itself, and `preventDefault` cannot stop it. Catching the GTK touchpad pinch event on the webview widget in Rust works well: it stops WebKitGTK's own zoom and gives a clean begin / update / end sequence with a scale and a center. **Windows was not tested**: no laptop with a trackpad yet.

Date: 2026-11-02 · Code: branch `spike/trackpad-pinch` (not merged, built on `main`)

## Setup

| | Linux |
| --- | --- |
| Device | ASUS VivoBook S530FN, ELAN1300 touchpad |
| System | Ubuntu 24.04, X11 session |
| Webview | WebKitGTK 2.52.6, AppleWebKit 605.1.15 |
| `devicePixelRatio` | 1 |
| Build | `pnpm tauri dev`, debug |

## What the spike does

A page listens to every input event the webview can deliver (`wheel`, `gesturestart`/`gesturechange`/`gestureend`, touch, pointer, keyboard, `visualViewport` resize) with `passive: false`, shows them in a live log and prints them to the terminal through a Tauri command. A test square scales with anything that looks like a pinch and moves with two-finger scroll. A checkbox turns `preventDefault` on and off.

Two runs, the same gestures each time: slow and fast pinch, vertical and horizontal two-finger scroll (slow, then a flick to get inertia), pinch again without `preventDefault`.

1. **JavaScript only:** what WebKitGTK delivers to the page as it is.
2. **With a native adapter:** Rust connects to the `event` signal of the WebKitGTK widget (`WebviewWindow::with_webview`, then `connect_event` on the GTK widget), picks `GdkEventTouchpadPinch`, sends phase, scale, position and finger count to the frontend as a Tauri event, and stops propagation so WebKitGTK does not see it.

## Results

| | Run 1: JavaScript only | Run 2: native adapter |
| --- | --- | --- |
| Pinch events seen by the page | none (0 `gesture*`, 0 `wheel` with `ctrl`) | 4 gestures, 164 updates, scale from 0.38 to 2.49 |
| Page zoom (`visualViewport.scale`) | changes by itself, up to 1.80; 12 resize events | stays at 1.00 |
| `preventDefault` stops the page zoom | no | not needed |
| Update rate during a pinch | — | most updates 0–12 ms apart |
| Two-finger scroll | `wheel`, `deltaMode` 0 | same, unaffected by the adapter |

## Findings

- **WebKitGTK keeps the pinch for itself.** It turns it into page zoom: `visualViewport.scale` and `devicePixelRatio` change together, and the page only hears a `visualViewport` resize, once or twice per gesture and after the fact. It is not enough to drive a zoom, and the browser zoom also breaks the "render at physical resolution" rule by changing `devicePixelRatio` under our feet.
- **The GTK event is exactly what the gesture engine needs.** `GdkEventTouchpadPinch` has a phase (begin, update, end, cancel), a scale relative to the start of the gesture, the center position and the number of fingers. Stopping it in the widget's `event` handler is enough to turn off WebKitGTK's zoom.
- **Two-finger scroll is usable as it is.** It arrives as `wheel` in pixels, in steps of about 0.44 px, with clean axes: in vertical or horizontal scrolls the other axis stays at 0.
- **Inertia is not marked, but it is recognizable.** After a flick, `wheel` events keep coming with a smooth decay, for example from 84 to 0.4 px in about 180 ms. This matches the design's plan of telling inertia from the trend of the deltas.

## Caveats

- **The system decides between pinch and scroll before the app does.** In the first run a slow pinch arrived as 243 small `wheel` events with no zoom: libinput classified it as a two-finger scroll. The adapter cannot change that; only the M2 tests on real gestures will show how often it happens.
- **Only X11 was tested.** Wayland delivers touchpad pinch through the same GDK event, so the adapter should work there too, but it is not verified.
- **Windows was not tested.** The design expects Chromium (WebView2) to deliver the pinch as `wheel` with `ctrlKey`; that is documented behavior, not measured here.
- Times come from WebKit's `performance.now()`, rounded to 1 ms, and timestamps taken in JavaScript after a Tauri event round trip, in a debug build.

## Decision

The design changes. The per-platform input adapter on Linux is partly native: Rust catches touchpad pinch on the GTK webview widget, stops it before WebKitGTK zooms the page, and forwards begin / update / end with scale and center to the gesture engine. Wheel, pointer and keyboard input still come from the webview. The Windows half of the question stays open until a laptop with a trackpad is available.
