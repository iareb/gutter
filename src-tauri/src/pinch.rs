//! Touchpad pinch on Linux. WebKitGTK handles the gesture itself (it zooms the
//! whole page) and never shows it to JavaScript, so the webview widget's GTK
//! events are read here, the pinch is stopped before WebKitGTK sees it and sent
//! to the frontend as the `pinch` event. See docs/spikes/trackpad-pinch.md.
//! The other webviews report a pinch to the page by themselves.

use serde::Serialize;

/// One step of a pinch, as the frontend's `PinchInput` expects it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Pinch {
    pub phase: &'static str,
    /// Relative to the start of the pinch: 1 at the start.
    pub scale: f64,
    /// Position in the window, in CSS pixels.
    pub x: f64,
    pub y: f64,
}

/// The name of a `GdkTouchpadGesturePhase`: 0 begin, 1 update, 2 end, 3 cancel.
pub fn phase_name(phase: i8) -> Option<&'static str> {
    match phase {
        0 => Some("begin"),
        1 => Some("update"),
        2 => Some("end"),
        3 => Some("cancel"),
        _ => None,
    }
}

/// Forwards touchpad pinches on the main window to the frontend. Does nothing
/// if the window or the GTK widget cannot be reached.
#[cfg(target_os = "linux")]
pub fn forward(app: &tauri::App) {
    use gtk::prelude::*;
    use tauri::{Emitter, Manager};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.handle().clone();
    let _ = window.with_webview(move |webview| {
        webview.inner().connect_event(move |_, event| {
            if event.event_type() != gtk::gdk::EventType::TouchpadPinch {
                return gtk::glib::Propagation::Proceed;
            }
            let Some(pinch) = event.downcast_ref::<gtk::gdk::EventTouchpadPinch>() else {
                return gtk::glib::Propagation::Proceed;
            };
            let raw: &gtk::gdk::ffi::GdkEventTouchpadPinch = pinch.as_ref();
            if let Some(phase) = phase_name(raw.phase) {
                let (x, y) = pinch.position();
                let scale = pinch.scale();
                let _ = handle.emit("pinch", Pinch { phase, scale, x, y });
            }
            // Always stopped: WebKitGTK would zoom the whole page
            gtk::glib::Propagation::Stop
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_gtk_phases() {
        let names: Vec<_> = (0..4).filter_map(phase_name).collect();
        assert_eq!(names, ["begin", "update", "end", "cancel"]);
        assert_eq!(phase_name(4), None);
        assert_eq!(phase_name(-1), None);
    }

    #[test]
    fn serializes_as_the_frontend_expects() {
        let pinch = Pinch {
            phase: "update",
            scale: 1.5,
            x: 10.0,
            y: 20.0,
        };
        let json = serde_json::to_string(&pinch).unwrap();
        assert_eq!(json, r#"{"phase":"update","scale":1.5,"x":10.0,"y":20.0}"#);
    }
}
