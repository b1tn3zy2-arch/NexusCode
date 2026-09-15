use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;

fn main() {
    void_check();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    #[cfg(target_os = "windows")]
    let cmd = {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/C");
        c.arg("echo PTY_OK");
        c
    };

    #[cfg(not(target_os = "windows"))]
    let cmd = {
        let mut c = CommandBuilder::new("sh");
        c.arg("-c");
        c.arg("echo PTY_OK");
        c
    };

    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut buf = vec![0u8; 4096];
    let mut total = String::new();
    for _ in 0..20 {
        let n = reader.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        total.push_str(&String::from_utf8_lossy(&buf[..n]));
        if total.contains("PTY_OK") {
            break;
        }
    }

    let _ = child.wait();

    if total.contains("PTY_OK") {
        println!("OK pty roundtrip works ({} bytes)", total.len());
    } else {
        eprintln!("FAIL: marker not seen; got: {total:?}");
        std::process::exit(1);
    }
}

fn void_check() {
    let _ = base64::engine::general_purpose::STANDARD.decode("");
}
