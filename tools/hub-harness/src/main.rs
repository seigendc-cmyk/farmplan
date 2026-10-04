mod hub; mod stub;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{mpsc::channel, Arc, Mutex};
fn req(raw: &str) -> String { let mut s = TcpStream::connect("127.0.0.1:17878").unwrap(); s.write_all(raw.as_bytes()).unwrap(); let mut o = String::new(); s.read_to_string(&mut o).unwrap(); o }
fn main() {
    let h = Arc::new(hub::Hub::default()); let (tx, rx) = channel(); let app = stub::AppHandle { tx: Arc::new(Mutex::new(tx)) };
    hub::hub_start(app, stub::State(&*h), 17878).unwrap();
    // the "web view": answers every event with {echo}
    let h2 = h.clone(); std::thread::spawn(move || { for m in rx { let v: serde_json::Value = serde_json::from_str(&m).unwrap(); let id = v["id"].as_u64().unwrap();
        let body = serde_json::json!({"method": v["method"], "path": v["path"], "auth": v["auth"], "body": v["body"]}).to_string(); hub::hub_reply(stub::State(&*h2), id, if v["path"] == "/missing" { 422 } else { 200 }, body); } });
    let o = req("OPTIONS /push HTTP/1.1\r\nHost: x\r\nOrigin: http://tauri.localhost\r\n\r\n"); assert!(o.starts_with("HTTP/1.1 204"), "{o}"); assert!(o.contains("Access-Control-Allow-Private-Network: true") && o.contains("Access-Control-Allow-Origin: *"), "{o}");
    let g = req("GET /pull?table=fields&since=0 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer abc\r\n\r\n"); assert!(g.starts_with("HTTP/1.1 200"), "{g}"); assert!(g.contains("\"path\":\"/pull?table=fields&since=0\"") && g.contains("\"auth\":\"Bearer abc\""), "{g}");
    let body = "{\"table\":\"x\",\"rows\":[\"é\"]}"; let p = req(&format!("POST /push HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", body.len(), body)); assert!(p.contains("\\\"table\\\":\\\"x\\\""), "{p}");
    let big = "a".repeat(300_000); let b = req(&format!("POST /push HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}", big.len(), big)); assert!(b.len() > 300_000 && b.contains(&big), "large body split across reads");
    assert!(req("POST /missing HTTP/1.1\r\nContent-Length: 0\r\n\r\n").starts_with("HTTP/1.1 422"));
    assert!(req("POST /push HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n").starts_with("HTTP/1.1 413"));
    assert!(req("garbage\r\n\r\n").starts_with("HTTP/1.1")); 
    hub::hub_stop(stub::State(&*h)); println!("RUST HUB TRANSPORT OK");
}
