pub mod archive;

/// Spike: prints input events from the webview to the terminal, so a session can be read back.
#[tauri::command]
fn spike_log(line: String) {
    println!("[input] {line}");
}

/// Spike: one GTK touchpad pinch event, forwarded to the webview as the `pinch` event.
#[cfg(target_os = "linux")]
#[derive(Clone, serde::Serialize)]
struct Pinch {
    /// 0 begin, 1 update, 2 end, 3 cancel (`GdkTouchpadGesturePhase`).
    phase: i8,
    /// Scale relative to the start of the gesture.
    scale: f64,
    x: f64,
    y: f64,
    fingers: i8,
}

/// Spike: WebKitGTK handles touchpad pinch itself (page zoom) and never shows it to JavaScript.
/// Catch it on the GTK widget first, stop it there and send it to the frontend instead.
#[cfg(target_os = "linux")]
fn intercept_pinch(app: &tauri::App) {
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
            let (x, y) = pinch.position();
            let _ = handle.emit(
                "pinch",
                Pinch {
                    phase: raw.phase,
                    scale: pinch.scale(),
                    x,
                    y,
                    fingers: pinch.n_fingers(),
                },
            );
            gtk::glib::Propagation::Stop
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            intercept_pinch(_app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![spike_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
