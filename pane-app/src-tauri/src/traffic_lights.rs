/// macOS traffic light (window control) positioning.
///
/// The built-in `trafficLightPosition` config gets reset by setTitle, window-state
/// restore, and theme changes. This module re-applies the position reliably using
/// raw Objective-C message sends, triggered on window events.

#[cfg(target_os = "macos")]
use tauri::{Runtime, WebviewWindow};

/// Position relative to window top-left (points, not pixels).
#[cfg(target_os = "macos")]
const PADDING_X: f64 = 24.0;
#[cfg(target_os = "macos")]
const PADDING_Y: f64 = 24.0;
/// Horizontal spacing between buttons.
#[cfg(target_os = "macos")]
const BUTTON_SPACING: f64 = 20.0;

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[cfg(target_os = "macos")]
unsafe impl objc2::Encode for CGPoint {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "CGPoint",
        &[objc2::Encoding::Double, objc2::Encoding::Double],
    );
}

#[cfg(target_os = "macos")]
unsafe impl objc2::Encode for CGSize {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "CGSize",
        &[objc2::Encoding::Double, objc2::Encoding::Double],
    );
}

#[cfg(target_os = "macos")]
unsafe impl objc2::Encode for CGRect {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "CGRect",
        &[CGPoint::ENCODING, CGSize::ENCODING],
    );
}

#[cfg(target_os = "macos")]
unsafe impl objc2::RefEncode for CGPoint {
    const ENCODING_REF: objc2::Encoding = objc2::Encoding::Pointer(&<Self as objc2::Encode>::ENCODING);
}

#[cfg(target_os = "macos")]
unsafe impl objc2::RefEncode for CGSize {
    const ENCODING_REF: objc2::Encoding = objc2::Encoding::Pointer(&<Self as objc2::Encode>::ENCODING);
}

#[cfg(target_os = "macos")]
unsafe impl objc2::RefEncode for CGRect {
    const ENCODING_REF: objc2::Encoding = objc2::Encoding::Pointer(&<Self as objc2::Encode>::ENCODING);
}

#[cfg(target_os = "macos")]
pub fn position_traffic_lights<R: Runtime>(window: &WebviewWindow<R>) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let ns_window = match window.ns_window() {
        Ok(w) => w as *mut AnyObject,
        Err(_) => return,
    };

    unsafe {
        // NSWindowButton values: Close=0, Miniaturize=1, Zoom=2
        let close: *mut AnyObject = msg_send![ns_window, standardWindowButton: 0usize];
        let minimize: *mut AnyObject = msg_send![ns_window, standardWindowButton: 1usize];
        let zoom: *mut AnyObject = msg_send![ns_window, standardWindowButton: 2usize];

        if close.is_null() || minimize.is_null() || zoom.is_null() {
            return;
        }

        // Get the title bar container view (close -> superview -> superview)
        let close_superview: *mut AnyObject = msg_send![close, superview];
        if close_superview.is_null() {
            return;
        }
        let title_bar_view: *mut AnyObject = msg_send![close_superview, superview];
        if title_bar_view.is_null() {
            return;
        }

        let title_bar_frame: CGRect = msg_send![title_bar_view, frame];
        let close_frame: CGRect = msg_send![close, frame];
        let button_height = close_frame.size.height;
        let button_width = close_frame.size.width;

        // Resize the titlebar container to be tall enough for our custom position.
        // This ensures the hit-test area covers the repositioned buttons.
        let needed_height = PADDING_Y + button_height + 4.0;
        if title_bar_frame.size.height < needed_height {
            let new_frame = CGRect {
                origin: CGPoint {
                    x: title_bar_frame.origin.x,
                    y: title_bar_frame.origin.y - (needed_height - title_bar_frame.size.height),
                },
                size: CGSize {
                    width: title_bar_frame.size.width,
                    height: needed_height,
                },
            };
            let _: () = msg_send![title_bar_view, setFrame: new_frame];
        }

        // Also resize the direct parent of buttons (close_superview) to match
        let sv_frame: CGRect = msg_send![close_superview, frame];
        let sv_needed_width = PADDING_X + BUTTON_SPACING * 2.0 + button_width + 4.0;
        let sv_needed_height = PADDING_Y + button_height + 4.0;
        if sv_frame.size.width < sv_needed_width || sv_frame.size.height < sv_needed_height {
            let new_sv_frame = CGRect {
                origin: sv_frame.origin,
                size: CGSize {
                    width: sv_needed_width.max(sv_frame.size.width),
                    height: sv_needed_height.max(sv_frame.size.height),
                },
            };
            let _: () = msg_send![close_superview, setFrame: new_sv_frame];
        }

        // Refetch title bar frame after resize
        let title_bar_frame: CGRect = msg_send![title_bar_view, frame];

        // macOS coordinates: origin is bottom-left, y increases upward
        let y = title_bar_frame.size.height - PADDING_Y - button_height;

        let close_origin = CGPoint { x: PADDING_X, y };
        let minimize_origin = CGPoint { x: PADDING_X + BUTTON_SPACING, y };
        let zoom_origin = CGPoint { x: PADDING_X + BUTTON_SPACING * 2.0, y };

        let _: () = msg_send![close, setFrameOrigin: close_origin];
        let _: () = msg_send![minimize, setFrameOrigin: minimize_origin];
        let _: () = msg_send![zoom, setFrameOrigin: zoom_origin];
    }
}

#[cfg(target_os = "macos")]
pub fn setup<R: Runtime>(window: &WebviewWindow<R>) {
    position_traffic_lights(window);

    // Re-apply on resize/move/theme events (window-state restore and setTitle trigger these)
    let w = window.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Resized { .. }
            | tauri::WindowEvent::Moved { .. }
            | tauri::WindowEvent::ThemeChanged { .. } => {
                position_traffic_lights(&w);
            }
            _ => {}
        }
    });
}
