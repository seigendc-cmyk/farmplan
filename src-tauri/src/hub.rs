//! Wi-Fi hub transport. UNVERIFIED: written without a Rust toolchain available — compile and test on a real machine first.
//!
//! This file is deliberately dumb. It listens on the LAN, parses one HTTP request per connection, hands it to the web view
//! (which owns the SQLite database and every rule: pairing, tokens, permissions, sync) through a Tauri event, and writes back
//! whatever the web view replies. No farm data or business logic lives in Rust.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 8 * 1024 * 1024;
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct Hub {
    running: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
    pending: Arc<Mutex<HashMap<u64, Sender<(u16, String)>>>>,
}

#[derive(Serialize, Clone)]
struct HubRequest { id: u64, method: String, path: String, auth: Option<String>, body: String }

#[derive(Serialize)]
pub struct HubInfo { port: u16, addresses: Vec<String> }

fn lan_ip() -> Option<String> {
    // Connecting a UDP socket sends nothing; it only makes the OS pick the outbound interface.
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("10.255.255.255:1").ok().or_else(|| s.connect("8.8.8.8:80").ok())?;
    Some(s.local_addr().ok()?.ip().to_string())
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let text = match status { 200 => "OK", 204 => "No Content", 400 => "Bad Request", 413 => "Payload Too Large", 504 => "Gateway Timeout", _ => "Status" };
    let head = format!(
        "HTTP/1.1 {status} {text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\
         Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: authorization, content-type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Private-Network: true\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn handle(mut stream: TcpStream, app: AppHandle, hub: (Arc<AtomicU64>, Arc<Mutex<HashMap<u64, Sender<(u16, String)>>>>)) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break p; }
        if buf.len() > MAX_HEADER { return respond(&mut stream, 400, "{\"error\":\"header too large\"}"); }
        match stream.read(&mut chunk) { Ok(0) | Err(_) => return, Ok(n) => buf.extend_from_slice(&chunk[..n]) }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let (method, path) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("/").to_string());
    let mut auth = None; let mut len = 0usize;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() { "authorization" => auth = Some(v.trim().to_string()), "content-length" => len = v.trim().parse().unwrap_or(0), _ => {} }
        }
    }
    if method == "OPTIONS" { return respond(&mut stream, 204, ""); }
    if len > MAX_BODY { return respond(&mut stream, 413, "{\"error\":\"body too large\"}"); }
    let mut body: Vec<u8> = buf[header_end + 4..].to_vec();
    while body.len() < len {
        match stream.read(&mut chunk) { Ok(0) | Err(_) => return respond(&mut stream, 400, "{\"error\":\"incomplete body\"}"), Ok(n) => body.extend_from_slice(&chunk[..n]) }
    }
    body.truncate(len);
    let id = hub.0.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    hub.1.lock().unwrap().insert(id, tx);
    let ev = HubRequest { id, method, path, auth, body: String::from_utf8_lossy(&body).to_string() };
    if app.emit("hub-request", ev).is_err() { hub.1.lock().unwrap().remove(&id); return respond(&mut stream, 504, "{\"error\":\"app not ready\"}"); }
    match rx.recv_timeout(REPLY_TIMEOUT) {
        Ok((status, payload)) => respond(&mut stream, status, &payload),
        Err(_) => { hub.1.lock().unwrap().remove(&id); respond(&mut stream, 504, "{\"error\":\"the office app did not answer in time\"}") }
    }
}

#[tauri::command]
pub fn hub_start(app: AppHandle, hub: State<'_, Hub>, port: u16) -> Result<HubInfo, String> {
    if hub.running.swap(true, Ordering::SeqCst) { return Ok(HubInfo { port, addresses: lan_ip().into_iter().collect() }); }
    let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|e| { hub.running.store(false, Ordering::SeqCst); format!("Could not listen on port {port}: {e}") })?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let (running, ids, pending) = (hub.running.clone(), hub.next_id.clone(), hub.pending.clone());
    thread::spawn(move || {
        while running.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => { let (a, i, p) = (app.clone(), ids.clone(), pending.clone()); thread::spawn(move || handle(stream, a, (i, p))); }
                Err(_) => thread::sleep(Duration::from_millis(100)),
            }
        }
    });
    Ok(HubInfo { port, addresses: lan_ip().into_iter().collect() })
}

#[tauri::command]
pub fn hub_stop(hub: State<'_, Hub>) { hub.running.store(false, Ordering::SeqCst); hub.pending.lock().unwrap().clear(); }

#[tauri::command]
pub fn hub_reply(hub: State<'_, Hub>, id: u64, status: u16, body: String) {
    if let Some(tx) = hub.pending.lock().unwrap().remove(&id) { let _ = tx.send((status, body)); }
}
