// Drag-and-drop for the WebView2 content via WebView2's own navigation events.
//
// A plain Win32 `IDropTarget` cannot work here: the web content is rendered in
// windows owned by the WebView2 *browser* process, and OLE drop events are
// dispatched on the window's owning thread — a target registered from our host
// process on those windows is never invoked (and OLE does not walk up the
// parent chain). So instead we:
//
// 1. Keep `dragDropEnabled: false` in tauri.conf.json so wry never installs its
//    handler and WebView2 keeps its default "external drops enabled" behaviour.
//    The page then receives normal HTML5 drag/drop events (used for cursor
//    feedback and the drop target position).
// 2. On drop the page deliberately does NOT call `preventDefault()`, so the
//    browser performs its default action for a file drop: navigating to (or
//    opening) the dropped file/folder. That fires `NavigationStarting` /
//    `NewWindowRequested` with a `file://` URI carrying the real local path.
// 3. We intercept those events, cancel the navigation, extract the path and
//    emit a `native-drag-drop` event so the frontend can hand it to the Rust
//    `walkdir` streaming upload (same code path as the Upload folder button).

#![cfg(windows)]

use std::sync::Mutex;

use tauri::AppHandle;
use tauri::Emitter;
use webview2_com::Microsoft::Web::WebView2::Win32::{
  ICoreWebView2, ICoreWebView2NavigationStartingEventArgs, ICoreWebView2NewWindowRequestedEventArgs,
};
use webview2_com::{take_pwstr, NavigationStartingEventHandler, NewWindowRequestedEventHandler};

/// Keep the COM event handlers alive for the lifetime of the process. (WebView2
/// also holds a reference internally, but this guards against any re-creation.)
/// Stored as raw pointer integers because `*mut c_void` is not `Send`.
static KEEP_ALIVE: Mutex<Vec<usize>> = Mutex::new(Vec::new());

fn keep(ptr: *mut core::ffi::c_void) {
  if let Ok(mut v) = KEEP_ALIVE.lock() {
    v.push(ptr as usize);
  }
}

/// Decode `%XX` escapes (the URI from WebView2 is percent-encoded).
fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      let hi = (bytes[i + 1] as char).to_digit(16);
      let lo = (bytes[i + 2] as char).to_digit(16);
      if let (Some(h), Some(l)) = (hi, lo) {
        out.push((h * 16 + l) as u8);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

/// Convert a `file:///C:/path/...` URI into a local Windows path, or `None`.
fn file_uri_to_path(uri: &str) -> Option<String> {
  let rest = uri.strip_prefix("file://")?;
  let rest = rest.trim_start_matches('/');
  if rest.is_empty() {
    return None;
  }
  Some(percent_decode(rest).replace('/', "\\"))
}

fn read_nav_uri(args: &ICoreWebView2NavigationStartingEventArgs) -> Option<String> {
  let mut uri = windows::core::PWSTR::null();
  unsafe { args.Uri(&mut uri) }.ok()?;
  Some(take_pwstr(uri))
}

fn read_nw_uri(args: &ICoreWebView2NewWindowRequestedEventArgs) -> Option<String> {
  let mut uri = windows::core::PWSTR::null();
  unsafe { args.Uri(&mut uri) }.ok()?;
  Some(take_pwstr(uri))
}

/// Register the drop interception on the webview. `platform` is the platform
/// webview handle handed to `WebviewWindow::with_webview`.
pub fn init(app: &AppHandle, platform: tauri::webview::PlatformWebview) {
  let controller = platform.controller();
  let core = match unsafe { controller.CoreWebView2() } {
    Ok(c) => c,
    Err(e) => {
      eprintln!("[drop] failed to get core webview: {}", e);
      return;
    }
  };

  // A dropped file can navigate the *same* webview — cancel the navigation and
  // hand the path to the frontend.
  let app_nav = app.clone();
  let nav_handler = NavigationStartingEventHandler::create(Box::new(
    move |_sender: Option<ICoreWebView2>, args: Option<ICoreWebView2NavigationStartingEventArgs>| {
      if let Some(args) = args {
        if let Some(uri) = read_nav_uri(&args) {
          if let Some(path) = file_uri_to_path(&uri) {
            eprintln!("[drop] NavigationStarting file:// -> {}", path);
            let _ = unsafe { args.SetCancel(true) };
            emit_drop(&app_nav, path);
          }
        }
      }
      Ok(())
    },
  ));
  match unsafe { core.add_NavigationStarting(&nav_handler, &mut 0i64) } {
    Ok(()) => eprintln!("[drop] NavigationStarting handler registered"),
    Err(e) => eprintln!("[drop] add_NavigationStarting failed: {}", e),
  }
  keep(windows::core::Interface::into_raw(nav_handler));

  // WebView2 may also open the dropped item in a new window — intercept it.
  let app_nw = app.clone();
  let nw_handler = NewWindowRequestedEventHandler::create(Box::new(
    move |_sender: Option<ICoreWebView2>, args: Option<ICoreWebView2NewWindowRequestedEventArgs>| {
      if let Some(args) = args {
        if let Some(uri) = read_nw_uri(&args) {
          if let Some(path) = file_uri_to_path(&uri) {
            eprintln!("[drop] NewWindowRequested file:// -> {}", path);
            let _ = unsafe { args.SetHandled(true) };
            emit_drop(&app_nw, path);
          }
        }
      }
      Ok(())
    },
  ));
  match unsafe { core.add_NewWindowRequested(&nw_handler, &mut 0i64) } {
    Ok(()) => eprintln!("[drop] NewWindowRequested handler registered"),
    Err(e) => eprintln!("[drop] add_NewWindowRequested failed: {}", e),
  }
  keep(windows::core::Interface::into_raw(nw_handler));
}

#[derive(Clone, serde::Serialize)]
struct NativeDropEvent {
  #[serde(rename = "type")]
  event_type: &'static str,
  paths: Vec<String>,
  position: NativeDropPosition,
}

#[derive(Clone, serde::Serialize)]
struct NativeDropPosition {
  x: i32,
  y: i32,
}

fn emit_drop(app: &AppHandle, path: String) {
  let _ = app.emit(
    "native-drag-drop",
    NativeDropEvent {
      event_type: "drop",
      paths: vec![path],
      position: NativeDropPosition { x: 0, y: 0 },
    },
  );
}
