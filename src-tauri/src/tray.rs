//! System tray.
//!
//! The menu mirrors two things only the frontend knows: the open sessions and
//! the recently opened items. It is a native menu, so it cannot read React
//! state — the frontend pushes both lists (labels included, so the menu follows
//! the app language) through `sync_tray_menu`, and a click only emits
//! `tray-action` back; App.tsx performs the switch.
//!
//! The icon itself is optional: Settings (`ui.showTray`, default on) and the
//! menu's own "hide tray icon" item both drive `set_tray_visible`. The menu item
//! only asks — the frontend confirms (the window is brought up for the dialog),
//! then persists the setting, and that push is what hides the icon. Hiding does
//! not destroy the menu — only the shell icon — so turning it back on restores
//! the same sessions and recents.

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{
  CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ssh_session::AppState;

use std::sync::atomic::Ordering;

const TRAY_ID: &str = "main";
const TAB_PREFIX: &str = "tab:";
const RECENT_PREFIX: &str = "recent:";

/// One open session row the tray menu switches to.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayTab {
  pub tab_id: u32,
  pub label: String,
  /// Checked in the menu — the session the window is currently showing.
  #[serde(default)]
  pub active: bool,
}

/// One recently opened item: a saved connection's id, or `local:<entryId>` for
/// a local terminal, the same ids `list_recent_connections` returns.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayRecent {
  pub id: String,
  pub label: String,
}

/// Menu captions, translated by the frontend so the tray follows the app language.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
  pub show: String,
  pub hide: String,
  /// Menu item that asks to hide the tray icon itself (re-enabled from Settings).
  pub hide_tray: String,
  pub quit: String,
  pub sessions: String,
  pub recent: String,
  pub no_sessions: String,
  pub no_recent: String,
}

/// What App.tsx needs to know about a menu click.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayAction {
  kind: &'static str,
  #[serde(skip_serializing_if = "Option::is_none")]
  tab_id: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  id: Option<String>,
}

fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

/// `&` is the mnemonic marker in native menus, so an `&` in a session name
/// would otherwise swallow the next character.
fn menu_text(text: &str) -> String {
  text.replace('&', "&&")
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
  // Placeholder until the frontend pushes the real labels on mount; it also
  // keeps the tray usable if the webview never gets that far.
  let menu = MenuBuilder::new(app)
    .text("show", "Show Window")
    .text("hide", "Hide Window")
    .text("hide_tray", "Hide Tray Icon")
    .separator()
    .text("quit", "Quit")
    .build()?;
  let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
  TrayIconBuilder::with_id(TRAY_ID)
    .icon(icon)
    .tooltip("Wrolp Terminal")
    .menu(&menu)
    // Right click opens the menu; left click just brings the window back.
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| handle_menu_event(app, event))
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        show_main_window(tray.app_handle());
      }
    })
    .build(app)?;
  Ok(())
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
  let id = event.id().as_ref();
  match id {
    "show" => show_main_window(app),
    "hide" => {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
      }
    }
    "hide_tray" => {
      // With the icon gone the close button quits from then on, so the frontend
      // asks first: it shows a confirmation (the window comes up so the dialog
      // is never behind a hidden window) and, only on confirm, persists
      // `ui.showTray = false` — that setting push is what actually hides the
      // icon. Cancelling leaves the tray untouched.
      show_main_window(app);
      let _ = app.emit(
        "tray-action",
        TrayAction {
          kind: "hide-tray",
          tab_id: None,
          id: None,
        },
      );
    }
    "quit" => {
      // Never exit straight from the menu: the close button only hides the
      // window, so a click here is the one irreversible action, and quitting
      // takes every live session with it. The frontend asks first and calls
      // `quit_app` only on confirm.
      show_main_window(app);
      let _ = app.emit(
        "tray-action",
        TrayAction {
          kind: "quit",
          tab_id: None,
          id: None,
        },
      );
    }
    _ => {
      let action = if let Some(rest) = id.strip_prefix(TAB_PREFIX) {
        rest.parse::<u32>().ok().map(|tab_id| TrayAction {
          kind: "tab",
          tab_id: Some(tab_id),
          id: None,
        })
      } else {
        id.strip_prefix(RECENT_PREFIX)
          .filter(|rest| !rest.is_empty())
          .map(|rest| TrayAction {
            kind: "recent",
            tab_id: None,
            id: Some(rest.to_string()),
          })
      };
      if let Some(action) = action {
        // The click was meant for a hidden or minimized window: bring it back
        // before the frontend switches, so the result is never invisible.
        show_main_window(app);
        let _ = app.emit("tray-action", action);
      }
    }
  }
}

