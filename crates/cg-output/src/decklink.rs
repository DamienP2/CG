//! Bindings to the DeckLink shim (`decklink/shim.cpp`, built by build.rs).
//!
//! The shim is compiled in when the `decklink` feature is on and the target
//! can build it (`cfg(decklink_shim)`); otherwise every entry point reports
//! that DeckLink support is not built in. The DeckLink runtime (Blackmagic
//! Desktop Video) is loaded at run time: without it, listing devices or
//! opening one fails with [`NO_RUNTIME`], the server keeps running.

use std::time::Duration;

/// This build carries the DeckLink shim.
pub const BUILT: bool = cfg!(decklink_shim);

pub const NOT_BUILT: &str = "DeckLink support is not built into this server (`decklink` feature)";
pub const NO_RUNTIME: &str = "Blackmagic Desktop Video is not installed (no DeckLink driver)";

/// `BMDFieldDominance` values.
pub const FIELD_PROGRESSIVE: u32 = u32::from_be_bytes(*b"prog");
pub const FIELD_PSF: u32 = u32::from_be_bytes(*b"psf ");

/// A display mode of a device (`IDeckLinkDisplayMode`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayMode {
    /// `BMDDisplayMode`.
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Frame duration in `timescale` units (`GetFrameRate`).
    pub duration: i64,
    pub timescale: i64,
    /// `BMDFieldDominance`.
    pub field: u32,
}

impl DisplayMode {
    pub fn fps(&self) -> f64 {
        if self.duration <= 0 {
            0.0
        } else {
            self.timescale as f64 / self.duration as f64
        }
    }

    /// Same picture size and frame rate (29.97 = 30000/1001 ≈ 2997/100).
    pub fn matches(&self, width: u32, height: u32, rate: (u32, u32)) -> bool {
        if self.width != width || self.height != height || rate.0 == 0 || rate.1 == 0 {
            return false;
        }
        let want = rate.0 as f64 / rate.1 as f64;
        ((self.fps() - want) / want).abs() < 1e-4
    }
}

/// The modes matching a channel format, best first: progressive, then
/// progressive segmented frame, then interlaced (same frame rate).
pub fn candidates(
    modes: &[DisplayMode],
    width: u32,
    height: u32,
    rate: (u32, u32),
) -> Vec<&DisplayMode> {
    let mut m: Vec<&DisplayMode> = modes
        .iter()
        .filter(|m| m.matches(width, height, rate))
        .collect();
    m.sort_by_key(|m| match m.field {
        FIELD_PROGRESSIVE => 0,
        FIELD_PSF => 1,
        _ => 2,
    });
    m
}

/// "1920x1080 @ 25" for messages.
pub fn format_name(width: u32, height: u32, rate: (u32, u32)) -> String {
    let fps = rate.0 as f64 / rate.1.max(1) as f64;
    format!("{width}x{height} @ {}", (fps * 100.0).round() / 100.0)
}

/// Keyer of an output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keyer {
    /// Fill only.
    None = 0,
    /// The card keys the fill over its own SDI input.
    Internal = 1,
    /// Fill and key on two SDI outputs.
    External = 2,
}

/// What a device can do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Caps {
    pub output: bool,
    pub input: bool,
    pub internal_keyer: bool,
    pub external_keyer: bool,
    pub format_detection: bool,
}

/// Outcome of a push.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pushed {
    Queued,
    /// The output already holds enough frames (the producer runs ahead).
    Dropped,
    Failed,
}

#[cfg(decklink_shim)]
mod ffi {
    use std::ffi::{c_char, c_int, c_void};

    #[repr(C)]
    pub struct RawMode {
        pub id: u32,
        pub width: i32,
        pub height: i32,
        pub field_dominance: i32,
        pub duration: i64,
        pub timescale: i64,
        pub name: [c_char; 64],
    }

    extern "C" {
        pub fn dl_device_count() -> c_int;
        pub fn dl_device_name(index: c_int, buf: *mut c_char, len: c_int) -> c_int;
        pub fn dl_device_caps(index: c_int) -> c_int;
        pub fn dl_device_modes(
            index: c_int,
            input: c_int,
            out: *mut RawMode,
            cap: c_int,
            err: *mut c_char,
            errlen: c_int,
        ) -> c_int;
        pub fn dl_output_open(
            index: c_int,
            mode: u32,
            width: c_int,
            height: c_int,
            keyer: c_int,
            err: *mut c_char,
            errlen: c_int,
        ) -> *mut c_void;
        pub fn dl_output_push(h: *mut c_void, bgra: *const u8, stride: c_int) -> c_int;
        pub fn dl_output_wait(h: *mut c_void, timeout_ms: c_int, frames: *mut u64) -> c_int;
        pub fn dl_reference_locked(h: *mut c_void) -> c_int;
        pub fn dl_output_close(h: *mut c_void);
        pub fn dl_input_open(
            index: c_int,
            mode: u32,
            err: *mut c_char,
            errlen: c_int,
        ) -> *mut c_void;
        pub fn dl_input_take(
            h: *mut c_void,
            out: *mut u8,
            cap: i64,
            width: *mut c_int,
            height: *mut c_int,
            seq: *mut u64,
        ) -> i64;
        pub fn dl_input_signal(h: *mut c_void) -> c_int;
        pub fn dl_input_close(h: *mut c_void);
    }

