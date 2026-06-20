//! Standalone russh SSH test — no Tauri dependency, prints shell output to stdout
//! Run: execute cargo run --bin ssh_test in src-tauri directory
//! Usage: enter host, username, password as prompted

use russh::client::{self, Handler};
use russh::ChannelId;
use std::io::{self, Write};
use std::sync::Arc;
use tokio::io::AsyncReadExt;

#[derive(Debug)]
struct SshError(String);

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for SshError {}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self { SshError(e.to_string()) }
}
impl From<String> for SshError {
    fn from(s: String) -> Self { SshError(s) }
}

struct TestHandler;

#[async_trait::async_trait]
impl Handler for TestHandler {
    type Error = SshError;

    async fn check_server_key(&mut self, _key: &russh_keys::key::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn data(&mut self, _channel: ChannelId, data: &[u8], _session: &mut russh::client::Session) -> Result<(), Self::Error> {
        eprintln!("[test handler] {} bytes received", data.len());
        // Print directly to stdout
        let mut stdout = io::stdout();
        let _ = stdout.write_all(data);
        let _ = stdout.flush();
        Ok(())
    }

    async fn extended_data(&mut self, _channel: ChannelId, _code: u32, data: &[u8], _session: &mut russh::client::Session) -> Result<(), Self::Error> {
        let mut stdout = io::stdout();
        let _ = stdout.write_all(data);
        let _ = stdout.flush();
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    eprintln!("=== Standalone russh SSH Test ===");

    // Read connection info from CLI args or env vars
    let args: Vec<String> = std::env::args().collect();
    let (host, username, password) = if args.len() >= 4 {
        (args[1].clone(), args[2].clone(), args[3].clone())
    } else {
        // Interactive input
        let mut input = String::new();
        print!("Host: "); io::stdout().flush().unwrap();
        io::stdin().read_line(&mut input).unwrap();
        let host = input.trim().to_string();
        input.clear();
        print!("Username: "); io::stdout().flush().unwrap();
        io::stdin().read_line(&mut input).unwrap();
        let username = input.trim().to_string();
        input.clear();
        print!("Password: "); io::stdout().flush().unwrap();
        io::stdin().read_line(&mut input).unwrap();
        let password = input.trim().to_string();
        (host, username, password)
    };

    eprintln!("Connecting to {} as {} ...", host, username);

    let config = Arc::new(client::Config::default());
    let handler = TestHandler;
    let mut handle = match client::connect(config, (host.as_str(), 22), handler).await {
        Ok(h) => { eprintln!("SSH handshake OK"); h }
        Err(e) => { eprintln!("Handshake error: {:?}", e); return; }
    };

    eprintln!("Authenticating with password...");
    match handle.authenticate_password(&username, &password).await {
        Ok(true) => eprintln!("Authentication OK"),
        Ok(false) => { eprintln!("Wrong password!"); return; }
        Err(e) => { eprintln!("Auth error: {:?}", e); return; }
    }

    eprintln!("Opening channel...");
    let channel = match handle.channel_open_session().await {
        Ok(ch) => { eprintln!("Channel opened"); ch }
        Err(e) => { eprintln!("Channel error: {:?}", e); return; }
    };

    eprintln!("Requesting PTY...");
    if let Err(e) = channel.request_pty(true, "xterm-256color", 80, 24, 0, 0, &[]).await {
        eprintln!("PTY error: {:?}", e); return;
    }
    eprintln!("PTY allocated");

    eprintln!("Requesting shell...");
    if let Err(e) = channel.request_shell(true).await {
        eprintln!("Shell error: {:?}", e); return;
    }
    eprintln!("Shell started. Waiting for data...");

    // Read stdin and forward to SSH channel
    let (mut stdin_rx, stdin_tx_shutdown) = {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let mut stdin_handle = tokio::io::stdin();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            loop {
                tokio::select! {
                    result = stdin_handle.read(&mut buf) => {
                        match result {
                            Ok(0) => break,
                            Ok(n) => { let _ = tx.send(buf[..n].to_vec()); }
                            Err(_) => break,
                        }
                    }
                    _ = &mut shutdown_rx => break,
                }
            }
        });
        (rx, shutdown_tx)
    };

    loop {
        tokio::select! {
            Some(data) = stdin_rx.recv() => {
                if let Err(e) = channel.data(data.as_slice()).await {
                    eprintln!("Write error: {:?}", e);
                    break;
                }
            }
            else => {
                eprintln!("stdin closed");
                break;
            }
        }
    }

    let _ = stdin_tx_shutdown.send(());
    eprintln!("Test completed");
}
