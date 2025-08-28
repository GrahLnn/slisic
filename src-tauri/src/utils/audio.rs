use anyhow::{bail, Context, Result};
use ebur128::{EbuR128, Mode};
use std::path::Path;
use std::{fs::File, path::PathBuf};

use crate::utils::ffmpeg::integrated_lufs;

// 1) 单曲 Integrated LUFS
// pub fn integrated_lufs<P: AsRef<Path>>(path: P) -> Result<f64> {
//     // —— 打开 & 探测 ——
//     let src = Box::new(
//         File::open(&path)
//             .with_context(|| format!("open file failed: {}", path.as_ref().display()))?,
//     );
//     let mss = MediaSourceStream::new(src, Default::default());

//     let mut hint = Hint::new();
//     if let Some(ext) = path.as_ref().extension().and_then(|s| s.to_str()) {
//         hint.with_extension(ext);
//     }

//     let probed = get_probe().format(
//         &hint,
//         mss,
//         &FormatOptions::default(),
//         &MetadataOptions::default(),
//     )?;
//     let mut format = probed.format;

//     // —— 选轨（拷出必要字段，尽快结束不可变借用） ——
//     let (track_id, codec_params) = {
//         let track = format
//             .tracks()
//             .iter()
//             .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
//             .ok_or_else(|| anyhow::anyhow!("no audio track"))?;
//         (track.id, track.codec_params.clone())
//     };

//     let mut decoder = get_codecs().make(&codec_params, &DecoderOptions::default())?;
//     let mut r128: Option<EbuR128> = None;
//     let mut got_any = false;

//     loop {
//         let packet = match format.next_packet() {
//             Ok(p) if p.track_id() == track_id => p,
//             Ok(_) => continue,
//             Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
//                 break
//             }
//             Err(e) => return Err(e.into()),
//         };

//         let decoded = match decoder.decode(&packet) {
//             Ok(buf) => buf,
//             Err(SymphoniaError::DecodeError(_)) => continue, // 坏包直接跳过
//             Err(SymphoniaError::ResetRequired) => {
//                 decoder = get_codecs().make(&codec_params, &DecoderOptions::default())?;
//                 continue;
//             }
//             Err(e) => return Err(e.into()),
//         };

//         // —— 首帧后再建 EBU R128 ——（用实际声道/采样率）
//         if r128.is_none() {
//             let spec = *decoded.spec();
//             let chs = spec.channels.count();
//             let sr = spec.rate;
//             if chs == 0 || sr == 0 {
//                 bail!("invalid stream spec: channels={chs}, rate={sr}");
//             }
//             r128 = Some(EbuR128::new(chs as u32, sr as u32, Mode::I)?);
//         }
//         let r128 = r128.as_mut().unwrap();
//         got_any = true;

//         // —— 统一拷到交织的 f32，再手动拆 planar ——（避免依赖 Signal::chan）
//         let spec = *decoded.spec();
//         let cap = decoded.capacity() as u64;
//         let mut sbuf = SampleBuffer::<f32>::new(cap, spec);
//         sbuf.copy_interleaved_ref(decoded);

//         let chs = spec.channels.count();
//         let interleaved = sbuf.samples();
//         let frames = interleaved.len() / chs;

//         // 临时 planar（如需极致性能，可在循环外复用这块缓冲）
//         let mut planar: Vec<Vec<f32>> = vec![vec![0.0; frames]; chs];
//         for f in 0..frames {
//             let base = f * chs;
//             for c in 0..chs {
//                 planar[c][f] = interleaved[base + c];
//             }
//         }
//         let refs: Vec<&[f32]> = planar.iter().map(|v| v.as_slice()).collect();
//         r128.add_frames_planar_f32(&refs)?;
//     }

//     if !got_any {
//         bail!("no audio frames decoded");
//     }
//     Ok(r128.unwrap().loudness_global()?)
// }

// 2) 计算播放列表目标（平均 / 中位数 / 去极值均值）
pub enum TargetMode {
    Mean,
    Median,
    TrimmedMean(f64),
} // 例如 TrimmedMean(0.1) 去两端各10%
pub fn playlist_target(mut lufs: Vec<f64>, mode: TargetMode) -> f64 {
    match mode {
        TargetMode::Mean => {
            let s: f64 = lufs.iter().sum();
            s / (lufs.len().max(1) as f64)
        }
        TargetMode::Median => {
            lufs.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let n = lufs.len();
            if n == 0 {
                -16.0
            } else if n % 2 == 1 {
                lufs[n / 2]
            } else {
                (lufs[n / 2 - 1] + lufs[n / 2]) / 2.0
            }
        }
        TargetMode::TrimmedMean(alpha) => {
            let mut v = lufs;
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let n = v.len();
            if n == 0 {
                return -16.0;
            }
            let k = ((n as f64) * alpha).floor() as usize;
            let slice = &v[k..n.saturating_sub(k).max(k)];
            let s: f64 = slice.iter().copied().sum();
            s / (slice.len().max(1) as f64)
        }
    }
}

// 3) 为每首算补偿增益（带钳制）
pub fn track_gain_db(track_lufs: f64, target: f64, max_boost: f64, max_cut: f64) -> f64 {
    let raw = target - track_lufs;
    raw.clamp(-max_cut, max_boost)
}

// #[test]
// fn test_integrated_lufs() {
//     let now = std::time::Instant::now();
//     let path = PathBuf::from(
//         r"C:\Users\admin\Documents\test\【原神】「寂々たる無妄の国」Disc 1 - 稲光と雷櫻の大地\01. 稲妻.flac",
//     );
//     let lufs = integrated_lufs(&path);
//     println!("cost {:?}", now.elapsed());
//     dbg!(lufs);
// }