    /// A NUL-terminated C buffer as text.
    pub fn text(buf: &[c_char]) -> String {
        let bytes: Vec<u8> = buf
            .iter()
            .take_while(|&&c| c != 0)
            .map(|&c| c as u8)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[cfg(decklink_shim)]
fn index(device: u32) -> Result<std::ffi::c_int, String> {
    std::ffi::c_int::try_from(device).map_err(|_| format!("no DeckLink device #{device}"))
}

/// Names of the DeckLink devices, in Desktop Video order (the index is the
/// `device` of the settings).
pub fn devices() -> Result<Vec<String>, String> {
    #[cfg(decklink_shim)]
    {
        // SAFETY: plain calls into the shim; buffers sized as passed.
        let n = unsafe { ffi::dl_device_count() };
        if n < 0 {
            return Err(NO_RUNTIME.into());
        }
        let mut names = Vec::new();
        for i in 0..n {
            let mut buf = [0 as std::ffi::c_char; 256];
            // SAFETY: as above.
            let r = unsafe { ffi::dl_device_name(i, buf.as_mut_ptr(), buf.len() as _) };
            let name = ffi::text(&buf);
            names.push(if r == 0 && !name.is_empty() {
                name
            } else {
                format!("DeckLink #{i}")
            });
        }
        Ok(names)
    }
    #[cfg(not(decklink_shim))]
    Err(NOT_BUILT.into())
}

/// What a device can do (None: no such device, or not built / no runtime).
pub fn capabilities(device: u32) -> Option<Caps> {
    #[cfg(decklink_shim)]
    {
        // SAFETY: plain call into the shim.
        let c = unsafe { ffi::dl_device_caps(index(device).ok()?) };
        (c >= 0).then_some(Caps {
            output: c & 1 != 0,
            input: c & 2 != 0,
            internal_keyer: c & 4 != 0,
            external_keyer: c & 8 != 0,
            format_detection: c & 16 != 0,
        })
    }
    #[cfg(not(decklink_shim))]
    {
        let _ = device;
        None
    }
}

/// Display modes of a device's output (`input = false`) or input.
pub fn modes(device: u32, input: bool) -> Result<Vec<DisplayMode>, String> {
    #[cfg(decklink_shim)]
    {
        let idx = index(device)?;
        let mut err = [0 as std::ffi::c_char; 256];
        let mut raw: Vec<ffi::RawMode> = Vec::with_capacity(128);
        // SAFETY: `raw` has room for `capacity` modes; the shim writes at
        // most that many and returns the total count.
        let n = unsafe {
            ffi::dl_device_modes(
                idx,
                input as _,
                raw.as_mut_ptr(),
                raw.capacity() as _,
                err.as_mut_ptr(),
                err.len() as _,
            )
        };
        if n < 0 {
            let e = ffi::text(&err);
            return Err(if e.is_empty() { NO_RUNTIME.into() } else { e });
        }
        // SAFETY: the first min(n, capacity) entries were written.
        unsafe { raw.set_len((n as usize).min(raw.capacity())) };
        Ok(raw
            .iter()
            .map(|m| DisplayMode {
                id: m.id,
                name: ffi::text(&m.name),
                width: m.width.max(0) as u32,
                height: m.height.max(0) as u32,
                duration: m.duration,
                timescale: m.timescale,
                field: m.field_dominance as u32,
            })
            .collect())
    }
    #[cfg(not(decklink_shim))]
    {
        let _ = (device, input);
        Err(NOT_BUILT.into())
    }
}

/// The mode of a device matching a channel format, best first.
fn pick(
    device: u32,
    input: bool,
    width: u32,
    height: u32,
    rate: (u32, u32),
) -> Result<Vec<DisplayMode>, String> {
    let all = modes(device, input)?;
    let c: Vec<DisplayMode> = candidates(&all, width, height, rate)
        .into_iter()
        .cloned()
        .collect();
    if c.is_empty() {
        return Err(format!(
            "the DeckLink device has no {} mode for {}",
            if input { "input" } else { "output" },
            format_name(width, height, rate)
        ));
    }
    Ok(c)
}

/// An open DeckLink output. Thread-safe: frames are pushed from one thread
/// while others wait on its frame clock. Closed when dropped.
pub struct OutputHandle {
    #[cfg(decklink_shim)]
    raw: *mut std::ffi::c_void,
    pub width: u32,
    pub height: u32,
    /// The display mode in use.
    pub mode: DisplayMode,
}

// SAFETY: the shim guards the handle's state with a mutex; it is closed
// once, on drop, when no other reference is left.
unsafe impl Send for OutputHandle {}
unsafe impl Sync for OutputHandle {}

impl OutputHandle {
    /// Opens a device's output in the mode matching width × height at `rate`.
    pub fn open(
        device: u32,
        width: u32,
        height: u32,
        rate: (u32, u32),
        keyer: Keyer,
    ) -> Result<Self, String> {
        #[cfg(decklink_shim)]
        {
            let idx = index(device)?;
            let mut last = String::new();
            for mode in pick(device, false, width, height, rate)? {
                let mut err = [0 as std::ffi::c_char; 256];
                // SAFETY: plain call; `err` sized as passed.
                let raw = unsafe {
                    ffi::dl_output_open(
                        idx,
                        mode.id,
                        width as _,
                        height as _,
                        keyer as _,
                        err.as_mut_ptr(),
                        err.len() as _,
                    )
                };
                if !raw.is_null() {
                    return Ok(Self {
                        raw,
                        width,
                        height,
                        mode,
                    });
                }
                last = format!("{} ({})", ffi::text(&err), mode.name);
            }
            Err(last)
        }
        #[cfg(not(decklink_shim))]
        {
            let _ = (device, width, height, rate, keyer, pick);
            Err(NOT_BUILT.into())
        }
    }

    /// Queues a BGRA picture of the output's size (`stride` bytes a row).
    pub fn push(&self, bgra: &[u8], stride: usize) -> Pushed {
        if stride < self.width as usize * 4 || bgra.len() < stride * self.height as usize {
            return Pushed::Failed;
        }
        #[cfg(decklink_shim)]
        {
            // SAFETY: `bgra` holds `height` rows of `stride` bytes (checked).
            match unsafe { ffi::dl_output_push(self.raw, bgra.as_ptr(), stride as _) } {
                0 => Pushed::Queued,
                1 => Pushed::Dropped,
                _ => Pushed::Failed,
            }
        }
        #[cfg(not(decklink_shim))]
        Pushed::Failed
    }

    /// Waits for the card's next frame boundary; false on timeout.
    pub fn wait(&self, timeout: Duration) -> bool {
        #[cfg(decklink_shim)]
        {
            let ms = timeout.as_millis().clamp(1, i32::MAX as u128) as std::ffi::c_int;
            let mut frames = 0u64;
            // SAFETY: open handle; `frames` is a valid out pointer.
            unsafe { ffi::dl_output_wait(self.raw, ms, &mut frames) == 1 }
        }
        #[cfg(not(decklink_shim))]
        {
            std::thread::sleep(timeout);
            false
        }
    }

    /// Locked to the reference input (None: the card cannot tell).
    pub fn reference_locked(&self) -> Option<bool> {
        #[cfg(decklink_shim)]
        {
            // SAFETY: open handle.
            match unsafe { ffi::dl_reference_locked(self.raw) } {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            }
        }
        #[cfg(not(decklink_shim))]
        None
    }
}

impl Drop for OutputHandle {
    fn drop(&mut self) {
        #[cfg(decklink_shim)]
        // SAFETY: opened by `open`, closed once here.
        unsafe {
            ffi::dl_output_close(self.raw)
        };
    }
}

/// An open DeckLink input capturing 8-bit 4:2:2 (UYVY). Closed when dropped.
pub struct InputHandle {
    #[cfg(decklink_shim)]
    raw: *mut std::ffi::c_void,
    pub mode: DisplayMode,
}

// SAFETY: the shim guards the captured frame with a mutex.
unsafe impl Send for InputHandle {}
unsafe impl Sync for InputHandle {}

impl InputHandle {
    pub fn open(device: u32, width: u32, height: u32, rate: (u32, u32)) -> Result<Self, String> {
        #[cfg(decklink_shim)]
        {
            let idx = index(device)?;
            let mut last = String::new();
            for mode in pick(device, true, width, height, rate)? {
                let mut err = [0 as std::ffi::c_char; 256];
                // SAFETY: plain call; `err` sized as passed.
                let raw =
                    unsafe { ffi::dl_input_open(idx, mode.id, err.as_mut_ptr(), err.len() as _) };
                if !raw.is_null() {
                    return Ok(Self { raw, mode });
                }
                last = format!("{} ({})", ffi::text(&err), mode.name);
            }
            Err(last)
        }
        #[cfg(not(decklink_shim))]
        {
            let _ = (device, width, height, rate);
            Err(NOT_BUILT.into())
        }
    }

    /// The newest frame (UYVY, rows packed) into `buf` when newer than
    /// `*seq`: its (width, height).
    pub fn take(&self, buf: &mut Vec<u8>, seq: &mut u64) -> Option<(u32, u32)> {
        #[cfg(decklink_shim)]
        {
            if buf.capacity() == 0 {
                buf.reserve(self.mode.width as usize * self.mode.height as usize * 2);
            }
            for _ in 0..3 {
                let (mut w, mut h) = (0, 0);
                // SAFETY: `buf` has `capacity` writable bytes; the shim
                // writes at most that many (else returns the size needed).
                let r = unsafe {
                    ffi::dl_input_take(
                        self.raw,
                        buf.as_mut_ptr(),
                        buf.capacity() as i64,
                        &mut w,
                        &mut h,
                        seq,
                    )
                };
                match r {
                    1 => {
                        let len = w.max(0) as usize * h.max(0) as usize * 2;
                        // SAFETY: the shim wrote `len` <= capacity bytes.
                        unsafe { buf.set_len(len.min(buf.capacity())) };
                        return Some((w as u32, h as u32));
                    }
                    0 => return None,
                    need => {
                        buf.clear();
                        buf.reserve((-need) as usize);
                    }
                }
            }
            None
        }
        #[cfg(not(decklink_shim))]
        {
            let _ = (buf, seq);
            None
        }
    }

    /// A signal is coming in (None: nothing received yet).
    pub fn signal(&self) -> Option<bool> {
        #[cfg(decklink_shim)]
        {
            // SAFETY: open handle.
            match unsafe { ffi::dl_input_signal(self.raw) } {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            }
        }
        #[cfg(not(decklink_shim))]
        None
    }
}

impl Drop for InputHandle {
    fn drop(&mut self) {
        #[cfg(decklink_shim)]
        // SAFETY: opened by `open`, closed once here.
        unsafe {
            ffi::dl_input_close(self.raw)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(id: u32, w: u32, h: u32, duration: i64, timescale: i64, field: u32) -> DisplayMode {
        DisplayMode {
            id,
            name: format!("{id}"),
            width: w,
            height: h,
            duration,
            timescale,
            field,
        }
    }

    #[test]
    fn mode_matching() {
        let upper = u32::from_be_bytes(*b"uppr");
        let modes = [
            mode(1, 1920, 1080, 1000, 25000, upper), // 1080i50
            mode(2, 1920, 1080, 1000, 25000, FIELD_PROGRESSIVE), // 1080p25
            mode(3, 1920, 1080, 1000, 50000, FIELD_PROGRESSIVE), // 1080p50
            mode(4, 1920, 1080, 1001, 30000, FIELD_PROGRESSIVE), // 1080p29.97
            mode(5, 1920, 1080, 1000, 30000, FIELD_PROGRESSIVE), // 1080p30
            mode(6, 1280, 720, 1000, 50000, FIELD_PROGRESSIVE), // 720p50
            mode(7, 1920, 1080, 1000, 25000, FIELD_PSF), // 1080PsF25
        ];
        let ids = |w, h, r| {
            candidates(&modes, w, h, r)
                .iter()
                .map(|m| m.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(1920, 1080, (25, 1)), vec![2, 7, 1]);
        assert_eq!(ids(1920, 1080, (50, 1)), vec![3]);
        assert_eq!(ids(1920, 1080, (30000, 1001)), vec![4]);
        assert_eq!(ids(1920, 1080, (2997, 100)), vec![4]);
        assert_eq!(ids(1920, 1080, (30, 1)), vec![5]);
        assert_eq!(ids(1280, 720, (50, 1)), vec![6]);
        assert!(ids(3840, 2160, (50, 1)).is_empty());
        assert!(ids(1920, 1080, (0, 1)).is_empty());
        assert_eq!(format_name(1920, 1080, (30000, 1001)), "1920x1080 @ 29.97");
    }

    #[test]
    fn listing_without_runtime_or_support_does_not_panic() {
        // CI machines have no Desktop Video: a clean error, never a panic.
        match devices() {
            Ok(list) => {
                if !BUILT {
                    panic!("devices listed without the shim: {list:?}");
                }
            }
            Err(e) => assert!(e == NOT_BUILT || e == NO_RUNTIME, "{e}"),
        }
        if !BUILT {
            assert!(OutputHandle::open(0, 1920, 1080, (25, 1), Keyer::External).is_err());
            assert!(InputHandle::open(0, 1920, 1080, (25, 1)).is_err());
            assert_eq!(capabilities(0), None);
        }
    }
}
