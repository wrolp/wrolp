//! Native "float window" support: a pane popped out of the main window into a
//! real OS window.
//!
//! Why this is not just another `position: fixed` box: terminal output is
//! **polled** (`poll_output(tab)` drains a per-tab buffer), so exactly one webview
//! may own a session's terminal at a time. Moving the pane therefore means the
//! main window hands the session over and stops polling, the float window starts
//! polling, and on close the hand-over happens again in reverse.
//!
//! What travels with the hand-over is the rendered screen (xterm's serialized
//! buffer), because each webview has its own JS heap: `float_scrollback_put` /
//! `float_scrollback_take` carry it across the boundary, so a pop-out and a
//! dock-back both keep the output the user was reading.

use super::*;

/// State shared between the main window and every float window.
#[derive(Default)]
pub struct FloatState {
  /// Serialized xterm screen for a session, written by the window that is about
  /// to let go of it and taken by the one that picks it up.
  scrollback: StdMutex<HashMap<u32, String>>,
  /// Which session each float window shows, so its destruction can tell the main
  /// window which pane to take back.
  windows: StdMutex<HashMap<String, u32>>,
  /// What the main window knows about the session that the float window cannot
  /// read for itself: the tab's type, its connection fields (so "Reconnect" can
  /// re-open the same host) and the local-shell parameters. JSON, because the
  /// shape belongs to the frontend and nothing here interprets it.
  contexts: StdMutex<HashMap<u32, String>>,
}

/// Payload of `float-window-closed`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatClosed {
  /// The window label, which is also the float id the panel tracks.
  pub label: String,
  /// Session the window was showing, when known.
  pub tab_id: Option<u32>,
}

/// Hand a session's serialized screen to whichever window picks it up next.
#[tauri::command]
pub fn float_scrollback_put(state: tauri::State<'_, FloatState>, tab_id: u32, data: String) {
  if data.is_empty() {
    return;
  }
  if let Ok(mut map) = state.scrollback.lock() {
    map.insert(tab_id, data);
  }
}

/// Take (and forget) the serialized screen for `tab_id`, if one was left behind.
#[tauri::command]
pub fn float_scrollback_take(state: tauri::State<'_, FloatState>, tab_id: u32) -> Option<String> {
  state.scrollback.lock().ok()?.remove(&tab_id)
}

/// Leave the tab's context (type, connection fields, local-shell parameters) for
/// its float window. Without it the window can show the terminal but not offer
/// "Reconnect" — the connection details live in the main window's state only.
#[tauri::command]
pub fn float_context_put(state: tauri::State<'_, FloatState>, tab_id: u32, data: String) {
  if data.is_empty() {
    return;
  }
  if let Ok(mut map) = state.contexts.lock() {
    map.insert(tab_id, data);
  }
}

/// Take (and forget) that context, when the float window boots.
#[tauri::command]
pub fn float_context_take(state: tauri::State<'_, FloatState>, tab_id: u32) -> Option<String> {
  state.contexts.lock().ok()?.remove(&tab_id)
}

/// Open a float window showing the terminal for `tab_id`.
///
/// The window loads the same app bundle with `?float=terminal&tab=<id>`, so it
/// shares the origin's `localStorage` (theme, i18n, terminal appearance) and can
/// use every command the main window uses. Re-opening an existing label only
/// focuses it: a session must never be shown by two windows.
#[tauri::command]
pub async fn open_float_window(
  app: tauri::AppHandle,
  state: tauri::State<'_, FloatState>,
  label: String,
  title: String,
  tab_id: u32,
  width: f64,
  height: f64,
) -> Result<(), String> {
  if let Some(existing) = app.get_webview_window(&label) {
    let _ = existing.set_focus();
    return Ok(());
  }

  let query = format!("index.html?float=terminal&tab={tab_id}&label={label}");
  let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(query.into()))
    .title(title)
    .inner_size(width.max(360.0), height.max(220.0))
    .min_inner_size(320.0, 180.0)
    // Same chrome as the main window: the app draws its own titlebar
    // (`Titlebar.tsx`), so the OS one would double up — and it would look like a
    // different application next to the main window.
    .decorations(false)
    .build()
    .map_err(|e| format!("failed to open float window: {e}"))?;

  if let Ok(mut map) = state.windows.lock() {
    map.insert(label.clone(), tab_id);
  }

  // Tell the main window to take the pane back. `Destroyed` rather than `Close`:
  // the float window serializes its buffer first and only then destroys itself,
  // so by the time this fires the hand-over payload is already on its way.
  let app_for_event = app.clone();
  let label_for_event = label.clone();
  window.on_window_event(move |event| {
    if !matches!(event, tauri::WindowEvent::Destroyed) {
      return;
    }
    let tab_id = app_for_event
      .try_state::<FloatState>()
      .and_then(|state| state.windows.lock().ok()?.remove(&label_for_event));
    let _ = app_for_event.emit(
      "float-window-closed",
      FloatClosed {
        label: label_for_event.clone(),
        tab_id,
      },
    );
  });

  let _ = window.show();
  Ok(())
}

/// Bring the main window forward.
///
/// The float window is a terminal, not a second app: the AI panel, the inspector
/// and the recordings list live in the main window, so its "AI" button means
/// "show me that panel" rather than a second copy of it.
#[tauri::command]
pub fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
  let window = app
    .get_webview_window("main")
    .ok_or_else(|| "the main window is gone".to_string())?;
  let _ = window.unminimize();
  window
    .set_focus()
    .map_err(|e| format!("failed to focus the main window: {e}"))
}

/// Destroy a float window from the main window (its session went away).
#[tauri::command]
pub fn close_float_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
  match app.get_webview_window(&label) {
    Some(window) => window
      .destroy()
      .map_err(|e| format!("failed to close float window: {e}")),
    None => Ok(()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_handover_payload_keeps_its_shape_for_the_frontend() {
    let payload = FloatClosed {
      label: "float-42".to_string(),
      tab_id: Some(7),
    };
    let json = serde_json::to_string(&payload).unwrap();
    assert_eq!(json, r#"{"label":"float-42","tabId":7}"#);
    // A window whose session is unknown still reports the label, so the pane
    // can be restored even if the tab list moved on.
    let orphan = FloatClosed {
      label: "float-43".to_string(),
      tab_id: None,
    };
    assert_eq!(
      serde_json::to_string(&orphan).unwrap(),
      r#"{"label":"float-43","tabId":null}"#
    );
  }
}