fn build_menu(
  app: &AppHandle,
  tabs: &[TrayTab],
  recents: &[TrayRecent],
  labels: &TrayLabels,
) -> tauri::Result<Menu<tauri::Wry>> {
  // The items are referenced by the submenu builders, so each list has to be
  // built first and kept alive until its submenu is.
  let session_items = tabs
    .iter()
    .map(|tab| {
      CheckMenuItemBuilder::with_id(format!("{TAB_PREFIX}{}", tab.tab_id), menu_text(&tab.label))
        .checked(tab.active)
        .build(app)
    })
    .collect::<tauri::Result<Vec<_>>>()?;
  let mut sessions = SubmenuBuilder::new(app, menu_text(&labels.sessions));
  if session_items.is_empty() {
    let empty = MenuItemBuilder::new(menu_text(&labels.no_sessions))
      .enabled(false)
      .build(app)?;
    sessions = sessions.item(&empty);
  } else {
    for item in &session_items {
      sessions = sessions.item(item);
    }
  }
  let sessions = sessions.build()?;

  let recent_items = recents
    .iter()
    .map(|recent| {
      MenuItemBuilder::with_id(
        format!("{RECENT_PREFIX}{}", recent.id),
        menu_text(&recent.label),
      )
      .build(app)
    })
    .collect::<tauri::Result<Vec<_>>>()?;
  let mut recent_menu = SubmenuBuilder::new(app, menu_text(&labels.recent));
  if recent_items.is_empty() {
    let empty = MenuItemBuilder::new(menu_text(&labels.no_recent))
      .enabled(false)
      .build(app)?;
    recent_menu = recent_menu.item(&empty);
  } else {
    for item in &recent_items {
      recent_menu = recent_menu.item(item);
    }
  }
  let recent_menu = recent_menu.build()?;

  MenuBuilder::new(app)
    .text("show", menu_text(&labels.show))
    .text("hide", menu_text(&labels.hide))
    .text("hide_tray", menu_text(&labels.hide_tray))
    .separator()
    .item(&sessions)
    .item(&recent_menu)
    .separator()
    .text("quit", menu_text(&labels.quit))
    .build()
}

/// Replace the tray menu with the current session and recent lists.
///
/// Called by App.tsx after every change to either list (and on language
/// change, since the captions arrive with the lists).
#[tauri::command]
pub async fn sync_tray_menu(
  app: AppHandle,
  tabs: Vec<TrayTab>,
  recents: Vec<TrayRecent>,
  labels: TrayLabels,
) -> Result<(), String> {
  let menu = build_menu(&app, &tabs, &recents, &labels).map_err(|e| e.to_string())?;
  match app.tray_by_id(TRAY_ID) {
    // No tray (init failed at startup): nothing to update, and that is not an
    // error the frontend could act on.
    None => Ok(()),
    Some(tray) => tray.set_menu(Some(menu)).map_err(|e| e.to_string()),
  }
}

/// End the process for real.
///
/// With the tray icon shown the window's close button only hides it (the app
/// keeps running in the tray), so this is the one path out of the app from the
/// menu — and the frontend runs it only after the user confirms the tray's
/// Quit, because it takes every live session with it.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
  app.exit(0);
}

/// Show or hide the tray icon, keeping `AppState::tray_visible` in step.
///
/// The icon is hidden with `set_visible`, not destroyed, so the current menu
/// (sessions, recents, captions) survives a hide/show round trip. Called with
/// `false` the window close button quits instead of hiding: without an icon
/// there would be no way to bring a hidden window back.
fn apply_tray_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
  let tray = app
    .tray_by_id(TRAY_ID)
    .ok_or_else(|| "no tray".to_string())?;
  tray.set_visible(visible).map_err(|e| e.to_string())?;
  if let Some(state) = app.try_state::<AppState>() {
    state.tray_visible.store(visible, Ordering::Relaxed);
  }
  Ok(())
}

/// Show or hide the tray icon — the frontend's `ui.showTray` setting (default
/// on), pushed here on mount and on every change. A failed tray init is not an
/// error to the caller: the app simply runs without an icon, and close quits.
#[tauri::command]
pub fn set_tray_visible(app: AppHandle, visible: bool) -> Result<(), String> {
  match apply_tray_visible(&app, visible) {
    Ok(()) => Ok(()),
    Err(e) if e == "no tray" => {
      if let Some(state) = app.try_state::<AppState>() {
        state.tray_visible.store(false, Ordering::Relaxed);
      }
      Ok(())
    }
    Err(e) => Err(e),
  }
}

/// Choose what the window's close button does.
///
/// `true` (the shipped default) parks the app in the tray; `false` lets the
/// close go through and quits. Either way the hide only happens while the tray
/// icon is shown — see `set_tray_visible`. The setting lives in the frontend's
/// `ui.windowCloseAction` (localStorage), which Rust cannot read, so the
/// frontend pushes it here on mount and on every change — the `CloseRequested`
/// handler in `lib.rs` reads `AppState::close_to_tray` at click time.
#[tauri::command]
pub fn set_close_to_tray(state: State<'_, AppState>, close_to_tray: bool) {
  state.close_to_tray.store(close_to_tray, Ordering::Relaxed);
}
