use base64::Engine;
use serde::Serialize;

const MAX_DIM: u32 = 1568;

#[derive(Debug, Clone, Serialize)]
pub struct PreparedImage {
    pub data_b64: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub size: usize,
}

fn encode_best(img: &image::RgbaImage) -> Result<(Vec<u8>, &'static str), String> {
    let has_alpha = img.pixels().any(|p| p.0[3] < 250);
    if has_alpha {
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok((out.into_inner(), "image/png"))
    } else {
        let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
        let mut out = std::io::Cursor::new(Vec::new());
        let enc =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
        rgb.write_with_encoder(enc).map_err(|e| e.to_string())?;
        Ok((out.into_inner(), "image/jpeg"))
    }
}

pub fn prepare_bytes(raw: &[u8]) -> Result<PreparedImage, String> {
    let format = image::guess_format(raw).map_err(|e| format!("unknown image format: {e}"))?;
    let dyn_img = image::load_from_memory_with_format(raw, format)
        .map_err(|e| format!("decode failed: {e}"))?;

    let (w, h) = (dyn_img.width(), dyn_img.height());
    let rgba = if w.max(h) > MAX_DIM {
        let scale = MAX_DIM as f32 / w.max(h) as f32;
        let nw = ((w as f32 * scale) as u32).max(1);
        let nh = ((h as f32 * scale) as u32).max(1);
        dyn_img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
    } else {
        dyn_img
    };

    let flat = rgba.to_rgba8();
    let (bytes, mime) = encode_best(&flat)?;
    let (fw, fh) = flat.dimensions();

    Ok(PreparedImage {
        data_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: mime.to_string(),
        width: fw,
        height: fh,
        size: bytes.len(),
    })
}

pub fn read_image_file(path: &str) -> Result<PreparedImage, String> {
    let raw = std::fs::read(path).map_err(|e| format!("read '{path}': {e}"))?;
    prepare_bytes(&raw)
}

#[cfg(windows)]
pub fn capture_screen() -> Result<PreparedImage, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
    };

    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        if w <= 0 || h <= 0 {
            return Err("invalid screen metrics".into());
        }

        let hdc = GetDC(std::ptr::null_mut());
        if hdc.is_null() {
            return Err("GetDC failed".into());
        }
        let mem = CreateCompatibleDC(hdc);
        let bmp = CreateCompatibleBitmap(hdc, w, h);
        let old = SelectObject(mem, bmp as _);

        let blit_ok = BitBlt(mem, 0, 0, w, h, hdc, 0, 0, SRCCOPY);

        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: std::mem::zeroed(),
        };

        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let got = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            buf.as_mut_ptr() as _,
            &mut bi,
            DIB_RGB_COLORS,
        );

        SelectObject(mem, old);
        DeleteObject(bmp as _);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), hdc);

        if blit_ok == 0 || got == 0 {
            return Err("screen capture failed".into());
        }

        // BGRA -> RGBA
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        let img = match image::RgbaImage::from_raw(w as u32, h as u32, buf) {
            Some(i) => i,
            None => return Err("buffer mismatch".into()),
        };

        // Screenshots have no meaningful alpha; encode as JPEG for size.
        let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
        let mut out = std::io::Cursor::new(Vec::new());
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
        rgb.write_with_encoder(enc).map_err(|e| e.to_string())?;
        let bytes = out.into_inner();

        Ok(PreparedImage {
            data_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            mime: "image/jpeg".to_string(),
            width: w as u32,
            height: h as u32,
            size: bytes.len(),
        })
    }
}

#[cfg(not(windows))]
pub fn capture_screen() -> Result<PreparedImage, String> {
    Err("screenshot is not supported on this platform yet".to_string())
}
